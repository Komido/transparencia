// Página de cada cidade: /nome-uf, como /alfenas-mg (o Worker entrega cidade.html com o
// título e a manchete da cidade). Quem foi eleito, receitas e gastos da
// prefeitura, emendas, Bolsa Família e BPC e o governo do estado, com links
// para o resto do site.

import * as f from './formato.js';
import {
  carregarPainel, carregarIndiceMunicipios, carregarMunicipiosUf, carregarBeneficiosUf, carregarEmendasUf, carregarVereadoresUf, carregarCamarasUf,
} from './dados.js';
import { caminhoDaCidade, slugDaCidade, slugDoCaminho } from './endereco.js';
import {
  $, el, campo, definir, inflacao, fatorParaHoje, fatorMesParaHoje, mesAnterior, arred, definirTopicos, registrarDownload, montarBusca,
  lerMunicipioGuardado, guardarMunicipio,
} from './comum.js';
import { resumoDoEstado, listaDeItens, eleitosDe, linhaEleito, listaDeGovernadores } from './estado.js';
import { doEstado } from './textos.js';

const SELO_PREFEITURA = {
  ok: (ano) => `Contas de ${ano} entregues ao Tesouro e conferidas: as partes somam o total do relatório.`,
  nao_fecha: (ano) => `A prefeitura entregou as contas de ${ano}, mas a soma das partes não bate com o total do relatório. Os números aparecem como foram entregues.`,
  sem_relatorio: (ano, data) => `A prefeitura não entregou ao Tesouro o relatório do ano completo de ${ano} (conferido em ${data}). Sem dado: o site não estima.`,
  formato: (ano) => `A prefeitura entregou o relatório de ${ano}, mas ele veio sem as linhas que o site usa para conferir a conta. Sem dado, para não mostrar número errado.`,
  erro: (ano) => `Não foi possível buscar as contas de ${ano} desta prefeitura na última atualização. Sem dado.`,
  df: () => 'Brasília não tem prefeitura. Os impostos que nas outras cidades são da prefeitura, como IPTU e ISS, são cobrados pelo governo do Distrito Federal e aparecem em "O governo do Distrito Federal", mais abaixo.',
};

// Áreas de despesa das prefeituras, na ordem de campos_despesa do índice.
const AREAS_PREFEITURA = {
  saude: ['Saúde', 'postos, hospitais, remédios e vacinas'],
  educacao: ['Educação', 'creches, escolas, merenda e transporte escolar'],
  urbanismo: ['Ruas, praças e iluminação', 'obras e serviços urbanos'],
  administracao: ['Administração da prefeitura', 'pessoal administrativo, prédios e sistemas'],
  previdencia: ['Aposentadorias dos servidores', 'de quem trabalhou na prefeitura'],
  assistencia: ['Assistência social', 'apoio a famílias, crianças e idosos'],
  saneamento: ['Saneamento', 'água, esgoto e drenagem'],
  transporte: ['Transporte', 'estradas, ônibus e terminais'],
  encargos: ['Dívidas e outros encargos', 'juros e parcelas de empréstimos e outros'],
  camara: ['Câmara de Vereadores', 'vereadores e funcionamento da Câmara'],
  seguranca: ['Segurança', 'guarda municipal e defesa civil'],
  cultura_esporte: ['Cultura, esporte e lazer', null],
  habitacao: ['Moradia', 'habitação popular'],
  outras: ['Outras áreas', 'agricultura, meio ambiente, trabalho, turismo e outras'],
};

const SELO_DESPESA = {
  nao_fecha: 'A soma das áreas não bate com o total do relatório. Os números aparecem como a prefeitura entregou.',
  formato: 'O relatório de despesas veio sem as linhas que o site usa para conferir a conta. Sem dado.',
  sem_anexo: 'A prefeitura entregou as receitas, mas o relatório veio sem as despesas por área. Sem dado.',
  erro: 'Não foi possível buscar as despesas desta prefeitura na última atualização. Sem dado.',
};

// cidade: { codigo (número IBGE), codigo7 (texto com 7 dígitos), nome, uf }.
const estado = { painel: null, ctx: null, indice: null, cidade: null, d: null, m: null, emendas: undefined, beneficios: undefined, vereadores: undefined };
const selAno = () => $('#mun-ano');
const anoEscolhido = () => Number(selAno().value);
const valorGrande = (v) => (v >= 1e6 ? f.reaisPorExtenso(v) : f.reaisCompacto(v));

// Salário mínimo de um mês ("2026-09"), da série oficial do painel (Banco
// Central, SGS 1619).
function salarioMinimo(mes) {
  const i = estado.ctx?.meses.indexOf(mes) ?? -1;
  const v = i >= 0 ? estado.painel.mensal.series.salario_minimo?.[i] : null;
  return v > 0 ? v : null;
}

// Pessoas com BPC no mês: cada benefício é de um salário mínimo, então o
// valor pago dividido pelo mínimo dá o número de benefícios. A "quantidade
// de beneficiados" da consulta do Portal conta só quem tem NIS: no arquivo
// completo de setembro de 2026, 974.618 dos 6.620.994 benefícios do país
// (15%) vinham sem NIS, e o valor por benefício dava R$ 1.621,05 com o
// mínimo a R$ 1.621. Sem o mínimo do mês, fica a quantidade do Portal.
function pessoasNoBpc(valor, qtdPortal, mes) {
  const sm = salarioMinimo(mes);
  return sm && valor > 0 ? Math.round(valor / sm) : qtdPortal;
}
const nomeDoEstado = (uf) => estado.painel?.estados_fiscal?.estados?.find((x) => x.sigla === uf)?.nome ?? uf;
// "governo de Minas Gerais", "governo da Bahia", "governo do Distrito Federal".
const governoDe = (uf) => `governo ${doEstado(uf, nomeDoEstado(uf))}`;

// Números do alto da página, um por assunto, com link para a seção.
function resumo(id, valor, detalhe) {
  const div = $(`#${id}`);
  div.querySelectorAll('dd').forEach((dd) => dd.remove());
  el('dd', null, valor ?? 'sem dado', div);
  if (detalhe) el('dd', 'detalhe', detalhe, div);
}

// ---------------------------------------------------------------------------
// Contas da prefeitura (receitas), com o selo da entrega ao Tesouro

