-- Bloco "cidades" do painel: para cada capital, as séries do DIEESE e do
-- aluguel (FipeZAP) nos mesmos meses do painel nacional e a POF 2017-2018 da
-- UF por faixa de renda. A tarefa .github/workflows/atualizar-dados.yml separa
-- esse bloco em site/dados/cidades/<código do IBGE>.json, para o site baixar
-- só a cidade escolhida.
--
-- etl.painel_blocos_extras() passa a juntar o bloco anterior (renomeado para
-- painel_blocos_extras_v1) com o novo, sem copiar o que já existia.

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
    select l.id, l.nome, l.uf_sigla, left(l.id, 2)::smallint as uf_codigo
      from ref.cidade_dieese c
      join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla
     where c.capital
  ),
  series as (
    select cid.id as cidade, s.id as serie,
           jsonb_agg(o.valor order by m.periodo) as valores,
           count(o.valor) as com_valor
      from cidades cid
     cross join ref.serie s
     cross join meses m
      left join dados.observacao o on o.serie_id = s.id and o.localidade_id = cid.id and o.periodo = m.periodo
     where s.fonte_id = 'dieese_cesta' or s.id = 'aluguel_m2'
     group by cid.id, s.id
  )
  select jsonb_object_agg(cid.id, jsonb_build_object(
           'codigo', cid.id,
           'nome', cid.nome,
           'uf', cid.uf_sigla,
           'series', (select jsonb_object_agg(se.serie, se.valores)
                        from series se where se.cidade = cid.id and se.com_valor > 0),
           'pof', (select jsonb_agg(jsonb_build_object(
                            'codigo', pc.codigo,
                            'renda_ate', pc.renda_ate,
                            'itens', (select jsonb_object_agg(
                                               case p.item_codigo
                                                 when 8010 then 'agua' when 8018 then 'luz'
                                                 when 8022 then 'gas' when 103541 then 'aluguel' end,
                                               p.valor)
                                        from dados.pof_despesa_uf p
                                       where p.uf_codigo = cid.uf_codigo and p.classe_codigo = pc.codigo))
                          order by pc.ordem)
                     from ref.pof_classe pc)))
    from cidades cid
$$;

alter function etl.painel_blocos_extras() rename to painel_blocos_extras_v1;

create function etl.painel_blocos_extras()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select etl.painel_blocos_extras_v1() || jsonb_build_object('cidades', etl.painel_cidades())
$$;
