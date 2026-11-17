// Endereço próprio de cada cidade: /cidade/nome-uf, sem acento e em
// minúsculas ("Olho d'Água das Flores" (AL) -> /cidade/olho-d-agua-das-flores-al).
// Usado pelo site e pelo Worker (worker/index.js), para os dois gerarem o
// mesmo endereço. Não há duas cidades com o mesmo nome no mesmo estado.
export function slugDaCidade(nome, uf) {
  const base = String(nome).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base}-${String(uf).toLowerCase()}`;
}

export const caminhoDaCidade = (nome, uf) => `/cidade/${slugDaCidade(nome, uf)}`;

// /cidade/fama-mg -> "fama-mg"; outro caminho -> null.
export function slugDoCaminho(caminho) {
  const m = /^\/cidade\/([a-z0-9]+(?:-[a-z0-9]+)*-[a-z]{2})\/?$/.exec(caminho);
  return m ? m[1] : null;
}
