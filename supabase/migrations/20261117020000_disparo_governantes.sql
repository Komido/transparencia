-- Disparo mensal da tarefa de prefeitos e governadores eleitos
-- (converter-governantes.yml), que lê os dados abertos do TSE. Os eleitos só
-- mudam com eleição suplementar ou correção do TSE; uma vez por mês basta.
-- Dia 13, às 06:19 de Brasília, fora dos horários das outras tarefas.

select cron.schedule('arrecadometro-github-governantes', '19 9 13 * *',
  $$select etl.disparar_github('converter-governantes.yml')$$);
