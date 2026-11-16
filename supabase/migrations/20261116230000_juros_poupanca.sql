-- Juros do dia a dia e rendimento da poupança, para a seção "Dinheiro no dia
-- a dia".
--
-- Banco Central, SGS. Códigos e nomes conferidos em 16/11/2026 no catálogo de
-- dados abertos do BCB (dadosabertos.bcb.gov.br):
--   25477 Taxa média mensal de juros ... Pessoas físicas - Cartão de crédito rotativo
--   25463 Taxa média mensal de juros ... Pessoas físicas - Cheque especial
--   25470 Taxa média mensal de juros ... Pessoas físicas - Crédito pessoal total
--     (as três em % ao mês, mensais; setembro de 2026: 15,29%, 7,53% e 3,58%)
--   195   Depósitos de poupança a partir de 04.05.2012 - Rentabilidade no período
--     (diária: cada dia traz o rendimento de um mês para quem depositou naquele
--     dia; em 13/11/2026, 0,6463%)
--
-- Da poupança fica só o dia 1º de cada mês: é o rendimento do mês inteiro de
-- um depósito feito no dia 1º, e dá uma série mensal como as outras. Para
-- isso, um carregador novo (sgs_dia1) que ignora os outros dias. A API do BCB
-- devolve no máximo 10 anos de série diária por pedido, por isso a poupança
-- vem em dois pedidos: de 04/05/2012 a 31/12/2021 e de 01/01/2022 em diante.
-- Depósitos anteriores a 04/05/2012 seguem outra regra (série 25) e ficam
-- fora.
--
-- Versão anterior renomeada: carregar_formato_v4.

insert into ref.serie (id, nome, unidade, fonte_id, codigo_origem, observacao) values
  ('juros_rotativo', 'Juros do cartão de crédito rotativo, taxa média do mês (pessoas físicas)', '% ao mês', 'bcb_sgs', 'SGS 25477',
   'Média de todos os bancos. Desde 2024, os juros e encargos do rotativo e do parcelamento da fatura não podem passar do valor original da dívida (Lei 14.690/2023).'),
  ('juros_cheque_especial', 'Juros do cheque especial, taxa média do mês (pessoas físicas)', '% ao mês', 'bcb_sgs', 'SGS 25463',
   'Média de todos os bancos. Limitados a 8% ao mês desde 2020 (Resolução CMN 4.765/2019).'),
  ('juros_credito_pessoal', 'Juros do crédito pessoal, taxa média do mês (pessoas físicas)', '% ao mês', 'bcb_sgs', 'SGS 25470',
   'Média de todos os bancos, com e sem desconto em folha.'),
  ('poupanca_rend', 'Rendimento da poupança no mês (depósito no dia 1º)', '% no mês', 'bcb_sgs', 'SGS 195',
   'Regra dos depósitos feitos a partir de 4 de maio de 2012. Rendimento do mês para quem tem aniversário no dia 1º.');

alter table ref.coleta drop constraint coleta_formato_check;
alter table ref.coleta add constraint coleta_formato_check check (formato = any (array[
  'sgs_json', 'bls_json', 'rfb_csv', 'dieese_html', 'dieese_produto', 'anp_csv', 'ibge_municipios',
  'sidra_json', 'csv_series', 'siconfi_dca', 'sidra_pof', 'fipezap_cidades', 'anp_estados_csv',
  'siconfi_rgf', 'siconfi_rreo3', 'sgs_dia1']));

