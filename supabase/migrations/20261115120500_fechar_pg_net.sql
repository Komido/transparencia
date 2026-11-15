-- Tentativa de fechar o esquema net (pg_net) para os papéis anon e
-- authenticated.
--
-- Resultado: SEM EFEITO. O esquema e as funções pertencem ao papel interno
-- supabase_admin, que concedeu os acessos (inclusive a PUBLIC). O papel
-- postgres não pode revogar concessões feitas por outro papel. A migração foi
-- mantida para registrar a tentativa.
--
-- Risco residual: o esquema net não está exposto pela API REST nem pelo
-- GraphQL do projeto, então visitantes não conseguem chamá-lo. Não adicione
-- "net" à lista de esquemas expostos nas configurações da API.
revoke usage on schema net from anon, authenticated;
revoke execute on all functions in schema net from anon, authenticated;
