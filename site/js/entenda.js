// Página Entenda (/entenda): explicações em linguagem simples. Dados
// carregados: as siglas dos partidos (dados/partidos.json, do TSE) e o
// salário mínimo em vigor (painel, série oficial do Banco Central), que
// atualiza os valores do BPC sem depender de edição do texto. Sem os dados,
// fica o valor escrito na página, conferido na data indicada.

import * as f from './formato.js';
import { preencherTabela } from './graficos.js';
import { carregarPainel } from './dados.js';
import { $, definir } from './comum.js';
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

montarPartidos();
montarSalarioMinimo();