function desenhar() {
  const { nome, uf } = estado.cidade;
  const { d, m } = estado;
  const ano = anoEscolhido();
  const r = m?.a[String(ano)];
  const ctx = estado.ctx;
  definir('cid-resumo-titulo', `Em ${ano}, em dinheiro de hoje`);
  const selo = $('#mun-selo');
  // Sem registro do ano ou situação desconhecida: "sem dado", nunca "não entregou".
  const situacao = Object.hasOwn(SELO_PREFEITURA, r?.s) ? r.s : 'erro';
  // Sem dado no ano escolhido: oferece o ano mais recente que tem.
  const outros = (estado.indice.anos ?? []).filter((a) => a !== ano && m?.a[String(a)]?.v).sort((a, b) => b - a);
  const caixaOutro = $('#mun-outro-ano');
  caixaOutro.hidden = Boolean(r?.v) || !outros.length;
  if (!caixaOutro.hidden) {
    const bt = $('#mun-ver-ano');
    bt.textContent = `Ver as contas de ${outros[0]}`;
    bt.onclick = () => { selAno().value = String(outros[0]); aoMudarAno(); };
  }
  desenharGoverno();
  selo.textContent = SELO_PREFEITURA[situacao](ano, f.dataCurta(d?.atualizado))
    + (!r?.v && situacao !== 'df' && !outros.length ? ' Os outros anos também estão sem dado.' : '');
  selo.classList.toggle('aviso', situacao !== 'ok');
  desenharDespesas(r, ano);
  desenharCamara(r, ano);
  desenharEmendas(ano, r?.p || m?.p);
  const caixaContas = $('#mun-contas');
  if (!r?.v) {
    caixaContas.hidden = true;
    campo('mun-resumo').forEach((e) => e.replaceChildren());
    resumo('cid-resumo-receita', uf === 'DF' ? 'não se aplica' : null, uf === 'DF' ? 'Brasília não tem prefeitura' : `a prefeitura não entregou as contas de ${ano}`);
    return;
  }
  caixaContas.hidden = false;
  const campos = estado.indice.campos;
  const v = Object.fromEntries(campos.map((k, i) => [k, r.v[i]]));
  const fator = fatorParaHoje(ctx, ano) ?? 1;
  const pop = r.p || m.p;
  const receita = v.receita;
  const parte = (x) => (receita > 0 ? (x / receita) * 100 : null);
  const outrosRepasses = v.transferencias - v.fpm - v.icms - v.ipva - v.fundeb;
  const outrasReceitas = receita - v.tributos - v.transferencias;
  const hoje = (x) => x * fator;
  resumo('cid-resumo-receita', valorGrande(hoje(receita)), `${f.moeda(hoje(receita) / pop, 0)} por morador`);

  // Resposta em tópicos.
  const porCem = (x) => Math.round(parte(x));
  const topicos = [
    `Em ${ano}, a prefeitura de ${nome} (${uf}) recebeu ${f.reaisPorExtenso(hoje(receita))}, ou ${f.moeda(hoje(receita) / pop, 0)} por morador (em dinheiro de hoje).`,
    `De cada R$ 100, R$ ${porCem(v.tributos)} vieram de impostos e taxas cobrados pela própria cidade e R$ ${porCem(v.transferencias)} de repasses da União e do estado${porCem(outrasReceitas) >= 1 ? `; R$ ${porCem(outrasReceitas)}, de outras receitas` : ''}.`,
  ];
  const anterior = m.a[String(ano - 1)];
  const fatorAnt = fatorParaHoje(ctx, ano - 1);
  if (anterior?.s === 'ok' && anterior.v && fatorAnt) {
    const recAnt = anterior.v[campos.indexOf('receita')] * fatorAnt;
    const varia = ((hoje(receita) - recAnt) / recAnt) * 100;
    topicos.push(Math.abs(varia) < 0.5
      ? `Descontada a inflação, a receita ficou igual à de ${ano - 1}.`
      : `Descontada a inflação, a receita foi ${f.porcentagem(Math.abs(varia), 0)} ${varia > 0 ? 'maior' : 'menor'} que em ${ano - 1}.`);
  }
  definirTopicos('mun-resumo', topicos.join(' '));
  definir('mun-receitas-titulo', `De onde veio cada R$ 100 em ${ano}`);

  // De onde veio cada R$ 100: ordem fixa, impostos da cidade primeiro.
  const itens = [
    { nome: 'Impostos e taxas da cidade', explica: `IPTU ${f.reaisCompacto(hoje(v.iptu))} · ISS ${f.reaisCompacto(hoje(v.iss))} · ITBI ${f.reaisCompacto(hoje(v.itbi))} · IR dos servidores ${f.reaisCompacto(hoje(v.irrf))}`, valor: v.tributos },
    { nome: 'FPM (repasse da União)', explica: 'parte do Imposto de Renda e do IPI dividida entre as cidades', valor: v.fpm },
    { nome: 'ICMS (parte do imposto do estado)', explica: 'um quarto do ICMS fica com as cidades', valor: v.icms },
    { nome: 'FUNDEB (educação)', explica: 'fundo da educação básica, pelo número de alunos', valor: v.fundeb },
    { nome: 'IPVA (parte do imposto dos carros)', explica: 'metade do IPVA dos carros da cidade', valor: v.ipva },
    { nome: 'Outros repasses', explica: 'SUS, assistência social, merenda, ITR e outros', valor: outrosRepasses },
    { nome: 'Outras receitas da prefeitura', explica: 'aplicações financeiras, serviços e contribuições', valor: outrasReceitas },
  ].filter((x) => x.valor > 0);
  const lista = $('#mun-barras');
  lista.replaceChildren();
  for (const x of itens) barraDe(lista, x.nome, x.explica, `${f.parteDoTotal(parte(x.valor))} · ${f.reaisCompacto(hoje(x.valor))}`, parte(x.valor));

  // Comparação com a mediana das cidades do mesmo tamanho e do estado.
  const faixas = estado.indice.faixas;
  const iFaixa = faixas.findIndex((x) => x.ate == null || pop <= x.ate);
  const medFaixa = estado.indice.medianas[String(ano)]?.[String(iFaixa)] ?? {};
  const medUf = d.medianas?.[String(ano)] ?? {};
  const compara = $('#mun-compara');
  compara.replaceChildren();
  const linhas = [
    ['Receita por morador', hoje(receita) / pop, (x) => f.moeda(hoje(x), 0), 'receita_hab'],
    ['Impostos da própria cidade, por morador', hoje(v.tributos) / pop, (x) => f.moeda(hoje(x), 0), 'tributos_hab'],
    ['Parte que vem de repasses', parte(v.transferencias), (x) => f.porcentagem(x, 0), 'repasses_pct'],
  ];
  for (const [rotulo, valor, fmt, chave] of linhas) {
    const div = el('div', null, null, compara);
    el('dt', null, rotulo, div);
    el('dd', null, chave === 'repasses_pct' ? f.porcentagem(valor, 0) : f.moeda(valor, 0), div);
    const det = [];
    if (medFaixa[chave] != null) det.push(`cidades do mesmo tamanho: ${fmt(medFaixa[chave])}`);
    if (medUf[chave] != null) det.push(`cidades de ${uf}: ${fmt(medUf[chave])}`);
    if (det.length) el('dd', 'detalhe', det.join(' · '), div);
  }
  definir('mun-compara-nota', `Mediana das cidades com contas conferidas em ${ano}: metade está acima e metade abaixo. Mesmo tamanho: ${faixas[iFaixa]?.rotulo ?? ''}${medFaixa.n ? ` (${f.numero(medFaixa.n)} cidades)` : ''}${medUf.n ? `; ${uf}: ${f.numero(medUf.n)} cidades` : ''}.`);
}

// Uma linha de barra: nome, explicação, valor e a barra proporcional.
function barraDe(lista, nome, explica, valor, pct) {
  const li = el('li', null, null, lista);
  const topo = el('div', 'barra-topo', null, li);
  const nomeEl = el('span', 'barra-nome', nome, topo);
  if (explica) el('span', 'barra-explica', explica, nomeEl);
  el('span', 'barra-valor', valor, topo);
  const trilho = el('div', 'barra-trilho', null, li);
  trilho.setAttribute('aria-hidden', 'true');
  el('div', 'barra', null, trilho).style.width = `${Math.max(1, pct)}%`;
  return li;
}

// ---------------------------------------------------------------------------
// Quem foi eleito: prefeito do mandato do ano das contas e vereadores (TSE)

