// Partes comuns às páginas do site (parlamentar e, aos poucos, as outras):
// atalhos de DOM, busca por nome com sugestões, inflação e planilhas.

import * as c from './calculos.js';
import { baixarCSV } from './graficos.js';

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const campo = (nome) => document.querySelectorAll(`[data-campo="${nome}"]`);
export const definir = (nome, texto) => campo(nome).forEach((e) => { e.textContent = texto; });

export function el(tag, classe, texto, pai) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto;
  if (pai) pai.appendChild(e);
  return e;
}

// "São João del-Rei" -> "sao joao del rei", para comparar nomes.
export const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Inflação (IPCA) a partir do painel: meses e índice acumulado.
export function inflacao(painel) {
  return { meses: c.listaMeses(painel.mensal.inicio, painel.mensal.fim), ipca: c.indiceAcumulado(painel.mensal.series.ipca_var) };
}

// Fator para trazer valores de um ano a dinheiro de hoje: IPCA de hoje sobre
// a média do IPCA dos meses daquele ano já publicados.
export function fatorParaHoje(ctx, ano) {
  const { meses, ipca } = ctx;
  const ref = ipca[c.ultimoIndice(ipca)];
  const doAno = meses.map((m, i) => (c.anoDe(m) === ano ? ipca[i] : null)).filter((v) => v != null);
  return doAno.length && ref ? ref / (doAno.reduce((a, v) => a + v, 0) / doAno.length) : null;
}

export const arred = (v, casas) => (v == null ? null : Math.round(v * 10 ** casas) / 10 ** casas);

// Planilhas: cada botão com data-baixar="chave" chama a função registrada.
const planilhas = new Map();
export function registrarDownload(chave, gerar) { planilhas.set(chave, gerar); }
document.addEventListener('click', (ev) => {
  const botao = ev.target.closest('[data-baixar]');
  const gerar = botao && planilhas.get(botao.dataset.baixar);
  if (!gerar) return;
  const { nome, cabecalhos, linhas } = gerar();
  baixarCSV(nome, cabecalhos, linhas);
});

// Barra horizontal de uma lista (.barras): nome (com link, se houver),
// explicação, valor e a barra proporcional.
export function barra(lista, { nome, href, explica, valor, pct, aoClicar }) {
  const li = el('li', null, null, lista);
  const topo = el('div', 'barra-topo', null, li);
  const nomeEl = el('span', 'barra-nome', null, topo);
  if (href) {
    const a = el('a', null, nome, nomeEl);
    a.href = href;
    if (aoClicar) a.addEventListener('click', aoClicar);
  } else nomeEl.textContent = nome;
  if (explica) el('span', 'barra-explica', explica, nomeEl);
  el('span', 'barra-valor', valor, topo);
  const trilho = el('div', 'barra-trilho', null, li);
  trilho.setAttribute('aria-hidden', 'true');
  el('div', 'barra', null, trilho).style.width = `${Math.max(1, Math.min(100, pct))}%`;
  return li;
}

// Mostra só os primeiros itens de uma lista; o botão abre e fecha o resto.
export function encurtarLista(lista, botao, visiveis, rotulos) {
  const itens = [...lista.children];
  let aberto = false;
  const aplicar = () => {
    itens.forEach((li, k) => { li.hidden = !aberto && k >= visiveis; });
    botao.textContent = aberto ? rotulos.fechar : rotulos.abrir;
    botao.setAttribute('aria-expanded', String(aberto));
  };
  botao.hidden = itens.length <= visiveis;
  botao.onclick = () => { aberto = !aberto; aplicar(); };
  aplicar();
}

// Busca por nome com lista de sugestões (combobox acessível).
// itens(): a lista; texto(item): o que se compara; rotulo(item): [nome, detalhe].
export function montarBusca({ entrada, lista, prefixo, itens, texto, rotulo, vazio, aoEscolher, aoFocar }) {
  const estado = { sugestoes: [], ativa: -1, nomes: null, fonte: null };
  const fechar = () => {
    lista.hidden = true;
    entrada.setAttribute('aria-expanded', 'false');
    entrada.removeAttribute('aria-activedescendant');
    estado.ativa = -1;
  };
  const marcar = (i) => {
    estado.ativa = i;
    [...lista.children].forEach((li, k) => li.setAttribute('aria-selected', k === i ? 'true' : 'false'));
    if (i >= 0) {
      entrada.setAttribute('aria-activedescendant', `${prefixo}-${i}`);
      lista.children[i]?.scrollIntoView({ block: 'nearest' });
    } else entrada.removeAttribute('aria-activedescendant');
  };
  const escolher = (item) => { fechar(); aoEscolher(item); };
  const sugerir = () => {
    const todos = itens();
    if (!todos) return;
    if (estado.fonte !== todos) { estado.fonte = todos; estado.nomes = todos.map((x) => semAcento(texto(x))); }
    const q = semAcento(entrada.value);
    if (q.length < 2) { fechar(); return; }
    const comeca = [];
    const contem = [];
    estado.nomes.forEach((n, i) => {
      if (n.startsWith(q)) comeca.push(i);
      else if (n.includes(` ${q}`) || (q.length >= 4 && n.includes(q))) contem.push(i);
    });
    estado.sugestoes = [...comeca, ...contem].slice(0, 8).map((i) => todos[i]);
    lista.replaceChildren();
    if (!estado.sugestoes.length) {
      const li = el('li', 'sugestao-nada', vazio, lista);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-disabled', 'true');
    }
    estado.sugestoes.forEach((x, k) => {
      const [nome, detalhe] = rotulo(x);
      const li = el('li', null, nome, lista);
      li.id = `${prefixo}-${k}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      if (detalhe) el('small', null, ` ${detalhe}`, li);
      li.addEventListener('mousedown', (ev) => { ev.preventDefault(); escolher(x); });
    });
    lista.hidden = false;
    entrada.setAttribute('aria-expanded', 'true');
    marcar(-1);
  };
  entrada.addEventListener('focus', () => { aoFocar?.(); });
  entrada.addEventListener('input', () => { Promise.resolve(aoFocar?.()).then(sugerir).catch(() => {}); });
  entrada.addEventListener('keydown', (ev) => {
    const n = estado.sugestoes.length;
    if (ev.key === 'ArrowDown' && n) { ev.preventDefault(); if (lista.hidden) sugerir(); marcar((estado.ativa + 1) % n); }
    else if (ev.key === 'ArrowUp' && n) { ev.preventDefault(); marcar((estado.ativa - 1 + n) % n); }
    else if (ev.key === 'Enter' && !lista.hidden && n) { ev.preventDefault(); escolher(estado.sugestoes[Math.max(0, estado.ativa)]); }
    else if (ev.key === 'Escape') fechar();
  });
  entrada.addEventListener('blur', () => setTimeout(fechar, 100));
}
