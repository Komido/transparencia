-- Orçamento da família: gastos médios da POF 2017-2018 (IBGE) e inflação de
-- cada item (IPCA por subitem), para trazer esses gastos para hoje.
--
-- POF: SIDRA tabela 6715, variável 1201 (despesa monetária e não monetária
-- média mensal familiar), por classe de rendimento familiar (c339) e tipo de
-- despesa (c12190). Pesquisa feita uma vez; os valores foram copiados da
-- resposta da API em 15/11/2026, sem digitação manual:
-- https://apisidra.ibge.gov.br/values/t/6715/n1/all/v/1201/p/all/c339/all/c12190/103536,103540,103541,8007,8018,8010,8022
--
-- IPCA por subitem, variação mensal (variável 63, classificação c315). O IBGE
-- divide a série em duas tabelas: 1419 (2012 a 2019) e 7060 (desde 2020).
--   7451 = 2101004.Taxa de água e esgoto
--   7482 = 2201004.Gás de botijão
--   7485 = 2202003.Energia elétrica residencial
--
-- etl.carregar_sidra passa a conferir também a categoria (quando o código de
-- origem a informa) e a comparar a quantidade de registros só dentro do
-- período que a resposta cobre, porque duas tabelas alimentam a mesma série.
-- A versão anterior foi renomeada para etl.carregar_sidra_v1.

create table ref.pof_despesa (
  classe_codigo  integer not null,
  classe         text not null,
  item_codigo    integer not null,
  item           text not null,
  valor          numeric not null check (valor >= 0),
  primary key (classe_codigo, item_codigo)
);
alter table ref.pof_despesa enable row level security;