async function desenharGoverno() {
  const caixa = $('#mun-governo');
  const lista = $('#mun-governo-lista');
  const vazio = $('#mun-governo-vazio');
  const { codigo7, uf } = estado.cidade;
  const ano = anoEscolhido();
  caixa.hidden = true;
  vazio.hidden = true;
  if (uf === 'DF') {
    vazio.textContent = 'Brasília não tem prefeito nem vereadores: quem governa é o governador do Distrito Federal, e as leis são feitas pela Câmara Legislativa. Veja "O governo do Distrito Federal", mais abaixo.';
    vazio.hidden = false;
    return;
  }
  const d = await eleitosDe(uf);
  if (anoEscolhido() !== ano) return;
  const mandato = d && Object.entries(d.eleicoes).find(([, e]) => e.cargo === 'prefeito' && e.inicio <= ano && ano <= e.fim);
  const eleitos = mandato ? (d.prefeitos[codigo7] ?? []).filter((x) => String(x[0]) === mandato[0]) : [];
  if (!eleitos.length) {
    vazio.textContent = d ? 'O arquivo do TSE não traz o prefeito eleito para o mandato deste ano.' : 'Não foi possível carregar os eleitos agora. Tente de novo mais tarde.';
    vazio.hidden = false;
    return;
  }
  const [eleicao, e] = mandato;
  lista.replaceChildren();
  el('li', 'governo-mandato', `As contas de ${ano} são do mandato de ${e.inicio} a ${e.fim}.`, lista);
  for (const x of eleitos) {
    const rotulo = x[2] ? `Eleição suplementar em ${f.dataCurta(x[1])}: ` : `${x[4] ? 'Prefeita eleita' : 'Prefeito eleito'} em ${eleicao}: `;
    linhaEleito(lista, rotulo, x);
  }
  caixa.hidden = false;
}

// Vereadores eleitos na última eleição municipal, com o partido.
async function desenharVereadores() {
  const caixa = $('#mun-vereadores');
  const { codigo7, nome, uf } = estado.cidade;
  caixa.hidden = true;
  if (estado.vereadores === undefined) {
    try { estado.vereadores = await carregarVereadoresUf(uf); } catch (erro) { console.error(erro); estado.vereadores = null; }
  }
  const d = estado.vereadores;
  const lista = d?.cidades[codigo7];
  if (!lista?.length) return;
  definir('mun-vereadores-titulo', `Os ${lista.length} vereadores eleitos em ${d.eleicao} (mandato de ${d.inicio} a ${d.fim})`);
  // Quantos de cada partido, do que elegeu mais para o que elegeu menos.
  const porPartido = new Map();
  lista.forEach((x) => porPartido.set(x[2], (porPartido.get(x[2]) ?? 0) + 1));
  const partidos = $('#mun-vereadores-partidos');
  partidos.replaceChildren();
  [...porPartido].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([sigla, n]) => {
    const li = el('li', null, null, partidos);
    li.title = d.partidos?.[sigla] ?? sigla;
    el('span', 'contagem-sigla', sigla, li);
    el('span', 'contagem-numero', String(n), li);
  });
  // Nome em cima, sigla do partido embaixo, como nas outras listas de pessoas.
  const ul = $('#mun-vereadores-lista');
  ul.replaceChildren();
  lista.forEach((x) => {
    const li = el('li', null, null, ul);
    el('span', 'pessoa-nome', x[0], li);
    const sigla = el('span', 'pessoa-detalhe', x[2], li);
    if (d.partidos?.[x[2]]) sigla.title = d.partidos[x[2]];
  });
  definir('mun-vereadores-nota', `Fonte: TSE, dados abertos. O TSE registra quem foi eleito, não quem está no cargo hoje: se um vereador saiu e o suplente assumiu, a troca não aparece. O que cada vereador faz (projetos, votos, presença) só é publicado pela Câmara Municipal de ${nome}; cada câmara publica do seu jeito, e não há uma base nacional com isso.`);
  caixa.hidden = false;
}

// ---------------------------------------------------------------------------
// Para onde foi o dinheiro: despesa liquidada por área (RREO Anexo 2), em
// dinheiro de hoje, e comparação por morador com cidades parecidas.

function desenharDespesas(r, ano) {
  const caixa = $('#mun-despesas');
  const vazio = $('#mun-despesas-vazio');
  const { nome, uf } = estado.cidade;
  const { m, d } = estado;
  const campos = estado.indice.campos_despesa;
  caixa.hidden = true;
  vazio.hidden = true;
  const semDado = (texto, curto) => {
    vazio.textContent = texto;
    vazio.hidden = false;
    resumo('cid-resumo-gastos', uf === 'DF' ? 'não se aplica' : null, curto);
  };
  if (uf === 'DF') { semDado('Brasília não tem prefeitura: os gastos da cidade estão nas contas do governo do Distrito Federal.', 'Brasília não tem prefeitura'); return; }
  if (!campos || !r?.ds) { semDado(`Sem dado dos gastos da prefeitura em ${ano}: o relatório do ano não foi entregue ao Tesouro ou não traz as despesas.`, `sem relatório de ${ano}`); return; }
  const selo = $('#mun-despesas-selo');
  const lista = $('#mun-despesas-barras');
  const compara = $('#mun-despesas-compara');
  lista.replaceChildren();
  compara.replaceChildren();
  definir('mun-despesas-nota', '');
  selo.hidden = r.ds === 'ok';
  selo.textContent = SELO_DESPESA[r.ds] ?? '';
  caixa.hidden = false;
  const total = r.d ? r.d.reduce((a, x) => a + (x ?? 0), 0) : 0;
  if (!r.d || total <= 0) {
    definir('mun-despesas-titulo', `Gastos da prefeitura em ${ano}`);
    resumo('cid-resumo-gastos', null, SELO_DESPESA[r.ds] ? 'veja o aviso na seção' : null);
    return;
  }
  const fator = fatorParaHoje(estado.ctx, ano) ?? 1;
  const hoje = (x) => x * fator;
  const pop = r.p || m.p;
  resumo('cid-resumo-gastos', valorGrande(hoje(total)), pop ? `${f.moeda(hoje(total) / pop, 0)} por morador` : null);
  definir('mun-despesas-titulo', `De cada R$ 100 gastos em ${ano}`);
  const itens = campos.map((k, i) => ({ k, valor: r.d[i] ?? 0 }))
    .filter((x) => x.valor > 0 && AREAS_PREFEITURA[x.k])
    .sort((a, b) => (a.k === 'outras') - (b.k === 'outras') || b.valor - a.valor);
  for (const x of itens) {
    const [rotulo, explica] = AREAS_PREFEITURA[x.k];
    const pct = (x.valor / total) * 100;
    barraDe(lista, rotulo, explica, `${f.parteDoTotal(pct)} · ${f.reaisCompacto(hoje(x.valor))}`, pct);
  }
  if (r.ds !== 'ok' || !pop) {
    definir('mun-despesas-nota', `Total gasto em ${ano}: ${f.reaisPorExtenso(hoje(total))} (em dinheiro de hoje).`);
    return;
  }
  const faixas = estado.indice.faixas;
  const iFaixa = faixas.findIndex((x) => x.ate == null || pop <= x.ate);
  const medFaixa = estado.indice.medianas[String(ano)]?.[String(iFaixa)] ?? {};
  const medUf = d.medianas?.[String(ano)] ?? {};
  const valor = (k) => r.d[campos.indexOf(k)] ?? 0;
  const linhas = [
    ['Gasto por morador no ano', total / pop, 'despesa_hab'],
    ['Saúde por morador', valor('saude') / pop, 'saude_hab'],
    ['Educação por morador', valor('educacao') / pop, 'educacao_hab'],
  ];
  for (const [rotulo, v, chave] of linhas) {
    const div = el('div', null, null, compara);
    el('dt', null, rotulo, div);
    el('dd', null, f.moeda(hoje(v), 0), div);
    const det = [];
    if (medFaixa[chave] != null) det.push(`cidades do mesmo tamanho: ${f.moeda(hoje(medFaixa[chave]), 0)}`);
    if (medUf[chave] != null) det.push(`cidades de ${d.uf}: ${f.moeda(hoje(medUf[chave]), 0)}`);
    if (det.length) el('dd', 'detalhe', det.join(' · '), div);
  }
  definir('mun-despesas-nota', `${nome} gastou ${f.reaisPorExtenso(hoje(total))} em ${ano}, em dinheiro de hoje. Mediana das cidades com despesas conferidas no mesmo ano${medFaixa.nd ? ` (${f.numero(medFaixa.nd)} do mesmo tamanho)` : ''}.`);
}

