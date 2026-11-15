-- O servidor do SIDRA (IBGE) responde "400 Bad Request - Invalid Header" a
-- qualquer cabeçalho extra enviado pelo pg_net, inclusive o User-Agent de
-- identificação. Sem cabeçalhos extras ele responde normalmente (testado em
-- 15/11/2026). A coluna cabecalho_proprio desliga o cabeçalho só nessas coletas.
--
-- O envio passa a ficar numa função só, usada pela coleta diária e pelas novas
-- tentativas. As versões anteriores foram renomeadas (_v3 e _v1).

alter table ref.coleta add column cabecalho_proprio boolean not null default true;
update ref.coleta set cabecalho_proprio = false where formato = 'sidra_json';

create function etl.enviar_requisicao(p_coleta text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_coleta     record;
  v_url        text;
  v_cabecalho  jsonb;
  v_req        bigint;
begin
  select id, url, metodo, corpo, cabecalho_proprio into v_coleta from ref.coleta where id = p_coleta;
  if not found then
    raise exception 'Coleta % não existe', p_coleta;
  end if;

  v_url := replace(v_coleta.url, '{mes_atual}', to_char(now() at time zone 'America/Sao_Paulo', 'MMYYYY'));
  v_cabecalho := case when v_coleta.cabecalho_proprio
                      then jsonb_build_object('User-Agent', 'ArrecadometroBrasil/1.0 (coleta de dados publicos)')
                      else '{}'::jsonb end;

  if v_coleta.metodo = 'POST' then
    v_req := net.http_post(
      url := v_url,
      body := v_coleta.corpo,
      headers := v_cabecalho || jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 120000
    );
  else
    v_req := net.http_get(url := v_url, headers := v_cabecalho, timeout_milliseconds := 120000);
  end if;

  insert into etl.carga (coleta_id, url, requisicao_id) values (v_coleta.id, v_url, v_req);
  return v_req;
end
$$;

alter function etl.solicitar_coletas() rename to solicitar_coletas_v3;

create function etl.solicitar_coletas()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_id  text;
  v_n   integer := 0;
begin
  for v_id in select id from ref.coleta where ativa order by id loop
    perform etl.enviar_requisicao(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

alter function etl.reenviar_falhas() rename to reenviar_falhas_v1;

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
       and ultima.status = 'erro'
       and ultima.mensagem ~ '^(HTTP 5[0-9][0-9]|HTTP sem resposta|A fonte não respondeu)'
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
