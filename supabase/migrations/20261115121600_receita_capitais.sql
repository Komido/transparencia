-- ISS, IPTU e ITBI das 27 capitais, mês a mês, desde 2015.
--
-- Fonte: RREO-Anexo 03 de cada prefeitura (co_esfera=M), na API do SICONFI,
-- o mesmo anexo já usado para os estados. Contas usadas, conferidas em
-- 15/11/2026 nos relatórios de São Paulo (2025 e 2026, 4º bimestre),
-- Palmas (2025), Belo Horizonte (2016), Campinas (2025), Macapá (2015),
-- Porto Velho (2015), Rio Branco (2018), Boa Vista (2017), Teresina (2026,
-- 4º bimestre), Rio de Janeiro (2020) e São Luís (2016):
--   ISSLiquidoExcetoTransferenciasEFUNDEB
--   IPTULiquidoExcetoTransferenciasEFUNDEB
--   ITBILiquidoExcetoTransferenciasEFUNDEB
-- Exemplo: São Paulo em 2025, ISS de R$ 39,5 bilhões, IPTU de R$ 18,1
-- bilhões e ITBI de R$ 4,7 bilhões.
--
-- Brasília não tem prefeitura: quem cobra ISS, IPTU e ITBI é o governo do
-- Distrito Federal, e a API não tem relatório municipal para 5300108
-- (resposta vazia em 2025). Esses impostos estão no relatório do próprio
-- Distrito Federal (id_ente 53), com as mesmas contas, em todos os anos de
-- 2015 a 2026 (conferido). Por isso o carregador grava, a partir do
-- relatório do Distrito Federal, o ICMS, o IPVA e o ITCD como estado e o
-- ISS, o IPTU e o ITBI como Brasília.
--
-- As mesmas conferências dos estados valem aqui: 12 meses por imposto, cada
-- um uma vez, e soma igual ao total do relatório. Mês repetido em dois
-- relatórios fica com o do relatório mais recente.
--
-- Coletas: as mesmas regras dos estados (anos fechados uma vez por mês, cada
-- uma num dia; os dois últimos bimestres encerrados todo dia), para as 26
-- capitais com prefeitura. Brasília vem das coletas do Distrito Federal.
--
-- Versões anteriores renomeadas: carregar_siconfi_rreo3_v1,
-- painel_blocos_extras_v5.

create table dados.receita_municipio (
  mes                date not null check (extract(day from mes) = 1),
  municipio_codigo   integer not null check (municipio_codigo between 1100000 and 5399999),
  tributo            text not null check (tributo in ('iss', 'iptu', 'itbi')),
  valor              numeric not null,
  relatorio_ano      smallint not null check (relatorio_ano between 2000 and 2100),
  relatorio_bimestre smallint not null check (relatorio_bimestre between 1 and 6),
  carga_id           bigint not null references etl.carga (id),
  primary key (mes, municipio_codigo, tributo)
);
alter table dados.receita_municipio enable row level security;

-- Capitais com prefeitura (Brasília fica de fora: vem do Distrito Federal).
insert into ref.coleta (id, fonte_id, url, formato, serie_id, dia_do_mes)
select 'rreo3m_' || l.id || '_' || a.rotulo, 'stn_siconfi_rreo',
       'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rreo?an_exercicio=' || a.ano
         || '&nr_periodo=6&co_tipo_demonstrativo=RREO&no_anexo=RREO-Anexo%2003&co_esfera=M&id_ente=' || l.id,
       'siconfi_rreo3', null,
       (1 + (row_number() over (order by a.ordem, l.id) + 13) % 28)::smallint
  from ref.cidade_dieese c
  join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla
 cross join (select g::text as ano, g::text as rotulo, g as ordem from generate_series(2015, 2024) as g
             union all
             select '{ano_anterior}', 'ano_anterior', 9999) as a
 where c.capital and l.id <> '5300108';

insert into ref.coleta (id, fonte_id, url, formato, serie_id, dia_do_mes)
select 'rreo3m_' || l.id || '_bimestre_' || b.n, 'stn_siconfi_rreo',
       'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rreo?{rreo_bimestre_' || b.n
         || '}&co_tipo_demonstrativo=RREO&no_anexo=RREO-Anexo%2003&co_esfera=M&id_ente=' || l.id,
       'siconfi_rreo3', null, null
  from ref.cidade_dieese c
  join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla
 cross join (values (1), (2)) as b(n)
 where c.capital and l.id <> '5300108';

