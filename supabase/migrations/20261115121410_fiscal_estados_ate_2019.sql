-- Leitura do RGF dos estados nos anos em que o relatório tem outro formato.
--
-- Conferido nas respostas da API do SICONFI em 15/11/2026:
--   * RGF-Anexo 02 de 2019 para trás não tem a linha
--     ReceitaCorrenteLiquidaAjustadaParaCalculoDosLimitesDeEndividamento.
--     O percentual da dívida (PercentualDaDCLSobreARCL, "% da DCL sobre a RCL
--     (III/RCL)") é calculado sobre a própria RCL (RGF2ReceitaCorrenteLiquida).
--     Exemplo, São Paulo 2019: limite de R$ 320.889.105.673,10 sobre RCL de
--     R$ 160.444.552.836,55 = 200%, o limite do Senado.
--   * RGF-Anexo 01 do Paraná em 2017 traz os limites só em reais, sem a coluna
--     de percentual. O percentual sai do valor em reais dividido pela RCL
--     ajustada do mesmo relatório (ReceitaCorrenteLiquidaAjustada, coluna
--     Valor): R$ 17.941.485.168,65 / R$ 36.615.275.854,39 = 49%, o limite da
--     LRF para o Poder Executivo estadual.
--
-- O percentual publicado no relatório continua tendo preferência. O cálculo
-- só entra quando ele falta.
--
-- Versão anterior renomeada: carregar_siconfi_rgf_v1.

alter function etl.carregar_siconfi_rgf(bigint, text) rename to carregar_siconfi_rgf_v1;

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
                                           'ReceitaCorrenteLiquidaAjustada',
                                           'PercentualDaDCLSobreARCL', 'DividaConsolidadaLiquida', 'RGF2ReceitaCorrenteLiquida',
                                           'LimiteDefinidoPorResolucaoDoSenadoFederal', 'LimiteDeAlerta',
                                           'ReceitaCorrenteLiquidaAjustadaParaCalculoDosLimitesDeEndividamento')) then
    raise exception 'RGF: contas repetidas na resposta';
  end if;

  if v_anexo = 'RGF-Anexo 01' then
    with l as (
      select e ->> 'cod_conta' as cod, e ->> 'coluna' as col, (e ->> 'valor')::numeric as v
        from jsonb_array_elements(v_itens) e
    ),
    base as (
      select (select v from l where cod = 'ReceitaCorrenteLiquidaAjustada' and col = 'Valor') as rcl_aj
    ),
    pct as (
      select c.chave,
             coalesce((select l.v from l where l.cod = c.cod and l.col ~* '^% sobre a RCL'),
                      (select round(100 * l.v / nullif(base.rcl_aj, 0), 2) from l, base where l.cod = c.cod and l.col = 'Valor')) as v
        from (values ('pessoal_rcl_pct', 'DespesaComPessoalTotal'),
                     ('pessoal_limite_pct', 'LimiteMaximoDespesaComPessoalTotal'),
                     ('pessoal_prudencial_pct', 'LimitePrudencialDespesaComPessoalTotal'),
                     ('pessoal_alerta_pct', 'LimiteDeAlertaDespesaComPessoalTotal')) as c(chave, cod)
    )
    select jsonb_strip_nulls(
             jsonb_build_object('pessoal', (select v from l where cod = 'DespesaComPessoalTotal' and col = 'Valor'))
             || coalesce((select jsonb_object_agg(chave, v) from pct where v is not null), '{}'::jsonb))
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
      select coalesce((select v from l where cod = 'ReceitaCorrenteLiquidaAjustadaParaCalculoDosLimitesDeEndividamento'),
                      (select v from l where cod = 'RGF2ReceitaCorrenteLiquida')) as rcl_base
    )
    select jsonb_strip_nulls(jsonb_build_object(
             'rcl', (select v from l where cod = 'RGF2ReceitaCorrenteLiquida'),
             'dcl', (select v from l where cod = 'DividaConsolidadaLiquida'),
             'dcl_rcl_pct', coalesce((select v from l where cod = 'PercentualDaDCLSobreARCL'),
                                     (select round(100 * v / nullif(base.rcl_base, 0), 2) from l, base where cod = 'DividaConsolidadaLiquida')),
             'dcl_limite_pct', (select round(100 * v / nullif(base.rcl_base, 0), 2) from l, base where cod = 'LimiteDefinidoPorResolucaoDoSenadoFederal'),
             'dcl_alerta_pct', (select round(100 * v / nullif(base.rcl_base, 0), 2) from l, base where cod = 'LimiteDeAlerta')))
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
