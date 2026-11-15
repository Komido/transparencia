import * as c from './calculos.js';
import * as f from './formato.js';
import * as t from './textos.js';
import { criarGrafico, preencherTabela, baixarCSV } from './graficos.js';
import { carregarPainel, carregarIndiceCidades, carregarCidade } from './dados.js';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const campo = (nome) => document.querySelectorAll(`[data-campo="${nome}"]`);
const definir = (nome, texto) => campo(nome).forEach((e) => { e.textContent = texto; });

// Resumos em tópicos: uma frase por item, mais fácil de achar cada número.
// A frase termina em ". " seguido de maiúscula; "R$ 1.621" não quebra.
function definirTopicos(nome, texto) {
  const partes = texto.trim().split(/\.\s+(?=[A-ZÀ-Ý])/);
  const frases = partes.map((fr, i) => (i < partes.length - 1 ? `${fr}.` : fr)).filter((fr) => fr.trim());
  campo(nome).forEach((e) => {
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

  const atualizar = () => {
    const agora = Date.now();
    const est = dados.estimadoEm(agora);
    alvo.textContent = `R$\u00A0${formatoCheio.format(dados.confirmado + est)}`;
    estimado.textContent = f.reaisCompacto(est);
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
        nome: real ? 'Arrecadação federal, em dinheiro de hoje' : 'Arrecadação federal como parte do PIB',
        classe: 'serie-1',
        valores: anual.map((l) => (real ? l.real / 1e3 : l.carga)),
        parciais: real ? parciais : new Set(),
        notaParcial: (i) => `soma de ${anual[i].meses} meses`,
      }],
      formatoY: real
        ? (v, eixo) => (eixo ? `${f.numero(v, 0)}` : `R$\u00A0${f.numero(v, 1)} bi`)
        : (v) => f.porcentagem(v, 1),
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
        : 'Arrecadação federal por ano, como parte do PIB.',
    };
  };

  const notaMedida = (medida) => {
    const base = medida === 'real'
      ? `Valores em bilhões de reais, em dinheiro de ${f.mesLongo(referencia)} (corrigidos pela inflação medida pelo IPCA).`
      : 'Arrecadação dividida pelo PIB dos mesmos meses. O PIB mensal é uma estimativa do Banco Central.';
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
    ['Ano', 'Em dinheiro de hoje (R$ bilhões)', 'Parte do PIB', 'Frente ao ano anterior, sem a inflação'],
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
      [agrupar ? 'Partido' : 'Mandato', 'Parte do PIB (média dos anos)', 'Crescimento por ano, sem a inflação (média)'],
      resumo.map((r) => [
        {
          texto: r.rotulo,
          detalhe: `${agrupar ? r.mandatos.join(', ') : r.partido} · ${descreverAnos(r)}`,
        },
        f.porcentagem(r.medias.carga, 2),
        r.anosComDado.variacaoReal ? f.porcentagem(r.medias.variacaoReal, 1, true) : 'n/d',
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
  const maior = somas[0]?.soma ?? 1;
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
    barra.style.width = `${Math.max(1, (g.soma / maior) * 100)}%`;
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
    linhas.push(`Estados: nos 12 meses até ${f.mesLongo(ate)}, os estados e o Distrito Federal arrecadaram ${f.reaisPorExtenso(icms)} de ICMS, `
      + `${f.reaisPorExtenso(ipva)} de IPVA e ${f.reaisPorExtenso(itcd)} de ITCMD (herança e doação).`);
    const k = ctx.meses.indexOf(ate);
    const janela = k >= 11 ? ctx.total.slice(k - 11, k + 1) : [];
    if (janela.length === 12 && janela.every((v) => v != null)) {
      const federal = janela.reduce((a, v) => a + v, 0) * 1e6;
      linhas.push(`No mesmo período, a arrecadação federal foi de ${f.reaisPorExtenso(federal)}: para cada R$ 100 federais, `
        + `os estados arrecadaram ${f.moeda(((icms + ipva + itcd) / federal) * 100, 0)} com esses três impostos.`);
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
      linhas.push(`Prefeituras: em ${ano}, arrecadaram ${f.reaisPorExtenso((iss + iptu + itbi) * 1e6)} com ISS, IPTU e ITBI, `
        + `pela estimativa anual do Tesouro Nacional (${f.reaisPorExtenso(iss * 1e6)} de ISS, ${f.reaisPorExtenso(iptu * 1e6)} de IPTU e ${f.reaisPorExtenso(itbi * 1e6)} de ITBI).`);
    }
    const total = item('governo_geral_total');
    const pct = item('governo_geral_total', 'pct_pib');
    if (total != null && pct != null) {
      linhas.push(`Tudo junto: em ${ano}, União, estados e prefeituras cobraram ${f.reaisPorExtenso(total * 1e6)} em tributos, `
        + `ou ${f.moeda(pct, 0)} de cada R$ 100 que o país produziu.`);
    }
  }
  if (!linhas.length) return;
  definirTopicos('composicao-estados', linhas.join(' '));
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
    const maior = grandes[0]?.valor ?? 1;
    const linha = (nome, explica, valor) => {
      const li = el('li', null, null, lista);
      const topo = el('div', 'barra-topo', null, li);
      const rotulo = el('span', 'barra-nome', nome, topo);
      if (explica) el('span', 'barra-explica', explica, rotulo);
      el('span', 'barra-valor', `${porCem((valor / totalAno) * 100)} de cada R$ 100 · ${f.reaisCompacto(valor)}`, topo);
      const trilho = el('div', 'barra-trilho', null, li);
      trilho.setAttribute('aria-hidden', 'true');
      el('div', 'barra', null, trilho).style.width = `${Math.max(1, (valor / maior) * 100)}%`;
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
      ? `Nos 12 meses até ${ate}, o governo federal arrecadou ${f.reaisPorExtenso(p)} a mais do que gastou, sem contar os juros da dívida (${f.porcentagem(pPib.hoje.valor, 1)} do PIB).`
      : `Nos 12 meses até ${ate}, o governo federal gastou ${f.reaisPorExtenso(-p)} a mais do que arrecadou, sem contar os juros da dívida (${f.porcentagem(-pPib.hoje.valor, 1)} do PIB).`);
    linhas.push(`Os juros da dívida custaram ${f.reaisPorExtenso(jR.hoje.valor * 1e6)} (${f.porcentagem(jPib.hoje.valor, 1)} do PIB).`);
    linhas.push(n >= 0
      ? `Mesmo com os juros, sobraram ${f.reaisPorExtenso(n)} (${f.porcentagem(nPib.hoje.valor, 1)} do PIB).`
      : `Somando os juros, faltaram ${f.reaisPorExtenso(-n)} (${f.porcentagem(-nPib.hoje.valor, 1)} do PIB), cobertos com dívida nova.`);
    if (dPib.hoje) {
      linhas.push(`A dívida bruta do governo (União, estados e municípios) está em ${f.porcentagem(dPib.hoje.valor, 0)} do PIB em ${f.mesLongo(dPib.hoje.ate)}: para cada R$ 100 que o país produz em um ano, o governo deve ${f.moeda(dPib.hoje.valor, 0)}.`);
    }
    definirTopicos('contas-resumo', linhas.join(' '));
  }

  // Gráfico por ano --------------------------------------------------------
  const anos = [...new Set([...pPib.anos.keys(), ...dPib.anos.keys()])].filter((a) => a >= 1995).sort((a, b) => a - b);
  const faixas = c.faixasAnuais(mandatos, anos);
  const visoes = {
    primario: {
      nome: 'Antes dos juros: sobrou (+) ou faltou (−)', pib: pPib, real: pReal,
      explicacao: 'Diferença entre o que o governo federal arrecadou e o que gastou no ano, sem contar os juros da dívida. Acima de zero, sobrou dinheiro (superávit); abaixo, faltou (déficit).',
    },
    juros: {
      nome: 'Juros da dívida', pib: jPib, real: jReal,
      explicacao: 'Quanto a dívida custou em juros no ano.',
    },
    nominal: {
      nome: 'Resultado final, com os juros', pib: nPib, real: nReal,
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
        ? (x, eixo) => (eixo ? f.numero(x, 0) : `${f.porcentagem(x, 1)} do PIB`)
        : (x, eixo) => (eixo ? f.numero(x, 0) : `R$\u00A0${f.numero(x, 1)} bi`),
      rotuloEixoX: (ano) => (ano % 5 === 0 ? String(ano) : null),
      tituloTooltip: (i) => String(anos[i]),
      extraTooltip: (i) => {
        const g = c.governoDoAno(mandatos, anos[i]);
        return g ? `Governo: ${g.rotulo} (${g.partido})` : null;
      },
      descricao: `${v.nome}, por ano, ${medida === 'pib' ? 'em % do PIB' : 'em bilhões de reais de hoje'}.`,
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-contas'), opcoes);
  };
  document.querySelectorAll('input[name="contas-visao"], input[name="contas-medida"]').forEach((r) => r.addEventListener('change', desenhar));
  desenhar();

  // Por governo -------------------------------------------------------------
  const linhasAno = anos.map((a) => ({ ano: a, primario: pPib.anos.get(a) ?? null, nominal: nPib.anos.get(a) ?? null, divida: dPib.anos.get(a) ?? null }));
  const resumo = c.resumoPorGoverno(linhasAno, mandatos, ['primario', 'nominal']);
  const sinal = (x) => (x == null ? 'n/d' : f.porcentagem(x, 1, true));
  preencherTabela($('#tabela-contas-governos'),
    ['Mandato', 'Antes dos juros (média por ano, % do PIB)', 'Resultado final (média por ano, % do PIB)', 'Dívida bruta no fim (% do PIB)'],
    resumo.map((r) => {
      const ultimo = r.anos.length ? Math.max(...r.anos) : null;
      const divida = ultimo != null ? dPib.anos.get(ultimo) : null;
      return [
        { texto: r.rotulo, detalhe: `${r.partido} · ${descreverAnos(r)}` },
        r.anosComDado.primario ? sinal(r.medias.primario) : 'n/d',
        r.anosComDado.nominal ? sinal(r.medias.nominal) : 'n/d',
        divida == null ? 'n/d' : f.porcentagem(divida, 0),
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
  estados.forEach((uf) => { el('option', null, uf.nome, selUf).value = uf.sigla; });
  let escolhidoPelaPessoa = false;
  const ufDaCidade = () => (cidade.dados?.uf && estados.some((x) => x.sigla === cidade.dados.uf) ? cidade.dados.uf : null);
  selUf.value = ufDaCidade() ?? estados[0].sigla;

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
        texto: `nos 12 meses até ${f.mesLongo(rec.doze_meses_ate)}, o estado arrecadou ${f.reaisPorExtenso(total)}. `
          + `O ICMS, imposto embutido no preço das mercadorias, respondeu por ${f.porcentagem((doze.icms / total) * 100, 0)} disso.`,
      });
    }
    const capital = capitalDe(uf);
    const dozeCap = capital?.doze_meses;
    if (dozeCap?.iss != null && dozeCap.iptu != null && dozeCap.itbi != null && capital.ultimo_mes) {
      const total = dozeCap.iss + dozeCap.iptu + dozeCap.itbi;
      itens.push({
        rotulo: ehBrasilia(capital) ? 'Impostos de Brasília' : `Prefeitura de ${capital.nome}`,
        texto: `nos 12 meses até ${f.mesLongo(capital.ultimo_mes)}, ${quemCobra(capital)} arrecadou ${f.reaisPorExtenso(total)} com ISS, IPTU e ITBI. `
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
      formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : (v == null ? 'n/d' : `${porCemReais(v)} de cada R$ 100`)),
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
        : (v == null ? 'n/d' : `R$ ${f.numero(v, 1)} ${escala.sufixo} em dinheiro de hoje`)),
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

  const desenharTudo = () => { desenharResumo(); desenharGrafico(); desenharReceita(); };
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
        div == null ? 'n/d' : { texto: porCemReais(div, limiteDivida, alertaDivida), detalhe: marca(sitDiv) },
        fol == null ? 'n/d' : { texto: porCemReais(fol, limite, alerta), detalhe: marca(sitFol) },
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
// Salário mínimo
// ---------------------------------------------------------------------------

function montarSalario(ctx) {
  const { meses, s, mandatos } = ctx;
  const sm = c.salarioMinimo(meses, s);
  const anual = c.anualSalario(meses, sm);
  const iUlt = c.ultimoIndice(sm.real);
  const iDolar = c.ultimoIndice(sm.emDolar);
  const iNec = c.ultimoIndice(sm.frenteNecessario);

  // Resumo e números do topo acompanham o ano escolhido em "Comparar com".
  const atualizarTopo = (iBase) => {
    const razaoReal = sm.real[iUlt] / sm.real[iBase];
    const ganho = razaoReal >= 1.5
      ? `compra ${f.numero(razaoReal, 1)} vezes o que comprava em ${f.mesLongo(meses[iBase])}`
      : `compra ${t.variacao((razaoReal - 1) * 100, 0)} do que em ${f.mesLongo(meses[iBase])}`;
    let resumoSm = `Em ${f.mesLongo(meses[iUlt])}, o salário mínimo é de ${f.moeda(s.salario_minimo[iUlt], 0)}. Descontada a inflação, ele ${ganho}.`;
    if (s.smn_dieese[iNec] != null) {
      resumoSm += ` Pelas contas do DIEESE, uma família de quatro pessoas precisaria de ${f.moeda(s.smn_dieese[iNec], 0)} por mês para viver com o básico, `
        + `o equivalente a ${f.numero(s.smn_dieese[iNec] / s.salario_minimo[iNec], 1)} salários mínimos.`;
    }
    definirTopicos('sm-resumo', resumoSm);

    const numeros = $('#numeros-salario');
    numeros.replaceChildren();
    const item = (rotulo, valor) => {
      const div = el('div', null, null, numeros);
      el('dt', null, rotulo, div);
      el('dd', null, valor, div);
    };
    item(`Salário mínimo em ${f.mesCurto(meses[iUlt])}`, f.moeda(s.salario_minimo[iUlt], 0));
    item(`Salário de ${f.mesCurto(meses[iBase])} em dinheiro de hoje`, f.moeda(sm.real[iBase], 0));
    item(`Em dólar (${f.mesCurto(meses[iDolar])})`, f.dolar(sm.emDolar[iDolar], 0));
    item(`Parte do salário necessário, segundo o DIEESE (${f.mesCurto(meses[iNec])})`, f.porcentagem(sm.frenteNecessario[iNec], 0));
  };

  // Poder de compra: o salário de um mês-base, corrigido só pela inflação
  // (INPC) dali em diante, ao lado do salário de verdade. A distância entre as
  // linhas é o ganho (ou a perda) acima da inflação desde o mês-base.
  const inpc = c.indiceAcumulado(s.inpc_var);
  const { candidatos: basesPossiveis } = mesesParaComparar(meses, sm.real);
  let anoBase = null;
  const selBase = $('#sm-ano');

  const reguas = {
    real: () => {
      const iB = indiceDoAno(meses, basesPossiveis, anoBase);
      preencherAnos(selBase, meses, basesPossiveis, iB);
      atualizarTopo(iB);
      const corrigido = meses.map((m, i) => (i < iB || inpc[i] == null ? null : (s.salario_minimo[iB] * inpc[i]) / inpc[iB]));
      const iFim = c.ultimoIndice(corrigido);
      const nomeBase = f.mesCurto(meses[iB]);
      return {
        inicio: iB,
        nome: `Salário mínimo e o salário de ${nomeBase} corrigido só pela inflação`,
        series: [
          { nome: 'Salário mínimo', classe: 'serie-1', valores: s.salario_minimo },
          { nome: `Salário de ${nomeBase} só com a inflação`, classe: 'serie-2', valores: corrigido },
        ],
        formato: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 0)),
        explicacao: `A linha azul é o salário mínimo de cada mês. A laranja mostra quanto ele seria se, a partir de ${f.mesLongo(meses[iB])} (${f.moeda(s.salario_minimo[iB], 0)}), só tivesse sido corrigido pela inflação (INPC). `
          + `Em ${f.mesLongo(meses[iFim])}, essa conta dá ${f.moeda(corrigido[iFim], 0)}, e o salário é ${f.moeda(s.salario_minimo[iFim], 0)}. `
          + 'Quando a azul fica acima da laranja, o salário ganhou da inflação; abaixo, perdeu.',
      };
    },
    dolar: () => ({
      nome: 'Salário mínimo em dólares',
      valores: sm.emDolar,
      formato: (v, eixo) => (eixo ? f.numero(v, 0) : f.dolar(v, 0)),
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
        explicacao: `A linha laranja é quanto o DIEESE calcula que uma família de 2 adultos e 2 crianças precisa por mês para viver com o básico. A distância até a linha azul é quanto falta ao salário mínimo: em ${f.mesLongo(meses[iN])}, ${f.moeda(s.smn_dieese[iN] - s.salario_minimo[iN], 0)}, e o mínimo cobre ${f.porcentagem(sm.frenteNecessario[iN], 0)} do necessário.`,
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
    $('#sm-ano-caixa').hidden = chave !== 'real';
    const { opcoes, explicacao } = configurar(chave);
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-salario'), opcoes);
    definir('sm-explicacao', explicacao);
  };
  document.querySelectorAll('input[name="sm-regua"]').forEach((r) => r.addEventListener('change', desenharSalario));
  selBase.addEventListener('change', (ev) => { anoBase = c.anoDe(meses[Number(ev.target.value)]); desenharSalario(); });
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
  definirTopicos('dolar-resumo',
    `Em ${f.mesLongo(meses[iUlt])}, um dólar custou em média ${f.moeda(s.dolar_ptax[iUlt], 2)}. `
    + `Descontada a inflação do Brasil e a dos Estados Unidos, ${posicao}${efeito}`);

  criarGrafico($('#grafico-dolar'), {
    tipo: 'linhas',
    rotulos: meses,
    faixas,
    series: [
      { nome: 'Cotação na época', classe: 'serie-1', valores: s.dolar_ptax },
      { nome: 'Em dinheiro de hoje', classe: 'serie-2', valores: real.valores },
    ],
    formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 2)),
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
    + `Se o limite de ${f.moeda(primeiraIsencao, 0)} de 1996 tivesse acompanhado a inflação, ele seria de ${f.moeda(corrigida[iUlt], 0)}.`;
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
    const comp = t.compraMaisOuMenos(qB, qA);
    let fecho = '';
    if (comp === 'a mesma quantidade') fecho = ` Hoje ele compra a mesma quantidade que em ${anoA}.`;
    else if (comp) fecho = ` Hoje ele compra ${comp} do que em ${anoA}.`;
    const onde = naCidade(item) ? `${ondeLocal(item)}, com` : 'Com';
    definirTopicos('compras-resumo',
      `${onde} um salário mínimo (${f.moeda(s.salario_minimo[iUlt], 0)}), em ${f.mesLongo(meses[iUlt])} dá para comprar ${t.quantidadeCom(qB, item.unidade, item.plural)}. `
      + `Em ${f.mesLongo(meses[iA])}, com o salário da época (${f.moeda(s.salario_minimo[iA], 0)}), dava para comprar ${t.quantidade(qA)}.${fecho}`);

    const numeros = $('#compras-numeros');
    numeros.replaceChildren();
    const precoItem = (i) => precos[i] * item.tamanho;
    itemNumero(numeros, `Em ${f.mesCurto(meses[iA])}`, t.quantidade(qA), item.plural);
    itemNumero(numeros, `Em ${f.mesCurto(meses[iUlt])}`, t.quantidade(qB), item.plural);
    const equivalente = (precoItem(iA) * s.salario_minimo[iUlt]) / s.salario_minimo[iA];
    itemNumero(numeros, `${maiuscula(item.singular)} custa hoje`, f.moeda(precoItem(iUlt), 2),
      `Em ${anoA} custava ${f.moeda(precoItem(iA), 2)}, o equivalente a ${f.moeda(equivalente, 2)} no salário de hoje.`);

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
      id: 'salario', nome: 'Salário mínimo', curto: 'salário mínimo', secao: '#salario',
      explica: 'quanto vale em dinheiro de hoje (corrigido pela inflação, INPC)',
      valores: sm.real, tipo: 'media', maiorMelhor: true, formato: (v) => f.moeda(v, 0),
      causas: [salario, { rotulo: 'os preços (INPC)', serie: inpc }],
    },
    {
      id: 'cestas', nome: 'Cestas básicas por salário mínimo', curto: 'cestas básicas por salário', secao: '#compras',
      explica: 'quantas cestas do DIEESE um salário mínimo compra',
      valores: s.cesta_total ? c.quantidadeComprada(s.salario_minimo, s.cesta_total) : null,
      tipo: 'media', maiorMelhor: true, formato: (v) => f.numero(v, 2),
      causas: [salario, { rotulo: 'a cesta básica', serie: s.cesta_total }],
    },
    {
      id: 'desemprego', nome: 'Desemprego', curto: 'desemprego', secao: null,
      explica: 'de cada 100 pessoas que trabalham ou procuram trabalho, quantas não encontram',
      valores: s.desocupacao, tipo: 'trimestral', maiorMelhor: false, formato: (v) => f.porcentagem(v, 1),
    },
    {
      id: 'renda', nome: 'Renda de quem trabalha', curto: 'renda do trabalho', secao: null,
      explica: 'média de todos os trabalhos, com ou sem carteira, em dinheiro de hoje',
      valores: s.renda_trabalho, tipo: 'trimestral', maiorMelhor: true, formato: (v) => f.moeda(v, 0),
    },
    {
      id: 'inflacao', nome: 'Inflação', curto: 'inflação', secao: null, meta: t.META_INFLACAO,
      explica: 'quanto os preços subiram em 12 meses (IPCA)',
      valores: s.ipca_var, tipo: 'acumulado', maiorMelhor: false, formato: (v) => f.porcentagem(v, 1),
    },
    {
      id: 'botijao', nome: 'Botijão de gás', curto: 'botijão de gás', secao: '#combustiveis',
      explica: 'quanto pesa no salário mínimo',
      valores: s.comb_glp ? parteDoSalario(s.comb_glp, 1) : null,
      tipo: 'media', maiorMelhor: false, formato: (v) => f.porcentagem(v, 1),
      causas: [{ rotulo: 'o botijão', serie: s.comb_glp }, salario],
    },
    {
      id: 'tanque', nome: 'Tanque de gasolina', curto: 'gasolina', secao: '#combustiveis',
      explica: `quanto ${TANQUE_LITROS} litros pesam no salário mínimo`,
      valores: s.comb_gasolina ? parteDoSalario(s.comb_gasolina, TANQUE_LITROS) : null,
      tipo: 'media', maiorMelhor: false, formato: (v) => f.porcentagem(v, 0),
      causas: [{ rotulo: 'a gasolina', serie: s.comb_gasolina }, salario],
    },
    {
      id: 'divida', nome: 'Dívida do governo', curto: 'dívida do governo', secao: '#contas',
      explica: 'tudo o que União, estados e municípios devem, comparado com o que o país produz em um ano (PIB)',
      valores: s.divida_bruta_pib, tipo: 'fim', maiorMelhor: false, formato: (v) => `${f.porcentagem(v, 1)} do PIB`,
      deficit: Array.isArray(s.nfsp_nominal) ? c.deflacionar(s.nfsp_nominal, ipca) : null,
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

const NOME_NIVEL = { bom: 'Bom', medio: 'Médio', ruim: 'Ruim' };

function montarResumo(ctx) {
  const { meses, mandatos } = ctx;
  const itens = indicadoresDoAno(ctx);
  if (!itens.length) { $('#resumo').hidden = true; return; }
  itens.forEach((it) => { it.situacao = nivelDeHoje(it); });

  // Resumo geral: o que está bom, médio e ruim hoje.
  const grupos = ['bom', 'medio', 'ruim'].map((nivel) => ({ nivel, nomes: itens.filter((it) => it.situacao?.nivel === nivel).map((it) => it.curto) }))
    .filter((g) => g.nomes.length);
  const rotuloGrupo = { bom: 'Está bom', medio: 'Está na média', ruim: 'Está ruim' };
  definirItens('resumo-geral', grupos.map((g) => ({ rotulo: rotuloGrupo[g.nivel], texto: `${listaDeAnos(g.nomes)}.` })));

  // Opções de comparação: governos que já terminaram (o mais recente primeiro,
  // que é o padrão) e anos completos.
  const anteriores = [...mandatos].filter((m) => m.fim).sort((a, b) => b.inicio.localeCompare(a.inicio));
  const periodos = new Map();
  anteriores.forEach((m) => {
    const indices = c.mesesDoMandato(mandatos, meses, m.id);
    if (!indices.length) return;
    const de = c.anoDe(meses[indices[0]]);
    const ate = c.anoDe(meses[indices[indices.length - 1]]);
    periodos.set(`g:${m.id}`, { indices, rotulo: `Governo ${m.rotulo}`, quando: `no governo ${m.rotulo}`, de, ate, partido: m.partido });
  });
  const todosOsAnos = [...new Set(itens.flatMap((it) => [...it.anos.keys()]))].sort((a, b) => b - a);
  todosOsAnos.forEach((ano) => {
    const indices = meses.map((mes, i) => (c.anoDe(mes) === ano ? i : -1)).filter((i) => i >= 0);
    periodos.set(`a:${ano}`, { indices, rotulo: String(ano), quando: `em ${ano}`, de: ano, ate: ano, ano });
  });

  const select = $('#resumo-comparar');
  select.replaceChildren();
  const grupoGov = el('optgroup', null, null, select);
  grupoGov.label = 'Governos anteriores';
  const grupoAno = el('optgroup', null, null, select);
  grupoAno.label = 'Anos';
  for (const [chave, p] of periodos) {
    const texto = p.ano ? p.rotulo : `${p.rotulo} (${p.partido}), ${p.de} a ${p.ate}`;
    el('option', null, texto, p.ano ? grupoAno : grupoGov).value = chave;
  }
  select.value = periodos.keys().next().value;

  const descricaoPeriodo = (it, p) => {
    if (p.ano) return { media: 'média do ano', trimestral: 'média do ano', acumulado: 'no ano', fim: 'em dezembro' }[it.tipo];
    const intervalo = `${p.de} a ${p.ate}`;
    return { media: `média de ${intervalo}`, trimestral: `média de ${intervalo}`, acumulado: `média por ano, ${intervalo}`,
      fim: `no fim, ${f.mesCurto(meses[p.indices[p.indices.length - 1]])}` }[it.tipo];
  };
  const descricaoHoje = (it) => (it.tipo === 'fim' ? f.mesCurto(it.hoje.ate) : `${f.mesCurto(it.hoje.de)} a ${f.mesCurto(it.hoje.ate)}`);
  // Governos: aceita até 10% dos meses sem dado (a ANP, por exemplo, não
  // publicou setembro de 2020). Anos continuam exigindo os 12 meses.
  const valorNoPeriodo = (it, p) => (p.ano ? it.anos.get(p.ano) ?? null : c.valorDoPeriodo(meses, it.valores, it.tipo, p.indices, 0.9));
  const primeiroMesComDado = (it) => meses[it.valores.findIndex((v) => v != null)];

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
    const lista = $('#resumo-lista');
    lista.replaceChildren();
    for (const it of itens) {
      const li = el('li', 'ano-item', null, lista);
      const topo = el('div', 'ano-topo', null, li);
      el('h3', 'ano-nome', it.nome, topo);
      if (it.situacao) el('span', `selo selo-${it.situacao.nivel}`, NOME_NIVEL[it.situacao.nivel], topo);
      el('p', 'ano-explica', it.explica, li);

      const valores = el('dl', 'ano-valores', null, li);
      const caixa = (rotulo, texto, detalhe) => {
        const div = el('div', null, null, valores);
        el('dt', null, rotulo, div);
        const dd = el('dd', null, texto, div);
        if (detalhe) el('span', 'ano-quando', detalhe, dd);
      };
      caixa('Hoje', it.formato(it.hoje.valor), descricaoHoje(it));
      const vSel = valorNoPeriodo(it, p);
      caixa(p.rotulo, vSel == null ? 'sem dado' : it.formato(vSel), vSel == null ? null : descricaoPeriodo(it, p));

      let veredito;
      if (vSel == null) {
        const inicio = primeiroMesComDado(it);
        veredito = meses[p.indices[0]] < inicio
          ? `Sem dado para esse período: a pesquisa começa em ${c.anoDe(inicio)}.`
          : 'Faltam dados da pesquisa nesse período.';
      }
      else {
        const r = c.comparar(it.hoje.valor, vSel, it.maiorMelhor);
        veredito = r === 1 ? 'Melhor hoje.' : r === -1 ? `Era melhor ${p.quando}.` : 'Praticamente igual.';
      }
      el('p', 'ano-veredito', veredito, li);
      const porque = vSel == null ? null : fraseCausas(it, p);
      if (porque) el('p', 'ano-porque', porque, li);
      if (it.situacao) el('p', 'ano-ranking', it.situacao.frase, li);
      if (it.secao) {
        const a = el('a', 'ano-link', 'Ver detalhes', li);
        a.href = it.secao;
      }
    }
  };
  select.addEventListener('change', desenhar);
  desenhar();

  registrarDownload('resumo', () => ({
    nome: 'resumo-por-ano-e-governo.csv',
    cabecalhos: ['período', ...itens.map((it) => it.nome)],
    linhas: [
      ['hoje (últimos 12 meses)', ...itens.map((it) => arred(it.hoje.valor, 2))],
      ...[...periodos.values()].map((p) => [p.ano ? String(p.ano) : `${p.rotulo} (${p.de} a ${p.ate})`,
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
    const iUltPreco = c.ultimoIndice(nominal);
    const equivalente = c.noSalarioDeHoje(nominal, s.salario_minimo, iUltPreco);
    const { iUlt, candidatos } = mesesParaComparar(meses, equivalente);
    if (iUlt < 0 || !candidatos.length) return;
    const iA = indiceDoAno(meses, candidatos, anoEscolhido);
    preencherAnos($('#combustiveis-ano'), meses, candidatos, iA);

    const anoA = c.anoDe(meses[iA]);
    const comparado = t.maisCaroOuBarato(nominal[iUlt], equivalente[iA], item.feminino);
    const custo = (i) => (item.litro ? nominal[i] * TANQUE_LITROS : nominal[i]);
    const parte = (i) => (custo(i) / s.salario_minimo[i]) * 100;
    const casas = item.litro ? 0 : 1;

    const conclusao = comparado
      ? `Para quem ganha um salário mínimo, ${item.sujeito} está ${comparado} do que em ${anoA}.`
      : `Para quem ganha um salário mínimo, ${item.sujeito} pesa praticamente o mesmo que em ${anoA}.`;
    const textoCusto = item.litro
      ? `Encher um tanque de ${TANQUE_LITROS} litros custa ${f.moeda(custo(iUlt), 0)}, ou ${t.parteDoSalario(parte(iUlt))} (em ${anoA}, ${f.porcentagem(parte(iA), 0)}).`
      : `Um botijão custa ${t.parteDoSalario(parte(iUlt))} (em ${anoA}, ${f.porcentagem(parte(iA), 1)}).`;
    definirTopicos('combustiveis-resumo',
      `Em ${f.mesLongo(meses[iUlt])}, ${item.descricao} custa em média ${f.moeda(nominal[iUlt], 2)} ${onde}, com o salário mínimo em ${f.moeda(s.salario_minimo[iUlt], 0)}. `
      + `Em ${f.mesLongo(meses[iA])}, custava ${f.moeda(nominal[iA], 2)}, quando o salário mínimo era ${f.moeda(s.salario_minimo[iA], 0)}; com o salário de hoje, aquele preço equivaleria a ${f.moeda(equivalente[iA], 2)}. `
      + `${conclusao} ${textoCusto}`);

    const numeros = $('#combustiveis-numeros');
    numeros.replaceChildren();
    itemNumero(numeros, `Preço em ${f.mesCurto(meses[iUlt])}`, f.moeda(nominal[iUlt], 2));
    itemNumero(numeros, `Preço de ${f.mesCurto(meses[iA])} no salário de hoje`, f.moeda(equivalente[iA], 2), `Na época: ${f.moeda(nominal[iA], 2)}`);
    itemNumero(numeros, item.litro ? `Tanque de ${TANQUE_LITROS} litros` : 'Um botijão', f.moeda(custo(iUlt), 0),
      `${t.parteDoSalario(parte(iUlt))} (em ${anoA}, ${f.porcentagem(parte(iA), casas)})`);

    // O gráfico começa no primeiro mês com preço publicado.
    const iIni = nominal.findIndex((v) => v != null);
    const mesesG = meses.slice(iIni);
    const opcoes = {
      tipo: 'linhas',
      rotulos: mesesG,
      faixas: c.faixasDeMandato(mandatos, mesesG),
      series: [
        { nome: 'Preço na época', classe: 'serie-1', valores: nominal.slice(iIni) },
        { nome: 'No salário de hoje', classe: 'serie-2', valores: equivalente.slice(iIni) },
      ],
      formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 2)),
      rotuloEixoX: rotuloMesNoEixo(5),
      tituloTooltip: (i) => f.mesCurto(mesesG[i]),
      extraTooltip: (i) => textoGoverno(ctx, mesesG[i]),
      descricao: `Preço médio de ${item.descricao}, na época e trazido para o salário mínimo de hoje.`,
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-combustiveis'), opcoes);

    registrarDownload('combustiveis', () => ({
      nome: `combustivel-${item.id}-mensal${cidade.dados?.series?.[item.serie] ? `-${cidade.dados.uf}` : ''}.csv`,
      cabecalhos: ['mes', 'preco na epoca (R$)', 'salario minimo (R$)', `equivalente no salario de ${meses[iUltPreco]} (R$)`],
      linhas: meses.map((m, i) => [m, nominal[i], s.salario_minimo[i], arred(equivalente[i], 2)]).filter((l) => l[1] != null),
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

function montarAvisos(ctx) {
  const lista = $('#lista-avisos');
  lista.replaceChildren();
  const avisos = [];

  for (const a of ctx.d.avisos ?? []) {
    if (a.tipo === 'valores_repetidos') {
      const afetaComparavel = ctx.grupos.find((g) => g.grupo === a.grupo)?.comparavel;
      avisos.push({
        titulo: `Receita Federal: ${a.rubrica} de ${f.mesCurto(a.mes)} repete os valores de ${f.mesCurto(a.igual_a)}`,
        texto: `Os valores são idênticos em todas as UFs, o que indica erro no arquivo da Receita. O site mostra o dado como publicado. ${afetaComparavel
          ? 'A série comparável é afetada.'
          : 'A série comparável não usa esta rubrica; o contador e a composição usam, e ficam subestimados nesse mês.'}`,
      });
    }
  }

  for (const k of ctx.d.coletas ?? []) {
    if (k.ultimo_status === 'erro') {
      const nome = nomeDaColeta(k.id);
      avisos.push({
        titulo: `A última coleta de ${nome} falhou`,
        texto: `Os números exibidos são da última coleta válida${k.ultima_ok ? `, de ${f.dataDeTimestamp(k.ultima_ok)}` : ''}. A coleta é refeita todos os dias.`,
      });
    }
  }

  if (!avisos.length) {
    el('p', null, 'Nenhum problema detectado na última verificação.', lista);
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
  const barra = $('.atalhos');
  if (!barra) return;
  const links = [...barra.querySelectorAll('a[href^="#"]')];
  const secoes = links.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);

  // Linha divisória só quando a barra está presa no topo.
  const sentinela = document.createElement('div');
  sentinela.setAttribute('aria-hidden', 'true');
  barra.before(sentinela);
  new IntersectionObserver(([e]) => barra.classList.toggle('presa', !e.isIntersecting)).observe(sentinela);

  const marcar = (id) => {
    links.forEach((a) => {
      const ativo = a.getAttribute('href') === `#${id}`;
      if (ativo) {
        a.setAttribute('aria-current', 'true');
        // Mantém o atalho ativo visível na barra, sem mexer na rolagem vertical.
        const esquerda = a.offsetLeft - barra.offsetLeft;
        if (esquerda < barra.scrollLeft || esquerda + a.offsetWidth > barra.scrollLeft + barra.clientWidth) {
          barra.scrollLeft = esquerda - 16;
        }
      } else {
        a.removeAttribute('aria-current');
      }
    });
  };

  // A seção ativa é a que ocupa a faixa logo abaixo da barra.
  const visiveis = new Set();
  const observador = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => (e.isIntersecting ? visiveis.add(e.target.id) : visiveis.delete(e.target.id)));
    const atual = secoes.find((s) => visiveis.has(s.id));
    marcar(atual ? atual.id : null);
  }, { rootMargin: '-80px 0px -55% 0px' });
  secoes.forEach((s) => observador.observe(s));
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
      montarComposicao, montarComposicaoEstados, montarGastos, montarContas, montarEstados, montarDolar, montarIR, montarAvisos, montarFontes];
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
    const caixa = $('#erro-carga');
    caixa.textContent = 'Não foi possível carregar os dados agora. Tente recarregar a página em instantes.';
    caixa.hidden = false;
  } finally {
    main.classList.remove('carregando');
    // Depois que tudo foi desenhado, refaz o salto para #seção, se houver.
    requestAnimationFrame(reposicionarNaSecao);
  }
}

iniciarNavegacao();
iniciar();