-- ---------------------------------------------------------------------------
-- Conferência de um grupo de contas do anexo 3: 12 meses, cada um uma vez,
-- com número, e um total igual à soma. Devolve o problema ou null.
-- ---------------------------------------------------------------------------
create function etl.rreo3_conferir(p_itens jsonb, p_contas text[])
returns text
language sql
immutable
set search_path = ''
as $$
  with l as (
    select e ->> 'cod_conta' as conta, e ->> 'coluna' as col, e -> 'valor' as valor
      from jsonb_array_elements(p_itens) e
     where e ->> 'cod_conta' = any (p_contas)
       and (e ->> 'coluna' ~ '^<MR(-([1-9]|1[01]))?>$' or e ->> 'coluna' = 'TOTAL (ÚLTIMOS 12 MESES)')
  ),
  resumo as (
    select c.conta,
           count(l.col) filter (where l.col <> 'TOTAL (ÚLTIMOS 12 MESES)') as meses,
           count(distinct l.col) filter (where l.col <> 'TOTAL (ÚLTIMOS 12 MESES)') as meses_distintos,
           count(l.col) filter (where l.col = 'TOTAL (ÚLTIMOS 12 MESES)') as totais,
           count(l.col) filter (where jsonb_typeof(l.valor) is distinct from 'number') as invalidos,
           sum((l.valor #>> '{}')::numeric) filter (where l.col <> 'TOTAL (ÚLTIMOS 12 MESES)' and jsonb_typeof(l.valor) = 'number') as soma,
           max((l.valor #>> '{}')::numeric) filter (where l.col = 'TOTAL (ÚLTIMOS 12 MESES)' and jsonb_typeof(l.valor) = 'number') as total
      from unnest(p_contas) as c(conta)
      left join l on l.conta = c.conta
     group by c.conta
  )
  select string_agg(format('%s: %s meses (%s distintos), %s totais, %s inválidos, soma %s, total %s',
                           conta, meses, meses_distintos, totais, invalidos, soma, total), '; ')
    from resumo
   where meses <> 12 or meses_distintos <> 12 or totais <> 1 or invalidos > 0 or abs(soma - total) > 0.05
$$;

-- ---------------------------------------------------------------------------
-- Carregador do anexo 3 para estados, Distrito Federal e prefeituras.
-- ---------------------------------------------------------------------------
alter function etl.carregar_siconfi_rreo3(bigint, text) rename to carregar_siconfi_rreo3_v1;

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
  v_ente      bigint;
  v_anexo     text;
  v_problema  text;
  v_lidos     integer := 0;
  v_estaduais constant text[] := array['ICMSLiquidoExcetoTransferenciasEFUNDEB', 'IPVALiquidoExcetoTransferenciasEFUNDEB',
                                       'ITCDLiquidoExcetoTransferenciasEFUNDEB'];
  v_municipais constant text[] := array['ISSLiquidoExcetoTransferenciasEFUNDEB', 'IPTULiquidoExcetoTransferenciasEFUNDEB',
                                        'ITBILiquidoExcetoTransferenciasEFUNDEB'];
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
         min((e ->> 'exercicio')::int), min((e ->> 'periodo')::int), min((e ->> 'cod_ibge')::bigint), min(e ->> 'anexo')
    into v_n, v_ano, v_bim, v_ente, v_anexo
    from jsonb_array_elements(v_itens) e;
  if v_n <> 1 or v_anexo is distinct from 'RREO-Anexo 03' or v_bim not between 1 and 6
     or not (v_ente between 11 and 53 or v_ente between 1100000 and 5399999) then
    raise exception 'RREO: resposta fora do esperado (% combinações, ente %, anexo %, bimestre %)', v_n, v_ente, v_anexo, v_bim;
  end if;

  -- Estados e Distrito Federal: ICMS, IPVA e ITCD.
  if v_ente between 11 and 53 then
    v_problema := etl.rreo3_conferir(v_itens, v_estaduais);
    if v_problema is not null then
      raise exception 'RREO 3 (UF %, %/%): %', v_ente, v_ano, v_bim, v_problema;
    end if;
    insert into dados.receita_uf (mes, uf_codigo, tributo, valor, relatorio_ano, relatorio_bimestre, carga_id)
    select (make_date(v_ano, 2 * v_bim, 1)
             - make_interval(months => coalesce(substring(e ->> 'coluna' from '^<MR-([0-9]+)>$')::int, 0)))::date,
           v_ente,
           case e ->> 'cod_conta'
             when 'ICMSLiquidoExcetoTransferenciasEFUNDEB' then 'icms'
             when 'IPVALiquidoExcetoTransferenciasEFUNDEB' then 'ipva'
             else 'itcd' end,
           (e ->> 'valor')::numeric, v_ano, v_bim, p_carga
      from jsonb_array_elements(v_itens) e
     where e ->> 'cod_conta' = any (v_estaduais)
       and e ->> 'coluna' ~ '^<MR(-([1-9]|1[01]))?>$'
    on conflict (mes, uf_codigo, tributo) do update
       set valor = excluded.valor, relatorio_ano = excluded.relatorio_ano,
           relatorio_bimestre = excluded.relatorio_bimestre, carga_id = excluded.carga_id
     where (excluded.relatorio_ano, excluded.relatorio_bimestre)
             > (dados.receita_uf.relatorio_ano, dados.receita_uf.relatorio_bimestre)
        or ((excluded.relatorio_ano, excluded.relatorio_bimestre)
             = (dados.receita_uf.relatorio_ano, dados.receita_uf.relatorio_bimestre)
            and dados.receita_uf.valor is distinct from excluded.valor);
    v_lidos := v_lidos + 36;
  end if;

  -- Prefeituras, e o Distrito Federal no papel de Brasília: ISS, IPTU e ITBI.
  if v_ente = 53 or v_ente >= 1100000 then
    v_problema := etl.rreo3_conferir(v_itens, v_municipais);
    if v_problema is not null then
      raise exception 'RREO 3 (município %, %/%): %', case when v_ente = 53 then 5300108 else v_ente end, v_ano, v_bim, v_problema;
    end if;
    insert into dados.receita_municipio (mes, municipio_codigo, tributo, valor, relatorio_ano, relatorio_bimestre, carga_id)
    select (make_date(v_ano, 2 * v_bim, 1)
             - make_interval(months => coalesce(substring(e ->> 'coluna' from '^<MR-([0-9]+)>$')::int, 0)))::date,
           case when v_ente = 53 then 5300108 else v_ente end,
           case e ->> 'cod_conta'
             when 'ISSLiquidoExcetoTransferenciasEFUNDEB' then 'iss'
             when 'IPTULiquidoExcetoTransferenciasEFUNDEB' then 'iptu'
             else 'itbi' end,
           (e ->> 'valor')::numeric, v_ano, v_bim, p_carga
      from jsonb_array_elements(v_itens) e
     where e ->> 'cod_conta' = any (v_municipais)
       and e ->> 'coluna' ~ '^<MR(-([1-9]|1[01]))?>$'
    on conflict (mes, municipio_codigo, tributo) do update
       set valor = excluded.valor, relatorio_ano = excluded.relatorio_ano,
           relatorio_bimestre = excluded.relatorio_bimestre, carga_id = excluded.carga_id
     where (excluded.relatorio_ano, excluded.relatorio_bimestre)
             > (dados.receita_municipio.relatorio_ano, dados.receita_municipio.relatorio_bimestre)
        or ((excluded.relatorio_ano, excluded.relatorio_bimestre)
             = (dados.receita_municipio.relatorio_ano, dados.receita_municipio.relatorio_bimestre)
            and dados.receita_municipio.valor is distinct from excluded.valor);
    v_lidos := v_lidos + 36;
  end if;

  return v_lidos;
end
$$;

-- ---------------------------------------------------------------------------
-- Painel: bloco "capitais_receita", com a mesma forma de "estados_receita".
-- ---------------------------------------------------------------------------
create function etl.painel_receita_capitais()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with capitais as (
    select l.id::integer as codigo, l.nome, l.uf_sigla
      from ref.cidade_dieese c
      join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla
     where c.capital
  ),
  base as (
    select r.* from dados.receita_municipio r join capitais k on k.codigo = r.municipio_codigo
  ),
  anual as (
    select municipio_codigo, tributo, extract(year from mes)::int as ano, sum(valor) as valor, count(*) as meses
      from base
     group by 1, 2, 3
  ),
  anos as (
    select generate_series(2015, (select max(ano) from anual where meses = 12)) as ano
  ),
  ultimo as (
    select municipio_codigo, max(mes) as mes from base where tributo = 'iss' group by 1
  ),
  fim as (
    select min(mes) as mes from ultimo having count(*) = (select count(*) from capitais)
  ),
  doze as (
    select b.municipio_codigo, b.tributo, sum(b.valor) as valor, count(*) as meses
      from base b, fim
     where b.mes > (fim.mes - interval '12 months')::date and b.mes <= fim.mes
     group by 1, 2
  ),
  tributos(tributo) as (values ('iss'), ('iptu'), ('itbi'))
  select jsonb_build_object(
    'fonte_url', 'https://apidatalake.tesouro.gov.br/docs/siconfi/',
    'anos', (select jsonb_agg(ano order by ano) from anos),
    'doze_meses_ate', (select to_char(mes, 'YYYY-MM') from fim),
    'capitais', (
      select jsonb_agg(jsonb_build_object(
               'codigo', k.codigo::text, 'nome', k.nome, 'uf', k.uf_sigla,
               'ultimo_mes', (select to_char(x.mes, 'YYYY-MM') from ultimo x where x.municipio_codigo = k.codigo),
               'anual', (select jsonb_object_agg(t.tributo,
                                  (select jsonb_agg((select round(a.valor, 2) from anual a
                                                      where a.municipio_codigo = k.codigo and a.tributo = t.tributo
                                                        and a.ano = y.ano and a.meses = 12)
                                                    order by y.ano)
                                     from anos y))
                           from tributos t),
               'doze_meses', (select jsonb_object_agg(d.tributo, round(d.valor, 2))
                                from doze d where d.municipio_codigo = k.codigo and d.meses = 12))
             order by k.uf_sigla)
        from capitais k))
$$;

alter function etl.painel_blocos_extras() rename to painel_blocos_extras_v5;

create function etl.painel_blocos_extras()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select etl.painel_blocos_extras_v5() || jsonb_build_object('capitais_receita', etl.painel_receita_capitais())
$$;
