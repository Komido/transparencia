-- Preços do dia a dia: alimentos (DIEESE, por capital) e combustíveis (ANP, Brasil).
-- Também carrega os 5.571 municípios do IBGE, para guardar cada preço na cidade
-- certa pelo código oficial.
--
-- Unidades dos alimentos: conferidas com os próprios dados do DIEESE. Para São
-- Paulo em out/2026, gasto mensal ÷ preço médio dá exatamente as quantidades da
-- cesta da região (6 kg de carne, 7,5 L de leite, 4,5 kg de feijão, 3 kg de
-- arroz, 600 g de café, 6 kg de pão), o que confirma preço por kg ou por litro.
--
-- Como nas migrações anteriores, funções substituídas são renomeadas (sufixo
-- _v2 ou _v1) em vez de apagadas.

-- ---------------------------------------------------------------------------
-- Fontes, séries e cidades do DIEESE
-- ---------------------------------------------------------------------------

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('dieese_cesta', 'Pesquisa Nacional da Cesta Básica de Alimentos', 'DIEESE',
   'https://www.dieese.org.br/cesta/',
   'Preço médio mensal de cada produto nas capitais pesquisadas.'),
  ('anp', 'Levantamento de Preços de Combustíveis', 'ANP',
   'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/precos-revenda-e-de-distribuicao-combustiveis/serie-historica-do-levantamento-de-precos',
   'Preço médio de revenda nos postos, Brasil. A ANP publica em Excel; o arquivo é convertido para CSV por scripts/anp_para_csv.py, que registra o SHA-256 de cada original em dados-fonte/anp/origem.json.'),
  ('ibge_localidades', 'Localidades (municípios e UFs)', 'IBGE',
   'https://servicodados.ibge.gov.br/api/docs/localidades', null);

insert into ref.serie (id, nome, unidade, fonte_id, codigo_origem, observacao) values
  ('cesta_total', 'Custo da cesta básica de alimentos', 'R$ por mês, por pessoa adulta', 'dieese_cesta', 'produto 1', 'Média das capitais pesquisadas desde 1995.'),
  ('preco_arroz', 'Arroz', 'R$ por kg', 'dieese_cesta', 'produto 5', 'Média das capitais pesquisadas desde 1995.'),
  ('preco_feijao', 'Feijão', 'R$ por kg', 'dieese_cesta', 'produto 4', 'Média das capitais pesquisadas desde 1995.'),
  ('preco_carne', 'Carne bovina', 'R$ por kg', 'dieese_cesta', 'produto 2', 'Média das capitais pesquisadas desde 1995.'),
  ('preco_leite', 'Leite', 'R$ por litro', 'dieese_cesta', 'produto 3', 'Média das capitais pesquisadas desde 1995.'),
  ('preco_cafe', 'Café em pó', 'R$ por kg', 'dieese_cesta', 'produto 10', 'Média das capitais pesquisadas desde 1995.'),
  ('preco_pao', 'Pão francês', 'R$ por kg', 'dieese_cesta', 'produto 9', 'Média das capitais pesquisadas desde 1995.'),
  ('comb_gasolina', 'Gasolina comum', 'R$ por litro', 'anp', 'GASOLINA COMUM', null),
  ('comb_etanol', 'Etanol hidratado', 'R$ por litro', 'anp', 'ETANOL HIDRATADO', null),
  ('comb_diesel', 'Óleo diesel', 'R$ por litro', 'anp', 'OLEO DIESEL', null),
  ('comb_glp', 'Gás de cozinha (botijão de 13 kg)', 'R$ por botijão', 'anp', 'GLP', null);

-- Cidades pesquisadas pelo DIEESE, com a UF para achar o código do IBGE.
-- painel_1995: capitais com pesquisa contínua desde janeiro de 1995. A média
-- nacional usa só essas, para que a entrada de novas capitais em 2016 não
-- mude o nível da série.
create table ref.cidade_dieese (
  nome         text primary key,
  uf_sigla     text not null check (uf_sigla ~ '^[A-Z]{2}$'),
  painel_1995  boolean not null
);
alter table ref.cidade_dieese enable row level security;

