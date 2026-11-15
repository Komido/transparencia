-- ICMS, IPVA e ITCD (ITCMD) de cada estado, mês a mês, desde 2015.
--
-- Fonte: RREO-Anexo 03 (demonstrativo da receita corrente líquida) de cada
-- estado e do Distrito Federal, na API do SICONFI (Tesouro Nacional). O anexo
-- traz a receita de cada um dos 12 meses que terminam no fim do bimestre
-- (colunas <MR-11> a <MR>, em que <MR> é o último mês do bimestre) e o total
-- desses 12 meses.
--
-- Contas usadas, conferidas em 15/11/2026 nos relatórios de 2015 (BA),
-- 2016 (SP), 2017 (PR), 2018 (AC), 2020 (RJ), 2022 (DF), 2025 (SP) e 2026
-- (SP e RR, 4º bimestre):
--   ICMSLiquidoExcetoTransferenciasEFUNDEB
--   IPVALiquidoExcetoTransferenciasEFUNDEB
--   ITCDLiquidoExcetoTransferenciasEFUNDEB
-- "Líquido" é depois das restituições e outras deduções da própria receita.
-- "Exceto transferências e FUNDEB" quer dizer que o valor ainda inclui a
-- parte que o estado repassa às prefeituras e ao FUNDEB: é o que o estado
-- arrecadou.
--
-- Conferências feitas nos mesmos relatórios: a soma dos 12 meses é igual ao
-- total do relatório, centavo por centavo; e o mesmo mês informado em dois
-- relatórios (São Paulo, setembro a dezembro de 2025, no 6º bimestre de 2025
-- e no 4º de 2026) tem o mesmo valor. Exemplo: ICMS de São Paulo em 2025,
-- R$ 238.061.225.357,02.
--
-- Quando um mês aparece em mais de um relatório, vale o do relatório mais
-- recente (ano e bimestre), para pegar correções sem que um relatório antigo
-- desfaça uma correção.
--
-- Coletas:
--   * 2015 a 2024 e o último ano fechado ({ano_anterior}): 6º bimestre, uma
--     vez por mês, cada coleta num dia;
--   * ano corrente: os dois últimos bimestres já encerrados, todo dia
--     ({rreo_bimestre_1} e {rreo_bimestre_2}). O relatório sai até 30 dias
--     depois do fim do bimestre; o segundo cobre estados que atrasam. Um
--     bimestre ainda não entregue volta vazio e não grava nada.
--
-- Versões anteriores renomeadas: enviar_requisicao_v2, carregar_formato_v3,
-- painel_blocos_extras_v4.

create table dados.receita_uf (
  mes                date not null check (extract(day from mes) = 1),
  uf_codigo          smallint not null check (uf_codigo between 11 and 53),
  tributo            text not null check (tributo in ('icms', 'ipva', 'itcd')),
  valor              numeric not null,
  relatorio_ano      smallint not null check (relatorio_ano between 2000 and 2100),
  relatorio_bimestre smallint not null check (relatorio_bimestre between 1 and 6),
  carga_id           bigint not null references etl.carga (id),
  primary key (mes, uf_codigo, tributo)
);
alter table dados.receita_uf enable row level security;

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('stn_siconfi_rreo', 'Relatório Resumido da Execução Orçamentária dos estados (SICONFI)', 'Tesouro Nacional',
   'https://apidatalake.tesouro.gov.br/docs/siconfi/',
   'RREO de cada estado, Anexo 3 (receita corrente líquida): ICMS, IPVA e ITCD de cada um dos 12 meses até o fim do bimestre.');

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv',
                     'ibge_municipios', 'sidra_json', 'csv_series', 'siconfi_dca', 'sidra_pof', 'fipezap_cidades',
                     'anp_estados_csv', 'siconfi_rgf', 'siconfi_rreo3'));
alter table ref.coleta drop constraint coleta_serie_check;
alter table ref.coleta add constraint coleta_serie_check
  check ((formato in ('rfb_csv', 'anp_csv', 'ibge_municipios', 'csv_series', 'siconfi_dca', 'sidra_pof',
                      'anp_estados_csv', 'siconfi_rgf', 'siconfi_rreo3')) = (serie_id is null));

