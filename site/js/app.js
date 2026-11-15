import * as c from './calculos.js';
import * as f from './formato.js';
import * as t from './textos.js';
import { criarGrafico, preencherTabela, baixarCSV } from './graficos.js';
import { carregarPainel, carregarIndiceCidades, carregarCidade, carregarIndiceCota, carregarCotaAno, carregarPortal } from './dados.js';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const campo = (nome) => document.querySelectorAll(`[data-campo="${nome}"]`);
const definir = (nome, texto) => campo(nome).forEach((e) => { e.textContent = texto; });

// Resumos em tópicos: uma frase por item, mais fácil de achar cada número.
// A frase termina em ". " seguido de maiúscula; "R$ 1.621" não quebra.
function definirTopicos(nome, texto) {
  const partes = texto.trim().split(/\.\s+(?=[A-ZÀ-Ý])/);
  const frases = partes.map((fr, i) => (i < partes.length - 1 ? `${fr}.` : fr)).filter((fr) => fr.trim());
  campo(nome).forEach((e) => {
    // Uma frase só é a resposta da seção: parágrafo, sem marcador.
    if (frases.length === 1) {
      e.replaceChildren(el('p', 'resposta', frases[0]));
      return;
    }
    const lista = document.createElement('ul');
    frases.forEach((fr) => el('li', null, fr, lista));
    e.replaceChildren(lista);
  });
}

function el(tag, classe, texto, pai) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto;
  if (pai) pai.appendChild(e);
  return e;
}

function valorRadio(nome) {
  return document.querySelector(`input[name="${nome}"]:checked`)?.value;
}

// ---------------------------------------------------------------------------

function preparar(d) {
  const meses = c.listaMeses(d.mensal.inicio, d.mensal.fim);
  const s = d.mensal.series;
  const ipca = c.indiceAcumulado(s.ipca_var);
  const mandatos = d.mandatos;
  const grupos = d.mensal.arrecadacao_grupos;
  const total = c.arrecadacaoMensal(grupos, false);
  const comparavel = c.arrecadacaoMensal(grupos, true);
  const comparavelReal = c.deflacionar(comparavel, ipca);
  const anual = c.anualArrecadacao(meses, comparavel, comparavelReal, s.pib_mensal)
    .filter((l) => l.ano >= 2000);
  const referencia = meses[c.ultimoIndice(ipca)];
  return { d, meses, s, ipca, mandatos, grupos, total, comparavel, comparavelReal, anual, referencia };
}

const rotuloMesNoEixo = (passoAnos) => (mes) => {
  const ano = c.anoDe(mes);
  return c.mesDoAno(mes) === 1 && ano % passoAnos === 0 ? String(ano) : null;
};

function textoGoverno(ctx, mes) {
  const g = c.governoDoMes(ctx.mandatos, mes);
  return g ? `Governo: ${g.rotulo} (${g.partido})` : null;
}

// ---------------------------------------------------------------------------
// Contador
// ---------------------------------------------------------------------------

