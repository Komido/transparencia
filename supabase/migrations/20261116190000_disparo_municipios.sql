-- Disparo mensal da tarefa das contas das prefeituras (converter-municipios.yml).
--
-- A tarefa pede ao Tesouro o relatório de cada uma das 5.570 prefeituras
-- (uma chamada por prefeitura e por ano) e leva cerca de três horas. Uma vez
-- por mês basta: o relatório é anual, e o mês a mês só pega prefeituras que
-- entregaram atrasado ou corrigiram o relatório. Dia 12, às 06:13 de
-- Brasília, fora dos horários das outras tarefas.

select cron.schedule('arrecadometro-github-prefeituras', '13 9 12 * *',
  $$select etl.disparar_github('converter-municipios.yml', '{"ufs": "todas"}'::jsonb)$$);
