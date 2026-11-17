// Partes do governo do estado usadas na página inicial (seção "Seu estado")
// e na página de cada cidade: o resumo em frases curtas (dívida, folha e
// impostos) e quem foi eleito (TSE).

import * as c from './calculos.js';
import * as f from './formato.js';
import { el } from './comum.js';
import { carregarGovernantesUf } from './dados.js';

// Situação diante dos limites da lei, em palavras simples. "Perto do limite"
// começa no nível de alerta da lei (90% do limite). Os limites da folha vêm do
// relatório de cada estado (49% ou 48,6%); o da dívida é o da lei, igual para
// todos.
export function situacao(valor, limite, alerta) {
  if (valor == null || limite == null) return null;
  if (valor > limite) return 'acima do limite';
  if (alerta != null && valor > alerta) return 'perto do limite';
  return 'dentro do limite';
}

const FRASE_SITUACAO = { 'acima do limite': 'Está acima do limite.', 'perto do limite': 'Está perto do limite.', 'dentro do limite': 'Está dentro do limite.' };

// Os percentuais viram "R$ X de cada R$ 100". Centavos só perto de um
// limite, para que "R$ 49" não pareça igual ao limite de R$ 49.
export const porCemReais = (v, ...referencias) => f.moeda(v, referencias.some((r) => r != null && Math.abs(v - r) < 1) ? 2 : 0);
const limiteReais = (v) => f.moeda(v, Number.isInteger(v) ? 0 : 2);

// Em Brasília, ISS, IPTU e ITBI são cobrados pelo governo do Distrito Federal.
const ehBrasilia = (capital) => capital?.codigo === '5300108';

// Resumo do governo do estado em itens [{ rotulo, texto }], a partir do
// painel (estados_fiscal, estados_receita e, com comCapital, capitais_receita).
export function resumoDoEstado(painel, sigla, { comCapital = true } = {}) {
  const bloco = painel.estados_fiscal;
  const uf = bloco?.estados?.find((x) => x.sigla === sigla);
  if (!uf) return [];
  const { anos } = bloco;
  const limiteDivida = bloco.limite_divida_pct ?? 200;
  const alertaDivida = bloco.alerta_divida_pct ?? 180;
  const ind = (chave, k) => uf.indicadores?.[chave]?.[k] ?? null;
  const itens = [];
  const kDiv = c.ultimoIndice(uf.indicadores?.dcl_rcl_pct ?? []);
  if (kDiv >= 0) {
    const v = ind('dcl_rcl_pct', kDiv);
    const sit = situacao(v, limiteDivida, alertaDivida);
    itens.push({
      rotulo: 'Dívida',
      texto: v < 0
        ? `em ${anos[kDiv]}, o governo tinha mais dinheiro em caixa do que dívidas. ${FRASE_SITUACAO[sit]}`
        : `em ${anos[kDiv]}, o governo devia ${porCemReais(v, limiteDivida, alertaDivida)} para cada R$ 100 que entraram no ano. `
          + `A lei permite até ${limiteReais(limiteDivida)}. ${FRASE_SITUACAO[sit]}`,
    });
  }
  const kPes = c.ultimoIndice(uf.indicadores?.pessoal_rcl_pct ?? []);
  if (kPes >= 0) {
    const v = ind('pessoal_rcl_pct', kPes);
    const limite = ind('pessoal_limite_pct', kPes);
    const alerta = ind('pessoal_alerta_pct', kPes);
    const sit = situacao(v, limite, alerta);
    itens.push({
      rotulo: 'Folha de pagamento',
      texto: `em ${anos[kPes]}, de cada R$ 100 que entraram, o governo gastou ${porCemReais(v, limite, alerta)} com salários e aposentadorias de servidores.`
        + (limite != null ? ` A lei permite até ${limiteReais(limite)}. ${FRASE_SITUACAO[sit]}` : ''),
    });
  }
  const rec = painel.estados_receita;
  const doze = Array.isArray(rec?.estados) ? rec.estados.find((x) => x.sigla === sigla)?.doze_meses : null;
  if (doze?.icms != null && doze.ipva != null && doze.itcd != null && rec.doze_meses_ate) {
    const total = doze.icms + doze.ipva + doze.itcd;
    itens.push({
      rotulo: 'Impostos',
      texto: `nos 12 meses até ${f.mesLongo(rec.doze_meses_ate)}, ${sigla === 'DF' ? 'o Distrito Federal' : 'o estado'} arrecadou ${f.reaisPorExtenso(total)}. `
        + `O ICMS, imposto embutido no preço das mercadorias, respondeu por ${f.porcentagem((doze.icms / total) * 100, 0)} disso.`,
    });
  }
  const capital = comCapital && Array.isArray(painel.capitais_receita?.capitais) ? painel.capitais_receita.capitais.find((x) => x.uf === sigla) : null;
  const dozeCap = capital?.doze_meses;
  if (dozeCap?.iss != null && dozeCap.iptu != null && dozeCap.itbi != null && capital.ultimo_mes) {
    const total = dozeCap.iss + dozeCap.iptu + dozeCap.itbi;
    itens.push({
      rotulo: ehBrasilia(capital) ? 'Impostos de Brasília' : `Prefeitura de ${capital.nome}`,
      texto: `nos 12 meses até ${f.mesLongo(capital.ultimo_mes)}, ${ehBrasilia(capital) ? 'o governo do Distrito Federal arrecadou' : 'arrecadou'} ${f.reaisPorExtenso(total)} com ISS, IPTU e ITBI. `
        + `O ISS, imposto sobre serviços, respondeu por ${f.porcentagem((dozeCap.iss / total) * 100, 0)} disso.`,
    });
  }
  return itens;
}

