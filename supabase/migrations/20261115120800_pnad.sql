-- Desemprego e renda média do trabalho (IBGE, PNAD Contínua).
--
-- Fonte: API do SIDRA (apisidra.ibge.gov.br), Brasil, trimestre móvel.
--   Tabela 6381, variável 4099: taxa de desocupação das pessoas de 14 anos ou
--   mais (%).
--   Tabela 6390, variável 5933: rendimento médio mensal real habitualmente
--   recebido em todos os trabalhos (R$). O IBGE publica esta série já corrigida
--   para valores do trimestre mais recente; por isso todos os meses mudam a cada
--   divulgação, e a carga atualiza o histórico inteiro.
--
-- Cada trimestre móvel é gravado no último mês dele: "jan-fev-mar 2012"
-- (código 201203) vira 2012-03.
--
-- As versões anteriores das funções alteradas foram renomeadas com sufixo _v3.

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('ibge_pnadc', 'Pesquisa Nacional por Amostra de Domicílios Contínua (PNAD Contínua)', 'IBGE',
   'https://sidra.ibge.gov.br/tabela/6381',
   'Trimestre móvel, Brasil. Começa em janeiro-março de 2012.');

insert into ref.serie (id, nome, unidade, fonte_id, codigo_origem, observacao) values
  ('desocupacao', 'Taxa de desocupação (desemprego)', '% das pessoas de 14 anos ou mais na força de trabalho',
   'ibge_pnadc', 'SIDRA 6381, variável 4099',
   'Trimestre móvel gravado no último mês dele.'),
  ('renda_trabalho', 'Rendimento médio real do trabalho', 'R$ por mês, em valores do trimestre mais recente',
   'ibge_pnadc', 'SIDRA 6390, variável 5933',
   'Habitualmente recebido em todos os trabalhos. Trimestre móvel gravado no último mês dele.');

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check
  check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv',
                     'ibge_municipios', 'sidra_json'));

insert into ref.coleta (id, fonte_id, url, formato, serie_id) values
  ('sidra_6381', 'ibge_pnadc', 'https://apisidra.ibge.gov.br/values/t/6381/n1/all/v/4099/p/all', 'sidra_json', 'desocupacao'),
  ('sidra_6390', 'ibge_pnadc', 'https://apisidra.ibge.gov.br/values/t/6390/n1/all/v/5933/p/all', 'sidra_json', 'renda_trabalho');

-- ---------------------------------------------------------------------------
-- SIDRA: lista JSON; o primeiro item é o cabeçalho com o nome de cada campo.
-- Campos usados: V (valor), D1C (Brasil = 1), D2C (variável), D3C (período
-- AAAAMM). Valores "..." , "-", ".." e "X" são os marcadores de dado ausente
-- do IBGE e ficam fora; qualquer outro valor não numérico recusa a carga.
-- ---------------------------------------------------------------------------
create function etl.carregar_sidra(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json        jsonb;
  v_cab         jsonb;
  v_variavel    text;
  v_total       integer;
  v_invalidos   integer;
  v_distintos   integer;
  v_variaveis   integer;
  v_existentes  integer;
begin
  v_json := p_conteudo::jsonb;
  if jsonb_typeof(v_json) <> 'array' or jsonb_array_length(v_json) < 2 then
    raise exception 'SIDRA: a resposta não é uma lista com dados';
  end if;

  v_cab := v_json -> 0;
  if v_cab ->> 'V' <> 'Valor' or v_cab ->> 'D1N' <> 'Brasil' or v_cab ->> 'D2N' <> 'Variável'
     or v_cab ->> 'D3N' not in ('Trimestre Móvel', 'Mês') then
    raise exception 'SIDRA: cabeçalho inesperado %', left(v_cab::text, 200);
  end if;

  -- A variável esperada vem do código de origem da série ("variável 4099").
  select substring(codigo_origem from 'variável ([0-9]+)') into v_variavel
    from ref.serie where id = p_serie;
  if v_variavel is null then
    raise exception 'SIDRA: série % sem variável no código de origem', p_serie;
  end if;

  with linhas as (
    select e from jsonb_array_elements(v_json) with ordinality as t(e, i)
     where i > 1 and coalesce(e ->> 'V', '') not in ('...', '-', '..', 'X')
  )
  select count(*),
         count(*) filter (where not (e ->> 'V' ~ '^-?[0-9]+(\.[0-9]+)?$'
                                     and e ->> 'D1C' = '1'
                                     and e ->> 'D3C' ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])$')),
         count(distinct e ->> 'D3C'),
         count(distinct e ->> 'D2C') filter (where e ->> 'D2C' <> v_variavel)
    into v_total, v_invalidos, v_distintos, v_variaveis
    from linhas;

  if v_invalidos > 0 then
    raise exception 'SIDRA: % registros fora do formato esperado', v_invalidos;
  end if;
  if v_variaveis > 0 then
    raise exception 'SIDRA: a resposta traz variável diferente de %', v_variavel;
  end if;
  if v_distintos <> v_total then
    raise exception 'SIDRA: períodos repetidos na resposta';
  end if;

  select count(*) into v_existentes
    from dados.observacao
   where serie_id = p_serie and localidade_id = 'BR';
  if v_total < v_existentes then
    raise exception 'SIDRA: a fonte devolveu % registros, menos que os % já gravados', v_total, v_existentes;
  end if;

  insert into dados.observacao (serie_id, localidade_id, periodo, valor, carga_id)
  select p_serie, 'BR', to_date(e ->> 'D3C', 'YYYYMM'), (e ->> 'V')::numeric, p_carga
    from jsonb_array_elements(v_json) with ordinality as t(e, i)
   where i > 1 and coalesce(e ->> 'V', '') not in ('...', '-', '..', 'X')
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Orquestração com o formato do SIDRA
-- ---------------------------------------------------------------------------
alter function etl.processar_respostas() rename to processar_respostas_v3;

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
    select k.id, k.coleta_id, k.requisicao_id, k.solicitada_em, c.formato, c.serie_id, c.codificacao
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
