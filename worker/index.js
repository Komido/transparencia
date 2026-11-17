// Única parte do site que roda no servidor. Os arquivos de site/ são
// entregues direto pela Cloudflare, sem passar por aqui; este código só roda
// nos endereços listados em "run_worker_first" (wrangler.jsonc):
//
//   /api/onde        cidade e estado prováveis de quem acessa, pelo que a
//                    própria Cloudflare já sabe do endereço IP (request.cf),
//                    para o site perguntar "Você está em ...?". Nada é
//                    guardado nem registrado, e nada vai para outro serviço.
//   /cidade/nome-uf  a página de cada cidade: a mesma página inicial, com
//                    título, descrição e endereço da cidade, para que ela
//                    possa ser encontrada em buscadores e compartilhada.
//                    Os números continuam sendo montados no navegador.
//   /sitemap.xml     a lista das páginas, para os buscadores.
//   /robots.txt      as regras para os buscadores.
//
// No plano gratuito, são até 100 mil execuções por dia; acima disso, só
// esses endereços param até a meia-noite (UTC). A página inicial e os dados
// não dependem deste código.

import { slugDaCidade, slugDoCaminho } from '../site/js/endereco.js';

// Os mesmos cabeçalhos de segurança de site/_headers, que a Cloudflare não
// aplica às respostas montadas aqui. Mudou lá, muda aqui.
const SEGURANCA = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const comCabecalhos = (extra) => new Headers({ ...SEGURANCA, ...extra });

// Texto para dentro de HTML.
const escapar = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// /api/onde

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

// ---------------------------------------------------------------------------
// Cidades: o índice do site (dados/municipios/indice.json), lido uma vez por
// instância do Worker.

let cidadesEmCache = null;

async function cidades(env, url) {
  if (cidadesEmCache) return cidadesEmCache;
  const r = await env.ASSETS.fetch(new Request(new URL('/dados/municipios/indice.json', url)));
  if (!r.ok) throw new Error(`índice de cidades: HTTP ${r.status}`);
  const d = await r.json();
  const porSlug = new Map();
  for (const c of d.cidades ?? []) {
    if (!Array.isArray(c) || !Number.isInteger(c[0]) || typeof c[1] !== 'string' || !/^[A-Z]{2}$/.test(c[2] ?? '')) continue;
    porSlug.set(slugDaCidade(c[1], c[2]), { codigo: String(c[0]).padStart(7, '0'), nome: c[1], uf: c[2] });
  }
  if (porSlug.size < 5000) throw new Error(`índice de cidades com ${porSlug.size} cidades`);
  cidadesEmCache = { porSlug, atualizado: /^\d{4}-\d{2}-\d{2}$/.test(d.atualizado ?? '') ? d.atualizado : null };
  return cidadesEmCache;
}

export function textosDaCidade(c, origem) {
  const lugar = `${c.nome} (${c.uf})`;
  return {
    titulo: `${lugar}: contas da prefeitura, emendas e Bolsa Família | Arrecadômetro Brasil`,
    tituloCurto: `O dinheiro público de ${lugar}`,
    descricao: `Quanto a prefeitura de ${lugar} recebe e gasta, as emendas parlamentares pagas a ela, o Bolsa Família e o BPC na cidade e quem foi eleito, com dados oficiais e em linguagem simples.`,
    endereco: `${origem}/cidade/${slugDaCidade(c.nome, c.uf)}`,
  };
}

function naoEncontrada() {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Cidade não encontrada | Arrecadômetro Brasil</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/estilo.css">
</head>
<body>
  <main class="conteiner">
    <div class="abertura">
      <h1>Cidade não encontrada</h1>
      <p>Este endereço não corresponde a nenhuma das 5.570 cidades do país. <a href="/">Escolher a cidade</a></p>
    </div>
  </main>
</body>
</html>
`;
  return new Response(html, { status: 404, headers: comCabecalhos({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }) });
}

async function paginaDaCidade(request, env, url) {
  const slug = slugDoCaminho(url.pathname.toLowerCase());
  if (!slug) return naoEncontrada();
  // Um endereço só por cidade: sem barra no fim e em minúsculas.
  const certo = `/cidade/${slug}`;
  if (url.pathname !== certo) return Response.redirect(`${url.origin}${certo}${url.search}`, 301);
  const { porSlug } = await cidades(env, url);
  const c = porSlug.get(slug);
  if (!c) return naoEncontrada();
  const base = await env.ASSETS.fetch(new Request(new URL('/', url)));
  if (!base.ok) return base;
  const t = textosDaCidade(c, url.origin);
  const pagina = new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(t.titulo); } })
    .on('meta[name="description"]', { element(e) { e.setAttribute('content', t.descricao); } })
    .on('meta[property="og:title"]', { element(e) { e.setAttribute('content', t.tituloCurto); } })
    .on('meta[property="og:description"]', { element(e) { e.setAttribute('content', t.descricao); } })
    .on('head', {
      element(e) {
        e.append(`<link rel="canonical" href="${escapar(t.endereco)}">\n<meta property="og:url" content="${escapar(t.endereco)}">\n`, { html: true });
      },
    })
    .on('h1', { element(e) { e.setInnerContent(t.tituloCurto); } })
    .transform(base);
  return new Response(request.method === 'HEAD' ? null : pagina.body, {
    status: 200,
    headers: comCabecalhos({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }),
  });
}

// ---------------------------------------------------------------------------
// Buscadores

async function mapaDoSite(env, url) {
  const { porSlug, atualizado } = await cidades(env, url);
  const quando = atualizado ? `<lastmod>${atualizado}</lastmod>` : '';
  const enderecos = [`${url.origin}/`, `${url.origin}/metodologia.html`, ...[...porSlug.keys()].map((s) => `${url.origin}/cidade/${s}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    enderecos.map((e) => `<url><loc>${escapar(e)}</loc>${quando}</url>`).join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: comCabecalhos({ 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' }) });
}

function regrasParaBuscadores(url) {
  const texto = `User-agent: *\nDisallow: /api/\n\nSitemap: ${url.origin}/sitemap.xml\n`;
  return new Response(texto, { headers: comCabecalhos({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' }) });
}

// ---------------------------------------------------------------------------

const CABECALHOS_API = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/api/onde') return new Response(JSON.stringify(onde(request.cf)), { headers: CABECALHOS_API });
    if (url.pathname.toLowerCase().startsWith('/cidade/')) return paginaDaCidade(request, env, url);
    if (url.pathname === '/sitemap.xml') return mapaDoSite(env, url);
    if (url.pathname === '/robots.txt') return regrasParaBuscadores(url);
    // Qualquer outro endereço que não é arquivo: a mesma resposta de antes (404).
    return env.ASSETS.fetch(request);
  },
};
