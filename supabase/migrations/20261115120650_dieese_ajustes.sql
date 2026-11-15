-- Ajustes depois da primeira coleta dos preços do DIEESE:
--
-- 1. A linha de dezembro de 2015 vem como "12-2015(1)": a nota (1) do DIEESE
--    avisa que a série foi recalculada por mudança de metodologia. A marca é
--    retirada do mês; a mudança está registrada na metodologia do site.
-- 2. Algumas consultas voltaram com erro 500 do servidor da fonte. Falhas do
--    lado da fonte (HTTP 5xx ou sem resposta) passam a ser tentadas de novo a
--    cada hora, no máximo 3 vezes em 24 horas, para qualquer coleta.

alter function etl.carregar_dieese_produto(bigint, text, text) rename to carregar_dieese_produto_v1;

create function etl.carregar_dieese_produto(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_cab           text[];
  v_locais        text[];
  v_desconhecidas text[];
  v_tr            text;
  v_tds           text[];
  v_mes           text;
  v_valor         text;
  v_periodo       date;
  v_periodos      date[] := '{}';
  v_locs          text[] := '{}';
  v_valores       numeric[] := '{}';
  v_meses         integer := 0;
  v_total         integer;
  v_existentes    integer;
  i               integer;
begin
  select array_agg(btrim(regexp_replace(regexp_replace(regexp_replace(m[1], '<[^>]+>', '', 'g'), '\s+', ' ', 'g'), '\s*\([0-9]+\)$', '')) order by ordem)
    into v_cab
    from regexp_matches(substring(p_conteudo from '<thead>(.*?)</thead>'), '<th[^>]*?>(.*?)</th>', 'gi') with ordinality as t(m, ordem);

  if coalesce(array_length(v_cab, 1), 0) < 11 then
    raise exception 'DIEESE: cabeçalho com % colunas; o layout pode ter mudado', coalesce(array_length(v_cab, 1), 0);
  end if;

  select array_agg(l.id order by x.ordem),
         array_agg(x.nome order by x.ordem) filter (where l.id is null)
    into v_locais, v_desconhecidas
    from unnest(v_cab[2:]) with ordinality as x(nome, ordem)
    left join ref.cidade_dieese c on c.nome = x.nome
    left join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla;

  if v_desconhecidas is not null then
    raise exception 'DIEESE: cidades sem código do IBGE: %', v_desconhecidas;
  end if;

  for v_tr in
    select (regexp_matches(substring(p_conteudo from '<tbody>(.*?)</tbody>'), '<tr[^>]*?>(.*?)</tr>', 'gi'))[1]
  loop
    select array_agg(btrim(regexp_replace(regexp_replace(m[1], '<[^>]+>', '', 'g'), '\s+', ' ', 'g')) order by ordem)
      into v_tds
      from regexp_matches(v_tr, '<td[^>]*?>(.*?)</td>', 'gi') with ordinality as t(m, ordem);

    continue when v_tds is null;
    -- Retira notas como "(1)" do mês.
    v_mes := regexp_replace(v_tds[1], '\s*\([0-9]+\)$', '');
    if v_mes !~ '^(0[1-9]|1[0-2])-[0-9]{4}$' then
      raise exception 'DIEESE: mês inválido "%"', left(v_tds[1], 40);
    end if;
    if array_length(v_tds, 1) <> array_length(v_cab, 1) then
      raise exception 'DIEESE: % tem % colunas; esperado %', v_mes, array_length(v_tds, 1), array_length(v_cab, 1);
    end if;

    v_periodo := make_date(substr(v_mes, 4, 4)::integer, substr(v_mes, 1, 2)::integer, 1);
    v_meses := v_meses + 1;

    for i in 2 .. array_length(v_tds, 1) loop
      v_valor := regexp_replace(v_tds[i], '\s*\([0-9]+\)$', '');
      continue when v_valor in ('-', '');
      if v_valor !~ '^[0-9]{1,3}(\.[0-9]{3})*,[0-9]{2}$' then
        raise exception 'DIEESE: valor inválido "%" em %', left(v_valor, 30), v_mes;
      end if;
      v_periodos := v_periodos || v_periodo;
      v_locs := v_locs || v_locais[i - 1];
      v_valores := v_valores || replace(replace(v_valor, '.', ''), ',', '.')::numeric;
    end loop;
  end loop;

  v_total := coalesce(array_length(v_valores, 1), 0);
  if v_meses < 300 then
    raise exception 'DIEESE: só % meses na tabela', v_meses;
  end if;

  select count(*) into v_existentes from dados.observacao where serie_id = p_serie;
  if v_total < v_existentes then
    raise exception 'DIEESE: a tabela trouxe % valores, menos que os % já gravados', v_total, v_existentes;
  end if;

  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select p_serie, u.local, u.periodo, u.valor, p_carga
    from unnest(v_periodos, v_locs, v_valores) as u(periodo, local, valor)
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- Nova tentativa para falhas do lado da fonte.
create function etl.reenviar_falhas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_coleta     record;
  v_url        text;
  v_req        bigint;
  v_n          integer := 0;
  v_cabecalho  constant jsonb := jsonb_build_object('User-Agent', 'ArrecadometroBrasil/1.0 (coleta de dados publicos)');
begin
  for v_coleta in
    select c.id, c.url, c.metodo, c.corpo
      from ref.coleta c
      join lateral (
        select k.status, k.mensagem from etl.carga k where k.coleta_id = c.id order by k.id desc limit 1
      ) ultima on true
     where c.ativa
       and ultima.status = 'erro'
       and ultima.mensagem ~ '^(HTTP 5[0-9][0-9]|HTTP sem resposta|A fonte não respondeu)'
       and (select count(*) from etl.carga k
             where k.coleta_id = c.id and k.solicitada_em > now() - interval '24 hours') < 4
     order by c.id
  loop
    v_url := replace(v_coleta.url, '{mes_atual}', to_char(now() at time zone 'America/Sao_Paulo', 'MMYYYY'));
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
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Processamento a cada hora: lê respostas, tenta de novo o que falhou na
-- fonte e refaz o painel se algo foi processado.
select cron.schedule('arrecadometro-processar', '7 * * * *', $$
  select etl.processar_respostas();
  select etl.reenviar_falhas();
  select etl.gerar_painel()
   where exists (select 1 from etl.carga
                  where processada_em > coalesce((select gerado_em from painel.snapshot where id = 1), '-infinity'));
$$);
