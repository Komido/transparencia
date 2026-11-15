-- Contas públicas dos estados: dívida e despesa com pessoal em relação à
-- receita corrente líquida (RCL), com os limites legais, no fim de cada ano.
--
-- Fonte: Relatório de Gestão Fiscal (RGF) do Poder Executivo de cada estado,
-- 3º quadrimestre, na API do SICONFI (Tesouro Nacional):
--   RGF-Anexo 01 (despesa com pessoal):
--     DespesaComPessoalTotal [% sobre a RCL | % sobre a RCL Ajustada] e [Valor]
--     LimiteMaximo/Prudencial/DeAlerta DespesaComPessoalTotal [% sobre a RCL...]
--   RGF-Anexo 02 (dívida consolidada líquida), coluna "Até o 3º Quadrimestre":
--     PercentualDaDCLSobreARCL, DividaConsolidadaLiquida, RGF2ReceitaCorrenteLiquida,
--     LimiteDefinidoPorResolucaoDoSenadoFederal e LimiteDeAlerta (em R$; o
--     percentual é calculado sobre ReceitaCorrenteLiquidaAjustadaParaCalculoDosLimitesDeEndividamento)
-- Códigos conferidos nos relatórios de 2020 a 2025. De 2019 para trás o
-- anexo 2 não tem a RCL ajustada; a leitura desses anos foi corrigida em
-- 20261115121410_fiscal_estados_ate_2019.sql.
--
-- A API só responde com o estado informado (id_ente). Para não sobrecarregar
-- o servidor do Tesouro, os anos fechados são coletados uma vez por mês, cada
-- coleta num dia diferente (coluna dia_do_mes); o último ano fechado
-- ({ano_anterior}) é conferido todo dia.
--
-- O resultado primário dos estados (RREO-Anexo 06) fica de fora: a forma de
-- cálculo mudou em 2018 e depois, e a série não é comparável entre anos.
--
-- Versões anteriores renomeadas: solicitar_coletas_v4, carregar_formato_v2,
-- painel_blocos_extras_v2.

create table dados.fiscal_uf (
  exercicio   smallint not null check (exercicio between 2000 and 2100),
  uf_codigo   smallint not null check (uf_codigo between 11 and 53),
  indicador   text not null check (indicador in (
                'rcl', 'dcl', 'dcl_rcl_pct', 'dcl_limite_pct', 'dcl_alerta_pct',
                'pessoal', 'pessoal_rcl_pct', 'pessoal_limite_pct', 'pessoal_prudencial_pct', 'pessoal_alerta_pct')),
  valor       numeric not null,
  carga_id    bigint not null references etl.carga (id),
  primary key (exercicio, uf_codigo, indicador)
);
alter table dados.fiscal_uf enable row level security;

alter table ref.coleta add column dia_do_mes smallint check (dia_do_mes between 1 and 28);

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('stn_siconfi_rgf', 'Relatório de Gestão Fiscal dos estados (SICONFI)', 'Tesouro Nacional',
   'https://apidatalake.tesouro.gov.br/docs/siconfi/',
   'RGF do Poder Executivo de cada estado, 3º quadrimestre: despesa com pessoal (Anexo 1) e dívida consolidada líquida (Anexo 2) em relação à receita corrente líquida.');

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv',
                     'ibge_municipios', 'sidra_json', 'csv_series', 'siconfi_dca', 'sidra_pof', 'fipezap_cidades',
                     'anp_estados_csv', 'siconfi_rgf'));
alter table ref.coleta drop constraint coleta_serie_check;
alter table ref.coleta add constraint coleta_serie_check
  check ((formato in ('rfb_csv', 'anp_csv', 'ibge_municipios', 'csv_series', 'siconfi_dca', 'sidra_pof',
                      'anp_estados_csv', 'siconfi_rgf')) = (serie_id is null));

-- Anos fechados: uma coleta por estado, ano e anexo, espalhadas pelos dias 1 a 28.
insert into ref.coleta (id, fonte_id, url, formato, serie_id, dia_do_mes)
select 'rgf_' || u.id || '_' || a.ano || '_' || x.sufixo, 'stn_siconfi_rgf',
       'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rgf?an_exercicio=' || a.ano
         || '&in_periodicidade=Q&nr_periodo=3&co_tipo_demonstrativo=RGF&no_anexo=RGF-Anexo%20' || x.anexo
         || '&co_esfera=E&co_poder=E&id_ente=' || u.id,
       'siconfi_rgf', null,
       (1 + (row_number() over (order by a.ano, u.id, x.anexo) - 1) % 28)::smallint
  from ref.localidade u
 cross join generate_series(2015, 2024) as a(ano)
 cross join (values ('01', 'pessoal'), ('02', 'divida')) as x(anexo, sufixo)
 where u.nivel = 'uf';