function iniciarContador(ctx) {
  const dados = c.arrecadometro(ctx.meses, ctx.total);
  if (!dados) return;
  const [primeiro] = dados.mesesConfirmados;
  const ultimo = dados.mesesConfirmados[dados.mesesConfirmados.length - 1];
  definir('ano-atual', String(dados.anoAtual));
  definir('meses-confirmados', primeiro
    ? `${f.mesCurto(primeiro).split('/')[0]} a ${f.mesCurto(ultimo)}`
    : 'nenhum mês ainda');
  definir('confirmado', f.reaisCompacto(dados.confirmado));
  definir('inicio-estimativa', new Date(dados.inicioEstimativa).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
  definir('arrec-ultimo', f.mesCurto(dados.ultimoMes));

  const alvo = campo('contador')[0];
  const estimado = campo('estimado')[0];
  const formatoCheio = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const reduzir = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const intervalo = reduzir ? 1000 : 100;

  const curto = campo('contador-curto')[0];
  const atualizar = () => {
    const agora = Date.now();
    const est = dados.estimadoEm(agora);
    alvo.textContent = `R$\u00A0${formatoCheio.format(dados.confirmado + est)}`;
    estimado.textContent = f.reaisCompacto(est);
    if (curto) curto.textContent = f.reaisPorExtenso(dados.confirmado + est);
  };
  atualizar();
  let timer = setInterval(atualizar, intervalo);
  document.addEventListener('visibilitychange', () => {
    clearInterval(timer);
    if (!document.hidden) { atualizar(); timer = setInterval(atualizar, intervalo); }
  });
  alvo.setAttribute('aria-label', `Estimativa: ${f.reaisCompacto(dados.confirmado + dados.estimadoEm(Date.now()))}`);
}

// ---------------------------------------------------------------------------
// Arrecadação
// ---------------------------------------------------------------------------

function montarArrecadacao(ctx) {
  const { anual, mandatos, referencia } = ctx;
  const anos = anual.map((l) => l.ano);
  const parciais = new Set(anual.map((l, i) => (l.parcial ? i : -1)).filter((i) => i >= 0));
  const faixas = c.faixasAnuais(mandatos, anos);
  const ultimoParcial = anual.find((l) => l.parcial);

  const completos = anual.filter((l) => !l.parcial);
  const ultimoAno = completos[completos.length - 1];
  if (ultimoAno) {
    let resumo = `Em ${ultimoAno.ano}, o governo federal arrecadou ${f.reaisPorExtenso(ultimoAno.real * 1e6)} em impostos e contribuições, `
      + 'em dinheiro de hoje e sem contar o INSS.';
    const v = t.variacao(ultimoAno.variacaoReal);
    if (v) resumo += ` Descontada a inflação, foi ${v} que em ${ultimoAno.ano - 1}.`;
    if (ultimoAno.carga != null) {
      resumo += ` De cada ${f.moeda(100, 0)} produzidos no país, ${f.moeda(ultimoAno.carga, 0)} foram para esses tributos.`;
    }
    if (ultimoParcial && ultimoParcial.variacaoReal != null) {
      resumo += ` Em ${ultimoParcial.ano}, nos ${ultimoParcial.meses} meses já publicados, a arrecadação foi ${t.variacao(ultimoParcial.variacaoReal)} que nos mesmos meses de ${ultimoParcial.ano - 1}.`;
    }
    definirTopicos('arrec-resumo', resumo);
  }

  const configurar = (medida) => {
    const real = medida === 'real';
    return {
      tipo: 'colunas',
      rotulos: anos,
      faixas,
      series: [{
        nome: real ? 'Arrecadação federal, em dinheiro de hoje' : 'Arrecadação federal como parte da economia (PIB)',
        classe: 'serie-1',
        valores: anual.map((l) => (real ? l.real / 1e3 : l.carga)),
        parciais: real ? parciais : new Set(),
        notaParcial: (i) => `soma de ${anual[i].meses} meses`,
      }],
      formatoY: real
        ? (v, eixo) => (eixo ? `${f.numero(v, 0)}` : `R$\u00A0${f.numero(v, 1)} bi`)
        : (v) => f.porcentagem(v, 1),
      unidade: real ? 'bilhões de reais de hoje' : '% de tudo o que o país produz no ano (PIB)',
      rotuloEixoX: (ano) => String(ano),
      tituloTooltip: (i) => (anual[i].parcial ? `${anos[i]} (${anual[i].meses} meses)` : String(anos[i])),
      extraTooltip: (i) => {
        const g = c.governoDoAno(mandatos, anos[i]);
        const v = anual[i].variacaoReal;
        const partes = [];
        if (g) partes.push(`Governo: ${g.rotulo} (${g.partido})`);
        if (v != null) partes.push(`Frente ao ano anterior, sem a inflação: ${f.porcentagem(v, 1, true)}`);
        return partes.join(' · ');
      },
      descricao: real
        ? `Arrecadação federal por ano, em bilhões de reais de ${f.mesLongo(referencia)}.`
        : 'Arrecadação federal por ano, como parte de tudo o que o país produz (PIB).',
    };
  };

  const notaMedida = (medida) => {
    const base = medida === 'real'
      ? `Valores em bilhões de reais, em dinheiro de ${f.mesLongo(referencia)} (corrigidos pela inflação medida pelo IPCA).`
      : 'Arrecadação dividida por tudo o que o país produziu nos mesmos meses (o PIB). O PIB de cada mês é uma estimativa do Banco Central.';
    const parcial = ultimoParcial
      ? ` ${ultimoParcial.ano} tem só ${ultimoParcial.meses} meses publicados${medida === 'real' ? ' e aparece em tom mais claro' : ''}.`
      : '';
    return base + parcial;
  };

  const grafico = criarGrafico($('#grafico-arrecadacao'), configurar('real'));
  definir('arrec-nota', notaMedida('real'));
  document.querySelectorAll('input[name="arrec-medida"]').forEach((r) => r.addEventListener('change', () => {
    const medida = valorRadio('arrec-medida');
    grafico.atualizar(configurar(medida));
    definir('arrec-nota', notaMedida(medida));
  }));

  preencherTabela($('#tabela-arrecadacao-anual'),
    ['Ano', 'Em dinheiro de hoje (R$ bilhões)', 'Parte da economia (PIB)', 'Frente ao ano anterior, sem a inflação'],
    anual.map((l) => [
      l.parcial ? `${l.ano} (${l.meses} meses)` : String(l.ano),
      f.numero(l.real / 1e3, 1),
      f.porcentagem(l.carga, 2),
      f.porcentagem(l.variacaoReal, 1, true),
    ]));

  const desenharGovernos = () => {
    const agrupar = valorRadio('arrec-agrupar') === 'partido';
    const excluir = $('#arrec-excluir-primeiro').checked;
    const resumo = c.resumoPorGoverno(anual, mandatos, ['carga', 'variacaoReal'],
      { excluirPrimeiroAno: excluir, agruparPorPartido: agrupar });
    preencherTabela($('#tabela-arrecadacao-governos'),
      [agrupar ? 'Partido' : 'Mandato', 'Parte da economia (PIB), média dos anos', 'Crescimento por ano, sem a inflação (média)'],
      resumo.map((r) => [
        {
          texto: r.rotulo,
          detalhe: `${agrupar ? r.mandatos.join(', ') : r.partido} · ${descreverAnos(r)}`,
        },
        f.porcentagem(r.medias.carga, 2),
        r.anosComDado.variacaoReal ? f.porcentagem(r.medias.variacaoReal, 1, true) : 'sem dado',
      ]));
  };
  desenharGovernos();
  document.querySelectorAll('input[name="arrec-agrupar"]').forEach((r) => r.addEventListener('change', desenharGovernos));
  $('#arrec-excluir-primeiro').addEventListener('change', desenharGovernos);

  registrarDownload('arrecadacao', () => ({
    nome: 'arrecadacao-federal-mensal.csv',
    cabecalhos: ['mes', ...ctx.grupos.map((g) => `${g.grupo} (R$ milhões)`), 'total (R$ milhões)', 'comparável (R$ milhões)', `comparável real (R$ milhões de ${referencia})`],
    linhas: ctx.meses.map((m, i) => [m, ...ctx.grupos.map((g) => g.valores[i]), ctx.total[i], ctx.comparavel[i],
      ctx.comparavelReal[i] == null ? null : Math.round(ctx.comparavelReal[i] * 1000) / 1000])
      .filter((l) => l[l.length - 2] != null),
  }));
}

function descreverAnos(r) {
  if (!r.anos.length) {
    return r.excluidos.length ? 'só o 1º ano, excluído' : 'sem dados nesta base';
  }
  const texto = intervalos(r.anos);
  return r.parciais.length ? `${texto} (${r.parciais.join(', ')} incompleto)` : texto;
}

function intervalos(anos) {
  const ordenados = [...anos].sort((a, b) => a - b);
  const partes = [];
  let ini = ordenados[0];
  let ant = ordenados[0];
  for (const a of [...ordenados.slice(1), null]) {
    if (a !== ant + 1) {
      partes.push(ini === ant ? String(ini) : `${ini} a ${ant}`);
      ini = a;
    }
    ant = a;
  }
  return partes.join(', ');
}

// ---------------------------------------------------------------------------
// Composição
// ---------------------------------------------------------------------------

function montarComposicao(ctx) {
  const iUlt = c.ultimoIndice(ctx.total);
  const inicio = iUlt - 11;
  const somas = ctx.grupos.map((g) => {
    let soma = 0;
    for (let i = inicio; i <= iUlt; i += 1) soma += g.valores[i] ?? 0;
    return { grupo: g.grupo, soma: soma * 1e6 };
  }).filter((g) => g.soma > 0).sort((a, b) => b.soma - a.soma);
  const total = somas.reduce((a, g) => a + g.soma, 0);
  definir('composicao-periodo', `${f.mesCurto(ctx.meses[inicio])} a ${f.mesCurto(ctx.meses[iUlt])}, total de ${f.reaisCompacto(total)}`);
  if (somas.length >= 2) {
    const fatia = ((somas[0].soma + somas[1].soma) / total) * 100;
    const pct = (g) => f.porcentagem((g.soma / total) * 100, 0);
    const abertura = fatia > 50 ? 'Mais da metade veio de duas fontes' : `Duas fontes somaram ${f.porcentagem(fatia, 0)}`;
    definirTopicos('composicao-resumo',
      `De ${f.mesLongo(ctx.meses[inicio])} a ${f.mesLongo(ctx.meses[iUlt])}, o governo federal arrecadou ${f.reaisPorExtenso(total)}. `
      + `${abertura}: ${t.nomeDoTributo(somas[0].grupo)} (${pct(somas[0])}) e ${t.nomeDoTributo(somas[1].grupo)} (${pct(somas[1])}).`);
  }
  const lista = $('#lista-composicao');
  lista.replaceChildren();
  // A barra mostra a parte do total: 32% ocupa 32% do trilho.
  for (const g of somas) {
    const li = el('li', null, null, lista);
    const topo = el('div', 'barra-topo', null, li);
    const nome = el('span', 'barra-nome', t.nomeDoTributo(g.grupo), topo);
    const explica = t.TRIBUTOS[g.grupo]?.explica;
    if (explica) el('span', 'barra-explica', explica, nome);
    const pct = (g.soma / total) * 100;
    el('span', 'barra-valor', `${f.porcentagem(pct, pct < 1 ? 1 : 0)} · ${f.reaisCompacto(g.soma)}`, topo);
    const trilho = el('div', 'barra-trilho', null, li);
    trilho.setAttribute('aria-hidden', 'true');
    const barra = el('div', 'barra', null, trilho);
    barra.style.width = `${Math.max(1, (g.soma / total) * 100)}%`;
  }
}

// Impostos de estados (12 meses até o último mês que os 27 já informaram,
// com a arrecadação federal dos mesmos meses) e de prefeituras e do país
// (último ano da estimativa anual do Tesouro).
function montarComposicaoEstados(ctx) {
  const linhas = [];
  const rec = ctx.d.estados_receita;
  const ate = rec?.doze_meses_ate;
  const estadosCompletos = ate && Array.isArray(rec.estados) && rec.estados.length >= 27
    && rec.estados.every((x) => x.doze_meses?.icms != null && x.doze_meses?.ipva != null && x.doze_meses?.itcd != null);
  if (estadosCompletos) {
    const soma = (chave) => rec.estados.reduce((total, x) => total + x.doze_meses[chave], 0);
    const icms = soma('icms');
    const ipva = soma('ipva');
    const itcd = soma('itcd');
    linhas.push({ rotulo: 'Estados', texto: `nos 12 meses até ${f.mesLongo(ate)}, os estados e o Distrito Federal arrecadaram ${f.reaisPorExtenso(icms)} de ICMS, `
      + `${f.reaisPorExtenso(ipva)} de IPVA e ${f.reaisPorExtenso(itcd)} de ITCMD (herança e doação).` });
    const k = ctx.meses.indexOf(ate);
    const janela = k >= 11 ? ctx.total.slice(k - 11, k + 1) : [];
    if (janela.length === 12 && janela.every((v) => v != null)) {
      const federal = janela.reduce((a, v) => a + v, 0) * 1e6;
      linhas.push({ rotulo: null, texto: `No mesmo período, a arrecadação federal foi de ${f.reaisPorExtenso(federal)}: para cada R$ 100 federais, `
        + `os estados arrecadaram ${f.moeda(((icms + ipva + itcd) / federal) * 100, 0)} com esses três impostos.` });
    }
  }
  const ctb = ctx.d.carga_tributaria;
  const ultimo = ctb?.anos?.length ? ctb.anos.length - 1 : -1;
  const item = (chave, campo = 'milhoes') => (ultimo >= 0 ? ctb.itens?.[chave]?.[campo]?.[ultimo] ?? null : null);
  if (ultimo >= 0) {
    const ano = ctb.anos[ultimo];
    const iss = item('municipios_iss');
    const iptu = item('municipios_iptu');
    const itbi = item('municipios_itbi');
    if (iss != null && iptu != null && itbi != null) {
      linhas.push({ rotulo: 'Prefeituras', texto: `em ${ano}, arrecadaram ${f.reaisPorExtenso((iss + iptu + itbi) * 1e6)} com ISS, IPTU e ITBI, `
        + `pela estimativa anual do Tesouro Nacional (${f.reaisPorExtenso(iss * 1e6)} de ISS, ${f.reaisPorExtenso(iptu * 1e6)} de IPTU e ${f.reaisPorExtenso(itbi * 1e6)} de ITBI).` });
    }
    const total = item('governo_geral_total');
    const pct = item('governo_geral_total', 'pct_pib');
    if (total != null && pct != null) {
      linhas.push({ rotulo: 'Tudo junto', texto: `em ${ano}, União, estados e prefeituras cobraram ${f.reaisPorExtenso(total * 1e6)} em tributos, `
        + `ou ${f.moeda(pct, 0)} de cada R$ 100 que o país produziu.` });
    }
  }
  if (!linhas.length) return;
  definirItens('composicao-estados', linhas);
  $('#composicao-estados-caixa').hidden = false;
}

// ---------------------------------------------------------------------------
// Para onde vai o dinheiro do governo federal
// ---------------------------------------------------------------------------

// Base de comparação: despesa total sem a rolagem da dívida (dívida velha paga
// com dívida nova). "De cada R$ 100" usa essa base.
function prepararGastos(ctx) {
  const g = ctx.d.gastos_federais;
  if (!g?.anos?.length || !Array.isArray(g.contas)) return null;
  const n = g.anos.length;
  const total = c.somarContas(g.contas, ['total'], n);
  const rolagem = c.somarContas(g.contas, t.ROLAGEM, n);
  const base = total.map((v, k) => (v == null ? null : v - (rolagem[k] ?? 0)));
  const areas = t.AREAS_DE_GASTO.map((a) => ({ ...a, valores: c.somarContas(g.contas, a.contas, n) }))
    .filter((a) => a.valores.some((v) => v != null));
  const fatores = c.fatoresAnuais(ctx.meses, ctx.ipca, g.anos);
  return { anos: g.anos, total, rolagem, base, areas, fatores };
}

const porCem = (v) => f.moeda(v, v < 1 ? 1 : 0);

function montarGastos(ctx) {
  const dados = prepararGastos(ctx);
  if (!dados) { $('#gastos').hidden = true; return; }
  const { anos, rolagem, base, areas, fatores } = dados;

  // Lista do ano escolhido -------------------------------------------------
  const selAno = $('#gastos-ano');
  selAno.replaceChildren();
  [...anos].reverse().forEach((ano) => { el('option', null, String(ano), selAno).value = String(ano); });

  const desenharAno = () => {
    const k = anos.indexOf(Number(selAno.value));
    const totalAno = base[k] * 1e6;
    const doAno = areas.map((a) => ({ ...a, valor: (a.valores[k] ?? 0) * 1e6 }))
      .filter((a) => a.valor > 0).sort((x, y) => y.valor - x.valor);
    const grandes = doAno.filter((a) => a.valor / totalAno >= 0.01);
    const pequenas = doAno.filter((a) => a.valor / totalAno < 0.01);

    const cinco = grandes.slice(0, 5).map((a) => `${porCem((a.valor / totalAno) * 100)} para ${a.nome.toLowerCase().replace('inss', 'INSS')}`);
    definirTopicos('gastos-resumo',
      `Em ${anos[k]}, o governo federal gastou ${f.reaisPorExtenso(totalAno)}, sem contar a rolagem da dívida. `
      + `De cada R$ 100, foram ${listaDeAnos(cinco)}. `
      + `A rolagem, quando o governo paga dívida que venceu com dívida nova, somou mais ${f.reaisPorExtenso(rolagem[k] * 1e6)} e fica fora dessa conta.`);

    const lista = $('#lista-gastos');
    lista.replaceChildren();
    const linha = (nome, explica, valor) => {
      const li = el('li', null, null, lista);
      const topo = el('div', 'barra-topo', null, li);
      const rotulo = el('span', 'barra-nome', nome, topo);
      if (explica) el('span', 'barra-explica', explica, rotulo);
      el('span', 'barra-valor', `${porCem((valor / totalAno) * 100)} de cada R$ 100 · ${f.reaisCompacto(valor)}`, topo);
      const trilho = el('div', 'barra-trilho', null, li);
      trilho.setAttribute('aria-hidden', 'true');
      el('div', 'barra', null, trilho).style.width = `${Math.max(1, (valor / totalAno) * 100)}%`;
    };
    grandes.forEach((a) => linha(a.nome, a.explica, a.valor));
    if (pequenas.length) {
      linha(`Outras ${pequenas.length} áreas`, pequenas.map((a) => a.nome).join(', '),
        pequenas.reduce((soma, a) => soma + a.valor, 0));
    }
  };
  selAno.addEventListener('change', desenharAno);
  desenharAno();

  // Comparação ao longo dos anos -----------------------------------------
  const selA = $('#gastos-area-a');
  const selB = $('#gastos-area-b');
  const opcoes = [...areas].sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'));
  for (const sel of [selA, selB]) {
    sel.replaceChildren();
    if (sel === selB) el('option', null, 'Nenhuma', sel).value = '';
    opcoes.forEach((a) => { el('option', null, a.nome, sel).value = a.id; });
  }
  selA.value = '10';
  selB.value = '12';
  const faixas = c.faixasAnuais(ctx.mandatos, anos);
  let grafico = null;

  const serieDe = (area, medida) => area.valores.map((v, k) => {
    if (v == null) return null;
    if (medida === 'parte') return base[k] ? (v / base[k]) * 100 : null;
    return fatores[k] == null ? null : (v * fatores[k]) / 1e3;
  });

  const desenharComparacao = () => {
    const medida = valorRadio('gastos-medida') ?? 'real';
    const a = areas.find((x) => x.id === selA.value) ?? areas[0];
    const b = areas.find((x) => x.id === selB.value && x.id !== a.id);
    const sa = serieDe(a, medida);
    const kUlt = c.ultimoIndice(sa);
    const kIni = sa.findIndex((v) => v != null);
    if (medida === 'parte') {
      definirTopicos('gastos-comparacao',
        `Em ${anos[kUlt]}, ${a.nome.toLowerCase()} ficou com ${porCem(sa[kUlt])} de cada R$ 100 gastos pelo governo federal. Em ${anos[kIni]}, eram ${porCem(sa[kIni])}.`);
    } else {
      const v = t.variacao((sa[kUlt] / sa[kIni] - 1) * 100, 0);
      definirTopicos('gastos-comparacao',
        `Em ${anos[kUlt]}, o governo federal gastou ${f.reaisPorExtenso(sa[kUlt] * 1e9)} com ${a.nome.toLowerCase()}, em dinheiro de hoje. `
        + `Em ${anos[kIni]}, foram ${f.reaisPorExtenso(sa[kIni] * 1e9)}${v ? `: ${v}, descontada a inflação` : ''}.`);
    }
    const series = [{ nome: a.nome, classe: 'serie-1', valores: sa }];
    if (b) series.push({ nome: b.nome, classe: 'serie-2', valores: serieDe(b, medida) });
    const opcoesGrafico = {
      tipo: 'linhas',
      rotulos: anos,
      faixas,
      series,
      formatoY: medida === 'parte'
        ? (v, eixo) => (eixo ? f.numero(v, v < 10 ? 1 : 0) : `${porCem(v)} de cada R$ 100`)
        : (v, eixo) => (eixo ? f.numero(v, 0) : `R$\u00A0${f.numero(v, 1)} bi`),
      unidade: medida === 'parte' ? 'reais de cada R$ 100 gastos' : 'bilhões de reais de hoje',
      rotuloEixoX: (ano) => String(ano),
      tituloTooltip: (i) => String(anos[i]),
      extraTooltip: (i) => {
        const gov = c.governoDoAno(ctx.mandatos, anos[i]);
        return gov ? `Governo: ${gov.rotulo} (${gov.partido})` : null;
      },
      descricao: medida === 'parte'
        ? 'Parte de cada área no gasto federal, sem a rolagem da dívida, por ano.'
        : 'Gasto federal por área, por ano, em bilhões de reais de hoje.',
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoesGrafico); else grafico = criarGrafico($('#grafico-gastos'), opcoesGrafico);
  };
  selA.addEventListener('change', desenharComparacao);
  selB.addEventListener('change', desenharComparacao);
  document.querySelectorAll('input[name="gastos-medida"]').forEach((r) => r.addEventListener('change', desenharComparacao));
  desenharComparacao();

  registrarDownload('gastos', () => ({
    nome: 'gastos-federais-por-area.csv',
    cabecalhos: ['ano', 'total sem rolagem (R$ milhões)', 'rolagem da divida (R$ milhões)', ...areas.map((a) => `${a.nome} (R$ milhões)`), `fator para dinheiro de ${ctx.referencia}`],
    linhas: anos.map((ano, k) => [ano, arred(base[k], 3), arred(rolagem[k], 3), ...areas.map((a) => arred(a.valores[k], 3)), arred(fatores[k], 6)]),
  }));
}

// ---------------------------------------------------------------------------
// As contas do governo federal fecham?
// ---------------------------------------------------------------------------

// As séries do Banco Central (NFSP) vêm com positivo = déficit. Aqui o sinal
// é invertido para a leitura do dia a dia: positivo = sobrou, negativo = faltou.
function montarContas(ctx) {
  const { meses, s, ipca, mandatos } = ctx;
  if (!Array.isArray(s.nfsp_primario_pib) || !Array.isArray(s.divida_bruta_pib)) { $('#contas').hidden = true; return; }
  const inverter = (v) => (v == null ? null : -v);
  const pPib = c.valoresAnuais(meses, s.nfsp_primario_pib.map(inverter), 'fim');
  const jPib = c.valoresAnuais(meses, s.nfsp_juros_pib, 'fim');
  const nPib = c.valoresAnuais(meses, s.nfsp_nominal_pib.map(inverter), 'fim');
  const dPib = c.valoresAnuais(meses, s.divida_bruta_pib, 'fim');
  const pR = c.valoresAnuais(meses, s.nfsp_primario.map(inverter), 'soma');
  const jR = c.valoresAnuais(meses, s.nfsp_juros, 'soma');
  const nR = c.valoresAnuais(meses, s.nfsp_nominal.map(inverter), 'soma');
  const real = (serie) => c.valoresAnuais(meses, c.deflacionar(serie, ipca), 'soma');
  const pReal = real(s.nfsp_primario.map(inverter));
  const jReal = real(s.nfsp_juros);
  const nReal = real(s.nfsp_nominal.map(inverter));

  // Resumo: últimos 12 meses publicados.
  if (pPib.hoje && pR.hoje && jR.hoje && nR.hoje) {
    const ate = f.mesLongo(pPib.hoje.ate);
    const p = pR.hoje.valor * 1e6;
    const n = nR.hoje.valor * 1e6;
    const linhas = [];
    linhas.push(p >= 0
      ? `Nos 12 meses até ${ate}, o governo federal arrecadou ${f.reaisPorExtenso(p)} a mais do que gastou, sem contar os juros da dívida (${f.porcentagem(pPib.hoje.valor, 1)} de tudo o que o país produz em um ano, o PIB).`
      : `Nos 12 meses até ${ate}, o governo federal gastou ${f.reaisPorExtenso(-p)} a mais do que arrecadou, sem contar os juros da dívida (${f.porcentagem(-pPib.hoje.valor, 1)} de tudo o que o país produz em um ano, o PIB).`);
    linhas.push(`Os juros da dívida custaram ${f.reaisPorExtenso(jR.hoje.valor * 1e6)} (${f.porcentagem(jPib.hoje.valor, 1)} do que o país produz em um ano).`);
    linhas.push(n >= 0
      ? `Mesmo com os juros, sobraram ${f.reaisPorExtenso(n)} (${f.porcentagem(nPib.hoje.valor, 1)} do que o país produz em um ano).`
      : `Somando os juros, faltaram ${f.reaisPorExtenso(-n)} (${f.porcentagem(-nPib.hoje.valor, 1)} do que o país produz em um ano), cobertos com dívida nova.`);
    if (dPib.hoje) {
      linhas.push(`A dívida bruta do governo (União, estados e municípios) equivale a ${f.porcentagem(dPib.hoje.valor, 0)} de tudo o que o país produz em um ano (${f.mesLongo(dPib.hoje.ate)}): para cada R$ 100 que o país produz em um ano, o governo deve ${f.moeda(dPib.hoje.valor, 0)}.`);
    }
    definirTopicos('contas-resumo', linhas.join(' '));
  }

  // Gráfico por ano --------------------------------------------------------
  const anos = [...new Set([...pPib.anos.keys(), ...dPib.anos.keys()])].filter((a) => a >= 1995).sort((a, b) => a - b);
  const faixas = c.faixasAnuais(mandatos, anos);
  const visoes = {
    primario: {
      nome: 'Sem os juros: sobrou (+) ou faltou (−)', pib: pPib, real: pReal,
      explicacao: 'Diferença entre o que o governo federal arrecadou e o que gastou no ano, sem contar os juros da dívida. Acima de zero, sobrou dinheiro (superávit); abaixo, faltou (déficit).',
    },
    juros: {
      nome: 'Juros da dívida', pib: jPib, real: jReal,
      explicacao: 'Quanto a dívida custou em juros no ano.',
    },
    nominal: {
      nome: 'Com os juros: sobrou (+) ou faltou (−)', pib: nPib, real: nReal,
      explicacao: 'O que sobrou ou faltou depois de pagar os juros. Quando falta, o governo pega dinheiro emprestado e a dívida cresce.',
    },
    divida: {
      nome: 'Dívida bruta do governo', pib: dPib, real: null,
      explicacao: 'Tudo o que União, estados e municípios devem, comparado com o que o país produz em um ano. Valor de dezembro de cada ano; a série começa em 2006.',
    },
  };
  let grafico = null;
  const desenhar = () => {
    const chave = valorRadio('contas-visao') ?? 'primario';
    const v = visoes[chave];
    const medida = chave === 'divida' ? 'pib' : (valorRadio('contas-medida') ?? 'pib');
    $('#contas-medida-caixa').hidden = chave === 'divida';
    const fonte = medida === 'pib' ? v.pib : v.real;
    const valores = anos.map((a) => fonte.anos.get(a) ?? null).map((x) => (x == null ? null : (medida === 'pib' ? x : x / 1e3)));
    definir('contas-explicacao', v.explicacao);
    const opcoes = {
      tipo: 'colunas',
      rotulos: anos,
      faixas,
      series: [{ nome: v.nome, classe: 'serie-1', valores, parciais: new Set() }],
      formatoY: medida === 'pib'
        ? (x, eixo) => (eixo ? f.numero(x, 0) : `${f.porcentagem(x, 1)} do que o país produz`)
        : (x, eixo) => (eixo ? f.numero(x, 0) : `R$\u00A0${f.numero(x, 1)} bi`),
      unidade: medida === 'pib' ? '% de tudo o que o país produz no ano (PIB)' : 'bilhões de reais de hoje',
      rotuloEixoX: (ano) => (ano % 5 === 0 ? String(ano) : null),
      tituloTooltip: (i) => String(anos[i]),
      extraTooltip: (i) => {
        const g = c.governoDoAno(mandatos, anos[i]);
        return g ? `Governo: ${g.rotulo} (${g.partido})` : null;
      },
      descricao: `${v.nome}, por ano, ${medida === 'pib' ? 'em % de tudo o que o país produz no ano' : 'em bilhões de reais de hoje'}.`,
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-contas'), opcoes);
  };
  document.querySelectorAll('input[name="contas-visao"], input[name="contas-medida"]').forEach((r) => r.addEventListener('change', desenhar));
  desenhar();

  // Por governo -------------------------------------------------------------
  const linhasAno = anos.map((a) => ({ ano: a, primario: pPib.anos.get(a) ?? null, nominal: nPib.anos.get(a) ?? null, divida: dPib.anos.get(a) ?? null }));
  const resumo = c.resumoPorGoverno(linhasAno, mandatos, ['primario', 'nominal']);
  const sinal = (x) => (x == null ? 'sem dado' : f.porcentagem(x, 1, true));
  preencherTabela($('#tabela-contas-governos'),
    ['Mandato', 'Sem os juros: sobrou (+) ou faltou (−), média por ano, % da economia', 'Com os juros: sobrou (+) ou faltou (−), média por ano, % da economia', 'Dívida no fim, % da economia'],
    resumo.map((r) => {
      const ultimo = r.anos.length ? Math.max(...r.anos) : null;
      const divida = ultimo != null ? dPib.anos.get(ultimo) : null;
      return [
        { texto: r.rotulo, detalhe: `${r.partido} · ${descreverAnos(r)}` },
        r.anosComDado.primario ? sinal(r.medias.primario) : 'sem dado',
        r.anosComDado.nominal ? sinal(r.medias.nominal) : 'sem dado',
        divida == null ? 'sem dado' : f.porcentagem(divida, 0),
      ];
    }),
    'Positivo: sobrou dinheiro. Negativo: faltou.');

  registrarDownload('contas', () => ({
    nome: 'contas-publicas-por-ano.csv',
    cabecalhos: ['ano', 'antes dos juros (% PIB, + sobrou)', 'juros (% PIB)', 'resultado final (% PIB, + sobrou)', 'divida bruta (% PIB, dezembro)',
      `antes dos juros (R$ milhões de ${ctx.referencia})`, `juros (R$ milhões de ${ctx.referencia})`, `resultado final (R$ milhões de ${ctx.referencia})`],
    linhas: anos.map((a) => [a, pPib.anos.get(a) ?? null, jPib.anos.get(a) ?? null, nPib.anos.get(a) ?? null, dPib.anos.get(a) ?? null,
      arred(pReal.anos.get(a) ?? null, 1), arred(jReal.anos.get(a) ?? null, 1), arred(nReal.anos.get(a) ?? null, 1)]),
  }));
}

// ---------------------------------------------------------------------------
// Contas dos estados (Relatório de Gestão Fiscal do Poder Executivo)
// ---------------------------------------------------------------------------

// Situação diante dos limites da lei, em palavras simples. "Perto do limite"
// começa no nível de alerta da lei (90% do limite). Os limites da folha vêm do
// relatório de cada estado (49% ou 48,6%); o da dívida é o da lei, igual para
// todos.
function situacao(valor, limite, alerta) {
  if (valor == null || limite == null) return null;
  if (valor > limite) return 'acima do limite';
  if (alerta != null && valor > alerta) return 'perto do limite';
  return 'dentro do limite';
}

// Lista com rótulo em negrito no começo de cada item: [{ rotulo, texto }].
function definirItens(nome, itens) {
  campo(nome).forEach((e) => {
    const lista = document.createElement('ul');
    itens.forEach(({ rotulo, texto }) => {
      const li = el('li', null, null, lista);
      if (rotulo) el('strong', null, `${rotulo}: `, li);
      li.append(document.createTextNode(texto));
    });
    e.replaceChildren(lista);
  });
}

const REPASSE_PREFEITURAS = {
  icms: 'Um quarto fica com as prefeituras do estado.',
  ipva: 'Metade fica com a prefeitura onde o veículo é registrado.',
  itcd: '',
};

function montarEstados(ctx) {
  const bloco = ctx.d.estados_fiscal;
  if (!bloco?.anos?.length || !Array.isArray(bloco.estados) || !bloco.estados.length) { $('#estados').hidden = true; return; }
  const { anos, estados } = bloco;
  const limiteDivida = bloco.limite_divida_pct ?? 200;
  const alertaDivida = bloco.alerta_divida_pct ?? 180;
  const ind = (uf, chave, k) => uf.indicadores?.[chave]?.[k] ?? null;
  // Os percentuais viram "R$ X de cada R$ 100". Centavos só perto de um
  // limite, para que "R$ 49" não pareça igual ao limite de R$ 49.
  const porCemReais = (v, ...referencias) => f.moeda(v, referencias.some((r) => r != null && Math.abs(v - r) < 1) ? 2 : 0);
  const limiteReais = (v) => f.moeda(v, Number.isInteger(v) ? 0 : 2);
  const fraseSituacao = { 'acima do limite': 'Está acima do limite.', 'perto do limite': 'Está perto do limite.', 'dentro do limite': 'Está dentro do limite.' };

  // Seletor de estado: em ordem alfabética; começa no estado da cidade
  // escolhida, se houver.
  const selUf = $('#estados-uf');
  selUf.replaceChildren();
  // Sem cidade escolhida, nenhum estado vem marcado: abrir sempre no Acre,
  // só por ser o primeiro da ordem alfabética, não ajuda ninguém.
  el('option', null, 'Escolha o estado', selUf).value = '';
  estados.forEach((uf) => { el('option', null, uf.nome, selUf).value = uf.sigla; });
  let escolhidoPelaPessoa = false;
  const ufDaCidade = () => (cidade.dados?.uf && estados.some((x) => x.sigla === cidade.dados.uf) ? cidade.dados.uf : null);
  selUf.value = ufDaCidade() ?? '';

  const rec = ctx.d.estados_receita;
  const temReceita = Array.isArray(rec?.anos) && rec.anos.length && Array.isArray(rec.estados) && rec.estados.length;
  const fatoresReceita = temReceita ? c.fatoresAnuais(ctx.meses, ctx.ipca, rec.anos) : [];
  const cap = ctx.d.capitais_receita;
  const temCapitais = Array.isArray(cap?.anos) && cap.anos.length && Array.isArray(cap.capitais) && cap.capitais.length;
  const fatoresCapitais = temCapitais ? c.fatoresAnuais(ctx.meses, ctx.ipca, cap.anos) : [];
  const estadoAtual = () => estados.find((x) => x.sigla === selUf.value) ?? estados[0];
  const capitalDe = (uf) => (temCapitais ? cap.capitais.find((x) => x.uf === uf.sigla) ?? null : null);
  // Em Brasília, ISS, IPTU e ITBI são cobrados pelo governo do Distrito Federal.
  const ehBrasilia = (capital) => capital?.codigo === '5300108';
  const quemCobra = (capital) => (ehBrasilia(capital) ? 'o governo do Distrito Federal' : `a prefeitura de ${capital.nome}`);

  // Resumo: dívida, folha e impostos, uma frase curta cada -----------------
  const desenharResumo = () => {
    const uf = estadoAtual();
    const itens = [];
    const kDiv = c.ultimoIndice(uf.indicadores?.dcl_rcl_pct ?? []);
    if (kDiv >= 0) {
      const v = ind(uf, 'dcl_rcl_pct', kDiv);
      const sit = situacao(v, limiteDivida, alertaDivida);
      itens.push({
        rotulo: 'Dívida',
        texto: v < 0
          ? `em ${anos[kDiv]}, o governo tinha mais dinheiro em caixa do que dívidas. ${fraseSituacao[sit]}`
          : `em ${anos[kDiv]}, o governo devia ${porCemReais(v, limiteDivida, alertaDivida)} para cada R$ 100 que entraram no ano. `
            + `A lei permite até ${limiteReais(limiteDivida)}. ${fraseSituacao[sit]}`,
      });
    }
    const kPes = c.ultimoIndice(uf.indicadores?.pessoal_rcl_pct ?? []);
    if (kPes >= 0) {
      const v = ind(uf, 'pessoal_rcl_pct', kPes);
      const limite = ind(uf, 'pessoal_limite_pct', kPes);
      const alerta = ind(uf, 'pessoal_alerta_pct', kPes);
      const sit = situacao(v, limite, alerta);
      itens.push({
        rotulo: 'Folha de pagamento',
        texto: `em ${anos[kPes]}, de cada R$ 100 que entraram, o governo gastou ${porCemReais(v, limite, alerta)} com salários e aposentadorias de servidores.`
          + (limite != null ? ` A lei permite até ${limiteReais(limite)}. ${fraseSituacao[sit]}` : ''),
      });
    }
    const doze = temReceita ? rec.estados.find((x) => x.sigla === uf.sigla)?.doze_meses : null;
    if (doze?.icms != null && doze.ipva != null && doze.itcd != null && rec.doze_meses_ate) {
      const total = doze.icms + doze.ipva + doze.itcd;
      itens.push({
        rotulo: 'Impostos',
        texto: `nos 12 meses até ${f.mesLongo(rec.doze_meses_ate)}, ${uf.sigla === 'DF' ? 'o Distrito Federal' : 'o estado'} arrecadou ${f.reaisPorExtenso(total)}. `
          + `O ICMS, imposto embutido no preço das mercadorias, respondeu por ${f.porcentagem((doze.icms / total) * 100, 0)} disso.`,
      });
    }
    const capital = capitalDe(uf);
    const dozeCap = capital?.doze_meses;
    if (dozeCap?.iss != null && dozeCap.iptu != null && dozeCap.itbi != null && capital.ultimo_mes) {
      const total = dozeCap.iss + dozeCap.iptu + dozeCap.itbi;
      itens.push({
        rotulo: ehBrasilia(capital) ? 'Impostos de Brasília' : `Prefeitura de ${capital.nome}`,
        texto: `nos 12 meses até ${f.mesLongo(capital.ultimo_mes)}, ${ehBrasilia(capital) ? 'o governo do Distrito Federal arrecadou' : 'arrecadou'} ${f.reaisPorExtenso(total)} com ISS, IPTU e ITBI. `
          + `O ISS, imposto sobre serviços, respondeu por ${f.porcentagem((dozeCap.iss / total) * 100, 0)} disso.`,
      });
    }
    definirItens('estados-resumo', itens);
  };

  // Dívida e folha, ano a ano ---------------------------------------------
  let grafico = null;
  const desenharGrafico = () => {
    const uf = estadoAtual();
    const visao = valorRadio('estados-visao') ?? 'divida';
    const valores = (uf.indicadores?.[visao === 'divida' ? 'dcl_rcl_pct' : 'pessoal_rcl_pct'] ?? []).map((v) => (v == null ? null : Number(v)));
    const limites = visao === 'divida'
      ? anos.map(() => limiteDivida)
      : anos.map((_, k) => ind(uf, 'pessoal_limite_pct', k));
    definir('estados-explicacao', visao === 'divida'
      ? 'Quanto o governo devia, em cada ano, para cada R$ 100 que entraram. A linha tracejada é o limite da lei. Abaixo de zero, tinha mais dinheiro em caixa do que dívidas.'
      : 'Quanto o governo gastou com salários e aposentadorias de servidores, em cada ano, de cada R$ 100 que entraram. A linha tracejada é o limite da lei.');
    const opcoes = {
      tipo: 'linhas',
      rotulos: anos,
      series: [
        { nome: uf.nome, classe: 'serie-1', valores },
        { nome: 'Limite da lei', classe: 'serie-limite', valores: limites, degrau: true },
      ],
      formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : (v == null ? 'sem dado' : `${porCemReais(v)} de cada R$ 100`)),
      unidade: 'reais para cada R$ 100 que entram no ano',
      rotuloEixoX: (ano) => String(ano),
      tituloTooltip: (i) => String(anos[i]),
      descricao: visao === 'divida'
        ? `Dívida do governo ${t.doEstado(uf.sigla, uf.nome)} para cada 100 reais que entraram, por ano, e o limite da lei.`
        : `Folha de pagamento do governo ${t.doEstado(uf.sigla, uf.nome)} de cada 100 reais que entraram, por ano, e o limite da lei.`,
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-estados'), opcoes);
  };

  // Impostos do estado e da capital, ano a ano ----------------------------
  const NOMES_TRIBUTO = { icms: 'ICMS', ipva: 'IPVA', itcd: 'ITCMD', iss: 'ISS', iptu: 'IPTU', itbi: 'ITBI' };
  const MUNICIPAIS = ['iss', 'iptu', 'itbi'];
  const selTributo = $('#estados-tributo');
  // As opções da prefeitura levam o nome da capital do estado escolhido.
  const montarOpcoesTributo = () => {
    const anterior = selTributo.value || 'icms';
    const capital = capitalDe(estadoAtual());
    selTributo.replaceChildren();
    if (temReceita) {
      const g = el('optgroup', null, null, selTributo);
      g.label = 'Do estado';
      ['icms', 'ipva', 'itcd'].forEach((x) => { el('option', null, NOMES_TRIBUTO[x], g).value = x; });
    }
    if (capital) {
      const g = el('optgroup', null, null, selTributo);
      g.label = ehBrasilia(capital) ? 'De Brasília (cobrados pelo Distrito Federal)' : `Da prefeitura de ${capital.nome}`;
      MUNICIPAIS.forEach((x) => { el('option', null, NOMES_TRIBUTO[x], g).value = x; });
    }
    selTributo.value = [...selTributo.options].some((o) => o.value === anterior) ? anterior : selTributo.options[0]?.value;
  };

  let graficoReceita = null;
  const desenharReceita = () => {
    if (!temReceita && !temCapitais) return;
    montarOpcoesTributo();
    const uf = estadoAtual();
    const tributo = selTributo.value;
    const municipal = MUNICIPAIS.includes(tributo);
    const capital = capitalDe(uf);
    const fonte = municipal ? capital : rec.estados.find((x) => x.sigla === uf.sigla);
    const anosSerie = municipal ? cap.anos : rec.anos;
    const fatores = municipal ? fatoresCapitais : fatoresReceita;
    const nome = NOMES_TRIBUTO[tributo];
    const reais = (fonte?.anual?.[tributo] ?? []).map((v, k) => (v == null || fatores[k] == null ? null : v * fatores[k]));
    const maior = Math.max(0, ...reais.filter((v) => v != null));
    const escala = maior >= 1e9 ? { div: 1e9, sufixo: 'bi', nome: 'bilhões' } : { div: 1e6, sufixo: 'mi', nome: 'milhões' };
    const valores = reais.map((v) => (v == null ? null : v / escala.div));
    const quem = municipal ? quemCobra(capital) : `o governo ${t.doEstado(uf.sigla, uf.nome)}`;
    const quemSemArtigo = quem.replace(/^(o|a) /, '');
    definir('estados-receita-explicacao',
      `${nome} arrecadado ${quem.startsWith('a ') ? 'pela' : 'pelo'} ${quemSemArtigo} em cada ano, em ${escala.nome} de reais de hoje. ${REPASSE_PREFEITURAS[tributo] ?? ''}`.trim());
    const opcoes = {
      tipo: 'colunas',
      rotulos: anosSerie,
      series: [{ nome, classe: 'serie-1', valores, parciais: new Set() }],
      formatoY: (v, eixo) => (eixo ? f.numero(v, maior / escala.div < 10 ? 1 : 0)
        : (v == null ? 'sem dado' : `R$ ${f.numero(v, 1)} ${escala.sufixo} em dinheiro de hoje`)),
      unidade: `${escala.nome} de reais de hoje`,
      rotuloEixoX: (ano) => String(ano),
      tituloTooltip: (i) => String(anosSerie[i]),
      descricao: `${nome} arrecadado ${quem.startsWith('a ') ? 'pela' : 'pelo'} ${quemSemArtigo} por ano, em ${escala.nome} de reais de hoje.`,
      incluirZero: true,
    };
    if (graficoReceita) graficoReceita.atualizar(opcoes); else graficoReceita = criarGrafico($('#grafico-estados-receita'), opcoes);
  };
  if (!temReceita && !temCapitais) {
    $('#estados-receita-caixa').hidden = true;
  } else {
    selTributo.addEventListener('change', desenharReceita);
    registrarDownload('estados-receita', () => {
      const linhas = [];
      if (temReceita) {
        rec.estados.forEach((x) => rec.anos.forEach((ano, k) => linhas.push(['estado', x.nome, x.sigla, ano,
          x.anual?.icms?.[k] ?? null, x.anual?.ipva?.[k] ?? null, x.anual?.itcd?.[k] ?? null, null, null, null, arred(fatoresReceita[k], 6)])));
      }
      if (temCapitais) {
        cap.capitais.forEach((x) => cap.anos.forEach((ano, k) => linhas.push([ehBrasilia(x) ? 'capital (cobrados pelo DF)' : 'capital', x.nome, x.uf, ano,
          null, null, null, x.anual?.iss?.[k] ?? null, x.anual?.iptu?.[k] ?? null, x.anual?.itbi?.[k] ?? null, arred(fatoresCapitais[k], 6)])));
      }
      return {
        nome: 'impostos-de-estados-e-capitais-por-ano.csv',
        cabecalhos: ['tipo', 'nome', 'UF', 'ano', 'ICMS (R$)', 'IPVA (R$)', 'ITCMD (R$)', 'ISS (R$)', 'IPTU (R$)', 'ITBI (R$)', `fator para dinheiro de ${ctx.referencia}`],
        linhas,
      };
    });
  }

  // A linha do estado escolhido fica destacada na tabela de todos os estados.
  const marcarLinha = () => {
    const nome = estados.find((x) => x.sigla === selUf.value)?.nome;
    document.querySelectorAll('#tabela-estados tbody tr').forEach((tr) => {
      tr.classList.toggle('atual', !!nome && tr.querySelector('th')?.textContent === nome);
    });
  };
  const desenharTudo = () => {
    const escolhido = !!selUf.value;
    $('#estados-detalhe').hidden = !escolhido;
    if (escolhido) {
      desenharResumo(); desenharGrafico(); desenharReceita();
    } else {
      campo('estados-resumo').forEach((e) => e.replaceChildren(el('p', 'resumo-vazio',
        'Escolha um estado para ver a dívida, a folha de pagamento e os impostos do governo estadual e da capital. A tabela abaixo mostra todos os estados.')));
    }
    marcarLinha();
  };
  selUf.addEventListener('change', () => { escolhidoPelaPessoa = true; desenharTudo(); });
  document.querySelectorAll('input[name="estados-visao"]').forEach((r) => r.addEventListener('change', desenharGrafico));
  aoMudarCidade(() => {
    const sigla = ufDaCidade();
    if (sigla && !escolhidoPelaPessoa && sigla !== selUf.value) { selUf.value = sigla; desenharTudo(); }
  });
  desenharTudo();

  // Todos os estados ------------------------------------------------------
  const selAno = $('#estados-ano');
  selAno.replaceChildren();
  [...anos].reverse().forEach((ano) => { el('option', null, String(ano), selAno).value = String(ano); });
  const desenharTabela = () => {
    const k = anos.indexOf(Number(selAno.value));
    const acimaDivida = [];
    const acimaFolha = [];
    const linhas = estados.map((uf) => {
      const div = ind(uf, 'dcl_rcl_pct', k);
      const fol = ind(uf, 'pessoal_rcl_pct', k);
      const limite = ind(uf, 'pessoal_limite_pct', k);
      const alerta = ind(uf, 'pessoal_alerta_pct', k);
      const sitDiv = situacao(div, limiteDivida, alertaDivida);
      const sitFol = situacao(fol, limite, alerta);
      if (sitDiv === 'acima do limite') acimaDivida.push(uf.nome);
      if (sitFol === 'acima do limite') acimaFolha.push(uf.nome);
      const marca = (sit) => (sit === 'dentro do limite' ? null : sit);
      return [
        uf.nome,
        // Mesmas casas decimais na coluna toda: dívida em reais inteiros (os
        // limites são 200 e 180); folha com centavos (44,10, 46,55, 48,60, 49).
        div == null ? 'sem dado' : { texto: f.moeda(div, 0), detalhe: marca(sitDiv), destaque: sitDiv === 'acima do limite' },
        fol == null ? 'sem dado' : { texto: f.moeda(fol, 2), detalhe: marca(sitFol), destaque: sitFol === 'acima do limite' },
      ];
    });
    const frase = (lista, oque) => (lista.length
      ? `Em ${anos[k]}, ${lista.length === 1 ? '1 estado estava' : `${lista.length} estados estavam`} acima do limite ${oque}: ${listaDeAnos(lista)}.`
      : `Em ${anos[k]}, nenhum estado estava acima do limite ${oque}.`);
    definirTopicos('estados-todos', `${frase(acimaDivida, 'da dívida')} ${frase(acimaFolha, 'da folha de pagamento')}`);
    preencherTabela($('#tabela-estados'),
      ['Estado', 'Dívida: deve, para cada R$ 100', 'Folha: gasta, de cada R$ 100'],
      linhas,
      `A lei permite dívida de até ${limiteReais(limiteDivida)} e folha de até R$ 49 para cada R$ 100 que entram no ano (R$ 48,60 em alguns estados).`);
    marcarLinha();
  };
  selAno.addEventListener('change', desenharTabela);
  desenharTabela();

  registrarDownload('estados', () => ({
    nome: 'contas-dos-estados.csv',
    cabecalhos: ['estado', 'sigla', 'ano', 'receita corrente liquida (R$)', 'divida consolidada liquida (R$)', 'divida (% da RCL)',
      'limite da divida (% da RCL)', 'despesa com pessoal (R$)', 'pessoal (% da RCL)', 'limite de pessoal (% da RCL)',
      'limite prudencial (% da RCL)', 'limite de alerta de pessoal (% da RCL)'],
    linhas: estados.flatMap((uf) => anos.map((ano, k) => [uf.nome, uf.sigla, ano, ind(uf, 'rcl', k), ind(uf, 'dcl', k), ind(uf, 'dcl_rcl_pct', k),
      limiteDivida, ind(uf, 'pessoal', k), ind(uf, 'pessoal_rcl_pct', k), ind(uf, 'pessoal_limite_pct', k),
      ind(uf, 'pessoal_prudencial_pct', k), ind(uf, 'pessoal_alerta_pct', k)])),
  }));
}

// ---------------------------------------------------------------------------
// Portal da Transparência: ministérios, cartão corporativo e viagens
// ---------------------------------------------------------------------------

// Fator para trazer valores de um ano a dinheiro de hoje: IPCA de hoje sobre
// a média do IPCA dos meses daquele ano já publicados.
function fatorParaHoje(ctx, ano) {
  const { meses, ipca } = ctx;
  const ref = ipca[c.ultimoIndice(ipca)];
  const doAno = meses.map((m, i) => (c.anoDe(m) === ano ? ipca[i] : null)).filter((v) => v != null);
  return doAno.length && ref ? ref / (doAno.reduce((a, v) => a + v, 0) / doAno.length) : null;
}

const anoFechado = (d, ano) => (d.ate_mes[String(ano)] ?? 0) >= 12 && ano < new Date().getFullYear();

// Seletor de ano: o mais recente primeiro; começa no último ano fechado.
function preencherAnosPortal(sel, d) {
  sel.replaceChildren();
  [...d.anos].reverse().forEach((ano) => {
    const ate = d.ate_mes[String(ano)];
    const texto = anoFechado(d, ano) || !ate ? String(ano) : `${ano} (até ${f.mesCurto(`${ano}-${String(ate).padStart(2, '0')}`).split('/')[0]})`;
    el('option', null, texto, sel).value = String(ano);
  });
  sel.value = String([...d.anos].reverse().find((a) => anoFechado(d, a)) ?? d.anos[d.anos.length - 1]);
}

const nomeDoOrgao = (o, ano) => o.nomes[String(ano)] ?? Object.values(o.nomes).pop() ?? o.codigo;

// Lista de barras por órgão: os maiores e o resto somado em "outros".
function barrasDeOrgaos(lista, itens, total, { explicar, maximo = 10 } = {}) {
  lista.replaceChildren();
  const ordenados = [...itens].sort((a, b) => b.valor - a.valor);
  const grandes = ordenados.slice(0, maximo);
  const resto = ordenados.slice(maximo);
  if (resto.length) {
    grandes.push({ nome: `Outros ${resto.length} órgãos`, valor: resto.reduce((a, x) => a + x.valor, 0), outros: true });
  }
  for (const g of grandes) {
    const li = el('li', null, null, lista);
    const topo = el('div', 'barra-topo', null, li);
    const nome = el('span', 'barra-nome', g.nome, topo);
    const explica = g.outros ? null : explicar?.(g);
    if (explica) el('span', 'barra-explica', explica, nome);
    const pct = total > 0 ? (g.valor / total) * 100 : 0;
    el('span', 'barra-valor', `${f.porcentagem(pct, pct < 1 ? 1 : 0)} · ${f.reaisCompacto(g.valor)}`, topo);
    const trilho = el('div', 'barra-trilho', null, li);
    trilho.setAttribute('aria-hidden', 'true');
    el('div', 'barra', null, trilho).style.width = `${Math.max(1, pct)}%`;
  }
}

function periodoDoAno(d, ano) {
  const ate = d.ate_mes[String(ano)];
  return anoFechado(d, ano) || !ate ? `Em ${ano}` : `Em ${ano}, até ${f.mesLongo(`${ano}-${String(ate).padStart(2, '0')}`).replace(/ de \d{4}$/, '')}`;
}

// Tabela "por governo": média por ano, só anos fechados.
function tabelaPorGoverno(ctx, tabela, linhas, colunas) {
  const resumo = c.resumoPorGoverno(linhas, ctx.mandatos, colunas.map((x) => x.chave)).filter((r) => r.anos.length);
  preencherTabela(tabela, ['Mandato', ...colunas.map((x) => x.titulo)],
    resumo.map((r) => [
      { texto: r.rotulo, detalhe: `${r.partido} · ${descreverAnos(r)}` },
      ...colunas.map((x) => (r.anosComDado[x.chave] ? x.formato(r.medias[x.chave], r) : 'sem dado')),
    ]));
}

async function montarMinisterios(ctx) {
  const secao = $('#ministerios');
  let d;
  try {
    d = await carregarPortal('ministerios');
  } catch (erro) {
    console.error(erro);
    secao.hidden = true;
    return;
  }
  definir('ministerios-atualizado', f.dataCurta(d.atualizado_em));
  const selAno = $('#ministerios-ano');
  const selOrgao = $('#ministerios-orgao');
  preencherAnosPortal(selAno, d);
  let grafico = null;

  const itensDoAno = (ano) => {
    const fator = fatorParaHoje(ctx, ano) ?? 1;
    return d.orgaos.filter((o) => o.valores[String(ano)]).map((o) => {
      const [liquidado, repasse] = o.valores[String(ano)];
      return { o, nome: nomeDoOrgao(o, ano), valor: liquidado * fator, repasse: repasse * fator };
    }).filter((x) => x.valor > 0);
  };

  const desenharOrgao = () => {
    const o = d.orgaos.find((x) => x.codigo === selOrgao.value);
    if (!o) return;
    const anos = d.anos;
    const valores = anos.map((a) => (o.valores[String(a)] ? o.valores[String(a)][0] * (fatorParaHoje(ctx, a) ?? 1) / 1e9 : null));
    const parciais = new Set(anos.map((a, i) => (anoFechado(d, a) ? -1 : i)).filter((i) => i >= 0));
    const nomes = [...new Set(anos.map((a) => o.nomes[String(a)]).filter(Boolean))];
    definir('ministerios-explicacao', `Gasto por ano, em bilhões de reais de hoje, sem a dívida pública.${nomes.length > 1 ? ` O órgão teve mais de um nome: ${listaDeAnos(nomes)}.` : ''}`);
    const opcoes = {
      tipo: 'colunas',
      rotulos: anos,
      faixas: c.faixasAnuais(ctx.mandatos, anos),
      series: [{ nome: nomeDoOrgao(o, anos[anos.length - 1]), classe: 'serie-1', valores, parciais, notaParcial: (i) => `até ${f.mesCurto(`${anos[i]}-${String(d.ate_mes[String(anos[i])]).padStart(2, '0')}`)}` }],
      formatoY: (v, eixo) => (eixo ? f.numero(v, v < 10 ? 1 : 0) : `R$ ${f.numero(v, 1)} bi`),
      unidade: 'bilhões de reais de hoje',
      rotuloEixoX: (ano) => String(ano),
      tituloTooltip: (i) => `${anos[i]}: ${o.nomes[String(anos[i])] ?? 'sem dado'}`,
      descricao: `Gasto anual de ${nomeDoOrgao(o, anos[anos.length - 1])}, em bilhões de reais de hoje.`,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-ministerios'), opcoes);
  };

  const desenhar = () => {
    const ano = Number(selAno.value);
    const itens = itensDoAno(ano);
    const total = itens.reduce((a, x) => a + x.valor, 0);
    const fator = fatorParaHoje(ctx, ano) ?? 1;
    const div = d.divida[String(ano)] ?? { juros: 0, amortizacao: 0 };
    const top = [...itens].sort((a, b) => b.valor - a.valor).slice(0, 3);
    const pct = (v) => f.porcentagem((v / total) * 100, 0);
    definirItens('ministerios-resumo', [
      { rotulo: null, texto: `${periodoDoAno(d, ano)}, os ministérios e demais órgãos do governo federal gastaram ${f.reaisPorExtenso(total)}, sem contar a dívida pública (em dinheiro de hoje).` },
      { rotulo: null, texto: `Os que mais gastaram foram ${listaDeAnos(top.map((x) => `${x.nome} (${pct(x.valor)})`))}.` },
      { rotulo: null, texto: `A dívida pública, paga pelo Ministério da Fazenda, somou mais ${f.reaisPorExtenso(div.juros * fator)} em juros e ${f.reaisPorExtenso(div.amortizacao * fator)} em pagamento e troca de dívida. Esses valores ficam fora da lista.` },
    ]);
    barrasDeOrgaos($('#ministerios-lista'), itens, total, {
      explicar: (g) => (g.repasse / g.valor >= 0.1 ? `${f.porcentagem((g.repasse / g.valor) * 100, 0)} repassado a estados e prefeituras` : null),
    });
    const anterior = selOrgao.value;
    selOrgao.replaceChildren();
    [...itens].sort((a, b) => b.valor - a.valor).forEach((x) => { el('option', null, x.nome, selOrgao).value = x.o.codigo; });
    selOrgao.value = itens.some((x) => x.o.codigo === anterior) ? anterior : selOrgao.options[0]?.value ?? '';
    desenharOrgao();
  };
  selAno.addEventListener('change', desenhar);
  selOrgao.addEventListener('change', desenharOrgao);
  desenhar();

  registrarDownload('ministerios', () => ({
    nome: 'gastos-por-ministerio.csv',
    cabecalhos: ['ano', 'meses', 'codigo do orgao', 'orgao', 'liquidado sem divida (R$ da epoca)', 'repassado a estados e municipios (R$ da epoca)', 'fator para dinheiro de hoje'],
    linhas: d.anos.flatMap((a) => d.orgaos.filter((o) => o.valores[String(a)]).map((o) => [a, d.ate_mes[String(a)], o.codigo, nomeDoOrgao(o, a), ...o.valores[String(a)], arred(fatorParaHoje(ctx, a), 6)])),
  }));
}

async function montarCartao(ctx) {
  const secao = $('#cartao');
  let d;
  try {
    d = await carregarPortal('cartao');
  } catch (erro) {
    console.error(erro);
    secao.hidden = true;
    return;
  }
  definir('cartao-atualizado', f.dataCurta(d.atualizado_em));
  const selAno = $('#cartao-ano');
  preencherAnosPortal(selAno, d);
  // total, sigilo, saque, lançamentos
  const somaDoAno = (ano) => d.orgaos.reduce((acc, o) => {
    const v = o.valores[String(ano)];
    if (v) v.forEach((x, k) => { acc[k] += x; });
    return acc;
  }, [0, 0, 0, 0]);

  const desenhar = () => {
    const ano = Number(selAno.value);
    const fator = fatorParaHoje(ctx, ano) ?? 1;
    const [total, sigilo, saque, n] = somaDoAno(ano);
    const itens = d.orgaos.filter((o) => o.valores[String(ano)]).map((o) => {
      const [v, sg, sq] = o.valores[String(ano)];
      return { nome: nomeDoOrgao(o, ano), valor: v * fator, sigilo: sg * fator, saque: sq * fator };
    }).filter((x) => x.valor > 0);
    const maisSigilo = [...itens].filter((x) => x.sigilo > 0).sort((a, b) => b.sigilo - a.sigilo).slice(0, 2);
    const resumo = [
      { rotulo: null, texto: `${periodoDoAno(d, ano)}, o governo federal gastou ${f.reaisPorExtenso(total * fator)} no cartão corporativo, em ${f.numero(n, 0)} lançamentos (em dinheiro de hoje).` },
    ];
    if (sigilo > 0) {
      resumo.push({ rotulo: 'Sob sigilo', texto: `${f.reaisPorExtenso(sigilo * fator)}, ou ${f.porcentagem((sigilo / total) * 100, 0)} do total, sem detalhe do que foi comprado${maisSigilo.length ? `; a maior parte em ${listaDeAnos(maisSigilo.map((x) => x.nome))}` : ''}.` });
    }
    if (saque > 0) resumo.push({ rotulo: 'Saques em dinheiro', texto: `${f.reaisPorExtenso(saque * fator)}.` });
    definirItens('cartao-resumo', resumo);
    barrasDeOrgaos($('#cartao-lista'), itens, total * fator, {
      explicar: (g) => [g.sigilo > 0 ? `${f.reaisCompacto(g.sigilo)} sob sigilo` : null, g.saque > 0 ? `${f.reaisCompacto(g.saque)} em saques` : null].filter(Boolean).join(' · ') || null,
    });
  };
  selAno.addEventListener('change', desenhar);
  desenhar();

  const fechados = d.anos.filter((a) => anoFechado(d, a));
  const linhas = fechados.map((a) => {
    const fator = fatorParaHoje(ctx, a) ?? 1;
    const [total, sigilo, saque] = somaDoAno(a);
    return { ano: a, total: total * fator, sigilo: sigilo * fator, saque: saque * fator, parteSigilo: total > 0 ? (sigilo / total) * 100 : null };
  });
  criarGrafico($('#grafico-cartao'), {
    tipo: 'linhas',
    rotulos: fechados,
    faixas: c.faixasAnuais(ctx.mandatos, fechados),
    series: [
      { nome: 'Total', classe: 'serie-1', valores: linhas.map((l) => l.total / 1e6) },
      { nome: 'Sob sigilo', classe: 'serie-2', valores: linhas.map((l) => l.sigilo / 1e6) },
    ],
    formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : `R$ ${f.numero(v, 1)} mi`),
    unidade: 'milhões de reais de hoje',
    rotuloEixoX: (ano) => String(ano),
    tituloTooltip: (i) => String(fechados[i]),
    descricao: 'Gasto anual no cartão corporativo do governo federal e a parte sob sigilo, em milhões de reais de hoje.',
  });
  tabelaPorGoverno(ctx, $('#tabela-cartao-governos'), linhas, [
    { chave: 'total', titulo: 'Gasto por ano', formato: (v) => f.reaisCompacto(v) },
    { chave: 'sigilo', titulo: 'Sob sigilo, por ano', formato: (v) => f.reaisCompacto(v) },
    { chave: 'parteSigilo', titulo: 'Parte sob sigilo', formato: (v) => f.porcentagem(v, 0) },
  ]);

  registrarDownload('cartao', () => ({
    nome: 'cartao-corporativo-por-orgao.csv',
    cabecalhos: ['ano', 'meses', 'codigo do orgao', 'orgao', 'total (R$ da epoca)', 'sob sigilo (R$ da epoca)', 'saques (R$ da epoca)', 'lancamentos', 'fator para dinheiro de hoje'],
    linhas: d.anos.flatMap((a) => d.orgaos.filter((o) => o.valores[String(a)]).map((o) => [a, d.ate_mes[String(a)], o.codigo, nomeDoOrgao(o, a), ...o.valores[String(a)], arred(fatorParaHoje(ctx, a), 6)])),
  }));
}

const quantasViagens = (n) => (n === 1 ? '1 viagem' : `${f.numero(n, 0)} viagens`);

async function montarViagens(ctx) {
  const secao = $('#viagens');
  let d;
  try {
    d = await carregarPortal('viagens');
  } catch (erro) {
    console.error(erro);
    secao.hidden = true;
    return;
  }
  definir('viagens-atualizado', f.dataCurta(d.atualizado_em));
  const selAno = $('#viagens-ano');
  preencherAnosPortal(selAno, d);
  const liquido = (t) => t.diarias + t.passagens + t.outros - t.devolucao;

  const desenhar = () => {
    const ano = Number(selAno.value);
    const fator = fatorParaHoje(ctx, ano) ?? 1;
    const t = d.total[String(ano)];
    const total = liquido(t) * fator;
    definirItens('viagens-resumo', [
      { rotulo: null, texto: `${periodoDoAno(d, ano)}, o governo federal gastou ${f.reaisPorExtenso(total)} em ${f.numero(t.n, 0)} viagens a serviço (em dinheiro de hoje).` },
      { rotulo: null, texto: `Diárias somaram ${f.reaisPorExtenso(t.diarias * fator)} e passagens, ${f.reaisPorExtenso(t.passagens * fator)}.` },
      ...(t.sigilo > 0 ? [{ rotulo: 'Sob sigilo', texto: `${quantasViagens(t.n_sigilo)}, com ${f.reaisPorExtenso(t.sigilo * fator)}, sem informar quem viajou nem para onde.` }] : []),
    ]);
    const itens = d.orgaos.filter((o) => o.valores[String(ano)]).map((o) => ({
      nome: o.codigo === 'sigiloso' ? 'Órgão sob sigilo' : nomeDoOrgao(o, ano),
      valor: o.valores[String(ano)][0] * fator,
      n: o.valores[String(ano)][1],
    })).filter((x) => x.valor > 0);
    barrasDeOrgaos($('#viagens-lista'), itens, itens.reduce((a, x) => a + x.valor, 0), {
      explicar: (g) => quantasViagens(g.n),
    });

    const lista = $('#viagens-ministros');
    lista.replaceChildren();
    const ne = d.natureza_especial[String(ano)] ?? [];
    const totalNe = ne.reduce((a, y) => a + y.valor, 0) * fator;
    definirItens('viagens-ministros-nota', ne.length
      ? [{ rotulo: null, texto: `${periodoDoAno(d, ano)}, ${ne.length === 1 ? '1 pessoa viajou' : `${ne.length} pessoas viajaram`} ocupando cargo de natureza especial (ministros de Estado e cargos do mesmo nível), com gasto total de ${f.reaisPorExtenso(totalNe)}. Abaixo, quem mais gastou.` }]
      : [{ rotulo: null, texto: 'Sem viagens de cargos de natureza especial nesse ano.' }]);
    ne.slice(0, 15).forEach((y) => {
      const li = el('li', null, null, lista);
      const topo = el('div', 'ranking-topo', null, li);
      el('span', 'ranking-nome', y.nome, topo);
      el('span', 'ranking-valor', milReais(y.valor * fator), topo);
      el('span', 'ranking-explica', `${y.orgao} · ${quantasViagens(y.viagens)}`, li);
    });
  };
  selAno.addEventListener('change', desenhar);
  desenhar();

  const fechados = d.anos.filter((a) => anoFechado(d, a));
  const linhas = fechados.map((a) => {
    const fator = fatorParaHoje(ctx, a) ?? 1;
    const t = d.total[String(a)];
    return { ano: a, total: liquido(t) * fator, sigilo: t.sigilo * fator, viagens: t.n };
  });
  criarGrafico($('#grafico-viagens'), {
    tipo: 'colunas',
    rotulos: fechados,
    faixas: c.faixasAnuais(ctx.mandatos, fechados),
    series: [{ nome: 'Gasto com viagens', classe: 'serie-1', valores: linhas.map((l) => l.total / 1e9), parciais: new Set() }],
    formatoY: (v, eixo) => (eixo ? f.numero(v, 1) : `R$ ${f.numero(v, 2)} bi`),
    unidade: 'bilhões de reais de hoje',
    rotuloEixoX: (ano) => String(ano),
    tituloTooltip: (i) => `${fechados[i]}: ${f.numero(linhas[i].viagens, 0)} viagens`,
    descricao: 'Gasto anual do governo federal com viagens a serviço, em bilhões de reais de hoje.',
  });
  tabelaPorGoverno(ctx, $('#tabela-viagens-governos'), linhas, [
    { chave: 'total', titulo: 'Gasto por ano', formato: (v) => f.reaisCompacto(v) },
    { chave: 'viagens', titulo: 'Viagens por ano', formato: (v) => f.numero(v, 0) },
  ]);

  registrarDownload('viagens', () => ({
    nome: 'viagens-a-servico.csv',
    cabecalhos: ['ano', 'tipo', 'orgao', 'nome', 'viagens', 'valor (R$ da epoca)', 'fator para dinheiro de hoje'],
    linhas: d.anos.flatMap((a) => [
      ...d.orgaos.filter((o) => o.valores[String(a)]).map((o) => [a, 'orgao', o.codigo === 'sigiloso' ? 'sob sigilo' : nomeDoOrgao(o, a), '', o.valores[String(a)][1], o.valores[String(a)][0], arred(fatorParaHoje(ctx, a), 6)]),
      ...(d.natureza_especial[String(a)] ?? []).map((y) => [a, 'cargo de natureza especial', y.orgao, y.nome, y.viagens, y.valor, arred(fatorParaHoje(ctx, a), 6)]),
    ]),
  }));
}

// ---------------------------------------------------------------------------
// Cota parlamentar (deputados e senadores)
// ---------------------------------------------------------------------------

const NOMES_CASA = {
  camara: { titulo: 'Câmara', plural: 'deputados', singular: 'deputado', rotulo: 'Deputado', daCasa: 'da Câmara' },
  senado: { titulo: 'Senado', plural: 'senadores', singular: 'senador', rotulo: 'Senador', daCasa: 'do Senado' },
};

function barrasDeGrupos(lista, grupos, valores) {
  lista.replaceChildren();
  const total = valores.reduce((a, v) => a + v, 0);
  const itens = grupos.map((g, k) => ({ nome: g.nome, valor: valores[k] })).filter((g) => g.valor > 0).sort((a, b) => b.valor - a.valor);
  for (const g of itens) {
    const li = el('li', null, null, lista);
    const topo = el('div', 'barra-topo', null, li);
    el('span', 'barra-nome', g.nome, topo);
    const pct = total > 0 ? (g.valor / total) * 100 : 0;
    el('span', 'barra-valor', `${f.porcentagem(pct, pct < 1 ? 1 : 0)} · ${f.reaisCompacto(g.valor)}`, topo);
    const trilho = el('div', 'barra-trilho', null, li);
    trilho.setAttribute('aria-hidden', 'true');
    el('div', 'barra', null, trilho).style.width = `${Math.max(1, total > 0 ? (g.valor / total) * 100 : 0)}%`;
  }
}

// Nomes curtos dos grupos para as frases do resumo.
const GRUPO_CURTO = {
  passagens: 'passagens', divulgacao: 'divulgação', consultoria: 'consultorias', seguranca: 'segurança',
  escritorio: 'escritório', telefone: 'telefone e correio', locomocao: 'deslocamento, hospedagem e alimentação',
  moradia: 'auxílio-moradia', outros: 'outros',
};

// Quem esteve no cargo o ano todo (no ano corrente, desde o começo do ano),
// com quem não usou a cota valendo zero. É a base das médias e do ranking:
// quem ficou só parte do ano gasta menos por isso. Nulo quando o arquivo não
// diz quem ficou o ano todo.
function cotaAnoTodo(casa) {
  if (!casa.parlamentares.length || casa.parlamentares.some((p) => p.ano_todo == null)) return null;
  const semGasto = (casa.sem_gasto ?? []).filter((p) => p.ano_todo === true).map((p) => ({ ...p, total: 0, meses: 0 }));
  return [...casa.parlamentares.filter((p) => p.ano_todo), ...semGasto];
}

function mediasPorUf(lista) {
  const porUf = new Map();
  for (const p of lista) {
    if (!p.uf) continue;
    const x = porUf.get(p.uf) ?? { n: 0, total: 0 };
    x.n += 1;
    x.total += p.total;
    porUf.set(p.uf, x);
  }
  for (const x of porUf.values()) x.media = x.total / x.n;
  return porUf;
}

const milReais = (v) => (Math.abs(v) >= 1000 ? `R$\u00A0${f.numero(v / 1e3, 0)}\u00A0mil` : f.moeda(v, 0));

const rotuloParlamentar = (p) => {
  const extra = [p.partido, p.uf].filter(Boolean).join('-');
  return extra ? `${p.nome} (${extra})` : p.nome;
};

// No ano corrente, "o ano todo" quer dizer desde o começo do ano.
function frasesPeriodo(ano) {
  const corrente = ano >= new Date().getFullYear();
  return corrente
    ? { ficaram: 'estão no cargo desde o começo do ano', ficou: 'está no cargo desde o começo do ano', naoFicou: 'não está no cargo desde o começo do ano' }
    : { ficaram: 'ficaram o ano todo no cargo', ficou: 'ficou o ano todo no cargo', naoFicou: 'não ficou o ano todo no cargo' };
}

// Ranking do Brasil todo. Cada parlamentar é comparado com a média dos
// colegas do mesmo estado (mesma base de quem ficou o ano todo), porque o
// limite da cota muda de estado para estado: em reais, a lista dos que mais
// gastam seria quase só de estados longe de Brasília.
const MINIMO_POR_ESTADO = 5;

function desenharRanking(casa, nomes, base, medias, fr, nomeUf) {
  const listaMais = $('#cota-ranking-mais');
  const listaMenos = $('#cota-ranking-menos');
  listaMais.replaceChildren();
  listaMenos.replaceChildren();
  const caixa = listaMais.closest('.rankings');
  if (!base) {
    caixa.hidden = true;
    definirItens('cota-ranking-nota', [{ rotulo: null, texto: `Sem ranking ${nomes.daCasa} para esse ano: a lista oficial não informa quem ficou no cargo o ano todo, e comparar com quem ficou poucos meses seria injusto.` }]);
    return;
  }
  // Com poucos colegas no estado, um só que gaste muito pouco derruba a
  // média e faz quem gastou pouco parecer gastador. No Senado (3 por estado)
  // aconteceu em 2025: em Goiás, um senador com R$ 181 mil ficou 65% acima da
  // média, porque outro não usou a cota.
  const comparaveis = base.filter((p) => p.uf && medias.get(p.uf)?.media > 0 && medias.get(p.uf).n >= MINIMO_POR_ESTADO)
    .map((p) => ({ p, razao: p.total / medias.get(p.uf).media }));
  if (comparaveis.length < 20) {
    caixa.hidden = true;
    definirItens('cota-ranking-nota', [{ rotulo: null, texto: `Sem ranking ${nomes.daCasa}: com só 3 ${nomes.plural} por estado, a comparação com a média do estado não é confiável, e o limite muda de estado para estado. Um ranking justo precisa do limite oficial de cada estado, que ainda não está no site.` }]);
    return;
  }
  const ordem = (a, b) => a.razao - b.razao || a.p.total - b.p.total || a.p.nome.localeCompare(b.p.nome, 'pt-BR');
  const crescente = [...comparaveis].sort(ordem);
  const n = Math.min(10, Math.floor(crescente.length / 2));
  caixa.hidden = n === 0;
  definirItens('cota-ranking-nota', [
    { rotulo: null, texto: `No Brasil todo, entre os ${comparaveis.length} ${nomes.plural} que ${fr.ficaram}. Cada um é comparado com a média dos colegas do mesmo estado, que têm o mesmo limite de gasto. Por isso a ordem não segue só o valor em reais.` },
  ]);
  const item = (lista, { p, razao }) => {
    const li = el('li', null, null, lista);
    const topo = el('div', 'ranking-topo', null, li);
    // Partido e estado não se separam na quebra de linha.
    const nome = el('span', 'ranking-nome', `${p.nome} `, topo);
    const sigla = [p.partido, p.uf].filter(Boolean).join('-');
    if (sigla) el('span', 'ranking-sigla', `(${sigla})`, nome);
    el('span', 'ranking-valor', p.total > 0 ? milReais(p.total) : 'R$\u00A00', topo);
    const media = medias.get(p.uf).media;
    const pct = (razao - 1) * 100;
    const doUf = t.doEstado(p.uf, nomeUf(p.uf));
    el('span', 'ranking-explica', p.total <= 0
      ? `não usou a cota; média ${doUf}: ${milReais(media)}`
      : `${Math.abs(pct) < 0.5 ? 'igual à' : `${f.porcentagem(Math.abs(pct), 0)} ${pct > 0 ? 'acima' : 'abaixo'} da`} média ${doUf} (${milReais(media)})`, li);
  };
  crescente.slice(-n).reverse().forEach((x) => item(listaMais, x));
  crescente.slice(0, n).forEach((x) => item(listaMenos, x));
}

async function montarCota(ctx) {
  const secao = $('#cota');
  let indice;
  try {
    indice = await carregarIndiceCota();
  } catch (erro) {
    console.error(erro);
    secao.hidden = true;
    return;
  }
  definir('cota-atualizado', f.dataCurta(indice.atualizado_em));
  const nomesUf = new Map((ctx.d.estados_fiscal?.estados ?? []).map((e) => [e.sigla, e.nome]));
  const nomeUf = (uf) => nomesUf.get(uf) ?? uf;
  const cache = new Map();

  // Ano: começa no último ano fechado; o ano corrente fica disponível.
  const anos = [...indice.anos].sort((a, b) => b - a);
  const selAno = $('#cota-ano');
  selAno.replaceChildren();
  anos.forEach((ano) => { el('option', null, String(ano), selAno).value = String(ano); });
  const anoAtual = new Date().getFullYear();
  selAno.value = String(anos.find((a) => a < anoAtual) ?? anos[0]);

  const selUf = $('#cota-uf');
  selUf.replaceChildren();
  el('option', null, 'Todos os estados', selUf).value = '';
  [...nomesUf.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'))
    .forEach(([sigla, nome]) => { el('option', null, nome, selUf).value = sigla; });
  if (cidade.dados?.uf && nomesUf.has(cidade.dados.uf)) selUf.value = cidade.dados.uf;

  const selParl = $('#cota-parlamentar');
  let atual = null;

  const desenharParlamentar = () => {
    if (!atual) return;
    const { d, casaId, ano } = atual;
    const casa = d[casaId];
    const nomes = NOMES_CASA[casaId];
    const p = casa.parlamentares.find((x) => x.id === selParl.value);
    if (!p) {
      campo('cota-parlamentar-resumo').forEach((e) => e.replaceChildren(el('p', 'resumo-vazio',
        `Escolha ${casaId === 'camara' ? 'um deputado' : 'um senador'} na lista para ver quanto gastou, com o quê, e como fica perto da média do estado.`)));
      $('#cota-parlamentar-grupos').replaceChildren();
      return;
    }
    const itens = [{
      rotulo: p.nome,
      texto: `gastou ${f.reaisPorExtenso(p.total)} da cota em ${ano}, com despesas em ${p.meses === 1 ? '1 mês' : `${p.meses} meses`}`
        + (p.meses ? `, média de ${f.moeda(p.total / p.meses, 0)} por mês.` : '.'),
    }];
    const base = cotaAnoTodo(casa);
    const fr = frasesPeriodo(ano);
    if (base && p.ano_todo === false) {
      itens.push({ rotulo: null, texto: `${p.nome} ${fr.naoFicou}. Por isso fica fora da comparação com a média e do ranking.` });
    } else {
      const mesmos = p.uf ? (base ?? casa.parlamentares).filter((x) => x.uf === p.uf) : [];
      if (mesmos.length > 1) {
        const media = mesmos.reduce((a, x) => a + x.total, 0) / mesmos.length;
        const v = t.variacao((p.total / media - 1) * 100, 0);
        itens.push({ rotulo: null, texto: `A média dos ${nomes.plural} ${t.doEstado(p.uf, nomeUf(p.uf))}${base ? ` que ${fr.ficaram}` : ''} foi ${f.moeda(media, 0)}${v ? `; ${p.nome} gastou ${v === 'praticamente o mesmo valor' ? v : `${v} que a média`}` : ''}.` });
      }
    }
    definirItens('cota-parlamentar-resumo', itens);
    barrasDeGrupos($('#cota-parlamentar-grupos'), d.grupos, p.grupos);
  };

  const desenharAno = (d, ano) => {
    const casaId = valorRadio('cota-casa') ?? 'camara';
    const casa = d[casaId];
    const nomes = NOMES_CASA[casaId];
    const uf = selUf.value || null;
    const todos = casa.parlamentares;
    const recorte = uf ? todos.filter((p) => p.uf === uf) : todos;
    const soma = (lista) => lista.reduce((a, p) => a + p.total, 0);
    const mediaCasa = todos.length ? soma(todos) / todos.length : null;
    const ateMes = d.ate_mes?.[casaId];
    const base = cotaAnoTodo(casa);
    const fr = frasesPeriodo(ano);
    const medias = base ? mediasPorUf(base) : null;

    // Resumo.
    const itens = [];
    if (ateMes && ateMes < 12) {
      itens.push({ rotulo: 'Ano em curso', texto: `os dados vão até ${f.mesLongo(`${ano}-${String(ateMes).padStart(2, '0')}`)}.` });
    }
    if (recorte.length) {
      const total = soma(recorte);
      const usaram = `${recorte.length === 1 ? `1 ${nomes.singular}${uf ? ' do estado' : ''} usou` : `${recorte.length} ${nomes.plural}${uf ? ' do estado' : ''} usaram`} a cota e ${recorte.length === 1 ? 'gastou' : 'gastaram'} ${f.reaisPorExtenso(total)}`;
      if (base) {
        // Médias só com quem ficou o ano todo, a mesma base do ranking e da tabela.
        const mediaBase = soma(base) / base.length;
        const doUf = uf ? medias.get(uf) : null;
        itens.push(uf
          ? { rotulo: nomeUf(uf), texto: `em ${ano}, ${usaram}.${doUf ? ` Entre os que ${fr.ficaram}, a média foi ${f.moeda(doUf.media, 0)} por ${nomes.singular}; ${nomes.daCasa === 'da Câmara' ? 'na Câmara toda' : 'no Senado todo'}, ${f.moeda(mediaBase, 0)}.` : ''}` }
          : { rotulo: nomes.titulo, texto: `em ${ano}, ${usaram}. Entre os ${base.length} que ${fr.ficaram}, a média foi ${f.moeda(mediaBase, 0)} por ${nomes.singular}.` });
      } else {
        itens.push(uf
          ? { rotulo: nomeUf(uf), texto: `em ${ano}, ${usaram}, média de ${f.moeda(total / recorte.length, 0)} por ${nomes.singular}. A média ${nomes.daCasa} foi ${f.moeda(mediaCasa, 0)}.` }
          : { rotulo: nomes.titulo, texto: `em ${ano}, ${usaram}, média de ${f.moeda(mediaCasa, 0)} por ${nomes.singular}.` });
      }
      const porGrupo = d.grupos.map((g, k) => ({ nome: GRUPO_CURTO[g.id] ?? g.nome.toLowerCase(), v: recorte.reduce((a, p) => a + (p.grupos[k] ?? 0), 0) }))
        .filter((g) => g.v > 0).sort((a, b) => b.v - a.v).slice(0, 3);
      if (porGrupo.length) itens.push({ rotulo: 'O que mais pesou', texto: `${listaDeAnos(porGrupo.map((g) => `${g.nome} (${f.porcentagem((g.v / total) * 100, 0)})`))}.` });
      barrasDeGrupos($('#cota-grupos'), d.grupos, d.grupos.map((_, k) => recorte.reduce((a, p) => a + (p.grupos[k] ?? 0), 0)));
    } else {
      itens.push({ rotulo: null, texto: `Nenhum ${nomes.singular} ${uf ? t.doEstado(uf, nomeUf(uf)) : ''} usou a cota em ${ano}.` });
      $('#cota-grupos').replaceChildren();
    }
    definirItens('cota-resumo', itens);

    desenharRanking(casa, nomes, base, medias, fr, nomeUf);

    // Parlamentar: lista do recorte, em ordem alfabética.
    definir('cota-rotulo-parlamentar', nomes.rotulo);
    const anterior = selParl.value;
    selParl.replaceChildren();
    // Ninguém escolhido de início: o site não expõe uma pessoa só porque o
    // nome dela vem primeiro na ordem alfabética.
    el('option', null, `Escolha ${casaId === 'camara' ? 'um deputado' : 'um senador'}`, selParl).value = '';
    recorte.forEach((p) => { el('option', null, rotuloParlamentar(p), selParl).value = p.id; });
    selParl.value = recorte.some((p) => p.id === anterior) ? anterior : '';
    atual = { d, casaId, ano };
    desenharParlamentar();

    // Quem não usou.
    const sem = casa.sem_gasto;
    if (sem == null) {
      definirItens('cota-sem-gasto', [{ rotulo: null, texto: casaId === 'senado'
        ? 'Sem essa lista para o Senado nesse ano: a lista oficial de senadores não trouxe as datas em que cada um esteve no cargo.'
        : 'Sem lista para esse ano.' }]);
    } else {
      const doRecorte = uf ? sem.filter((p) => p.uf === uf) : sem;
      const onde = uf ? ` ${t.doEstado(uf, nomeUf(uf))}` : '';
      const quantos = (n) => (n === 1 ? `1 ${nomes.singular}` : `${n} ${nomes.plural}`);
      if (doRecorte.some((p) => p.ano_todo != null)) {
        const todo = doRecorte.filter((p) => p.ano_todo);
        const parte = doRecorte.filter((p) => !p.ano_todo);
        const itensSem = [{ rotulo: null, texto: todo.length
          ? `Em ${ano}, ${quantos(todo.length)}${onde} ${todo.length === 1 ? fr.ficou : fr.ficaram} e não ${todo.length === 1 ? 'teve' : 'tiveram'} nenhum gasto da cota: ${listaDeAnos(todo.map(rotuloParlamentar))}.`
          : `Em ${ano}, todos os ${nomes.plural}${onde} que ${fr.ficaram} usaram a cota.` }];
        if (parte.length) {
          const quem = parte.length === 1 ? `1 ${nomes.singular}` : `${todo.length ? 'Outros ' : ''}${parte.length} ${nomes.plural}`;
          itensSem.push({ rotulo: null, texto: `${quem}${todo.length ? '' : onde} ${parte.length === 1 ? 'ficou' : 'ficaram'} só parte do ano no cargo, como suplentes ou quem saiu para ser ministro, e não ${parte.length === 1 ? 'teve' : 'tiveram'} gasto: ${listaDeAnos(parte.map(rotuloParlamentar))}.` });
        }
        itensSem.push({ rotulo: null, texto: 'Não ter gasto não prova que a pessoa recusou a cota de forma declarada.' });
        definirItens('cota-sem-gasto', itensSem);
      } else definirItens('cota-sem-gasto', doRecorte.length
        ? [
          { rotulo: null, texto: `Em ${ano}, ${doRecorte.length === 1 ? `1 ${nomes.singular}` : `${doRecorte.length} ${nomes.plural}`}${onde} em exercício não ${doRecorte.length === 1 ? 'teve' : 'tiveram'} nenhum gasto da cota: ${listaDeAnos(doRecorte.map(rotuloParlamentar))}.` },
          { rotulo: null, texto: 'A lista inclui quem ficou pouco tempo no cargo, como suplentes que assumiram por poucos dias. Não ter gasto também não prova que a pessoa recusou a cota de forma declarada.' },
        ]
        : [{ rotulo: null, texto: `Em ${ano}, todos os ${nomes.plural}${onde} em exercício usaram a cota.` }]);
    }

    // Por estado, em ordem alfabética.
    const porUf = medias ?? mediasPorUf(todos);
    const linhas = [...porUf.entries()].sort((a, b) => nomeUf(a[0]).localeCompare(nomeUf(b[0]), 'pt-BR'))
      .map(([sigla, x]) => [nomeUf(sigla), String(x.n), milReais(x.media)]);
    // O total do estado acompanha o número de parlamentares; a comparação
    // justa é a média. O total fica na planilha.
    preencherTabela($('#tabela-cota-estados'),
      ['Estado', casaId === 'camara' ? 'Deputados' : 'Senadores', `Média por ${nomes.singular}`],
      linhas,
      base
        ? `${nomes.titulo}, ${ano}: ${nomes.plural} que ${fr.ficaram}, incluindo quem não usou a cota, e média por ${nomes.singular}. Cada estado tem um limite diferente, por causa da distância até Brasília.`
        : `${nomes.titulo}, ${ano}: ${nomes.plural} com gasto e média por ${nomes.singular}. Cada estado tem um limite diferente, por causa da distância até Brasília.`);
  };

  const desenhar = async () => {
    const ano = Number(selAno.value);
    let d = cache.get(ano);
    if (!d) {
      try {
        d = await carregarCotaAno(ano);
        cache.set(ano, d);
      } catch (erro) {
        console.error(erro);
        definirItens('cota-resumo', [{ rotulo: null, texto: 'Não foi possível carregar os dados desse ano agora. Tente de novo em instantes.' }]);
        return;
      }
    }
    if (Number(selAno.value) !== ano) return;
    desenharAno(d, ano);
  };
  selAno.addEventListener('change', desenhar);
  selUf.addEventListener('change', desenhar);
  document.querySelectorAll('input[name="cota-casa"]').forEach((r) => r.addEventListener('change', desenhar));
  selParl.addEventListener('change', desenharParlamentar);
  await desenhar();

  registrarDownload('cota', () => {
    const { d, casaId, ano } = atual ?? {};
    if (!d) return { nome: 'cota-parlamentar.csv', cabecalhos: [], linhas: [] };
    return {
      nome: `cota-parlamentar-${casaId}-${ano}.csv`,
      cabecalhos: ['nome', 'partido', 'UF', 'no cargo o ano todo', 'total reembolsado (R$)', 'meses com despesa', ...d.grupos.map((g) => `${g.nome} (R$)`)],
      linhas: d[casaId].parlamentares.map((p) => [p.nome, p.partido ?? '', p.uf ?? '', p.ano_todo == null ? '' : (p.ano_todo ? 'sim' : 'não'), p.total, p.meses, ...p.grupos]),
    };
  });
}

// ---------------------------------------------------------------------------
// Salário mínimo
// ---------------------------------------------------------------------------

function montarSalario(ctx) {
  const { meses, s, mandatos } = ctx;
  const sm = c.salarioMinimo(meses, s);
  const anual = c.anualSalario(meses, sm);
  const iUlt = c.ultimoIndice(sm.real);
  const iDolar = c.ultimoIndice(sm.emDolar);
  const iNec = c.ultimoIndice(sm.frenteNecessario);

  // Resposta, caixa de comparação e números acompanham o ano escolhido em
  // "Comparar com".
  const atualizarTopo = (iBase) => {
    const razaoReal = sm.real[iUlt] / sm.real[iBase];
    const quando = f.mesLongo(meses[iBase]);
    const ganho = razaoReal >= 1.5
      ? `compra ${f.numero(razaoReal, 1)} vezes o que comprava em ${quando}`
      : Math.abs(razaoReal - 1) < 0.005
        ? `compra praticamente o mesmo que em ${quando}`
        : `compra ${t.variacao((razaoReal - 1) * 100, 0)} do que em ${quando}`;
    definirTopicos('sm-resumo', `Descontada a inflação, o salário mínimo de hoje (${f.moeda(s.salario_minimo[iUlt], 0)}) ${ganho}.`);

    caixaComparacao($('#sm-comparacao'), {
      titulo: 'Salário mínimo, descontada a inflação',
      hoje: `Hoje (${f.mesCurto(meses[iUlt])})`,
      antes: comMaiuscula(f.mesCurto(meses[iBase])),
      itens: [{ rotulo: 'Valor na época', valores: [f.moeda(s.salario_minimo[iUlt], 0), f.moeda(s.salario_minimo[iBase], 0)] }],
      principal: { rotulo: 'em dinheiro de hoje', valores: [sm.real[iUlt], sm.real[iBase]], formato: (v) => f.moeda(v, 0) },
      maiorMelhor: true,
      frase: (r) => (r === 1 ? `Melhor hoje: o salário de hoje ${ganho}.`
        : r === -1 ? `Pior hoje: o salário de hoje ${ganho}.` : `Quase igual: o salário de hoje ${ganho}.`),
    });

    const numeros = $('#numeros-salario');
    numeros.replaceChildren();
    itemNumero(numeros, `Em dólar (${f.mesCurto(meses[iDolar])})`, f.dolar(sm.emDolar[iDolar], 0));
    if (s.smn_dieese[iNec] != null) {
      itemNumero(numeros, `Parte do salário necessário (DIEESE, ${f.mesCurto(meses[iNec])})`, f.porcentagem(sm.frenteNecessario[iNec], 0),
        `Pelas contas do DIEESE, uma família de quatro pessoas precisaria de ${f.moeda(s.smn_dieese[iNec], 0)} por mês.`);
    }
  };

  // Ao longo do tempo: o salário de cada mês em dinheiro de hoje, em dólar ou
  // ao lado do necessário do DIEESE.
  const { candidatos: basesPossiveis } = mesesParaComparar(meses, sm.real);
  let anoBase = null;
  const selBase = $('#sm-ano');
  const desenharTopo = () => {
    const iB = indiceDoAno(meses, basesPossiveis, anoBase);
    preencherAnos(selBase, meses, basesPossiveis, iB);
    atualizarTopo(iB);
  };

  const reguas = {
    real: () => ({
      inicio: sm.real.findIndex((v) => v != null),
      nome: 'Salário mínimo em dinheiro de hoje',
      valores: sm.real,
      formato: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 0)),
      unidade: 'reais de hoje por mês',
      explicacao: 'Cada ponto é o salário mínimo daquele mês corrigido pela inflação até hoje (INPC). Quanto mais alta a linha, mais o salário comprava.',
    }),
    dolar: () => ({
      nome: 'Salário mínimo em dólares',
      valores: sm.emDolar,
      formato: (v, eixo) => (eixo ? f.numero(v, 0) : f.dolar(v, 0)),
      unidade: 'dólares por mês',
      explicacao: 'Quantos dólares o salário de cada mês comprava, pela cotação daquele mês.',
    }),
    necessario: () => {
      const iN = c.ultimoIndice(s.smn_dieese);
      return {
        inicio: s.smn_dieese.findIndex((v) => v != null),
        nome: 'Salário mínimo e o salário mínimo necessário do DIEESE',
        series: [
          { nome: 'Salário mínimo', classe: 'serie-1', valores: s.salario_minimo },
          { nome: 'Necessário (DIEESE)', classe: 'serie-2', valores: s.smn_dieese },
        ],
        formato: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 0)),
        unidade: 'reais por mês',
        explicacao: `A linha tracejada é quanto o DIEESE calcula que uma família de 2 adultos e 2 crianças precisa por mês para viver com o básico. A distância até a linha cheia é quanto falta ao salário mínimo: em ${f.mesLongo(meses[iN])}, ${f.moeda(s.smn_dieese[iN] - s.salario_minimo[iN], 0)}, e o mínimo cobre ${f.porcentagem(sm.frenteNecessario[iN], 0)} do necessário.`,
      };
    },
  };

  const configurar = (chave) => {
    const r = reguas[chave]();
    const i0 = Math.max(0, r.inicio ?? 0);
    const mesesG = meses.slice(i0);
    const series = (r.series ?? [{ nome: r.nome, classe: 'serie-1', valores: r.valores }])
      .map((serie) => ({ ...serie, valores: serie.valores.slice(i0) }));
    return {
      opcoes: {
        tipo: 'linhas',
        rotulos: mesesG,
        faixas: c.faixasDeMandato(mandatos, mesesG),
        series,
        formatoY: r.formato,
        unidade: r.unidade,
        rotuloEixoX: rotuloMesNoEixo(5),
        tituloTooltip: (i) => f.mesCurto(mesesG[i]),
        extraTooltip: (i) => textoGoverno(ctx, mesesG[i]),
        descricao: r.nome,
        incluirZero: true,
      },
      explicacao: r.explicacao,
    };
  };

  let grafico = null;
  const desenharSalario = () => {
    const chave = valorRadio('sm-regua') ?? 'real';
    const { opcoes, explicacao } = configurar(chave);
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-salario'), opcoes);
    definir('sm-explicacao', explicacao);
  };
  document.querySelectorAll('input[name="sm-regua"]').forEach((r) => r.addEventListener('change', desenharSalario));
  selBase.addEventListener('change', (ev) => { anoBase = c.anoDe(meses[Number(ev.target.value)]); desenharTopo(); });
  desenharTopo();
  desenharSalario();

  const resumo = c.resumoPorGoverno(anual, mandatos, ['variacaoReal', 'emDolar', 'frenteNecessario']);
  preencherTabela($('#tabela-salario-governos'),
    ['Mandato', 'Aumento por ano, sem a inflação', 'Em dólar', 'Parte do necessário'],
    resumo.map((r) => [
      { texto: r.rotulo, detalhe: `${r.partido} · ${descreverAnos(r)}` },
      f.porcentagem(r.medias.variacaoReal, 1, true),
      f.dolar(r.medias.emDolar, 0),
      f.porcentagem(r.medias.frenteNecessario, 1),
    ]),
    'Médias dos anos de cada mandato.');

  registrarDownload('salario', () => ({
    nome: 'salario-minimo-mensal.csv',
    cabecalhos: ['mes', 'salario minimo (R$)', `real (R$ de ${sm.referencia}, INPC)`, 'em dolar (US$)', 'necessario DIEESE (R$)', '% do necessario', 'dolar medio (R$)'],
    linhas: meses.map((m, i) => [m, s.salario_minimo[i], arred(sm.real[i], 2), arred(sm.emDolar[i], 2), s.smn_dieese[i], arred(sm.frenteNecessario[i], 2), s.dolar_ptax[i]]),
  }));
}

