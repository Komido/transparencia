-- O arquivo arrecadacao-estado.csv da Receita mistura formatos numéricos:
--   * na maior parte dos meses: vírgula decimal ("73514,09");
--   * em junho/2023 e maio/2024: ponto como milhar ("11.080.068", "226.708.856,85");
--   * de 2001 a 2002: vírgula como milhar ("1,131,699") no mesmo mês em que
--     aparecem centavos com 2 casas ("808,54").
--
-- Regra adotada:
--   1. Um mês usa "vírgula como milhar" se algum valor dele tiver duas ou mais
--      vírgulas em grupos de 3 dígitos. Só nesses meses "408,348" é lido como
--      408.348 reais. A escolha muda o total mensal em no máximo 0,36%
--      (0,21% em média), medido na carga de 15/11/2026.
--   2. Ponto em grupos de 3 dígitos é sempre milhar.
--   3. Fora disso, vírgula é decimal. Qualquer outro formato recusa a carga.

create function etl.numero_receita(p_valor text, p_milhar_virgula boolean)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_milhar_virgula and p_valor ~ '^-?[0-9]{1,3}(,[0-9]{3})+$'
      then replace(p_valor, ',', '')::numeric
    when p_valor ~ '^-?[0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?$'
      then replace(replace(p_valor, '.', ''), ',', '.')::numeric
    when p_valor ~ '^-?[0-9]+(,[0-9]+)?$'
      then replace(p_valor, ',', '.')::numeric
  end
$$;

alter function etl.carregar_rfb(bigint, text) rename to carregar_rfb_v1;

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

  with t as (
    select string_to_array(l, ';') as c from unnest(v_linhas) as l
  ),
  meses_milhar as (
    select distinct t.c[1] as ano, etl.mes_numero(t.c[2]) as mes
      from t cross join ref.rubrica_receita r
     where t.c[r.posicao] ~ '^-?[0-9]{1,3}(,[0-9]{3}){2,}$'
  )
  select count(*) into v_erros
    from t
   cross join ref.rubrica_receita r
    left join meses_milhar mm on mm.ano = t.c[1] and mm.mes = etl.mes_numero(t.c[2])
   where coalesce(t.c[r.posicao], '') <> ''
     and etl.numero_receita(t.c[r.posicao], mm.ano is not null) is null;
  if v_erros > 0 then
    raise exception 'Receita: % valores fora dos formatos numéricos conhecidos', v_erros;
  end if;

  select count(*) into v_existentes
    from (select distinct periodo, uf from dados.arrecadacao_federal) x;
  if v_registros < v_existentes then
    raise exception 'Receita: o arquivo tem % linhas (mês e UF), menos que as % já gravadas', v_registros, v_existentes;
  end if;

  with t as (
    select string_to_array(l, ';') as c from unnest(v_linhas) as l
  ),
  meses_milhar as (
    select distinct t.c[1] as ano, etl.mes_numero(t.c[2]) as mes
      from t cross join ref.rubrica_receita r
     where t.c[r.posicao] ~ '^-?[0-9]{1,3}(,[0-9]{3}){2,}$'
  )
  insert into dados.arrecadacao_federal (periodo, uf, posicao, valor, carga_id)
  select make_date(t.c[1]::integer, etl.mes_numero(t.c[2]), 1),
         t.c[3],
         r.posicao,
         etl.numero_receita(t.c[r.posicao], mm.ano is not null),
         p_carga
    from t
   cross join ref.rubrica_receita r
    left join meses_milhar mm on mm.ano = t.c[1] and mm.mes = etl.mes_numero(t.c[2])
   where coalesce(t.c[r.posicao], '') <> ''
  on conflict (periodo, uf, posicao) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.arrecadacao_federal.valor is distinct from excluded.valor;

  return v_registros;
end
$$;
