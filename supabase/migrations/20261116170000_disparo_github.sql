-- Disparo das tarefas do GitHub pelo agendador do banco.
--
-- Desde que o repositório existe (15/11/2026), o GitHub não disparou nenhuma
-- tarefa agendada (evento schedule), embora as execuções manuais funcionem.
-- Em 16/11, uma tarefa de teste a cada 5 minutos não rodou nenhuma vez em uma
-- hora; salva de novo pela conta do dono do repositório, a cada 10 minutos,
-- também não rodou em 40 minutos. A causa não foi encontrada (branch padrão,
-- repositório público, tarefas ativas). O pg_cron deste banco, que roda a
-- coleta diária sem falha, passa a pedir ao GitHub que rode cada tarefa
-- (workflow_dispatch), nos horários que estavam nos arquivos das tarefas.
--
-- A chave do GitHub fica no Vault com o nome github_disparo: token
-- fine-grained do dono do repositório, só com Actions (leitura e escrita) e
-- só neste repositório. A função lê a chave do Vault na hora do pedido; ela
-- não aparece em arquivo nem em tabela do projeto (o pg_net a guarda na fila
-- de saída só até enviar o pedido).
--
-- Cada pedido fica em etl.disparo. etl.conferir_disparos, de hora em hora,
-- copia a resposta do GitHub (204 = aceito) e marca erro quando a resposta é
-- outra ou não chega em 6 horas (o pg_net apaga respostas mais antigas).
-- Chave apagada, vencida ou sem permissão aparece ali como erro (401, 403 ou
-- 404), em vez de o site simplesmente parar de atualizar.
--
-- Se a branch padrão do repositório mudar de nome, mudar também v_branch.

create table etl.disparo (
  id             bigint generated always as identity primary key,
  tarefa         text not null,
  entradas       jsonb not null default '{}'::jsonb,
  pedido_em      timestamptz not null default now(),
  requisicao_id  bigint,
  status         text not null default 'pendente' check (status in ('pendente', 'ok', 'erro')),
  http_status    integer,
  mensagem       text,
  conferido_em   timestamptz
);
alter table etl.disparo enable row level security;

create function etl.disparar_github(p_tarefa text, p_entradas jsonb default '{}'::jsonb)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_branch  constant text := 'claude/tender-hopper-dbp169';
  v_chave   text;
  v_corpo   jsonb;
  v_id      bigint;
  v_req     bigint;
begin
  if p_tarefa !~ '^[a-z0-9-]+\.yml$' then
    raise exception 'Nome de tarefa inválido: %', p_tarefa;
  end if;
  insert into etl.disparo (tarefa, entradas)
  values (p_tarefa, coalesce(p_entradas, '{}'::jsonb))
  returning id into v_id;

  select decrypted_secret into v_chave from vault.decrypted_secrets where name = 'github_disparo';
  if v_chave is null or btrim(v_chave) = '' then
    update etl.disparo
       set status = 'erro', mensagem = 'Chave github_disparo não encontrada no Vault', conferido_em = now()
     where id = v_id;
    return v_id;
  end if;

  v_corpo := jsonb_build_object('ref', v_branch);
  if p_entradas is not null and p_entradas <> '{}'::jsonb then
    v_corpo := v_corpo || jsonb_build_object('inputs', p_entradas);
  end if;

  v_req := net.http_post(
    url := 'https://api.github.com/repos/Komido/transparencia/actions/workflows/' || p_tarefa || '/dispatches',
    body := v_corpo,
    headers := jsonb_build_object(
      'Accept', 'application/vnd.github+json',
      'Authorization', 'Bearer ' || btrim(v_chave),
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'ArrecadometroBrasil/1.0 (disparo de tarefas)',
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 30000
  );
  update etl.disparo set requisicao_id = v_req where id = v_id;
  return v_id;
end
$$;

create function etl.conferir_disparos()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  update etl.disparo d
     set status = case when r.status_code = 204 then 'ok' else 'erro' end,
         http_status = r.status_code,
         mensagem = case
           when r.status_code = 204 then null
           when r.timed_out then 'O GitHub não respondeu a tempo'
           else left(coalesce(nullif(r.error_msg, ''), r.content, 'Resposta inesperada'), 300)
         end,
         conferido_em = now()
    from net._http_response r
   where r.id = d.requisicao_id and d.status = 'pendente';
  get diagnostics v_n = row_count;

  update etl.disparo
     set status = 'erro', mensagem = 'Sem resposta do GitHub em 6 horas', conferido_em = now()
   where status = 'pendente' and pedido_em < now() - interval '6 hours';
  return v_n;
end
$$;

revoke all on table etl.disparo from public, anon, authenticated;
revoke all on function etl.disparar_github(text, jsonb) from public, anon, authenticated;
revoke all on function etl.conferir_disparos() from public, anon, authenticated;

-- Horários em UTC, os mesmos que estavam nas tarefas (Brasília = UTC-3).
select cron.schedule('arrecadometro-github-cota-recentes', '37 8 * * 1-6',
  $$select etl.disparar_github('converter-cota.yml', '{"periodo": "recentes"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-cota-tudo', '37 8 * * 0',
  $$select etl.disparar_github('converter-cota.yml', '{"periodo": "tudo"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-anp', '53 8 * * *',
  $$select etl.disparar_github('converter-anp.yml')$$);
select cron.schedule('arrecadometro-github-fipezap', '57 8 * * *',
  $$select etl.disparar_github('converter-fipezap.yml')$$);
select cron.schedule('arrecadometro-github-portal-recentes', '23 9 * * 1',
  $$select etl.disparar_github('converter-portal.yml', '{"periodo": "recentes"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-portal-tudo', '41 9 2 * *',
  $$select etl.disparar_github('converter-portal.yml', '{"periodo": "tudo"}'::jsonb)$$);
select cron.schedule('arrecadometro-github-atualizar', '23 11 * * *',
  $$select etl.disparar_github('atualizar-dados.yml')$$);
select cron.schedule('arrecadometro-github-conferir', '29 * * * *',
  $$select etl.conferir_disparos()$$);
