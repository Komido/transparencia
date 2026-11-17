// Única parte do site que roda no servidor: responde em /api/onde a cidade e
// o estado prováveis de quem acessa, pelo que a própria Cloudflare já sabe do
// endereço IP de cada acesso (request.cf). Serve só para o site sugerir
// "Você está em ...?"; a pessoa confirma ou escolhe outra cidade.
//
// Nada é guardado nem registrado, e nada vai para outro serviço. Os arquivos
// do site (pasta site/) são entregues direto pela Cloudflare, sem passar por
// aqui: este código só roda para endereços que não são arquivos.

const CABECALHOS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

// Só letras, espaço, apóstrofo, hífen e ponto ("Olho d'Água das Flores").
const limpo = (v, max) => (typeof v === 'string' && v.length <= max && /^[\p{L}\p{M}' .-]+$/u.test(v) ? v : null);

export function onde(cf) {
  const pais = limpo(cf?.country, 2);
  if (pais !== 'BR') return { pais, uf: null, cidade: null };
  const uf = limpo(cf?.regionCode, 2);
  return {
    pais,
    uf: uf && /^[A-Z]{2}$/.test(uf) ? uf : null,
    cidade: limpo(cf?.city, 80),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/onde') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { ...CABECALHOS, allow: 'GET, HEAD' } });
      }
      return new Response(JSON.stringify(onde(request.cf)), { headers: CABECALHOS });
    }
    // Qualquer outro endereço que não é arquivo: a mesma resposta de antes (404).
    return env.ASSETS.fetch(request);
  },
};
