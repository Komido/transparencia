-- Esquema do Arrecadômetro Brasil.
--
-- Princípio de segurança: nenhum destes esquemas é exposto pela API REST do
-- Supabase (só "public" é). O único ponto de leitura pública é a função
-- public.painel(), criada em outra migração, que devolve o JSON já pronto.
-- Ninguém de fora consegue gravar nada: não há políticas de escrita.

create schema if not exists ref;     -- referências: fontes, séries, mandatos, tabela do IR
create schema if not exists dados;   -- observações coletadas das fontes oficiais
create schema if not exists etl;     -- controle e auditoria das coletas
create schema if not exists painel;  -- JSON publicado para o site

revoke all on schema ref, dados, etl, painel from public;
revoke all on schema ref, dados, etl, painel from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Referências
-- ---------------------------------------------------------------------------

create table ref.fonte (
  id               text primary key,
  nome             text not null,
  orgao            text not null,
  url_documentacao text not null,
  observacao       text
);

create table ref.serie (
  id             text primary key,
  nome           text not null,
  unidade        text not null,
  fonte_id       text not null references ref.fonte (id),
  codigo_origem  text,
  observacao     text
);

-- Endereços consultados pela coleta automática.
create table ref.coleta (
  id        text primary key,
  fonte_id  text not null references ref.fonte (id),
  url       text not null check (url like 'https://%'),
  formato   text not null check (formato in ('sgs_json', 'bls_json', 'rfb_csv', 'dieese_html')),
  serie_id  text references ref.serie (id),
  ativa     boolean not null default true,
  check ((formato = 'rfb_csv') = (serie_id is null))
);

-- Períodos de exercício da Presidência. A regra de atribuição está em
-- site/js/calculos.js e na página de metodologia; é a mesma para todos.
create table ref.mandato (
  id          text primary key,
  ordem       smallint not null unique,
  cargo       text not null check (cargo in ('presidente')),
  nome        text not null,
  rotulo      text not null,
  partido     text not null,
  inicio      date not null,
  fim         date,
  observacao  text,
  fonte_url   text not null,
  check (fim is null or fim >= inicio)
);

-- Colunas do CSV de arrecadação da Receita Federal, pela posição.
-- "fragmento_cabecalho" é conferido a cada coleta: se a Receita mudar o
-- layout do arquivo, a carga é recusada em vez de gravar dados trocados.
create table ref.rubrica_receita (
  posicao              smallint primary key check (posicao between 4 and 60),
  nome                 text not null,
  fragmento_cabecalho  text not null,
  grupo                text not null,
  serie_comparavel     boolean not null
);

-- Tabela mensal do IRPF: faixa isenta e isenção efetiva.
create table ref.ir_tabela (
  vigencia_inicio        date primary key check (extract(day from vigencia_inicio) = 1),
  limite_tabela          numeric(10, 2) not null check (limite_tabela > 0),
  desconto_simplificado  numeric(10, 2),
  isencao_efetiva        numeric(10, 2) not null check (isencao_efetiva >= limite_tabela),
  norma                  text not null,
  fonte_url              text not null,
  conferido_na_fonte     boolean not null,
  observacao             text
);

-- ---------------------------------------------------------------------------
-- Controle das coletas
-- ---------------------------------------------------------------------------

create table etl.carga (
  id             bigint generated always as identity primary key,
  coleta_id      text not null references ref.coleta (id),
  url            text not null,
  requisicao_id  bigint,
  solicitada_em  timestamptz not null default now(),
  processada_em  timestamptz,
  status         text not null default 'pendente'
                 check (status in ('pendente', 'ok', 'sem_mudanca', 'erro')),
  http_status    integer,
  bytes          integer,
  sha256         text,
  linhas         integer,
  mensagem       text
);

create index carga_coleta_idx on etl.carga (coleta_id, id desc);
create index carga_pendente_idx on etl.carga (status) where status = 'pendente';

-- ---------------------------------------------------------------------------
-- Dados
-- ---------------------------------------------------------------------------

create table dados.observacao (
  serie_id  text not null references ref.serie (id),
  periodo   date not null check (extract(day from periodo) = 1),
  valor     numeric not null,
  carga_id  bigint not null references etl.carga (id),
  primary key (serie_id, periodo)
);

create table dados.arrecadacao_federal (
  periodo   date not null check (extract(day from periodo) = 1),
  uf        text not null check (uf ~ '^[A-Z]{2}$'),
  posicao   smallint not null references ref.rubrica_receita (posicao),
  valor     numeric not null,
  carga_id  bigint not null references etl.carga (id),
  primary key (periodo, uf, posicao)
);

create index arrecadacao_posicao_idx on dados.arrecadacao_federal (posicao, periodo);

-- ---------------------------------------------------------------------------
-- Painel publicado
-- ---------------------------------------------------------------------------

create table painel.snapshot (
  id         smallint primary key default 1 check (id = 1),
  gerado_em  timestamptz not null,
  sha256     text not null,
  dados      jsonb not null
);

-- Histórico de todas as versões publicadas (transparência sobre correções).
create table painel.versao (
  id         bigint generated always as identity primary key,
  gerado_em  timestamptz not null,
  sha256     text not null unique,
  dados      jsonb not null
);

-- ---------------------------------------------------------------------------
-- RLS em todas as tabelas. Sem políticas = ninguém de fora lê ou grava.
-- A única política é a leitura do snapshot, usada pela função pública.
-- ---------------------------------------------------------------------------

alter table ref.fonte                 enable row level security;
alter table ref.serie                 enable row level security;
alter table ref.coleta                enable row level security;
alter table ref.mandato               enable row level security;
alter table ref.rubrica_receita       enable row level security;
alter table ref.ir_tabela             enable row level security;
alter table etl.carga                 enable row level security;
alter table dados.observacao          enable row level security;
alter table dados.arrecadacao_federal enable row level security;
alter table painel.snapshot           enable row level security;
alter table painel.versao             enable row level security;

grant usage on schema painel to anon, authenticated;
grant select on painel.snapshot to anon, authenticated;

create policy leitura_publica_snapshot on painel.snapshot
  for select to anon, authenticated
  using (true);
