-- O DIEESE publica dezembro de 2015 duas vezes: pela metodologia antiga
-- ("12-2015", 17 cidades) e recalculado pela nova ("12-2015 (1)", 27 cidades).
-- A partir de janeiro de 2016 só existe a nova. Regra: quando um mês aparece
-- duas vezes, vale a linha recalculada (com a nota), que continua nos meses
-- seguintes. Mês repetido sem a nota de recálculo continua recusando a carga.

alter function etl.carregar_dieese_produto(bigint, text, text) rename to carregar_dieese_produto_v2;

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
  v_recalculada   boolean;
  v_valor         text;
  v_periodo       date;
  v_vistos        date[] := '{}';
  v_vistos_rec    date[] := '{}';
  v_periodos      date[] := '{}';
  v_locs          text[] := '{}';
  v_valores       numeric[] := '{}';
  v_recs          boolean[] := '{}';
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
    v_recalculada := v_tds[1] ~ '\([0-9]+\)$';
    v_mes := regexp_replace(v_tds[1], '\s*\([0-9]+\)$', '');
    if v_mes !~ '^(0[1-9]|1[0-2])-[0-9]{4}$' then
      raise exception 'DIEESE: mês inválido "%"', left(v_tds[1], 40);
    end if;
    if array_length(v_tds, 1) <> array_length(v_cab, 1) then
      raise exception 'DIEESE: % tem % colunas; esperado %', v_mes, array_length(v_tds, 1), array_length(v_cab, 1);
    end if;

    v_periodo := make_date(substr(v_mes, 4, 4)::integer, substr(v_mes, 1, 2)::integer, 1);
    if v_recalculada then
      if v_periodo = any (v_vistos_rec) then
        raise exception 'DIEESE: % recalculado aparece mais de uma vez', v_mes;
      end if;
      v_vistos_rec := v_vistos_rec || v_periodo;
    else
      if v_periodo = any (v_vistos) then
        raise exception 'DIEESE: % aparece mais de uma vez sem nota de recálculo', v_mes;
      end if;
      v_vistos := v_vistos || v_periodo;
      v_meses := v_meses + 1;
    end if;

    for i in 2 .. array_length(v_tds, 1) loop
      v_valor := regexp_replace(v_tds[i], '\s*\([0-9]+\)$', '');
      continue when v_valor in ('-', '');
      if v_valor !~ '^[0-9]{1,3}(\.[0-9]{3})*,[0-9]{2}$' then
        raise exception 'DIEESE: valor inválido "%" em %', left(v_valor, 30), v_mes;
      end if;
      v_periodos := v_periodos || v_periodo;
      v_locs := v_locs || v_locais[i - 1];
      v_valores := v_valores || replace(replace(v_valor, '.', ''), ',', '.')::numeric;
      v_recs := v_recs || v_recalculada;
    end loop;
  end loop;

  if v_meses < 300 then
    raise exception 'DIEESE: só % meses na tabela', v_meses;
  end if;

  select count(*) into v_total
    from (select distinct u.periodo, u.local from unnest(v_periodos, v_locs) as u(periodo, local)) x;
  select count(*) into v_existentes from dados.observacao where serie_id = p_serie;
  if v_total < v_existentes then
    raise exception 'DIEESE: a tabela trouxe % valores, menos que os % já gravados', v_total, v_existentes;
  end if;

  -- Um valor por mês e cidade, preferindo a linha recalculada.
  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select p_serie, d.local, d.periodo, d.valor, p_carga
    from (select distinct on (u.periodo, u.local) u.periodo, u.local, u.valor
            from unnest(v_periodos, v_locs, v_valores, v_recs) as u(periodo, local, valor, recalculada)
           order by u.periodo, u.local, u.recalculada desc) d
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;
