-- Gastos do governo federal por área (função de governo).
--
-- Fonte: SICONFI (Tesouro Nacional), Declaração de Contas Anuais da União,
-- Anexo I-E (despesa por função e subfunção), pela API
-- https://apidatalake.tesouro.gov.br/ords/siconfi/tt/dca. Uma coleta por ano,
-- de 2014 em diante; a coleta "dca_ano_anterior" acompanha o último ano
-- fechado ({ano_anterior} é trocado na hora da coleta).
--
-- A conta vem como texto ("10 - Saúde", "10.301 - Atenção Básica",
-- "FU10 - Demais Subfunções", "Despesas Exceto Intraorçamentárias"). O
-- leitor guarda o código ("10", "10.301", "FU10", "total", "intra") e
-- recusa a carga se a soma das funções não bater com o total.
--
-- Também: etl.enviar_requisicao troca {ano_anterior}; os blocos novos do
-- painel saem de etl.painel_blocos_extras(), para que adições futuras não
-- precisem copiar etl.gerar_painel() inteira.
--
-- Versões anteriores renomeadas: enviar_requisicao_v1,
-- processar_respostas_v5, gerar_painel_v3.

create table dados.despesa_funcao (
  exercicio  smallint not null check (exercicio between 2000 and 2100),
  conta      text not null check (conta ~ '^((FU)?[0-9]{2}(\.[0-9]{3})?|total|intra)$'),
  nome       text not null,
  coluna     text not null check (coluna in ('empenhada', 'liquidada', 'paga')),
  valor      numeric not null,
  carga_id   bigint not null references etl.carga (id),
  primary key (exercicio, conta, coluna)
);
alter table dados.despesa_funcao enable row level security;

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('stn_siconfi', 'Declaração de Contas Anuais da União (SICONFI), despesa por função', 'Tesouro Nacional',
   'https://apidatalake.tesouro.gov.br/docs/siconfi/',
   'Anexo I-E da DCA: despesa empenhada, liquidada e paga por função e subfunção de governo. O site usa a despesa liquidada.');

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv',
                     'ibge_municipios', 'sidra_json', 'csv_series', 'siconfi_dca'));
alter table ref.coleta drop constraint coleta_serie_check;
alter table ref.coleta add constraint coleta_serie_check
  check ((formato in ('rfb_csv', 'anp_csv', 'ibge_municipios', 'csv_series', 'siconfi_dca')) = (serie_id is null));

insert into ref.coleta (id, fonte_id, url, formato, serie_id)
select 'dca_' || ano, 'stn_siconfi',
       'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/dca?an_exercicio=' || ano || '&no_anexo=DCA-Anexo%20I-E&id_ente=1',
       'siconfi_dca', null
  from generate_series(2014, 2024) as ano;
insert into ref.coleta (id, fonte_id, url, formato, serie_id) values
  ('dca_ano_anterior', 'stn_siconfi',
   'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/dca?an_exercicio={ano_anterior}&no_anexo=DCA-Anexo%20I-E&id_ente=1',
   'siconfi_dca', null);

-- ---------------------------------------------------------------------------
-- Envio: troca também {ano_anterior}
-- ---------------------------------------------------------------------------
alter function etl.enviar_requisicao(text) rename to enviar_requisicao_v1;

