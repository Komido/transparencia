-- Disparo semanal da tarefa das emendas parlamentares por cidade
-- (converter-emendas.yml), que baixa o arquivo único do Portal da
-- Transparência. Segundas, às 06:31 de Brasília, fora dos horários das outras
-- tarefas.

select cron.schedule('arrecadometro-github-emendas', '31 9 * * 1',
  $$select etl.disparar_github('converter-emendas.yml')$$);
