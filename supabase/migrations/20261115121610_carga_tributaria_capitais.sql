-- 1) Capitais: cada uma com os próprios últimos 12 meses.
--
-- As capitais não são somadas no site, então não há motivo para esperar a
-- mais atrasada. Em 15/11/2026, Macapá ainda não tinha entregue o 4º
-- bimestre de 2026, e o mês comum a todas ficaria em dezembro de 2025.
-- "doze_meses" passa a terminar no último mês de cada capital
-- ("ultimo_mes"); "doze_meses_ate" sai do bloco.
--
-- 2) Carga tributária por esfera de governo (Tesouro Nacional).
--
-- Fonte: Boletim de Estimativa da Carga Tributária Bruta do Governo Geral
-- 2025, Tesouro Nacional, publicado em 25/03/2026.
--   https://cdn.tesouro.gov.br/sistemas-internos/apex/producao/sistemas/thot/arquivos/publicacoes/54334_1699660/Boletim_CTB_2025.pdf
--   sha256 c7e51243ca43c7d54e94b40905fced20bb5e18bd479ae1a3b7aaa6b1110d4727,
--   13 páginas. Valores copiados da Tabela 1 (por esfera de governo) e da
--   Tabela 3 (por esfera e espécie tributária), em R$ milhões correntes e %
--   do PIB, dados preliminares. Conferido: no bloco dos municípios, IPTU +
--   ITBI + outros = impostos sobre a propriedade, e propriedade + bens e
--   serviços = impostos, nos dois anos.
--
-- É a única fonte oficial com o total de todos os municípios do país: a API
-- do Siconfi responde uma prefeitura por vez, e o Tesouro completa as que
-- não entregam dados com técnicas de imputação (nota 4/ da Tabela 3). O
-- boletim sai em PDF, uma vez por ano, com endereço novo a cada edição, sem
-- planilha. Por isso os valores entram aqui como dado de referência, e cada
-- nova edição precisa de uma migração nova, conferida da mesma forma.
--
-- A carga não inclui o FGTS nem o Sistema S (notas 5/ e 6/ da Tabela 3).
-- O bloco dos estados tem pequenos valores de ISS, IPTU e ITBI, que são do
-- Distrito Federal (no DF quem cobra esses impostos é o governo distrital).
--
-- Versões anteriores renomeadas: painel_receita_capitais_v1,
-- painel_blocos_extras_v6.

alter function etl.painel_receita_capitais() rename to painel_receita_capitais_v1;

create function etl.painel_receita_capitais()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with capitais as (
    select l.id::integer as codigo, l.nome, l.uf_sigla
      from ref.cidade_dieese c
      join ref.localidade l on l.nivel = 'municipio' and l.nome = c.nome and l.uf_sigla = c.uf_sigla
     where c.capital
  ),
  base as (
    select r.* from dados.receita_municipio r join capitais k on k.codigo = r.municipio_codigo
  ),
  anual as (
    select municipio_codigo, tributo, extract(year from mes)::int as ano, sum(valor) as valor, count(*) as meses
      from base
     group by 1, 2, 3
  ),
  anos as (
    select generate_series(2015, (select max(ano) from anual where meses = 12)) as ano
  ),
  ultimo as (
    select municipio_codigo, max(mes) as mes from base where tributo = 'iss' group by 1
  ),
  doze as (
    select b.municipio_codigo, b.tributo, sum(b.valor) as valor, count(*) as meses
      from base b
      join ultimo u on u.municipio_codigo = b.municipio_codigo
     where b.mes > (u.mes - interval '12 months')::date and b.mes <= u.mes
     group by 1, 2
  ),
  tributos(tributo) as (values ('iss'), ('iptu'), ('itbi'))
  select jsonb_build_object(
    'fonte_url', 'https://apidatalake.tesouro.gov.br/docs/siconfi/',
    'anos', (select jsonb_agg(ano order by ano) from anos),
    'capitais', (
      select jsonb_agg(jsonb_build_object(
               'codigo', k.codigo::text, 'nome', k.nome, 'uf', k.uf_sigla,
               'ultimo_mes', (select to_char(x.mes, 'YYYY-MM') from ultimo x where x.municipio_codigo = k.codigo),
               'anual', (select jsonb_object_agg(t.tributo,
                                  (select jsonb_agg((select round(a.valor, 2) from anual a
                                                      where a.municipio_codigo = k.codigo and a.tributo = t.tributo
                                                        and a.ano = y.ano and a.meses = 12)
                                                    order by y.ano)
                                     from anos y))
                           from tributos t),
               'doze_meses', (select jsonb_object_agg(d.tributo, round(d.valor, 2))
                                from doze d where d.municipio_codigo = k.codigo and d.meses = 12))
             order by k.uf_sigla)
        from capitais k))
$$;

