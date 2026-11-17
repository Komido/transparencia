-- Disparo da tarefa das votações e projetos de deputados e senadores
-- (converter-congresso.yml), que lê os arquivos da Câmara e os serviços do
-- Senado. Segundas e quintas, às 05:13 de Brasília: na segunda, termina antes
-- da tarefa das emendas (06:31), que usa a lista oficial gravada por ela.

select cron.schedule('arrecadometro-github-congresso', '13 8 * * 1,4',
  $$select etl.disparar_github('converter-congresso.yml')$$);