const arred = (v, casas) => (v == null ? null : Math.round(v * 10 ** casas) / 10 ** casas);

// ---------------------------------------------------------------------------
// Dólar
// ---------------------------------------------------------------------------

function montarDolar(ctx) {
  const { meses, s, ipca, mandatos } = ctx;
  const real = c.dolarReal(s.dolar_ptax, ipca, s.cpi_eua);
  const faixas = c.faixasDeMandato(mandatos, meses);
  const iUlt = c.ultimoIndice(s.dolar_ptax);
  const base = meses[real.base];
  const validos = real.valores.filter((v) => v != null);
  const media = validos.reduce((a, v) => a + v, 0) / validos.length;
  const faltantes = meses.filter((m, i) => s.dolar_ptax[i] != null && real.valores[i] == null);

  const numeros = $('#numeros-dolar');
  numeros.replaceChildren();
  const item = (rotulo, valor) => {
    const div = el('div', null, null, numeros);
    el('dt', null, rotulo, div);
    el('dd', null, valor, div);
  };
  item(`Dólar em ${f.mesCurto(meses[iUlt])}`, f.moeda(s.dolar_ptax[iUlt], 2));
  item('Média desde 1995, em dinheiro de hoje', f.moeda(media, 2));
  item('Hoje, comparado à média', t.maisCaroOuBarato(real.valores[real.base], media) ?? 'igual à média');

  const desvio = (real.valores[real.base] / media - 1) * 100;
  const comparado = t.maisCaroOuBarato(real.valores[real.base], media);
  const posicao = comparado
    ? `o dólar está ${comparado} do que a média desde 1995.`
    : 'o dólar está praticamente igual à média desde 1995.';
  let efeito = '';
  if (desvio >= 0.5) efeito = ' Dólar mais caro encarece produtos importados e viagens ao exterior.';
  else if (desvio <= -0.5) efeito = ' Dólar mais barato barateia produtos importados e viagens ao exterior.';
  definirTopicos('dolar-resumo', `Descontada a inflação do Brasil e a dos Estados Unidos, ${posicao}${efeito}`);

  criarGrafico($('#grafico-dolar'), {
    tipo: 'linhas',
    rotulos: meses,
    faixas,
    series: [
      { nome: 'Cotação na época', classe: 'serie-1', valores: s.dolar_ptax },
      { nome: 'Em dinheiro de hoje', classe: 'serie-2', valores: real.valores },
    ],
    formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 2)),
    unidade: 'reais por dólar',
    rotuloEixoX: rotuloMesNoEixo(5),
    tituloTooltip: (i) => f.mesCurto(meses[i]),
    extraTooltip: (i) => textoGoverno(ctx, meses[i]),
    descricao: 'Dólar comercial: cotação média de cada mês, na época e em dinheiro de hoje.',
    incluirZero: true,
  });

  if (faltantes.length) {
    const nota = el('p', 'nota', `Sem valor em dinheiro de hoje em ${faltantes.map(f.mesCurto).join(', ')}: o governo dos Estados Unidos (BLS) não publicou a inflação desse mês.`);
    $('#grafico-dolar').after(nota);
  }

  registrarDownload('dolar', () => ({
    nome: 'dolar-mensal.csv',
    cabecalhos: ['mes', 'dolar medio (R$)', `a precos de ${base} (R$)`, 'IPCA mensal (%)', 'CPI-U EUA'],
    linhas: meses.map((m, i) => [m, s.dolar_ptax[i], arred(real.valores[i], 4), s.ipca_var[i], s.cpi_eua[i]]),
  }));
}

