import * as c from './calculos.js';
import * as f from './formato.js';
import * as t from './textos.js';
import { criarGrafico, preencherTabela, baixarCSV } from './graficos.js';
import { carregarPainel } from './dados.js';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const campo = (nome) => document.querySelectorAll(`[data-campo="${nome}"]`);
const definir = (nome, texto) => campo(nome).forEach((e) => { e.textContent = texto; });

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
    definir('arrec-resumo', resumo);
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
    definir('composicao-resumo',
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

// ---------------------------------------------------------------------------
// Salário mínimo
// ---------------------------------------------------------------------------

function montarSalario(ctx) {
  const { meses, s, mandatos } = ctx;
  const sm = c.salarioMinimo(meses, s);
  const anual = c.anualSalario(meses, sm);
  const faixas = c.faixasDeMandato(mandatos, meses);
  const iUlt = c.ultimoIndice(sm.real);
  const iDolar = c.ultimoIndice(sm.emDolar);
  const iNec = c.ultimoIndice(sm.frenteNecessario);

  const iPrimeiro = sm.real.findIndex((v) => v != null);
  const razaoReal = sm.real[iUlt] / sm.real[iPrimeiro];
  const ganho = razaoReal >= 1.5
    ? `compra ${f.numero(razaoReal, 1)} vezes o que comprava em ${f.mesLongo(meses[iPrimeiro])}`
    : `compra ${t.variacao((razaoReal - 1) * 100, 0)} do que em ${f.mesLongo(meses[iPrimeiro])}`;
  let resumoSm = `Em ${f.mesLongo(meses[iUlt])}, o salário mínimo é de ${f.moeda(s.salario_minimo[iUlt], 0)}. Descontada a inflação, ele ${ganho}.`;
  if (s.smn_dieese[iNec] != null) {
    resumoSm += ` Pelas contas do DIEESE, uma família de quatro pessoas precisaria de ${f.moeda(s.smn_dieese[iNec], 0)} por mês para viver com o básico. `
      + `Isso dá ${f.numero(s.smn_dieese[iNec] / s.salario_minimo[iNec], 1)} salários mínimos.`;
  }
  definir('sm-resumo', resumoSm);

  const numeros = $('#numeros-salario');
  numeros.replaceChildren();
  const item = (rotulo, valor) => {
    const div = el('div', null, null, numeros);
    el('dt', null, rotulo, div);
    el('dd', null, valor, div);
  };
  item(`Salário mínimo em ${f.mesCurto(meses[iUlt])}`, f.moeda(s.salario_minimo[iUlt], 0));
  item('Salário de jan/1995 em dinheiro de hoje', f.moeda(sm.real[0], 0));
  item(`Em dólar (${f.mesCurto(meses[iDolar])})`, f.dolar(sm.emDolar[iDolar], 0));
  item(`Parte do salário necessário, segundo o DIEESE (${f.mesCurto(meses[iNec])})`, f.porcentagem(sm.frenteNecessario[iNec], 0));

  const reguas = {
    real: {
      nome: 'Salário mínimo em dinheiro de hoje',
      valores: sm.real,
      formato: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 0)),
      explicacao: `Quanto o salário de cada época valeria hoje, corrigido pela inflação até ${f.mesLongo(sm.referencia)}. Quanto mais alto, mais ele comprava.`,
    },
    dolar: {
      nome: 'Salário mínimo em dólares',
      valores: sm.emDolar,
      formato: (v, eixo) => (eixo ? f.numero(v, 0) : f.dolar(v, 0)),
      explicacao: 'Quantos dólares o salário de cada mês comprava, pela cotação daquele mês.',
    },
    necessario: {
      nome: 'Salário mínimo como parte do necessário (DIEESE)',
      valores: sm.frenteNecessario,
      formato: (v) => f.porcentagem(v, 0),
      explicacao: 'O DIEESE calcula todo mês quanto uma família de quatro pessoas precisa para viver com o básico. A linha mostra quanto o salário mínimo cobre desse valor: 100% seria cobrir tudo.',
    },
  };

  const configurar = (chave) => {
    const r = reguas[chave];
    return {
      tipo: 'linhas',
      rotulos: meses,
      faixas,
      series: [{ nome: r.nome, classe: 'serie-1', valores: r.valores }],
      formatoY: r.formato,
      rotuloEixoX: rotuloMesNoEixo(5),
      tituloTooltip: (i) => f.mesCurto(meses[i]),
      extraTooltip: (i) => textoGoverno(ctx, meses[i]),
      descricao: r.nome,
      incluirZero: true,
    };
  };

  const grafico = criarGrafico($('#grafico-salario'), configurar('real'));
  definir('sm-explicacao', reguas.real.explicacao);
  document.querySelectorAll('input[name="sm-regua"]').forEach((r) => r.addEventListener('change', () => {
    const chave = valorRadio('sm-regua');
    grafico.atualizar(configurar(chave));
    definir('sm-explicacao', reguas[chave].explicacao);
  }));

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
  if (desvio >= 0.5) efeito = ' Isso encarece produtos importados e viagens ao exterior.';
  else if (desvio <= -0.5) efeito = ' Isso barateia produtos importados e viagens ao exterior.';
  definir('dolar-resumo',
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
  definir('ir-resumo', resumoIr);

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

function preencherAnos(select, meses, candidatos, escolhido) {
  select.replaceChildren();
  candidatos.forEach((i) => {
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
  let escolhido = null;

  const desenhar = () => {
    const q = c.quantidadeComprada(s.salario_minimo, s[item.serie], item.tamanho);
    const { iUlt, candidatos } = mesesParaComparar(meses, q);
    if (iUlt < 0 || !candidatos.length) return;
    if (!candidatos.includes(escolhido)) escolhido = candidatos[0];
    preencherAnos($('#compras-ano'), meses, candidatos, escolhido);

    const iA = escolhido;
    const qA = q[iA];
    const qB = q[iUlt];
    const anoA = c.anoDe(meses[iA]);
    const comp = t.compraMaisOuMenos(qB, qA);
    let fecho = '';
    if (comp === 'a mesma quantidade') fecho = ` Hoje ele compra a mesma quantidade que em ${anoA}.`;
    else if (comp) fecho = ` Hoje ele compra ${comp} do que em ${anoA}.`;
    definir('compras-resumo',
      `Com um salário mínimo (${f.moeda(s.salario_minimo[iUlt], 0)}), em ${f.mesLongo(meses[iUlt])} dá para comprar ${t.quantidadeCom(qB, item.unidade, item.plural)}. `
      + `Em ${f.mesLongo(meses[iA])}, com o salário da época (${f.moeda(s.salario_minimo[iA], 0)}), dava para comprar ${t.quantidade(qA)}.${fecho}`);

    const numeros = $('#compras-numeros');
    numeros.replaceChildren();
    const precoItem = (i) => s[item.serie][i] * item.tamanho;
    const parte = (i) => (precoItem(i) / s.salario_minimo[i]) * 100;
    itemNumero(numeros, `Em ${f.mesCurto(meses[iA])}`, t.quantidade(qA), item.plural);
    itemNumero(numeros, `Em ${f.mesCurto(meses[iUlt])}`, t.quantidade(qB), item.plural);
    itemNumero(numeros, `${maiuscula(item.singular)} custa hoje`, f.moeda(precoItem(iUlt), 2),
      `${t.parteDoSalario(parte(iUlt))} (em ${anoA}, ${f.porcentagem(parte(iA), parte(iA) < 10 ? 1 : 0)})`);

    definir('compras-nota-fonte', item.fonte === 'dieese'
      ? `Os preços são a média de ${capitais.length} capitais que o DIEESE pesquisa todo mês desde 1995 (${capitais.join(', ')}). Na sua cidade o preço pode ser diferente. A cesta básica é o conjunto de 13 alimentos que, pela lei, sustenta uma pessoa adulta por um mês.`
      : 'O preço é a média dos postos pesquisados pela ANP em todo o Brasil. Na sua cidade o preço pode ser diferente.');

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
      nome: `salario-minimo-compra-${item.id}.csv`,
      cabecalhos: ['mes', 'salario minimo (R$)', `preco de ${item.singular} (R$)`, `quantidade (${item.plural})`],
      linhas: meses.map((m, i) => [m, s.salario_minimo[i], s[item.serie][i] == null ? null : arred(precoItem(i), 2), arred(q[i], 2)])
        .filter((l) => l[2] != null),
    }));
  };

  montarEscolhas($('#compras-itens'), 'compras-item', itens, (novo) => { item = novo; escolhido = null; desenhar(); });
  $('#compras-ano').addEventListener('change', (ev) => { escolhido = Number(ev.target.value); desenhar(); });
  desenhar();
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

function montarCombustiveis(ctx) {
  const { meses, s, ipca, mandatos } = ctx;
  const itens = ITENS_COMBUSTIVEL.filter((it) => Array.isArray(s[it.serie]));
  if (!itens.length) { $('#combustiveis').hidden = true; return; }
  let grafico = null;
  let item = itens[0];
  let escolhido = null;

  const desenhar = () => {
    const nominal = s[item.serie];
    const real = c.deflacionar(nominal, ipca);
    const { iUlt, candidatos } = mesesParaComparar(meses, real);
    if (iUlt < 0 || !candidatos.length) return;
    if (!candidatos.includes(escolhido)) escolhido = candidatos[0];
    preencherAnos($('#combustiveis-ano'), meses, candidatos, escolhido);

    const iA = escolhido;
    const anoA = c.anoDe(meses[iA]);
    const comparado = t.maisCaroOuBarato(real[iUlt], real[iA], item.feminino);
    const custo = (i) => (item.litro ? nominal[i] * TANQUE_LITROS : nominal[i]);
    const parte = (i) => (custo(i) / s.salario_minimo[i]) * 100;
    const casas = item.litro ? 0 : 1;

    const conclusao = comparado
      ? `Ou seja, descontada a inflação, ${item.sujeito} está ${comparado} do que em ${anoA}.`
      : `Ou seja, descontada a inflação, ${item.sujeito} custa praticamente o mesmo que em ${anoA}.`;
    const textoCusto = item.litro
      ? `Encher um tanque de ${TANQUE_LITROS} litros custa ${f.moeda(custo(iUlt), 0)}, ou ${t.parteDoSalario(parte(iUlt))} (em ${anoA}, ${f.porcentagem(parte(iA), 0)}).`
      : `Um botijão custa ${t.parteDoSalario(parte(iUlt))} (em ${anoA}, ${f.porcentagem(parte(iA), 1)}).`;
    // Preço e peso no salário podem andar em sentidos opostos; quando isso
    // acontece, a frase explica o motivo para não parecer contradição.
    let ponte = '';
    const pesoMudou = Math.abs(parte(iUlt) / parte(iA) - 1) >= 0.05;
    const subiu = real[iUlt] > real[iA];
    if (comparado && pesoMudou && subiu && parte(iUlt) < parte(iA)) {
      ponte = ` Mesmo ${item.feminino ? 'mais cara' : 'mais caro'}, ${item.sujeito} pesa menos para quem ganha um salário mínimo, porque o salário subiu mais do que o preço.`;
    } else if (comparado && pesoMudou && !subiu && parte(iUlt) > parte(iA)) {
      ponte = ` Mesmo ${item.feminino ? 'mais barata' : 'mais barato'}, ${item.sujeito} pesa mais para quem ganha um salário mínimo, porque o salário perdeu mais valor do que o preço.`;
    }
    definir('combustiveis-resumo',
      `Em ${f.mesLongo(meses[iUlt])}, ${item.descricao} custa em média ${f.moeda(nominal[iUlt], 2)} no país. `
      + `Em ${f.mesLongo(meses[iA])}, custava ${f.moeda(nominal[iA], 2)}. Como os preços em geral subiram desde então, esse valor equivale a ${f.moeda(real[iA], 2)} hoje. `
      + `${conclusao} ${textoCusto}${ponte}`);

    const numeros = $('#combustiveis-numeros');
    numeros.replaceChildren();
    itemNumero(numeros, `Preço em ${f.mesCurto(meses[iUlt])}`, f.moeda(nominal[iUlt], 2));
    itemNumero(numeros, `Preço de ${f.mesCurto(meses[iA])} em dinheiro de hoje`, f.moeda(real[iA], 2), `Na época: ${f.moeda(nominal[iA], 2)}`);
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
        { nome: 'Em dinheiro de hoje', classe: 'serie-2', valores: real.slice(iIni) },
      ],
      formatoY: (v, eixo) => (eixo ? f.numero(v, 0) : f.moeda(v, 2)),
      rotuloEixoX: rotuloMesNoEixo(5),
      tituloTooltip: (i) => f.mesCurto(mesesG[i]),
      extraTooltip: (i) => textoGoverno(ctx, mesesG[i]),
      descricao: `Preço médio de ${item.descricao}, na época e em dinheiro de hoje.`,
      incluirZero: true,
    };
    if (grafico) grafico.atualizar(opcoes); else grafico = criarGrafico($('#grafico-combustiveis'), opcoes);

    registrarDownload('combustiveis', () => ({
      nome: `combustivel-${item.id}-mensal.csv`,
      cabecalhos: ['mes', 'preco na epoca (R$)', `em dinheiro de ${ctx.referencia} (R$)`],
      linhas: meses.map((m, i) => [m, nominal[i], arred(real[i], 2)]).filter((l) => l[1] != null),
    }));
  };

  montarEscolhas($('#combustiveis-itens'), 'combustivel-item', itens, (novo) => { item = novo; escolhido = null; desenhar(); });
  $('#combustiveis-ano').addEventListener('change', (ev) => { escolhido = Number(ev.target.value); desenhar(); });
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
    const etapas = [iniciarContador, montarCompras, montarCombustiveis, montarSalario, montarArrecadacao,
      montarComposicao, montarDolar, montarIR, montarAvisos, montarFontes];
    for (const etapa of etapas) {
      try {
        etapa(ctx);
      } catch (erro) {
        console.error(`Falha em ${etapa.name}:`, erro);
      }
    }
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
