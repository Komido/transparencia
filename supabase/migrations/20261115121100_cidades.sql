-- Números por capital.
--
-- 1. ref.cidade_dieese ganha a coluna "capital" (Macaé fica de fora: não é
--    capital e o DIEESE parou de pesquisar a cidade em 2020).
-- 2. POF 2017-2018 por UF (SIDRA 6715, nível N3): luz, água, gás e aluguel
--    por faixa de renda, coletada como as outras fontes (formato sidra_pof).
-- 3. Aluguel do FipeZAP por cidade (dados-fonte/fipezap/aluguel-cidades-fipezap.csv,
--    formato fipezap_cidades): cada cidade é ligada ao código do IBGE pelo
--    nome e pela UF; nome desconhecido recusa a carga.
-- 4. A escolha do leitor de cada formato passa para etl.carregar_formato(),
--    chamada por etl.processar_respostas(). Formato novo só exige trocar essa
--    função.
-- 5. etl.painel_blocos_extras() ganha o bloco "cidades": séries do DIEESE e
--    do aluguel de cada capital, nos mesmos meses do painel, e a POF da UF.
--    A tarefa que publica o painel separa esse bloco em um arquivo por cidade.
--
-- Versões anteriores renomeadas: processar_respostas_v6, painel_blocos_extras_v1.

alter table ref.cidade_dieese add column capital boolean not null default true;
update ref.cidade_dieese set capital = false where nome = 'Macaé' and uf_sigla = 'RJ';

create table dados.pof_despesa_uf (
  uf_codigo      smallint not null check (uf_codigo between 11 and 53),
  classe_codigo  integer not null references ref.pof_classe (codigo),
  item_codigo    integer not null,
  valor          numeric not null check (valor >= 0),
  carga_id       bigint not null references etl.carga (id),
  primary key (uf_codigo, classe_codigo, item_codigo)
);
alter table dados.pof_despesa_uf enable row level security;

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv',
                     'ibge_municipios', 'sidra_json', 'csv_series', 'siconfi_dca', 'sidra_pof', 'fipezap_cidades'));
alter table ref.coleta drop constraint coleta_serie_check;
alter table ref.coleta add constraint coleta_serie_check
  check ((formato in ('rfb_csv', 'anp_csv', 'ibge_municipios', 'csv_series', 'siconfi_dca', 'sidra_pof'))
         = (serie_id is null));

insert into ref.coleta (id, fonte_id, url, formato, serie_id, cabecalho_proprio) values
  ('sidra_pof_uf', 'ibge_pof',
   'https://apisidra.ibge.gov.br/values/t/6715/n3/all/v/1201/p/all/c339/all/c12190/103541,8018,8010,8022',
   'sidra_pof', null, false),
  ('fipezap_cidades_csv', 'fipezap',
   'https://raw.githubusercontent.com/Komido/transparencia/claude/tender-hopper-dbp169/dados-fonte/fipezap/aluguel-cidades-fipezap.csv',
   'fipezap_cidades', 'aluguel_m2', true);

