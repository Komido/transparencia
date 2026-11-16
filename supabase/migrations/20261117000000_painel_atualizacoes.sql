-- Quando chegou o último número de cada série, para o bloco "O que chegou de
-- novo" do site.
--
-- Para cada série do país, o último período gravado e quando a carga que o
-- gravou foi processada (coletado_em). primeira_carga marca o que veio da
-- primeira carga da coleta (a carga inicial do site, em 15 e 16/11/2026), que
-- não é novidade. A arrecadação federal entra com o último mês do arquivo da
-- Receita.
--
-- Entra no painel pelo ponto de extensão painel_blocos_extras, antes do
-- cálculo da versão. Versão anterior renomeada: painel_blocos_extras_v7.

create function etl.painel_atualizacoes()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with primeira as (
    select coleta_id, min(id) as id from etl.carga where status = 'ok' group by coleta_id
  ),
  ultimo as (
    select distinct on (o.serie_id) o.serie_id, o.periodo, o.carga_id
      from dados.observacao o
     where o.localidade_id = 'BR'
     order by o.serie_id, o.periodo desc
  ),
  arrec as (
    select a.periodo, max(a.carga_id) as carga_id
      from dados.arrecadacao_federal a
     where a.periodo = (select max(periodo) from dados.arrecadacao_federal)
     group by a.periodo
  ),
  itens as (
    select u.serie_id as id, u.periodo, k.processada_em, (k.id = p.id) as primeira_carga
      from ultimo u
      join etl.carga k on k.id = u.carga_id
      left join primeira p on p.coleta_id = k.coleta_id
    union all
    select 'arrecadacao_federal', a.periodo, k.processada_em, (k.id = p.id)
      from arrec a
      join etl.carga k on k.id = a.carga_id
      left join primeira p on p.coleta_id = k.coleta_id
  )
  select jsonb_build_object('atualizacoes', coalesce(jsonb_object_agg(id, jsonb_build_object(
           'periodo', to_char(periodo, 'YYYY-MM'),
           'coletado_em', to_char(processada_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'primeira_carga', coalesce(primeira_carga, false))), '{}'::jsonb))
    from itens
$$;

alter function etl.painel_blocos_extras() rename to painel_blocos_extras_v7;

create function etl.painel_blocos_extras()
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  return etl.painel_blocos_extras_v7() || etl.painel_atualizacoes();
end
$$;

revoke all on function etl.painel_atualizacoes() from public, anon, authenticated;
revoke all on function etl.painel_blocos_extras() from public, anon, authenticated;
