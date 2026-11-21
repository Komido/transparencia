-- Repetição das tarefas mensais no dia seguinte, no mesmo horário.
--
-- Em 21/11/2026 o Tesouro Transparente derrubou todas as conexões da tarefa
-- do STF ("connection reset"), e a próxima tentativa seria só em 21/12. A
-- repetição envia repeticao=sim: a primeira etapa da tarefa ("conferir")
-- procura no GitHub uma execução com o mesmo título que tenha dado certo nas
-- últimas 30 horas. Se achar, a tarefa para ali, sem baixar nada dos
-- servidores do governo; se não achar, roda inteira.
--
-- As entradas são as mesmas da execução mensal, mais repeticao, para que o
-- título (e a conferência) seja o mesmo.

select cron.schedule('arrecadometro-github-stf-repeticao', '47 11 22 * *',
  $$select etl.disparar_github('converter-stf.yml', '{"repeticao": "sim"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-camaras-repeticao', '47 11 21 * *',
  $$select etl.disparar_github('converter-camaras.yml', '{"repeticao": "sim"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-prefeituras-repeticao', '13 9 13 * *',
  $$select etl.disparar_github('converter-municipios.yml', '{"ufs": "todas", "repeticao": "sim"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-governantes-repeticao', '19 9 14 * *',
  $$select etl.disparar_github('converter-governantes.yml', '{"repeticao": "sim"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-portal-tudo-repeticao', '41 9 3 * *',
  $$select etl.disparar_github('converter-portal.yml', '{"periodo": "tudo", "repeticao": "sim"}'::jsonb)$$);
