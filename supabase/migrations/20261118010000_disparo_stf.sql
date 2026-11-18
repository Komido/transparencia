-- Gastos do STF (Tesouro Nacional): .github/workflows/converter-stf.yml.
-- Uma vez por mês, dia 21 às 08:47 de Brasília. A tarefa só refaz a conta
-- quando alguma planilha anual do Tesouro muda.

select cron.schedule('arrecadometro-github-stf', '47 11 21 * *',
  $$select etl.disparar_github('converter-stf.yml')$$);