insert into ref.fonte (id, nome, orgao, url_documentacao, observacao) values
  ('stn_ctb', 'Estimativa da Carga Tributária Bruta do Governo Geral', 'Tesouro Nacional',
   'https://cdn.tesouro.gov.br/sistemas-internos/apex/producao/sistemas/thot/arquivos/publicacoes/54334_1699660/Boletim_CTB_2025.pdf',
   'Boletim anual em PDF. Edição 2025 publicada em 25/03/2026, sha256 c7e51243ca43c7d54e94b40905fced20bb5e18bd479ae1a3b7aaa6b1110d4727. Tabelas 1 e 3.');

create table ref.carga_tributaria (
  ano            smallint not null check (ano between 2000 and 2100),
  esfera         text not null check (esfera in ('governo_geral', 'central', 'estados', 'municipios')),
  item           text not null check (item in ('total', 'iss', 'iptu', 'itbi')),
  valor_milhoes  numeric not null,
  pct_pib        numeric not null,
  fonte_id       text not null references ref.fonte (id),
  tabela         text not null,
  primary key (ano, esfera, item)
);
alter table ref.carga_tributaria enable row level security;

insert into ref.carga_tributaria (ano, esfera, item, valor_milhoes, pct_pib, fonte_id, tabela) values
  (2024, 'governo_geral', 'total', 3794740, 32.22, 'stn_ctb', 'Tabela 1'),
  (2025, 'governo_geral', 'total', 4127232, 32.40, 'stn_ctb', 'Tabela 1'),
  (2024, 'central',       'total', 2513703, 21.34, 'stn_ctb', 'Tabela 1'),
  (2025, 'central',       'total', 2750941, 21.60, 'stn_ctb', 'Tabela 1'),
  (2024, 'estados',       'total',  998835,  8.48, 'stn_ctb', 'Tabela 1'),
  (2025, 'estados',       'total', 1067626,  8.38, 'stn_ctb', 'Tabela 1'),
  (2024, 'municipios',    'total',  282203,  2.40, 'stn_ctb', 'Tabela 1'),
  (2025, 'municipios',    'total',  308665,  2.42, 'stn_ctb', 'Tabela 1'),
  (2024, 'municipios',    'iss',    136618,  1.16, 'stn_ctb', 'Tabela 3'),
  (2025, 'municipios',    'iss',    150919,  1.18, 'stn_ctb', 'Tabela 3'),
  (2024, 'municipios',    'iptu',    70033,  0.59, 'stn_ctb', 'Tabela 3'),
  (2025, 'municipios',    'iptu',    77024,  0.60, 'stn_ctb', 'Tabela 3'),
  (2024, 'municipios',    'itbi',    24364,  0.21, 'stn_ctb', 'Tabela 3'),
  (2025, 'municipios',    'itbi',    26559,  0.21, 'stn_ctb', 'Tabela 3'),
  (2024, 'estados',       'iss',      3459,  0.03, 'stn_ctb', 'Tabela 3'),
  (2025, 'estados',       'iss',      3844,  0.03, 'stn_ctb', 'Tabela 3'),
  (2024, 'estados',       'iptu',     1286,  0.01, 'stn_ctb', 'Tabela 3'),
  (2025, 'estados',       'iptu',     1325,  0.01, 'stn_ctb', 'Tabela 3'),
  (2024, 'estados',       'itbi',      618,  0.01, 'stn_ctb', 'Tabela 3'),
  (2025, 'estados',       'itbi',      477,  0.00, 'stn_ctb', 'Tabela 3');

-- As esferas somam o governo geral (diferença de arredondamento até R$ 1 milhão).
do $$
declare
  v_ano smallint;
  v_dif numeric;
begin
  for v_ano, v_dif in
    select ano, sum(valor_milhoes) filter (where esfera <> 'governo_geral') - sum(valor_milhoes) filter (where esfera = 'governo_geral')
      from ref.carga_tributaria where item = 'total' group by ano
  loop
    if abs(v_dif) > 1 then
      raise exception 'Carga tributária de %: esferas não somam o total (diferença de % milhões)', v_ano, v_dif;
    end if;
  end loop;
end
$$;

create function etl.painel_carga_tributaria()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with anos as (select distinct ano from ref.carga_tributaria)
  select jsonb_build_object(
    'fonte_url', (select url_documentacao from ref.fonte where id = 'stn_ctb'),
    'anos', (select jsonb_agg(ano order by ano) from anos),
    'itens', (select jsonb_object_agg(x.chave, x.valores)
                from (select c.esfera || '_' || c.item as chave,
                             jsonb_build_object(
                               'milhoes', jsonb_agg(c.valor_milhoes order by c.ano),
                               'pct_pib', jsonb_agg(c.pct_pib order by c.ano)) as valores
                        from ref.carga_tributaria c
                       group by c.esfera, c.item) x))
$$;

alter function etl.painel_blocos_extras() rename to painel_blocos_extras_v6;

create function etl.painel_blocos_extras()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select etl.painel_blocos_extras_v6()
         || jsonb_build_object('capitais_receita', etl.painel_receita_capitais(),
                               'carga_tributaria', etl.painel_carga_tributaria())
$$;