// ---------------------------------------------------------------------------
// Imposto de Renda
// ---------------------------------------------------------------------------

function montarIR(ctx) {
  const { meses, ipca, mandatos, d } = ctx;
  const isencao = c.serieIsencao(meses, d.ir_tabela);
  const tabela = c.serieIsencao(meses, d.ir_tabela, 'limite_tabela');
  const corrigida = c.isencaoCorrigida(meses, ipca, d.ir_tabela);
  const iIni = isencao.findIndex((v) => v != null);
  const iUlt = c.ultimoIndice(corrigida);
  const faixas = c.faixasDeMandato(mandatos, meses.slice(iIni)).map((fx) => ({ ...fx }));
  const defasagem = (corrigida[iUlt] / isencao[iUlt] - 1) * 100;

  const numeros = $('#numeros-ir');
  numeros.replaceChildren();
  const item = (rotulo, valor) => {
    const div = el('div', null, null, numeros);
    el('dt', null, rotulo, div);
    el('dd', null, valor, div);
  };
  item(`Até quanto não paga (${f.mesCurto(meses[iUlt])})`, f.moeda(isencao[iUlt], 2));
  item('Limite de 1996 corrigido pela inflação', f.moeda(corrigida[iUlt], 2));
  item('Quanto falta para repor a inflação', f.porcentagem(defasagem, 1));

  const primeiraIsencao = isencao[iIni];
  let resumoIr = `Hoje, quem ganha até ${f.moeda(isencao[iUlt], 0)} por mês não paga Imposto de Renda. `
    + `O limite de 1996 era ${f.moeda(primeiraIsencao, 0)}.`;
  const acima = (isencao[iUlt] / corrigida[iUlt] - 1) * 100;
  resumoIr += defasagem > 0.5
    ? ` Para repor a inflação desde 1996, o limite atual precisaria subir ${f.porcentagem(defasagem, 0)}.`
    : acima > 0.5
      ? ` O limite atual está ${f.porcentagem(acima, 0)} acima do que seria só repondo a inflação desde 1996.`
      : ' O limite atual acompanha a inflação acumulada desde 1996.';
  definirTopicos('ir-resumo', resumoIr);

  const recorte = (arr) => arr.slice(iIni);
  const mesesIR = meses.slice(iIni);
  criarGrafico($('#grafico-ir'), {
    tipo: 'linhas',
    rotulos: mesesIR,
    faixas,
    series: [
      { nome: 'Limite para não pagar', classe: 'serie-1', valores: recorte(isencao), degrau: true },
      { nome: 'Limite de 1996 corrigido pela inflação', classe: 'serie-2', valores: recorte(corrigida) },
    ],
    formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 2)),
    unidade: 'reais por mês',
    rotuloEixoX: rotuloMesNoEixo(5),
    tituloTooltip: (i) => f.mesCurto(mesesIR[i]),
    extraTooltip: (i) => {
      const t = tabela[iIni + i];
      const e = isencao[iIni + i];
      const partes = [textoGoverno(ctx, mesesIR[i])];
      if (t != null && e !== t) partes.push(`valor na tabela oficial: ${f.moeda(t, 2)}`);
      return partes.filter(Boolean).join(' · ');
    },
    descricao: 'Salário mensal até o qual não se paga Imposto de Renda, comparado ao limite de 1996 corrigido pela inflação.',
    incluirZero: true,
  });

  const porMandato = c.irPorMandato(meses, mandatos, isencao, ipca);
  preencherTabela($('#tabela-ir-governos'),
    ['Mandato', 'Quanto o limite subiu', 'Inflação no período'],
    porMandato.map((r) => [
      { texto: r.rotulo, detalhe: `${r.partido} · ${r.de ? `${f.mesCurto(r.de)} a ${f.mesCurto(r.ate)}` : 'sem dado'}` },
      f.porcentagem(r.correcao, 1, true),
      f.porcentagem(r.ipca, 1, true),
    ]));

  registrarDownload('ir', () => ({
    nome: 'imposto-de-renda-isencao-mensal.csv',
    cabecalhos: ['mes', 'limite da tabela (R$)', 'isencao efetiva (R$)', 'limite de 1996 corrigido pelo IPCA (R$)'],
    linhas: meses.slice(iIni).map((m, k) => [m, tabela[iIni + k], isencao[iIni + k], arred(corrigida[iIni + k], 2)]),
  }));
}

