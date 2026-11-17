// Página Entenda (/entenda): explicações em linguagem simples. O único dado
// carregado é a tabela das siglas dos partidos (dados/partidos.json, do TSE).

import { preencherTabela } from './graficos.js';
import { $ } from './comum.js';

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

montarPartidos();