// Quanto custou a Câmara de Vereadores no ano (função Legislativa do RREO
// Anexo 2), por morador, comparado com as medianas do país (mesmo tamanho)
// e do estado. Só com as despesas do ano conferidas.
function desenharCamara(r, ano) {
  const caixa = $('#mun-camara');
  caixa.hidden = true;
  $('#mun-camara-numeros').replaceChildren();
  definir('mun-camara-nota', '');
  desenharCamaraTipos(ano);
  const campos = estado.indice.campos_despesa;
  const i = campos?.indexOf('camara') ?? -1;
  const { m, d } = estado;
  const pop = r?.p || m?.p;
  if (i < 0 || r?.ds !== 'ok' || !r.d || !(r.d[i] > 0) || !pop) return;
  const fator = fatorParaHoje(estado.ctx, ano) ?? 1;
  const hoje = (x) => x * fator;
  const camara = r.d[i];
  const total = r.d.reduce((a, x) => a + (x ?? 0), 0);
  const faixas = estado.indice.faixas;
  const iFaixa = faixas.findIndex((x) => x.ate == null || pop <= x.ate);
  const medFaixa = estado.indice.medianas[String(ano)]?.[String(iFaixa)] ?? {};
  const medUf = d.medianas?.[String(ano)] ?? {};
  const dl = $('#mun-camara-numeros');
  dl.replaceChildren();
  const div = el('div', null, null, dl);
  el('dt', null, `Câmara de Vereadores em ${ano}`, div);
  el('dd', null, valorGrande(hoje(camara)), div);
  el('dd', 'detalhe', `${f.moeda(hoje(camara) / pop, 0)} por morador; R$ ${f.numero((camara / total) * 100, 1)} de cada R$ 100 gastos pela prefeitura`, div);
  const det = [];
  if (medFaixa.camara_hab != null) det.push(`cidades do mesmo tamanho: ${f.moeda(hoje(medFaixa.camara_hab), 0)} por morador`);
  if (medUf.camara_hab != null) det.push(`cidades de ${d.uf}: ${f.moeda(hoje(medUf.camara_hab), 0)}`);
  if (det.length) el('dd', 'detalhe', det.join(' · '), div);
  definir('mun-camara-nota', 'Inclui salários dos vereadores e dos servidores da Câmara, prédio e funcionamento, em dinheiro de hoje. A Constituição limita esse gasto a uma parte do que a cidade arrecada: de 7%, nas cidades de até 100 mil habitantes, a 3,5%, nas de mais de 8 milhões. O site não calcula esse limite, porque o relatório não traz a base exata da conta.');
  caixa.hidden = false;
}

// Em que a Câmara gastou, pelo tipo de despesa de cada pagamento (Tribunal de
// Contas do estado). Só onde o tribunal publica os lançamentos: por enquanto,
// SP. Sem nomes de pessoas.
const UFS_COM_CAMARAS = new Set(['SP']);
const CAPITAL_SP = '3550308';
const TIPOS_CAMARA = {
  vereadores: 'o subsídio pago a cada vereador',
  pessoal: 'servidores da Câmara e contribuições à previdência, inclusive sobre o salário dos vereadores',
  diarias: 'valor por dia de viagem a serviço, de vereadores e servidores',
  viagens: 'passagens, pedágios, táxi e outros deslocamentos',
  servicos: 'empresas e pessoas contratadas: sistemas, contabilidade, limpeza, publicidade',
  material: 'combustível, papel, limpeza, alimentação',
  obras: 'reformas, veículos, móveis e computadores',
  outros: 'auxílio-alimentação, indenizações, contas de anos anteriores e outros',
};

// Câmaras pequenas gastam poucos milhões: "R$ 1,4 mi", não "R$ 1 mi".
const milhoes = (v) => (Math.abs(v) >= 1e6 && Math.abs(v) < 1e8 ? `R$\u00A0${f.numero(v / 1e6, 1)} mi` : f.reaisCompacto(v));

async function desenharCamaraTipos(ano) {
  const caixa = $('#mun-camara-tipos');
  caixa.hidden = true;
  $('#mun-baixar-camaras').hidden = true;
  const { codigo7, uf } = estado.cidade;
  if (!UFS_COM_CAMARAS.has(uf)) return;
  if (estado.camaras === undefined) {
    try { estado.camaras = await carregarCamarasUf(uf); } catch (erro) { console.error(erro); estado.camaras = null; }
  }
  // O ano mudou enquanto o arquivo carregava: o desenho seguinte cuida.
  if (anoEscolhido() !== ano) return;
  const d = estado.camaras;
  if (!d) return;
  $('#mun-baixar-camaras').hidden = false;
  const lista = $('#mun-camara-barras');
  lista.replaceChildren();
  const mostrar = () => { caixa.hidden = false; $('#mun-camara').hidden = false; };
  if (codigo7 === CAPITAL_SP) {
    definir('mun-camara-tipos-titulo', 'Em que a Câmara gastou');
    definir('mun-camara-tipos-nota', 'A Câmara Municipal de São Paulo é fiscalizada pelo Tribunal de Contas do Município, não pelo Tribunal de Contas do Estado, e por isso fica fora desta conta.');
    mostrar();
    return;
  }
  const porAno = d.cidades[codigo7] ?? {};
  const anosCom = d.anos.filter((a) => porAno[String(a)]?.[0] > 0).sort((a, b) => a - b);
  if (!anosCom.length) return;
  // Sem o ano escolhido no tribunal: o mais recente até ele, ou o primeiro que houver.
  const anoUsado = anosCom.includes(ano) ? ano : (anosCom.filter((a) => a < ano).pop() ?? anosCom[0]);
  const [total, partes] = porAno[String(anoUsado)];
  const fator = fatorParaHoje(estado.ctx, anoUsado) ?? 1;
  const itens = d.categorias.map(([k, rotulo], i) => ({ k, rotulo, valor: partes[i] }))
    .filter((x) => x.valor > 0)
    .sort((a, b) => (a.k === 'outros') - (b.k === 'outros') || b.valor - a.valor);
  const soma = itens.reduce((s, x) => s + x.valor, 0);
  if (!(soma > 0)) return;
  definir('mun-camara-tipos-titulo', anoUsado === ano
    ? `Em que a Câmara gastou em ${anoUsado}`
    : `Em que a Câmara gastou em ${anoUsado} (${d.anos.includes(ano) ? `o Tribunal de Contas não traz pagamentos desta Câmara em ${ano}` : `o Tribunal de Contas ainda não publicou ${ano}`})`);
  for (const x of itens) {
    const pct = (x.valor / soma) * 100;
    barraDe(lista, x.rotulo, TIPOS_CAMARA[x.k], `${f.parteDoTotal(pct)} · ${milhoes(x.valor * fator)}`, pct);
  }
  const semSubsidio = !itens.some((x) => x.k === 'vereadores');
  // O custo acima vem do relatório da prefeitura ao Tesouro (SICONFI).
  const iCam = estado.indice.campos_despesa?.indexOf('camara') ?? -1;
  const sic = estado.m?.a?.[String(anoUsado)];
  const custoTesouro = iCam >= 0 && sic?.ds === 'ok' ? sic.d?.[iCam] : null;
  const longe = custoTesouro > 0 && (total / custoTesouro < 0.8 || total / custoTesouro > 1.25);
  definir('mun-camara-tipos-nota', `Total pago em ${anoUsado}: ${f.reaisPorExtenso(total * fator)}, em dinheiro de hoje. `
    + 'Fonte: Tribunal de Contas do Estado de São Paulo, cada pagamento da Câmara pelo tipo de despesa. '
    + (longe
      ? `Neste ano, o total é bem diferente do custo que a prefeitura informou ao Tesouro (${f.reaisPorExtenso(custoTesouro * fator)}); o site mostra cada número como a fonte publicou.`
      : 'Pode diferir um pouco do custo informado pela prefeitura ao Tesouro, que conta a despesa liquidada, não a paga.')
    + (semSubsidio ? ' Neste ano, a Câmara não registrou nenhum pagamento como salário de vereador (subsídio); ele pode ter sido lançado junto com o dos servidores.' : ''));
  mostrar();
}