insert into ref.cidade_dieese (nome, uf_sigla, painel_1995) values
  ('São Paulo', 'SP', true), ('Porto Alegre', 'RS', true), ('Belo Horizonte', 'MG', true),
  ('Rio de Janeiro', 'RJ', true), ('Salvador', 'BA', true), ('Curitiba', 'PR', true),
  ('Florianópolis', 'SC', true), ('Brasília', 'DF', true), ('Fortaleza', 'CE', true),
  ('Recife', 'PE', true), ('Belém', 'PA', true), ('João Pessoa', 'PB', true),
  ('Vitória', 'ES', true), ('Natal', 'RN', true), ('Goiânia', 'GO', true),
  ('Aracaju', 'SE', false), ('Campo Grande', 'MS', false), ('Cuiabá', 'MT', false),
  ('Boa Vista', 'RR', false), ('Macapá', 'AP', false), ('Manaus', 'AM', false),
  ('Palmas', 'TO', false), ('Porto Velho', 'RO', false), ('Rio Branco', 'AC', false),
  ('Maceió', 'AL', false), ('São Luís', 'MA', false), ('Teresina', 'PI', false),
  ('Macaé', 'RJ', false);

-- ---------------------------------------------------------------------------
-- Coletas
-- ---------------------------------------------------------------------------

alter table ref.coleta drop constraint coleta_check;
alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv', 'ibge_municipios'));
alter table ref.coleta add constraint coleta_serie_check
  check ((formato in ('rfb_csv', 'anp_csv', 'ibge_municipios')) = (serie_id is null));

-- {mes_atual} é trocado pelo mês corrente (MMAAAA) no momento da coleta.
insert into ref.coleta (id, fonte_id, url, formato, serie_id, metodo, corpo, codificacao)
select 'dieese_' || s.serie, 'dieese_cesta',
       'https://www.dieese.org.br/cesta/produto?farinha=true&produtos=' || s.produto
         || '&tipoDado=4&cidades=0&dataInicial=011995&dataFinal={mes_atual}',
       'dieese_produto', s.serie, 'POST', '{}'::jsonb, 'UTF8'
  from (values ('cesta_total', 1), ('preco_arroz', 5), ('preco_feijao', 4), ('preco_carne', 2),
               ('preco_leite', 3), ('preco_cafe', 10), ('preco_pao', 9)) as s(serie, produto);

