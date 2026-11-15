-- Bloco "estados_fiscal" do painel: o limite da dívida passa a ser o da lei,
-- igual para todos os estados, em vez do valor informado em cada relatório.
--
-- Conferido em 15/11/2026 nos 297 relatórios carregados (27 estados, 2015 a
-- 2025):
--   * em 261, o limite informado dá 200,0% da RCL e o alerta, 180,0%;
--   * 15 ficam entre 200,1% e 200,8%, pela diferença entre a RCL e a RCL
--     ajustada;
--   * Ceará e Distrito Federal informaram limite zero em 9 relatórios,
--     Roraima informou cerca de 90% em 11 e São Paulo, 169,9% em 1.
-- O limite é o mesmo para todos os estados: duas vezes a receita corrente
-- líquida (Resolução do Senado Federal nº 40/2001, art. 3º, I). O alerta é
-- 90% do limite, ou 180% (LRF, art. 59, § 1º, III).
--
-- Os limites da despesa com pessoal continuam vindo do relatório, porque
-- variam por estado: 49% da RCL para o Executivo, ou 48,6% nos estados com
-- Tribunal de Contas dos Municípios (LRF, art. 20, II, c, e § 4º). Todos os
-- 297 relatórios conferem com isso.
--
-- Os valores informados (dcl_limite_pct, dcl_alerta_pct) continuam em
-- dados.fiscal_uf para conferência, mas saem do painel.
--
-- Versão anterior renomeada: painel_blocos_extras_v3.

alter function etl.painel_blocos_extras() rename to painel_blocos_extras_v3;

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
    ('rcl'), ('dcl'), ('dcl_rcl_pct'),
    ('pessoal'), ('pessoal_rcl_pct'), ('pessoal_limite_pct'), ('pessoal_prudencial_pct'), ('pessoal_alerta_pct'))
  select etl.painel_blocos_extras_v2() || jsonb_build_object('estados_fiscal', jsonb_build_object(
    'fonte_url', 'https://apidatalake.tesouro.gov.br/docs/siconfi/',
    'anos', (select jsonb_agg(exercicio order by exercicio) from anos),
    'limite_divida_pct', 200,
    'alerta_divida_pct', 180,
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