-- Anos fechados: uma coleta por estado e ano, espalhadas pelos dias 1 a 28.
insert into ref.coleta (id, fonte_id, url, formato, serie_id, dia_do_mes)
select 'rreo3_' || u.id || '_' || a.rotulo, 'stn_siconfi_rreo',
       'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rreo?an_exercicio=' || a.ano
         || '&nr_periodo=6&co_tipo_demonstrativo=RREO&no_anexo=RREO-Anexo%2003&co_esfera=E&id_ente=' || u.id,
       'siconfi_rreo3', null,
       (1 + (row_number() over (order by a.ordem, u.id) - 1) % 28)::smallint
  from ref.localidade u
 cross join (select g::text as ano, g::text as rotulo, g as ordem from generate_series(2015, 2024) as g
             union all
             select '{ano_anterior}', 'ano_anterior', 9999) as a
 where u.nivel = 'uf';

-- Ano corrente: os dois últimos bimestres encerrados, todo dia.
insert into ref.coleta (id, fonte_id, url, formato, serie_id, dia_do_mes)
select 'rreo3_' || u.id || '_bimestre_' || b.n, 'stn_siconfi_rreo',
       'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rreo?{rreo_bimestre_' || b.n
         || '}&co_tipo_demonstrativo=RREO&no_anexo=RREO-Anexo%2003&co_esfera=E&id_ente=' || u.id,
       'siconfi_rreo3', null, null
  from ref.localidade u
 cross join (values (1), (2)) as b(n)
 where u.nivel = 'uf';

-- ---------------------------------------------------------------------------
-- Endereço com o bimestre: {rreo_bimestre_1} é o último bimestre encerrado,
-- {rreo_bimestre_2} o anterior. Em 15/11/2026: 5º e 4º de 2026. Em janeiro:
-- 6º e 5º do ano anterior. Em março: 1º do ano e 6º do ano anterior.
-- ---------------------------------------------------------------------------
alter function etl.enviar_requisicao(text) rename to enviar_requisicao_v2;

