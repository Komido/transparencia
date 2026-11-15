-- Extensões usadas pela coleta agendada.
-- pg_net: requisições HTTP feitas pelo próprio banco.
-- pg_cron: agendamento das coletas.
create extension if not exists pg_net;
create extension if not exists pg_cron;