// ---------------------------------------------------------------------------
// Emendas parlamentares pagas à prefeitura: o ano escolhido e, se for outro,
// o ano em andamento. Valores em dinheiro de hoje (IPCA).

async function desenharEmendas(ano, moradores) {
  const caixa = $('#mun-emendas');
  const vazio = $('#mun-emendas-vazio');
  const { codigo7, nome, uf } = estado.cidade;
  if (estado.emendas === undefined) {
    caixa.hidden = true;
    try { estado.emendas = await carregarEmendasUf(uf); } catch (erro) { console.error(erro); estado.emendas = null; }
  }
  // O ano mudou enquanto o arquivo carregava: o desenho seguinte cuida.
  if (anoEscolhido() !== ano) return;
  const d = estado.emendas;
  vazio.hidden = Boolean(d);
  if (!d) {
    caixa.hidden = true;
    resumo('cid-resumo-emendas', null, null);
    return;
  }
  $('#mun-baixar-emendas').hidden = false;
  // Brasília não tem prefeitura: o que vai para a cidade é pago ao governo
  // do Distrito Federal, que fica fora desta conta.
  if (uf === 'DF') {
    $('#mun-emendas-numeros').replaceChildren();
    campo('mun-emendas-autores-titulo')[0].hidden = true;
    $('#mun-emendas-autores').hidden = true;
    $('#mun-emendas-todos').hidden = true;
    definir('mun-emendas-nota', 'Brasília não tem prefeitura: as emendas para a cidade são pagas ao governo do Distrito Federal, que não entra nesta conta, feita só com o que é pago a prefeituras e fundos municipais.');
    resumo('cid-resumo-emendas', 'não se aplica', 'Brasília não tem prefeitura');
    caixa.hidden = false;
    return;
  }
  const daCidade = d.cidades[codigo7] ?? {};
  const emAndamento = Math.max(...d.anos);
  // Nos anos de d.anos_total (muito dinheiro registrado no Portal como pago
  // ao Banco do Brasil), o total vem do arquivo: série do Tesouro mais
  // comissão e relator do Portal. A lista de autores é só a do Portal.
  const doAno = (a) => {
    const x = daCidade[String(a)];
    const temPortal = Boolean(x && x[0] > 0);
    const total = d.anos_total?.includes(a) ? d.total?.[codigo7]?.[String(a)] : undefined;
    if (!temPortal && !(total > 0)) return null;
    const fator = fatorParaHoje(estado.ctx, a) ?? 1;
    const lista = temPortal ? x[2].map(([i, v]) => [d.nomes[i], v * fator, d.cargos?.[i] ?? '', d.paginas?.[i] ?? '']) : [];
    const portal = temPortal ? x[0] * fator : 0;
    // Só quando o Tesouro traz dinheiro que o Portal não ligou à cidade.
    const pelaSerie = total > 0 && total * fator - portal > Math.max(1000, 0.01 * portal);
    return { pago: pelaSerie ? Math.max(total * fator, portal) : portal, portal, emendas: temPortal ? x[1] : 0, autores: lista.length, lista, pelaSerie };
  };
  const quantas = (x) => `${f.numero(x.emendas)} ${x.emendas === 1 ? 'emenda' : 'emendas'}${x.autores ? ` de ${f.numero(x.autores)} ${x.autores === 1 ? 'autor' : 'autores'}` : ''}`;
  const detalheDoAno = (x) => (!x.pelaSerie ? quantas(x)
    : (x.autores ? `${valorGrande(x.portal)} com autor identificado (${quantas(x)})` : 'nenhuma com autor identificado'));
  const rotuloAno = (a) => (a === emAndamento ? `Pago em ${a} (ano em andamento)` : `Pago em ${a}`);
  const dl = $('#mun-emendas-numeros');
  dl.replaceChildren();
  const linha = (rotulo, valor, detalhes) => {
    const div = el('div', null, null, dl);
    el('dt', null, rotulo, div);
    el('dd', null, valor, div);
    detalhes.forEach((t) => el('dd', 'detalhe', t, div));
  };
  const escolhido = d.anos.includes(ano) ? doAno(ano) : null;
  if (!d.anos.includes(ano)) {
    linha(`Pago em ${ano}`, 'sem dado', [`O site mostra as emendas de ${Math.min(...d.anos)} a ${emAndamento}.`]);
    resumo('cid-resumo-emendas', null, `o site tem de ${Math.min(...d.anos)} a ${emAndamento}`);
  } else if (!escolhido) {
    linha(rotuloAno(ano), f.moeda(0, 0), ['Nenhuma emenda paga à prefeitura neste ano.']);
    resumo('cid-resumo-emendas', f.moeda(0, 0), 'nenhuma emenda paga');
  } else {
    const det = [detalheDoAno(escolhido)];
    if (moradores) det.push(`${f.moeda(escolhido.pago / moradores, 0)} por morador`);
    linha(rotuloAno(ano), valorGrande(escolhido.pago), det);
    resumo('cid-resumo-emendas', valorGrande(escolhido.pago), escolhido.pelaSerie ? 'total do Tesouro Nacional' : quantas(escolhido));
  }
  const atual = ano !== emAndamento ? doAno(emAndamento) : null;
  if (atual) linha(rotuloAno(emAndamento), valorGrande(atual.pago), [detalheDoAno(atual)]);
  else if (ano !== emAndamento) linha(rotuloAno(emAndamento), f.moeda(0, 0), ['Nenhuma emenda paga à prefeitura até agora.']);

  // Quem mandou mais: no ano escolhido ou, sem ele, no ano em andamento.
  const anoLista = escolhido ? ano : (atual ? emAndamento : null);
  const lista = anoLista === ano ? escolhido : atual;
  const titulo = campo('mun-emendas-autores-titulo')[0];
  const barras = $('#mun-emendas-autores');
  const botaoTodos = $('#mun-emendas-todos');
  barras.replaceChildren();
  titulo.hidden = barras.hidden = !lista?.lista.length;
  botaoTodos.hidden = true;
  const notas = [];
  if (lista?.lista.length) {
    titulo.textContent = lista.pelaSerie
      ? `Quem mandou dinheiro em ${anoLista}: só a parte com autor identificado (${valorGrande(lista.portal)} de ${valorGrande(lista.pago)})`
      : `Quem mandou dinheiro em ${anoLista}${anoLista === emAndamento ? ' (até agora)' : ''}, do maior para o menor`;
    // Todos os autores; os 6 primeiros aparecem logo, o resto com o botão.
    const VISIVEIS = 6;
    lista.lista.forEach(([autor, valor, cargo, pagina], k) => {
      const pct = lista.pago > 0 ? (valor / lista.pago) * 100 : 0;
      const li = el('li', null, null, barras);
      li.hidden = k >= VISIVEIS;
      const topo = el('div', 'barra-topo', null, li);
      const nomeEl = el('span', 'barra-nome', null, topo);
      if (pagina) el('a', null, autor, nomeEl).href = `/parlamentar/${pagina}`;
      else nomeEl.textContent = autor;
      if (cargo) el('span', 'barra-explica', cargo, nomeEl);
      // Entre 1 e 10 milhões, com uma casa: "R$ 1,4 mi", não "R$ 1 mi".
      const valorCurto = valor >= 1e6 && valor < 1e7 ? `R$ ${f.numero(valor / 1e6, 1)} mi` : f.reaisCompacto(valor);
      el('span', 'barra-valor', `${valorCurto} · ${f.parteDoTotal(pct)}`, topo);
      const trilho = el('div', 'barra-trilho', null, li);
      trilho.setAttribute('aria-hidden', 'true');
      el('div', 'barra', null, trilho).style.width = `${Math.max(1, pct)}%`;
    });
    if (lista.lista.length > VISIVEIS) {
      let aberto = false;
      const rotular = () => {
        botaoTodos.textContent = aberto ? `Mostrar só os ${VISIVEIS} maiores` : `Ver todos os ${f.numero(lista.lista.length)} autores`;
        botaoTodos.setAttribute('aria-expanded', String(aberto));
      };
      botaoTodos.onclick = () => {
        aberto = !aberto;
        [...barras.children].forEach((li, k) => { li.hidden = !aberto && k >= VISIVEIS; });
        rotular();
        if (!aberto) titulo.scrollIntoView({ block: 'nearest' });
      };
      rotular();
      botaoTodos.hidden = false;
    }
    const nomes = lista.lista.map(([a]) => a);
    if (nomes.includes('Relator Geral')) notas.push('Relator Geral: emendas do relator do orçamento, proibidas pelo STF em dezembro de 2022; depois disso, é pagamento de compromisso antigo.');
    if (nomes.includes('Sem informação')) notas.push('Sem informação: o arquivo não traz o autor.');
  }
  // Pagamentos registrados ao Banco do Brasil, sem a cidade: quase todos de
  // 2023 e 2024. O aviso aparece só no ano em que isso pesa (o arquivo traz o
  // total do país por ano); em arquivo antigo, sem esse total, aviso geral.
  const anoNota = anoLista ?? ano;
  const doNota = anoNota === ano ? escolhido : atual;
  const banco = d.banco?.[String(anoNota)];
  // Anos com o total pelo Tesouro: individuais e de bancada completas;
  // comissão e relator pagos por meio do banco seguem sem cidade.
  const anoComTotal = d.anos_total?.includes(anoNota);
  const bancoCR = d.banco_comissao_relator?.[String(anoNota)];
  const avisoBanco = anoComTotal
    ? ` Em ${anoNota}, parte das emendas foi registrada no Portal como paga ao Banco do Brasil, sem dizer a cidade. As individuais e de bancada estão completas aqui pela série do Tesouro Nacional, que registra cada pagamento à prefeitura${doNota?.pelaSerie ? ', mas não diz o autor: a lista de quem mandou soma menos que o total' : ''}.${bancoCR >= 1e8 ? ` As de comissão e de relator pagas por meio do banco (${f.reaisPorExtenso(bancoCR)} no país) não têm essa série e ficam de fora, então o valor de ${anoNota} pode ser maior.` : ''}`
    : d.banco === undefined
    ? ' Parte das emendas é paga por meio do Banco do Brasil, e o arquivo oficial não diz para qual cidade foi; esse dinheiro também não entra, então o valor real pode ser maior.'
    : (banco >= 1e9 ? ` Em ${anoNota}, ${f.reaisPorExtenso(banco)} em emendas do país inteiro (a maior parte de saúde) foram registrados como pagos ao Banco do Brasil, sem dizer a cidade; esse dinheiro não entra aqui, então o valor de ${anoNota} pode ser maior.` : '');
  const fonteTesouro = anoComTotal ? ' e Tesouro Nacional (série Emendas Parlamentares Individuais e de Bancada)' : '';
  notas.push(`Fonte: Portal da Transparência, pagamentos à prefeitura de ${nome} (${uf}) e aos fundos municipais${fonteTesouro}, em dinheiro de hoje. Emendas pagas a hospitais, entidades ou ao governo do estado não entram.${avisoBanco} Atualização: ${f.dataCurta(d.atualizado)}.`);
  definir('mun-emendas-nota', notas.join(' '));
  caixa.hidden = false;
}