// Lista com rótulo em negrito no começo de cada item: [{ rotulo, texto }].
export function listaDeItens(itens) {
  const lista = document.createElement('ul');
  itens.forEach(({ rotulo, texto }) => {
    const li = el('li', null, null, lista);
    if (rotulo) el('strong', null, `${rotulo}: `, li);
    li.append(document.createTextNode(texto));
  });
  return lista;
}

// Prefeitos e governadores eleitos (TSE), carregados uma vez por estado.
const eleitosPorUf = new Map();
export function eleitosDe(uf) {
  if (!eleitosPorUf.has(uf)) {
    eleitosPorUf.set(uf, carregarGovernantesUf(uf).catch((erro) => { console.error(erro); return null; }));
  }
  return eleitosPorUf.get(uf);
}

// x: [ano, data, suplementar, nome, feminino, partido, vice].
export function linhaEleito(lista, rotulo, x) {
  const li = el('li', null, null, lista);
  el('span', null, rotulo, li);
  el('strong', null, x[3], li);
  el('span', null, ` (${x[5]})${x[6] ? `, vice ${x[6]}` : ''}.`, li);
}

// Governadores eleitos: o mandato atual e o anterior, em itens de lista.
export function listaDeGovernadores(lista, d) {
  const anoAtual = new Date().getFullYear();
  for (const x of d.governadores) {
    const e = d.eleicoes[String(x[0])];
    if (!e) continue;
    // Emenda Constitucional 111/2021: a partir de 2027, governadores tomam posse em 6 de janeiro.
    const posse = e.inicio > anoAtual && e.inicio >= 2027 ? `, posse em 6 de janeiro de ${e.inicio}` : '';
    const quem = x[4] ? 'eleita' : 'eleito';
    const rotulo = x[2]
      ? `Eleição suplementar em ${f.dataCurta(x[1])} (mandato até ${e.fim}): `
      : `${x[0]}, ${quem} para o mandato de ${e.inicio} a ${e.fim}${posse}: `;
    linhaEleito(lista, rotulo, x);
  }
}