insert into ref.pof_despesa (classe_codigo, classe, item_codigo, item, valor) values
  (47558, 'Até 1.908 Reais', 8007, '2.1.2.1.1 Aluguel monetário', 63.90),
  (47558, 'Até 1.908 Reais', 8010, '2.1.2.3.6 Água e esgoto', 28.12),
  (47558, 'Até 1.908 Reais', 8018, '2.1.2.3.1 Energia elétrica', 65.62),
  (47558, 'Até 1.908 Reais', 8022, '2.1.2.3.5 Gás doméstico', 32.83),
  (47558, 'Até 1.908 Reais', 103536, '1 Despesa total', 1500.73),
  (47558, 'Até 1.908 Reais', 103540, '2.1.2 Habitação', 585.91),
  (47558, 'Até 1.908 Reais', 103541, '2.1.2.1 Aluguel', 307.98),
  (47559, 'Mais de 1.908 a 2.862 Reais', 8007, '2.1.2.1.1 Aluguel monetário', 80.02),
  (47559, 'Mais de 1.908 a 2.862 Reais', 8010, '2.1.2.3.6 Água e esgoto', 39.12),
  (47559, 'Mais de 1.908 a 2.862 Reais', 8018, '2.1.2.3.1 Energia elétrica', 88.14),
  (47559, 'Mais de 1.908 a 2.862 Reais', 8022, '2.1.2.3.5 Gás doméstico', 37.15),
  (47559, 'Mais de 1.908 a 2.862 Reais', 103536, '1 Despesa total', 2350.74),
  (47559, 'Mais de 1.908 a 2.862 Reais', 103540, '2.1.2 Habitação', 859.96),
  (47559, 'Mais de 1.908 a 2.862 Reais', 103541, '2.1.2.1 Aluguel', 456.75),
  (47560, 'Mais de 2.862 a 5.724 Reais', 8007, '2.1.2.1.1 Aluguel monetário', 85.80),
  (47560, 'Mais de 2.862 a 5.724 Reais', 8010, '2.1.2.3.6 Água e esgoto', 50.81),
  (47560, 'Mais de 2.862 a 5.724 Reais', 8018, '2.1.2.3.1 Energia elétrica', 117.64),
  (47560, 'Mais de 2.862 a 5.724 Reais', 8022, '2.1.2.3.5 Gás doméstico', 39.21),
  (47560, 'Mais de 2.862 a 5.724 Reais', 103536, '1 Despesa total', 3705.24),
  (47560, 'Mais de 2.862 a 5.724 Reais', 103540, '2.1.2 Habitação', 1203.17),
  (47560, 'Mais de 2.862 a 5.724 Reais', 103541, '2.1.2.1 Aluguel', 626.87),
  (47561, 'Mais de 5.724 a 9.540 Reais', 8007, '2.1.2.1.1 Aluguel monetário', 118.57),
  (47561, 'Mais de 5.724 a 9.540 Reais', 8010, '2.1.2.3.6 Água e esgoto', 64.10),
  (47561, 'Mais de 5.724 a 9.540 Reais', 8018, '2.1.2.3.1 Energia elétrica', 152.75),
  (47561, 'Mais de 5.724 a 9.540 Reais', 8022, '2.1.2.3.5 Gás doméstico', 39.25),
  (47561, 'Mais de 5.724 a 9.540 Reais', 103536, '1 Despesa total', 6326.50),
  (47561, 'Mais de 5.724 a 9.540 Reais', 103540, '2.1.2 Habitação', 1792.13),
  (47561, 'Mais de 5.724 a 9.540 Reais', 103541, '2.1.2.1 Aluguel', 914.82),
  (47562, 'Mais de 9.540 a 14.310 Reais', 8007, '2.1.2.1.1 Aluguel monetário', 143.77),
  (47562, 'Mais de 9.540 a 14.310 Reais', 8010, '2.1.2.3.6 Água e esgoto', 68.01),
  (47562, 'Mais de 9.540 a 14.310 Reais', 8018, '2.1.2.3.1 Energia elétrica', 183.86),
  (47562, 'Mais de 9.540 a 14.310 Reais', 8022, '2.1.2.3.5 Gás doméstico', 42.96),
  (47562, 'Mais de 9.540 a 14.310 Reais', 103536, '1 Despesa total', 9401.98),
  (47562, 'Mais de 9.540 a 14.310 Reais', 103540, '2.1.2 Habitação', 2562.49),
  (47562, 'Mais de 9.540 a 14.310 Reais', 103541, '2.1.2.1 Aluguel', 1270.64),
  (47563, 'Mais de 14.310 a 23.850 Reais', 8007, '2.1.2.1.1 Aluguel monetário', 213.99),
  (47563, 'Mais de 14.310 a 23.850 Reais', 8010, '2.1.2.3.6 Água e esgoto', 70.42),
  (47563, 'Mais de 14.310 a 23.850 Reais', 8018, '2.1.2.3.1 Energia elétrica', 208.94),
  (47563, 'Mais de 14.310 a 23.850 Reais', 8022, '2.1.2.3.5 Gás doméstico', 43.85),
  (47563, 'Mais de 14.310 a 23.850 Reais', 103536, '1 Despesa total', 14872.30),
  (47563, 'Mais de 14.310 a 23.850 Reais', 103540, '2.1.2 Habitação', 3761.14),
  (47563, 'Mais de 14.310 a 23.850 Reais', 103541, '2.1.2.1 Aluguel', 1831.36),
  (47564, 'Mais de 23.850 Reais', 8007, '2.1.2.1.1 Aluguel monetário', 165.66),
  (47564, 'Mais de 23.850 Reais', 8010, '2.1.2.3.6 Água e esgoto', 75.27),
  (47564, 'Mais de 23.850 Reais', 8018, '2.1.2.3.1 Energia elétrica', 260.14),
  (47564, 'Mais de 23.850 Reais', 8022, '2.1.2.3.5 Gás doméstico', 58.19),
  (47564, 'Mais de 23.850 Reais', 103536, '1 Despesa total', 27866.89),
  (47564, 'Mais de 23.850 Reais', 103540, '2.1.2 Habitação', 6312.01),
  (47564, 'Mais de 23.850 Reais', 103541, '2.1.2.1 Aluguel', 2970.61);

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('ibge_pof', 'Pesquisa de Orçamentos Familiares 2017-2018 (POF)', 'IBGE',
   'https://sidra.ibge.gov.br/tabela/6715',
   'Gasto médio mensal das famílias por faixa de renda. Pesquisa feita uma vez, com dados de 2017 e 2018.');

insert into ref.serie (id, nome, unidade, fonte_id, codigo_origem, observacao) values
  ('ipca_agua_var', 'IPCA, taxa de água e esgoto, variação mensal', '%', 'ibge',
   'SIDRA 1419 e 7060, variável 63, categoria 7451', 'Usada para trazer o gasto da POF com água para hoje.'),
  ('ipca_gas_var', 'IPCA, gás de botijão, variação mensal', '%', 'ibge',
   'SIDRA 1419 e 7060, variável 63, categoria 7482', 'Usada para trazer o gasto da POF com gás para hoje.'),
  ('ipca_luz_var', 'IPCA, energia elétrica residencial, variação mensal', '%', 'ibge',
   'SIDRA 1419 e 7060, variável 63, categoria 7485', 'Usada para trazer o gasto da POF com luz para hoje.');

