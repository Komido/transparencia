-- Combustíveis e gás de cozinha por estado (ANP).
--
-- O conversor scripts/anp_para_csv.py grava dados-fonte/anp/precos-mensais-estados.csv
-- (mes, uf, produto, unidade, preco_medio_revenda, postos_pesquisados). O
-- leitor grava as mesmas séries do Brasil (comb_gasolina, comb_etanol,
-- comb_diesel, comb_glp) com a localidade da UF.
--
-- O arquivo de cada capital passa a levar também as séries de combustíveis
-- do estado e o nome do estado.
--
-- O leitor nacional (etl.carregar_anp_csv) passa a contar só os valores do
-- Brasil ao conferir se o arquivo trouxe menos dados que os já gravados; antes
-- contava todas as localidades, e os estados fariam a carga nacional falhar.
--
-- Versões anteriores renomeadas: carregar_anp_csv_v1, carregar_formato_v1,
-- painel_cidades_v1.

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv',
                     'ibge_municipios', 'sidra_json', 'csv_series', 'siconfi_dca', 'sidra_pof', 'fipezap_cidades',
                     'anp_estados_csv'));
alter table ref.coleta drop constraint coleta_serie_check;
alter table ref.coleta add constraint coleta_serie_check
  check ((formato in ('rfb_csv', 'anp_csv', 'ibge_municipios', 'csv_series', 'siconfi_dca', 'sidra_pof', 'anp_estados_csv'))
         = (serie_id is null));

insert into ref.coleta (id, fonte_id, url, formato, serie_id) values
  ('anp_estados_csv', 'anp',
   'https://raw.githubusercontent.com/Komido/transparencia/claude/tender-hopper-dbp169/dados-fonte/anp/precos-mensais-estados.csv',
   'anp_estados_csv', null);

create function etl.carregar_anp_estados(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_linhas      text[];
  v_erros       integer;
  v_repetidos   integer;
  v_sem_uf      text[];
  v_curtas      text[];
  v_total       integer;
  v_existentes  integer;
begin
  v_linhas := regexp_split_to_array(btrim(p_conteudo, E'\n'), E'\r?\n');
  if v_linhas[1] <> 'mes,uf,produto,unidade,preco_medio_revenda,postos_pesquisados' then
    raise exception 'ANP estados: cabeçalho inesperado "%"', left(v_linhas[1], 120);
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  )
  select count(*) filter (where array_length(c, 1) <> 6
                             or c[1] !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
                             or c[2] !~ '^[A-Z]{2}$'
                             or c[5] !~ '^[0-9]{1,4}(\.[0-9]+)?$'),
         count(*) - count(distinct (c[1], c[2], c[3]))
    into v_erros, v_repetidos
    from l;
  if v_erros > 0 or v_repetidos > 0 then
    raise exception 'ANP estados: % linhas fora do formato e % repetidas', v_erros, v_repetidos;
  end if;

  with l as (
    select distinct c[2] as uf
      from (select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> '') q
  )
  select array_agg(uf) into v_sem_uf
    from l where not exists (select 1 from ref.localidade m where m.nivel = 'uf' and m.uf_sigla = l.uf);
  if v_sem_uf is not null then
    raise exception 'ANP estados: UFs sem cadastro: %', v_sem_uf;
  end if;

  -- Cada série precisa existir nos 27 estados.
  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  ),
  mapa(produto, unidade, serie_id) as (values
    ('GASOLINA COMUM', 'R$/L', 'comb_gasolina'), ('ETANOL HIDRATADO', 'R$/L', 'comb_etanol'),
    ('OLEO DIESEL', 'R$/L', 'comb_diesel'), ('GLP', 'R$/13KG', 'comb_glp'))
  select array_agg(mapa.serie_id) filter (where coalesce(n, 0) < 27)
    into v_curtas
    from mapa
    left join (select c[3] as produto, c[4] as unidade, count(distinct c[2]) as n from l group by 1, 2) q
      on q.produto = mapa.produto and q.unidade = mapa.unidade;
  if v_curtas is not null then
    raise exception 'ANP estados: séries sem os 27 estados: %', v_curtas;
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  ),
  mapa(produto, unidade, serie_id) as (values
    ('GASOLINA COMUM', 'R$/L', 'comb_gasolina'), ('ETANOL HIDRATADO', 'R$/L', 'comb_etanol'),
    ('OLEO DIESEL', 'R$/L', 'comb_diesel'), ('GLP', 'R$/13KG', 'comb_glp'))
  select count(*) into v_total
    from l join mapa on mapa.produto = l.c[3] and mapa.unidade = l.c[4];

  select count(*) into v_existentes
    from dados.observacao o
    join ref.localidade m on m.id = o.localidade_id and m.nivel = 'uf'
   where o.serie_id like 'comb\_%';
  if v_total < v_existentes then
    raise exception 'ANP estados: o arquivo trouxe % valores, menos que os % já gravados', v_total, v_existentes;
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  ),
  mapa(produto, unidade, serie_id) as (values
    ('GASOLINA COMUM', 'R$/L', 'comb_gasolina'), ('ETANOL HIDRATADO', 'R$/L', 'comb_etanol'),
    ('OLEO DIESEL', 'R$/L', 'comb_diesel'), ('GLP', 'R$/13KG', 'comb_glp'))
  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select mapa.serie_id, m.id, to_date(l.c[1] || '-01', 'YYYY-MM-DD'), l.c[5]::numeric, p_carga
    from l
    join mapa on mapa.produto = l.c[3] and mapa.unidade = l.c[4]
    join ref.localidade m on m.nivel = 'uf' and m.uf_sigla = l.c[2]
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