create function etl.enviar_requisicao(p_coleta text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_coleta     record;
  v_agora      timestamp := now() at time zone 'America/Sao_Paulo';
  v_url        text;
  v_cabecalho  jsonb;
  v_req        bigint;
begin
  select id, url, metodo, corpo, cabecalho_proprio into v_coleta from ref.coleta where id = p_coleta;
  if not found then
    raise exception 'Coleta % não existe', p_coleta;
  end if;

  v_url := replace(v_coleta.url, '{mes_atual}', to_char(v_agora, 'MMYYYY'));
  v_url := replace(v_url, '{ano_anterior}', (extract(year from v_agora)::int - 1)::text);
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
-- SICONFI, DCA Anexo I-E
-- ---------------------------------------------------------------------------
create function etl.carregar_siconfi_dca(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json         jsonb;
  v_itens        jsonb;
  v_anos         integer;
  v_ano          integer;
  v_invalidos    integer;
  v_estranhas    text[];
  v_repetidas    integer;
  v_diferencas   text[];
  v_total        integer;
begin
  v_json := p_conteudo::jsonb;
  v_itens := v_json -> 'items';
  if jsonb_typeof(v_itens) is distinct from 'array' then
    raise exception 'SICONFI: resposta sem lista de itens';
  end if;
  if coalesce((v_json ->> 'hasMore')::boolean, false) then
    raise exception 'SICONFI: resposta dividida em páginas; o leitor espera tudo numa resposta';
  end if;
  -- Ano ainda não declarado: nada a gravar.
  if jsonb_array_length(v_itens) = 0 then
    return 0;
  end if;

  select count(distinct e ->> 'exercicio'), min((e ->> 'exercicio')::int),
         count(*) filter (where e ->> 'anexo' is distinct from 'DCA-Anexo I-E'
                             or e ->> 'cod_ibge' is distinct from '1'
                             or jsonb_typeof(e -> 'valor') is distinct from 'number')
    into v_anos, v_ano, v_invalidos
    from jsonb_array_elements(v_itens) e;
  if v_anos <> 1 or v_invalidos > 0 then
    raise exception 'SICONFI: % anos na resposta e % itens fora do esperado', v_anos, v_invalidos;
  end if;

  create temporary table if not exists pg_temp.dca_linhas (conta text, nome text, coluna text, valor numeric) on commit drop;
  delete from pg_temp.dca_linhas;
  insert into pg_temp.dca_linhas
  select case
           when e ->> 'conta' ~* '^Despesas \(?Exceto Intraor' then 'total'
           when e ->> 'conta' ~* '^Despesas \(?Intraor' then 'intra'
           else substring(e ->> 'conta' from '^((FU)?[0-9]{2}(\.[0-9]{3})?) - ')
         end,
         case when e ->> 'conta' ~* '^Despesas' then e ->> 'conta'
              else substring(e ->> 'conta' from ' - (.*)$') end,
         case e ->> 'coluna'
           when 'Despesas Empenhadas' then 'empenhada'
           when 'Despesas Liquidadas' then 'liquidada'
           when 'Despesas Pagas' then 'paga'
         end,
         (e ->> 'valor')::numeric
    from jsonb_array_elements(v_itens) e;

  select array_agg(distinct nome) into v_estranhas from pg_temp.dca_linhas where conta is null;
  if v_estranhas is not null then
    raise exception 'SICONFI: contas não reconhecidas: %', v_estranhas;
  end if;

  select count(*) into v_repetidas from (
    select conta, coluna from pg_temp.dca_linhas where coluna is not null group by 1, 2 having count(*) > 1) x;
  if v_repetidas > 0 then
    raise exception 'SICONFI: % contas repetidas na mesma coluna', v_repetidas;
  end if;

  -- A soma das funções precisa bater com o total (tolerância de R$ 1,00).
  select array_agg(coluna) into v_diferencas from (
    select coluna,
           sum(valor) filter (where conta ~ '^[0-9]{2}$') as funcoes,
           sum(valor) filter (where conta = 'total') as total
      from pg_temp.dca_linhas where coluna is not null group by coluna) x
   where total is null or abs(funcoes - total) > 1;
  if v_diferencas is not null then
    raise exception 'SICONFI: a soma das funções não bate com o total em: %', v_diferencas;
  end if;

  insert into dados.despesa_funcao (exercicio, conta, nome, coluna, valor, carga_id)
  select v_ano, conta, nome, coluna, valor, p_carga
    from pg_temp.dca_linhas where coluna is not null
  on conflict (exercicio, conta, coluna) do update
     set nome = excluded.nome, valor = excluded.valor, carga_id = excluded.carga_id
   where dados.despesa_funcao.valor is distinct from excluded.valor
      or dados.despesa_funcao.nome is distinct from excluded.nome;

  select count(*) into v_total from pg_temp.dca_linhas where coluna is not null;
  return v_total;
end
$$;

alter function etl.processar_respostas() rename to processar_respostas_v5;

create function etl.processar_respostas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_carga     record;
  v_resp      record;
  v_bruto     bytea;
  v_texto     text;
  v_sha       text;
  v_anterior  text;
  v_linhas    integer;
  v_n         integer := 0;
begin
  -- Municípios primeiro: as outras cargas dependem dos códigos do IBGE.
  for v_carga in
    select k.id, k.coleta_id, k.requisicao_id, k.solicitada_em, c.formato, c.serie_id, c.codificacao, c.fonte_id
      from etl.carga k
      join ref.coleta c on c.id = k.coleta_id
     where k.status = 'pendente'
     order by (c.formato = 'ibge_municipios') desc, k.id
  loop
    select status_code, content, error_msg, timed_out
      into v_resp
      from net._http_response
     where id = v_carga.requisicao_id;

    if not found then
      if v_carga.solicitada_em < now() - interval '2 hours' then
        update etl.carga
           set status = 'erro', processada_em = now(), mensagem = 'A fonte não respondeu'
         where id = v_carga.id;
      end if;
      continue;
    end if;

    begin
      if v_resp.status_code is distinct from 200 or v_resp.content is null then
        raise exception 'HTTP % %', coalesce(v_resp.status_code::text, 'sem resposta'), coalesce(v_resp.error_msg, '');
      end if;

      v_bruto := textsend(v_resp.content);
      v_texto := convert_from(v_bruto, case v_carga.codificacao when 'LATIN1' then 'LATIN1' else 'UTF8' end);
      v_sha := encode(extensions.digest(v_bruto, 'sha256'), 'hex');

      select sha256 into v_anterior
        from etl.carga
       where coleta_id = v_carga.coleta_id and status = 'ok'
       order by id desc
       limit 1;

      if v_anterior is not distinct from v_sha then
        update etl.carga
           set status = 'sem_mudanca', processada_em = now(), http_status = v_resp.status_code,
               bytes = octet_length(v_bruto), sha256 = v_sha
         where id = v_carga.id;
      else
        v_linhas := case v_carga.formato
          when 'sgs_json'        then etl.carregar_sgs(v_carga.id, v_carga.serie_id, v_texto)
          when 'bls_json'        then etl.carregar_bls(v_carga.id, v_carga.serie_id, v_texto)
          when 'rfb_csv'         then etl.carregar_rfb(v_carga.id, v_texto)
          when 'dieese_html'     then etl.carregar_dieese(v_carga.id, v_carga.serie_id, v_texto)
          when 'dieese_produto'  then etl.carregar_dieese_produto(v_carga.id, v_carga.serie_id, v_texto)
          when 'anp_csv'         then etl.carregar_anp_csv(v_carga.id, v_texto)
          when 'ibge_municipios' then etl.carregar_ibge_municipios(v_carga.id, v_texto)
          when 'sidra_json'      then etl.carregar_sidra(v_carga.id, v_carga.serie_id, v_texto)
          when 'csv_series'      then etl.carregar_csv_series(v_carga.id, v_carga.fonte_id, v_texto)
          when 'siconfi_dca'     then etl.carregar_siconfi_dca(v_carga.id, v_texto)
        end;
        update etl.carga
           set status = 'ok', processada_em = now(), http_status = v_resp.status_code,
               bytes = octet_length(v_bruto), sha256 = v_sha, linhas = v_linhas
         where id = v_carga.id;
      end if;
    exception when others then
      update etl.carga
         set status = 'erro', processada_em = now(), http_status = v_resp.status_code,
             mensagem = left(sqlerrm, 500)
       where id = v_carga.id;
    end;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- Blocos adicionais do painel
-- ---------------------------------------------------------------------------
create function etl.painel_blocos_extras()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'orcamento', jsonb_build_object(
    'pof', jsonb_build_object(
      'data_referencia', '2018-01-15',
      'mes_referencia', '2018-01',
      'salario_minimo_referencia', 954,
      'fonte_url', 'https://sidra.ibge.gov.br/tabela/6715',
      'classes', (
        select jsonb_agg(jsonb_build_object(
                 'codigo', c.codigo, 'nome', c.nome, 'renda_ate', c.renda_ate,
                 'itens', (select jsonb_object_agg(
                                    case p.item_codigo
                                      when 8010 then 'agua' when 8018 then 'luz' when 8022 then 'gas'
                                      when 8007 then 'aluguel_monetario' when 103541 then 'aluguel'
                                      when 103540 then 'habitacao' when 103536 then 'despesa_total' end,
                                    p.valor)
                             from ref.pof_despesa p where p.classe_codigo = c.codigo))
               order by c.ordem)
          from ref.pof_classe c))),
    'gastos_federais', jsonb_build_object(
      'coluna', 'liquidada',
      'unidade', 'R$ milhões',
      'fonte_url', 'https://apidatalake.tesouro.gov.br/docs/siconfi/',
      'anos', (select jsonb_agg(distinct exercicio order by exercicio)
                 from dados.despesa_funcao where coluna = 'liquidada' and conta = 'total'),
      'contas', (
        with anos as (
          select distinct exercicio from dados.despesa_funcao where coluna = 'liquidada' and conta = 'total'
        ),
        contas as (
          select distinct on (conta) conta, nome
            from dados.despesa_funcao
           where coluna = 'liquidada' and (conta ~ '^[0-9]{2}$' or conta ~ '^28\.' or conta = 'FU28' or conta in ('total', 'intra'))
           order by conta, exercicio desc
        )
        select jsonb_agg(jsonb_build_object(
                 'conta', c.conta, 'nome', c.nome,
                 'valores', (select jsonb_agg(round(d.valor / 1000000.0, 3) order by a.exercicio)
                               from anos a
                               left join dados.despesa_funcao d
                                 on d.exercicio = a.exercicio and d.conta = c.conta and d.coluna = 'liquidada'))
               order by c.conta)
          from contas c)))
$$;

alter function etl.gerar_painel() rename to gerar_painel_v3;

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

  -- Orçamento da família: gastos da POF 2017-2018 por faixa de renda.
  -- Blocos adicionais (orçamento da família, gastos federais...).
  v_dados := v_dados || etl.painel_blocos_extras();

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
