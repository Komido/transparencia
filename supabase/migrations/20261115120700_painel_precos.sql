-- Painel com preços do dia a dia.
--
-- Alimentos (DIEESE): a série nacional é a média simples das 15 capitais com
-- pesquisa contínua desde janeiro de 1995 (ref.cidade_dieese.painel_1995). O mês
-- só é publicado quando pelo menos 12 delas têm preço; senão fica sem dado.
-- Combustíveis (ANP): média Brasil publicada pela própria ANP.
--
-- A versão anterior foi renomeada para etl.gerar_painel_v1.

alter function etl.gerar_painel() rename to gerar_painel_v1;

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
