-- Inflação do aluguel residencial (IPCA, subitem 2101001, categoria 7448),
-- para trazer para hoje o valor de aluguel da POF 2017-2018 no orçamento da
-- família. Mesmo formato das outras séries de IPCA por subitem.

insert into ref.serie (id, nome, unidade, fonte_id, codigo_origem, observacao) values
  ('ipca_aluguel_var', 'IPCA, aluguel residencial, variação mensal', '%', 'ibge',
   'SIDRA 1419 e 7060, variável 63, categoria 7448', 'Usada para trazer o valor de aluguel da POF para hoje.');

insert into ref.coleta (id, fonte_id, url, formato, serie_id, cabecalho_proprio) values
  ('sidra_1419_aluguel', 'ibge', 'https://apisidra.ibge.gov.br/values/t/1419/n1/all/v/63/p/all/c315/7448', 'sidra_json', 'ipca_aluguel_var', false),
  ('sidra_7060_aluguel', 'ibge', 'https://apisidra.ibge.gov.br/values/t/7060/n1/all/v/63/p/all/c315/7448', 'sidra_json', 'ipca_aluguel_var', false);
