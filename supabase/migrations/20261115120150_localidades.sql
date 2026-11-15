-- Localidades: Brasil, UFs e (numa fase seguinte) municípios, pelos códigos do IBGE.
-- Prepara o banco para o portal mostrar país, estado e cidade com o mesmo modelo.

create table ref.localidade (
  id        text primary key,  -- 'BR', código IBGE da UF (2 dígitos) ou do município (7 dígitos)
  nivel     text not null check (nivel in ('pais', 'uf', 'municipio')),
  nome      text not null,
  uf_sigla  text check (uf_sigla ~ '^[A-Z]{2}$'),
  uf_id     text references ref.localidade (id),
  regiao    text,
  check (
       (nivel = 'pais'      and id = 'BR'            and uf_sigla is null     and uf_id is null)
    or (nivel = 'uf'        and id ~ '^[0-9]{2}$'    and uf_sigla is not null and uf_id is null)
    or (nivel = 'municipio' and id ~ '^[0-9]{7}$'    and uf_id is not null)
  )
);

create unique index localidade_uf_sigla_idx on ref.localidade (uf_sigla) where nivel = 'uf';
create index localidade_uf_idx on ref.localidade (uf_id) where nivel = 'municipio';
alter table ref.localidade enable row level security;

-- Códigos e nomes conforme a API de localidades do IBGE
-- (https://servicodados.ibge.gov.br/api/v1/localidades/estados).
insert into ref.localidade (id, nivel, nome, uf_sigla, regiao) values
  ('BR', 'pais', 'Brasil', null, null),
  ('11', 'uf', 'Rondônia', 'RO', 'Norte'),
  ('12', 'uf', 'Acre', 'AC', 'Norte'),
  ('13', 'uf', 'Amazonas', 'AM', 'Norte'),
  ('14', 'uf', 'Roraima', 'RR', 'Norte'),
  ('15', 'uf', 'Pará', 'PA', 'Norte'),
  ('16', 'uf', 'Amapá', 'AP', 'Norte'),
  ('17', 'uf', 'Tocantins', 'TO', 'Norte'),
  ('21', 'uf', 'Maranhão', 'MA', 'Nordeste'),
  ('22', 'uf', 'Piauí', 'PI', 'Nordeste'),
  ('23', 'uf', 'Ceará', 'CE', 'Nordeste'),
  ('24', 'uf', 'Rio Grande do Norte', 'RN', 'Nordeste'),
  ('25', 'uf', 'Paraíba', 'PB', 'Nordeste'),
  ('26', 'uf', 'Pernambuco', 'PE', 'Nordeste'),
  ('27', 'uf', 'Alagoas', 'AL', 'Nordeste'),
  ('28', 'uf', 'Sergipe', 'SE', 'Nordeste'),
  ('29', 'uf', 'Bahia', 'BA', 'Nordeste'),
  ('31', 'uf', 'Minas Gerais', 'MG', 'Sudeste'),
  ('32', 'uf', 'Espírito Santo', 'ES', 'Sudeste'),
  ('33', 'uf', 'Rio de Janeiro', 'RJ', 'Sudeste'),
  ('35', 'uf', 'São Paulo', 'SP', 'Sudeste'),
  ('41', 'uf', 'Paraná', 'PR', 'Sul'),
  ('42', 'uf', 'Santa Catarina', 'SC', 'Sul'),
  ('43', 'uf', 'Rio Grande do Sul', 'RS', 'Sul'),
  ('50', 'uf', 'Mato Grosso do Sul', 'MS', 'Centro-Oeste'),
  ('51', 'uf', 'Mato Grosso', 'MT', 'Centro-Oeste'),
  ('52', 'uf', 'Goiás', 'GO', 'Centro-Oeste'),
  ('53', 'uf', 'Distrito Federal', 'DF', 'Centro-Oeste');

-- Observações passam a ser por localidade (hoje tudo é 'BR').
alter table dados.observacao
  add column localidade_id text not null default 'BR' references ref.localidade (id);
alter table dados.observacao drop constraint observacao_pkey;
alter table dados.observacao add primary key (serie_id, localidade_id, periodo);

-- Mandatos de presidente, governador e prefeito, com a mesma regra de atribuição.
alter table ref.mandato
  add column localidade_id text not null default 'BR' references ref.localidade (id);
alter table ref.mandato drop constraint mandato_cargo_check;
alter table ref.mandato
  add constraint mandato_cargo_check check (cargo in ('presidente', 'governador', 'prefeito'));
alter table ref.mandato drop constraint mandato_ordem_key;
alter table ref.mandato
  add constraint mandato_ordem_unica unique (localidade_id, cargo, ordem);