// ---------------------------------------------------------------------------
// Escolhas (itens e ano de comparação), usadas por compras e combustíveis
// ---------------------------------------------------------------------------

function montarEscolhas(container, nome, itens, aoMudar) {
  container.replaceChildren();
  itens.forEach((item, k) => {
    const rotulo = el('label', 'escolha', null, container);
    const input = el('input', null, null, rotulo);
    input.type = 'radio';
    input.name = nome;
    input.value = item.id;
    input.checked = k === 0;
    input.addEventListener('change', () => aoMudar(item));
    el('span', null, item.nome, rotulo);
  });
}

// Índices do mesmo mês do ano em anos anteriores ao último dado.
function mesesParaComparar(meses, valores) {
  const iUlt = c.ultimoIndice(valores);
  if (iUlt < 0) return { iUlt, candidatos: [] };
  const mes = c.mesDoAno(meses[iUlt]);
  const candidatos = [];
  meses.forEach((m, i) => {
    if (i < iUlt && c.mesDoAno(m) === mes && valores[i] != null) candidatos.push(i);
  });
  return { iUlt, candidatos };
}

// Entre os meses candidatos, o do ano pedido; se o item não tem esse ano, o
// mais próximo dele; sem ano pedido, o mais antigo.
function indiceDoAno(meses, candidatos, ano) {
  if (ano == null) return candidatos[0];
  return candidatos.reduce((melhor, i) => (
    Math.abs(c.anoDe(meses[i]) - ano) < Math.abs(c.anoDe(meses[melhor]) - ano) ? i : melhor), candidatos[0]);
}

function preencherAnos(select, meses, candidatos, escolhido) {
  select.replaceChildren();
  // Mais recente no topo: é o que a pessoa procura primeiro.
  [...candidatos].reverse().forEach((i) => {
    const op = el('option', null, String(c.anoDe(meses[i])), select);
    op.value = String(i);
    if (i === escolhido) op.selected = true;
  });
}

function itemNumero(container, rotulo, valor, detalhe) {
  const div = el('div', null, null, container);
  el('dt', null, rotulo, div);
  const dd = el('dd', null, valor, div);
  if (detalhe) el('span', 'detalhe', detalhe, dd);
}

// ---------------------------------------------------------------------------
// O que o salário mínimo compra
// ---------------------------------------------------------------------------

const ITENS_COMPRA = [
  { id: 'cesta', serie: 'cesta_total', nome: 'Cesta básica', unidade: 'cesta básica', plural: 'cestas básicas', singular: 'uma cesta básica', tamanho: 1, fonte: 'dieese' },
  { id: 'arroz', serie: 'preco_arroz', nome: 'Arroz', unidade: 'pacote de arroz de 5 kg', plural: 'pacotes de arroz de 5 kg', singular: 'um pacote de arroz de 5 kg', tamanho: 5, fonte: 'dieese' },
  { id: 'feijao', serie: 'preco_feijao', nome: 'Feijão', unidade: 'quilo de feijão', plural: 'quilos de feijão', singular: 'um quilo de feijão', tamanho: 1, fonte: 'dieese' },
  { id: 'carne', serie: 'preco_carne', nome: 'Carne', unidade: 'quilo de carne bovina', plural: 'quilos de carne bovina', singular: 'um quilo de carne bovina', tamanho: 1, fonte: 'dieese' },
  { id: 'leite', serie: 'preco_leite', nome: 'Leite', unidade: 'litro de leite', plural: 'litros de leite', singular: 'um litro de leite', tamanho: 1, fonte: 'dieese' },
  { id: 'cafe', serie: 'preco_cafe', nome: 'Café', unidade: 'pacote de café de 500 g', plural: 'pacotes de café de 500 g', singular: 'um pacote de café de 500 g', tamanho: 0.5, fonte: 'dieese' },
  { id: 'pao', serie: 'preco_pao', nome: 'Pão francês', unidade: 'quilo de pão francês', plural: 'quilos de pão francês', singular: 'um quilo de pão francês', tamanho: 1, fonte: 'dieese' },
  { id: 'gasolina', serie: 'comb_gasolina', nome: 'Gasolina', unidade: 'litro de gasolina', plural: 'litros de gasolina', singular: 'um litro de gasolina', tamanho: 1, fonte: 'anp' },
  { id: 'botijao', serie: 'comb_glp', nome: 'Botijão de gás', unidade: 'botijão de gás de 13 kg', plural: 'botijões de gás de 13 kg', singular: 'um botijão de gás de 13 kg', tamanho: 1, fonte: 'anp' },
];

const maiuscula = (texto) => texto.charAt(0).toUpperCase() + texto.slice(1);

