-- Montagem do JSON publicado e ponto de leitura pública.
--
-- etl.gerar_painel() junta as séries já validadas num único JSON e grava em
-- painel.snapshot. Toda versão com conteúdo diferente vai para painel.versao,
-- o que permite mostrar quando um número foi corrigido pela fonte.
-- Os cálculos (inflação acumulada, valores reais, médias por mandato) ficam no
-- site, em site/js/calculos.js, para que qualquer pessoa possa conferi-los.

create function etl.gerar_painel()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_inicio  constant date := date '1995-01-01';
  v_fim     date;
  v_dados   jsonb;
  v_sha     text;
begin
  -- A janela termina no último mês com IPCA oficial.
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
  series as (
    select s.id, jsonb_agg(o.valor order by m.periodo) as valores
      from ref.serie s
     cross join meses m
      left join dados.observacao o
        on o.serie_id = s.id and o.localidade_id = 'BR' and o.periodo = m.periodo
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
    -- R$ milhões correntes; null quando o mês não está na base da Receita.
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
                                   where o.serie_id = s.id and o.localidade_id = 'BR'),
               'urls', (select jsonb_agg(c.url order by c.id) from ref.coleta c where c.serie_id = s.id))
             order by s.id)
        from ref.serie s),
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

  -- Avisos automáticos de qualidade: rubricas em que um mês inteiro (todas as
  -- UFs) repete exatamente os valores de outro mês. É sinal de erro na fonte;
  -- o dado não é alterado, mas o aviso é publicado.
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

  -- O hash ignora o estado das coletas, que muda todo dia.
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

-- Leitura pública: devolve o JSON pronto. Não recebe parâmetros e não grava nada.
create function public.painel()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  perform set_config('response.headers', '[{"Cache-Control": "public, max-age=600"}]', true);
  return (
    select s.dados || jsonb_build_object('gerado_em', s.gerado_em)
      from painel.snapshot s
     where s.id = 1
  );
end
$$;

grant execute on function public.painel() to anon, authenticated;

-- Agendamento (UTC). Coleta às 09:41 (06:41 em Brasília); processamento a
-- cada hora, para pegar respostas lentas. O painel só é refeito quando alguma
-- carga foi processada depois da última geração.
select cron.schedule('arrecadometro-solicitar', '41 9 * * *', $$select etl.solicitar_coletas()$$);
select cron.schedule('arrecadometro-processar', '7 * * * *', $$
  select etl.processar_respostas();
  select etl.gerar_painel()
   where exists (select 1 from etl.carga
                  where processada_em > coalesce((select gerado_em from painel.snapshot where id = 1), '-infinity'));
$$);
