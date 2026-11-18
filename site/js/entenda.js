// Página Entenda (/entenda): explicações em linguagem simples. Dados
// carregados: as siglas dos partidos (dados/partidos.json, do TSE) e o
// salário mínimo em vigor (painel, série oficial do Banco Central), que
// atualiza os valores do BPC sem depender de edição do texto. Sem os dados,
// fica o valor escrito na página, conferido na data indicada.

import * as f from './formato.js';
import { preencherTabela } from './graficos.js';
import { carregarPainel, carregarStf } from './dados.js';
import { $, definir, barra, el, inflacao, fatorParaHoje } from './comum.js';
import * as c from './calculos.js';

async function montarPartidos() {
  const caixa = $('#partidos-caixa');
  if (!caixa) return;
  try {
    const r = await fetch('/dados/partidos.json', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const linhas = Object.entries(d.partidos ?? {})
      .filter(([sigla, nome]) => typeof sigla === 'string' && typeof nome === 'string' && sigla.length <= 20 && nome.length <= 120);
    preencherTabela($('#tabela-partidos'), ['Sigla', 'Nome no TSE'], linhas, null, [1]);
  } catch (erro) {
    console.error(erro);
    caixa.querySelector('summary').textContent = 'A lista das siglas não pôde ser carregada agora.';
  }
  // Quem chega pelo link "O que é cada sigla" encontra a tabela aberta.
  const abrir = () => { if (location.hash === '#partidos') caixa.open = true; };
  window.addEventListener('hashchange', abrir);
  abrir();
}

// Salário mínimo do mês mais recente da série e um quarto dele (limite de
// renda por pessoa do BPC, Lei 8.742/1993, art. 20, § 3º).
async function montarSalarioMinimo() {
  try {
    const painel = await carregarPainel();
    const meses = c.listaMeses(painel.mensal.inicio, painel.mensal.fim);
    const serie = painel.mensal.series.salario_minimo ?? [];
    const i = c.ultimoIndice(serie);
    const sm = i >= 0 ? serie[i] : null;
    if (!(sm > 1000 && sm < 100000)) return;
    definir('sm-valor', f.moeda(sm, 0));
    definir('sm-quarto', f.moeda(sm / 4, 2));
    definir('sm-ano', String(c.anoDe(meses[i])));
  } catch (erro) {
    console.error(erro);
  }
}

// Quanto custa o STF: o ano fechado mais recente, os anteriores e a
// conferência cruzada com o relatório de pessoal do próprio STF.
const EXPLICA_STF = {
  ativos: 'salários, encargos e benefícios de quem trabalha no tribunal',
  aposentados: 'de quem trabalhou no tribunal',
  funcionamento: 'contratos, sistemas, segurança, limpeza e benefícios dos servidores',
  investimentos: 'reformas, computadores e equipamentos',
};
async function montarCustoStf() {
  const caixa = $('#stf-custo');
  if (!caixa) return;
  try {
    const [painel, d] = await Promise.all([carregarPainel(), carregarStf()]);
    if (!d) return;
    const ctx = inflacao(painel);
    const hoje = (v, ano) => v * (fatorParaHoje(ctx, ano) ?? 1);
    const ultimo = d.anos[d.anos.length - 1];
    const [total, partes] = d.valores[String(ultimo)];
    const dl = $('#stf-custo-numeros');
    dl.replaceChildren();
    const div = el('div', null, null, dl);
    el('dt', null, `Pago pelo STF em ${ultimo}`, div);
    el('dd', null, f.reaisPorExtenso(hoje(total, ultimo)), div);
    const antes = d.anos.slice(0, -1).reverse();
    if (antes.length) {
      el('dd', 'detalhe', antes.map((a) => `${a}: ${f.reaisPorExtenso(hoje(d.valores[String(a)][0], a))}`).join(' · '), div);
    }
    definir('stf-custo-titulo', `Para onde foi o dinheiro em ${ultimo}`);
    const lista = $('#stf-custo-barras');
    lista.replaceChildren();
    d.categorias.forEach(([k, rotulo], i) => {
      const v = partes[i];
      if (!(v > 0)) return;
      const pct = (v / total) * 100;
      barra(lista, { nome: rotulo, explica: EXPLICA_STF[k], valor: `${f.parteDoTotal(pct)} · ${f.reaisPorExtenso(hoje(v, ultimo))}`, pct });
    });
    const conf = d.conferencia[String(ultimo)];
    const dif = (conf.planilha / conf.rgf - 1) * 100;
    definir('stf-custo-conferencia', `Conferência cruzada: a despesa com pessoal desta conta em ${ultimo} (${f.reaisPorExtenso(conf.planilha)}) `
      + `foi comparada com a do relatório de pessoal que o próprio STF entrega ao Tesouro (${f.reaisPorExtenso(conf.rgf)}). `
      + `Diferença: ${f.numero(Math.abs(dif), 1)}%. As duas medem coisas um pouco diferentes (o pago no ano e o liquidado nos 12 meses); `
      + 'se a diferença passar de 15%, a atualização para.');
    caixa.hidden = false;
    $('#stf-custo-vazio').hidden = true;
  } catch (erro) {
    console.error(erro);
  }
}

// Link com #seção (ex.: #quem-julga-custo): os blocos acima crescem quando
// os dados chegam e empurram o alvo para baixo. Refaz o salto no fim, a não
// ser que a pessoa já tenha rolado a página.
let usuarioRolou = false;
['wheel', 'touchmove', 'keydown'].forEach((evento) => {
  window.addEventListener(evento, () => { usuarioRolou = true; }, { passive: true, once: true });
});

Promise.allSettled([montarPartidos(), montarSalarioMinimo(), montarCustoStf()]).then(() => {
  const alvo = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (alvo && !usuarioRolou) requestAnimationFrame(() => alvo.scrollIntoView({ block: 'start' }));
});
