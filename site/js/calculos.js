// Todas as regras de cálculo do Arrecadômetro Brasil.
//
// Este arquivo é a implementação da página de metodologia. As mesmas funções
// são aplicadas a todos os governos e partidos; nenhuma recebe exceção.
// Valores ausentes ficam ausentes: nada aqui estima ou interpola dado faltante.

// ---------------------------------------------------------------------------
// Meses
// ---------------------------------------------------------------------------

export function listaMeses(inicio, fim) {
  const [ai, mi] = inicio.split('-').map(Number);
  const [af, mf] = fim.split('-').map(Number);
  const meses = [];
  let a = ai;
  let m = mi;
  while (a < af || (a === af && m <= mf)) {
    meses.push(`${a}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return meses;
}

export const anoDe = (mes) => Number(mes.slice(0, 4));
export const mesDoAno = (mes) => Number(mes.slice(5, 7));

export function ultimoIndice(valores) {
  for (let i = valores.length - 1; i >= 0; i -= 1) if (valores[i] != null) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Inflação e valores reais
// ---------------------------------------------------------------------------

// Índice acumulado a partir das variações mensais (%). O índice do mês i já
// inclui a inflação do próprio mês. Se faltar uma variação, o índice para ali.
export function indiceAcumulado(variacoes) {
  const indice = new Array(variacoes.length).fill(null);
  let acumulado = 1;
  for (let i = 0; i < variacoes.length; i += 1) {
    if (variacoes[i] == null) break;
    acumulado *= 1 + variacoes[i] / 100;
    indice[i] = acumulado;
  }
  return indice;
}

// Converte valores nominais para reais do mês de referência
// (padrão: o último mês com índice). valor_real = valor * I(ref) / I(mês).
export function deflacionar(valores, indice, referencia = ultimoIndice(indice)) {
  const base = indice[referencia];
  return valores.map((v, i) => (v == null || indice[i] == null ? null : (v * base) / indice[i]));
}

// ---------------------------------------------------------------------------
// Atribuição de períodos a governos (mesma regra para todos)
// ---------------------------------------------------------------------------

// O mês pertence a quem exercia o cargo no dia 15.
export function governoDoMes(mandatos, mes) {
  const dia = `${mes}-15`;
  return mandatos.find((m) => m.inicio <= dia && (m.fim == null || m.fim >= dia)) ?? null;
}

// O ano pertence a quem governou mais meses dele. Em caso de empate, a quem
// estava no cargo em dezembro.
export function governoDoAno(mandatos, ano) {
  const contagem = new Map();
  for (let m = 1; m <= 12; m += 1) {
    const g = governoDoMes(mandatos, `${ano}-${String(m).padStart(2, '0')}`);
    if (g) contagem.set(g.id, (contagem.get(g.id) ?? 0) + 1);
  }
  if (contagem.size === 0) return null;
  const maximo = Math.max(...contagem.values());
  const empatados = [...contagem.entries()].filter(([, n]) => n === maximo).map(([id]) => id);
  if (empatados.length === 1) return mandatos.find((m) => m.id === empatados[0]);
  return governoDoMes(mandatos, `${ano}-12`);
}

// Primeiro ano atribuído a cada mandato, olhando o calendário inteiro (com ou
// sem dado), para que a opção "excluir o 1º ano" seja igual para todos.
export function primeiroAnoDeCadaMandato(mandatos, anoInicial, anoFinal) {
  const primeiro = new Map();
  for (let ano = anoInicial; ano <= anoFinal; ano += 1) {
    const g = governoDoAno(mandatos, ano);
    if (g && !primeiro.has(g.id)) primeiro.set(g.id, ano);
  }
  return primeiro;
}

// Faixas contínuas de meses de cada mandato, para o fundo dos gráficos.
export function faixasDeMandato(mandatos, meses) {
  const faixas = [];
  let atual = null;
  meses.forEach((mes, i) => {
    const g = governoDoMes(mandatos, mes);
    const id = g ? g.id : null;
    if (!atual || atual.id !== id) {
      atual = { id, rotulo: g ? g.rotulo : '', partido: g ? g.partido : '', inicio: i, fim: i };
      faixas.push(atual);
    } else {
      atual.fim = i;
    }
  });
  return faixas.filter((f) => f.id);
}

// Faixas por ano (para gráficos anuais).
export function faixasAnuais(mandatos, anos) {
  const faixas = [];
  let atual = null;
  anos.forEach((ano, i) => {
    const g = governoDoAno(mandatos, ano);
    const id = g ? g.id : null;
    if (!atual || atual.id !== id) {
      atual = { id, rotulo: g ? g.rotulo : '', partido: g ? g.partido : '', inicio: i, fim: i };
      faixas.push(atual);
    } else {
      atual.fim = i;
    }
  });
  return faixas.filter((f) => f.id);
}

// ---------------------------------------------------------------------------
// Agregação anual
// ---------------------------------------------------------------------------

// Agrupa uma série mensal por ano. Devolve, para cada ano, os índices dos
// meses com dado. A soma e a média usam só esses meses.
export function porAno(meses, valores, modo = 'soma') {
  const anos = new Map();
  meses.forEach((mes, i) => {
    const v = valores[i];
    if (v == null) return;
    const ano = anoDe(mes);
    if (!anos.has(ano)) anos.set(ano, { ano, soma: 0, meses: [] });
    const reg = anos.get(ano);
    reg.soma += v;
    reg.meses.push(mesDoAno(mes));
  });
  return [...anos.values()].map((r) => ({
    ano: r.ano,
    valor: modo === 'media' ? r.soma / r.meses.length : r.soma,
    meses: r.meses,
    parcial: r.meses.length < 12,
  }));
}

// Variação real de cada ano contra os MESMOS meses do ano anterior. Para anos
// completos, é a variação anual comum; para o ano em curso, compara o mesmo
// pedaço do calendário. modo: 'soma' (fluxos) ou 'media' (preços e salários).
export function variacaoMesmosMeses(meses, valores, modo = 'soma') {
  const porMes = new Map();
  meses.forEach((mes, i) => { if (valores[i] != null) porMes.set(mes, valores[i]); });
  const resultado = new Map();
  for (const linha of porAno(meses, valores, modo)) {
    let atual = 0;
    let anterior = 0;
    let completo = true;
    for (const m of linha.meses) {
      const mm = String(m).padStart(2, '0');
      const a = porMes.get(`${linha.ano}-${mm}`);
      const b = porMes.get(`${linha.ano - 1}-${mm}`);
      if (b == null) { completo = false; break; }
      atual += a;
      anterior += b;
    }
    resultado.set(linha.ano, completo && anterior !== 0 ? (atual / anterior - 1) * 100 : null);
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Arrecadação federal
// ---------------------------------------------------------------------------

// Soma mensal dos grupos (R$ milhões correntes). comparavel=true usa só a série
// comparável: sem receita previdenciária e sem receitas de outros órgãos.
export function arrecadacaoMensal(grupos, comparavel) {
  const usados = grupos.filter((g) => !comparavel || g.comparavel);
  const n = usados[0]?.valores.length ?? 0;
  const total = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    let soma = null;
    for (const g of usados) {
      const v = g.valores[i];
      if (v != null) soma = (soma ?? 0) + v;
    }
    total[i] = soma;
  }
  return total;
}

// Linhas anuais: arrecadação nominal e real (R$ milhões), carga em % do PIB
// (mesmos meses no numerador e no denominador) e variação real.
export function anualArrecadacao(meses, nominal, real, pib) {
  const linhasNominais = porAno(meses, nominal, 'soma');
  const reais = new Map(porAno(meses, real, 'soma').map((l) => [l.ano, l.valor]));
  const variacao = variacaoMesmosMeses(meses, real, 'soma');
  const pibPorMes = new Map(meses.map((m, i) => [m, pib[i]]));
  return linhasNominais.map((l) => {
    let somaPib = 0;
    let pibCompleto = true;
    for (const m of l.meses) {
      const p = pibPorMes.get(`${l.ano}-${String(m).padStart(2, '0')}`);
      if (p == null) { pibCompleto = false; break; }
      somaPib += p;
    }
    return {
      ano: l.ano,
      meses: l.meses.length,
      parcial: l.parcial,
      nominal: l.valor,
      real: reais.get(l.ano) ?? null,
      carga: pibCompleto && somaPib > 0 ? (l.valor / somaPib) * 100 : null,
      variacaoReal: variacao.get(l.ano) ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Resumo por governo ou por partido
// ---------------------------------------------------------------------------

// linhas: [{ano, parcial, ...métricas}]. Para cada mandato (ou partido), média
// simples das métricas nos anos atribuídos a ele que têm o dado.
export function resumoPorGoverno(linhas, mandatos, metricas, opcoes = {}) {
  const { excluirPrimeiroAno = false, agruparPorPartido = false } = opcoes;
  const anos = linhas.map((l) => l.ano);
  const primeiro = primeiroAnoDeCadaMandato(mandatos, Math.min(...anos, 1995), Math.max(...anos));
  const grupos = new Map();

  for (const g of mandatos) {
    const chave = agruparPorPartido ? g.partido : g.id;
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        chave,
        rotulo: agruparPorPartido ? g.partido : g.rotulo,
        partido: g.partido,
        mandatos: [],
        anos: [],
        parciais: [],
        excluidos: [],
        somas: Object.fromEntries(metricas.map((m) => [m, { soma: 0, n: 0 }])),
      });
    }
    grupos.get(chave).mandatos.push(g.rotulo);
  }

  for (const linha of linhas) {
    const g = governoDoAno(mandatos, linha.ano);
    if (!g) continue;
    const grupo = grupos.get(agruparPorPartido ? g.partido : g.id);
    if (excluirPrimeiroAno && primeiro.get(g.id) === linha.ano) {
      grupo.excluidos.push(linha.ano);
      continue;
    }
    grupo.anos.push(linha.ano);
    if (linha.parcial) grupo.parciais.push(linha.ano);
    for (const m of metricas) {
      if (linha[m] != null) {
        grupo.somas[m].soma += linha[m];
        grupo.somas[m].n += 1;
      }
    }
  }

  return [...grupos.values()].map((g) => ({
    chave: g.chave,
    rotulo: g.rotulo,
    partido: g.partido,
    mandatos: [...new Set(g.mandatos)],
    anos: g.anos,
    parciais: g.parciais,
    excluidos: g.excluidos,
    medias: Object.fromEntries(metricas.map((m) => [m, g.somas[m].n ? g.somas[m].soma / g.somas[m].n : null])),
    anosComDado: Object.fromEntries(metricas.map((m) => [m, g.somas[m].n])),
  }));
}

// ---------------------------------------------------------------------------
// Salário mínimo
// ---------------------------------------------------------------------------

export function salarioMinimo(meses, s) {
  const inpc = indiceAcumulado(s.inpc_var);
  const real = deflacionar(s.salario_minimo, inpc);
  const emDolar = s.salario_minimo.map((v, i) => (v == null || s.dolar_ptax[i] == null ? null : v / s.dolar_ptax[i]));
  const frenteNecessario = s.salario_minimo.map((v, i) =>
    (v == null || s.smn_dieese[i] == null ? null : (v / s.smn_dieese[i]) * 100));
  return { real, emDolar, frenteNecessario, referencia: meses[ultimoIndice(inpc)] };
}

export function anualSalario(meses, sm) {
  const real = porAno(meses, sm.real, 'media');
  const variacao = variacaoMesmosMeses(meses, sm.real, 'media');
  const dolar = new Map(porAno(meses, sm.emDolar, 'media').map((l) => [l.ano, l.valor]));
  const necessario = new Map(porAno(meses, sm.frenteNecessario, 'media').map((l) => [l.ano, l.valor]));
  return real.map((l) => ({
    ano: l.ano,
    parcial: l.parcial,
    real: l.valor,
    variacaoReal: variacao.get(l.ano) ?? null,
    emDolar: dolar.get(l.ano) ?? null,
    frenteNecessario: necessario.get(l.ano) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Câmbio
// ---------------------------------------------------------------------------

// Dólar a preços de hoje: dólar do mês * (inflação do Brasil desde então)
// / (inflação dos EUA desde então). Referência: último mês com os três dados.
export function dolarReal(ptax, ipcaIndice, cpiEua) {
  let base = -1;
  for (let i = ptax.length - 1; i >= 0; i -= 1) {
    if (ptax[i] != null && ipcaIndice[i] != null && cpiEua[i] != null) { base = i; break; }
  }
  if (base < 0) return { valores: ptax.map(() => null), base };
  const valores = ptax.map((p, i) => {
    if (p == null || ipcaIndice[i] == null || cpiEua[i] == null) return null;
    return p * (ipcaIndice[base] / ipcaIndice[i]) * (cpiEua[i] / cpiEua[base]);
  });
  return { valores, base };
}

// ---------------------------------------------------------------------------
// Tabela do Imposto de Renda
// ---------------------------------------------------------------------------

// Isenção vigente em cada mês (degrau), conforme a tabela publicada.
export function serieIsencao(meses, tabela, campo = 'isencao_efetiva') {
  return meses.map((mes) => {
    let vigente = null;
    for (const t of tabela) if (t.inicio <= mes) vigente = t;
    return vigente ? Number(vigente[campo]) : null;
  });
}

// Isenção da primeira tabela (jan/1996) corrigida pelo IPCA acumulado até o
// mês anterior a cada mês.
export function isencaoCorrigida(meses, ipcaIndice, tabela) {
  const primeira = tabela[0];
  const iBase = meses.indexOf(primeira.inicio);
  if (iBase < 1) return meses.map(() => null);
  const indiceBase = ipcaIndice[iBase - 1];
  return meses.map((_, i) => {
    if (i < iBase) return null;
    const idx = ipcaIndice[i - 1];
    return idx == null ? null : Number(primeira.isencao_efetiva) * (idx / indiceBase);
  });
}

// Para cada mandato: quanto a isenção foi corrigida e quanto foi o IPCA no
// mesmo período (do mês anterior à posse ao último mês no cargo ou com dado).
export function irPorMandato(meses, mandatos, isencao, ipcaIndice) {
  const iPrimeiro = isencao.findIndex((v) => v != null);
  return mandatos.map((g) => {
    const idxPosse = meses.findIndex((m) => governoDoMes(mandatos, m)?.id === g.id);
    let idxFim = -1;
    meses.forEach((m, i) => { if (governoDoMes(mandatos, m)?.id === g.id) idxFim = i; });
    if (idxPosse < 0 || idxFim < 0) return { id: g.id, rotulo: g.rotulo, partido: g.partido, correcao: null, ipca: null };
    const inicio = Math.max(idxPosse - 1, iPrimeiro);
    const fim = Math.min(idxFim, ultimoIndice(ipcaIndice));
    const ok = inicio >= 0 && fim > inicio && isencao[inicio] != null && isencao[fim] != null;
    return {
      id: g.id,
      rotulo: g.rotulo,
      partido: g.partido,
      de: meses[inicio],
      ate: meses[fim],
      correcao: ok ? (isencao[fim] / isencao[inicio] - 1) * 100 : null,
      ipca: ok ? (ipcaIndice[fim] / ipcaIndice[inicio] - 1) * 100 : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Poder de compra
// ---------------------------------------------------------------------------

// Quantas unidades do item o salário compra em cada mês.
// tamanho: quantas unidades de preço formam uma unidade do item
// (ex.: preço por kg e pacote de 5 kg => tamanho 5).
export function quantidadeComprada(salario, preco, tamanho = 1) {
  return salario.map((s, i) => {
    const p = preco[i];
    return s == null || p == null || p <= 0 ? null : s / (p * tamanho);
  });
}

// ---------------------------------------------------------------------------
// Comparar anos
// ---------------------------------------------------------------------------

// Valor de cada ano completo e dos últimos 12 meses com dado.
// tipo 'media':      média dos 12 meses.
// tipo 'acumulado':  variação acumulada a partir das variações mensais (%).
// tipo 'trimestral': média dos 4 trimestres (jan-mar, abr-jun, jul-set,
//                    out-dez), para séries de trimestre móvel gravadas no
//                    último mês de cada trimestre.
// tipo 'soma':       soma dos 12 meses (fluxos, como gasto ou juros).
// tipo 'fim':        valor do último mês do período (saldos, como a dívida,
//                    e séries já acumuladas em 12 meses).
// Um período só tem valor quando todos os meses (ou trimestres) têm dado.
export function valoresAnuais(meses, valores, tipo) {
  const pontos = (fim) => {
    if (tipo === 'trimestral') return [fim - 9, fim - 6, fim - 3, fim];
    // 'doze': a série já vem somada em 12 meses (déficit e juros do Banco
    // Central, impostos em 12 meses); o valor do ano é o de dezembro.
    if (tipo === 'fim' || tipo === 'doze') return [fim];
    return Array.from({ length: 12 }, (_, k) => fim - 11 + k);
  };
  const calcular = (fim) => {
    const idx = pontos(fim);
    if (idx[0] < 0) return null;
    const v = idx.map((i) => valores[i]);
    if (v.some((x) => x == null)) return null;
    if (tipo === 'acumulado') return (v.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 100;
    if (tipo === 'soma') return v.reduce((a, x) => a + x, 0);
    if (tipo === 'fim' || tipo === 'doze') return v[v.length - 1];
    return v.reduce((a, x) => a + x, 0) / v.length;
  };

  const anos = new Map();
  meses.forEach((mes, i) => {
    if (mesDoAno(mes) !== 12) return;
    const valor = calcular(i);
    if (valor != null) anos.set(anoDe(mes), valor);
  });
  const ultimo = ultimoIndice(valores);
  const valorHoje = ultimo < 0 ? null : calcular(ultimo);
  const hoje = valorHoje == null ? null : { valor: valorHoje, de: meses[ultimo - 11], ate: meses[ultimo] };
  return { anos, hoje };
}

// Soma móvel de 12 meses de a dividida pela de b, em %, quando os 12 meses
// das duas séries têm dado (impostos em 12 meses como parte do PIB).
export function razaoDozeMeses(a, b) {
  return a.map((_, i) => {
    if (i < 11) return null;
    let sa = 0;
    let sb = 0;
    for (let k = i - 11; k <= i; k += 1) {
      if (a[k] == null || b[k] == null) return null;
      sa += a[k];
      sb += b[k];
    }
    return sb > 0 ? (sa / sb) * 100 : null;
  });
}

// Soma de `a` dividida pela soma de `b` nos mesmos meses, em %. Para fluxos
// de um período inteiro (déficit, juros, impostos) sobre o que o país
// produziu nele. Exige todos os meses.
export function razaoNoPeriodo(a, b, indices) {
  if (!indices.length) return null;
  let sa = 0;
  let sb = 0;
  for (const i of indices) {
    if (a[i] == null || b[i] == null) return null;
    sa += a[i];
    sb += b[i];
  }
  return sb > 0 ? (sa / sb) * 100 : null;
}

// Índices dos meses de um mandato (o mês é de quem governava no dia 15).
export function mesesDoMandato(mandatos, meses, id) {
  return meses.map((mes, i) => (governoDoMes(mandatos, mes)?.id === id ? i : -1)).filter((i) => i >= 0);
}

// Valor de um período (os meses de um mandato), com a mesma regra dos anos:
// 'media' média dos meses; 'trimestral' média dos trimestres que fecham no
// período (março, junho, setembro e dezembro); 'acumulado' média por ano da
// variação acumulada; 'fim' o último mês; 'doze' média dos valores de
// dezembro (anos completos) do período. "cobertura" é a parte mínima dos
// meses que precisa ter dado (1 = todos); 'fim' sempre exige o último mês.
export function valorDoPeriodo(meses, valores, tipo, indices, cobertura = 1) {
  if (!indices.length) return null;
  let pontos = indices;
  if (tipo === 'trimestral') pontos = indices.filter((i) => mesDoAno(meses[i]) % 3 === 0);
  if (tipo === 'doze') pontos = indices.filter((i) => mesDoAno(meses[i]) === 12);
  if (tipo === 'fim') pontos = [indices[indices.length - 1]];
  const v = pontos.map((i) => valores[i]).filter((x) => x != null);
  if (!v.length || v.length < Math.ceil(pontos.length * (tipo === 'fim' ? 1 : cobertura))) return null;
  if (tipo === 'acumulado') return (v.reduce((a, x) => a * (1 + x / 100), 1) ** (12 / v.length) - 1) * 100;
  if (tipo === 'soma') return v.reduce((a, x) => a + x, 0);
  if (tipo === 'fim') return v[0];
  return v.reduce((a, x) => a + x, 0) / v.length;
}

// Posição de hoje entre os anos completos: em quantos anos hoje está melhor.
// "bom": melhor que em pelo menos dois terços dos anos; "ruim": em no máximo
// um terço; "medio" no meio.
export function posicaoNaHistoria(hoje, anos, maiorMelhor) {
  const lista = [...anos.values()];
  if (hoje == null || lista.length < 3) return null;
  const vencidos = lista.filter((v) => comparar(hoje, v, maiorMelhor) === 1).length;
  const fracao = vencidos / lista.length;
  return { vencidos, total: lista.length, nivel: fracao >= 2 / 3 ? 'bom' : fracao <= 1 / 3 ? 'ruim' : 'medio' };
}

// Mesmo período em dois governos: do primeiro mês do atual até o índice
// `ate`, e os mesmos meses de mandato do anterior (o 1º com o 1º, o 2º com o
// 2º...). Null se o anterior não tiver tantos meses.
export function mesmoPeriodo(mandatos, meses, atual, anterior, ate) {
  const a = mesesDoMandato(mandatos, meses, atual).filter((i) => i <= ate);
  const b = mesesDoMandato(mandatos, meses, anterior).slice(0, a.length);
  return a.length && b.length === a.length ? { atual: a, anterior: b } : null;
}

// Compara dois valores. 1: o primeiro é mais favorável; -1: menos favorável;
// 0: diferença menor que 1% do segundo (praticamente igual).
export function comparar(a, b, maiorMelhor) {
  if (a == null || b == null) return null;
  const base = Math.abs(b) > 0 ? Math.abs(b) : 1;
  if (Math.abs(a - b) / base < 0.01) return 0;
  return (a > b) === maiorMelhor ? 1 : -1;
}

// Anos do mais para o menos favorável. Empate no valor: o ano mais antigo antes.
export function rankingDeAnos(anos, maiorMelhor) {
  return [...anos.entries()]
    .map(([ano, valor]) => ({ ano, valor }))
    .sort((a, b) => (maiorMelhor ? b.valor - a.valor : a.valor - b.valor) || a.ano - b.ano);
}

// ---------------------------------------------------------------------------
// Orçamento da família
// ---------------------------------------------------------------------------

// Soma as despesas e calcula a parte da renda de cada uma e o que sobra.
// Despesa sem valor (null) não entra na soma.
export function orcamento(renda, despesas) {
  const parte = (v) => (renda > 0 && v != null ? (v / renda) * 100 : null);
  const itens = despesas.map((d) => ({ ...d, parte: parte(d.valor) }));
  const total = itens.reduce((a, d) => a + (d.valor ?? 0), 0);
  return { itens, total, parteTotal: parte(total), sobra: renda - total };
}

// Preço de cada mês trazido para o salário de hoje: quanto ele custaria se
// pesasse no salário mínimo de hoje o mesmo que pesava no salário da época.
// preco × salário do mês de referência ÷ salário do mês.
export function noSalarioDeHoje(precos, salario, iReferencia) {
  const base = salario[iReferencia];
  return precos.map((p, i) => (p == null || salario[i] == null || salario[i] <= 0 || base == null
    ? null : (p * base) / salario[i]));
}

// Quanto os preços subiram desde um mês-base: produto de (1 + variação) dos
// meses seguintes até o último publicado. Um mês sem dado no meio interrompe a
// conta (devolve null), para não estimar o que a fonte não publicou.
export function fatorDesde(meses, variacoes, mesBase) {
  const iBase = meses.indexOf(mesBase);
  const iUlt = ultimoIndice(variacoes ?? []);
  if (iBase < 0 || iUlt <= iBase) return null;
  let fator = 1;
  for (let i = iBase + 1; i <= iUlt; i += 1) {
    if (variacoes[i] == null) return null;
    fator *= 1 + variacoes[i] / 100;
  }
  return { fator, ate: meses[iUlt] };
}

// Pessoas da casa em "adultos equivalentes", pela regra do DIEESE: duas
// crianças consomem como um adulto.
export const unidadesDeConsumo = (adultos, criancas) => adultos + criancas / 2;

// Faixa de renda da POF para uma renda em salários mínimos. As faixas da POF
// estão em reais de 15/01/2018; divididas pelo salário mínimo da época, viram
// múltiplos do salário mínimo (até 2, até 3, até 6...).
export function faixaDaPof(classes, salariosMinimos, salarioMinimoReferencia) {
  return classes.find((cl) => cl.renda_ate == null || salariosMinimos <= cl.renda_ate / salarioMinimoReferencia + 1e-9)
    ?? classes[classes.length - 1];
}

// Fator para trazer valores anuais para dinheiro de hoje: índice do último mês
// com inflação ÷ média do índice nos 12 meses do ano. Ano sem os 12 meses
// fica sem fator (null).
export function fatoresAnuais(meses, indice, anos) {
  const ref = indice[ultimoIndice(indice)];
  return anos.map((ano) => {
    const valores = meses.map((m, i) => (anoDe(m) === ano ? indice[i] : null)).filter((v) => v != null);
    return valores.length === 12 ? ref / (valores.reduce((a, v) => a + v, 0) / 12) : null;
  });
}

// Soma, ano a ano, as contas de um grupo. Conta sem valor num ano conta como
// zero só se alguma outra conta do grupo tiver valor naquele ano.
export function somarContas(contas, codigos, nAnos) {
  const escolhidas = contas.filter((c) => codigos.includes(c.conta));
  return Array.from({ length: nAnos }, (_, k) => {
    const valores = escolhidas.map((c) => c.valores[k]).filter((v) => v != null);
    return valores.length ? valores.reduce((a, v) => a + v, 0) : null;
  });
}

// Último valor publicado de uma série mensal, com o mês.
export function ultimoValor(meses, valores) {
  const i = ultimoIndice(valores ?? []);
  return i < 0 ? null : { valor: valores[i], mes: meses[i] };
}

// ---------------------------------------------------------------------------
// Arrecadômetro (estimativa em tempo real)
// ---------------------------------------------------------------------------

const BRASILIA = -3 * 3600 * 1000; // UTC-3, sem horário de verão desde 2019

function inicioDoMesBrasilia(mes) {
  const [a, m] = mes.split('-').map(Number);
  return Date.UTC(a, m - 1, 1) - BRASILIA;
}

function mesSeguinte(mes) {
  const [a, m] = mes.split('-').map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
}

// confirmado: soma dos meses do ano corrente já publicados pela Receita.
// estimado: média por segundo dos últimos 12 meses publicados, aplicada do
// início do mês seguinte ao último publicado até agora.
export function arrecadometro(meses, totalMilhoes, agoraMs = Date.now()) {
  const iUlt = ultimoIndice(totalMilhoes);
  if (iUlt < 11) return null;
  const ultimoMes = meses[iUlt];
  const anoAtual = new Date(agoraMs + BRASILIA).getUTCFullYear();

  let confirmado = 0;
  const mesesConfirmados = [];
  meses.forEach((mes, i) => {
    if (anoDe(mes) === anoAtual && totalMilhoes[i] != null) {
      confirmado += totalMilhoes[i] * 1e6;
      mesesConfirmados.push(mes);
    }
  });

  let somaDoze = 0;
  for (let i = iUlt - 11; i <= iUlt; i += 1) somaDoze += totalMilhoes[i] * 1e6;
  const segundosDoze = (inicioDoMesBrasilia(mesSeguinte(ultimoMes)) - inicioDoMesBrasilia(meses[iUlt - 11])) / 1000;
  const porSegundo = somaDoze / segundosDoze;

  const inicioAno = Date.UTC(anoAtual, 0, 1) - BRASILIA;
  const inicioEstimativa = Math.max(inicioDoMesBrasilia(mesSeguinte(ultimoMes)), inicioAno);

  return {
    anoAtual,
    ultimoMes,
    mesesConfirmados,
    confirmado,
    porSegundo,
    somaDoze,
    inicioEstimativa,
    estimadoEm: (ms) => Math.max(0, (ms - inicioEstimativa) / 1000) * porSegundo,
  };
}
