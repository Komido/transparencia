-- Orçamento da família, parte 2: aluguel (FipeZAP) e painel com a POF.
--
-- Aluguel: o conversor scripts/fipezap_para_csv.py grava em
-- dados-fonte/fipezap/aluguel-indice-fipezap.csv o preço médio de locação
-- (R$/m², total, média das cidades do Índice FipeZAP). O banco lê esse CSV
-- com um formato genérico, csv_series: cabeçalho "mes,<id da série>,...",
-- e cada coluna precisa ser uma série cadastrada da mesma fonte da coleta.
--
-- POF: faixas de renda da tabela 6715 em reais de 15/01/2018 (data de
-- referência da pesquisa; salário mínimo de R$ 954, conforme a publicação
-- "POF 2017-2018 - Primeiros resultados", IBGE).
--
-- Versões anteriores renomeadas: processar_respostas_v4, gerar_painel_v2.

create table ref.pof_classe (
  codigo     integer primary key,
  nome       text not null,
  renda_ate  numeric,
  ordem      smallint not null unique
);
alter table ref.pof_classe enable row level security;

insert into ref.pof_classe (codigo, nome, renda_ate, ordem) values
  (47558, 'Até 1.908 Reais', 1908, 1),
  (47559, 'Mais de 1.908 a 2.862 Reais', 2862, 2),
  (47560, 'Mais de 2.862 a 5.724 Reais', 5724, 3),
  (47561, 'Mais de 5.724 a 9.540 Reais', 9540, 4),
  (47562, 'Mais de 9.540 a 14.310 Reais', 14310, 5),
  (47563, 'Mais de 14.310 a 23.850 Reais', 23850, 6),
  (47564, 'Mais de 23.850 Reais', null, 7);

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('fipezap', 'Índice FipeZAP de preços de imóveis anunciados', 'Fipe',
   'https://www.fipe.org.br/pt-br/indices/fipezap/',
   'Preço pedido em anúncios de apartamentos nos portais do Grupo OLX (Zap, Viva Real e OLX). A Fipe publica em Excel; o arquivo é convertido para CSV por scripts/fipezap_para_csv.py, que registra o SHA-256 do original em dados-fonte/fipezap/origem.json.');

insert into ref.serie (id, nome, unidade, fonte_id, codigo_origem, observacao) values
  ('aluguel_m2', 'Aluguel residencial, preço médio pedido em anúncios', 'R$ por m² por mês', 'fipezap',
   'Índice FipeZAP, locação, preço médio (R$/m²), total',
   'Média das cidades acompanhadas pelo índice. Preços mensais são médias móveis de 3 meses.');

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv',
                     'ibge_municipios', 'sidra_json', 'csv_series'));
alter table ref.coleta drop constraint coleta_serie_check;
alter table ref.coleta add constraint coleta_serie_check
  check ((formato in ('rfb_csv', 'anp_csv', 'ibge_municipios', 'csv_series')) = (serie_id is null));

insert into ref.coleta (id, fonte_id, url, formato, serie_id) values
  ('fipezap_csv', 'fipezap',
   'https://raw.githubusercontent.com/Komido/transparencia/claude/tender-hopper-dbp169/dados-fonte/fipezap/aluguel-indice-fipezap.csv',
   'csv_series', null);