create function etl.enviar_requisicao(p_coleta text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_coleta     record;
  v_agora      timestamp := now() at time zone 'America/Sao_Paulo';
  v_fim        date;
  v_b1_ano     integer;
  v_b1         integer;
  v_b2_ano     integer;
  v_b2         integer;
  v_url        text;
  v_cabecalho  jsonb;
  v_req        bigint;
begin
  select id, url, metodo, corpo, cabecalho_proprio into v_coleta from ref.coleta where id = p_coleta;
  if not found then
    raise exception 'Coleta % não existe', p_coleta;
  end if;

  -- Último dia do mês anterior: o bimestre que terminou até ele.
  v_fim := (date_trunc('month', v_agora) - interval '1 day')::date;
  v_b1_ano := extract(year from v_fim)::int;
  v_b1 := extract(month from v_fim)::int / 2;
  if v_b1 = 0 then
    v_b1 := 6;
    v_b1_ano := v_b1_ano - 1;
  end if;
  v_b2_ano := v_b1_ano;
  v_b2 := v_b1 - 1;
  if v_b2 = 0 then
    v_b2 := 6;
    v_b2_ano := v_b2_ano - 1;
  end if;

  v_url := replace(v_coleta.url, '{mes_atual}', to_char(v_agora, 'MMYYYY'));
  v_url := replace(v_url, '{ano_anterior}', (extract(year from v_agora)::int - 1)::text);
  v_url := replace(v_url, '{rreo_bimestre_1}', 'an_exercicio=' || v_b1_ano || '&nr_periodo=' || v_b1);
  v_url := replace(v_url, '{rreo_bimestre_2}', 'an_exercicio=' || v_b2_ano || '&nr_periodo=' || v_b2);
  v_cabecalho := case when v_coleta.cabecalho_proprio
                      then jsonb_build_object('User-Agent', 'ArrecadometroBrasil/1.0 (coleta de dados publicos)')
                      else '{}'::jsonb end;

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
  return v_req;
end
$$;

-- ---------------------------------------------------------------------------
-- RREO, anexo 3
-- ---------------------------------------------------------------------------
create function etl.carregar_siconfi_rreo3(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json      jsonb;
  v_itens     jsonb;
  v_n         integer;
  v_ano       integer;
  v_bim       integer;
  v_uf        integer;
  v_anexo     text;
  v_problema  text;
begin
  v_json := p_conteudo::jsonb;
  v_itens := v_json -> 'items';
  if jsonb_typeof(v_itens) is distinct from 'array' then
    raise exception 'RREO: resposta sem lista de itens';
  end if;
  if coalesce((v_json ->> 'hasMore')::boolean, false) then
    raise exception 'RREO: resposta dividida em páginas';
  end if;
  -- Relatório ainda não entregue: nada a gravar.
  if jsonb_array_length(v_itens) = 0 then
    return 0;
  end if;

  select count(distinct (e ->> 'exercicio', e ->> 'periodo', e ->> 'cod_ibge', e ->> 'anexo')),
         min((e ->> 'exercicio')::int), min((e ->> 'periodo')::int), min((e ->> 'cod_ibge')::int), min(e ->> 'anexo')
    into v_n, v_ano, v_bim, v_uf, v_anexo
    from jsonb_array_elements(v_itens) e;
  if v_n <> 1 or v_uf not between 11 and 53 or v_anexo is distinct from 'RREO-Anexo 03' or v_bim not between 1 and 6 then
    raise exception 'RREO: resposta fora do esperado (% combinações, UF %, anexo %, bimestre %)', v_n, v_uf, v_anexo, v_bim;
  end if;

  -- Para cada tributo: 12 meses, cada um uma vez, com número; total igual à
  -- soma dos meses.
  with l as (
    select case e ->> 'cod_conta'
             when 'ICMSLiquidoExcetoTransferenciasEFUNDEB' then 'icms'
             when 'IPVALiquidoExcetoTransferenciasEFUNDEB' then 'ipva'
             when 'ITCDLiquidoExcetoTransferenciasEFUNDEB' then 'itcd' end as tributo,
           e ->> 'coluna' as col, e -> 'valor' as valor
      from jsonb_array_elements(v_itens) e
     where e ->> 'cod_conta' in ('ICMSLiquidoExcetoTransferenciasEFUNDEB', 'IPVALiquidoExcetoTransferenciasEFUNDEB',
                                 'ITCDLiquidoExcetoTransferenciasEFUNDEB')
       and (e ->> 'coluna' ~ '^<MR(-([1-9]|1[01]))?>$' or e ->> 'coluna' = 'TOTAL (ÚLTIMOS 12 MESES)')
  ),
  t(tributo) as (values ('icms'), ('ipva'), ('itcd')),
  resumo as (
    select t.tributo,
           count(l.col) filter (where l.col <> 'TOTAL (ÚLTIMOS 12 MESES)') as meses,
           count(distinct l.col) filter (where l.col <> 'TOTAL (ÚLTIMOS 12 MESES)') as meses_distintos,
           count(l.col) filter (where l.col = 'TOTAL (ÚLTIMOS 12 MESES)') as totais,
           count(l.col) filter (where jsonb_typeof(l.valor) is distinct from 'number') as invalidos,
           sum((l.valor #>> '{}')::numeric) filter (where l.col <> 'TOTAL (ÚLTIMOS 12 MESES)' and jsonb_typeof(l.valor) = 'number') as soma,
           max((l.valor #>> '{}')::numeric) filter (where l.col = 'TOTAL (ÚLTIMOS 12 MESES)' and jsonb_typeof(l.valor) = 'number') as total
      from t left join l on l.tributo = t.tributo
     group by t.tributo
  )
  select string_agg(format('%s: %s meses (%s distintos), %s totais, %s inválidos, soma %s, total %s',
                           tributo, meses, meses_distintos, totais, invalidos, soma, total), '; ')
    into v_problema
    from resumo
   where meses <> 12 or meses_distintos <> 12 or totais <> 1 or invalidos > 0 or abs(soma - total) > 0.05;
  if v_problema is not null then
    raise exception 'RREO 3 (UF %, %/%): %', v_uf, v_ano, v_bim, v_problema;
  end if;

  insert into dados.receita_uf (mes, uf_codigo, tributo, valor, relatorio_ano, relatorio_bimestre, carga_id)
  select (make_date(v_ano, 2 * v_bim, 1)
           - make_interval(months => coalesce(substring(e ->> 'coluna' from '^<MR-([0-9]+)>$')::int, 0)))::date,
         v_uf,
         case e ->> 'cod_conta'
           when 'ICMSLiquidoExcetoTransferenciasEFUNDEB' then 'icms'
           when 'IPVALiquidoExcetoTransferenciasEFUNDEB' then 'ipva'
           else 'itcd' end,
         (e ->> 'valor')::numeric, v_ano, v_bim, p_carga
    from jsonb_array_elements(v_itens) e
   where e ->> 'cod_conta' in ('ICMSLiquidoExcetoTransferenciasEFUNDEB', 'IPVALiquidoExcetoTransferenciasEFUNDEB',
                               'ITCDLiquidoExcetoTransferenciasEFUNDEB')
     and e ->> 'coluna' ~ '^<MR(-([1-9]|1[01]))?>$'
  on conflict (mes, uf_codigo, tributo) do update
     set valor = excluded.valor, relatorio_ano = excluded.relatorio_ano,
         relatorio_bimestre = excluded.relatorio_bimestre, carga_id = excluded.carga_id
   where (excluded.relatorio_ano, excluded.relatorio_bimestre)
           > (dados.receita_uf.relatorio_ano, dados.receita_uf.relatorio_bimestre)
      or ((excluded.relatorio_ano, excluded.relatorio_bimestre)
           = (dados.receita_uf.relatorio_ano, dados.receita_uf.relatorio_bimestre)
          and dados.receita_uf.valor is distinct from excluded.valor);

  -- 3 tributos x 12 meses lidos (gravados só os que mudaram).
  return 36;
end
$$;

alter function etl.carregar_formato(text, bigint, text, text, text) rename to carregar_formato_v3;

create function etl.carregar_formato(p_formato text, p_carga bigint, p_serie text, p_fonte text, p_texto text)
returns integer
language plpgsql
set search_path = ''
as $$
begin
  if p_formato = 'siconfi_rreo3' then
    return etl.carregar_siconfi_rreo3(p_carga, p_texto);
  end if;
  return etl.carregar_formato_v3(p_formato, p_carga, p_serie, p_fonte, p_texto);
end
$$;

-- ---------------------------------------------------------------------------
-- Painel: bloco "estados_receita"
--   anos: anos completos desde 2015;
--   doze_meses_ate: último mês em que os 27 estados já informaram, para
--     somar o país no mesmo período;
--   por estado: total de cada ano (só anos com os 12 meses), total dos 12
--     meses até doze_meses_ate e o último mês informado. Valores em reais da
--     época.
-- ---------------------------------------------------------------------------
create function etl.painel_receita_estados()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with anual as (
    select uf_codigo, tributo, extract(year from mes)::int as ano, sum(valor) as valor, count(*) as meses
      from dados.receita_uf
     group by 1, 2, 3
  ),
  anos as (
    select generate_series(2015, (select max(ano) from anual where meses = 12)) as ano
  ),
  ultimo as (
    select uf_codigo, max(mes) as mes from dados.receita_uf where tributo = 'icms' group by 1
  ),
  fim as (
    select min(mes) as mes from ultimo having count(*) = (select count(*) from ref.localidade where nivel = 'uf')
  ),
  doze as (
    select r.uf_codigo, r.tributo, sum(r.valor) as valor, count(*) as meses
      from dados.receita_uf r, fim
     where r.mes > (fim.mes - interval '12 months')::date and r.mes <= fim.mes
     group by 1, 2
  ),
  tributos(tributo) as (values ('icms'), ('ipva'), ('itcd'))
  select jsonb_build_object(
    'fonte_url', 'https://apidatalake.tesouro.gov.br/docs/siconfi/',
    'anos', (select jsonb_agg(ano order by ano) from anos),
    'doze_meses_ate', (select to_char(mes, 'YYYY-MM') from fim),
    'estados', (
      select jsonb_agg(jsonb_build_object(
               'codigo', u.id, 'sigla', u.uf_sigla, 'nome', u.nome,
               'ultimo_mes', (select to_char(x.mes, 'YYYY-MM') from ultimo x where x.uf_codigo = u.id::smallint),
               'anual', (select jsonb_object_agg(t.tributo,
                                  (select jsonb_agg((select round(a.valor, 2) from anual a
                                                      where a.uf_codigo = u.id::smallint and a.tributo = t.tributo
                                                        and a.ano = y.ano and a.meses = 12)
                                                    order by y.ano)
                                     from anos y))
                           from tributos t),
               'doze_meses', (select jsonb_object_agg(d.tributo, round(d.valor, 2))
                                from doze d where d.uf_codigo = u.id::smallint and d.meses = 12))
             order by u.nome)
        from ref.localidade u
       where u.nivel = 'uf'))
$$;

alter function etl.painel_blocos_extras() rename to painel_blocos_extras_v4;

create function etl.painel_blocos_extras()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select etl.painel_blocos_extras_v4() || jsonb_build_object('estados_receita', etl.painel_receita_estados())
$$;