// ---------------------------------------------------------------------------
// Bolsa Família e BPC da cidade: último mês publicado e o mesmo mês do ano
// anterior. Não depende do ano escolhido nem do relatório da prefeitura.

async function desenharBeneficios() {
  const caixa = $('#mun-beneficios');
  const vazio = $('#mun-beneficios-vazio');
  const { codigo7, nome, uf } = estado.cidade;
  const ctx = estado.ctx;
  caixa.hidden = true;
  try { estado.beneficios = await carregarBeneficiosUf(uf); } catch (erro) { console.error(erro); estado.beneficios = null; }
  const d = estado.beneficios;
  const semDado = (texto) => {
    vazio.textContent = texto;
    vazio.hidden = false;
    resumo('cid-resumo-beneficios', null, null);
  };
  if (!d) { semDado('Não foi possível carregar o Bolsa Família e o BPC agora. Tente de novo mais tarde.'); return; }
  $('#mun-baixar-beneficios').hidden = false;
  const serie = d.municipios[codigo7];
  const iUlt = d.meses.length - 1;
  const atual = serie?.[iUlt];
  if (!atual) { semDado('Sem dado de Bolsa Família e BPC para esta cidade no último mês publicado.'); return; }
  const mesAtual = d.meses[iUlt];
  const iAnt = d.meses.indexOf(mesAnterior(mesAtual, 12));
  const antes = iAnt >= 0 ? serie[iAnt] : null;
  const fatorAnt = iAnt >= 0 ? fatorMesParaHoje(ctx, d.meses[iAnt]) : null;
  const dl = $('#mun-beneficios-numeros');
  dl.replaceChildren();
  // Uma informação por linha; valores arredondados ("R$ 839 mil").
  const linha = (rotulo, valor, detalhes) => {
    const div = el('div', null, null, dl);
    el('dt', null, rotulo, div);
    el('dd', null, valorGrande(valor), div);
    detalhes.forEach((t) => el('dd', 'detalhe', t, div));
  };
  const [bfValor, bfQtd, bpcValor, bpcQtd] = atual;
  if (bfValor != null && bfQtd) {
    const det = [`${f.numero(bfQtd)} famílias, média de ${f.moeda(bfValor / bfQtd, 0)} por família`];
    if (antes?.[0] != null && antes[1] && fatorAnt) {
      det.push(`Um ano antes: ${f.numero(antes[1])} famílias, média de ${f.moeda((antes[0] * fatorAnt) / antes[1], 0)} (em dinheiro de hoje)`);
    }
    linha(`Bolsa Família em ${f.mesLongo(mesAtual)}`, bfValor, det);
    resumo('cid-resumo-beneficios', valorGrande(bfValor), `${f.numero(bfQtd)} famílias em ${f.mesLongo(mesAtual)}`);
  } else {
    resumo('cid-resumo-beneficios', null, null);
  }
  const bpcPessoas = bpcValor != null && bpcQtd ? pessoasNoBpc(bpcValor, bpcQtd, mesAtual) : null;
  if (bpcPessoas) {
    const det = [`${f.numero(bpcPessoas)} pessoas, um salário mínimo cada`];
    if (antes?.[2] && antes[3]) det.push(`Um ano antes: ${f.numero(pessoasNoBpc(antes[2], antes[3], d.meses[iAnt]))} pessoas`);
    linha(`BPC em ${f.mesLongo(mesAtual)}`, bpcValor, det);
  }
  if (!dl.children.length) { semDado('Sem dado de Bolsa Família e BPC para esta cidade no último mês publicado.'); return; }
  // Soma dos últimos 12 meses, só se a cidade tiver os 12.
  const ultimos = serie.slice(-12);
  if (d.meses.length >= 12 && ultimos.length === 12 && ultimos.every((x) => x && x[0] != null && x[2] != null)) {
    const meses12 = d.meses.slice(-12);
    const total = ultimos.reduce((a, x, k) => a + (x[0] + x[2]) * (fatorMesParaHoje(ctx, meses12[k]) ?? 1), 0);
    linha('Os dois, nos últimos 12 meses', total, [`De ${f.mesLongo(meses12[0])} a ${f.mesLongo(meses12[11])}, em dinheiro de hoje`]);
  }
  // Reajuste de 15,04% do Bolsa Família (Decreto 13.120/2026), pago a partir
  // da folha de outubro de 2026: avisa enquanto o último mês é anterior e
  // enquanto a comparação com um ano antes atravessa o reajuste.
  const REAJUSTE = '2026-10';
  const aviso = mesAtual < REAJUSTE
    ? ' Os valores do Bolsa Família subiram 15,04% a partir de outubro de 2026; o mês mostrado aqui ainda é de antes do reajuste.'
    : (mesAnterior(mesAtual, 12) < REAJUSTE ? ' A comparação com um ano antes inclui o reajuste de 15,04% do Bolsa Família, pago desde outubro de 2026.' : '');
  // Quando a contagem do Portal (só quem tem NIS) é menor, diz por quê.
  const avisoBpc = bpcPessoas && bpcQtd < bpcPessoas
    ? ` No BPC, o número de pessoas é o valor pago dividido pelo salário mínimo do mês, o valor de cada benefício. A consulta do Portal informa ${f.numero(bpcQtd)}, porque conta só quem tem NIS (o número do cadastro social); no arquivo completo, parte dos benefícios vem sem esse número.`
    : '';
  definir('mun-beneficios-nota', `Fonte: Portal da Transparência, pagamentos de ${nome} (${uf}) por mês. Atualização: ${f.dataCurta(d.atualizado)}.${aviso}${avisoBpc}`);
  vazio.hidden = true;
  caixa.hidden = false;
}