insert into ref.coleta (id, fonte_id, url, formato, serie_id) values
  ('anp_csv', 'anp', 'https://raw.githubusercontent.com/Komido/transparencia/claude/tender-hopper-dbp169/dados-fonte/anp/precos-mensais-brasil.csv', 'anp_csv', null),
  ('ibge_municipios', 'ibge_localidades', 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios', 'ibge_municipios', null);

-- ---------------------------------------------------------------------------
-- IBGE: municípios
-- ---------------------------------------------------------------------------
create function etl.carregar_ibge_municipios(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json       jsonb;
  v_total      integer;
  v_invalidos  integer;
begin
  v_json := p_conteudo::jsonb;
  if jsonb_typeof(v_json) <> 'array' then
    raise exception 'IBGE: a resposta não é uma lista';
  end if;

  with m as (
    select e ->> 'id' as id, e ->> 'nome' as nome,
           coalesce(e -> 'microrregiao' -> 'mesorregiao' -> 'UF',
                    e -> 'regiao-imediata' -> 'regiao-intermediaria' -> 'UF') as uf
      from jsonb_array_elements(v_json) e
  )
  select count(*),
         count(*) filter (where m.id !~ '^[0-9]{7}$' or coalesce(m.nome, '') = '' or m.uf is null
                          or not exists (select 1 from ref.localidade l where l.id = m.uf ->> 'id' and l.nivel = 'uf'))
    into v_total, v_invalidos
    from m;

  if v_total < 5500 then
    raise exception 'IBGE: só % municípios na resposta', v_total;
  end if;
  if v_invalidos > 0 then
    raise exception 'IBGE: % municípios com código, nome ou UF inválidos', v_invalidos;
  end if;

  with m as (
    select e ->> 'id' as id, e ->> 'nome' as nome,
           coalesce(e -> 'microrregiao' -> 'mesorregiao' -> 'UF',
                    e -> 'regiao-imediata' -> 'regiao-intermediaria' -> 'UF') as uf
      from jsonb_array_elements(v_json) e
  )
  insert into ref.localidade (id, nivel, nome, uf_sigla, uf_id, regiao)
  select m.id, 'municipio', m.nome, m.uf ->> 'sigla', m.uf ->> 'id', m.uf -> 'regiao' ->> 'nome'
    from m
  on conflict (id) do update
     set nome = excluded.nome, uf_sigla = excluded.uf_sigla, uf_id = excluded.uf_id, regiao = excluded.regiao
   where (ref.localidade.nome, ref.localidade.uf_sigla, ref.localidade.uf_id, ref.localidade.regiao)
         is distinct from (excluded.nome, excluded.uf_sigla, excluded.uf_id, excluded.regiao);

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- DIEESE: tabela de preço médio de um produto em todas as cidades
-- (linhas = meses "MM-AAAA", colunas = cidades, "-" = sem pesquisa)
-- ---------------------------------------------------------------------------
create function etl.carregar_dieese_produto(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_cab           text[];
  v_locais        text[];
  v_desconhecidas text[];
  v_tr            text;
  v_tds           text[];
  v_valor         text;
  v_periodo       date;
  v_periodos      date[] := '{}';
  v_locs          text[] := '{}';
  v_valores       numeric[] := '{}';
  v_meses         integer := 0;
  v_total         integer;
  v_existentes    integer;
  i               integer;
begin
  -- Cabeçalho: primeira célula vazia e depois o nome de cada cidade.
  select array_agg(btrim(regexp_replace(regexp_replace(regexp_replace(m[1], '<[^>]+>', '', 'g'), '\s+', ' ', 'g'), '\s*\([0-9]+\)$', '')) order by ordem)
    into v_cab
    from regexp_matches(substring(p_conteudo from '<thead>(.*?)</thead>'), '<th[^>]*?>(.*?)</th>', 'gi') with ordinality as t(m, ordem);

  if coalesce(array_length(v_cab, 1), 0) < 11 then
    raise exception 'DIEESE: cabeçalho com % colunas; o layout pode ter mudado', coalesce(array_length(v_cab, 1), 0);
  end if;

  select array_agg(l.id order by x.ordem),
         array_agg(x.nome order by x.ordem) filter (where l.id is null)
    into v_locais, v_desconhecidas
    from unnest(v_cab[2:]) with ordinality as x(nome, ordem)
    left join ref.cidade_dieese c on c.nome = x.nome
    left join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla;

  if v_desconhecidas is not null then
    raise exception 'DIEESE: cidades sem código do IBGE: %', v_desconhecidas;
  end if;

  for v_tr in
    select (regexp_matches(substring(p_conteudo from '<tbody>(.*?)</tbody>'), '<tr[^>]*?>(.*?)</tr>', 'gi'))[1]
  loop
    select array_agg(btrim(regexp_replace(regexp_replace(m[1], '<[^>]+>', '', 'g'), '\s+', ' ', 'g')) order by ordem)
      into v_tds
      from regexp_matches(v_tr, '<td[^>]*?>(.*?)</td>', 'gi') with ordinality as t(m, ordem);

    continue when v_tds is null;
    if v_tds[1] !~ '^(0[1-9]|1[0-2])-[0-9]{4}$' then
      raise exception 'DIEESE: mês inválido "%"', left(v_tds[1], 40);
    end if;
    if array_length(v_tds, 1) <> array_length(v_cab, 1) then
      raise exception 'DIEESE: % tem % colunas; esperado %', v_tds[1], array_length(v_tds, 1), array_length(v_cab, 1);
    end if;

    v_periodo := make_date(substr(v_tds[1], 4, 4)::integer, substr(v_tds[1], 1, 2)::integer, 1);
    v_meses := v_meses + 1;

    for i in 2 .. array_length(v_tds, 1) loop
      v_valor := regexp_replace(v_tds[i], '\s*\([0-9]+\)$', '');
      continue when v_valor in ('-', '');
      if v_valor !~ '^[0-9]{1,3}(\.[0-9]{3})*,[0-9]{2}$' then
        raise exception 'DIEESE: valor inválido "%" em %', left(v_valor, 30), v_tds[1];
      end if;
      v_periodos := v_periodos || v_periodo;
      v_locs := v_locs || v_locais[i - 1];
      v_valores := v_valores || replace(replace(v_valor, '.', ''), ',', '.')::numeric;
    end loop;
  end loop;

  v_total := coalesce(array_length(v_valores, 1), 0);
  if v_meses < 300 then
    raise exception 'DIEESE: só % meses na tabela', v_meses;
  end if;

  select count(*) into v_existentes from dados.observacao where serie_id = p_serie;
  if v_total < v_existentes then
    raise exception 'DIEESE: a tabela trouxe % valores, menos que os % já gravados', v_total, v_existentes;
  end if;

  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select p_serie, u.local, u.periodo, u.valor, p_carga
    from unnest(v_periodos, v_locs, v_valores) as u(periodo, local, valor)
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- ANP: CSV convertido de dados-fonte/anp (mes, produto, unidade, preço, postos)
-- ---------------------------------------------------------------------------
create function etl.carregar_anp_csv(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_linhas      text[];
  v_erros       integer;
  v_curtas      text[];
  v_total       integer;
  v_existentes  integer;
begin
  v_linhas := regexp_split_to_array(btrim(p_conteudo, E'\n'), E'\r?\n');
  if v_linhas[1] <> 'mes,produto,unidade,preco_medio_revenda,postos_pesquisados' then
    raise exception 'ANP: cabeçalho inesperado "%"', left(v_linhas[1], 120);
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  )
  select count(*) filter (where array_length(c, 1) <> 5
                             or c[1] !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
                             or c[4] !~ '^[0-9]{1,4}(\.[0-9]+)?$')
    into v_erros
    from l;
  if v_erros > 0 then
    raise exception 'ANP: % linhas fora do formato esperado', v_erros;
  end if;

  -- Cada série precisa existir com histórico longo e na unidade esperada.
  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  ),
  mapa(produto, unidade, serie_id) as (values
    ('GASOLINA COMUM', 'R$/L', 'comb_gasolina'), ('ETANOL HIDRATADO', 'R$/L', 'comb_etanol'),
    ('OLEO DIESEL', 'R$/L', 'comb_diesel'), ('GLP', 'R$/13KG', 'comb_glp'))
  select array_agg(mapa.serie_id) filter (where coalesce(n, 0) < 250)
    into v_curtas
    from mapa
    left join (select c[2] as produto, c[3] as unidade, count(*) as n from l group by 1, 2) q
      on q.produto = mapa.produto and q.unidade = mapa.unidade;
  if v_curtas is not null then
    raise exception 'ANP: séries ausentes ou curtas: %', v_curtas;
  end if;

  select count(*) into v_existentes from dados.observacao where serie_id like 'comb\_%';

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  ),
  mapa(produto, unidade, serie_id) as (values
    ('GASOLINA COMUM', 'R$/L', 'comb_gasolina'), ('ETANOL HIDRATADO', 'R$/L', 'comb_etanol'),
    ('OLEO DIESEL', 'R$/L', 'comb_diesel'), ('GLP', 'R$/13KG', 'comb_glp')),
  dados_novos as (
    select mapa.serie_id, to_date(l.c[1] || '-01', 'YYYY-MM-DD') as periodo, l.c[4]::numeric as valor
      from l join mapa on mapa.produto = l.c[2] and mapa.unidade = l.c[3]
  )
  select count(*) into v_total from dados_novos;

  if v_total < v_existentes then
    raise exception 'ANP: o arquivo trouxe % valores, menos que os % já gravados', v_total, v_existentes;
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  ),
  mapa(produto, unidade, serie_id) as (values
    ('GASOLINA COMUM', 'R$/L', 'comb_gasolina'), ('ETANOL HIDRATADO', 'R$/L', 'comb_etanol'),
    ('OLEO DIESEL', 'R$/L', 'comb_diesel'), ('GLP', 'R$/13KG', 'comb_glp'))
  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select mapa.serie_id, 'BR', to_date(l.c[1] || '-01', 'YYYY-MM-DD'), l.c[4]::numeric, p_carga
    from l join mapa on mapa.produto = l.c[2] and mapa.unidade = l.c[3]
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Orquestração com os novos formatos
-- ---------------------------------------------------------------------------
alter function etl.solicitar_coletas() rename to solicitar_coletas_v2;
alter function etl.processar_respostas() rename to processar_respostas_v2;

