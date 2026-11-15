-- Fila com ritmo para a API do Tesouro (apidatalake.tesouro.gov.br).
--
-- Em 15/11/2026, um lote de 104 pedidos seguidos (RREO das capitais) teve 41
-- recusas: HTTP 429 (pedidos demais) e conexões cortadas ("Failure when
-- receiving data from the peer"). Lotes parecidos tinham passado minutos
-- antes, então o limite parece ser por janela de tempo. A coleta diária
-- mandava todos os pedidos ao Tesouro no mesmo minuto (cerca de 170 diários
-- mais 40 do rodízio mensal), e reenviar_falhas não repetia o 429.
--
-- Agora:
--   * solicitar_coletas deixa de mandar os pedidos do Tesouro;
--   * solicitar_tesouro(limite) roda a cada 5 minutos e manda no máximo
--     "limite" pedidos (12): primeiro os do dia que ainda não foram pedidos
--     hoje, depois as falhas passageiras (429, 5xx, sem resposta), até 4
--     pedidos por coleta em 24 horas. Uma coleta com pedido ainda pendente
--     espera a resposta. Com 12 a cada 5 minutos, o volume diário termina em
--     cerca de uma hora e meia;
--   * reenviar_falhas deixa o Tesouro para a fila e passa a repetir também o
--     429 das outras fontes.
--
-- Versões anteriores renomeadas: solicitar_coletas_v5, reenviar_falhas_v2.

alter function etl.solicitar_coletas() rename to solicitar_coletas_v5;

create function etl.solicitar_coletas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_id   text;
  v_dia  integer := extract(day from now() at time zone 'America/Sao_Paulo')::int;
  v_n    integer := 0;
begin
  for v_id in
    select id from ref.coleta
     where ativa and (dia_do_mes is null or dia_do_mes = v_dia)
       and url not like 'https://apidatalake.tesouro.gov.br/%'
     order by id
  loop
    perform etl.enviar_requisicao(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

create function etl.solicitar_tesouro(p_limite integer default 12)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_id    text;
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dia   integer := extract(day from now() at time zone 'America/Sao_Paulo')::int;
  v_n     integer := 0;
begin
  for v_id in
    with candidatas as (
      select c.id,
             ultima.status, ultima.mensagem, ultima.solicitada_em,
             (c.dia_do_mes is null or c.dia_do_mes = v_dia) as devida_hoje
        from ref.coleta c
        left join lateral (
          select k.status, k.mensagem, k.solicitada_em from etl.carga k where k.coleta_id = c.id order by k.id desc limit 1
        ) ultima on true
       where c.ativa and c.url like 'https://apidatalake.tesouro.gov.br/%'
         and ultima.status is distinct from 'pendente'
    )
    select id from (
      -- Do dia, ainda não pedidas hoje.
      select id, 1 as ordem from candidatas
       where devida_hoje and (solicitada_em is null or (solicitada_em at time zone 'America/Sao_Paulo')::date < v_hoje)
      union all
      -- Falhas passageiras, até 4 pedidos em 24 horas.
      select k.id, 2 from candidatas k
       where k.status = 'erro'
         and k.mensagem ~ '^(HTTP 429|HTTP 5[0-9][0-9]|HTTP sem resposta|A fonte não respondeu)'
         and (select count(*) from etl.carga x where x.coleta_id = k.id and x.solicitada_em > now() - interval '24 hours') < 4
    ) fila
    group by id
    order by min(ordem), id
    limit p_limite
  loop
    perform etl.enviar_requisicao(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

alter function etl.reenviar_falhas() rename to reenviar_falhas_v2;

create function etl.reenviar_falhas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_id  text;
  v_n   integer := 0;
begin
  for v_id in
    select c.id
      from ref.coleta c
      join lateral (
        select k.status, k.mensagem from etl.carga k where k.coleta_id = c.id order by k.id desc limit 1
      ) ultima on true
     where c.ativa
       and c.url not like 'https://apidatalake.tesouro.gov.br/%'
       and ultima.status = 'erro'
       and ultima.mensagem ~ '^(HTTP 429|HTTP 5[0-9][0-9]|HTTP sem resposta|A fonte não respondeu)'
       and (select count(*) from etl.carga k
             where k.coleta_id = c.id and k.solicitada_em > now() - interval '24 hours') < 4
     order by c.id
  loop
    perform etl.enviar_requisicao(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

select cron.schedule('arrecadometro-tesouro', '*/5 * * * *', $cron$select etl.solicitar_tesouro(12)$cron$);
