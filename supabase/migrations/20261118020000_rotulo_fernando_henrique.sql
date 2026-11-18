-- Regra do site: nenhuma sigla sem explicação. O rótulo curto dos mandatos de
-- Fernando Henrique Cardoso deixa de ser a sigla "FHC" e passa a ser o nome
-- pelo qual ele é conhecido, como já acontece com Lula, Dilma e os outros.
-- Conferido em 18/11/2026: "Fernando Henrique" cabe nas faixas dos gráficos
-- no celular (390 px).
update ref.mandato set rotulo = 'Fernando Henrique 1' where id = 'fhc1';
update ref.mandato set rotulo = 'Fernando Henrique 2' where id = 'fhc2';