create function etl.solicitar_coletas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_coleta     record;
  v_url        text;
  v_req        bigint;
  v_n          integer := 0;
  v_cabecalho  constant jsonb := jsonb_build_object('User-Agent', 'ArrecadometroBrasil/1.0 (coleta de dados publicos)');
begin
  for v_coleta in select id, url, metodo, corpo from ref.coleta where ativa order by id loop
    v_url := replace(v_coleta.url, '{mes_atual}', to_char(now() at time zone 'America/Sao_Paulo', 'MMYYYY'));
    if v_coleta.metodo = 'POST' then
      v_req := net.http_post(
        url := v_url,
        body := v_coleta.corpo,
        headers := v_cabecalho || jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 120000
      );
    else
      v_req := net.http_get(url := v_url, headers := v_cabecalho, timeout_milliseconds := 120000);
    end if;
    insert into etl.carga (coleta_id, url, requisicao_id) values (v_coleta.id, v_url, v_req);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

create function etl.processar_respostas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_carga     record;
  v_resp      record;
  v_bruto     bytea;
  v_texto     text;
  v_sha       text;
  v_anterior  text;
  v_linhas    integer;
  v_n         integer := 0;
begin
  -- Municípios primeiro: as outras cargas dependem dos códigos do IBGE.
  for v_carga in
    select k.id, k.coleta_id, k.requisicao_id, k.solicitada_em, c.formato, c.serie_id, c.codificacao
      from etl.carga k
      join ref.coleta c on c.id = k.coleta_id
     where k.status = 'pendente'
     order by (c.formato = 'ibge_municipios') desc, k.id
  loop
    select status_code, content, error_msg, timed_out
      into v_resp
      from net._http_response
     where id = v_carga.requisicao_id;

    if not found then
      if v_carga.solicitada_em < now() - interval '2 hours' then
        update etl.carga
           set status = 'erro', processada_em = now(), mensagem = 'A fonte não respondeu'
         where id = v_carga.id;
      end if;
      continue;
    end if;

    begin
      if v_resp.status_code is distinct from 200 or v_resp.content is null then
        raise exception 'HTTP % %', coalesce(v_resp.status_code::text, 'sem resposta'), coalesce(v_resp.error_msg, '');
      end if;

      v_bruto := textsend(v_resp.content);
      v_texto := convert_from(v_bruto, case v_carga.codificacao when 'LATIN1' then 'LATIN1' else 'UTF8' end);
      v_sha := encode(extensions.digest(v_bruto, 'sha256'), 'hex');

      select sha256 into v_anterior
        from etl.carga
       where coleta_id = v_carga.coleta_id and status = 'ok'
       order by id desc
       limit 1;

      if v_anterior is not distinct from v_sha then
        update etl.carga
           set status = 'sem_mudanca', processada_em = now(), http_status = v_resp.status_code,
               bytes = octet_length(v_bruto), sha256 = v_sha
         where id = v_carga.id;
      else
        v_linhas := case v_carga.formato
          when 'sgs_json'        then etl.carregar_sgs(v_carga.id, v_carga.serie_id, v_texto)
          when 'bls_json'        then etl.carregar_bls(v_carga.id, v_carga.serie_id, v_texto)
          when 'rfb_csv'         then etl.carregar_rfb(v_carga.id, v_texto)
          when 'dieese_html'     then etl.carregar_dieese(v_carga.id, v_carga.serie_id, v_texto)
          when 'dieese_produto'  then etl.carregar_dieese_produto(v_carga.id, v_carga.serie_id, v_texto)
          when 'anp_csv'         then etl.carregar_anp_csv(v_carga.id, v_texto)
          when 'ibge_municipios' then etl.carregar_ibge_municipios(v_carga.id, v_texto)
        end;
        update etl.carga
           set status = 'ok', processada_em = now(), http_status = v_resp.status_code,
               bytes = octet_length(v_bruto), sha256 = v_sha, linhas = v_linhas
         where id = v_carga.id;
      end if;
    exception when others then
      update etl.carga
         set status = 'erro', processada_em = now(), http_status = v_resp.status_code,
             mensagem = left(sqlerrm, 500)
       where id = v_carga.id;
    end;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