insert into ref.coleta (id, fonte_id, url, formato, serie_id) values
  ('sgs_25477', 'bcb_sgs', 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.25477/dados?formato=json', 'sgs_json', 'juros_rotativo'),
  ('sgs_25463', 'bcb_sgs', 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.25463/dados?formato=json', 'sgs_json', 'juros_cheque_especial'),
  ('sgs_25470', 'bcb_sgs', 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.25470/dados?formato=json', 'sgs_json', 'juros_credito_pessoal'),
  ('sgs_195_ate_2021', 'bcb_sgs', 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.195/dados?formato=json&dataInicial=04/05/2012&dataFinal=31/12/2021', 'sgs_dia1', 'poupanca_rend'),
  ('sgs_195_desde_2022', 'bcb_sgs', 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.195/dados?formato=json&dataInicial=01/01/2022', 'sgs_dia1', 'poupanca_rend');

-- Série diária do SGS, guardando só o dia 1º de cada mês. Confere o formato de
-- todos os registros, datas repetidas e, dentro do período que a resposta
-- cobre, que não venham menos meses do que já estão gravados.
create function etl.carregar_sgs_dia1(p_carga bigint, p_serie text, p_conteudo text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_json        jsonb;
  v_total       integer;
  v_invalidos   integer;
  v_distintos   integer;
  v_dia1        integer;
  v_inicio      date;
  v_fim         date;
  v_existentes  integer;
begin
  v_json := p_conteudo::jsonb;
  if jsonb_typeof(v_json) <> 'array' then
    raise exception 'SGS diária: a resposta não é uma lista';
  end if;

  select count(*),
         count(*) filter (where not (e ->> 'data' ~ '^(0[1-9]|[12][0-9]|3[01])/(0[1-9]|1[0-2])/[0-9]{4}$'
                                     and e ->> 'valor' ~ '^-?[0-9]+(\.[0-9]+)?$')),
         count(distinct e ->> 'data'),
         count(*) filter (where e ->> 'data' like '01/%')
    into v_total, v_invalidos, v_distintos, v_dia1
    from jsonb_array_elements(v_json) e
   where coalesce(e ->> 'valor', '') <> '';

  if v_total = 0 then
    raise exception 'SGS diária: resposta vazia';
  end if;
  if v_invalidos > 0 then
    raise exception 'SGS diária: % registros fora do formato esperado', v_invalidos;
  end if;
  if v_distintos <> v_total then
    raise exception 'SGS diária: datas repetidas na resposta';
  end if;

  select min(to_date(e ->> 'data', 'DD/MM/YYYY')), max(to_date(e ->> 'data', 'DD/MM/YYYY'))
    into v_inicio, v_fim
    from jsonb_array_elements(v_json) e
   where e ->> 'data' like '01/%';

  select count(*) into v_existentes
    from dados.observacao
   where serie_id = p_serie and localidade_id = 'BR' and periodo between v_inicio and v_fim;
  if v_dia1 < v_existentes then
    raise exception 'SGS diária: a fonte devolveu % meses, menos que os % já gravados no mesmo período', v_dia1, v_existentes;
  end if;

  insert into dados.observacao (serie_id, periodo, valor, carga_id)
  select p_serie, to_date(e ->> 'data', 'DD/MM/YYYY'), (e ->> 'valor')::numeric, p_carga
    from jsonb_array_elements(v_json) e
   where coalesce(e ->> 'valor', '') <> '' and e ->> 'data' like '01/%'
  on conflict (serie_id, localidade_id, periodo) do update
     set valor = excluded.valor, carga_id = excluded.carga_id
   where dados.observacao.valor is distinct from excluded.valor;

  return v_dia1;
end
$$;

alter function etl.carregar_formato(text, bigint, text, text, text) rename to carregar_formato_v4;

create function etl.carregar_formato(p_formato text, p_carga bigint, p_serie text, p_fonte text, p_texto text)
returns integer
language plpgsql
set search_path = ''
as $$
begin
  if p_formato = 'sgs_dia1' then
    return etl.carregar_sgs_dia1(p_carga, p_serie, p_texto);
  end if;
  return etl.carregar_formato_v4(p_formato, p_carga, p_serie, p_fonte, p_texto);
end
$$;

revoke all on function etl.carregar_sgs_dia1(bigint, text, text) from public, anon, authenticated;
revoke all on function etl.carregar_formato(text, bigint, text, text, text) from public, anon, authenticated;
