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
  // Quando chegou o último número de cada série (bloco "O que chegou de novo").
  const at = d.atualizacoes && typeof d.atualizacoes === 'object' ? d.atualizacoes : {};
  d.atualizacoes = Object.fromEntries(Object.entries(at).filter(([, a]) => a && ehMes(a.periodo)
    && typeof a.coletado_em === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(a.coletado_em)
    && typeof a.primeira_carga === 'boolean'));
  return d;
}

export async function carregarPainel(url = '/dados/painel.json') {
  const resposta = await fetch(url, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar os dados (HTTP ${resposta.status})`);
  return validarPainel(await resposta.json());
}

// Índice das capitais com números próprios: [{codigo, nome, uf, aluguel}].
export async function carregarIndiceCidades(url = '/dados/cidades/indice.json') {
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
  const resposta = await fetch(`/dados/cidades/${codigo}.json`, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar a cidade (HTTP ${resposta.status})`);
  return validarCidade(await resposta.json(), codigo, n);
}

// Cota parlamentar: resumo por ano gerado por scripts/cota_para_json.py.
export async function carregarIndiceCota() {
  const resposta = await fetch('/dados/cota/indice.json', { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar a cota parlamentar (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || !Array.isArray(d.anos) || !d.anos.length || !d.anos.every((a) => Number.isInteger(a) && a >= 2000 && a <= 2100)) {
    falhar('índice da cota parlamentar');
  }
  return d;
}

function validarCasa(casa, nGrupos, nome) {
  if (!casa || typeof casa !== 'object' || !Array.isArray(casa.parlamentares)) falhar(`cota: ${nome}`);
  if (!ehNumeroOuNulo(casa.total)) falhar(`cota: total de ${nome}`);
  for (const p of casa.parlamentares) {
    if (!p || !ehTexto(p.id) || !ehTexto(p.nome) || !(p.uf === null || /^[A-Z]{2}$/.test(p.uf))
      || !ehNumeroOuNulo(p.total) || !Number.isInteger(p.meses)
      || !Array.isArray(p.grupos) || p.grupos.length !== nGrupos || !p.grupos.every(ehNumeroOuNulo)
      || !(p.ano_todo == null || typeof p.ano_todo === 'boolean')) {
      falhar(`cota: parlamentar de ${nome}`);
    }
  }
  if (casa.sem_gasto != null) {
    if (!Array.isArray(casa.sem_gasto) || !casa.sem_gasto.every((p) => p && ehTexto(p.nome)
      && (p.ano_todo == null || typeof p.ano_todo === 'boolean'))) falhar(`cota: sem gasto de ${nome}`);
  }
}

export async function carregarCotaAno(ano) {
  if (!Number.isInteger(ano)) falhar('ano da cota');
  const resposta = await fetch(`/dados/cota/${ano}.json`, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar a cota de ${ano} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || d.ano !== ano || !Array.isArray(d.grupos) || !d.grupos.every((g) => g && ehTexto(g.id) && ehTexto(g.nome))) falhar('cota do ano');
  validarCasa(d.camara, d.grupos.length, 'Câmara');
  validarCasa(d.senado, d.grupos.length, 'Senado');
  return d;
}

// Portal da Transparência: cartão, despesa por ministério e viagens, resumidos
// por scripts/portal_para_json.py.
export async function carregarPortal(nome) {
  if (!['cartao', 'ministerios', 'viagens'].includes(nome)) falhar('base do Portal da Transparência');
  const resposta = await fetch(`/dados/portal/${nome}.json`, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar ${nome} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || !Array.isArray(d.anos) || !d.anos.length || !d.anos.every((a) => Number.isInteger(a) && a >= 2000 && a <= 2100)) falhar(`${nome}: anos`);
  if (!Array.isArray(d.orgaos) || !d.orgaos.every((o) => o && ehTexto(o.codigo) && o.nomes && o.valores
    && Object.values(o.valores).every((v) => Array.isArray(v) && v.every(ehNumeroOuNulo)))) falhar(`${nome}: órgãos`);
  if (nome === 'viagens' && (!d.total || !d.natureza_especial)) falhar('viagens: totais');
  if (nome === 'ministerios' && !d.divida) falhar('ministérios: dívida');
  return d;
}

// Contas das prefeituras: resumo por estado gerado por
// scripts/municipios_para_json.py (Tesouro, RREO Anexo 3 de cada prefeitura).
const SITUACOES_PREFEITURA = ['ok', 'nao_fecha', 'sem_relatorio', 'formato', 'erro', 'df'];
const SITUACOES_DESPESA = ['ok', 'nao_fecha', 'formato', 'sem_anexo', 'erro'];
// Mínimos da Constituição (Anexo 14): situação e [percentual, base, mínimo]
// de educação, FUNDEB e saúde, cada um podendo faltar.
const SITUACOES_MINIMOS = ['ok', 'sem_linhas', 'sem_anexo', 'erro'];
// Percentual e base podem vir negativos no relatório (erro de preenchimento:
// base da educação de Santo Antônio do Planalto/RS em 2025); um erro de uma
// prefeitura não pode derrubar o estado inteiro. A página mostra "número fora
// do padrão".
const ehMinimo = (x) => x === null || (Array.isArray(x) && x.length === 3 && Number.isFinite(x[0])
  && (x[1] === null || Number.isFinite(x[1])) && (x[2] === null || Number.isFinite(x[2])));

export async function carregarIndiceMunicipios() {
  const resposta = await fetch('/dados/municipios/indice.json', { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar a lista de cidades (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || !Array.isArray(d.anos) || !d.anos.length || !d.anos.every((a) => Number.isInteger(a) && a >= 2015 && a <= 2100)) falhar('prefeituras: anos');
  if (!Array.isArray(d.campos) || !d.campos.every(ehTexto)) falhar('prefeituras: campos');
  // Despesas por área: opcional (arquivos montados antes das despesas não têm).
  if (d.campos_despesa != null && (!Array.isArray(d.campos_despesa) || !d.campos_despesa.every(ehTexto))) falhar('prefeituras: campos de despesa');
  if (!Array.isArray(d.faixas) || !d.faixas.every((f) => f && ehTexto(f.rotulo) && (f.ate === null || Number.isInteger(f.ate)))) falhar('prefeituras: faixas');
  if (!Array.isArray(d.cidades) || d.cidades.length < 20 || !d.cidades.every((c) => Array.isArray(c) && Number.isInteger(c[0])
    && c[0] >= 1100000 && c[0] <= 5399999 && ehTexto(c[1]) && /^[A-Z]{2}$/.test(c[2]) && Number.isInteger(c[3]))) falhar('prefeituras: cidades');
  return d;
}

export async function carregarMunicipiosUf(uf, nCampos, nDespesa = 0) {
  if (!/^[A-Z]{2}$/.test(uf)) falhar('prefeituras: UF');
  const resposta = await fetch(`/dados/municipios/${uf}.json`, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar as prefeituras de ${uf} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || d.uf !== uf || !Array.isArray(d.municipios)) falhar(`prefeituras de ${uf}`);
  for (const m of d.municipios) {
    if (!m || !Number.isInteger(m.c) || !ehTexto(m.n) || !Number.isInteger(m.p) || !m.a || typeof m.a !== 'object') falhar(`prefeitura de ${uf}`);
    for (const r of Object.values(m.a)) {
      if (!r || !SITUACOES_PREFEITURA.includes(r.s)) falhar(`situação de prefeitura de ${uf}`);
      if (r.v != null && (!Array.isArray(r.v) || r.v.length !== nCampos || !r.v.every(ehNumeroOuNulo))) falhar(`valores de prefeitura de ${uf}`);
      if (r.p != null && !Number.isInteger(r.p)) falhar(`população de prefeitura de ${uf}`);
      if (r.ds != null && !SITUACOES_DESPESA.includes(r.ds)) falhar(`situação das despesas de prefeitura de ${uf}`);
      if (r.d != null && (!nDespesa || !Array.isArray(r.d) || r.d.length !== nDespesa || !r.d.every(ehNumeroOuNulo))) falhar(`despesas de prefeitura de ${uf}`);
      if (r.ms != null && !SITUACOES_MINIMOS.includes(r.ms)) falhar(`situação dos mínimos de prefeitura de ${uf}`);
      if (r.mi != null && (!Array.isArray(r.mi) || r.mi.length !== 3 || !r.mi.every(ehMinimo))) falhar(`mínimos de prefeitura de ${uf}`);
    }
  }
  return d;
}

// Tabelas oficiais de INSS e Imposto de Renda do ano (dados/folha.json).
export async function carregarFolha() {
  const resposta = await fetch('/dados/folha.json', { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar as tabelas do salário (HTTP ${resposta.status})`);
  const d = await resposta.json();
  const faixasOk = (fs, comDeducao) => Array.isArray(fs) && fs.length >= 2 && fs.every((x, i) => x
    && (x.ate === null ? i === fs.length - 1 : typeof x.ate === 'number' && x.ate > 0)
    && typeof x.aliquota === 'number' && x.aliquota >= 0 && x.aliquota < 50
    && (!comDeducao || typeof x.deducao === 'number'));
  if (!d || !Number.isInteger(d.ano) || !ehData(d.conferido_em)) falhar('tabelas do salário: ano');
  if (!d.inss || !faixasOk(d.inss.faixas, false) || !ehLinkSeguro(d.inss.fonte)) falhar('tabela do INSS');
  const ir = d.ir;
  if (!ir || !faixasOk(ir.faixas, true) || typeof ir.dependente !== 'number' || typeof ir.desconto_simplificado !== 'number'
    || !ehLinkSeguro(ir.fonte)) falhar('tabela do IR');
  return d;
}

// Próximas divulgações do IBGE (dados/agenda.json, scripts/agenda_ibge.py).
export async function carregarAgenda() {
  const resposta = await fetch('/dados/agenda.json', { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar a agenda (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || !Array.isArray(d.itens) || !d.itens.every((x) => x && ehData(x.data) && ehTexto(x.nome)
    && typeof x.secao === 'string' && /^#[a-z-]+$/.test(x.secao))) falhar('agenda');
  return d;
}

// Bolsa Família e BPC por cidade, últimos meses (scripts/beneficios_para_json.py).
// municipios: { codigo IBGE: [ [nbf_valor, nbf_qtd, bpc_valor, bpc_qtd] ou null, ... um por mês ] }
const CAMPOS_BENEFICIOS = ['nbf_valor', 'nbf_qtd', 'bpc_valor', 'bpc_qtd'];
export async function carregarBeneficiosUf(uf) {
  if (!/^[A-Z]{2}$/.test(uf)) falhar('benefícios: UF');
  const resposta = await fetch(`/dados/beneficios/${uf}.json`, { credentials: 'same-origin' });
  // Sem arquivo ainda (antes da primeira coleta): sem dado, sem erro.
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar os benefícios de ${uf} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || d.uf !== uf || !Array.isArray(d.meses) || !d.meses.length || !d.meses.every(ehMes)
    || JSON.stringify(d.campos) !== JSON.stringify(CAMPOS_BENEFICIOS) || !d.municipios || typeof d.municipios !== 'object') {
    falhar(`benefícios de ${uf}`);
  }
  for (const [cod, serie] of Object.entries(d.municipios)) {
    if (!/^[0-9]{7}$/.test(cod) || !Array.isArray(serie) || serie.length !== d.meses.length
      || !serie.every((x) => x === null || (Array.isArray(x) && x.length === 4 && x.every((v) => v === null || (Number.isFinite(v) && v >= 0))))) {
      falhar(`benefícios da cidade ${cod}`);
    }
  }
  return d;
}

// Série inteira do Bolsa Família e do BPC de uma cidade, desde março de 2023
// (scripts/beneficios_para_json.py --cidades): {inicio: 'AAAA-MM', campos,
// s: [[nbf_valor, nbf_qtd, bpc_valor, bpc_qtd] ou null, um por mês]}, em
// reais da época. Só existe com a série completa; sem ele, null, sem erro.
export async function carregarSerieBeneficios(cod) {
  if (!/^[0-9]{7}$/.test(cod)) falhar('série de benefícios: código');
  const resposta = await fetch(`/dados/beneficios/cidades/${cod}.json`, { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar a série de benefícios (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || !ehMes(d.inicio) || JSON.stringify(d.campos) !== JSON.stringify(CAMPOS_BENEFICIOS) || !Array.isArray(d.s) || !d.s.length
    || !d.s.every((x) => x === null || (Array.isArray(x) && x.length === 4 && x.every((v) => v === null || (Number.isFinite(v) && v >= 0))))) {
    falhar(`série de benefícios da cidade ${cod}`);
  }
  return d;
}

// Cidade e estado prováveis de quem acessa, pelo endereço de internet
// (worker/index.js, em /api/onde). Fora da Cloudflare (no computador de quem
// desenvolve, por exemplo) ou sem resposta válida: null, sem erro.
export async function buscarOnde() {
  try {
    const resposta = await fetch('/api/onde', { credentials: 'same-origin', cache: 'no-store' });
    if (!resposta.ok) return null;
    const d = await resposta.json();
    if (!d || d.pais !== 'BR' || !/^[A-Z]{2}$/.test(d.uf ?? '')) return null;
    return { uf: d.uf, cidade: typeof d.cidade === 'string' && d.cidade.length <= 80 ? d.cidade : null };
  } catch {
    return null;
  }
}

// Emendas parlamentares pagas à prefeitura e aos fundos municipais, por ano
// de pagamento (scripts/emendas_para_json.py).
// nomes: os autores do estado, uma vez cada; cargos: o cargo de cada um
// ("Câmara · PT-MG", "Bancada do estado"...), na mesma ordem.
// cidades: { codigo IBGE: { ano: [pago, emendas, [[índice em nomes, valor], ...]] } },
// com todos os autores, do que mais mandou ao que menos mandou.
const CAMPOS_EMENDAS = ['pago', 'emendas', 'autores'];
export async function carregarEmendasUf(uf) {
  if (!/^[A-Z]{2}$/.test(uf)) falhar('emendas: UF');
  // Conferência cruzada: [Portal, Tesouro], em reais da época.
  const ehPar = (x) => Array.isArray(x) && x.length === 2 && x.every((v) => Number.isFinite(v) && v >= 0);
  const resposta = await fetch(`/dados/emendas/${uf}.json`, { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar as emendas de ${uf} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || d.uf !== uf || !ehData(d.atualizado) || JSON.stringify(d.campos) !== JSON.stringify(CAMPOS_EMENDAS)
    || !Array.isArray(d.anos) || !d.anos.length || !d.anos.every(Number.isInteger)
    || !Array.isArray(d.nomes) || !d.nomes.every(ehTexto)
    || (d.cargos !== undefined && (!Array.isArray(d.cargos) || d.cargos.length !== d.nomes.length || !d.cargos.every((c) => typeof c === 'string')))
    || (d.paginas !== undefined && (!Array.isArray(d.paginas) || d.paginas.length !== d.nomes.length || !d.paginas.every((c) => c === '' || ehEndereco(c))))
    || (d.banco !== undefined && (!d.banco || typeof d.banco !== 'object' || !Object.entries(d.banco).every(([a, v]) => /^\d{4}$/.test(a) && Number.isFinite(v) && v >= 0)))
    || (d.anos_total !== undefined && (!Array.isArray(d.anos_total) || !d.anos_total.every((a) => d.anos.includes(a))))
    || (d.banco_comissao_relator !== undefined && (!d.banco_comissao_relator || typeof d.banco_comissao_relator !== 'object'
      || !Object.entries(d.banco_comissao_relator).every(([a, v]) => /^\d{4}$/.test(a) && Number.isFinite(v) && v >= 0)))
    || (d.total !== undefined && (!d.total || typeof d.total !== 'object' || !Object.entries(d.total).every(([cod, anos]) => /^[0-9]{7}$/.test(cod)
      && anos && typeof anos === 'object' && Object.entries(anos).every(([a, v]) => (d.anos_total ?? []).includes(Number(a)) && Number.isFinite(v) && v >= 0))))
    || (d.conferencia !== undefined && (!d.conferencia || typeof d.conferencia !== 'object' || !Object.entries(d.conferencia).every(([cod, anos]) => /^[0-9]{7}$/.test(cod)
      && anos && typeof anos === 'object' && Object.entries(anos).every(([a, x]) => d.anos.includes(Number(a)) && ehPar(x)))))
    || (d.conferencia_pais !== undefined && (!d.conferencia_pais || typeof d.conferencia_pais !== 'object'
      || !Object.entries(d.conferencia_pais).every(([a, x]) => d.anos.includes(Number(a)) && ehPar(x))))
    || !d.cidades || typeof d.cidades !== 'object') {
    falhar(`emendas de ${uf}`);
  }
  const n = d.nomes.length;
  const ehAutor = (a) => Array.isArray(a) && a.length === 2 && Number.isInteger(a[0]) && a[0] >= 0 && a[0] < n && Number.isFinite(a[1]) && a[1] > 0;
  const ehAno = (x) => Array.isArray(x) && x.length === 3 && Number.isFinite(x[0]) && Number.isInteger(x[1]) && x[1] >= 0
    && Array.isArray(x[2]) && x[2].every(ehAutor);
  for (const [cod, anos] of Object.entries(d.cidades)) {
    if (!/^[0-9]{7}$/.test(cod) || !anos || typeof anos !== 'object'
      || !Object.entries(anos).every(([a, x]) => d.anos.includes(Number(a)) && ehAno(x))) {
      falhar(`emendas da cidade ${cod}`);
    }
  }
  return d;
}

// Quanto o STF pagou por ano (Tesouro Nacional; scripts/stf_para_json.py):
// {anos, categorias: [[chave, rótulo]], valores: {ano: [total, [por
// categoria]]}, conferencia: {ano: {planilha, rgf}}}, em reais da época.
export async function carregarStf() {
  const resposta = await fetch('/dados/stf.json', { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar os gastos do STF (HTTP ${resposta.status})`);
  const d = await resposta.json();
  const n = Array.isArray(d?.categorias) ? d.categorias.length : 0;
  const ehValor = (x) => Array.isArray(x) && x.length === 2 && Number.isFinite(x[0]) && x[0] > 0
    && Array.isArray(x[1]) && x[1].length === n && x[1].every(Number.isFinite);
  if (!d || !ehData(d.atualizado) || !ehLinkSeguro(d.fonte) || !n
    || !d.categorias.every((c) => Array.isArray(c) && c.length === 2 && ehTexto(c[0]) && ehTexto(c[1]))
    || !Array.isArray(d.anos) || !d.anos.length || !d.anos.every(Number.isInteger)
    || !d.anos.every((a) => ehValor(d.valores?.[String(a)]))
    || !d.anos.every((a) => Number.isFinite(d.conferencia?.[String(a)]?.planilha) && Number.isFinite(d.conferencia?.[String(a)]?.rgf))) {
    falhar('gastos do STF');
  }
  return d;
}

// Gastos das câmaras municipais por tipo de despesa (Tribunais de Contas de
// SP, RS, PE, CE e PR; scripts/camaras_UF_para_json.py): {anos, categorias:
// [[chave, rótulo]], cidades: {código: {ano: [total pago, [por categoria]]}},
// fora?: {código: {ano: motivo}}}, em reais da época. "fora" lista as câmaras
// que o tribunal publica sem os pagamentos, ou sem órgão próprio (PE, CE e PR).
const MOTIVOS_FORA = ['pago_zerado', 'incompleto', 'na_prefeitura'];
export async function carregarCamarasUf(uf) {
  if (!/^[A-Z]{2}$/.test(uf)) falhar('câmaras: UF');
  const resposta = await fetch(`/dados/camaras/${uf}.json`, { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar os gastos das câmaras de ${uf} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || d.uf !== uf || !ehData(d.atualizado) || !ehLinkSeguro(d.fonte)
    || (d.tribunal !== undefined && !ehTexto(d.tribunal))
    || !Array.isArray(d.anos) || !d.anos.length || !d.anos.every(Number.isInteger)
    || !Array.isArray(d.categorias) || !d.categorias.length
    || !d.categorias.every((c) => Array.isArray(c) && c.length === 2 && ehTexto(c[0]) && ehTexto(c[1]))
    || !d.cidades || typeof d.cidades !== 'object') {
    falhar(`câmaras de ${uf}`);
  }
  const n = d.categorias.length;
  const ehAno = (x) => Array.isArray(x) && x.length === 2 && Number.isFinite(x[0])
    && Array.isArray(x[1]) && x[1].length === n && x[1].every(Number.isFinite);
  for (const [cod, anos] of Object.entries(d.cidades)) {
    if (!/^[0-9]{7}$/.test(cod) || !anos || typeof anos !== 'object'
      || !Object.entries(anos).every(([a, x]) => d.anos.includes(Number(a)) && ehAno(x))) {
      falhar(`câmara da cidade ${cod}`);
    }
  }
  if (d.fora !== undefined) {
    if (!d.fora || typeof d.fora !== 'object') falhar(`câmaras de ${uf}: fora`);
    for (const [cod, anos] of Object.entries(d.fora)) {
      if (!/^[0-9]{7}$/.test(cod) || !anos || typeof anos !== 'object'
        || !Object.entries(anos).every(([a, m]) => /^[0-9]{4}$/.test(a) && MOTIVOS_FORA.includes(m))) {
        falhar(`câmara fora da conta ${cod}`);
      }
    }
  }
  return d;
}

// Deputados e senadores com página (scripts/emendas_para_json.py):
// [endereço, nome, casa, partido, UF, emendas pagas nos anos do site].
const CAMPOS_PARLAMENTARES = ['endereco', 'nome', 'casa', 'partido', 'uf', 'emendas_pagas'];
const CAMPOS_PARLAMENTARES_V2 = [...CAMPOS_PARLAMENTARES, 'oficial', 'sexo'];
const ehEndereco = (v) => typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
export async function carregarIndiceParlamentares() {
  const resposta = await fetch('/dados/parlamentares/indice.json', { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar os parlamentares (HTTP ${resposta.status})`);
  const d = await resposta.json();
  const v2 = JSON.stringify(d?.campos) === JSON.stringify(CAMPOS_PARLAMENTARES_V2);
  const n = v2 ? 8 : 6;
  if (!d || !ehData(d.atualizado) || (!v2 && JSON.stringify(d.campos) !== JSON.stringify(CAMPOS_PARLAMENTARES))
    || !Array.isArray(d.anos) || !d.anos.length || !d.anos.every(Number.isInteger)
    || !Array.isArray(d.parlamentares) || d.parlamentares.length < 500
    || !d.parlamentares.every((x) => Array.isArray(x) && x.length === n && ehEndereco(x[0]) && ehTexto(x[1])
      && (!v2 || ((x[6] === '' || /^(camara|senado):[0-9]{1,9}$/.test(x[6])) && ['M', 'F', ''].includes(x[7])))
      && ['camara', 'senado', ''].includes(x[2]) && typeof x[3] === 'string' && (x[4] === '' || /^[A-Z]{2}$/.test(x[4]))
      && Number.isFinite(x[5]))) {
    falhar('lista de parlamentares');
  }
  return d;
}

// Emendas de um parlamentar: por ano, o total, por tipo de recebedor e as
// cidades (prefeitura e fundos municipais).
const TIPOS_RECEBEDOR = ['prefeituras', 'estados', 'entidades', 'banco', 'outros'];
export async function carregarEmendasParlamentar(endereco) {
  if (!ehEndereco(endereco)) falhar('parlamentar: endereço');
  const resposta = await fetch(`/dados/parlamentares/emendas/${endereco}.json`, { credentials: 'same-origin' });
  if (!resposta.ok) throw new Error(`Falha ao carregar as emendas de ${endereco} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  const ehAno = (x) => x && Number.isFinite(x.pago) && Array.isArray(x.tipos) && x.tipos.length === TIPOS_RECEBEDOR.length
    && x.tipos.every(Number.isFinite) && Array.isArray(x.cidades)
    && x.cidades.every((c) => Array.isArray(c) && c.length === 2 && /^[0-9]{7}$/.test(c[0]) && Number.isFinite(c[1]) && c[1] > 0);
  if (!d || d.endereco !== endereco || !ehTexto(d.nome) || !ehData(d.atualizado)
    || JSON.stringify(d.tipos) !== JSON.stringify(TIPOS_RECEBEDOR)
    || !d.anos || typeof d.anos !== 'object' || !Object.entries(d.anos).every(([a, x]) => /^\d{4}$/.test(a) && ehAno(x))) {
    falhar(`emendas de ${endereco}`);
  }
  return d;
}

// Votos e projetos de um parlamentar (scripts/congresso_para_json.py).
export async function carregarAtividade(casa, id) {
  if (!['camara', 'senado'].includes(casa) || !/^[0-9]{1,9}$/.test(id)) falhar('parlamentar: identificação');
  const resposta = await fetch(`/dados/parlamentares/${casa}/${id}.json`, { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar a atividade de ${casa}/${id} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  const ehVoto = (v) => Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && v[0] >= 0 && typeof v[1] === 'string' && v[1].length <= 20;
  if (!d || d.casa !== casa || String(d.id) !== id || !ehTexto(d.nome) || !d.votos || typeof d.votos !== 'object'
    || !Object.entries(d.votos).every(([a, l]) => /^\d{4}$/.test(a) && Array.isArray(l) && l.every(ehVoto))
    || !Array.isArray(d.projetos) || !d.projetos.every((x) => Array.isArray(x) && x.length === 7 && typeof x[0] === 'string'
      && ehTexto(x[1]) && typeof x[3] === 'string' && ehData(x[4]) && typeof x[5] === 'string' && (x[6] === 0 || x[6] === 1))) {
    falhar(`atividade de ${casa}/${id}`);
  }
  return d;
}

// Votações nominais do Plenário de uma casa num ano.
const cacheVotacoes = new Map();
export function carregarVotacoesAno(casa, ano) {
  const chave = `${casa}-${ano}`;
  if (!cacheVotacoes.has(chave)) {
    cacheVotacoes.set(chave, (async () => {
      if (!['camara', 'senado'].includes(casa) || !Number.isInteger(ano)) falhar('votações: casa ou ano');
      const resposta = await fetch(`/dados/parlamentares/votacoes/${chave}.json`, { credentials: 'same-origin' });
      if (resposta.status === 404) return null;
      if (!resposta.ok) throw new Error(`Falha ao carregar as votações ${chave} (HTTP ${resposta.status})`);
      const d = await resposta.json();
      if (!d || d.casa !== casa || d.ano !== ano || !Array.isArray(d.campos) || !Array.isArray(d.votacoes)
        || !d.votacoes.every((v) => Array.isArray(v) && v.length === d.campos.length && typeof v[0] === 'string' && ehData(v[1]))) {
        falhar(`votações ${chave}`);
      }
      return d;
    })().catch((erro) => { cacheVotacoes.delete(chave); throw erro; }));
  }
  return cacheVotacoes.get(chave);
}

// Vereadores eleitos (TSE; scripts/governantes_para_json.py).
// cidades: { codigo IBGE: [[nome, feminino, partido, eleito_por], ...] }
const CAMPOS_VEREADORES = ['nome', 'feminino', 'partido', 'eleito_por'];
export async function carregarVereadoresUf(uf) {
  if (!/^[A-Z]{2}$/.test(uf)) falhar('vereadores: UF');
  const resposta = await fetch(`/dados/vereadores/${uf}.json`, { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar os vereadores de ${uf} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || d.uf !== uf || !Number.isInteger(d.eleicao) || !Number.isInteger(d.inicio) || !Number.isInteger(d.fim)
    || JSON.stringify(d.campos) !== JSON.stringify(CAMPOS_VEREADORES) || !d.cidades || typeof d.cidades !== 'object'
    || !Object.entries(d.cidades).every(([cod, l]) => /^[0-9]{7}$/.test(cod) && Array.isArray(l) && l.every((x) => Array.isArray(x)
      && x.length === 4 && ehTexto(x[0]) && (x[1] === 0 || x[1] === 1) && ehTexto(x[2]) && ['qp', 'media'].includes(x[3])))) {
    falhar(`vereadores de ${uf}`);
  }
  return d;
}

// Prefeitos e governadores eleitos (TSE; scripts/governantes_para_json.py).
// Cada eleito: [eleição, data, suplementar, nome, feminino, partido, vice].
const CAMPOS_GOVERNANTES = ['eleicao', 'data', 'suplementar', 'nome', 'feminino', 'partido', 'vice'];
const ehEleito = (x) => Array.isArray(x) && x.length === 7 && Number.isInteger(x[0]) && ehData(x[1])
  && (x[2] === 0 || x[2] === 1) && ehTexto(x[3]) && (x[4] === 0 || x[4] === 1) && ehTexto(x[5]) && typeof x[6] === 'string';
export async function carregarGovernantesUf(uf) {
  if (!/^[A-Z]{2}$/.test(uf)) falhar('governantes: UF');
  const resposta = await fetch(`/dados/governantes/${uf}.json`, { credentials: 'same-origin' });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`Falha ao carregar os eleitos de ${uf} (HTTP ${resposta.status})`);
  const d = await resposta.json();
  if (!d || d.uf !== uf || JSON.stringify(d.campos) !== JSON.stringify(CAMPOS_GOVERNANTES) || !d.eleicoes || typeof d.eleicoes !== 'object'
    || !Object.values(d.eleicoes).every((e) => e && ehTexto(e.cargo) && Number.isInteger(e.inicio) && Number.isInteger(e.fim))
    || !Array.isArray(d.governadores) || !d.governadores.every(ehEleito)
    || !d.prefeitos || typeof d.prefeitos !== 'object'
    || !Object.entries(d.prefeitos).every(([cod, lst]) => /^[0-9]{7}$/.test(cod) && Array.isArray(lst) && lst.every(ehEleito))) {
    falhar(`eleitos de ${uf}`);
  }
  return d;
}