function montarCompras(ctx) {
  const { meses, s, mandatos, d } = ctx;
  const itens = ITENS_COMPRA.filter((it) => Array.isArray(s[it.serie]));
  if (!itens.length) { $('#compras').hidden = true; return; }
  const capitais = d.precos?.capitais_media ?? [];
  let grafico = null;
  let item = itens[0];
  let anoEscolhido = null;

  // Com cidade escolhida, os alimentos usam o preço do DIEESE na cidade e
  // gasolina e gás usam a média da ANP no estado da cidade.
  const precoDe = (it) => cidade.dados?.series?.[it.serie] ?? s[it.serie];
  const naCidade = (it) => Boolean(cidade.dados?.series?.[it.serie]);
  const ondeLocal = (it) => (it.fonte === 'anp'
    ? `No estado ${t.doEstado(cidade.dados.uf, cidade.dados.uf_nome ?? cidade.dados.uf)}`
    : `Em ${cidade.dados.nome}`);

  const desenhar = () => {
    const precos = precoDe(item);
    const q = c.quantidadeComprada(s.salario_minimo, precos, item.tamanho);
    const { iUlt, candidatos } = mesesParaComparar(meses, q);
    if (iUlt < 0 || !candidatos.length) return;
    const iA = indiceDoAno(meses, candidatos, anoEscolhido);
    preencherAnos($('#compras-ano'), meses, candidatos, iA);

    const qA = q[iA];
    const qB = q[iUlt];
    const anoA = c.anoDe(meses[iA]);
    const onde = naCidade(item) ? `${ondeLocal(item)}, um` : 'Um';
    definirTopicos('compras-resumo',
      `${onde} salário mínimo compra ${t.quantidadeCom(qB, item.unidade, item.plural)} hoje; em ${f.mesLongo(meses[iA])}, comprava ${t.quantidade(qA)}.`);

    $('#compras-numeros').replaceChildren();
    const precoItem = (i) => precos[i] * item.tamanho;
    caixaComparacao($('#compras-comparacao'), {
      titulo: `Quanto um salário mínimo compra de ${item.nome.toLowerCase()}`,
      hoje: `Hoje (${f.mesCurto(meses[iUlt])})`,
      antes: comMaiuscula(f.mesCurto(meses[iA])),
      itens: [
        { rotulo: 'Salário mínimo', valores: [f.moeda(s.salario_minimo[iUlt], 0), f.moeda(s.salario_minimo[iA], 0)] },
        { rotulo: comMaiuscula(item.unidade), valores: [f.moeda(precoItem(iUlt), 2), f.moeda(precoItem(iA), 2)] },
      ],
      principal: { rotulo: item.plural, valores: [qB, qA], formato: (v) => t.quantidade(v) },
      maiorMelhor: true,
      frase: (r) => (r === 1 ? `Melhor hoje: o salário mínimo compra mais ${item.plural} do que em ${anoA}.`
        : r === -1 ? `Pior hoje: o salário mínimo compra menos ${item.plural} do que em ${anoA}.`
          : `Quase igual: o salário mínimo compra praticamente o mesmo que em ${anoA}.`),
    });

    const cesta = 'A cesta básica é o conjunto de 13 alimentos que, pela lei, sustenta uma pessoa adulta por um mês.';
    let nota;
    if (naCidade(item) && item.fonte === 'anp') {
      nota = `O preço é a média dos postos pesquisados pela ANP no estado ${t.doEstado(cidade.dados.uf, cidade.dados.uf_nome ?? cidade.dados.uf)}. Na sua cidade o preço pode ser diferente.`;
    } else if (naCidade(item)) {
      nota = `Os preços são os que o DIEESE pesquisa todo mês em ${cidade.dados.nome}. Meses sem pesquisa na cidade ficam em branco. ${cesta}`;
    } else if (item.fonte === 'dieese') {
      nota = `Os preços são a média de ${capitais.length} capitais que o DIEESE pesquisa todo mês desde 1995 (${capitais.join(', ')}). Na sua cidade o preço pode ser diferente. ${cesta}`;
    } else {
      nota = 'O preço é a média dos postos pesquisados pela ANP em todo o Brasil. Na sua cidade o preço pode ser diferente.';
    }
    definir('compras-nota-fonte', nota);

    // O gráfico começa no primeiro mês com preço publicado.
    const iIni = q.findIndex((v) => v != null);
    const mesesG = meses.slice(iIni);
    const opcoes = {
      tipo: 'linhas',
      rotulos: mesesG,
      faixas: c.faixasDeMandato(mandatos, mesesG),
      series: [{ nome: `${item.plural} com um salário mínimo`, classe: 'serie-1', valores: q.slice(iIni) }],
      formatoY: (v, eixo) => (eixo ? f.numero(v, v < 10 ? 1 : 0) : `${t.quantidade(v)} ${item.plural}`),
      unidade: `${item.plural} por salário mínimo`,
      rotuloEixoX: rotuloMesNoEixo(5),
      tituloTooltip: (i) => f.mesCurto(mesesG[i]),
      extraTooltip: (i) => textoGoverno(ctx, mesesG[i]),
      descricao: `Quantos ${item.plural} um salário mínimo comprava em cada mês.`,
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-compras'), opcoes);

    registrarDownload('compras', () => ({
      nome: `salario-minimo-compra-${item.id}${naCidade(item) ? `-${cidade.codigo}` : ''}.csv`,
      cabecalhos: ['mes', 'salario minimo (R$)', `preco de ${item.singular} (R$)`, `quantidade (${item.plural})`],
      linhas: meses.map((m, i) => [m, s.salario_minimo[i], precos[i] == null ? null : arred(precoItem(i), 2), arred(q[i], 2)])
        .filter((l) => l[2] != null),
    }));
  };

  montarEscolhas($('#compras-itens'), 'compras-item', itens, (novo) => { item = novo; desenhar(); });
  $('#compras-ano').addEventListener('change', (ev) => { anoEscolhido = c.anoDe(meses[Number(ev.target.value)]); desenhar(); });
  aoMudarCidade(desenhar);
  desenhar();
}

// ---------------------------------------------------------------------------
// Cidade escolhida
// ---------------------------------------------------------------------------

// null = média do país. As seções com números por capital (orçamento e
// compras) têm cada uma um seletor; os seletores ficam sincronizados e a
// escolha fica guardada no navegador do visitante.
const CHAVE_CIDADE = 'arrecadometro-cidade';
const cidade = { indice: [], codigo: null, dados: null, cache: new Map(), ouvintes: [], n: 0 };

const aoMudarCidade = (fn) => { cidade.ouvintes.push(fn); };

function lerCidadeGuardada() {
  try { return localStorage.getItem(CHAVE_CIDADE); } catch { return null; }
}

function guardarCidade(codigo) {
  try {
    if (codigo) localStorage.setItem(CHAVE_CIDADE, codigo); else localStorage.removeItem(CHAVE_CIDADE);
  } catch { /* navegador sem armazenamento: a escolha vale só nesta visita */ }
}

async function escolherCidade(codigo) {
  const valido = codigo && cidade.indice.some((x) => x.codigo === codigo) ? codigo : null;
  let dados = null;
  if (valido) {
    try {
      if (!cidade.cache.has(valido)) cidade.cache.set(valido, await carregarCidade(valido, cidade.n));
      dados = cidade.cache.get(valido);
    } catch (erro) {
      console.error(erro);
      document.querySelectorAll('select[data-cidade]').forEach((sel) => { sel.value = ''; });
      return escolherCidade(null);
    }
  }
  cidade.codigo = dados ? valido : null;
  cidade.dados = dados;
  guardarCidade(cidade.codigo);
  document.querySelectorAll('select[data-cidade]').forEach((sel) => { sel.value = cidade.codigo ?? ''; });
  cidade.ouvintes.forEach((fn) => {
    try { fn(); } catch (erro) { console.error(erro); }
  });
  return cidade.codigo;
}

function montarSeletoresDeCidade() {
  document.querySelectorAll('select[data-cidade]').forEach((sel) => {
    const caixa = sel.closest('label');
    if (!cidade.indice.length) { if (caixa) caixa.hidden = true; return; }
    sel.replaceChildren();
    el('option', null, 'Média do país', sel).value = '';
    cidade.indice.forEach((x) => { el('option', null, `${x.nome} (${x.uf})`, sel).value = x.codigo; });
    sel.addEventListener('change', () => { escolherCidade(sel.value || null); });
  });
}

// ---------------------------------------------------------------------------
// O salário dá para viver? (orçamento da família)
// ---------------------------------------------------------------------------

// Despesas do básico da casa. padrao() devolve o valor médio do país, com a
// explicação de onde ele vem, ou null quando falta dado. A pessoa pode trocar
// qualquer valor pelo da sua casa.
const AREA_EXEMPLO_M2 = 40;

// Gasto da POF 2017-2018 da faixa de renda, trazido para hoje pela inflação
// do próprio item (IPCA por subitem, desde janeiro de 2018).
function valorDaPof(ctx, familia, chave, serieIpca) {
  const pof = ctx.d.orcamento?.pof;
  // Com cidade escolhida, a faixa de renda vem da POF do estado da cidade.
  const valor2018 = familia.faixa?.itens?.[chave];
  const f2 = pof && c.fatorDesde(ctx.meses, ctx.s[serieIpca], pof.mes_referencia);
  return valor2018 == null || !f2 ? null : { valor: valor2018 * f2.fator, ate: f2.ate };
}

function gastoDaPof(ctx, familia, chave, serieIpca, nomeDaInflacao) {
  const v = valorDaPof(ctx, familia, chave, serieIpca);
  return v && {
    valor: v.valor,
    nota: `Gasto médio das famílias da mesma faixa de renda${familia.local ? ` no estado (${familia.local.uf})` : ''} (POF 2017-2018, IBGE), corrigido pela inflação ${nomeDaInflacao} até ${f.mesCurto(v.ate)}`,
  };
}

const ITENS_ORCAMENTO = [
  {
    id: 'comida', nome: 'Comida',
    padrao: ({ meses, s }, familia) => {
      const local = familia.local?.series?.cesta_total;
      const u = c.ultimoValor(meses, local ?? s.cesta_total);
      if (!u) return null;
      const cestas = familia.unidades;
      const textoCestas = cestas === 1 ? 'Uma cesta básica' : `${f.numero(cestas, cestas % 1 ? 1 : 0)} cestas básicas`;
      const onde = local ? `em ${familia.local.nome}` : 'média de capitais';
      return {
        valor: u.valor * cestas,
        nota: `${textoCestas} do DIEESE, ${onde}, em ${f.mesCurto(u.mes)}${familia.criancas ? ' (cada criança conta como meia cesta, como no cálculo do DIEESE)' : ''}`,
      };
    },
  },
  {
    id: 'aluguel', nome: 'Aluguel',
    opcoes: [
      { id: 'pof', nome: 'Moradias das famílias com essa renda (IBGE)' },
      { id: 'anuncio', nome: `Apartamento anunciado de ${AREA_EXEMPLO_M2} m² (FipeZAP)` },
    ],
    padrao: (ctx, familia, opcao) => {
      const { meses, s } = ctx;
      if (opcao !== 'anuncio') {
        const v = valorDaPof(ctx, familia, 'aluguel', 'ipca_aluguel_var');
        return v && {
          valor: v.valor,
          nota: `Valor médio de aluguel das moradias das famílias da mesma faixa de renda${familia.local ? ` no estado (${familia.local.uf})` : ''} (POF 2017-2018, IBGE; para quem tem casa própria, o IBGE usa o aluguel estimado), corrigido pela inflação do aluguel até ${f.mesCurto(v.ate)}`,
        };
      }
      const local = familia.local?.series?.aluguel_m2;
      const u = c.ultimoValor(meses, local ?? s.aluguel_m2);
      const onde = local ? `em ${familia.local.nome}` : 'nas cidades do Índice FipeZAP';
      return u && {
        valor: u.valor * AREA_EXEMPLO_M2,
        nota: `Apartamento de ${AREA_EXEMPLO_M2} m² a ${f.moeda(u.valor, 2)} por m², preço médio pedido em anúncios ${onde} em ${f.mesCurto(u.mes)}. Em bairros mais simples costuma ser menor`,
      };
    },
  },
  { id: 'luz', nome: 'Luz', padrao: (ctx, familia) => gastoDaPof(ctx, familia, 'luz', 'ipca_luz_var', 'da energia elétrica') },
  { id: 'agua', nome: 'Água', padrao: (ctx, familia) => gastoDaPof(ctx, familia, 'agua', 'ipca_agua_var', 'da conta de água e esgoto') },
  {
    id: 'gas', nome: 'Gás de cozinha',
    padrao: (ctx, familia) => {
      const g = gastoDaPof(ctx, familia, 'gas', 'ipca_gas_var', 'do gás de botijão');
      const botijao = c.ultimoValor(ctx.meses, familia.local?.series?.comb_glp ?? ctx.s.comb_glp);
      if (g && botijao) g.nota += `. Dá cerca de ${f.numero(g.valor / botijao.valor, 1)} botijão por mês`;
      return g;
    },
  },
];

const RENDAS_EM_SALARIOS = [1, 1.5, 2, 3, 4, 5];

function montarOrcamento(ctx) {
  const { meses, s } = ctx;
  const sm = c.ultimoValor(meses, s.salario_minimo);
  if (!sm) { $('#orcamento').hidden = true; return; }

  const selRenda = $('#orc-renda');
  const campoOutra = $('#orc-renda-outra');
  const caixaOutra = $('#orc-renda-outra-caixa');
  const selAdultos = $('#orc-adultos');
  const selCriancas = $('#orc-criancas');
  const pof = ctx.d.orcamento?.pof;
  selRenda.replaceChildren();
  for (const n of RENDAS_EM_SALARIOS) {
    const nome = n === 1 ? '1 salário mínimo' : `${f.numero(n, n % 1 ? 1 : 0)} salários mínimos`;
    const op = el('option', null, `${nome} (${f.moeda(sm.valor * n, 0)})`, selRenda);
    op.value = String(n);
    if (n === 2) op.selected = true;
  }
  el('option', null, 'Outro valor', selRenda).value = 'outro';

  // Valores digitados pela pessoa valem até ela pedir os valores médios de novo.
  const digitados = new Map();
  const opcoesEscolhidas = new Map();
  const lista = $('#orc-lista');
  const linhas = new Map();
  for (const item of ITENS_ORCAMENTO) {
    const li = el('li', 'orc-item', null, lista);
    const topo = el('div', 'orc-topo', null, li);
    const rotulo = el('label', 'orc-nome', item.nome, topo);
    rotulo.htmlFor = `orc-${item.id}`;
    const campo = el('div', 'orc-campo', null, topo);
    el('span', null, 'R$', campo);
    const input = el('input', null, null, campo);
    input.id = `orc-${item.id}`;
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = '1000000';
    input.step = '1';
    if (item.opcoes) {
      const rotuloRef = el('label', 'seletor orc-referencia', 'Referência', li);
      const sel = el('select', null, null, rotuloRef);
      sel.id = `orc-${item.id}-ref`;
      for (const op of item.opcoes) el('option', null, op.nome, sel).value = op.id;
      sel.addEventListener('change', () => {
        opcoesEscolhidas.set(item.id, sel.value);
        digitados.delete(item.id);
        calcular(false);
      });
    }
    const nota = el('p', 'orc-nota', null, li);
    const trilho = el('div', 'barra-trilho', null, li);
    trilho.setAttribute('aria-hidden', 'true');
    const barra = el('div', 'barra', null, trilho);
    const parte = el('p', 'orc-parte', null, li);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v) || v < 0) digitados.delete(item.id);
      else digitados.set(item.id, Math.min(v, 1000000));
      calcular(false);
    });
    linhas.set(item.id, { input, nota, barra, parte });
  }

  const renda = () => {
    if (selRenda.value !== 'outro') return sm.valor * Number(selRenda.value);
    const v = Number(campoOutra.value);
    return Number.isFinite(v) && v > 0 ? Math.min(v, 10000000) : 0;
  };

  const calcular = (reescreverCampos = true) => {
    const adultos = Number(selAdultos.value) || 2;
    const criancas = Number(selCriancas.value) || 0;
    caixaOutra.hidden = selRenda.value !== 'outro';
    const r = renda();
    const local = cidade.dados;
    const classes = local?.pof?.length ? local.pof : pof?.classes;
    const familia = {
      adultos,
      criancas,
      local,
      unidades: c.unidadesDeConsumo(adultos, criancas),
      faixa: classes?.length && pof ? c.faixaDaPof(classes, r / sm.valor, pof.salario_minimo_referencia) : null,
    };
    // Sem aluguel do FipeZAP para a cidade, fica só a referência do IBGE.
    const selRef = $('#orc-aluguel-ref');
    const semAnuncio = Boolean(local) && !local.series?.aluguel_m2;
    const opAnuncio = selRef?.querySelector('option[value="anuncio"]');
    if (opAnuncio) {
      opAnuncio.disabled = semAnuncio;
      opAnuncio.textContent = semAnuncio
        ? 'Apartamento anunciado (sem dado do FipeZAP para esta cidade)'
        : `Apartamento anunciado de ${AREA_EXEMPLO_M2} m² (FipeZAP)`;
      if (semAnuncio && selRef.value === 'anuncio') { selRef.value = 'pof'; opcoesEscolhidas.set('aluguel', 'pof'); }
    }
    const despesas = ITENS_ORCAMENTO.map((item) => {
      const p = item.padrao(ctx, familia, opcoesEscolhidas.get(item.id) ?? item.opcoes?.[0]?.id);
      const valor = digitados.has(item.id) ? digitados.get(item.id) : (p ? Math.round(p.valor) : null);
      return { id: item.id, nome: item.nome, valor, nota: digitados.has(item.id) ? 'Valor digitado por você' : (p?.nota ?? 'Ainda sem fonte automática para este item. Digite o valor da sua casa.') };
    });
    const res = c.orcamento(r, despesas);

    for (const d of res.itens) {
      const linha = linhas.get(d.id);
      if (reescreverCampos || !digitados.has(d.id)) linha.input.value = d.valor == null ? '' : String(d.valor);
      linha.nota.textContent = d.nota;
      linha.barra.style.width = `${Math.max(0, Math.min(100, d.parte ?? 0))}%`;
      linha.parte.textContent = d.parte == null ? '' : `${f.porcentagem(d.parte, 0)} da renda`;
    }

    const semValor = res.itens.filter((d) => d.valor == null).map((d) => d.nome.toLowerCase());
    const pessoasTexto = `${adultos === 1 ? '1 adulto' : `${adultos} adultos`}${criancas ? ` e ${criancas === 1 ? '1 criança' : `${criancas} crianças`}` : ''}`;
    const pessoas = `${adultos === 1 && !criancas ? 'Uma pessoa que mora sozinha' : `Uma casa com ${pessoasTexto}`}${local ? ` em ${local.nome}` : ''}`;
    const rendaTexto = selRenda.value === 'outro'
      ? `renda de ${f.moeda(r, 0)}`
      : `renda de ${selRenda.selectedOptions[0].textContent.replace(/ \(.*\)$/, '')} (${f.moeda(r, 0)})`;
    let resumo = r > 0
      ? `${pessoas}, com ${rendaTexto}, gasta cerca de ${f.moeda(res.total, 0)} por mês com o básico da casa: ${f.porcentagem(res.parteTotal, 0)} da renda. `
      : 'Informe a renda da casa. ';
    if (r > 0) {
      resumo += res.sobra >= 0
        ? `Sobram ${f.moeda(res.sobra, 0)} para transporte, saúde, roupas, escola e todo o resto.`
        : `Faltam ${f.moeda(-res.sobra, 0)} só para o básico.`;
    }
    if (semValor.length) resumo += ` A conta ainda não inclui ${listaDeAnos(semValor)}: digite esses valores abaixo para completar.`;
    definirTopicos('orc-resumo', resumo);
    definir('orc-total', f.moeda(res.total, 0));
    definir('orc-sobra-rotulo', res.sobra >= 0 ? 'Sobra' : 'Falta');
    definir('orc-sobra', f.moeda(Math.abs(res.sobra), 0));

    // Salário necessário do DIEESE: calculado para 2 adultos e 2 crianças
    // (3 adultos equivalentes). Para outra família, o mesmo método dá o valor
    // proporcional às pessoas: necessário × unidades ÷ 3.
    const nec = c.ultimoValor(meses, s.smn_dieese);
    if (nec) {
      const smNec = c.ultimoValor(meses, s.salario_minimo.map((v, i) => (s.smn_dieese[i] == null ? null : v)));
      const necFamilia = (nec.valor * familia.unidades) / 3;
      let texto = `Pelas contas do DIEESE, uma família de 2 adultos e 2 crianças precisaria de ${f.moeda(nec.valor, 0)} por mês, em ${f.mesLongo(nec.mes)}, para pagar comida, moradia, saúde, educação, roupas, higiene, transporte, lazer e previdência: ${f.numero(nec.valor / smNec.valor, 1)} salários mínimos. `;
      if (familia.unidades !== 3) {
        texto += `Pelo mesmo método, para ${pessoasTexto}, o valor seria ${f.moeda(necFamilia, 0)} (${f.numero(necFamilia / smNec.valor, 1)} salários mínimos). `;
      }
      if (r > 0) texto += `A renda escolhida cobre ${f.porcentagem((r / necFamilia) * 100, 0)} desse valor.`;
      definirTopicos('orc-digno', texto);
    }

    registrarDownload('orcamento', () => ({
      nome: 'orcamento-da-familia.csv',
      cabecalhos: ['item', 'valor (R$)', 'parte da renda (%)', 'origem do valor'],
      linhas: [['renda', arred(r, 2), 100, selRenda.value === 'outro' ? 'digitado' : `${selRenda.value} salário(s) mínimo(s)`],
        ...res.itens.map((d) => [d.nome, d.valor, arred(d.parte, 1), d.nota])],
    }));
  };

  selRenda.addEventListener('change', () => calcular(false));
  campoOutra.addEventListener('input', () => calcular(false));
  selAdultos.addEventListener('change', () => calcular(false));
  selCriancas.addEventListener('change', () => calcular(false));
  aoMudarCidade(() => calcular(false));
  $('#orc-restaurar').addEventListener('click', () => { digitados.clear(); calcular(true); });
  calcular(true);
}

// ---------------------------------------------------------------------------
// Como era a vida em outros anos
// ---------------------------------------------------------------------------

