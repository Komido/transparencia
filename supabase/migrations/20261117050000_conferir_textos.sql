-- Conferência semanal das regras escritas à mão no site (valores do Bolsa
-- Família e regras do BPC, na página Entenda) contra as páginas do MDS e do
-- INSS: .github/workflows/conferir-textos.yml. Quartas-feiras às 07:07 de
-- Brasília. Se algum valor mudar, a tarefa falha e o GitHub avisa.

select cron.schedule('arrecadometro-github-conferir-textos', '7 10 * * 3',
  $$select etl.disparar_github('conferir-textos.yml')$$);
