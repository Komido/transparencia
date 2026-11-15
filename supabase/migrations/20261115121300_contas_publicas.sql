-- Saúde das contas públicas (Banco Central, SGS).
--
-- Códigos conferidos pelo título oficial no portal de dados abertos do Banco
-- Central (dadosabertos.bcb.gov.br) em 15/11/2026:
--   4639  NFSP sem desvalorização cambial - Fluxo mensal corrente - Resultado primário - Total - Governo Federal e Banco Central
--   4606  NFSP sem desvalorização cambial - Fluxo mensal corrente - Juros nominais - Total - Governo Federal e Banco Central
--   4573  NFSP sem desvalorização cambial - Fluxo mensal corrente - Resultado nominal - Total - Governo Federal e Banco Central
--   5783  NFSP sem desvalorização cambial (% PIB) - Fluxo acumulado em 12 meses - Resultado primário - Total - Governo Federal e Banco Central
--   5750  NFSP sem desvalorização cambial (% PIB) - Fluxo acumulado em 12 meses - Juros nominais - Total - Governo Federal e Banco Central
--   5717  NFSP sem desvalorização cambial (% PIB) - Fluxo acumulado em 12 meses - Resultado nominal - Total - Governo Federal e Banco Central
--   13762 Dívida bruta do governo geral (% PIB) - Metodologia utilizada a partir de 2008
--
-- Sinal: NFSP são "necessidades de financiamento". Valor positivo é déficit
-- (faltou dinheiro), negativo é superávit (sobrou). Conferido nos dados:
-- 2020 = +9,79% do PIB (déficit da pandemia), 2013 = -1,41% (superávit).
-- O site mostra o sinal invertido ("sobrou" positivo) e explica isso.
--
-- "Governo Federal" no Banco Central inclui o INSS (há séries separadas de
-- governo federal sem INSS e de INSS).

insert into ref.serie (id, nome, unidade, fonte_id, codigo_origem, observacao) values
  ('nfsp_primario', 'Resultado primário do governo federal e Banco Central (NFSP)', 'R$ milhões no mês; positivo = déficit', 'bcb_sgs', 'SGS 4639', 'Sem desvalorização cambial. Fluxo mensal corrente.'),
  ('nfsp_juros', 'Juros nominais do governo federal e Banco Central (NFSP)', 'R$ milhões no mês; positivo = despesa', 'bcb_sgs', 'SGS 4606', 'Sem desvalorização cambial. Fluxo mensal corrente.'),
  ('nfsp_nominal', 'Resultado nominal do governo federal e Banco Central (NFSP)', 'R$ milhões no mês; positivo = déficit', 'bcb_sgs', 'SGS 4573', 'Sem desvalorização cambial. Fluxo mensal corrente.'),
  ('nfsp_primario_pib', 'Resultado primário do governo federal e Banco Central, % do PIB em 12 meses', '% do PIB; positivo = déficit', 'bcb_sgs', 'SGS 5783', 'Fluxo acumulado em 12 meses.'),
  ('nfsp_juros_pib', 'Juros nominais do governo federal e Banco Central, % do PIB em 12 meses', '% do PIB', 'bcb_sgs', 'SGS 5750', 'Fluxo acumulado em 12 meses.'),
  ('nfsp_nominal_pib', 'Resultado nominal do governo federal e Banco Central, % do PIB em 12 meses', '% do PIB; positivo = déficit', 'bcb_sgs', 'SGS 5717', 'Fluxo acumulado em 12 meses.'),
  ('divida_bruta_pib', 'Dívida bruta do governo geral', '% do PIB', 'bcb_sgs', 'SGS 13762', 'Governo geral: União, estados e municípios. Metodologia usada a partir de 2008, série desde dezembro de 2006.');

insert into ref.coleta (id, fonte_id, url, formato, serie_id)
select 'sgs_' || c.codigo, 'bcb_sgs', 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.' || c.codigo || '/dados?formato=json', 'sgs_json', c.serie
  from (values ('4639', 'nfsp_primario'), ('4606', 'nfsp_juros'), ('4573', 'nfsp_nominal'),
               ('5783', 'nfsp_primario_pib'), ('5750', 'nfsp_juros_pib'), ('5717', 'nfsp_nominal_pib'),
               ('13762', 'divida_bruta_pib')) as c(codigo, serie);
