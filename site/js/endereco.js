// Endereço próprio de cada cidade: /nome-uf, sem acento e em minúsculas
// ("Olho d'Água das Flores" (AL) -> /olho-d-agua-das-flores-al). Usado pelo
// site e pelo Worker (worker/index.js), para os dois gerarem o mesmo
// endereço. Não há duas cidades com o mesmo nome no mesmo estado, e nenhuma
// outra página do site termina em hífen e sigla de estado.
export const UFS = ['ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms', 'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'sp', 'se', 'to'];

export function slugDaCidade(nome, uf) {
  const base = String(nome).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base}-${String(uf).toLowerCase()}`;
}

export const caminhoDaCidade = (nome, uf) => `/${slugDaCidade(nome, uf)}`;

const CAMINHO = new RegExp(`^/(?:cidade/)?([a-z0-9]+(?:-[a-z0-9]+)*-(?:${UFS.join('|')}))/?$`);

// /fama-mg (ou o antigo /cidade/fama-mg) -> "fama-mg"; outro caminho -> null.
export function slugDoCaminho(caminho) {
  const m = CAMINHO.exec(caminho);
  return m ? m[1] : null;
}