-- ---------------------------------------------------------------------------
-- CSV genérico: "mes,serie_a,serie_b" com mês AAAA-MM e números com ponto.
-- Célula vazia é dado ausente. Toda coluna precisa ser série da fonte da coleta.
-- ---------------------------------------------------------------------------
create function etl.carregar_csv_series(p_carga bigint, p_fonte text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_linhas      text[];
  v_cab         text[];
  v_desconhec   text[];
  v_erros       integer;
  v_total       integer;
  v_existentes  integer;
begin
  v_linhas := regexp_split_to_array(btrim(p_conteudo, E'\n'), E'\r?\n');
  v_cab := string_to_array(v_linhas[1], ',');
  if v_cab[1] <> 'mes' or array_length(v_cab, 1) < 2 then
    raise exception 'CSV: cabeçalho inesperado "%"', left(v_linhas[1], 120);
  end if;

  select array_agg(c) into v_desconhec
    from unnest(v_cab[2:]) as c
   where not exists (select 1 from ref.serie s where s.id = c and s.fonte_id = p_fonte);
  if v_desconhec is not null then
    raise exception 'CSV: colunas que não são séries da fonte %: %', p_fonte, v_desconhec;
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  )
  select count(*) filter (where array_length(c, 1) <> array_length(v_cab, 1)
                             or c[1] !~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'
                             or exists (select 1 from unnest(c[2:]) v where v <> '' and v !~ '^-?[0-9]+(\.[0-9]+)?$')),
         count(*) - count(distinct c[1])
    into v_erros, v_total
    from l;
  if v_erros > 0 then
    raise exception 'CSV: % linhas fora do formato esperado', v_erros;
  end if;
  if v_total > 0 then
    raise exception 'CSV: meses repetidos';
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  ),
  valores as (
    select v_cab[k + 1] as serie_id, to_date(l.c[1] || '-01', 'YYYY-MM-DD') as periodo, l.c[k + 1] as valor
      from l cross join generate_series(1, array_length(v_cab, 1) - 1) as k
     where l.c[k + 1] <> ''
  )
  select count(*) into v_total from valores;

  select count(*) into v_existentes
    from dados.observacao where serie_id = any (v_cab[2:]) and localidade_id = 'BR';
  if v_total < v_existentes then
    raise exception 'CSV: o arquivo trouxe % valores, menos que os % já gravados', v_total, v_existentes;
  end if;

  with l as (
    select string_to_array(x, ',') as c from unnest(v_linhas[2:]) as x where btrim(x) <> ''
  )
  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select v_cab[k + 1], 'BR', to_date(l.c[1] || '-01', 'YYYY-MM-DD'), l.c[k + 1]::numeric, p_carga
    from l cross join generate_series(1, array_length(v_cab, 1) - 1) as k
   where l.c[k + 1] <> ''
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

alter function etl.processar_respostas() rename to processar_respostas_v4;

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
        v_linhas := case v_carga.formato
          when 'sgs_json'        then etl.carregar_sgs(v_carga.id, v_carga.serie_id, v_texto)
          when 'bls_json'        then etl.carregar_bls(v_carga.id, v_carga.serie_id, v_texto)
          when 'rfb_csv'         then etl.carregar_rfb(v_carga.id, v_texto)
          when 'dieese_html'     then etl.carregar_dieese(v_carga.id, v_carga.serie_id, v_texto)
          when 'dieese_produto'  then etl.carregar_dieese_produto(v_carga.id, v_carga.serie_id, v_texto)
          when 'anp_csv'         then etl.carregar_anp_csv(v_carga.id, v_texto)
          when 'ibge_municipios' then etl.carregar_ibge_municipios(v_carga.id, v_texto)
          when 'sidra_json'      then etl.carregar_sidra(v_carga.id, v_carga.serie_id, v_texto)
          when 'csv_series'      then etl.carregar_csv_series(v_carga.id, v_carga.fonte_id, v_texto)
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

alter function etl.gerar_painel() rename to gerar_painel_v2;

create function etl.gerar_painel()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_inicio   constant date := date '1995-01-01';
  v_minimo   constant integer := 12;
  v_fim      date;
  v_dados    jsonb;
  v_sha      text;