// Cada item é comparado separadamente. Não existe nota única: juntar os itens
// exigiria decidir quanto vale cada um, e essa decisão é uma opinião.
// Itens com um lado claramente melhor (dólar e arrecadação ficam de fora; ver
// metodologia). "causas" são as séries de origem que explicam a mudança entre
// o período escolhido e hoje; só entram onde os dados mostram o mecanismo.
function indicadoresDoAno(ctx) {
  const { meses, s, ipca } = ctx;
  const sm = c.salarioMinimo(meses, s);
  const inpc = c.indiceAcumulado(s.inpc_var);
  const parteDoSalario = (serie, multiplicador) => s.salario_minimo.map((v, i) =>
    (v == null || serie?.[i] == null ? null : ((serie[i] * multiplicador) / v) * 100));
  const salario = { rotulo: 'o salário mínimo', serie: s.salario_minimo };
  const lista = [
    {
      id: 'salario', grupo: 'bolso', nome: 'Salário mínimo', curto: 'salário mínimo', secao: '#salario', dica: 'em dinheiro de hoje',
      explica: 'quanto vale em dinheiro de hoje (corrigido pela inflação, INPC)',
      valores: sm.real, tipo: 'media', maiorMelhor: true, formato: (v) => f.moeda(v, 0),
      causas: [salario, { rotulo: 'os preços (INPC)', serie: inpc }],
    },
    {
      id: 'cestas', grupo: 'bolso', nome: 'Cestas básicas por salário mínimo', curto: 'cestas básicas por salário', secao: '#compras',
      nomeCurto: 'Cestas básicas', dica: 'quantas o salário mínimo compra',
      explica: 'quantas cestas do DIEESE um salário mínimo compra',
      valores: s.cesta_total ? c.quantidadeComprada(s.salario_minimo, s.cesta_total) : null,
      tipo: 'media', maiorMelhor: true, formato: (v) => f.numero(v, 2),
      causas: [salario, { rotulo: 'a cesta básica', serie: s.cesta_total }],
    },
    {
      id: 'desemprego', grupo: 'bolso', nome: 'Desemprego', curto: 'desemprego', secao: null,
      explica: 'de cada 100 pessoas que trabalham ou procuram trabalho, quantas não encontram',
      valores: s.desocupacao, tipo: 'trimestral', maiorMelhor: false, formato: (v) => f.porcentagem(v, 1),
    },
    {
      id: 'renda', grupo: 'bolso', nome: 'Renda de quem trabalha', curto: 'renda do trabalho', secao: null, dica: 'média, em dinheiro de hoje',
      explica: 'média de todos os trabalhos, com ou sem carteira, em dinheiro de hoje',
      valores: s.renda_trabalho, tipo: 'trimestral', maiorMelhor: true, formato: (v) => f.moeda(v, 0),
    },
    {
      id: 'inflacao', grupo: 'bolso', nome: 'Inflação', curto: 'inflação', secao: null, meta: t.META_INFLACAO,
      dica: `em 12 meses; meta: ${f.porcentagem(t.META_INFLACAO.centro, 0)} ao ano`,
      explica: 'quanto os preços subiram em 12 meses (IPCA)',
      valores: s.ipca_var, tipo: 'acumulado', maiorMelhor: false, formato: (v) => f.porcentagem(v, 1),
    },
    {
      id: 'botijao', grupo: 'bolso', nome: 'Botijão de gás', curto: 'botijão de gás', secao: '#combustiveis', dica: 'parte do salário mínimo',
      explica: 'quanto pesa no salário mínimo',
      valores: s.comb_glp ? parteDoSalario(s.comb_glp, 1) : null,
      tipo: 'media', maiorMelhor: false, formato: (v) => f.porcentagem(v, 1),
      causas: [{ rotulo: 'o botijão', serie: s.comb_glp }, salario],
    },
    {
      id: 'tanque', grupo: 'bolso', nome: 'Tanque de gasolina', curto: 'gasolina', secao: '#combustiveis', dica: `${TANQUE_LITROS} litros, parte do salário mínimo`,
      explica: `quanto ${TANQUE_LITROS} litros pesam no salário mínimo`,
      valores: s.comb_gasolina ? parteDoSalario(s.comb_gasolina, TANQUE_LITROS) : null,
      tipo: 'media', maiorMelhor: false, formato: (v) => f.porcentagem(v, 0),
      causas: [{ rotulo: 'a gasolina', serie: s.comb_gasolina }, salario],
    },
    {
      id: 'divida', grupo: 'pais', dica: 'em % do que o país produz em um ano', nome: 'Dívida do governo', curto: 'dívida do governo', secao: '#contas',
      explica: 'tudo o que União, estados e municípios devem, em % de tudo o que o país produz em um ano (o PIB). 83% quer dizer que a dívida equivale a 83 de cada 100 reais produzidos no país em um ano',
      valores: s.divida_bruta_pib, tipo: 'fim', maiorMelhor: false, formato: (v) => f.porcentagem(v, 1),
      formatoCurto: (v) => f.porcentagem(v, 0),
      deficit: Array.isArray(s.nfsp_nominal) ? c.deflacionar(s.nfsp_nominal, ipca) : null,
    },
    // Séries do Banco Central já somadas em 12 meses, em % do PIB. Positivo é
    // déficit (o governo precisou pegar dinheiro emprestado).
    {
      id: 'deficit', grupo: 'pais', nome: 'Contas do governo, com os juros', nomeCurto: 'Contas do governo, com os juros', curto: 'contas do governo com os juros', secao: '#contas',
      explica: 'quanto faltou ou sobrou de dinheiro ao governo federal em 12 meses, contando os juros da dívida. Quando o governo gasta mais do que arrecada, falta dinheiro (é o déficit) e ele precisa pegar emprestado, o que aumenta a dívida; quando arrecada mais do que gasta, sobra (superávit). O valor está em % de tudo o que o país produz em um ano (o PIB)',
      dica: 'em 12 meses, em % do que o país produz',
      valores: s.nfsp_nominal_pib, tipo: 'doze', maiorMelhor: false,
      formato: (v) => (v >= 0 ? `faltou ${f.porcentagem(v, 1)}` : `sobrou ${f.porcentagem(-v, 1)}`),
      formatoCurto: (v) => (v >= 0 ? `faltou ${f.porcentagem(v, 1)}` : `sobrou ${f.porcentagem(-v, 1)}`),
    },
    {
      id: 'primario', grupo: 'pais', nome: 'Contas do governo, sem os juros', curto: 'contas do governo sem os juros', secao: '#contas',
      explica: 'a mesma conta sem os juros da dívida: mostra se o que o governo arrecada paga os gastos do dia a dia (salários, aposentadorias, saúde, educação). Faltou quer dizer gasto maior que a arrecadação (déficit); sobrou, arrecadação maior que o gasto (superávit). Em % de tudo o que o país produz em um ano (o PIB)',
      dica: 'em 12 meses, em % do que o país produz',
      // Invertido: positivo é sobra, negativo é falta.
      valores: Array.isArray(s.nfsp_primario_pib) ? s.nfsp_primario_pib.map((v) => (v == null ? null : -v)) : null,
      tipo: 'doze', maiorMelhor: true,
      formato: (v) => (v < 0 ? `faltou ${f.porcentagem(-v, 1)}` : `sobrou ${f.porcentagem(v, 1)}`),
      formatoCurto: (v) => (v < 0 ? `faltou ${f.porcentagem(-v, 1)}` : `sobrou ${f.porcentagem(v, 1)}`),
    },
    {
      id: 'juros', grupo: 'pais', nome: 'Juros da dívida', curto: 'juros da dívida', secao: '#contas',
      explica: 'quanto o governo federal pagou de juros sobre o que deve, em 12 meses, em % de tudo o que o país produz em um ano (o PIB). Quanto maior a dívida e os juros do país, maior essa conta',
      dica: 'pagos em 12 meses, em % do que o país produz',
      valores: s.nfsp_juros_pib, tipo: 'doze', maiorMelhor: false,
      formato: (v) => f.porcentagem(v, 1), formatoCurto: (v) => f.porcentagem(v, 1),
    },
    // Sem nota: mais imposto pode significar mais serviços ou mais peso no
    // bolso, e decidir isso é opinião. Mostra o número e a direção.
    {
      id: 'impostos', grupo: 'pais', nome: 'Impostos federais', curto: 'impostos federais', secao: '#arrecadacao', neutro: true,
      explica: 'quanto o governo federal arrecadou em impostos e contribuições em 12 meses, em % de tudo o que o país produz em um ano (o PIB); sem a contribuição ao INSS, para comparar anos de forma justa',
      dica: 'em 12 meses, em % do que o país produz',
      valores: c.razaoDozeMeses(ctx.comparavel, s.pib_mensal), tipo: 'doze', maiorMelhor: true,
      formato: (v) => f.porcentagem(v, 1), formatoCurto: (v) => f.porcentagem(v, 1),
    },
  ];
  return lista
    .filter((it) => Array.isArray(it.valores))
    .map((it) => ({ ...it, ...c.valoresAnuais(meses, it.valores, it.tipo) }))
    .filter((it) => it.anos.size >= 3 && it.hoje)
    .map((it) => ({ ...it, ranking: c.rankingDeAnos(it.anos, it.maiorMelhor) }));
}

function frasePosicao(vencidos, total, desde) {
  if (vencidos === total) return `Nos últimos 12 meses, está melhor do que em todos os ${total} anos desde ${desde}.`;
  if (vencidos === 0) return `Nos últimos 12 meses, não está melhor do que em nenhum dos ${total} anos desde ${desde}.`;
  return `Nos últimos 12 meses, está melhor do que em ${vencidos} dos ${total} anos desde ${desde}.`;
}

const listaDeAnos = (anos) => (anos.length <= 1 ? anos.join('')
  : `${anos.slice(0, -1).join(', ')} e ${anos[anos.length - 1]}`);

// Situação de hoje: inflação pela meta oficial; o resto pela própria história.
function nivelDeHoje(it) {
  if (it.neutro) return null;
  if (it.meta) {
    const v = it.hoje.valor;
    if (v > it.meta.teto) return { nivel: 'ruim', frase: `Está acima da meta, que é ${f.porcentagem(it.meta.centro, 0)} ao ano, aceitando até ${f.porcentagem(it.meta.teto, 1)}.` };
    if (v < it.meta.piso) return { nivel: 'medio', frase: `Está abaixo da meta, que é ${f.porcentagem(it.meta.centro, 0)} ao ano, aceitando a partir de ${f.porcentagem(it.meta.piso, 1)}.` };
    return { nivel: 'bom', frase: `Está dentro da meta, que é ${f.porcentagem(it.meta.centro, 0)} ao ano, aceitando até ${f.porcentagem(it.meta.teto, 1)}.` };
  }
  const p = c.posicaoNaHistoria(it.hoje.valor, it.anos, it.maiorMelhor);
  if (!p) return null;
  return { nivel: p.nivel, frase: frasePosicao(p.vencidos, p.total, Math.min(...it.anos.keys())) };
}

const NOME_NIVEL = { bom: 'Bom', medio: 'Na média', ruim: 'Ruim' };

// Comparação entre um momento escolhido e hoje -----------------------------
// Selo curto com o veredito e duas barras na mesma escala, começando do zero:
// a diferença de tamanho mostra quanto mudou. Usada no resumo e nas seções
// que têm "Comparar com".
function seloVeredito(pai, r, neutro = false) {
  // Neutro: só a direção (maior ou menor), sem dizer se é melhor.
  const [classe, texto] = neutro
    ? (r === 1 ? ['neutro', 'Maior hoje'] : r === -1 ? ['neutro', 'Menor hoje'] : r === 0 ? ['igual', 'Quase igual'] : ['sem', 'Sem dado'])
    : (r === 1 ? ['melhor', 'Melhor hoje'] : r === -1 ? ['pior', 'Pior hoje'] : r === 0 ? ['igual', 'Quase igual'] : ['sem', 'Sem dado']);
  return el('span', `veredito veredito-${classe}`, texto, pai);
}

function barrasAntesHoje(pai, linhas, formato) {
  const comp = el('div', 'comparacao', null, pai);
  // Barra começando do zero só faz sentido com valores positivos; com
  // déficit de um lado e sobra do outro, ficam só os números.
  const comBarras = linhas.every((l) => l.valor == null || l.valor >= 0);
  if (!comBarras) comp.classList.add('sem-barras');
  const maior = Math.max(...linhas.map((l) => Math.abs(l.valor ?? 0))) || 1;
  for (const l of linhas) {
    const div = el('div', `comp-linha ${l.classe}`, null, comp);
    const topoLinha = el('div', 'comp-topo', null, div);
    const nome = el('span', 'comp-rotulo', l.rotulo, topoLinha);
    if (l.quando) el('small', null, l.quando, nome);
    el('span', 'comp-valor', l.valor == null ? 'sem dado' : formato(l.valor), topoLinha);
    const trilho = el('div', 'comp-trilho', null, div);
    trilho.setAttribute('aria-hidden', 'true');
    if (l.valor != null && comBarras) el('div', 'comp-barra', null, trilho).style.width = `${Math.max(1, (l.valor / maior) * 100)}%`;
  }
  return comp;
}

// Caixa das seções com "Comparar com": hoje à esquerda e a data escolhida à
// direita, cada lado com os mesmos itens (salário, preço) e, em destaque, a
// medida comparada, com barra na mesma escala. Embaixo, o veredito em uma
// frase.
function caixaComparacao(caixa, { titulo, hoje, antes, itens, principal, maiorMelhor, frase }) {
  caixa.replaceChildren();
  const [vHoje, vAntes] = principal.valores;
  const r = vHoje == null || vAntes == null ? null : c.comparar(vHoje, vAntes, maiorMelhor);
  const cabeca = el('div', 'comp-cabeca', null, caixa);
  el('p', 'comp-titulo', titulo, cabeca);
  seloVeredito(cabeca, r);
  const grade = el('div', 'comp-lados', null, caixa);
  const maior = Math.max(Math.abs(vHoje ?? 0), Math.abs(vAntes ?? 0)) || 1;
  [[hoje, 0, 'comp-hoje'], [antes, 1, 'comp-antes']].forEach(([quando, k, classe]) => {
    const lado = el('div', `comp-lado ${classe}`, null, grade);
    el('p', 'comp-quando', quando, lado);
    const dl = el('dl', 'comp-itens', null, lado);
    for (const it of itens) {
      const div = el('div', null, null, dl);
      el('dt', null, it.rotulo, div);
      el('dd', null, it.valores[k], div);
    }
    const v = principal.valores[k];
    const destaque = el('p', 'comp-principal', null, lado);
    el('span', 'comp-numero', v == null ? 'sem dado' : principal.formato(v), destaque);
    el('span', 'comp-unidade', principal.rotulo, destaque);
    const trilho = el('div', 'comp-trilho', null, lado);
    trilho.setAttribute('aria-hidden', 'true');
    if (v != null) el('div', 'comp-barra', null, trilho).style.width = `${Math.max(1, (Math.max(0, v) / maior) * 100)}%`;
  });
  if (frase) el('p', 'comp-frase', frase(r), caixa);
}

const comMaiuscula = (texto) => texto.charAt(0).toUpperCase() + texto.slice(1);
const anoDe = (mes) => c.anoDe(mes);

function montarResumo(ctx) {
  const { meses, mandatos } = ctx;
  const itens = indicadoresDoAno(ctx);
  if (!itens.length) { $('#resumo').hidden = true; return; }
  itens.forEach((it) => { it.situacao = nivelDeHoje(it); });


  // Opções de comparação: governos que já terminaram (o mais recente primeiro,
  // que é o padrão) e anos completos.
  const anteriores = [...mandatos].filter((m) => m.fim).sort((a, b) => b.inicio.localeCompare(a.inicio));
  const periodos = new Map();
  // Cada governo é representado pelo último ano atribuído a ele (o ano é de
  // quem governou a maior parte dele): como o governo entregou o país. A
  // média do mandato misturaria crises do meio do caminho, como a pandemia.
  const todosOsAnosDoCalendario = [...new Set(meses.map((mes) => c.anoDe(mes)))];
  anteriores.forEach((m) => {
    const anosDoGoverno = todosOsAnosDoCalendario.filter((a) => c.governoDoAno(mandatos, a)?.id === m.id);
    if (!anosDoGoverno.length) return;
    const ano = Math.max(...anosDoGoverno);
    const indices = meses.map((mes, i) => (c.anoDe(mes) === ano ? i : -1)).filter((i) => i >= 0);
    periodos.set(`g:${m.id}`, {
      indices, ano, governo: true, rotulo: `Governo ${m.rotulo}`, curto: `${m.rotulo} (${ano})`,
      quando: `no último ano do governo ${m.rotulo} (${ano})`, de: ano, ate: ano, partido: m.partido,
    });
  });
  const todosOsAnos = [...new Set(itens.flatMap((it) => [...it.anos.keys()]))].sort((a, b) => b - a);
  todosOsAnos.forEach((ano) => {
    const indices = meses.map((mes, i) => (c.anoDe(mes) === ano ? i : -1)).filter((i) => i >= 0);
    periodos.set(`a:${ano}`, { indices, rotulo: String(ano), curto: `Em ${ano}`, quando: `em ${ano}`, de: ano, ate: ano, ano });
  });

  // O mesmo período vale na abertura e nos cartões: os dois seletores andam
  // juntos.
  const seletores = [$('#resumo-comparar'), $('#hoje-comparar')].filter(Boolean);
  for (const sel of seletores) {
    sel.replaceChildren();
    const grupoGov = el('optgroup', null, null, sel);
    grupoGov.label = 'Governos anteriores';
    const grupoAno = el('optgroup', null, null, sel);
    grupoAno.label = 'Anos';
    for (const [chave, p] of periodos) {
      const texto = p.governo ? `${p.rotulo}, último ano (${p.ano})` : p.rotulo;
      el('option', null, texto, p.ano ? grupoAno : grupoGov).value = chave;
    }
    sel.value = periodos.keys().next().value;
  }
  const select = seletores[0];

  const descricaoPeriodo = (it, p) => {
    if (p.ano) return { media: `média de ${p.ano}`, trimestral: `média de ${p.ano}`, acumulado: `em ${p.ano}`, fim: `dez/${p.ano}`, doze: `em ${p.ano}` }[it.tipo];
    const intervalo = `${p.de} a ${p.ate}`;
    return { media: `média de ${intervalo}`, trimestral: `média de ${intervalo}`, acumulado: `média por ano, ${intervalo}`,
      fim: `no fim, ${f.mesCurto(meses[p.indices[p.indices.length - 1]])}`, doze: `média por ano, ${intervalo}` }[it.tipo];
  };
  const descricaoHoje = (it) => (it.tipo === 'fim' ? f.mesCurto(it.hoje.ate) : `${f.mesCurto(it.hoje.de)} a ${f.mesCurto(it.hoje.ate)}`);
  // Governos: aceita até 10% dos meses sem dado (a ANP, por exemplo, não
  // publicou setembro de 2020). Anos continuam exigindo os 12 meses.
  const valorNoPeriodo = (it, p) => (p.ano ? it.anos.get(p.ano) ?? null : c.valorDoPeriodo(meses, it.valores, it.tipo, p.indices, 0.9));
  const primeiroMesComDado = (it) => meses[it.valores.findIndex((v) => v != null)];

  // Abertura: como está cada número hoje, comparado com a própria história,
  // em grupos: o bolso das pessoas, as contas do país e, com uma cidade
  // escolhida, as contas do estado. Só o bolso daria uma ideia incompleta.
  // Em cada grupo, primeiro o que está bom, depois na média e ruim; cada
  // linha leva à seção.
  const caixaHoje = $('#hoje-lista');
  const ordem = { bom: 0, medio: 1, ruim: 2 };
  const linhaHoje = (lista, { href, nome, dica, valor, selo, comparacao }) => {
    const li = el('li', null, null, lista);
    const a = el('a', null, null, li);
    a.href = href;
    const span = el('span', 'hoje-nome', nome, a);
    if (dica) el('small', null, dica, span);
    el('span', 'hoje-valor', valor, a);
    if (selo) el('span', `selo selo-${selo.nivel}`, selo.texto, a);
    if (comparacao) {
      const linha = el('span', 'hoje-compara', `${comparacao.texto} · `, a);
      el('strong', `compara-${comparacao.classe}`, comparacao.palavra, linha);
    }
  };
  // Comparação com o período escolhido, em palavras (sem seta: no
  // desemprego, cair é melhorar).
  const comparacaoHoje = (it) => {
    const p = periodos.get(seletores[seletores.length - 1]?.value ?? select.value);
    if (!p) return null;
    const v = valorNoPeriodo(it, p);
    if (v == null) return { texto: `${p.curto}: sem dado`, palavra: 'sem comparação', classe: 'neutro' };
    const r = c.comparar(it.hoje.valor, v, it.neutro ? true : it.maiorMelhor);
    const [palavra, classe] = it.neutro
      ? (r === 1 ? ['maior hoje', 'neutro'] : r === -1 ? ['menor hoje', 'neutro'] : ['quase igual', 'neutro'])
      : (r === 1 ? ['melhor hoje', 'melhor'] : r === -1 ? ['pior hoje', 'pior'] : ['quase igual', 'neutro']);
    return { texto: `${p.curto}: ${(it.formatoCurto ?? it.formato)(v)}`, palavra, classe };
  };
  const desenharHoje = () => {
    if (!caixaHoje) return;
    caixaHoje.replaceChildren();
    for (const [grupo, titulo] of [['bolso', 'No seu bolso'], ['pais', 'Nas contas do país']]) {
      const doGrupo = itens.filter((it) => it.grupo === grupo);
      if (!doGrupo.length) continue;
      el('p', 'hoje-grupo', titulo, caixaHoje);
      const lista = el('ul', null, null, caixaHoje);
      [...doGrupo].sort((a, b) => (ordem[a.situacao?.nivel] ?? 3) - (ordem[b.situacao?.nivel] ?? 3)).forEach((it) => linhaHoje(lista, {
        href: it.secao ?? '#resumo',
        nome: it.nomeCurto ?? it.nome,
        dica: it.dica,
        valor: (it.formatoCurto ?? it.formato)(it.hoje.valor),
        selo: it.situacao ? { nivel: it.situacao.nivel, texto: NOME_NIVEL[it.situacao.nivel] } : (it.neutro ? { nivel: 'neutro', texto: 'Sem nota' } : null),
        comparacao: comparacaoHoje(it),
      }));
    }
    // Contas do estado da cidade escolhida: dívida e folha frente ao limite
    // da lei, no último ano publicado.
    const bloco = ctx.d.estados_fiscal;
    const uf = cidade.dados?.uf ? bloco?.estados?.find((e) => e.sigla === cidade.dados.uf) : null;
    if (uf && bloco.anos?.length) {
      const k = bloco.anos.length - 1;
      const ano = bloco.anos[k];
      const ind = (chave) => uf.indicadores?.[chave]?.[k] ?? null;
      const nivelLimite = { 'dentro do limite': ['bom', 'Dentro do limite'], 'perto do limite': ['medio', 'Perto do limite'], 'acima do limite': ['ruim', 'Acima do limite'] };
      const selo = (sit) => (sit ? { nivel: nivelLimite[sit][0], texto: nivelLimite[sit][1] } : null);
      el('p', 'hoje-grupo', `Nas contas do estado (${uf.nome})`, caixaHoje);
      const lista = el('ul', null, null, caixaHoje);
      const div = ind('dcl_rcl_pct');
      const limDiv = bloco.limite_divida_pct ?? 200;
      if (div != null) {
        linhaHoje(lista, { href: '#estados', nome: 'Dívida do estado', dica: `para cada R$ 100 que entram no ano (${ano}); a lei permite ${f.moeda(limDiv, 0)}`,
          valor: f.moeda(div, 0), selo: selo(situacao(div, limDiv, bloco.alerta_divida_pct ?? 180)) });
      }
      const fol = ind('pessoal_rcl_pct');
      if (fol != null) {
        linhaHoje(lista, { href: '#estados', nome: 'Folha de pagamento', dica: `de cada R$ 100 que entram (${ano}); a lei permite ${f.moeda(ind('pessoal_limite_pct'), 2)}`,
          valor: f.moeda(fol, 0), selo: selo(situacao(fol, ind('pessoal_limite_pct'), ind('pessoal_alerta_pct'))) });
      }
    } else {
      const p = el('p', 'hoje-estado', 'Para ver também as contas do seu estado, ', caixaHoje);
      const a = el('a', null, 'escolha o estado', p);
      a.href = '#estados';
      p.append('.');
    }
  };
  desenharHoje();
  aoMudarCidade(desenharHoje);

  // "Por quê": variação das séries de origem entre o período e hoje.
  const variacaoDaCausa = (serie, p) => {
    const antes = c.valorDoPeriodo(meses, serie, 'media', p.indices, p.ano ? 1 : 0.9);
    const depois = c.valoresAnuais(meses, serie, 'media').hoje?.valor;
    return antes && depois ? (depois / antes - 1) * 100 : null;
  };
  const fraseCausas = (it, p) => {
    if (it.causas) {
      const partes = it.causas.map((causa) => ({ ...causa, v: variacaoDaCausa(causa.serie, p) }));
      if (partes.some((x) => x.v == null)) return null;
      const verbo = (v) => (Math.abs(v) < 0.5 ? 'ficou praticamente igual' : `${v > 0 ? 'subiu' : 'caiu'} ${f.porcentagem(Math.abs(v), 0)}`);
      const [a, b] = partes;
      // "o salário mínimo subiu 45% e os preços (INPC), 38%": o verbo só se
      // repete quando o sentido muda.
      const mesmoSentido = Math.abs(a.v) >= 0.5 && Math.abs(b.v) >= 0.5 && Math.sign(a.v) === Math.sign(b.v);
      const segundo = mesmoSentido ? `${b.rotulo}, ${f.porcentagem(Math.abs(b.v), 0)}` : `${b.rotulo} ${verbo(b.v)}`;
      return `Desde então, ${a.rotulo} ${verbo(a.v)} e ${segundo}.`;
    }
    if (it.deficit) {
      const inicio = p.indices[p.indices.length - 1] + 1;
      const fim = c.ultimoIndice(it.deficit);
      if (inicio > fim) return null;
      const trecho = it.deficit.slice(inicio, fim + 1);
      if (trecho.some((v) => v == null)) return null;
      const soma = trecho.reduce((a, v) => a + v, 0) * 1e6;
      return soma >= 0
        ? `Depois de ${f.mesLongo(meses[inicio - 1])}, o governo federal gastou ${f.reaisPorExtenso(soma)} a mais do que arrecadou, contando os juros da dívida, e pegou emprestada a diferença (em dinheiro de hoje).`
        : `Depois de ${f.mesLongo(meses[inicio - 1])}, o governo federal arrecadou ${f.reaisPorExtenso(-soma)} a mais do que gastou, contando os juros da dívida (em dinheiro de hoje).`;
    }
    return null;
  };

  const desenhar = () => {
    const p = periodos.get(select.value);
    const caixaLista = $('#resumo-lista');
    caixaLista.replaceChildren();
    const listas = {};
    for (const [grupo, titulo] of [['bolso', 'No seu bolso'], ['pais', 'Nas contas do país']]) {
      if (!itens.some((it) => it.grupo === grupo)) continue;
      el('h3', 'grupo-titulo', titulo, caixaLista);
      listas[grupo] = el('ul', 'anos-lista', null, caixaLista);
    }
    for (const it of itens) {
      const li = el('li', 'ano-item', null, listas[it.grupo]);
      const vSel = valorNoPeriodo(it, p);
      const r = vSel == null ? null : c.comparar(it.hoje.valor, vSel, it.neutro ? true : it.maiorMelhor);

      // Topo: nome do item e um selo curto com o veredito. O selo (bom, na
      // média, ruim) da abertura compara com a história; este compara só com
      // o período escolhido.
      const topo = el('div', 'ano-topo', null, li);
      el('h3', 'ano-nome', it.nome, topo);
      seloVeredito(topo, r, it.neutro);
      el('p', 'ano-explica', it.explica, li);

      // Duas barras na mesma escala, começando do zero: o período escolhido e hoje.
      barrasAntesHoje(li, [
        { classe: 'comp-antes', rotulo: p.rotulo, quando: vSel == null ? null : descricaoPeriodo(it, p), valor: vSel },
        { classe: 'comp-hoje', rotulo: 'Hoje', quando: descricaoHoje(it), valor: it.hoje.valor },
      ], it.formato);

      if (vSel == null) {
        const inicio = primeiroMesComDado(it);
        el('p', 'ano-porque', meses[p.indices[0]] < inicio
          ? `Sem dado para esse período: a pesquisa começa em ${c.anoDe(inicio)}.`
          : 'Faltam dados da pesquisa nesse período.', li);
      }
      const porque = vSel == null ? null : fraseCausas(it, p);
      if (porque) el('p', 'ano-porque', porque, li);
      if (it.situacao) el('p', 'ano-ranking', it.situacao.frase, li);
      if (it.neutro) el('p', 'ano-ranking', 'Sem nota: mais imposto pode significar mais serviços ou mais peso no bolso, e decidir isso é opinião.', li);
      if (it.secao) {
        const a = el('a', 'ano-link', 'Ver detalhes', li);
        a.href = it.secao;
      }
    }
  };
  seletores.forEach((sel) => sel.addEventListener('change', () => {
    seletores.forEach((outro) => { outro.value = sel.value; });
    desenharHoje();
    desenhar();
  }));
  desenhar();

  registrarDownload('resumo', () => ({
    nome: 'resumo-por-ano-e-governo.csv',
    cabecalhos: ['período', ...itens.map((it) => it.nome)],
    linhas: [
      ['hoje (últimos 12 meses)', ...itens.map((it) => arred(it.hoje.valor, 2))],
      ...[...periodos.values()].map((p) => [p.governo ? `${p.rotulo}, último ano (${p.ano})` : String(p.ano),
        ...itens.map((it) => arred(valorNoPeriodo(it, p), 2))]),
    ],
  }));
}

