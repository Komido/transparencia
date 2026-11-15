-- O Arrecadômetro Brasil não tem contas de usuário. Com o repositório
-- público, a chave pública (publishable) fica visível, e ela permitiria
-- chamar o cadastro do Supabase Auth. Este gatilho recusa qualquer
-- inclusão em auth.users, venha de onde vier.
--
-- Para reverter, se um dia o projeto precisar de login:
--   drop trigger bloquear_cadastros on auth.users;

create function etl.recusar_cadastro()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Cadastros desativados: este projeto não usa contas de usuário.'
    using errcode = 'insufficient_privilege';
end
$$;

create trigger bloquear_cadastros
  before insert on auth.users
  for each statement
  execute function etl.recusar_cadastro();