// ---------------------------------------------------------------------------
// O governo do estado: governadores eleitos, dívida, folha e impostos

async function desenharEstado() {
  const { uf } = estado.cidade;
  const nomeUf = nomeDoEstado(uf);
  definir('estado-titulo', `O ${governoDe(uf)}`);
  const itens = resumoDoEstado(estado.painel, uf, { comCapital: false });
  campo('estado-resumo').forEach((e) => e.replaceChildren(itens.length ? listaDeItens(itens) : el('p', 'resumo-vazio', `Sem dado das contas do ${governoDe(uf)}.`)));
  const link = campo('estado-link')[0];
  link.href = `/?uf=${uf}#estados`;
  link.textContent = `Dívida, folha de pagamento e impostos do ${governoDe(uf)}, ano a ano`;
  const parl = campo('estado-parlamentares')[0];
  parl.href = `/?uf=${uf}#parlamentares`;
  parl.textContent = `Deputados federais e senadores ${doEstado(uf, nomeUf)}`;
  const caixa = $('#estado-governo');
  const d = await eleitosDe(uf);
  if (!d?.governadores?.length) return;
  const lista = $('#estado-governo-lista');
  lista.replaceChildren();
  listaDeGovernadores(lista, d);
  caixa.hidden = !lista.children.length;
}

// ---------------------------------------------------------------------------
// Planilhas

registrarDownload('emendas', () => {
  const uf = estado.cidade?.uf;
  const d = estado.emendas;
  const nomes = new Map((estado.indice?.cidades ?? []).filter((c) => c[2] === uf).map((c) => [String(c[0]).padStart(7, '0'), c[1]]));
  return {
    nome: `emendas-pagas-as-prefeituras-${(uf ?? 'sem-estado').toLowerCase()}.csv`,
    cabecalhos: ['ano', 'codigo_ibge', 'cidade', 'uf', 'autor', 'pago_reais_da_epoca', 'emendas_da_cidade_no_ano', 'fator para dinheiro de hoje (IPCA)',
      'total_da_cidade_no_ano (R$ da época; em 2023 e 2024, Tesouro + comissão e relator do Portal)'],
    // Uma linha por cidade, ano e autor; cidade só com o total do Tesouro
    // (nenhum autor no Portal) tem uma linha sem autor.
    linhas: d ? d.anos.flatMap((a) => {
      const total = (cod) => d.total?.[cod]?.[String(a)];
      const comAutor = Object.entries(d.cidades).filter(([, anos]) => anos[String(a)]).flatMap(([cod, anos]) => {
        const x = anos[String(a)];
        return x[2].map(([i, v]) => [a, cod, nomes.get(cod) ?? '', uf, d.nomes[i], v, x[1], arred(fatorParaHoje(estado.ctx, a) ?? 1, 6), total(cod) ?? x[0]]);
      });
      const soTesouro = Object.keys(d.total ?? {}).filter((cod) => total(cod) > 0 && !d.cidades[cod]?.[String(a)])
        .map((cod) => [a, cod, nomes.get(cod) ?? '', uf, '(sem autor identificado no Portal)', 0, 0, arred(fatorParaHoje(estado.ctx, a) ?? 1, 6), total(cod)]);
      return [...comAutor, ...soTesouro];
    }) : [],
  };
});

registrarDownload('beneficios', () => {
  const uf = estado.cidade?.uf;
  const d = estado.beneficios;
  const nomes = new Map((estado.indice?.cidades ?? []).filter((c) => c[2] === uf).map((c) => [String(c[0]).padStart(7, '0'), c[1]]));
  return {
    nome: `bolsa-familia-e-bpc-${(uf ?? 'sem-estado').toLowerCase()}.csv`,
    cabecalhos: ['mes', 'codigo_ibge', 'cidade', 'uf', 'bolsa_familia_reais', 'bolsa_familia_familias', 'bpc_reais', 'bpc_pessoas (valor ÷ salário mínimo do mês)', 'bpc_pessoas_com_nis (contagem do Portal)'],
    linhas: d ? d.meses.flatMap((mes, k) => Object.entries(d.municipios).map(([cod, serie]) => {
      const x = serie[k];
      return [mes, cod, nomes.get(cod) ?? '', uf, x?.[0] ?? '', x?.[1] ?? '', x?.[2] ?? '', x?.[2] != null && x?.[3] ? pessoasNoBpc(x[2], x[3], mes) : '', x?.[3] ?? ''];
    })) : [],
  };
});