begin
  select max(periodo) into v_fim
    from dados.observacao
   where serie_id = 'ipca_var' and localidade_id = 'BR';
  if v_fim is null then
    raise exception 'Painel: não há IPCA gravado; nada a publicar';
  end if;

  with meses as (
    select gs::date as periodo
      from generate_series(v_inicio, v_fim, interval '1 month') as gs
  ),
  painel_cidades as (
    select l.id
      from ref.cidade_dieese c
      join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla
     where c.painel_1995
  ),
  media_capitais as (
    select o.serie_id, o.periodo, avg(o.valor) as valor, count(*) as n
      from dados.observacao o
      join painel_cidades pc on pc.id = o.localidade_id
      join ref.serie s on s.id = o.serie_id and s.fonte_id = 'dieese_cesta'
     group by o.serie_id, o.periodo
  ),
  series as (
    select s.id,
           jsonb_agg(case when s.fonte_id = 'dieese_cesta'
                          then case when mc.n >= v_minimo then round(mc.valor, 2) end
                          else o.valor end
                     order by m.periodo) as valores
      from ref.serie s
     cross join meses m
      left join dados.observacao o
        on o.serie_id = s.id and o.localidade_id = 'BR' and o.periodo = m.periodo
      left join media_capitais mc
        on mc.serie_id = s.id and mc.periodo = m.periodo
     group by s.id
  ),
  meses_arrec as (
    select distinct periodo from dados.arrecadacao_federal
  ),
  arrec_mes as (
    select a.periodo, r.grupo, sum(a.valor) as total
      from dados.arrecadacao_federal a
      join ref.rubrica_receita r on r.posicao = a.posicao
     group by a.periodo, r.grupo
  ),
  grupos as (
    select grupo, bool_and(serie_comparavel) as comparavel, min(posicao) as ordem
      from ref.rubrica_receita
     group by grupo
  ),
  grupos_series as (
    select g.grupo, g.comparavel, g.ordem,
           jsonb_agg(case when ma.periodo is null then null
                          else round(coalesce(am.total, 0) / 1000000.0, 3) end
                     order by m.periodo) as valores
      from grupos g
     cross join meses m
      left join meses_arrec ma on ma.periodo = m.periodo
      left join arrec_mes am on am.periodo = m.periodo and am.grupo = g.grupo
     group by g.grupo, g.comparavel, g.ordem
  )
  select jsonb_build_object(
    'esquema', 1,
    'mensal', jsonb_build_object(
      'inicio', to_char(v_inicio, 'YYYY-MM'),
      'fim', to_char(v_fim, 'YYYY-MM'),
      'series', (select jsonb_object_agg(id, valores) from series),
      'arrecadacao_grupos', (
        select jsonb_agg(jsonb_build_object('grupo', grupo, 'comparavel', comparavel, 'valores', valores)
                         order by ordem)
          from grupos_series)
    ),
    'series', (
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'nome', s.nome, 'unidade', s.unidade, 'fonte', s.fonte_id,
               'codigo', s.codigo_origem, 'observacao', s.observacao,
               'ultimo_periodo', (select to_char(max(o.periodo), 'YYYY-MM') from dados.observacao o
                                   where o.serie_id = s.id),
               'urls', (select jsonb_agg(c.url order by c.id) from ref.coleta c where c.serie_id = s.id))
             order by s.id)
        from ref.serie s),
    'precos', jsonb_build_object(
      'capitais_media', (select jsonb_agg(c.nome order by c.nome) from ref.cidade_dieese c where c.painel_1995),
      'minimo_capitais', v_minimo,
      'combustiveis_url', (select url from ref.coleta where id = 'anp_csv')),
    'arrecadacao', jsonb_build_object(
      'primeiro_periodo', (select to_char(min(periodo), 'YYYY-MM') from dados.arrecadacao_federal),
      'ultimo_periodo', (select to_char(max(periodo), 'YYYY-MM') from dados.arrecadacao_federal),
      'url', (select url from ref.coleta where id = 'rfb_csv'),
      'rubricas', (select jsonb_agg(jsonb_build_object('nome', nome, 'grupo', grupo, 'comparavel', serie_comparavel)
                                    order by posicao) from ref.rubrica_receita)),
    'fontes', (
      select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome, 'orgao', f.orgao,
                                          'url', f.url_documentacao, 'observacao', f.observacao)
                       order by f.id)
        from ref.fonte f),
    'mandatos', (
      select jsonb_agg(jsonb_build_object('id', m.id, 'ordem', m.ordem, 'nome', m.nome, 'rotulo', m.rotulo,
                                          'partido', m.partido, 'inicio', m.inicio, 'fim', m.fim,
                                          'observacao', m.observacao, 'fonte_url', m.fonte_url)
                       order by m.ordem)
        from ref.mandato m
       where m.localidade_id = 'BR' and m.cargo = 'presidente'),
    'ir_tabela', (
      select jsonb_agg(jsonb_build_object('inicio', to_char(t.vigencia_inicio, 'YYYY-MM'),
                                          'limite_tabela', t.limite_tabela,
                                          'desconto_simplificado', t.desconto_simplificado,
                                          'isencao_efetiva', t.isencao_efetiva,
                                          'norma', t.norma, 'fonte_url', t.fonte_url,
                                          'conferido_na_fonte', t.conferido_na_fonte,
                                          'observacao', t.observacao)
                       order by t.vigencia_inicio)
        from ref.ir_tabela t)
  ) into v_dados;

  v_dados := v_dados || jsonb_build_object('avisos', (
    with m as (
      select posicao, periodo, md5(array_agg(valor order by uf)::text) as assinatura,
             count(*) as ufs, sum(abs(valor)) as soma
        from dados.arrecadacao_federal
       group by posicao, periodo
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'tipo', 'valores_repetidos',
             'fonte', 'rfb_arrecadacao',
             'rubrica', r.nome,
             'grupo', r.grupo,
             'mes', to_char(a.periodo, 'YYYY-MM'),
             'igual_a', to_char(b.periodo, 'YYYY-MM'))
           order by a.periodo, a.posicao), '[]'::jsonb)
      from m a
      join m b on b.posicao = a.posicao and b.assinatura = a.assinatura and b.periodo > a.periodo
      join ref.rubrica_receita r on r.posicao = a.posicao
     where a.ufs >= 20 and a.soma > 0));

  -- Orçamento da família: gastos da POF 2017-2018 por faixa de renda.
  v_dados := v_dados || jsonb_build_object('orcamento', jsonb_build_object(
    'pof', jsonb_build_object(
      'data_referencia', '2018-01-15',
      'mes_referencia', '2018-01',
      'salario_minimo_referencia', 954,
      'fonte_url', 'https://sidra.ibge.gov.br/tabela/6715',
      'classes', (
        select jsonb_agg(jsonb_build_object(
                 'codigo', c.codigo, 'nome', c.nome, 'renda_ate', c.renda_ate,
                 'itens', (select jsonb_object_agg(
                                    case p.item_codigo
                                      when 8010 then 'agua' when 8018 then 'luz' when 8022 then 'gas'
                                      when 8007 then 'aluguel_monetario' when 103541 then 'aluguel'
                                      when 103540 then 'habitacao' when 103536 then 'despesa_total' end,
                                    p.valor)
                             from ref.pof_despesa p where p.classe_codigo = c.codigo))
               order by c.ordem)
          from ref.pof_classe c))));

  v_sha := encode(extensions.digest(v_dados::text, 'sha256'), 'hex');

  v_dados := v_dados || jsonb_build_object(
    'versao', v_sha,
    'coletas', (
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'ultima_ok', (select max(k.processada_em) from etl.carga k
                              where k.coleta_id = c.id and k.status in ('ok', 'sem_mudanca')),
               'ultimo_status', (select k.status from etl.carga k
                                  where k.coleta_id = c.id and k.status <> 'pendente'
                                  order by k.id desc limit 1))
             order by c.id)
        from ref.coleta c));

  insert into painel.versao (gerado_em, sha256, dados)
  values (now(), v_sha, v_dados)
  on conflict (sha256) do nothing;

  insert into painel.snapshot (id, gerado_em, sha256, dados)
  values (1, now(), v_sha, v_dados)
  on conflict (id) do update
     set gerado_em = excluded.gerado_em, sha256 = excluded.sha256, dados = excluded.dados;

  return v_sha;
end
$$;