-- Último ano fechado: todo dia.
insert into ref.coleta (id, fonte_id, url, formato, serie_id, dia_do_mes)
select 'rgf_' || u.id || '_ano_anterior_' || x.sufixo, 'stn_siconfi_rgf',
       'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rgf?an_exercicio={ano_anterior}'
         || '&in_periodicidade=Q&nr_periodo=3&co_tipo_demonstrativo=RGF&no_anexo=RGF-Anexo%20' || x.anexo
         || '&co_esfera=E&co_poder=E&id_ente=' || u.id,
       'siconfi_rgf', null, null
  from ref.localidade u
 cross join (values ('01', 'pessoal'), ('02', 'divida')) as x(anexo, sufixo)
 where u.nivel = 'uf';

-- ---------------------------------------------------------------------------
-- Coleta diária respeitando o dia do mês de cada coleta
-- ---------------------------------------------------------------------------
alter function etl.solicitar_coletas() rename to solicitar_coletas_v4;

create function etl.solicitar_coletas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_id   text;
  v_dia  integer := extract(day from now() at time zone 'America/Sao_Paulo')::int;
  v_n    integer := 0;
begin
  for v_id in
    select id from ref.coleta
     where ativa and (dia_do_mes is null or dia_do_mes = v_dia)
     order by id
  loop
    perform etl.enviar_requisicao(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- RGF, anexos 1 e 2
-- ---------------------------------------------------------------------------
create function etl.carregar_siconfi_rgf(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json      jsonb;
  v_itens     jsonb;
  v_n         integer;
  v_ano       integer;
  v_uf        integer;
  v_anexo     text;
  v_invalidos integer;
  v_valores   jsonb;
  v_total     integer;
begin
  v_json := p_conteudo::jsonb;
  v_itens := v_json -> 'items';
  if jsonb_typeof(v_itens) is distinct from 'array' then
    raise exception 'RGF: resposta sem lista de itens';
  end if;
  if coalesce((v_json ->> 'hasMore')::boolean, false) then
    raise exception 'RGF: resposta dividida em páginas';
  end if;
  -- Relatório ainda não entregue: nada a gravar.
  if jsonb_array_length(v_itens) = 0 then
    return 0;
  end if;

  select count(distinct (e ->> 'exercicio', e ->> 'cod_ibge', e ->> 'anexo')),
         min((e ->> 'exercicio')::int), min((e ->> 'cod_ibge')::int), min(e ->> 'anexo'),
         count(*) filter (where jsonb_typeof(e -> 'valor') is distinct from 'number')
    into v_n, v_ano, v_uf, v_anexo, v_invalidos
    from jsonb_array_elements(v_itens) e;
  if v_n <> 1 or v_invalidos > 0 or v_uf not between 11 and 53 or v_anexo not in ('RGF-Anexo 01', 'RGF-Anexo 02') then
    raise exception 'RGF: resposta fora do esperado (% combinações, % valores inválidos, UF %, anexo %)',
      v_n, v_invalidos, v_uf, v_anexo;
  end if;

  -- Uma linha por código e coluna; repetição recusa a carga.
  if exists (select 1 from jsonb_array_elements(v_itens) e
              group by e ->> 'cod_conta', e ->> 'coluna' having count(*) > 1
                 and e ->> 'cod_conta' in ('DespesaComPessoalTotal', 'LimiteMaximoDespesaComPessoalTotal',
                                           'LimitePrudencialDespesaComPessoalTotal', 'LimiteDeAlertaDespesaComPessoalTotal',
                                           'PercentualDaDCLSobreARCL', 'DividaConsolidadaLiquida', 'RGF2ReceitaCorrenteLiquida',
                                           'LimiteDefinidoPorResolucaoDoSenadoFederal', 'LimiteDeAlerta',
                                           'ReceitaCorrenteLiquidaAjustadaParaCalculoDosLimitesDeEndividamento')) then
    raise exception 'RGF: contas repetidas na resposta';
  end if;

  if v_anexo = 'RGF-Anexo 01' then
    with l as (
      select e ->> 'cod_conta' as cod, e ->> 'coluna' as col, (e ->> 'valor')::numeric as v
        from jsonb_array_elements(v_itens) e
    )
    select jsonb_strip_nulls(jsonb_build_object(
             'pessoal', (select v from l where cod = 'DespesaComPessoalTotal' and col = 'Valor'),
             'pessoal_rcl_pct', (select v from l where cod = 'DespesaComPessoalTotal' and col ~* '^% sobre a RCL'),
             'pessoal_limite_pct', (select v from l where cod = 'LimiteMaximoDespesaComPessoalTotal' and col ~* '^% sobre a RCL'),
             'pessoal_prudencial_pct', (select v from l where cod = 'LimitePrudencialDespesaComPessoalTotal' and col ~* '^% sobre a RCL'),
             'pessoal_alerta_pct', (select v from l where cod = 'LimiteDeAlertaDespesaComPessoalTotal' and col ~* '^% sobre a RCL')))
      into v_valores;
    if v_valores ->> 'pessoal_rcl_pct' is null or v_valores ->> 'pessoal_limite_pct' is null then
      raise exception 'RGF 1: despesa com pessoal ou limite não encontrados (UF %, %)', v_uf, v_ano;
    end if;
  else
    with l as (
      select e ->> 'cod_conta' as cod, (e ->> 'valor')::numeric as v
        from jsonb_array_elements(v_itens) e
       where e ->> 'coluna' = 'Até o 3º Quadrimestre'
    ),
    base as (
      select (select v from l where cod = 'ReceitaCorrenteLiquidaAjustadaParaCalculoDosLimitesDeEndividamento') as rcl_aj
    )
    select jsonb_strip_nulls(jsonb_build_object(
             'rcl', (select v from l where cod = 'RGF2ReceitaCorrenteLiquida'),
             'dcl', (select v from l where cod = 'DividaConsolidadaLiquida'),
             'dcl_rcl_pct', (select v from l where cod = 'PercentualDaDCLSobreARCL'),
             'dcl_limite_pct', (select round(100 * v / nullif(base.rcl_aj, 0), 2) from l, base where cod = 'LimiteDefinidoPorResolucaoDoSenadoFederal'),
             'dcl_alerta_pct', (select round(100 * v / nullif(base.rcl_aj, 0), 2) from l, base where cod = 'LimiteDeAlerta')))
      into v_valores;
    if v_valores ->> 'dcl_rcl_pct' is null or v_valores ->> 'dcl_limite_pct' is null then
      raise exception 'RGF 2: dívida ou limite não encontrados (UF %, %)', v_uf, v_ano;
    end if;
  end if;

  insert into dados.fiscal_uf (exercicio, uf_codigo, indicador, valor, carga_id)
  select v_ano, v_uf, k, v::numeric, p_carga
    from jsonb_each_text(v_valores) as t(k, v)
  on conflict (exercicio, uf_codigo, indicador) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.fiscal_uf.valor is distinct from excluded.valor;

  select count(*) into v_total from jsonb_object_keys(v_valores);
  return v_total;
end
$$;

alter function etl.carregar_formato(text, bigint, text, text, text) rename to carregar_formato_v2;

create function etl.carregar_formato(p_formato text, p_carga bigint, p_serie text, p_fonte text, p_texto text)
returns integer
language plpgsql
set search_path = ''
as $$
begin
  if p_formato = 'siconfi_rgf' then
    return etl.carregar_siconfi_rgf(p_carga, p_texto);
  end if;
  return etl.carregar_formato_v2(p_formato, p_carga, p_serie, p_fonte, p_texto);
end
$$;

-- ---------------------------------------------------------------------------
-- Painel: bloco "estados_fiscal"
-- ---------------------------------------------------------------------------
alter function etl.painel_blocos_extras() rename to painel_blocos_extras_v2;

create function etl.painel_blocos_extras()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with anos as (
    select distinct exercicio from dados.fiscal_uf
  ),
  ufs as (
    select id, nome, uf_sigla from ref.localidade where nivel = 'uf'
  ),
  indicadores(indicador) as (values
    ('rcl'), ('dcl'), ('dcl_rcl_pct'), ('dcl_limite_pct'), ('dcl_alerta_pct'),
    ('pessoal'), ('pessoal_rcl_pct'), ('pessoal_limite_pct'), ('pessoal_prudencial_pct'), ('pessoal_alerta_pct'))
  select etl.painel_blocos_extras_v2() || jsonb_build_object('estados_fiscal', jsonb_build_object(
    'fonte_url', 'https://apidatalake.tesouro.gov.br/docs/siconfi/',
    'anos', (select jsonb_agg(exercicio order by exercicio) from anos),
    'estados', (
      select jsonb_agg(jsonb_build_object(
               'codigo', u.id, 'sigla', u.uf_sigla, 'nome', u.nome,
               'indicadores', (select jsonb_object_agg(i.indicador,
                                        (select jsonb_agg(f.valor order by a.exercicio)
                                           from anos a
                                           left join dados.fiscal_uf f
                                             on f.exercicio = a.exercicio and f.uf_codigo = u.id::smallint and f.indicador = i.indicador))
                                 from indicadores i))
             order by u.nome)
        from ufs u)))
$$;