insert into ref.coleta (id, fonte_id, url, formato, serie_id, cabecalho_proprio)
select 'sidra_' || t.tabela || '_' || s.nome, 'ibge',
       'https://apisidra.ibge.gov.br/values/t/' || t.tabela || '/n1/all/v/63/p/all/c315/' || s.categoria,
       'sidra_json', s.serie, false
  from (values ('1419'), ('7060')) as t(tabela)
 cross join (values ('agua', '7451', 'ipca_agua_var'), ('gas', '7482', 'ipca_gas_var'),
                    ('luz', '7485', 'ipca_luz_var')) as s(nome, categoria, serie);

alter function etl.carregar_sidra(bigint, text, text) rename to carregar_sidra_v1;

create function etl.carregar_sidra(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json        jsonb;
  v_cab         jsonb;
  v_variavel    text;
  v_categoria   text;
  v_total       integer;
  v_invalidos   integer;
  v_distintos   integer;
  v_variaveis   integer;
  v_categorias  integer;
  v_inicio      date;
  v_fim         date;
  v_existentes  integer;
begin
  v_json := p_conteudo::jsonb;
  if jsonb_typeof(v_json) <> 'array' or jsonb_array_length(v_json) < 2 then
    raise exception 'SIDRA: a resposta não é uma lista com dados';
  end if;

  v_cab := v_json -> 0;
  if v_cab ->> 'V' <> 'Valor' or v_cab ->> 'D1N' <> 'Brasil' or v_cab ->> 'D2N' <> 'Variável'
     or v_cab ->> 'D3N' not in ('Trimestre Móvel', 'Mês') then
    raise exception 'SIDRA: cabeçalho inesperado %', left(v_cab::text, 200);
  end if;

  select substring(codigo_origem from 'variável ([0-9]+)'), substring(codigo_origem from 'categoria ([0-9]+)')
    into v_variavel, v_categoria
    from ref.serie where id = p_serie;
  if v_variavel is null then
    raise exception 'SIDRA: série % sem variável no código de origem', p_serie;
  end if;

  with linhas as (
    select e from jsonb_array_elements(v_json) with ordinality as t(e, i)
     where i > 1 and coalesce(e ->> 'V', '') not in ('...', '-', '..', 'X')
  )
  select count(*),
         count(*) filter (where not (e ->> 'V' ~ '^-?[0-9]+(\.[0-9]+)?$'
                                     and e ->> 'D1C' = '1'
                                     and e ->> 'D3C' ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])$')),
         count(distinct e ->> 'D3C'),
         count(*) filter (where e ->> 'D2C' <> v_variavel),
         count(*) filter (where v_categoria is not null and e ->> 'D4C' is distinct from v_categoria),
         min(to_date(e ->> 'D3C', 'YYYYMM')),
         max(to_date(e ->> 'D3C', 'YYYYMM'))
    into v_total, v_invalidos, v_distintos, v_variaveis, v_categorias, v_inicio, v_fim
    from linhas;

  if v_invalidos > 0 then
    raise exception 'SIDRA: % registros fora do formato esperado', v_invalidos;
  end if;
  if v_variaveis > 0 then
    raise exception 'SIDRA: a resposta traz variável diferente de %', v_variavel;
  end if;
  if v_categorias > 0 then
    raise exception 'SIDRA: a resposta traz categoria diferente de %', v_categoria;
  end if;
  if v_distintos <> v_total then
    raise exception 'SIDRA: períodos repetidos na resposta';
  end if;

  select count(*) into v_existentes
    from dados.observacao
   where serie_id = p_serie and localidade_id = 'BR' and periodo between v_inicio and v_fim;
  if v_total < v_existentes then
    raise exception 'SIDRA: a fonte devolveu % registros entre % e %, menos que os % já gravados',
      v_total, v_inicio, v_fim, v_existentes;
  end if;

  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select p_serie, 'BR', to_date(e ->> 'D3C', 'YYYYMM'), (e ->> 'V')::numeric, p_carga
    from jsonb_array_elements(v_json) with ordinality as t(e, i)
   where i > 1 and coalesce(e ->> 'V', '') not in ('...', '-', '..', 'X')
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;
