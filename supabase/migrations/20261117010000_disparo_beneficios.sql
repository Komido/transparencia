-- Disparo diário da tarefa do Bolsa Família e do BPC por cidade
-- (converter-beneficios.yml).
--
-- A tarefa pede à API do Portal da Transparência uma cidade por vez, cerca de
-- 1 hora por mês de dados, e para depois de 5 horas. Nas primeiras noites ela
-- monta o histórico desde março de 2023; depois, só confere se saiu mês novo
-- (4 pedidos) e termina em segundos. Às 01:17 de Brasília, quando o limite do
-- Portal é maior e antes das outras tarefas da manhã.

select cron.schedule('arrecadometro-github-beneficios', '17 4 * * *',
  $$select etl.disparar_github('converter-beneficios.yml')$$);
