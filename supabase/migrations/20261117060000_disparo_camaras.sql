-- Gastos das câmaras municipais de SP (Tribunal de Contas de SP):
-- .github/workflows/converter-camaras.yml. Uma vez por mês, dia 20 às 08:47
-- de Brasília, fora do horário da recuperação do Bolsa Família (madrugada).
-- A tarefa só baixa o arquivo do ano que mudou (mais de 2 GB cada); quando
-- nada mudou, termina em menos de um minuto.

select cron.schedule('arrecadometro-github-camaras', '47 11 20 * *',
  $$select etl.disparar_github('converter-camaras.yml')$$);