// ---------------------------------------------------------------------------
// Combustíveis
// ---------------------------------------------------------------------------

const ITENS_COMBUSTIVEL = [
  { id: 'gasolina', serie: 'comb_gasolina', nome: 'Gasolina', descricao: 'o litro da gasolina comum', sujeito: 'a gasolina', feminino: true, litro: true },
  { id: 'etanol', serie: 'comb_etanol', nome: 'Etanol', descricao: 'o litro do etanol', sujeito: 'o etanol', feminino: false, litro: true },
  { id: 'diesel', serie: 'comb_diesel', nome: 'Diesel', descricao: 'o litro do diesel', sujeito: 'o diesel', feminino: false, litro: true },
  { id: 'botijao', serie: 'comb_glp', nome: 'Botijão de gás', descricao: 'o botijão de gás de 13 kg', sujeito: 'o botijão', feminino: false, litro: false },
];
const TANQUE_LITROS = 50;

// Régua do salário: o preço antigo é trazido para hoje pelo que ele pesava no
// salário mínimo da época. Responde "ficou mais fácil ou mais difícil de
// pagar para quem ganha o mínimo?", que é diferente de descontar a inflação.
function montarCombustiveis(ctx) {
  const { meses, s, mandatos } = ctx;
  const itens = ITENS_COMBUSTIVEL.filter((it) => Array.isArray(s[it.serie]));
  if (!itens.length) { $('#combustiveis').hidden = true; return; }
  let grafico = null;
  let item = itens[0];
  let anoEscolhido = null;

  const desenhar = () => {
    const local = cidade.dados?.series?.[item.serie];
    const nominal = local ?? s[item.serie];
    const onde = local ? `no estado ${t.doEstado(cidade.dados.uf, cidade.dados.uf_nome ?? cidade.dados.uf)}` : 'no país';
    // Régua: quanto do salário mínimo do mesmo mês vai para encher o tanque
    // (ou comprar o botijão). Preço e salário da mesma época, sem precisar
    // corrigir pela inflação.
    const custo = (i) => (nominal[i] == null ? null : (item.litro ? nominal[i] * TANQUE_LITROS : nominal[i]));
    const partes = meses.map((m, i) => (custo(i) == null || !s.salario_minimo[i] ? null : (custo(i) / s.salario_minimo[i]) * 100));
    const { iUlt, candidatos } = mesesParaComparar(meses, partes);
    if (iUlt < 0 || !candidatos.length) return;
    const iA = indiceDoAno(meses, candidatos, anoEscolhido);
    preencherAnos($('#combustiveis-ano'), meses, candidatos, iA);
    const casas = item.litro ? 0 : 1;
    const pct = (v) => f.porcentagem(v, casas);
    const oque = item.litro ? `Encher um tanque de ${TANQUE_LITROS} litros de ${item.nome.toLowerCase()}` : 'Um botijão de gás de 13 kg';

    definirTopicos('combustiveis-resumo',
      `${oque} custa ${f.moeda(custo(iUlt), 0)} ${onde}, ${pct(partes[iUlt])} do salário mínimo; em ${f.mesLongo(meses[iA])}, ${item.litro ? 'levava' : 'levava'} ${pct(partes[iA])}.`);

    const unidade = item.litro ? 'litro' : 'botijão';
    const coisa = item.litro ? `Tanque (${TANQUE_LITROS} L)` : 'Botijão';
    caixaComparacao($('#combustiveis-comparacao'), {
      titulo: item.litro ? `Encher o tanque de ${item.nome.toLowerCase()}` : 'Comprar um botijão de gás',
      hoje: `Hoje (${f.mesCurto(meses[iUlt])})`,
      antes: comMaiuscula(f.mesCurto(meses[iA])),
      itens: [
        { rotulo: 'Salário mínimo', valores: [f.moeda(s.salario_minimo[iUlt], 0), f.moeda(s.salario_minimo[iA], 0)] },
        { rotulo: coisa, valores: [f.moeda(custo(iUlt), 0), f.moeda(custo(iA), 0)] },
      ],
      principal: { rotulo: 'do salário', valores: [partes[iUlt], partes[iA]], formato: pct },
      maiorMelhor: false,
      frase: (r) => (r === 1 ? `Melhor hoje: ${item.litro ? 'o tanque' : 'o botijão'} leva uma parte menor do salário do que em ${anoDe(meses[iA])}.`
        : r === -1 ? `Pior hoje: ${item.litro ? 'o tanque' : 'o botijão'} leva uma parte maior do salário do que em ${anoDe(meses[iA])}.`
          : `Quase igual: ${item.litro ? 'o tanque' : 'o botijão'} leva do salário praticamente o mesmo que em ${anoDe(meses[iA])}.`),
    });
    $('#combustiveis-numeros').replaceChildren();

    // O gráfico começa no primeiro mês com preço publicado.
    const iIni = partes.findIndex((v) => v != null);
    const mesesG = meses.slice(iIni);
    const opcoes = {
      tipo: 'linhas',
      rotulos: mesesG,
      faixas: c.faixasDeMandato(mandatos, mesesG),
      series: [{ nome: item.litro ? 'Tanque de 50 litros' : 'Botijão', classe: 'serie-1', valores: partes.slice(iIni) }],
      formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : `${pct(v)} do salário mínimo`),
      unidade: '% do salário mínimo do mês',
      rotuloEixoX: rotuloMesNoEixo(5),
      tituloTooltip: (i) => f.mesCurto(mesesG[i]),
      extraTooltip: (i) => [`${comMaiuscula(unidade)} a ${f.moeda(nominal[iIni + i], 2)}; salário de ${f.moeda(s.salario_minimo[iIni + i], 0)}`, textoGoverno(ctx, mesesG[i])].filter(Boolean).join(' · '),
      descricao: `Quanto ${item.litro ? 'encher o tanque' : 'o botijão'} levava do salário mínimo em cada mês.`,
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-combustiveis'), opcoes);

    registrarDownload('combustiveis', () => ({
      nome: `combustivel-${item.id}-mensal${cidade.dados?.series?.[item.serie] ? `-${cidade.dados.uf}` : ''}.csv`,
      cabecalhos: ['mes', `preco do ${unidade} (R$)`, 'salario minimo (R$)', `% do salario minimo (${item.litro ? `tanque de ${TANQUE_LITROS} litros` : 'botijao'})`],
      linhas: meses.map((m, i) => [m, nominal[i], s.salario_minimo[i], arred(partes[i], 2)]).filter((l) => l[1] != null),
    }));
  };

  montarEscolhas($('#combustiveis-itens'), 'combustivel-item', itens, (novo) => { item = novo; desenhar(); });
  aoMudarCidade(desenhar);
  $('#combustiveis-ano').addEventListener('change', (ev) => { anoEscolhido = c.anoDe(meses[Number(ev.target.value)]); desenhar(); });
  desenhar();
}

// ---------------------------------------------------------------------------
// Avisos e fontes
// ---------------------------------------------------------------------------

const NOMES_COLETA = {
  sgs_1619: 'Salário mínimo (Banco Central)',
  sgs_433: 'IPCA (IBGE via Banco Central)',
  sgs_188: 'INPC (IBGE via Banco Central)',
  sgs_3698: 'Dólar (Banco Central)',
  sgs_4380: 'PIB mensal (Banco Central)',
  rfb_csv: 'Arrecadação federal (Receita Federal)',
  dieese_smn: 'Salário mínimo necessário (DIEESE)',
  anp_csv: 'Preços de combustíveis (ANP)',
  ibge_municipios: 'Lista de municípios (IBGE)',
};

function nomeDaColeta(id) {
  if (NOMES_COLETA[id]) return NOMES_COLETA[id];
  if (id.startsWith('bls')) return 'Inflação dos EUA (BLS)';
  if (id.startsWith('dieese_')) return 'Preços da cesta básica (DIEESE)';
  return id;
}

// Nomes das partes da arrecadação como um leigo entende.
const RUBRICA_SIMPLES = {
  'Receita previdenciária': 'a contribuição ao INSS',
  'Receitas administradas por outros órgãos': 'as receitas de outros órgãos federais (como royalties)',
};

// Seção afetada por cada coleta, para o lembrete curto no lugar certo.
const SECAO_DA_COLETA = {
  sgs_1619: '#salario', sgs_188: '#salario', sgs_3698: '#dolar', sgs_433: '#arrecadacao', sgs_4380: '#arrecadacao',
  rfb_csv: '#arrecadacao', dieese_smn: '#salario', anp_csv: '#combustiveis',
};

function montarAvisos(ctx) {
  const lista = $('#lista-avisos');
  lista.replaceChildren();
  document.querySelectorAll('.aviso-curto').forEach((e) => e.remove());
  const avisos = [];

  for (const a of ctx.d.avisos ?? []) {
    if (a.tipo === 'valores_repetidos') {
      const afetaComparavel = ctx.grupos.find((g) => g.grupo === a.grupo)?.comparavel;
      const parte = RUBRICA_SIMPLES[a.rubrica] ?? `a parte "${a.rubrica.toLowerCase()}"`;
      avisos.push({
        titulo: `A Receita Federal publicou ${parte} de ${f.mesLongo(a.mes)} com os mesmos números de ${f.mesLongo(a.igual_a)}`,
        texto: `Os números são iguais em todos os estados, o que indica erro no arquivo da Receita. O site mostra o dado como foi publicado e corrige quando a Receita corrigir. ${afetaComparavel
          ? 'Isso afeta a comparação da arrecadação entre os anos.'
          : 'A comparação entre os anos não usa essa parte, então não muda. O contador e a lista "De onde vem o dinheiro" usam, e ficam menores do que deveriam nesse mês.'}`,
        secoes: afetaComparavel ? ['#arrecadacao', '#composicao'] : ['#contador', '#composicao'],
      });
    }
  }

  for (const k of ctx.d.coletas ?? []) {
    if (k.ultimo_status === 'erro') {
      const nome = nomeDaColeta(k.id);
      avisos.push({
        titulo: `Não foi possível atualizar ${nome} na última tentativa`,
        texto: `Os números mostrados são da última atualização que deu certo${k.ultima_ok ? `, em ${f.dataDeTimestamp(k.ultima_ok)}` : ''}. O site tenta de novo todo dia.`,
        secoes: SECAO_DA_COLETA[k.id] ? [SECAO_DA_COLETA[k.id]] : [],
      });
    }
  }

  if (!avisos.length) {
    el('p', null, 'Nenhum problema encontrado na última verificação.', lista);
    return;
  }
  for (const a of avisos) {
    const caixa = el('div', 'aviso', null, lista);
    const icone = el('span', 'aviso-icone', '!', caixa);
    icone.setAttribute('aria-hidden', 'true');
    const corpo = el('div', null, null, caixa);
    el('strong', null, a.titulo, corpo);
    el('p', null, a.texto, corpo);
  }

  // Lembrete curto no topo de cada seção afetada, com link para o aviso.
  const porSecao = new Map();
  avisos.forEach((a) => a.secoes.forEach((sec) => porSecao.set(sec, (porSecao.get(sec) ?? 0) + 1)));
  for (const [sec, n] of porSecao) {
    const secao = $(sec);
    const titulo = secao?.querySelector('h2');
    if (!titulo) continue;
    const p = el('p', 'aviso-curto', n === 1 ? 'Há um aviso sobre os dados desta parte. ' : `Há ${n} avisos sobre os dados desta parte. `);
    const link = el('a', null, n === 1 ? 'Ver o aviso' : 'Ver os avisos', p);
    link.href = '#avisos';
    // No contador, o lembrete vem depois do número, não entre o rótulo e ele.
    (secao.querySelector('.contador-exato') ?? titulo).after(p);
  }
}

function montarFontes(ctx) {
  const { d } = ctx;
  const lista = $('#lista-fontes');
  lista.replaceChildren();
  const seriesPorFonte = new Map();
  for (const s of d.series) {
    if (!seriesPorFonte.has(s.fonte)) seriesPorFonte.set(s.fonte, []);
    seriesPorFonte.get(s.fonte).push(s);
  }
  for (const fonte of d.fontes) {
    const li = el('li', null, null, lista);
    const titulo = el('div', null, null, li);
    const a = el('a', null, fonte.nome, titulo);
    a.href = fonte.url;
    a.rel = 'noopener';
    el('div', 'orgao', fonte.orgao, li);
    const series = seriesPorFonte.get(fonte.id) ?? [];
    for (const s of series) {
      el('div', 'status', `${s.nome}${s.codigo ? ` (${s.codigo})` : ''}: dado até ${f.mesCurto(s.ultimo_periodo)}`, li);
    }
    if (fonte.id === 'rfb_arrecadacao') {
      el('div', 'status', `Arrecadação mensal por UF e tributo: ${f.mesCurto(d.arrecadacao.primeiro_periodo)} a ${f.mesCurto(d.arrecadacao.ultimo_periodo)}`, li);
    }
    if (fonte.id === 'rfb_irpf') {
      el('div', 'status', `${d.ir_tabela.length} tabelas mensais, de ${f.mesCurto(d.ir_tabela[0].inicio)} a ${f.mesCurto(d.ir_tabela[d.ir_tabela.length - 1].inicio)}`, li);
    }
    if (fonte.id === 'tse') {
      el('div', 'status', `${d.mandatos.length} mandatos presidenciais desde 1995`, li);
    }
  }
  definir('versao', d.versao.slice(0, 12));
  definir('atualizado-em', f.dataDeTimestamp(d.gerado_em));
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

const downloads = new Map();
function registrarDownload(chave, gerar) {
  downloads.set(chave, gerar);
}
document.addEventListener('click', (ev) => {
  const botao = ev.target.closest('[data-baixar]');
  if (!botao) return;
  const gerar = downloads.get(botao.dataset.baixar);
  if (!gerar) return;
  const { nome, cabecalhos, linhas } = gerar();
  baixarCSV(nome, cabecalhos, linhas);
});

// ---------------------------------------------------------------------------
// Navegação: barra de atalhos fixa, atalho da seção visível em destaque e
// correção do salto para #seção quando a página abre antes dos dados.
// ---------------------------------------------------------------------------

let usuarioRolou = false;
['wheel', 'touchmove', 'keydown'].forEach((evento) => {
  window.addEventListener(evento, () => { usuarioRolou = true; }, { passive: true });
});
window.addEventListener('hashchange', () => { usuarioRolou = false; });

function reposicionarNaSecao() {
  if (usuarioRolou) return;
  const id = decodeURIComponent(window.location.hash.slice(1));
  const alvo = id ? document.getElementById(id) : null;
  if (alvo) alvo.scrollIntoView({ block: 'start' });
}

function iniciarNavegacao() {
  const menu = $('#secoes');
  if (!menu) return;
  const links = [...menu.querySelectorAll('a[href^="#"]')];
  const secoes = links.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);

  // O menu fecha ao escolher uma seção, ao tocar fora dele e com Esc.
  links.forEach((a) => a.addEventListener('click', () => { menu.open = false; }));
  document.addEventListener('click', (ev) => { if (menu.open && !menu.contains(ev.target)) menu.open = false; });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
  });

  // A seção em leitura fica marcada no menu.
  const visiveis = new Set();
  const observador = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => (e.isIntersecting ? visiveis.add(e.target.id) : visiveis.delete(e.target.id)));
    const atual = secoes.find((sec) => visiveis.has(sec.id));
    links.forEach((a) => {
      if (atual && a.getAttribute('href') === `#${atual.id}`) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }, { rootMargin: '-70px 0px -55% 0px' });
  secoes.forEach((sec) => observador.observe(sec));
}

// ---------------------------------------------------------------------------

async function iniciar() {
  const main = $('#conteudo');
  try {
    const dados = await carregarPainel();
    const ctx = preparar(dados);
    cidade.n = ctx.meses.length;
    try {
      cidade.indice = await carregarIndiceCidades();
    } catch (erro) {
      console.error(erro);
      cidade.indice = [];
    }
    montarSeletoresDeCidade();
    const etapas = [iniciarContador, montarOrcamento, montarResumo, montarCompras, montarCombustiveis, montarSalario, montarArrecadacao,
      montarComposicao, montarComposicaoEstados, montarGastos, montarMinisterios, montarCartao, montarViagens, montarContas, montarEstados, montarCota,
      montarDolar, montarIR, montarAvisos, montarFontes];
    for (const etapa of etapas) {
      try {
        etapa(ctx);
      } catch (erro) {
        console.error(`Falha em ${etapa.name}:`, erro);
      }
    }
    const guardada = lerCidadeGuardada();
    if (guardada) await escolherCidade(guardada);
  } catch (erro) {
    console.error(erro);
    // Sem dados, nenhum número aparece: melhor a mensagem do que "R$ 0".
    main.classList.add('falhou');
    $('#erro-carga').hidden = false;
    $('#erro-recarregar')?.addEventListener('click', () => window.location.reload());
  } finally {
    main.classList.remove('carregando');
    main.removeAttribute('aria-busy');
    // Depois que tudo foi desenhado, refaz o salto para #seção, se houver.
    requestAnimationFrame(reposicionarNaSecao);
  }
}

iniciarNavegacao();
iniciar();
