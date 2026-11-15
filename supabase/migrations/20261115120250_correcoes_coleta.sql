-- Correções feitas depois da primeira coleta real. As validações recusaram
-- três fontes, e nenhum dado errado chegou a ser gravado:
--
-- 1. Receita e DIEESE publicam em ISO-8859-1. O pg_net guarda os bytes como
--    vieram; lidos como UTF-8, uma letra acentuada "engolia" o ";" seguinte
--    ("Mês;UF" virava uma coluna só). Agora cada coleta declara a
--    codificação, e o texto é convertido antes de qualquer validação.
-- 2. A API v1 do BLS só respeita o período pedido via POST; por GET devolve
--    apenas os anos mais recentes. O BLS também publica "-" quando não tem o
--    valor (caso de outubro de 2025): esses meses ficam sem dado, sem estimativa.
-- 3. DIEESE: nos anos mais antigos as células têm quebras de linha.
--
-- Para não usar comandos destrutivos, as versões anteriores das funções foram
-- renomeadas com o sufixo _v1. Elas não são chamadas por nada e podem ser
-- removidas numa limpeza futura.

alter table ref.coleta
  add column codificacao text not null default 'UTF8' check (codificacao in ('UTF8', 'LATIN1'));
alter table ref.coleta
  add column metodo text not null default 'GET' check (metodo in ('GET', 'POST'));
alter table ref.coleta
  add column corpo jsonb;
alter table ref.coleta
  add constraint coleta_corpo_post check ((metodo = 'POST') = (corpo is not null));

update ref.coleta set codificacao = 'LATIN1' where id in ('rfb_csv', 'dieese_smn');

update ref.coleta
   set metodo = 'POST',
       url = 'https://api.bls.gov/publicAPI/v1/timeseries/data/',
       corpo = jsonb_build_object(
         'seriesid', jsonb_build_array('CUUR0000SA0'),
         'startyear', left(right(id, 4), 4),
         'endyear', (right(id, 4)::integer + 9)::text)
 where formato = 'bls_json';

alter function etl.carregar_bls(bigint, text, text) rename to carregar_bls_v1;
alter function etl.carregar_dieese(bigint, text, text) rename to carregar_dieese_v1;
alter function etl.solicitar_coletas() rename to solicitar_coletas_v1;
alter function etl.processar_respostas() rename to processar_respostas_v1;