-- ---------------------------------------------------------------------------
-- POF por UF
-- ---------------------------------------------------------------------------
create function etl.carregar_sidra_pof(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json       jsonb;
  v_cab        jsonb;
  v_total      integer;
  v_invalidos  integer;
  v_repetidos  integer;
  v_ufs        integer;
begin
  v_json := p_conteudo::jsonb;
  if jsonb_typeof(v_json) <> 'array' or jsonb_array_length(v_json) < 2 then
    raise exception 'POF: a resposta não é uma lista com dados';
  end if;
  v_cab := v_json -> 0;
  if v_cab ->> 'V' <> 'Valor' or v_cab ->> 'D1N' <> 'Unidade da Federação'
     or v_cab ->> 'D4N' <> 'Classes de rendimento total e variação patrimonial mensal familiar'
     or v_cab ->> 'D5N' <> 'Tipos de despesa' then
    raise exception 'POF: cabeçalho inesperado %', left(v_cab::text, 200);
  end if;

  with l as (
    select e from jsonb_array_elements(v_json) with ordinality as t(e, i)
     where i > 1 and e ->> 'D4C' <> '7999' and coalesce(e ->> 'V', '') not in ('...', '-', '..', 'X')
  )
  select count(*),
         count(*) filter (where not (e ->> 'V' ~ '^[0-9]+(\.[0-9]+)?$'
                                     and e ->> 'D1C' ~ '^[1-5][0-9]$'
                                     and e ->> 'D2C' = '1201'
                                     and (e ->> 'D4C')::int in (select codigo from ref.pof_classe)
                                     and e ->> 'D5C' in ('103541', '8018', '8010', '8022'))),
         count(*) - count(distinct (e ->> 'D1C', e ->> 'D4C', e ->> 'D5C')),
         count(distinct e ->> 'D1C')
    into v_total, v_invalidos, v_repetidos, v_ufs
    from l;
  if v_invalidos > 0 or v_repetidos > 0 then
    raise exception 'POF: % registros fora do formato e % repetidos', v_invalidos, v_repetidos;
  end if;
  if v_ufs <> 27 then
    raise exception 'POF: esperava 27 UFs, vieram %', v_ufs;
  end if;

  insert into dados.pof_despesa_uf (uf_codigo, classe_codigo, item_codigo, valor, carga_id)
  select (e ->> 'D1C')::smallint, (e ->> 'D4C')::int, (e ->> 'D5C')::int, (e ->> 'V')::numeric, p_carga
    from jsonb_array_elements(v_json) with ordinality as t(e, i)
   where i > 1 and e ->> 'D4C' <> '7999' and coalesce(e ->> 'V', '') not in ('...', '-', '..', 'X')
  on conflict (uf_codigo, classe_codigo, item_codigo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.pof_despesa_uf.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Aluguel do FipeZAP por cidade: "mes,cidade,uf,aluguel_m2"
-- ---------------------------------------------------------------------------
create function etl.carregar_fipezap_cidades(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_linhas      text[];
  v_erros       integer;
  v_repetidos   integer;
  v_sem_codigo  text[];
  v_total       integer;
  v_existentes  integer;
begin
  v_linhas := regexp_split_to_array(btrim(p_conteudo, E'\n'), E'\r?\n');
  if v_linhas[1] <> 'mes,cidade,uf,aluguel_m2' then
    raise exception 'FipeZAP: cabeçalho inesperado "%"', left(v_linhas[1], 120);
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  )
  select count(*) filter (where array_length(c, 1) <> 4
                             or c[1] !~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'
                             or c[3] !~ '^[A-Z]{2}$'
                             or c[4] !~ '^[0-9]+(\.[0-9]+)?$'),
         count(*) - count(distinct (c[1], c[2], c[3]))
    into v_erros, v_repetidos
    from l;
  if v_erros > 0 or v_repetidos > 0 then
    raise exception 'FipeZAP: % linhas fora do formato e % repetidas', v_erros, v_repetidos;
  end if;

  with l as (
    select distinct c[2] as cidade, c[3] as uf
      from (select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> '') q
  )
  select array_agg(l.cidade || '/' || l.uf) into v_sem_codigo
    from l
   where not exists (select 1 from ref.localidade m
                      where m.nivel = 'municipio' and m.nome = l.cidade and m.uf_sigla = l.uf);
  if v_sem_codigo is not null then
    raise exception 'FipeZAP: cidades sem código do IBGE: %', v_sem_codigo;
  end if;

  select count(*) into v_total from unnest(v_linhas[2:]) as x where btrim(x) <> '';
  select count(*) into v_existentes
    from dados.observacao where serie_id = p_serie and localidade_id <> 'BR';
  if v_total < v_existentes then
    raise exception 'FipeZAP: o arquivo trouxe % valores, menos que os % já gravados', v_total, v_existentes;
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  )
  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select p_serie, m.id, to_date(l.c[1] || '-01', 'YYYY-MM-DD'), l.c[4]::numeric, p_carga
    from l
    join ref.localidade m on m.nivel = 'municipio' and m.nome = l.c[2] and m.uf_sigla = l.c[3]
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Escolha do leitor por formato
-- ---------------------------------------------------------------------------
create function etl.carregar_formato(p_formato text, p_carga bigint, p_serie text, p_fonte text, p_texto text)
returns integer
language plpgsql
set search_path = ''
as $$
begin
  return case p_formato
    when 'sgs_json'        then etl.carregar_sgs(p_carga, p_serie, p_texto)
    when 'bls_json'        then etl.carregar_bls(p_carga, p_serie, p_texto)
    when 'rfb_csv'         then etl.carregar_rfb(p_carga, p_texto)
    when 'dieese_html'     then etl.carregar_dieese(p_carga, p_serie, p_texto)
    when 'dieese_produto'  then etl.carregar_dieese_produto(p_carga, p_serie, p_texto)
    when 'anp_csv'         then etl.carregar_anp_csv(p_carga, p_texto)
    when 'ibge_municipios' then etl.carregar_ibge_municipios(p_carga, p_texto)
    when 'sidra_json'      then etl.carregar_sidra(p_carga, p_serie, p_texto)
    when 'csv_series'      then etl.carregar_csv_series(p_carga, p_fonte, p_texto)
    when 'siconfi_dca'     then etl.carregar_siconfi_dca(p_carga, p_texto)
    when 'sidra_pof'       then etl.carregar_sidra_pof(p_carga, p_texto)
    when 'fipezap_cidades' then etl.carregar_fipezap_cidades(p_carga, p_serie, p_texto)
  end;
end
$$;

alter function etl.processar_respostas() rename to processar_respostas_v6;

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
    select k.id, k.coleta_id, k.requisicao_id, k.solicitada_em, c.formato, c.serie_id, c.codificacao, c.fonte_id
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
        v_linhas := etl.carregar_formato(v_carga.formato, v_carga.id, v_carga.serie_id, v_carga.fonte_id, v_texto);
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
