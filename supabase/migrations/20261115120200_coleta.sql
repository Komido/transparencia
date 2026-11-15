-- Coleta automática, feita inteiramente dentro do banco.
--
-- 1. etl.solicitar_coletas() dispara um GET (pg_net) para cada fonte ativa.
-- 2. etl.processar_respostas() lê as respostas, valida e grava.
--    Qualquer falha de validação recusa a carga inteira daquela fonte e
--    mantém os dados anteriores. Nada é apagado: só inserido ou atualizado.
-- 3. painel.gerar() (outra migração) monta o JSON publicado.
--
-- Não existe endpoint público que acione a coleta. Os papéis anon e
-- authenticated não têm USAGE no esquema etl (ver migração do esquema),
-- então não conseguem executar nenhuma destas funções.

-- Mês em português para número. Usa só as 3 primeiras letras, o que tolera
-- acentos corrompidos ("Mar?o") e entidades HTML ("Mar&ccedil;o").
create function etl.mes_numero(p_nome text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case lower(left(btrim(p_nome), 3))
    when 'jan' then 1  when 'fev' then 2  when 'mar' then 3
    when 'abr' then 4  when 'mai' then 5  when 'jun' then 6
    when 'jul' then 7  when 'ago' then 8  when 'set' then 9
    when 'out' then 10 when 'nov' then 11 when 'dez' then 12
  end
$$;

-- ---------------------------------------------------------------------------
-- Banco Central (SGS): [{"data":"01/10/2026","valor":"0.14"}, ...]
-- ---------------------------------------------------------------------------
create function etl.carregar_sgs(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json        jsonb;
  v_total       integer;
  v_invalidos   integer;
  v_distintos   integer;
  v_existentes  integer;
begin
  v_json := p_conteudo::jsonb;
  if jsonb_typeof(v_json) <> 'array' then
    raise exception 'SGS: a resposta não é uma lista';
  end if;

  select count(*),
         count(*) filter (where not (e ->> 'data' ~ '^01/(0[1-9]|1[0-2])/[0-9]{4}$'
                                     and e ->> 'valor' ~ '^-?[0-9]+(\.[0-9]+)?$')),
         count(distinct e ->> 'data')
    into v_total, v_invalidos, v_distintos
    from jsonb_array_elements(v_json) e
   where coalesce(e ->> 'valor', '') <> '';

  if v_invalidos > 0 then
    raise exception 'SGS: % registros fora do formato esperado', v_invalidos;
  end if;
  if v_distintos <> v_total then
    raise exception 'SGS: datas repetidas na resposta';
  end if;

  select count(*) into v_existentes
    from dados.observacao
   where serie_id = p_serie and localidade_id = 'BR';
  if v_total < v_existentes then
    raise exception 'SGS: a fonte devolveu % registros, menos que os % já gravados', v_total, v_existentes;
  end if;

  insert into dados.observacao (serie_id, periodo, valor, carga_id)
  select p_serie, to_date(e ->> 'data', 'DD/MM/YYYY'), (e ->> 'valor')::numeric, p_carga
    from jsonb_array_elements(v_json) e
   where coalesce(e ->> 'valor', '') <> ''
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- BLS (CPI-U): Results.series[0].data[] com year, period (M01..M12), value
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

  if exists (
    select 1 from jsonb_array_elements(v_dados) d
     where d ->> 'period' ~ '^M(0[1-9]|1[0-2])$'
       and not (d ->> 'year' ~ '^[0-9]{4}$' and d ->> 'value' ~ '^[0-9]+(\.[0-9]+)?$')
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
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  get diagnostics v_total = row_count;
  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Receita Federal: arrecadacao-estado.csv (separador ";", decimal ",")
-- ---------------------------------------------------------------------------
create function etl.carregar_rfb(p_carga bigint, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_linhas      text[];
  v_cab         text[];
  v_rub         record;
  v_erros       integer;
  v_registros   integer;
  v_distintos   integer;
  v_existentes  integer;
begin
  v_linhas := regexp_split_to_array(p_conteudo, E'\r?\n');
  v_cab := string_to_array(v_linhas[1], ';');

  if coalesce(array_length(v_cab, 1), 0) <> 45 then
    raise exception 'Receita: o cabeçalho tem % colunas; esperado 45', coalesce(array_length(v_cab, 1), 0);
  end if;
  if v_cab[1] <> 'Ano' or v_cab[3] <> 'UF' then
    raise exception 'Receita: cabeçalho inesperado nas colunas Ano/UF';
  end if;
  for v_rub in select posicao, fragmento_cabecalho from ref.rubrica_receita order by posicao loop
    if strpos(upper(v_cab[v_rub.posicao]), upper(v_rub.fragmento_cabecalho)) = 0 then
      raise exception 'Receita: a coluna % mudou (esperado "%", recebido "%")',
        v_rub.posicao, v_rub.fragmento_cabecalho, v_cab[v_rub.posicao];
    end if;
  end loop;

  -- Só as linhas de dados, sem o cabeçalho e sem linhas vazias.
  select array_agg(l) into v_linhas
    from unnest(v_linhas[2:]) as l
   where btrim(l) <> '';

  select count(*) filter (where array_length(c, 1) <> 45
                             or c[1] !~ '^[0-9]{4}$'
                             or etl.mes_numero(c[2]) is null
                             or c[3] !~ '^[A-Z]{2}$'),
         count(*),
         count(distinct (c[1], etl.mes_numero(c[2]), c[3]))
    into v_erros, v_registros, v_distintos
    from (select string_to_array(l, ';') as c from unnest(v_linhas) as l) t;

  if v_erros > 0 then
    raise exception 'Receita: % linhas com ano, mês, UF ou número de colunas inválidos', v_erros;
  end if;
  if v_distintos <> v_registros then
    raise exception 'Receita: linhas repetidas para o mesmo mês e UF';
  end if;

  select count(*) into v_erros
    from (select string_to_array(l, ';') as c from unnest(v_linhas) as l) t
   cross join ref.rubrica_receita r
   where coalesce(t.c[r.posicao], '') <> ''
     and t.c[r.posicao] !~ '^-?[0-9]+(,[0-9]+)?$';
  if v_erros > 0 then
    raise exception 'Receita: % valores fora do formato numérico esperado', v_erros;
  end if;

  select count(*) into v_existentes
    from (select distinct periodo, uf from dados.arrecadacao_federal) x;
  if v_registros < v_existentes then
    raise exception 'Receita: o arquivo tem % linhas (mês e UF), menos que as % já gravadas', v_registros, v_existentes;
  end if;

  insert into dados.arrecadacao_federal (periodo, uf, posicao, valor, carga_id)
  select make_date(t.c[1]::integer, etl.mes_numero(t.c[2]), 1),
         t.c[3],
         r.posicao,
         replace(t.c[r.posicao], ',', '.')::numeric,
         p_carga
    from (select string_to_array(l, ';') as c from unnest(v_linhas) as l) t
   cross join ref.rubrica_receita r
   where coalesce(t.c[r.posicao], '') <> ''
  on conflict (periodo, uf, posicao) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.arrecadacao_federal.valor is distinct from excluded.valor;

  return v_registros;
end
$$;

-- ---------------------------------------------------------------------------
-- DIEESE: tabela HTML "Salário mínimo nominal e necessário"
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

    select array_agg(btrim(regexp_replace(m[1], '<[^>]+>', '', 'g')) order by ordem)
      into v_tds
      from regexp_matches(v_tr, '<td[^>]*?>(.*?)</td>', 'gi') with ordinality as t(m, ordem);

    continue when v_ano is null or v_tds is null or array_length(v_tds, 1) <> 3;
    v_mes := etl.mes_numero(v_tds[1]);
    -- Só valores em reais (a partir do Plano Real).
    continue when v_mes is null or v_tds[3] !~ '^R\$\s*[0-9.]+,[0-9]{2}$';

    v_periodo := make_date(v_ano, v_mes, 1);
    continue when v_periodo = any (v_periodos);
    v_periodos := v_periodos || v_periodo;
    v_valores := v_valores
      || replace(replace(regexp_replace(v_tds[3], '^R\$\s*', ''), '.', ''), ',', '.')::numeric;
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
-- Orquestração
-- ---------------------------------------------------------------------------
create function etl.solicitar_coletas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_coleta  record;
  v_req     bigint;
  v_n       integer := 0;
begin
  for v_coleta in select id, url from ref.coleta where ativa order by id loop
    v_req := net.http_get(
      url := v_coleta.url,
      headers := jsonb_build_object('User-Agent', 'ArrecadometroBrasil/1.0 (coleta de dados publicos)'),
      timeout_milliseconds := 120000
    );
    insert into etl.carga (coleta_id, url, requisicao_id) values (v_coleta.id, v_coleta.url, v_req);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

create function etl.processar_respostas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_carga     record;
  v_resp      record;
  v_sha       text;
  v_anterior  text;
  v_linhas    integer;
  v_n         integer := 0;
begin
  for v_carga in
    select k.id, k.coleta_id, k.requisicao_id, k.solicitada_em, c.formato, c.serie_id
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

      v_sha := encode(extensions.digest(v_resp.content, 'sha256'), 'hex');
      select sha256 into v_anterior
        from etl.carga
       where coleta_id = v_carga.coleta_id and status = 'ok'
       order by id desc
       limit 1;

      if v_anterior is not distinct from v_sha then
        update etl.carga
           set status = 'sem_mudanca', processada_em = now(), http_status = v_resp.status_code,
               bytes = octet_length(v_resp.content), sha256 = v_sha
         where id = v_carga.id;
      else
        v_linhas := case v_carga.formato
          when 'sgs_json'    then etl.carregar_sgs(v_carga.id, v_carga.serie_id, v_resp.content)
          when 'bls_json'    then etl.carregar_bls(v_carga.id, v_carga.serie_id, v_resp.content)
          when 'rfb_csv'     then etl.carregar_rfb(v_carga.id, v_resp.content)
          when 'dieese_html' then etl.carregar_dieese(v_carga.id, v_carga.serie_id, v_resp.content)
        end;
        update etl.carga
           set status = 'ok', processada_em = now(), http_status = v_resp.status_code,
               bytes = octet_length(v_resp.content), sha256 = v_sha, linhas = v_linhas
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