alter function etl.carregar_anp_csv(bigint, text) rename to carregar_anp_csv_v1;

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

  select count(*) into v_existentes from dados.observacao where serie_id like 'comb\_%' and localidade_id = 'BR';

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

alter function etl.carregar_formato(text, bigint, text, text, text) rename to carregar_formato_v1;

create function etl.carregar_formato(p_formato text, p_carga bigint, p_serie text, p_fonte text, p_texto text)
returns integer
language plpgsql
set search_path = ''
as $$
begin
  if p_formato = 'anp_estados_csv' then
    return etl.carregar_anp_estados(p_carga, p_texto);
  end if;
  return etl.carregar_formato_v1(p_formato, p_carga, p_serie, p_fonte, p_texto);
end
$$;

-- ---------------------------------------------------------------------------
-- Arquivo de cada capital: também os combustíveis do estado
-- ---------------------------------------------------------------------------
alter function etl.painel_cidades() rename to painel_cidades_v1;

create function etl.painel_cidades()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with fim as (
    select max(periodo) as periodo from dados.observacao where serie_id = 'ipca_var' and localidade_id = 'BR'
  ),
  meses as (
    select gs::date as periodo from fim, generate_series(date '1995-01-01', fim.periodo, interval '1 month') as gs
  ),
  cidades as (
    select l.id, l.nome, l.uf_sigla, left(l.id, 2) as uf_id, left(l.id, 2)::smallint as uf_codigo
      from ref.cidade_dieese c
      join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla
     where c.capital
  ),
  combustiveis as (
    select cid.id as cidade, s.id as serie,
           jsonb_agg(o.valor order by m.periodo) as valores,
           count(o.valor) as com_valor
      from cidades cid
     cross join ref.serie s
     cross join meses m
      left join dados.observacao o on o.serie_id = s.id and o.localidade_id = cid.uf_id and o.periodo = m.periodo
     where s.fonte_id = 'anp'
     group by cid.id, s.id
  )
  select jsonb_object_agg(v1.chave, v1.valor
           || jsonb_build_object('uf_nome', (select u.nome from ref.localidade u where u.id = cid.uf_id))
           || jsonb_build_object('series', coalesce(v1.valor -> 'series', '{}'::jsonb)
                                 || coalesce((select jsonb_object_agg(cb.serie, cb.valores)
                                                from combustiveis cb where cb.cidade = cid.id and cb.com_valor > 0),
                                             '{}'::jsonb)))
    from jsonb_each(etl.painel_cidades_v1()) as v1(chave, valor)
    join cidades cid on cid.id = v1.chave
$$;
