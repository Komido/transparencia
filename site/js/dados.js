// Carrega o painel publicado e confere o formato antes de usar.
// Se algo não bater, a página mostra um erro em vez de números errados.

const SERIES_OBRIGATORIAS = ['ipca_var', 'inpc_var', 'salario_minimo', 'dolar_ptax', 'pib_mensal', 'cpi_eua', 'smn_dieese'];

const ehMes = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const ehData = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const ehNumeroOuNulo = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const ehTexto = (v) => typeof v === 'string' && v.length > 0;
export const ehLinkSeguro = (v) => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v);

function falhar(motivo) {
  throw new Error(`Dados em formato inesperado: ${motivo}`);
}

function quantidadeDeMeses(inicio, fim) {
  const [ai, mi] = inicio.split('-').map(Number);
  const [af, mf] = fim.split('-').map(Number);
  return (af - ai) * 12 + (mf - mi) + 1;
}

export function validarPainel(d) {
  if (!d || typeof d !== 'object' || d.esquema !== 1) falhar('versão do esquema');
  if (!ehTexto(d.versao)) falhar('versão dos dados');
  const m = d.mensal;
  if (!m || !ehMes(m.inicio) || !ehMes(m.fim)) falhar('período mensal');
  const n = quantidadeDeMeses(m.inicio, m.fim);
  if (n < 12 || n > 2000) falhar('tamanho do período');

  for (const id of SERIES_OBRIGATORIAS) {
    if (!Array.isArray(m.series?.[id])) falhar(`série ${id} ausente`);
  }
  // Toda série presente, obrigatória ou não, precisa ter o tamanho certo.
  for (const [id, s] of Object.entries(m.series ?? {})) {
    if (!Array.isArray(s) || s.length !== n || !s.every(ehNumeroOuNulo)) falhar(`série ${id}`);
  }
  if (!Array.isArray(m.arrecadacao_grupos) || m.arrecadacao_grupos.length === 0) falhar('grupos de arrecadação');
  for (const g of m.arrecadacao_grupos) {
    if (!ehTexto(g.grupo) || typeof g.comparavel !== 'boolean') falhar('grupo de arrecadação');
    if (!Array.isArray(g.valores) || g.valores.length !== n || !g.valores.every(ehNumeroOuNulo)) falhar(`valores de ${g.grupo}`);
  }

  if (!Array.isArray(d.mandatos) || d.mandatos.length === 0) falhar('mandatos');
  for (const g of d.mandatos) {
    if (!ehTexto(g.id) || !ehTexto(g.rotulo) || !ehTexto(g.partido) || !ehData(g.inicio)) falhar('mandato');
    if (g.fim !== null && !ehData(g.fim)) falhar('fim de mandato');
  }

  if (!Array.isArray(d.ir_tabela) || d.ir_tabela.length === 0) falhar('tabela do IR');
  for (const t of d.ir_tabela) {
    if (!ehMes(t.inicio) || !ehNumeroOuNulo(t.isencao_efetiva) || !ehNumeroOuNulo(t.limite_tabela)) falhar('linha da tabela do IR');
  }

  // Links vindos dos dados só entram na página se forem https.
  d.fontes = (d.fontes ?? []).filter((x) => ehTexto(x.nome) && ehLinkSeguro(x.url));
  d.series = (d.series ?? []).filter((x) => ehTexto(x.id) && ehTexto(x.nome));
  d.avisos = Array.isArray(d.avisos) ? d.avisos.filter((a) => ehTexto(a.tipo)) : [];
  d.coletas = Array.isArray(d.coletas) ? d.coletas.filter((k) => ehTexto(k.id)) : [];
  return d;
}

export async function carregarPainel(url = 'dados/painel.json') {
  const resposta = await fetch(url, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar os dados (HTTP ${resposta.status})`);
  return validarPainel(await resposta.json());
}

// Índice das capitais com números próprios: [{codigo, nome, uf, aluguel}].
export async function carregarIndiceCidades(url = 'dados/cidades/indice.json') {
  const resposta = await fetch(url, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar as cidades (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || !Array.isArray(d.cidades)) falhar('índice de cidades');
  return d.cidades.filter((x) => /^[0-9]{7}$/.test(x?.codigo) && ehTexto(x.nome) && /^[A-Z]{2}$/.test(x.uf));
}

// Números de uma capital. As séries precisam ter o mesmo tamanho das séries
// do painel (n meses), para usar o mesmo eixo de tempo.
export function validarCidade(c, codigo, n) {
  if (!c || c.codigo !== codigo || !ehTexto(c.nome) || !/^[A-Z]{2}$/.test(c.uf)) falhar('cidade');
  if (!c.series || typeof c.series !== 'object') falhar('séries da cidade');
  for (const [id, s] of Object.entries(c.series)) {
    if (!Array.isArray(s) || s.length !== n || !s.every(ehNumeroOuNulo)) falhar(`série ${id} da cidade`);
  }
  if (!Array.isArray(c.pof)) falhar('POF da cidade');
  for (const cl of c.pof) {
    if (!Number.isInteger(cl.codigo) || !ehNumeroOuNulo(cl.renda_ate ?? null)) falhar('faixa da POF da cidade');
    if (cl.itens != null && !Object.values(cl.itens).every(ehNumeroOuNulo)) falhar('itens da POF da cidade');
  }
  return c;
}

export async function carregarCidade(codigo, n) {
  if (!/^[0-9]{7}$/.test(codigo)) falhar('código da cidade');
  const resposta = await fetch(`dados/cidades/${codigo}.json`, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar a cidade (HTTP ${resposta.status})`);
  return validarCidade(await resposta.json(), codigo, n);
}