registrarDownload('camaras', () => {
  const uf = estado.cidade?.uf;
  const d = estado.camaras;
  const nomes = new Map((estado.indice?.cidades ?? []).filter((c) => c[2] === uf).map((c) => [String(c[0]).padStart(7, '0'), c[1]]));
  return {
    nome: `gastos-das-camaras-${(uf ?? 'sem-estado').toLowerCase()}.csv`,
    cabecalhos: d ? ['ano', 'codigo_ibge', 'cidade', 'uf', 'total_pago (R$ da época)',
      ...d.categorias.map(([, rotulo]) => `${rotulo} (R$ da época)`), 'fator para dinheiro de hoje (IPCA)'] : [],
    linhas: d ? d.anos.flatMap((a) => Object.entries(d.cidades).filter(([, anos]) => anos[String(a)]).map(([cod, anos]) => {
      const [total, partes] = anos[String(a)];
      return [a, cod, nomes.get(cod) ?? '', uf, total, ...partes, arred(fatorParaHoje(estado.ctx, a) ?? 1, 6)];
    })) : [],
  };
});

registrarDownload('municipios', () => {
  const uf = estado.cidade?.uf;
  const d = estado.d;
  const campos = estado.indice?.campos ?? [];
  const camposDespesa = estado.indice?.campos_despesa ?? [];
  const anos = estado.indice?.anos ?? [];
  return {
    nome: `contas-das-prefeituras-${(uf ?? 'sem-estado').toLowerCase()}.csv`,
    cabecalhos: ['ano', 'codigo_ibge', 'cidade', 'uf', 'situacao', 'populacao', ...campos.map((k) => `${k} (R$ da época)`),
      'situacao_despesas', ...camposDespesa.map((k) => `despesa_${k} (R$ da época)`), 'fator para dinheiro de hoje (IPCA)'],
    linhas: d ? anos.flatMap((ano) => d.municipios.map((m) => {
      const r = m.a[String(ano)];
      return [ano, m.c, m.n, uf, r?.s ?? 'sem_dado', r?.p ?? m.p, ...campos.map((_, i) => r?.v?.[i] ?? ''),
        r?.ds ?? '', ...camposDespesa.map((_, i) => r?.d?.[i] ?? ''), arred(fatorParaHoje(estado.ctx, ano) ?? 1, 6)];
    })) : [],
  };
});

// ---------------------------------------------------------------------------

// O ano vai para o endereço, para o link compartilhado abrir no mesmo ano.
function aoMudarAno() {
  const p = new URLSearchParams(location.search);
  p.set('ano', selAno().value);
  history.replaceState(null, '', `${location.pathname}?${p}${location.hash}`);
  desenhar();
}

// "Marcar como a minha cidade": só aparece quando a cidade guardada é outra.
function montarGuardar() {
  const { codigo7, nome } = estado.cidade;
  const caixa = $('#cid-guardar-caixa');
  if (lerMunicipioGuardado() === codigo7) return;
  caixa.hidden = false;
  const bt = $('#cid-guardar');
  bt.textContent = `Marcar ${nome} como a minha cidade`;
  bt.onclick = () => {
    guardarMunicipio(codigo7);
    bt.hidden = true;
    const nota = campo('cid-guardar-nota')[0];
    nota.textContent = `Pronto: ${nome} ficou marcada como a sua cidade, só neste navegador. A página inicial mostra um atalho para ela.`;
    nota.hidden = false;
  };
}

async function iniciar() {
  const status = (t) => definir('cid-status', t);
  try {
    [estado.painel, estado.indice] = await Promise.all([carregarPainel(), carregarIndiceMunicipios()]);
  } catch (erro) {
    console.error(erro);
    status('Não foi possível carregar os dados agora. Tente de novo mais tarde.');
    return;
  }
  estado.ctx = inflacao(estado.painel);
  definir('mun-atualizado', f.dataCurta(estado.indice.atualizado));

  // Escolher outra cidade aqui é escolher a cidade da pessoa.
  montarBusca({
    entrada: $('#cid-busca'),
    lista: $('#cid-sugestoes'),
    prefixo: 'cid-op',
    itens: () => estado.indice.cidades,
    texto: (c) => `${c[1]} ${c[2]}`,
    rotulo: (c) => [c[1], c[2]],
    vazio: 'Nenhuma cidade com esse nome',
    aoEscolher: (c) => {
      guardarMunicipio(String(c[0]).padStart(7, '0'));
      location.href = caminhoDaCidade(c[1], c[2]);
    },
  });

  const slug = slugDoCaminho(location.pathname);
  const c = slug ? estado.indice.cidades.find((x) => slugDaCidade(x[1], x[2]) === slug) : null;
  if (!c) {
    status(slug ? 'Cidade não encontrada. Procure pelo nome acima.' : 'Procure a sua cidade pelo nome acima. Estão aqui as 5.570 cidades do país.');
    $('label[for="cid-busca"]').textContent = 'Qual é a sua cidade?';
    return;
  }
  estado.cidade = { codigo: c[0], codigo7: String(c[0]).padStart(7, '0'), nome: c[1], uf: c[2] };
  try {
    estado.d = await carregarMunicipiosUf(c[2], estado.indice.campos.length, estado.indice.campos_despesa?.length ?? 0);
  } catch (erro) {
    console.error(erro);
    status(`Não foi possível carregar as cidades de ${c[2]} agora. Tente de novo mais tarde.`);
    return;
  }
  estado.m = estado.d.municipios.find((x) => x.c === c[0]) ?? null;

  const nomeUf = nomeDoEstado(c[2]);
  definir('cid-nome', `O dinheiro público de ${c[1]} (${c[2]})`);
  definir('trilha-nome', c[1]);
  definir('trilha-estado', c[2] === 'DF' ? 'Distrito Federal' : nomeUf);
  campo('trilha-estado').forEach((a) => { a.href = `/?uf=${c[2]}#estados`; });
  const moradores = estado.m?.p;
  definir('cid-sub', `${c[2] === 'DF' ? 'Distrito Federal' : nomeUf}${moradores ? ` · ${f.numero(moradores)} moradores` : ''}`);
  document.title = `${c[1]} (${c[2]}): contas da prefeitura, emendas e Bolsa Família | Arrecadômetro Brasil`;

  const sel = selAno();
  [...estado.indice.anos].reverse().forEach((a) => { el('option', null, String(a), sel).value = String(a); });
  const pedido = new URLSearchParams(location.search).get('ano');
  if (pedido && [...sel.options].some((o) => o.value === pedido)) sel.value = pedido;
  sel.addEventListener('change', aoMudarAno);
  $('#mun-baixar').hidden = false;
  montarGuardar();
  campo('cid-status')[0].hidden = true;
  $('#cid-pagina').hidden = false;
  desenhar();
  desenharVereadores();
  desenharBeneficios();
  desenharEstado();
  // Link com #seção: a página só aparece depois dos dados; refaz o salto.
  // Os links antigos terminavam em #municipios, a seção da página inicial;
  // aqui a página inteira é da cidade, então eles abrem no alto.
  if (location.hash === '#municipios') history.replaceState(null, '', `${location.pathname}${location.search}`);
  const alvo = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (alvo) requestAnimationFrame(() => alvo.scrollIntoView({ block: 'start' }));
}

iniciar();
