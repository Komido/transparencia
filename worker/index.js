// Única parte do site que roda no servidor. Os arquivos de site/ são
// entregues direto pela Cloudflare, sem passar por aqui; este código só roda
// nos endereços listados em "run_worker_first" (wrangler.jsonc):
//
//   /api/onde        cidade e estado prováveis de quem acessa, pelo que a
//                    própria Cloudflare já sabe do endereço IP (request.cf),
//                    para o site perguntar "Você está em ...?". Nada é
//                    guardado nem registrado, e nada vai para outro serviço.
//   /cidade/nome-uf  a página de cada cidade (cidade.html), com título,
//                    descrição, manchete e endereço da cidade, para que ela
//                    possa ser encontrada em buscadores e compartilhada.
//                    Os números são montados no navegador (js/cidade.js).
//   /parlamentar/nome-uf  o mesmo, para cada deputado e senador
//                    (parlamentar.html).
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

// Parlamentares: dados/parlamentares/indice.json, lido uma vez por instância.
let parlamentaresEmCache = null;

async function parlamentares(env, url) {
  if (parlamentaresEmCache) return parlamentaresEmCache;
  const r = await env.ASSETS.fetch(new Request(new URL('/dados/parlamentares/indice.json', url)));
  if (!r.ok) throw new Error(`índice de parlamentares: HTTP ${r.status}`);
  const d = await r.json();
  const porEndereco = new Map();
  for (const p of d.parlamentares ?? []) {
    if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') {
      porEndereco.set(p[0], { nome: p[1], casa: p[2], partido: p[3], uf: p[4] });
    }
  }
  parlamentaresEmCache = { porEndereco, atualizado: /^\d{4}-\d{2}-\d{2}$/.test(d.atualizado ?? '') ? d.atualizado : null };
  return parlamentaresEmCache;
}

const CASA = { camara: 'Câmara dos Deputados', senado: 'Senado' };

const reais = (v) => (v >= 1e6
  ? `R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(v / 1e6)} milhões`
  : `R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(v)}`);

// resumo: { pago, cidades, de, ate } das emendas, em valores da época.
export function textosDoParlamentar(p, endereco, origem, resumo) {
  const sigla = p.uf ? ` (${p.partido ? `${p.partido}-` : ''}${p.uf})` : '';
  const numeros = resumo && resumo.pago > 0
    ? `De ${resumo.de} a ${resumo.ate}, as emendas individuais de ${p.nome} somaram ${reais(resumo.pago)} pagos (valores da época)${resumo.cidades ? `, para ${resumo.cidades} ${resumo.cidades === 1 ? 'cidade' : 'cidades'}` : ''}. `
    : '';
  return {
    titulo: `${p.nome}${sigla}: emendas e cota parlamentar · Arrecadômetro Brasil`,
    tituloCurto: p.nome,
    descricao: `${numeros}Para onde ${p.nome}${CASA[p.casa] ? ` (${CASA[p.casa]})` : ''} mandou emendas parlamentares, quais cidades receberam e quanto gastou da cota, com dados oficiais.`,
    endereco: `${origem}/parlamentar/${endereco}`,
  };
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

function naoEncontrada(oQue = 'Cidade não encontrada', texto = 'Este endereço não corresponde a nenhuma das 5.570 cidades do país.', link = 'Escolher a cidade') {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapar(oQue)} | Arrecadômetro Brasil</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/estilo.css">
</head>
<body>
  <main class="conteiner">
    <div class="abertura">
      <h1>${escapar(oQue)}</h1>
      <p>${escapar(texto)} <a href="/">${escapar(link)}</a></p>
    </div>
  </main>
</body>
</html>
`;
  return new Response(html, { status: 404, headers: comCabecalhos({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }) });
}

async function paginaDoParlamentar(request, env, url) {
  const m = /^\/parlamentar\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(url.pathname.toLowerCase());
  const naoAchou = () => naoEncontrada('Parlamentar não encontrado', 'Este endereço não corresponde a nenhum deputado federal ou senador com emendas ou cota desde 2023.', 'Voltar ao início');
  if (!m) return naoAchou();
  const certo = `/parlamentar/${m[1]}`;
  if (url.pathname !== certo) return Response.redirect(`${url.origin}${certo}${url.search}`, 301);
  const { porEndereco } = await parlamentares(env, url);
  const p = porEndereco.get(m[1]);
  if (!p) return naoAchou();
  // Resumo das emendas para a descrição (buscadores e prévia ao compartilhar).
  let resumo = null;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(`/dados/parlamentares/emendas/${m[1]}.json`, url)));
    if (r.ok) {
      const d = await r.json();
      const anos = Object.keys(d.anos ?? {}).sort();
      const cidades = new Set(anos.flatMap((a) => (d.anos[a].cidades ?? []).map((c) => c[0])));
      resumo = { pago: anos.reduce((s, a) => s + (d.anos[a].pago ?? 0), 0), cidades: cidades.size, de: anos[0], ate: anos[anos.length - 1] };
    }
  } catch { /* sem o resumo, a descrição sai sem números */ }
  return reescrever(request, env, url, textosDoParlamentar(p, m[1], url.origin, resumo), '/parlamentar');
}

async function paginaDaCidade(request, env, url) {
  // /cidade/ sem nome: a página de busca de cidade (cidade.html sozinha).
  if (url.pathname === '/cidade/') return Response.redirect(`${url.origin}/cidade${url.search}`, 301);
  const slug = slugDoCaminho(url.pathname.toLowerCase());
  if (!slug) return naoEncontrada();
  // Um endereço só por cidade: sem barra no fim e em minúsculas.
  const certo = `/cidade/${slug}`;
  if (url.pathname !== certo) return Response.redirect(`${url.origin}${certo}${url.search}`, 301);
  const { porSlug } = await cidades(env, url);
  const c = porSlug.get(slug);
  if (!c) return naoEncontrada();
  return reescrever(request, env, url, textosDaCidade(c, url.origin), '/cidade');
}

// Uma página do site (cidade.html ou parlamentar.html) com título,
// descrição, manchete e endereço próprios.
async function reescrever(request, env, url, t, modelo) {
  const base = await env.ASSETS.fetch(new Request(new URL(modelo, url)));
  if (!base.ok) return base;
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
  let deputados = [];
  try {
    deputados = [...(await parlamentares(env, url)).porEndereco.keys()].map((e) => `${url.origin}/parlamentar/${e}`);
  } catch { /* sem a lista de parlamentares, o mapa sai só com as cidades */ }
  const enderecos = [`${url.origin}/`, `${url.origin}/metodologia.html`, ...[...porSlug.keys()].map((s) => `${url.origin}/cidade/${s}`), ...deputados];
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
    if (url.pathname.toLowerCase().startsWith('/parlamentar/')) return paginaDoParlamentar(request, env, url);
    if (url.pathname === '/sitemap.xml') return mapaDoSite(env, url);
    if (url.pathname === '/robots.txt') return regrasParaBuscadores(url);
    // Qualquer outro endereço que não é arquivo: a mesma resposta de antes (404).
    return env.ASSETS.fetch(request);
  },
};
