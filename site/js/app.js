import * as c from './calculos.js';
import * as f from './formato.js';
import { montarIndice, acompanharLeitura } from './indice.js';
import * as t from './textos.js';
import { criarGrafico, preencherTabela, baixarCSV } from './graficos.js';
import { carregarPainel, carregarIndiceCidades, carregarCidade, carregarIndiceCota, carregarCotaAno, carregarPortal, carregarIndiceMunicipios, carregarMunicipiosUf, carregarFolha, carregarAgenda } from './dados.js';

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
    avisarCrises($('#tabela-arrecadacao-governos'), resumo);
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
    el('span', 'barra-valor', `${f.parteDoTotal(pct)} · ${f.reaisCompacto(g.soma)}`, topo);
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

    // A divisão por área fica nas barras logo abaixo; o resumo não repete.
    definirTopicos('gastos-resumo',
      `Em ${anos[k]}, o governo federal gastou ${f.reaisPorExtenso(totalAno)}, sem contar a rolagem da dívida. `
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
    // A conta em três linhas: sem os juros, os juros, e o total. A parte do
    // PIB aparece uma vez, no cabeçalho da coluna.
    const caixa = campo('contas-resumo')[0];
    caixa.replaceChildren();
    el('p', 'conta-titulo', `Governo federal, nos 12 meses até ${ate}`, caixa);
    const dl = el('dl', 'conta conta-pib', null, caixa);
    const cab = el('div', 'conta-cabeca', null, dl);
    el('dt', null, '', cab);
    el('dd', null, 'em reais', cab);
    el('dd', null, '% do PIB', cab);
    const linha = (rotulo, reais, pct, classe) => {
      const div = el('div', classe ?? null, null, dl);
      el('dt', null, rotulo, div);
      el('dd', null, f.reaisCompacto(Math.abs(reais)), div);
      el('dd', null, f.porcentagem(Math.abs(pct), 1), div);
    };
    linha(p >= 0 ? 'Sem contar os juros, sobrou (superávit)' : 'Sem contar os juros, faltou (déficit)', p, pPib.hoje.valor);
    linha(p >= 0 ? 'Menos os juros da dívida' : 'Mais os juros da dívida', jR.hoje.valor * 1e6, jPib.hoje.valor);
    linha(n >= 0 ? 'No total, sobrou' : 'No total, faltou', n, nPib.hoje.valor, `conta-fim${n < 0 ? ' conta-falta' : ''}`);
    const fim = [];
    if (n < 0) fim.push('O que faltou foi pago com dinheiro emprestado, e por isso a dívida cresce.');
    if (dPib.hoje) fim.push(`Hoje o governo (União, estados e municípios) deve ${f.moeda(dPib.hoje.valor, 0)} para cada R$ 100 que o país produz em um ano (${f.mesCurto(dPib.hoje.ate)}).`);
    el('p', 'conta-nota', `PIB é tudo o que o país produz em um ano. ${fim.join(' ')}`, caixa);
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
  const sinal = (x) => (x == null ? 'sem dado' : f.porcentagem(x, 1, true));
  const desenharGovernos = () => {
  const resumo = c.resumoPorGoverno(linhasAno, mandatos, ['primario', 'nominal'], { excluirPrimeiroAno: $('#contas-excluir-primeiro').checked });
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
  avisarCrises($('#tabela-contas-governos'), resumo);
  };
  $('#contas-excluir-primeiro').addEventListener('change', desenharGovernos);
  desenharGovernos();

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
        // Dívida líquida negativa: o estado tem mais em caixa do que deve.
        div == null ? 'sem dado' : div < 0 ? { texto: 'não deve', detalhe: 'mais caixa que dívida' }
          : { texto: f.moeda(div, 0), detalhe: marca(sitDiv), destaque: sitDiv === 'acima do limite' },
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

// O Portal usa o código -1, com o nome "Sem informação", para gasto sem órgão
// identificado. O nome mostrado diz isso com clareza; o código fica igual.
const nomeDoOrgao = (o, ano) => (o.codigo === '-1' ? 'Órgão não informado pelo Portal'
  : o.nomes[String(ano)] ?? Object.values(o.nomes).pop() ?? o.codigo);

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
    el('span', 'barra-valor', `${f.parteDoTotal(pct)} · ${f.reaisCompacto(g.valor)}`, topo);
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
// Aviso de crise nas tabelas por governo, com a mesma regra fixa da
// abertura: os anos de cada linha que cruzam uma crise com data oficial.
function avisarCrises(tabela, resumo) {
  const caixa = tabela.closest('.tabela-rolagem') ?? tabela;
  let aviso = caixa.nextElementSibling?.classList.contains('aviso-crise') ? caixa.nextElementSibling : null;
  const grupos = new Map();
  for (const r of resumo) {
    const crises = CRISES.filter((x) => (r.anos ?? []).some((a) => `${a}-01` <= x.ate && `${a}-12` >= x.de));
    if (!crises.length) continue;
    const chave = crises.map((x) => x.nome).join('|');
    if (!grupos.has(chave)) grupos.set(chave, { rotulos: [], crises });
    grupos.get(chave).rotulos.push(r.rotulo);
  }
  if (!grupos.size) { if (aviso) aviso.hidden = true; return; }
  if (!aviso) {
    aviso = el('p', 'aviso-crise');
    aviso.setAttribute('role', 'note');
    caixa.after(aviso);
  }
  aviso.hidden = false;
  const partes = [...grupos.values()].map((g) => `${listaDeAnos(g.rotulos)}, ${listaDeAnos(g.crises.map((x) => x.nome))}`);
  aviso.textContent = `Atenção, crises com data oficial nos anos da tabela: ${partes.join('; ')}. Crises mexem com quase todos os números; o aviso não muda as contas.`;
}

// A caixa "Não contar o 1º ano de cada mandato" fica no mesmo bloco da tabela
// e tira esse ano de todos os governos ao mesmo tempo.
function tabelaPorGoverno(ctx, tabela, linhas, colunas) {
  const excluir = tabela.closest('details')?.querySelector('input[id$="-excluir-primeiro"]');
  const desenhar = () => {
    const resumo = c.resumoPorGoverno(linhas, ctx.mandatos, colunas.map((x) => x.chave), { excluirPrimeiroAno: Boolean(excluir?.checked) })
      .filter((r) => r.anos.length);
    preencherTabela(tabela, ['Mandato', ...colunas.map((x) => x.titulo)],
      resumo.map((r) => [
        { texto: r.rotulo, detalhe: `${r.partido} · ${descreverAnos(r)}` },
        ...colunas.map((x) => (r.anosComDado[x.chave] ? x.formato(r.medias[x.chave], r) : 'sem dado')),
      ]));
    avisarCrises(tabela, resumo);
  };
  excluir?.addEventListener('change', desenhar);
  desenhar();
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
    definirItens('ministerios-resumo', [
      { rotulo: null, texto: `${periodoDoAno(d, ano)}, os ministérios e demais órgãos do governo federal gastaram ${f.reaisPorExtenso(total)}, sem contar a dívida pública (em dinheiro de hoje).` },
      // Quem mais gastou está nas barras logo abaixo. Os valores da dívida
      // ficam na planilha: aqui, um terceiro número de juros (o pago em
      // dinheiro pelo Tesouro) confundiria com os das outras seções.
      { rotulo: null, texto: 'Os pagamentos da dívida pública (juros e troca de dívida que venceu), feitos pelo Ministério da Fazenda, ficam fora da lista. O peso dos juros nas contas do governo aparece em "As contas fecham?".' },
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
    // A dívida pública (fora da lista do site) vai junto, em linhas próprias.
    linhas: d.anos.flatMap((a) => [
      ...d.orgaos.filter((o) => o.valores[String(a)]).map((o) => [a, d.ate_mes[String(a)], o.codigo, nomeDoOrgao(o, a), ...o.valores[String(a)], arred(fatorParaHoje(ctx, a), 6)]),
      [a, d.ate_mes[String(a)], 'divida-juros', 'Dívida pública: juros', d.divida[String(a)]?.juros ?? null, 0, arred(fatorParaHoje(ctx, a), 6)],
      [a, d.ate_mes[String(a)], 'divida-amortizacao', 'Dívida pública: pagamento e troca de dívida que venceu', d.divida[String(a)]?.amortizacao ?? null, 0, arred(fatorParaHoje(ctx, a), 6)],
    ]),
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
      ? [{ rotulo: null, texto: `${periodoDoAno(d, ano)}, ${ne.length === 1 ? '1 pessoa viajou' : `${ne.length} pessoas viajaram`} ocupando cargo de natureza especial (ministros de Estado e cargos do mesmo nível), com gasto total de ${f.reaisPorExtenso(totalNe)}. Abaixo, quem mais gastou. O valor depende muito do destino: viagens para fora do país e para estados distantes custam mais, e alguns cargos viajam mais por função.` }]
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
    el('span', 'barra-valor', `${f.parteDoTotal(pct)} · ${f.reaisCompacto(g.valor)}`, topo);
    const trilho = el('div', 'barra-trilho', null, li);
    trilho.setAttribute('aria-hidden', 'true');
    el('div', 'barra', null, trilho).style.width = `${Math.max(1, total > 0 ? (g.valor / total) * 100 : 0)}%`;
  }
}

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
  // Quem fica de fora por ter poucos colegas no estado, dito com número e
  // estado, para o total bater com o do resumo.
  const fora = new Map();
  for (const p of base) {
    if (p.uf && !(medias.get(p.uf)?.media > 0 && medias.get(p.uf).n >= MINIMO_POR_ESTADO)) fora.set(p.uf, (fora.get(p.uf) ?? 0) + 1);
  }
  const nForaTotal = [...fora.values()].reduce((a, n) => a + n, 0);
  const textoFora = nForaTotal
    ? ` Ficam fora ${listaDeAnos([...fora].map(([sigla, n]) => `${n} ${t.doEstado(sigla, nomeUf(sigla))}`))}: com menos de ${MINIMO_POR_ESTADO} ${nomes.plural} no estado o ano todo, a média do estado não serve de régua.`
    : '';
  definirItens('cota-ranking-nota', [
    { rotulo: null, texto: `O ranking reúne, no Brasil todo, os ${comparaveis.length} ${nomes.plural} que ${fr.ficaram}. Cada um é comparado com a média dos colegas do mesmo estado, que têm o mesmo limite de gasto. Por isso a ordem não segue só o valor em reais.${textoFora}` },
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

// ---------------------------------------------------------------------------
// Contas das prefeituras: de onde vem a receita de cada uma das 5.570
// cidades (impostos da própria cidade e repasses), comparada com cidades do
// mesmo tamanho e do mesmo estado. Os arquivos são carregados só quando a
// pessoa usa a busca: a lista de nomes primeiro, depois o estado escolhido.
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

const SELO_PREFEITURA = {
  ok: (ano) => `Contas de ${ano} entregues ao Tesouro e conferidas: as partes somam o total do relatório.`,
  nao_fecha: (ano) => `A prefeitura entregou as contas de ${ano}, mas a soma das partes não bate com o total do relatório. Os números aparecem como foram entregues.`,
  sem_relatorio: (ano, data) => `A prefeitura não entregou ao Tesouro o relatório do ano completo de ${ano} (conferido em ${data}). Sem dado: o site não estima.`,
  formato: (ano) => `A prefeitura entregou o relatório de ${ano}, mas ele veio sem as linhas que o site usa para conferir a conta. Sem dado, para não mostrar número errado.`,
  erro: (ano) => `Não foi possível buscar as contas de ${ano} desta prefeitura na última atualização. Sem dado.`,
  df: () => 'Brasília não tem prefeitura. Os impostos que nas outras cidades são da prefeitura, como IPTU e ISS, são cobrados pelo governo do Distrito Federal e aparecem em "Como estão as contas do seu estado?".',
};

function montarMunicipios(ctx) {
  const entrada = $('#mun-busca');
  const listaSug = $('#mun-sugestoes');
  const selAno = $('#mun-ano');
  if (!entrada || !listaSug || !selAno) return;
  const estado = { indice: null, carregando: null, porUf: new Map(), cidade: null, sugestoes: [], ativa: -1 };

  const carregarIndice = () => {
    if (!estado.carregando) {
      estado.carregando = carregarIndiceMunicipios().then((d) => {
        estado.indice = d;
        estado.nomes = d.cidades.map((c) => semAcento(`${c[1]} ${c[2]}`));
        selAno.replaceChildren();
        [...d.anos].reverse().forEach((ano) => { el('option', null, String(ano), selAno).value = String(ano); });
        definir('mun-atualizado', f.dataCurta(d.atualizado));
        return d;
      }).catch((erro) => {
        console.error(erro);
        $('#mun-vazio').textContent = 'Não foi possível carregar a lista de cidades agora. Tente de novo mais tarde.';
        estado.carregando = null;
        throw erro;
      });
    }
    return estado.carregando;
  };

  const fecharSugestoes = () => {
    listaSug.hidden = true;
    entrada.setAttribute('aria-expanded', 'false');
    entrada.removeAttribute('aria-activedescendant');
    estado.ativa = -1;
  };

  const marcarAtiva = (i) => {
    estado.ativa = i;
    [...listaSug.children].forEach((li, k) => li.setAttribute('aria-selected', k === i ? 'true' : 'false'));
    if (i >= 0) {
      entrada.setAttribute('aria-activedescendant', `mun-op-${i}`);
      listaSug.children[i]?.scrollIntoView({ block: 'nearest' });
    } else entrada.removeAttribute('aria-activedescendant');
  };

  const sugerir = () => {
    const q = semAcento(entrada.value);
    if (!estado.indice || q.length < 2) { fecharSugestoes(); return; }
    // Primeiro os nomes que começam com o que foi digitado; depois os que contêm.
    const comeca = [];
    const contem = [];
    estado.nomes.forEach((n, i) => {
      if (n.startsWith(q)) comeca.push(i);
      else if (n.includes(` ${q}`) || (q.length >= 4 && n.includes(q))) contem.push(i);
    });
    const achados = [...comeca, ...contem].slice(0, 8);
    estado.sugestoes = achados.map((i) => estado.indice.cidades[i]);
    listaSug.replaceChildren();
    if (!achados.length) {
      const li = el('li', 'sugestao-nada', 'Nenhuma cidade com esse nome', listaSug);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-disabled', 'true');
    }
    estado.sugestoes.forEach((c, k) => {
      const li = el('li', null, c[1], listaSug);
      li.id = `mun-op-${k}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      el('small', null, ` ${c[2]}`, li);
      li.addEventListener('mousedown', (ev) => { ev.preventDefault(); escolher(c); });
    });
    listaSug.hidden = false;
    entrada.setAttribute('aria-expanded', 'true');
    marcarAtiva(-1);
  };

  const escolher = async (c) => {
    fecharSugestoes();
    entrada.value = `${c[1]} (${c[2]})`;
    estado.cidade = { codigo: c[0], nome: c[1], uf: c[2] };
    try {
      if (!estado.porUf.has(c[2])) estado.porUf.set(c[2], await carregarMunicipiosUf(c[2], estado.indice.campos.length));
    } catch (erro) {
      console.error(erro);
      $('#mun-vazio').textContent = `Não foi possível carregar as cidades de ${c[2]} agora. Tente de novo mais tarde.`;
      $('#mun-vazio').hidden = false;
      $('#mun-detalhe').hidden = true;
      return;
    }
    $('#mun-baixar').hidden = false;
    desenhar();
  };

  entrada.addEventListener('focus', () => { carregarIndice().catch(() => {}); });
  entrada.addEventListener('input', () => { carregarIndice().then(sugerir).catch(() => {}); });
  entrada.addEventListener('keydown', (ev) => {
    const n = estado.sugestoes.length;
    if (ev.key === 'ArrowDown' && n) { ev.preventDefault(); if (listaSug.hidden) sugerir(); marcarAtiva((estado.ativa + 1) % n); }
    else if (ev.key === 'ArrowUp' && n) { ev.preventDefault(); marcarAtiva((estado.ativa - 1 + n) % n); }
    else if (ev.key === 'Enter' && !listaSug.hidden && n) { ev.preventDefault(); escolher(estado.sugestoes[Math.max(0, estado.ativa)]); }
    else if (ev.key === 'Escape') fecharSugestoes();
  });
  entrada.addEventListener('blur', () => setTimeout(fecharSugestoes, 100));
  selAno.addEventListener('change', () => { if (estado.cidade) desenhar(); });

  function desenhar() {
    const { codigo, nome, uf } = estado.cidade;
    const d = estado.porUf.get(uf);
    const m = d?.municipios.find((x) => x.c === codigo);
    const ano = Number(selAno.value);
    const r = m?.a[String(ano)];
    $('#mun-vazio').hidden = true;
    $('#mun-detalhe').hidden = false;
    const selo = $('#mun-selo');
    // Sem registro do ano ou situação desconhecida: "sem dado", nunca "não entregou".
    const situacao = Object.hasOwn(SELO_PREFEITURA, r?.s) ? r.s : 'erro';
    selo.textContent = SELO_PREFEITURA[situacao](ano, f.dataCurta(d?.atualizado));
    selo.classList.toggle('aviso', situacao !== 'ok');
    const caixaContas = $('#mun-contas');
    if (!r?.v) {
      caixaContas.hidden = true;
      campo('mun-resumo').forEach((e) => e.replaceChildren());
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
    for (const x of itens) {
      const li = el('li', null, null, lista);
      const topo = el('div', 'barra-topo', null, li);
      const nomeEl = el('span', 'barra-nome', x.nome, topo);
      el('span', 'barra-explica', x.explica, nomeEl);
      el('span', 'barra-valor', `${f.parteDoTotal(parte(x.valor))} · ${f.reaisCompacto(hoje(x.valor))}`, topo);
      const trilho = el('div', 'barra-trilho', null, li);
      trilho.setAttribute('aria-hidden', 'true');
      el('div', 'barra', null, trilho).style.width = `${Math.max(1, parte(x.valor))}%`;
    }

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

  registrarDownload('municipios', () => {
    const uf = estado.cidade?.uf;
    const d = uf ? estado.porUf.get(uf) : null;
    const campos = estado.indice?.campos ?? [];
    const anos = estado.indice?.anos ?? [];
    return {
      nome: `contas-das-prefeituras-${(uf ?? 'sem-estado').toLowerCase()}.csv`,
      cabecalhos: ['ano', 'codigo_ibge', 'cidade', 'uf', 'situacao', 'populacao', ...campos.map((k) => `${k} (R$ da época)`), 'fator para dinheiro de hoje (IPCA)'],
      linhas: d ? anos.flatMap((ano) => d.municipios.map((m) => {
        const r = m.a[String(ano)];
        return [ano, m.c, m.n, uf, r?.s ?? 'sem_dado', r?.p ?? m.p, ...campos.map((_, i) => r?.v?.[i] ?? ''), arred(fatorParaHoje(ctx, ano) ?? 1, 6)];
      })) : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Dinheiro no dia a dia: salário líquido (tabelas oficiais de INSS e IR do
// ano), o que a inflação faz com o dinheiro parado (IPCA e poupança) e quanto
// custa uma dívida (taxas médias do Banco Central).
function barrasDeValores(lista, itens) {
  lista.replaceChildren();
  const maior = Math.max(...itens.map((x) => x.valor));
  for (const x of itens) {
    const li = el('li', null, null, lista);
    const topo = el('div', 'barra-topo', null, li);
    const nome = el('span', 'barra-nome', x.nome, topo);
    if (x.explica) el('span', 'barra-explica', x.explica, nome);
    el('span', 'barra-valor', f.moeda(x.valor, 2), topo);
    const trilho = el('div', 'barra-trilho', null, li);
    trilho.setAttribute('aria-hidden', 'true');
    el('div', 'barra', null, trilho).style.width = `${Math.max(1, (x.valor / maior) * 100)}%`;
  }
}

async function montarDinheiro(ctx) {
  const secao = $('#dinheiro');
  const { meses, s } = ctx;
  let folha;
  try {
    folha = await carregarFolha();
  } catch (erro) {
    console.error(erro);
    folha = null;
  }

  // 1. Salário líquido ------------------------------------------------------
  const entrada = $('#din-salario');
  const selDep = $('#din-dependentes');
  if (folha) {
    definir('din-conferido', f.dataCurta(folha.conferido_em));
    const sm = c.ultimoValor(meses, s.salario_minimo);
    entrada.value = sm ? (2 * sm.valor).toFixed(2) : '3000.00';
    const desenharSalario = () => {
      const bruto = Number(entrada.value);
      if (!Number.isFinite(bruto) || bruto <= 0 || bruto > 1e7) {
        campo('din-salario-resumo').forEach((e) => e.replaceChildren(el('p', 'resposta', 'Digite um salário bruto maior que zero.')));
        return;
      }
      const dep = Number(selDep.value);
      const inss = c.inssEmpregado(bruto, folha.inss);
      const ir = c.irMensal(bruto, inss, dep, folha.ir);
      const liquido = bruto - inss - ir.imposto;
      const porCem = (x) => f.moeda((x / bruto) * 100, 0);
      const r = folha.ir.reducao;
      const frases = [
        `De um salário de ${f.moeda(bruto, 2)}, ${f.moeda(inss, 2)} vão para o INSS e ${f.moeda(ir.imposto, 2)} para o Imposto de Renda; você recebe ${f.moeda(liquido, 2)}.`,
        `De cada R$ 100 do salário, ${porCem(inss)} vão para o INSS e ${porCem(ir.imposto)} para o Imposto de Renda.`,
      ];
      if (r && bruto <= r.ate && ir.reducao > 0) frases.push(`Até ${f.moeda(r.ate, 0)} por mês não há Imposto de Renda desde ${folha.ano}: sem a redução, seriam ${f.moeda(ir.semReducao, 2)}.`);
      else if (ir.reducao > 0) frases.push(`A redução de ${folha.ano} tirou ${f.moeda(ir.reducao, 2)} do imposto.`);
      definirTopicos('din-salario-resumo', frases.join(' '));
      definir('din-bruto', f.moeda(bruto, 2));
      definir('din-inss', `− ${f.moeda(inss, 2)}`);
      definir('din-inss-parte', f.porcentagem((inss / bruto) * 100, 1));
      definir('din-ir', `− ${f.moeda(ir.imposto, 2)}`);
      definir('din-ir-parte', f.porcentagem((ir.imposto / bruto) * 100, 1));
      definir('din-liquido', f.moeda(liquido, 2));
      definir('din-liquido-parte', f.porcentagem((liquido / bruto) * 100, 1));
      const antiga = folha.ano < new Date().getFullYear();
      definir('din-salario-nota', antiga
        ? `Atenção: estas são as tabelas de ${folha.ano}; as de ${new Date().getFullYear()} ainda não foram atualizadas no site.`
        : `Tabelas de ${folha.ano}. O INSS paga aposentadoria, auxílio-doença e outros benefícios. Parte do Imposto de Renda vai para estados e prefeituras, pelo FPE e pelo FPM.${ir.simplificado ? ' Neste salário, o desconto simplificado dá menos imposto que deduzir o INSS e os dependentes, e é ele que a empresa usa.' : ''}`);
    };
    entrada.addEventListener('input', desenharSalario);
    selDep.addEventListener('change', desenharSalario);
    desenharSalario();
  } else {
    definir('din-salario-nota', 'Não foi possível carregar as tabelas de INSS e Imposto de Renda agora.');
  }

  // 2. Inflação e poupança --------------------------------------------------
  const iFim = c.ultimoIndice(s.ipca_var);
  const selDesde = $('#din-desde');
  const valorEl = $('#din-valor');
  const anoFim = c.anoDe(meses[iFim]);
  for (let ano = anoFim - 1; ano >= 1995; ano -= 1) {
    const i = meses.indexOf(`${ano}-01`);
    if (i >= 0) el('option', null, `janeiro de ${ano}`, selDesde).value = String(i);
  }
  selDesde.value = String(meses.indexOf(`${anoFim - 10}-01`));
  const desenharInflacao = () => {
    const valor = Number(valorEl.value);
    const i0 = Number(selDesde.value);
    if (!Number.isFinite(valor) || valor <= 0 || !(i0 >= 0)) return;
    const inflacao = c.acumularVariacoes(s.ipca_var, i0, iFim);
    const poupanca = s.poupanca_rend ? c.acumularVariacoes(s.poupanca_rend, i0, iFim) : null;
    const desde = f.mesLongo(meses[i0]);
    const ate = f.mesLongo(meses[iFim]);
    const frases = [
      `Para comprar hoje o que ${f.moeda(valor, 2)} compravam em ${desde}, são precisos ${f.moeda(valor * inflacao, 2)} (inflação até ${ate}).`,
      `Parado, sem render, o dinheiro perdeu ${f.porcentagem((1 - 1 / inflacao) * 100, 0)} do que comprava.`,
    ];
    if (poupanca) {
      const dif = valor * poupanca - valor * inflacao;
      frases.push(`Na poupança, teria virado ${f.moeda(valor * poupanca, 2)}: ${f.moeda(Math.abs(dif), 2)} ${dif >= 0 ? 'a mais' : 'a menos'} que o necessário para acompanhar a inflação.`);
    } else {
      frases.push('A comparação com a poupança começa em junho de 2012: antes disso, a regra de rendimento era outra.');
    }
    definirTopicos('din-inflacao-resumo', frases.join(' '));
    const itens = [
      { nome: 'Parado, sem render', explica: 'o mesmo valor, comprando menos', valor },
      { nome: 'Para comprar o mesmo hoje', explica: 'corrigido pela inflação (IPCA)', valor: valor * inflacao },
    ];
    if (poupanca) itens.push({ nome: 'Na poupança', explica: 'com o rendimento oficial de cada mês', valor: valor * poupanca });
    barrasDeValores($('#din-inflacao-barras'), itens);
  };
  valorEl.addEventListener('input', desenharInflacao);
  selDesde.addEventListener('change', desenharInflacao);
  desenharInflacao();

  // 3. Juros ------------------------------------------------------------------
  const rot = c.ultimoValor(meses, s.juros_rotativo);
  const che = c.ultimoValor(meses, s.juros_cheque_especial);
  const pes = c.ultimoValor(meses, s.juros_credito_pessoal);
  const pou = c.ultimoValor(meses, s.poupanca_rend);
  if (rot && che && pes && pou) {
    const ano = (x) => f.porcentagem(c.taxaAoAno(x), 0);
    definirTopicos('din-juros-resumo',
      `Em ${f.mesLongo(rot.mes)}, os bancos cobraram em média ${f.porcentagem(rot.valor, 2)} ao mês no rotativo do cartão de crédito (${ano(rot.valor)} ao ano), ${f.porcentagem(che.valor, 2)} no cheque especial (${ano(che.valor)} ao ano) e ${f.porcentagem(pes.valor, 2)} no crédito pessoal (${ano(pes.valor)} ao ano). `
      + `A poupança rendeu ${f.porcentagem(pou.valor, 2)} em ${f.mesLongo(pou.mes)} (${ano(pou.valor)} ao ano).`);
    const base = 500;
    const n = 6;
    const cartao = c.comJuros(base, rot.valor, n);
    const limite = base * 2;
    barrasDeValores($('#din-juros-barras'), [
      { nome: 'Guardado na poupança', explica: 'o que o banco te paga', valor: c.comJuros(base, pou.valor, n) },
      { nome: 'Crédito pessoal', explica: `${f.porcentagem(pes.valor, 2)} ao mês`, valor: c.comJuros(base, pes.valor, n) },
      { nome: 'Cheque especial', explica: `${f.porcentagem(che.valor, 2)} ao mês`, valor: c.comJuros(base, che.valor, n) },
      { nome: 'Cartão de crédito (rotativo ou parcelamento da fatura)', explica: cartao > limite ? `a lei limita os juros ao valor da dívida; sem o limite, seriam ${f.moeda(cartao, 2)}` : `${f.porcentagem(rot.valor, 2)} ao mês`, valor: Math.min(cartao, limite) },
    ]);
    definir('din-juros-nota', `Quanto vira uma dívida de ${f.moeda(base, 0)} depois de ${n} meses sem pagar nada, com a taxa média de ${f.mesLongo(rot.mes)}, e quanto rende o mesmo valor na poupança. Cada banco cobra uma taxa; a sua pode ser maior ou menor.`);
  } else {
    definir('din-juros-nota', 'As taxas de juros não estão disponíveis agora.');
  }

  registrarDownload('dinheiro', () => ({
    nome: 'juros-e-poupanca.csv',
    cabecalhos: ['mes', 'rotativo do cartao (% ao mes)', 'cheque especial (% ao mes)', 'credito pessoal (% ao mes)', 'poupanca (% no mes, deposito no dia 1)', 'IPCA (% no mes)'],
    linhas: meses.map((m, i) => [m, s.juros_rotativo?.[i] ?? '', s.juros_cheque_especial?.[i] ?? '', s.juros_credito_pessoal?.[i] ?? '', s.poupanca_rend?.[i] ?? '', s.ipca_var?.[i] ?? ''])
      .filter((l) => l.slice(1, 5).some((v) => v !== '')),
  }));
  secao.hidden = false;
}

// ---------------------------------------------------------------------------
// O que chegou de novo: o último número de cada indicador principal, do que
// chegou mais recentemente para o mais antigo, com a data da coleta; e as
// próximas divulgações do IBGE. Marca "novo" o que chegou nos últimos 7 dias
// (a carga inicial do site não conta como novidade).
const NOVIDADES = [
  { id: 'ipca_var', nome: 'Inflação do mês (IPCA)', valor: (v) => f.porcentagem(v, 2), secao: '#hoje' },
  { id: 'inpc_var', nome: 'Inflação das famílias de menor renda (INPC)', valor: (v) => f.porcentagem(v, 2), secao: '#salario' },
  { id: 'desocupacao', nome: 'Desemprego', valor: (v) => f.porcentagem(v, 1), secao: '#hoje', trimestre: true },
  { id: 'renda_trabalho', nome: 'Renda média de quem trabalha', valor: (v) => f.moeda(v, 0), secao: '#hoje', trimestre: true },
  { id: 'arrecadacao_federal', nome: 'Arrecadação federal do mês', valor: null, secao: '#arrecadacao' },
  { id: 'divida_bruta_pib', nome: 'Dívida do governo', valor: (v) => `${f.porcentagem(v, 1)} do PIB`, secao: '#contas' },
  { id: 'dolar_ptax', nome: 'Dólar, média do mês', valor: (v) => f.moeda(v, 2), secao: '#dolar' },
  { id: 'comb_gasolina', nome: 'Gasolina, preço médio do litro', valor: (v) => f.moeda(v, 2), secao: '#combustiveis' },
  { id: 'comb_glp', nome: 'Botijão de gás (13 kg)', valor: (v) => f.moeda(v, 2), secao: '#combustiveis' },
  { id: 'smn_dieese', nome: 'Salário necessário (DIEESE)', valor: (v) => f.moeda(v, 0), secao: '#orcamento' },
  { id: 'juros_rotativo', nome: 'Juros do rotativo do cartão', valor: (v) => `${f.porcentagem(v, 2)} ao mês`, secao: '#dinheiro' },
  { id: 'salario_minimo', nome: 'Salário mínimo em vigor', valor: (v) => f.moeda(v, 0), secao: '#salario', vigente: true },
];

async function montarNovidades(ctx) {
  const { meses, s, d } = ctx;
  const atual = d.atualizacoes;
  const lista = $('#novidades-lista');
  const agora = Date.now();
  const itens = NOVIDADES.map((n, ordem) => ({ ...n, ordem, a: atual[n.id] })).filter((n) => n.a)
    // O que veio da carga inicial do site não tem data de chegada que
    // signifique algo para o leitor: vai depois, na ordem da lista.
    .sort((x, y) => (x.a.primeira_carga - y.a.primeira_carga)
      || (x.a.primeira_carga ? 0 : y.a.coletado_em.localeCompare(x.a.coletado_em)) || x.ordem - y.ordem);
  lista.replaceChildren();
  for (const n of itens) {
    const i = meses.indexOf(n.a.periodo);
    let texto;
    if (n.id === 'arrecadacao_federal') {
      texto = i >= 0 && ctx.total[i] != null ? f.reaisPorExtenso(ctx.total[i] * 1e6) : null;
    } else if (n.vigente) {
      const u = c.ultimoValor(meses, s[n.id]);
      texto = u ? n.valor(u.valor) : null;
      // Primeiro mês com o valor atual, contado para trás na série.
      let k = meses.indexOf(u?.mes);
      while (k > 0 && s[n.id][k - 1] === u.valor) k -= 1;
      n.desde = k >= 0 ? meses[k] : null;
    } else {
      texto = i >= 0 && s[n.id]?.[i] != null ? n.valor(s[n.id][i]) : null;
    }
    if (!texto) continue;
    const quando = new Date(n.a.coletado_em);
    const novo = !n.a.primeira_carga && agora - quando.getTime() < 7 * 864e5;
    const li = el('li', novo ? 'novo' : null, null, lista);
    const a = el('a', null, null, li);
    a.href = n.secao;
    const topo = el('span', 'novidade-topo', null, a);
    if (novo) el('span', 'novidade-marca', 'novo', topo);
    el('span', 'novidade-nome', n.nome, topo);
    el('span', 'novidade-valor', texto, topo);
    const periodo = n.vigente ? (n.desde ? `em vigor desde ${f.mesLongo(n.desde)}` : 'em vigor') : n.trimestre ? `trimestre até ${f.mesLongo(n.a.periodo)}` : f.mesLongo(n.a.periodo);
    const chegada = n.a.primeira_carga ? '' : ` · chegou ao site em ${f.dataDeTimestamp(n.a.coletado_em)}`;
    el('span', 'novidade-quando', `${periodo}${chegada}`, a);
  }

  try {
    const agenda = await carregarAgenda();
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const proximas = agenda.itens.filter((x) => x.data >= hoje).slice(0, 6);
    if (proximas.length) {
      const al = $('#agenda-lista');
      al.replaceChildren();
      for (const x of proximas) {
        const a = el('a', null, null, el('li', null, null, al));
        a.href = x.secao;
        const topo = el('span', 'novidade-topo', null, a);
        el('span', 'novidade-data', f.dataCurta(x.data), topo);
        el('span', 'novidade-nome', x.nome, topo);
      }
      $('#agenda-caixa').hidden = false;
    }
  } catch (erro) {
    console.error(erro);
  }
  $('#novidades').hidden = !lista.children.length && $('#agenda-caixa').hidden;
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
      // Com o que foi gasto: nas barras logo abaixo, sem repetir no resumo.
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

  const desenharGovernos = () => {
  const resumo = c.resumoPorGoverno(anual, mandatos, ['variacaoReal', 'emDolar', 'frenteNecessario'], { excluirPrimeiroAno: $('#salario-excluir-primeiro').checked });
  preencherTabela($('#tabela-salario-governos'),
    ['Mandato', 'Aumento por ano, sem a inflação', 'Em dólar', 'Parte do necessário'],
    resumo.map((r) => [
      { texto: r.rotulo, detalhe: `${r.partido} · ${descreverAnos(r)}` },
      f.porcentagem(r.medias.variacaoReal, 1, true),
      f.dolar(r.medias.emDolar, 0),
      f.porcentagem(r.medias.frenteNecessario, 1),
    ]),
    'Médias dos anos de cada mandato.');
  avisarCrises($('#tabela-salario-governos'), resumo);
  };
  $('#salario-excluir-primeiro').addEventListener('change', desenharGovernos);
  desenharGovernos();

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

// "nota" é a linha curta embaixo do item; "fonte", a explicação completa,
// que vai para a planilha.
function gastoDaPof(ctx, familia, chave, serieIpca, nomeDaInflacao) {
  const v = valorDaPof(ctx, familia, chave, serieIpca);
  return v && {
    valor: v.valor,
    nota: null,
    pof: true,
    fonte: `Gasto médio das famílias da mesma faixa de renda${familia.local ? ` no estado (${familia.local.uf})` : ''} (POF 2017-2018, IBGE), corrigido pela inflação ${nomeDaInflacao} até ${f.mesCurto(v.ate)}`,
  };
}

// grupo: a cor na barra da renda (luz, água e gás são as contas da casa).
// Parte da comida no gasto das famílias de baixa renda na pesquisa de
// orçamentos do DIEESE (São Paulo, 1994/95); é o divisor do salário
// necessário (cesta × 3 ÷ 0,3571).
const PARTE_COMIDA_DIEESE = 35.71;

const ITENS_ORCAMENTO = [
  {
    id: 'comida', nome: 'Comida', grupo: 'comida',
    padrao: ({ meses, s }, familia) => {
      const local = familia.local?.series?.cesta_total;
      const u = c.ultimoValor(meses, local ?? s.cesta_total);
      if (!u) return null;
      const cestas = familia.unidades;
      const textoCestas = cestas === 1 ? '1 cesta básica' : `${f.numero(cestas, cestas % 1 ? 1 : 0)} cestas básicas`;
      const onde = local ? `em ${familia.local.nome}` : 'média de capitais';
      return {
        valor: u.valor * cestas,
        nota: `${textoCestas} do DIEESE${familia.criancas ? ' (criança conta meia)' : ''}, ${f.mesCurto(u.mes)}`,
        fonte: `${textoCestas} do DIEESE, ${onde}, em ${f.mesCurto(u.mes)}${familia.criancas ? ' (cada criança conta como meia cesta, como no cálculo do DIEESE)' : ''}`,
      };
    },
  },
  {
    id: 'aluguel', nome: 'Aluguel', grupo: 'aluguel',
    opcoes: [
      { id: 'pof', nome: 'Média das famílias' },
      { id: 'anuncio', nome: `Anúncio de ${AREA_EXEMPLO_M2} m²` },
    ],
    padrao: (ctx, familia, opcao) => {
      const { meses, s } = ctx;
      if (opcao !== 'anuncio') {
        const v = valorDaPof(ctx, familia, 'aluguel', 'ipca_aluguel_var');
        return v && {
          valor: v.valor,
          nota: null,
          pof: true,
          fonte: `Valor médio de aluguel das moradias das famílias da mesma faixa de renda${familia.local ? ` no estado (${familia.local.uf})` : ''} (POF 2017-2018, IBGE; para quem tem casa própria, o IBGE usa o aluguel estimado), corrigido pela inflação do aluguel até ${f.mesCurto(v.ate)}`,
        };
      }
      const local = familia.local?.series?.aluguel_m2;
      const u = c.ultimoValor(meses, local ?? s.aluguel_m2);
      const onde = local ? `em ${familia.local.nome}` : 'nas cidades do Índice FipeZAP';
      return u && {
        valor: u.valor * AREA_EXEMPLO_M2,
        nota: `${AREA_EXEMPLO_M2} m² a ${f.moeda(u.valor, 2)} o m², preço pedido em anúncios ${local ? onde : 'em cidades grandes'} (FipeZAP, ${f.mesCurto(u.mes)}); em bairros mais simples costuma ser menor`,
        fonte: `Apartamento de ${AREA_EXEMPLO_M2} m² a ${f.moeda(u.valor, 2)} por m², preço médio pedido em anúncios ${onde} em ${f.mesCurto(u.mes)}`,
      };
    },
  },
  { id: 'luz', nome: 'Luz', grupo: 'contas', padrao: (ctx, familia) => gastoDaPof(ctx, familia, 'luz', 'ipca_luz_var', 'da energia elétrica') },
  { id: 'agua', nome: 'Água', grupo: 'contas', padrao: (ctx, familia) => gastoDaPof(ctx, familia, 'agua', 'ipca_agua_var', 'da conta de água e esgoto') },
  {
    id: 'gas', nome: 'Gás de cozinha', grupo: 'contas',
    padrao: (ctx, familia) => {
      const g = gastoDaPof(ctx, familia, 'gas', 'ipca_gas_var', 'do gás de botijão');
      const botijao = c.ultimoValor(ctx.meses, familia.local?.series?.comb_glp ?? ctx.s.comb_glp);
      if (g && botijao) g.nota = `cerca de ${f.numero(g.valor / botijao.valor, 1)} botijão por mês`;
      return g;
    },
  },
];

// Partes da barra da renda, na ordem em que aparecem.
const GRUPOS_ORCAMENTO = [
  { id: 'comida', nome: 'Comida' },
  { id: 'aluguel', nome: 'Aluguel' },
  { id: 'contas', nome: 'Luz, água e gás' },
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
  const botaoRestaurar = $('#orc-restaurar');
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
  lista.replaceChildren();
  const linhas = new Map();
  for (const item of ITENS_ORCAMENTO) {
    const li = el('li', `orc-item orc-${item.grupo}`, null, lista);
    el('span', 'orc-cor', null, li).setAttribute('aria-hidden', 'true');
    const texto = el('div', 'orc-texto', null, li);
    const rotulo = el('label', 'orc-nome', item.nome, texto);
    rotulo.htmlFor = `orc-${item.id}`;
    const nota = el('span', 'orc-nota', null, texto);
    const campoValor = el('div', 'orc-campo', null, li);
    el('span', null, 'R$', campoValor);
    const input = el('input', null, null, campoValor);
    input.id = `orc-${item.id}`;
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = '1000000';
    input.step = '1';
    const parte = el('span', 'orc-parte', null, li);
    let radios = null;
    if (item.opcoes) {
      const grupo = el('div', 'segmentos orc-referencia', null, li);
      grupo.setAttribute('role', 'radiogroup');
      grupo.setAttribute('aria-label', `Referência do ${item.nome.toLowerCase()}`);
      radios = item.opcoes.map((op, k) => {
        const rotuloOp = el('label', null, null, grupo);
        const radio = el('input', null, null, rotuloOp);
        radio.type = 'radio';
        radio.name = `orc-${item.id}-ref`;
        radio.value = op.id;
        radio.checked = k === 0;
        const textoOp = el('span', null, op.nome, rotuloOp);
        radio.addEventListener('change', () => {
          opcoesEscolhidas.set(item.id, radio.value);
          digitados.delete(item.id);
          calcular(false);
        });
        return { radio, texto: textoOp, op };
      });
    }
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v) || v < 0) digitados.delete(item.id);
      else digitados.set(item.id, Math.min(v, 1000000));
      calcular(false);
    });
    linhas.set(item.id, { input, nota, parte, radios });
  }

  const renda = () => {
    if (selRenda.value !== 'outro') return sm.valor * Number(selRenda.value);
    const v = Number(campoOutra.value);
    return Number.isFinite(v) && v > 0 ? Math.min(v, 10000000) : 0;
  };

  // Barra da renda: comida, aluguel e contas da casa, cada um com sua cor, e
  // o que sobra no fim. Se o básico passa da renda, a escala é o básico e
  // uma linha marca onde a renda acaba.
  const desenharBarra = (r, res) => {
    const barra = $('#orc-barra');
    const legenda = $('#orc-legenda');
    barra.replaceChildren();
    legenda.replaceChildren();
    if (!(r > 0) || !(res.total > 0)) { barra.hidden = true; legenda.hidden = true; return; }
    barra.hidden = false;
    legenda.hidden = false;
    const escala = Math.max(r, res.total);
    const partes = GRUPOS_ORCAMENTO.map((g) => ({
      ...g, valor: res.itens.filter((d) => ITENS_ORCAMENTO.find((it) => it.id === d.id)?.grupo === g.id).reduce((a, d) => a + (d.valor ?? 0), 0),
    })).filter((g) => g.valor > 0);
    if (res.sobra > 0) partes.push({ id: 'sobra', nome: 'Sobra', valor: res.sobra });
    for (const g of partes) el('div', `orc-seg orc-seg-${g.id}`, null, barra).style.flexGrow = String(g.valor / escala);
    if (res.sobra < 0) el('div', 'orc-marca', null, barra).style.left = `${(r / escala) * 100}%`;
    const pct = (v) => f.porcentagem((v / r) * 100, 0);
    // Quando o básico passa da renda, "151% da renda" confunde: vai em reais.
    const rotulo = (v) => (res.sobra < 0 ? f.moeda(v, 0) : pct(v));
    for (const g of partes) {
      const li = el('li', `orc-leg orc-leg-${g.id}`, null, legenda);
      el('span', 'orc-leg-cor', null, li).setAttribute('aria-hidden', 'true');
      li.append(`${g.nome} ${rotulo(g.valor)}`);
    }
    if (res.sobra < 0) {
      const li = el('li', 'orc-leg orc-leg-marca', null, legenda);
      el('span', 'orc-leg-cor', null, li).setAttribute('aria-hidden', 'true');
      li.append('onde a renda acaba');
    }
    barra.setAttribute('aria-label', `Da renda de ${f.moeda(r, 0)}: ${partes.map((g) => `${g.nome.toLowerCase()} ${rotulo(g.valor)}`).join(', ')}${res.sobra < 0 ? `; o básico passa a renda em ${f.moeda(-res.sobra, 0)}` : ''}.`);
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
    const semAnuncio = Boolean(local) && !local.series?.aluguel_m2;
    const radiosAluguel = linhas.get('aluguel').radios;
    const anuncio = radiosAluguel?.find((x) => x.op.id === 'anuncio');
    if (anuncio) {
      anuncio.radio.disabled = semAnuncio;
      anuncio.texto.textContent = semAnuncio ? 'Anúncio (sem dado aqui)' : anuncio.op.nome;
      if (semAnuncio && anuncio.radio.checked) {
        radiosAluguel[0].radio.checked = true;
        opcoesEscolhidas.set('aluguel', 'pof');
      }
    }
    const despesas = ITENS_ORCAMENTO.map((item) => {
      const p = item.padrao(ctx, familia, opcoesEscolhidas.get(item.id) ?? item.opcoes?.[0]?.id);
      const digitado = digitados.has(item.id);
      const valor = digitado ? digitados.get(item.id) : (p ? Math.round(p.valor) : null);
      return {
        id: item.id, nome: item.nome, valor, daPof: !digitado && Boolean(p?.pof),
        nota: digitado ? 'valor digitado por você' : (p ? p.nota : 'sem fonte automática: digite o valor da sua casa'),
        fonte: digitado ? 'Valor digitado por você' : (p?.fonte ?? 'Sem fonte automática'),
      };
    });
    const res = c.orcamento(r, despesas);

    for (const d of res.itens) {
      const linha = linhas.get(d.id);
      if (reescreverCampos || !digitados.has(d.id)) linha.input.value = d.valor == null ? '' : String(d.valor);
      linha.nota.textContent = d.nota ?? '';
      linha.nota.hidden = !d.nota;
      linha.parte.textContent = d.parte == null ? '' : f.porcentagem(d.parte, 0);
    }
    botaoRestaurar.hidden = !digitados.size;

    // Resposta: quem é a casa, quanto sobra ou falta e para quê.
    const pessoasTexto = `${adultos === 1 ? '1 adulto' : `${adultos} adultos`}${criancas ? ` e ${criancas === 1 ? '1 criança' : `${criancas} crianças`}` : ''}`;
    const rendaTexto = selRenda.value === 'outro'
      ? `renda de ${f.moeda(r, 0)}`
      : `renda de ${f.moeda(r, 0)} (${selRenda.selectedOptions[0].textContent.replace(/ \(.*\)$/, '')})`;
    const caixa = campo('orc-resumo')[0];
    caixa.replaceChildren();
    el('p', 'orc-quem', `${pessoasTexto} · ${rendaTexto} · ${local ? local.nome : 'média do país'}`, caixa);
    const semValor = res.itens.filter((d) => d.valor == null).map((d) => d.nome.toLowerCase());
    if (r > 0) {
      const falta = res.sobra < 0;
      el('p', `orc-grande${falta ? ' orc-falta' : ''}`, `${falta ? 'Faltam' : 'Sobram'} ${f.moeda(Math.abs(res.sobra), 0)} por mês`, caixa);
      el('p', 'orc-explica', falta
        ? 'só para comida, aluguel, luz, água e gás, sem contar transporte, saúde, roupas e escola.'
        : `depois de comida, aluguel, luz, água e gás (${f.porcentagem(res.parteTotal, 0)} da renda). É o que fica para transporte, saúde, roupas, escola e todo o resto.`, caixa);
    } else {
      el('p', 'orc-grande', 'Informe a renda da casa', caixa);
    }
    if (semValor.length) el('p', 'orc-explica', `A conta ainda não inclui ${listaDeAnos(semValor)}: digite esses valores na lista abaixo.`, caixa);
    desenharBarra(r, res);

    definir('orc-renda-total', f.moeda(r, 0));
    definir('orc-total', f.moeda(res.total, 0));
    definir('orc-total-parte', r > 0 ? f.porcentagem(res.parteTotal, 0) : '');
    definir('orc-sobra-rotulo', res.sobra >= 0 ? 'Sobra' : 'Falta');
    definir('orc-sobra', f.moeda(Math.abs(res.sobra), 0));
    definir('orc-sobra-parte', r > 0 ? f.porcentagem((Math.abs(res.sobra) / r) * 100, 0) : '');
    campo('orc-sobra').forEach((e) => e.classList.toggle('orc-falta', res.sobra < 0));
    // Fonte comum de aluguel, luz, água e gás, quando vêm da POF.
    const daPof = despesas.filter((d) => d.daPof).map((d) => d.nome.toLowerCase().replace('gás de cozinha', 'gás'));
    const notaPof = $('.orc-fonte-curta');
    notaPof.hidden = !daPof.length;
    if (daPof.length) notaPof.textContent = `${comMaiuscula(listaDeAnos(daPof))}: média das famílias com a mesma renda${local ? ` no estado (${local.uf})` : ' no país'}, pela pesquisa de orçamentos do IBGE (2017-2018), corrigida pela inflação de cada conta.`;

    // Salário necessário do DIEESE: calculado para 2 adultos e 2 crianças
    // (3 adultos equivalentes). Para outra família, o mesmo método dá o valor
    // proporcional às pessoas: necessário × unidades ÷ 3.
    const nec = c.ultimoValor(meses, s.smn_dieese);
    if (nec) {
      const smNec = c.ultimoValor(meses, s.salario_minimo.map((v, i) => (s.smn_dieese[i] == null ? null : v)));
      const necFamilia = (nec.valor * familia.unidades) / 3;
      const cobre = r > 0 ? (r / necFamilia) * 100 : null;
      const caixaNec = campo('orc-digno')[0];
      caixaNec.replaceChildren();
      el('p', null, `Para ${pessoasTexto}, ${f.moeda(necFamilia, 0)} por mês (${f.numero(necFamilia / smNec.valor, 1)} salários mínimos, ${f.mesCurto(nec.mes)}), contando também transporte, saúde, educação, roupas, higiene, lazer e previdência.${cobre == null ? '' : ` A renda escolhida cobre ${f.porcentagem(cobre, 0)} disso.`}`, caixaNec);
      $('#orc-cobre-barra').style.width = `${Math.max(1, Math.min(100, cobre ?? 0))}%`;
      // Peso da comida: a conta do DIEESE parte de que a comida é 35,71% do
      // gasto da família. Não é meta, é a referência dele; ao lado, quanto a
      // comida leva da renda escolhida.
      const comida = res.itens.find((d) => d.id === 'comida');
      const caixaComida = $('#orc-peso-comida');
      caixaComida.hidden = !(r > 0 && comida?.valor != null);
      if (!caixaComida.hidden) {
        // Compara pelo número mostrado (sem casas), para "34%" não sair como
        // "menos" ao lado de 35,71%.
        const parte = Math.round((comida.valor / r) * 100);
        const perto = Math.abs(parte - PARTE_COMIDA_DIEESE) <= 2;
        let frase;
        if (parte >= 100) frase = 'a comida sozinha já custa mais do que a renda inteira';
        else if (perto) frase = `a comida leva ${f.porcentagem(parte, 0)} da renda, quase o mesmo`;
        else if (parte > PARTE_COMIDA_DIEESE) frase = `só a comida já leva ${f.porcentagem(parte, 0)} da renda, mais do que isso`;
        else frase = `a comida leva ${f.porcentagem(parte, 0)} da renda, menos do que isso`;
        caixaComida.textContent = `A conta do DIEESE parte de que a comida é pouco mais de um terço (${f.porcentagem(PARTE_COMIDA_DIEESE, 2)}) do que uma família gasta, como era entre as famílias de renda mais baixa de São Paulo em 1994 e 1995. Com a renda escolhida, ${frase}.`;
      }
      definir('orc-dieese-familia', familia.unidades === 3
        ? `Em ${f.mesLongo(nec.mes)}, o DIEESE calculou ${f.moeda(nec.valor, 0)} para 2 adultos e 2 crianças.`
        : `Em ${f.mesLongo(nec.mes)}, o DIEESE calculou ${f.moeda(nec.valor, 0)} para 2 adultos e 2 crianças (${f.numero(nec.valor / smNec.valor, 1)} salários mínimos). Para ${pessoasTexto}, o site aplica a mesma conta ao número de pessoas, com cada criança valendo meio adulto.`);
    }

    registrarDownload('orcamento', () => ({
      nome: 'orcamento-da-familia.csv',
      cabecalhos: ['item', 'valor (R$)', 'parte da renda (%)', 'origem do valor'],
      linhas: [['renda', arred(r, 2), 100, selRenda.value === 'outro' ? 'digitado' : `${selRenda.value} salário(s) mínimo(s)`],
        ...res.itens.map((d) => [d.nome, d.valor, arred(d.parte, 1), d.fonte])],
    }));
  };

  selRenda.addEventListener('change', () => calcular(false));
  campoOutra.addEventListener('input', () => calcular(false));
  selAdultos.addEventListener('change', () => calcular(false));
  selCriancas.addEventListener('change', () => calcular(false));
  aoMudarCidade(() => calcular(false));
  botaoRestaurar.addEventListener('click', () => { digitados.clear(); calcular(true); });
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
      // Comparação de governos: quanto a dívida mudou no período, em pontos.
      formatoVariacao: (v) => `${v >= 0 ? 'subiu' : 'caiu'} ${f.numero(Math.abs(v), 1)} ${Math.abs(v) < 2 ? 'ponto' : 'pontos'}`,
      deficit: Array.isArray(s.nfsp_nominal) ? c.deflacionar(s.nfsp_nominal, ipca) : null,
    },
    // Séries do Banco Central já somadas em 12 meses, em % do PIB. Positivo é
    // déficit (o governo precisou pegar dinheiro emprestado).
    {
      id: 'deficit', grupo: 'pais', nome: 'Contas do governo, com os juros', nomeCurto: 'Contas do governo, com os juros', curto: 'contas do governo com os juros', secao: '#contas',
      explica: 'quanto faltou ou sobrou de dinheiro ao governo federal em 12 meses, contando os juros da dívida. Quando o governo gasta mais do que arrecada, falta dinheiro (é o déficit) e ele precisa pegar emprestado, o que aumenta a dívida; quando arrecada mais do que gasta, sobra (superávit). O valor está em % de tudo o que o país produz em um ano (o PIB)',
      dica: 'em 12 meses, em % do que o país produz',
      valores: s.nfsp_nominal_pib, tipo: 'doze', maiorMelhor: false,
      fluxo: { num: s.nfsp_nominal, den: s.pib_mensal },
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
      fluxo: { num: Array.isArray(s.nfsp_primario) ? s.nfsp_primario.map((v) => (v == null ? null : -v)) : null, den: s.pib_mensal },
      formato: (v) => (v < 0 ? `faltou ${f.porcentagem(-v, 1)}` : `sobrou ${f.porcentagem(v, 1)}`),
      formatoCurto: (v) => (v < 0 ? `faltou ${f.porcentagem(-v, 1)}` : `sobrou ${f.porcentagem(v, 1)}`),
    },
    {
      id: 'juros', grupo: 'pais', nome: 'Juros da dívida', curto: 'juros da dívida', secao: '#contas',
      explica: 'quanto o governo federal pagou de juros sobre o que deve, em 12 meses, em % de tudo o que o país produz em um ano (o PIB). Quanto maior a dívida e os juros do país, maior essa conta',
      dica: 'pagos em 12 meses, em % do que o país produz',
      valores: s.nfsp_juros_pib, tipo: 'doze', maiorMelhor: false,
      fluxo: { num: s.nfsp_juros, den: s.pib_mensal },
      formato: (v) => f.porcentagem(v, 1), formatoCurto: (v) => f.porcentagem(v, 1),
    },
    // Sem nota: mais imposto pode significar mais serviços ou mais peso no
    // bolso, e decidir isso é opinião. Mostra o número e a direção.
    {
      id: 'impostos', grupo: 'pais', nome: 'Impostos federais', curto: 'impostos federais', secao: '#arrecadacao', neutro: true,
      explica: 'quanto o governo federal arrecadou em impostos e contribuições em 12 meses, em % de tudo o que o país produz em um ano (o PIB); sem a contribuição ao INSS, para comparar anos de forma justa',
      dica: 'em 12 meses, em % do que o país produz',
      valores: c.razaoDozeMeses(ctx.comparavel, s.pib_mensal), tipo: 'doze', maiorMelhor: true,
      fluxo: { num: ctx.comparavel, den: s.pib_mensal },
      formato: (v) => f.porcentagem(v, 1), formatoCurto: (v) => f.porcentagem(v, 1),
    },
  ];
  return lista
    .filter((it) => Array.isArray(it.valores))
    .map((it) => (it.fluxo && !(Array.isArray(it.fluxo.num) && Array.isArray(it.fluxo.den)) ? { ...it, fluxo: null } : it))
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

// Crises com data oficial. Recessões: cronologia do CODACE (Comitê de
// Datação de Ciclos Econômicos da FGV), em trimestres, do trimestre seguinte
// ao pico até o vale. Pandemia: Emergência em Saúde Pública de Importância
// Nacional, declarada pela Portaria GM/MS 188 (3/2/2020) e encerrada pela
// Portaria GM/MS 913 (22/4/2022), que entrou em vigor 30 dias depois. A
// regra é a mesma para todos os governos; o aviso não mexe nos números.
const CRISES = [
  { de: '1995-04', ate: '1995-09', nome: 'a recessão de 1995' },
  { de: '1998-01', ate: '1999-03', nome: 'a recessão de 1998 e 1999' },
  { de: '2001-04', ate: '2001-12', nome: 'a recessão de 2001' },
  { de: '2003-01', ate: '2003-06', nome: 'a recessão de 2003' },
  { de: '2008-10', ate: '2009-03', nome: 'a recessão da crise mundial de 2008 e 2009' },
  { de: '2014-04', ate: '2016-12', nome: 'a recessão de 2014 a 2016' },
  { de: '2020-01', ate: '2020-06', nome: 'a recessão de 2020' },
  { de: '2020-02', ate: '2022-05', nome: 'a pandemia de covid-19 (fev/2020 a mai/2022)' },
];

const crisesNoPeriodo = (de, ate) => CRISES.filter((x) => x.de <= ate && x.ate >= de);

function montarResumo(ctx) {
  const { meses, mandatos, s } = ctx;
  const itens = indicadoresDoAno(ctx);
  if (!itens.length) { $('#hoje').hidden = true; return; }
  itens.forEach((it) => { it.situacao = nivelDeHoje(it); });

  // Opções de comparação. Padrão: este governo até agora contra o anterior
  // nos mesmos meses de mandato. Depois, o último ano de cada governo que já
  // terminou e cada ano completo, contra os últimos 12 meses.
  const atual = mandatos.find((m) => !m.fim);
  const anteriores = [...mandatos].filter((m) => m.fim).sort((a, b) => b.inicio.localeCompare(a.inicio));
  const periodos = new Map();
  if (atual && anteriores.length) {
    const ant = anteriores[0];
    periodos.set('m:mesmo', { mesmo: true, atual, anterior: ant, rotulo: `${atual.rotulo} × ${ant.rotulo}, mesmo período` });
  }
  // Cada governo é representado pelo último ano atribuído a ele (o ano é de
  // quem governou a maior parte dele): como o governo entregou o país.
  const todosOsAnosDoCalendario = [...new Set(meses.map((mes) => c.anoDe(mes)))];
  const indicesDoAno = (ano) => meses.map((mes, i) => (c.anoDe(mes) === ano ? i : -1)).filter((i) => i >= 0);
  anteriores.forEach((m) => {
    const anosDoGoverno = todosOsAnosDoCalendario.filter((a) => c.governoDoAno(mandatos, a)?.id === m.id);
    if (!anosDoGoverno.length) return;
    const ano = Math.max(...anosDoGoverno);
    periodos.set(`g:${m.id}`, {
      indices: indicesDoAno(ano), ano, governo: true, rotulo: `Governo ${m.rotulo}, último ano (${ano})`,
      curto: `${m.rotulo} (${ano})`, barra: `Governo ${m.rotulo}`,
      modo: `os últimos 12 meses contra o último ano do governo ${m.rotulo} (${ano})`,
    });
  });
  const todosOsAnos = [...new Set(itens.flatMap((it) => [...it.anos.keys()]))].sort((a, b) => b - a);
  todosOsAnos.forEach((ano) => {
    periodos.set(`a:${ano}`, {
      indices: indicesDoAno(ano), ano, rotulo: String(ano), curto: `Em ${ano}`, barra: String(ano),
      modo: `os últimos 12 meses contra ${ano}`,
    });
  });

  const select = $('#hoje-comparar');
  select.replaceChildren();
  const grupos = [
    ['m', 'Este governo × o anterior'],
    ['g', 'Hoje × último ano de cada governo'],
    ['a', 'Hoje × um ano'],
  ].map(([tipo, rotulo]) => {
    const g = el('optgroup', null, null, select);
    g.label = rotulo;
    return [tipo, g];
  });
  const grupoDe = Object.fromEntries(grupos);
  for (const [chave, p] of periodos) el('option', null, p.rotulo, grupoDe[chave[0]]).value = chave;
  grupos.forEach(([, g]) => { if (!g.children.length) g.remove(); });
  select.value = periodos.keys().next().value;

  // Mesmo período: do início do governo atual até o último mês com dado do
  // item, e os mesmos meses de mandato do anterior.
  const ultimoMesDoItem = (it) => (it.fluxo
    ? Math.min(c.ultimoIndice(it.fluxo.num), c.ultimoIndice(it.fluxo.den))
    : c.ultimoIndice(it.valores));
  const mesmo = (it, p) => {
    const par = c.mesmoPeriodo(mandatos, meses, p.atual.id, p.anterior.id, ultimoMesDoItem(it));
    if (!par) return null;
    const valor = (indices) => {
      // Dívida: quanto mudou do mês anterior ao início até o último mês.
      if (it.tipo === 'fim') {
        const a = it.valores[indices[0] - 1];
        const b = it.valores[indices[indices.length - 1]];
        return a == null || b == null ? null : b - a;
      }
      // Fluxos (déficit, juros, impostos): soma do período sobre o PIB do período.
      if (it.fluxo) return c.razaoNoPeriodo(it.fluxo.num, it.fluxo.den, indices);
      return c.valorDoPeriodo(meses, it.valores, it.tipo, indices, 0.9);
    };
    return { ...par, vAtual: valor(par.atual), vAnterior: valor(par.anterior) };
  };
  const intervalo = (indices) => `${f.mesCurto(meses[indices[0]])} a ${f.mesCurto(meses[indices[indices.length - 1]])}`;
  const comoCalcula = (it, indices) => {
    if (it.tipo === 'fim') return `de ${f.mesCurto(meses[indices[0] - 1])} a ${f.mesCurto(meses[indices[indices.length - 1]])}`;
    if (it.fluxo) return `${intervalo(indices)}, todos os meses somados`;
    if (it.tipo === 'acumulado') return `média por ano, ${intervalo(indices)}`;
    return `média de ${intervalo(indices)}`;
  };
  const formatoMesmo = (it) => (it.tipo === 'fim' ? it.formatoVariacao : it.formato);
  const formatoMesmoCurto = (it) => (it.tipo === 'fim' ? it.formatoVariacao : (it.formatoCurto ?? it.formato));

  // Governos: aceita até 10% dos meses sem dado (a ANP, por exemplo, não
  // publicou setembro de 2020). Anos continuam exigindo os 12 meses.
  const valorNoPeriodo = (it, p) => (p.ano ? it.anos.get(p.ano) ?? null : c.valorDoPeriodo(meses, it.valores, it.tipo, p.indices, 0.9));
  const descricaoPeriodo = (it, p) => ({ media: `média de ${p.ano}`, trimestral: `média de ${p.ano}`, acumulado: `em ${p.ano}`, fim: `dez/${p.ano}`, doze: `em ${p.ano}` }[it.tipo]);
  const descricaoHoje = (it) => (it.tipo === 'fim' ? f.mesCurto(it.hoje.ate) : `${f.mesCurto(it.hoje.de)} a ${f.mesCurto(it.hoje.ate)}`);
  const primeiroMesComDado = (it) => meses[it.valores.findIndex((v) => v != null)];

  // Comparação de um item com a opção escolhida: valores, rótulos e veredito.
  const comparacao = (it, p) => {
    if (p.mesmo) {
      const m = mesmo(it, p);
      if (!m) return null;
      return {
        r: c.comparar(m.vAtual, m.vAnterior, it.neutro ? true : it.maiorMelhor),
        texto: m.vAtual == null || m.vAnterior == null ? `${p.anterior.rotulo}, mesmo período: sem dado`
          : `${p.atual.rotulo}: ${formatoMesmoCurto(it)(m.vAtual)} × ${p.anterior.rotulo}: ${formatoMesmoCurto(it)(m.vAnterior)}`,
        sufixo: 'neste governo',
        linhas: [
          { classe: 'comp-antes', rotulo: `Governo ${p.anterior.rotulo}, mesmo período`, quando: comoCalcula(it, m.anterior), valor: m.vAnterior },
          { classe: 'comp-hoje', rotulo: `Governo ${p.atual.rotulo}, até agora`, quando: comoCalcula(it, m.atual), valor: m.vAtual },
        ],
        formato: formatoMesmo(it),
        m,
      };
    }
    const v = valorNoPeriodo(it, p);
    return {
      r: v == null ? null : c.comparar(it.hoje.valor, v, it.neutro ? true : it.maiorMelhor),
      texto: v == null ? `${p.curto}: sem dado` : `${p.curto}: ${(it.formatoCurto ?? it.formato)(v)}`,
      sufixo: 'hoje',
      linhas: [
        { classe: 'comp-antes', rotulo: p.barra, quando: v == null ? null : descricaoPeriodo(it, p), valor: v },
        { classe: 'comp-hoje', rotulo: 'Hoje', quando: descricaoHoje(it), valor: it.hoje.valor },
      ],
      formato: it.formato,
      v,
    };
  };
  const palavraDe = (r, neutro, sufixo) => {
    if (r == null) return ['sem comparação', 'neutro'];
    if (r === 0) return ['quase igual', 'neutro'];
    if (neutro) return [`${r === 1 ? 'maior' : 'menor'} ${sufixo}`, 'neutro'];
    return r === 1 ? [`melhor ${sufixo}`, 'melhor'] : [`pior ${sufixo}`, 'pior'];
  };

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
  // Dívida no mesmo período: de quanto a quanto, nos dois governos.
  const fraseDivida = (it, p, m) => {
    const de = (ind) => `de ${it.formato(it.valores[ind[0] - 1])} (${f.mesCurto(meses[ind[0] - 1])}) para ${it.formato(it.valores[ind[ind.length - 1]])} (${f.mesCurto(meses[ind[ind.length - 1]])})`;
    return `Com ${p.atual.rotulo}, a dívida foi ${de(m.atual)}. No mesmo período de ${p.anterior.rotulo}, ${de(m.anterior)}. Um ponto equivale a 1 real a mais (ou a menos) de dívida para cada 100 produzidos no país em um ano.`;
  };

  // Detalhe que abre ao tocar no item: barras na mesma escala, o porquê, a
  // posição na história e o caminho para a seção.
  const detalhe = (pai, it, p, comp) => {
    const corpo = el('div', 'hoje-detalhe', null, pai);
    el('p', 'ano-explica', comMaiuscula(it.explica) + '.', corpo);
    barrasAntesHoje(corpo, comp.linhas, comp.formato);
    if (p.mesmo) {
      if (it.tipo === 'fim' && comp.m?.vAtual != null && comp.m?.vAnterior != null) el('p', 'ano-porque', fraseDivida(it, p, comp.m), corpo);
    } else if (comp.v == null) {
      const inicio = primeiroMesComDado(it);
      el('p', 'ano-porque', meses[p.indices[0]] < inicio
        ? `Sem dado para esse período: a pesquisa começa em ${c.anoDe(inicio)}.`
        : 'Faltam dados da pesquisa nesse período.', corpo);
    } else {
      const porque = fraseCausas(it, p);
      if (porque) el('p', 'ano-porque', porque, corpo);
    }
    if (it.situacao) el('p', 'ano-ranking', it.situacao.frase, corpo);
    if (it.neutro) el('p', 'ano-ranking', 'Sem nota: mais imposto pode significar mais serviços ou mais peso no bolso, e decidir isso é opinião.', corpo);
    if (it.secao) {
      const a = el('a', 'ano-link', 'Ver a seção completa', corpo);
      a.href = it.secao;
    }
  };

  // Abertura: como está cada número hoje, comparado com a própria história,
  // em grupos: o bolso das pessoas, as contas do país e, com uma cidade
  // escolhida, as contas do estado. Só o bolso daria uma ideia incompleta.
  // Em cada grupo, primeiro o que está bom, depois na média e ruim.
  const caixaHoje = $('#hoje-lista');
  const ordem = { bom: 0, medio: 1, ruim: 2 };
  const conteudoLinha = (linha, { nome, dica, valor, selo, comparacao: cmp }) => {
    const span = el('span', 'hoje-nome', nome, linha);
    if (dica) el('small', null, dica, span);
    el('span', 'hoje-valor', valor, linha);
    if (selo) el('span', `selo selo-${selo.nivel}`, selo.texto, linha);
    if (cmp) {
      const texto = el('span', 'hoje-compara', `${cmp.texto} · `, linha);
      el('strong', `compara-${cmp.classe}`, cmp.palavra, texto);
    }
  };
  const desenharHoje = () => {
    const p = periodos.get(select.value);
    caixaHoje.replaceChildren();
    // Duas colunas, que ficam lado a lado no computador: o bolso de um lado,
    // as contas do país (e do estado) do outro.
    const colunas = { bolso: el('div', 'hoje-coluna', null, caixaHoje), pais: el('div', 'hoje-coluna', null, caixaHoje) };
    for (const [grupo, titulo] of [['bolso', 'No seu bolso'], ['pais', 'Nas contas do país']]) {
      const doGrupo = itens.filter((it) => it.grupo === grupo);
      if (!doGrupo.length) continue;
      el('p', 'hoje-grupo', titulo, colunas[grupo]);
      const lista = el('ul', null, null, colunas[grupo]);
      [...doGrupo].sort((a, b) => (ordem[a.situacao?.nivel] ?? 3) - (ordem[b.situacao?.nivel] ?? 3)).forEach((it) => {
        const comp = comparacao(it, p);
        const [palavra, classe] = palavraDe(comp?.r ?? null, it.neutro, comp?.sufixo);
        const li = el('li', 'hoje-item', null, lista);
        const det = el('details', null, null, li);
        const resumo = el('summary', 'hoje-linha', null, det);
        conteudoLinha(resumo, {
          nome: it.nomeCurto ?? it.nome,
          dica: it.dica,
          valor: (it.formatoCurto ?? it.formato)(it.hoje.valor),
          selo: it.situacao ? { nivel: it.situacao.nivel, texto: NOME_NIVEL[it.situacao.nivel] } : (it.neutro ? { nivel: 'neutro', texto: 'Sem nota' } : null),
          comparacao: comp ? { texto: comp.texto, palavra, classe } : null,
        });
        if (comp) detalhe(det, it, p, comp);
      });
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
      el('p', 'hoje-grupo', `Nas contas do estado (${uf.nome})`, colunas.pais);
      const lista = el('ul', null, null, colunas.pais);
      const linhaEstado = (dados) => {
        const a = el('a', 'hoje-linha', null, el('li', 'hoje-item', null, lista));
        a.href = '#estados';
        conteudoLinha(a, dados);
      };
      const div = ind('dcl_rcl_pct');
      const limDiv = bloco.limite_divida_pct ?? 200;
      if (div != null) {
        linhaEstado({ nome: 'Dívida do estado', dica: `para cada R$ 100 que entram no ano (${ano}); a lei permite ${f.moeda(limDiv, 0)}`,
          valor: div < 0 ? 'não deve' : f.moeda(div, 0), selo: selo(situacao(div, limDiv, bloco.alerta_divida_pct ?? 180)) });
      }
      const fol = ind('pessoal_rcl_pct');
      if (fol != null) {
        linhaEstado({ nome: 'Folha de pagamento', dica: `de cada R$ 100 que entram (${ano}); a lei permite ${f.moeda(ind('pessoal_limite_pct'), 2)}`,
          valor: f.moeda(fol, 0), selo: selo(situacao(fol, ind('pessoal_limite_pct'), ind('pessoal_alerta_pct'))) });
      }
    } else {
      const pe = el('p', 'hoje-estado', 'Para ver também as contas do seu estado, ', colunas.pais);
      const a = el('a', null, 'escolha o estado', pe);
      a.href = '#estados';
      pe.append('.');
    }
  };

  // O que está sendo comparado, em uma frase, e o aviso de crise quando um
  // dos dois períodos cruza uma crise com data oficial.
  const ultimoMesGeral = Math.max(...itens.map((it) => ultimoMesDoItem(it)));
  const desenharModo = () => {
    const p = periodos.get(select.value);
    const caixaModo = $('#hoje-modo');
    const caixaAviso = $('#hoje-aviso');
    let trechos;
    if (p.mesmo) {
      const par = c.mesmoPeriodo(mandatos, meses, p.atual.id, p.anterior.id, ultimoMesGeral);
      caixaModo.textContent = `Embaixo de cada número: ${p.atual.rotulo}, do primeiro mês até o último publicado, × ${p.anterior.rotulo} nos mesmos meses de mandato (${intervalo(par.anterior)}).`;
      trechos = [[`o período de ${p.anterior.rotulo} inclui`, par.anterior], [`o período de ${p.atual.rotulo} inclui`, par.atual]];
    } else {
      caixaModo.textContent = `Embaixo de cada número: ${p.modo}.`;
      const hoje = meses.map((_, i) => i).filter((i) => i > ultimoMesGeral - 12 && i <= ultimoMesGeral);
      trechos = [[p.governo ? `o último ano do governo ${p.curto} inclui` : `o ano de ${p.ano} inclui`, p.indices], ['os últimos 12 meses incluem', hoje]];
    }
    const avisos = trechos
      .map(([nome, ind]) => [nome, crisesNoPeriodo(meses[ind[0]], meses[ind[ind.length - 1]])])
      .filter(([, lista]) => lista.length);
    caixaAviso.hidden = !avisos.length;
    if (avisos.length) {
      const partes = avisos.map(([sujeito, lista]) => `${sujeito} ${listaDeAnos(lista.map((x) => x.nome))}`);
      caixaAviso.textContent = `Atenção: ${partes.join('; ')}. Crises mexem com quase todos os números; o aviso não muda as contas.`;
    }
  };

  const atualizar = () => { desenharModo(); desenharHoje(); };
  atualizar();
  aoMudarCidade(desenharHoje);
  select.addEventListener('change', atualizar);

  registrarDownload('resumo', () => {
    const linhas = [['hoje (últimos 12 meses)', ...itens.map((it) => arred(it.hoje.valor, 2))]];
    const pm = periodos.get('m:mesmo');
    if (pm) {
      const valores = itens.map((it) => mesmo(it, pm));
      linhas.push([`governo ${pm.atual.rotulo} até agora (dívida: variação em pontos)`, ...valores.map((m) => arred(m?.vAtual, 2))]);
      linhas.push([`governo ${pm.anterior.rotulo}, mesmo período (dívida: variação em pontos)`, ...valores.map((m) => arred(m?.vAnterior, 2))]);
    }
    for (const p of periodos.values()) {
      if (!p.mesmo) linhas.push([p.rotulo, ...itens.map((it) => arred(valorNoPeriodo(it, p), 2))]);
    }
    return { nome: 'comparacao-por-ano-e-governo.csv', cabecalhos: ['período', ...itens.map((it) => it.nome)], linhas };
  });
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

  // Índice lateral: os mesmos grupos e links do menu, montados aqui para
  // não repetir a lista no HTML. A parte em leitura fica marcada nos dois.
  const indice = $('#indice');
  if (indice) {
    montarIndice(indice, [...menu.querySelectorAll('.secoes-grupo')].map((grupo) => ({
      titulo: grupo.querySelector('.secoes-titulo')?.textContent,
      links: [...grupo.querySelectorAll('a')].map((a) => ({ texto: a.textContent, href: a.getAttribute('href') })),
    })));
  }
  acompanharLeitura([...links, ...(indice ? indice.querySelectorAll('a[href^="#"]') : [])], secoes, indice);
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
    const etapas = [iniciarContador, montarNovidades, montarOrcamento, montarResumo, montarCompras, montarCombustiveis, montarSalario, montarArrecadacao,
      montarComposicao, montarComposicaoEstados, montarGastos, montarMinisterios, montarCartao, montarViagens, montarContas, montarEstados, montarMunicipios, montarCota, montarDinheiro,
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