-- ---------------------------------------------------------------------------
create function etl.carregar_bls(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json   jsonb;
  v_dados  jsonb;
  v_total  integer;
begin
  v_json := p_conteudo::jsonb;
  if v_json ->> 'status' is distinct from 'REQUEST_SUCCEEDED' then
    raise exception 'BLS: % %', coalesce(v_json ->> 'status', 'sem status'), coalesce((v_json -> 'message')::text, '');
  end if;

  v_dados := v_json -> 'Results' -> 'series' -> 0 -> 'data';
  if jsonb_typeof(v_dados) <> 'array' or jsonb_array_length(v_dados) = 0 then
    raise exception 'BLS: resposta sem dados';
  end if;

  -- Meses M01..M12 precisam ter número ou "-" (valor não publicado).
  if exists (
    select 1 from jsonb_array_elements(v_dados) d
     where d ->> 'period' ~ '^M(0[1-9]|1[0-2])$'
       and not (d ->> 'year' ~ '^[0-9]{4}$'
                and (d ->> 'value' ~ '^[0-9]+(\.[0-9]+)?$' or d ->> 'value' = '-'))
  ) then
    raise exception 'BLS: registros fora do formato esperado';
  end if;

  insert into dados.observacao (serie_id, periodo, valor, carga_id)
  select p_serie,
         make_date((d ->> 'year')::integer, substr(d ->> 'period', 2)::integer, 1),
         (d ->> 'value')::numeric,
         p_carga
    from jsonb_array_elements(v_dados) d
   where d ->> 'period' ~ '^M(0[1-9]|1[0-2])$'
     and d ->> 'value' ~ '^[0-9]+(\.[0-9]+)?$'
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  get diagnostics v_total = row_count;
  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
create function etl.carregar_dieese(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_tr          text;
  v_ano         integer;
  v_tds         text[];
  v_mes         integer;
  v_periodo     date;
  v_periodos    date[] := '{}';
  v_valores     numeric[] := '{}';
  v_total       integer;
  v_existentes  integer;
begin
  -- O primeiro quantificador não guloso torna a expressão inteira não gulosa.
  for v_tr in select (regexp_matches(p_conteudo, '<tr[^>]*?>(.*?)</tr>', 'gi'))[1] loop
    if v_tr ~* 'name="[0-9]{4}"' then
      v_ano := (regexp_match(v_tr, 'name="([0-9]{4})"', 'i'))[1]::integer;
      continue;
    end if;

    -- Remove as marcações e junta espaços e quebras de linha.
    select array_agg(btrim(regexp_replace(regexp_replace(m[1], '<[^>]+>', '', 'g'), '\s+', ' ', 'g'))
                     order by ordem)
      into v_tds
      from regexp_matches(v_tr, '<td[^>]*?>(.*?)</td>', 'gi') with ordinality as t(m, ordem);

    continue when v_ano is null or v_tds is null or array_length(v_tds, 1) <> 3;
    v_mes := etl.mes_numero(v_tds[1]);
    -- Só valores em reais (a partir do Plano Real).
    continue when v_mes is null or v_tds[3] !~ '^R\$ ?[0-9.]+,[0-9]{2}$';

    v_periodo := make_date(v_ano, v_mes, 1);
    continue when v_periodo = any (v_periodos);
    v_periodos := v_periodos || v_periodo;
    v_valores := v_valores
      || replace(replace(regexp_replace(v_tds[3], '^R\$ ?', ''), '.', ''), ',', '.')::numeric;
  end loop;

  v_total := coalesce(array_length(v_periodos, 1), 0);
  if v_total < 300 then
    raise exception 'DIEESE: só % meses reconhecidos; o layout da página pode ter mudado', v_total;
  end if;

  select count(*) into v_existentes
    from dados.observacao
   where serie_id = p_serie and localidade_id = 'BR';
  if v_total < v_existentes then
    raise exception 'DIEESE: a página trouxe % meses, menos que os % já gravados', v_total, v_existentes;
  end if;

  insert into dados.observacao (serie_id, periodo, valor, carga_id)
  select p_serie, u.periodo, u.valor, p_carga
    from unnest(v_periodos, v_valores) as u(periodo, valor)
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
create function etl.solicitar_coletas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_coleta     record;
  v_req        bigint;
  v_n          integer := 0;
  v_cabecalho  constant jsonb := jsonb_build_object('User-Agent', 'ArrecadometroBrasil/1.0 (coleta de dados publicos)');
begin
  for v_coleta in select id, url, metodo, corpo from ref.coleta where ativa order by id loop
    if v_coleta.metodo = 'POST' then
      v_req := net.http_post(
        url := v_coleta.url,
        body := v_coleta.corpo,
        headers := v_cabecalho || jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 120000
      );
    else
      v_req := net.http_get(
        url := v_coleta.url,
        headers := v_cabecalho,
        timeout_milliseconds := 120000
      );
    end if;
    insert into etl.carga (coleta_id, url, requisicao_id) values (v_coleta.id, v_coleta.url, v_req);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
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
  for v_carga in
    select k.id, k.coleta_id, k.requisicao_id, k.solicitada_em, c.formato, c.serie_id, c.codificacao
      from etl.carga k
      join ref.coleta c on c.id = k.coleta_id
     where k.status = 'pendente'
     order by k.id
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

      -- Bytes exatamente como chegaram; a conversão valida a codificação.
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
          when 'sgs_json'    then etl.carregar_sgs(v_carga.id, v_carga.serie_id, v_texto)
          when 'bls_json'    then etl.carregar_bls(v_carga.id, v_carga.serie_id, v_texto)
          when 'rfb_csv'     then etl.carregar_rfb(v_carga.id, v_texto)
          when 'dieese_html' then etl.carregar_dieese(v_carga.id, v_carga.serie_id, v_texto)
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
