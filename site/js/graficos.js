// Gráficos em SVG, sem bibliotecas externas. Responsivos, com leitura por
// toque, mouse e teclado. Todo texto vindo dos dados entra via textContent.

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, atributos = {}, pai = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(atributos)) e.setAttribute(k, String(v));
  if (pai) pai.appendChild(e);
  return e;
}

function htmlEl(tag, classe, texto, pai) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto;
  if (pai) pai.appendChild(e);
  return e;
}

function ticksLegiveis(min, max, alvo) {
  const intervalo = max - min || Math.abs(max) || 1;
  const bruto = intervalo / alvo;
  const magnitude = 10 ** Math.floor(Math.log10(bruto));
  const n = bruto / magnitude;
  const passo = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * magnitude;
  const inicio = Math.floor(min / passo) * passo;
  const fim = Math.ceil(max / passo) * passo;
  const ticks = [];
  for (let v = inicio; v <= fim + passo / 2; v += passo) ticks.push(Number(v.toPrecision(12)));
  return { ticks, min: inicio, max: fim };
}

// Mede o texto com a mesma fonte do gráfico, para posicionar rótulos sem cortes.
let medidor = null;
function larguraTexto(texto, px = 12) {
  if (!medidor) medidor = document.createElement('canvas').getContext('2d');
  if (!medidor) return texto.length * px * 0.6;
  medidor.font = `${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  return medidor.measureText(texto).width;
}

// opcoes:
//   tipo: 'linhas' | 'colunas'
//   rotulos: valores do eixo X (meses 'AAAA-MM' ou anos)
//   series: [{ nome, valores, classe ('serie-1'|'serie-2'), degrau, parciais: Set(i) }]
//   faixas: [{ inicio, fim, rotulo }] (índices em rotulos)
//   formatoY(v), rotuloEixoX(rotulo, i) -> texto | null, tituloTooltip(i), extraTooltip(i)
//   unidade: texto curto mostrado acima do gráfico ("R$ por litro", "% do PIB")
//   descricao: texto para leitores de tela
//   incluirZero: boolean
export function criarGrafico(container, opcoes) {
  let atual = { incluirZero: true, ...opcoes };
  let quadro = null;
  container.classList.add('grafico');
  container.replaceChildren();

  const unidade = htmlEl('p', 'grafico-unidade', null, container);
  const legenda = htmlEl('div', 'grafico-legenda', null, container);
  const area = htmlEl('div', 'grafico-area', null, container);
  const dica = htmlEl('div', 'grafico-dica', null, container);
  dica.hidden = true;

  function montarLegenda() {
    unidade.textContent = atual.unidade ? `Valores em ${atual.unidade}` : '';
    unidade.hidden = !atual.unidade;
    legenda.replaceChildren();
    legenda.hidden = atual.series.length < 2;
    for (const s of atual.series) {
      const item = htmlEl('span', 'legenda-item', null, legenda);
      htmlEl('span', `legenda-chave ${atual.tipo === 'colunas' ? 'chave-bloco' : 'chave-linha'} ${s.classe}`, null, item);
      htmlEl('span', null, s.nome, item);
    }
  }

  function desenhar() {
    // Largura real do espaço: com piso maior que a tela, o navegador encolhia o
    // desenho e os rótulos ficavam com 9 a 10 px.
    const largura = Math.max(240, Math.floor(area.clientWidth || 320));
    const altura = largura < 520 ? 240 : 300;
    const { series, rotulos, faixas = [], tipo } = atual;
    const n = rotulos.length;

    const todos = series.flatMap((s) => s.valores.filter((v) => v != null && Number.isFinite(v)));
    let minimo = todos.length ? Math.min(...todos) : 0;
    let maximo = todos.length ? Math.max(...todos) : 1;
    if (atual.incluirZero) { minimo = Math.min(0, minimo); maximo = Math.max(0, maximo); }
    const alvoTicks = altura < 260 ? 4 : 5;
    const escala = ticksLegiveis(minimo, maximo, alvoTicks);
    const rotulosY = escala.ticks.map((t) => atual.formatoY(t, true));
    const margem = {
      topo: 10,
      direita: 12,
      base: 26,
      esquerda: Math.ceil(Math.max(...rotulosY.map((t) => larguraTexto(t, 12)))) + 12,
    };
    const lp = largura - margem.esquerda - margem.direita;
    const banda = tipo === 'colunas' ? lp / n : (n > 1 ? lp / (n - 1) : lp);
    const x = (i) => (tipo === 'colunas' ? margem.esquerda + banda * (i + 0.5) : margem.esquerda + banda * i);
    const borda = (i) => {
      if (tipo === 'colunas') return margem.esquerda + banda * i;
      return Math.min(Math.max(margem.esquerda + banda * (i - 0.5), margem.esquerda), margem.esquerda + lp);
    };

    // Faixas de mandato: o fundo alterna a cada mandato.
    const bandas = faixas.map((fx) => ({ fx, x0: borda(fx.inicio), x1: borda(fx.fim + 1) }));

    // Rótulos: uma linha quando todos cabem na própria faixa; senão, duas
    // linhas alternadas, sem sobreposição. Se ainda assim algum não couber
    // (telas estreitas), mandatos seguidos da mesma pessoa ganham um rótulo
    // só ("Lula 1" e "Lula 2" viram "Lula"); o detalhe continua na dica.
    const posicionar = (grupos) => {
      const rotulos = grupos.map((g) => ({ ...g, centro: (g.x0 + g.x1) / 2, largura: larguraTexto(g.rotulo, 11) }));
      const umaLinha = rotulos.every((r) => r.largura + 4 <= r.x1 - r.x0);
      const ocupado = [-Infinity, -Infinity];
      rotulos.forEach((r, k) => {
        const x = umaLinha
          ? r.centro
          : Math.min(Math.max(r.centro, margem.esquerda + r.largura / 2), margem.esquerda + lp - r.largura / 2);
        const preferida = umaLinha ? 0 : k % 2;
        const tentativas = umaLinha ? [0] : [preferida, 1 - preferida];
        const linha = tentativas.find((l) => x - r.largura / 2 >= ocupado[l] + 4);
        r.x = x;
        r.visivel = linha !== undefined;
        r.linha = linha ?? preferida;
        if (r.visivel) ocupado[linha] = x + r.largura / 2;
      });
      return { rotulos, umaLinha, ocultos: rotulos.filter((r) => !r.visivel).length };
    };
    let posicao = posicionar(bandas.map((b) => ({ rotulo: b.fx.rotulo, x0: b.x0, x1: b.x1 })));
    if (posicao.ocultos || !posicao.umaLinha) {
      const pessoa = (rotulo) => rotulo.replace(/\s+\d+$/, '');
      const juntos = [];
      bandas.forEach((b) => {
        const ultimo = juntos[juntos.length - 1];
        if (ultimo && ultimo.rotulo === pessoa(b.fx.rotulo)) ultimo.x1 = b.x1;
        else juntos.push({ rotulo: pessoa(b.fx.rotulo), x0: b.x0, x1: b.x1 });
      });
      // Com duas linhas de rótulos a leitura já fica apertada: menos rótulos
      // ajudam, desde que nenhum a mais fique escondido.
      const alternativa = posicionar(juntos);
      if (juntos.length < bandas.length && alternativa.ocultos <= posicao.ocultos) posicao = alternativa;
    }
    const linhasRotulo = faixas.length ? (posicao.umaLinha ? 1 : 2) : 0;
    if (linhasRotulo) margem.topo = 8 + linhasRotulo * 14;
    const ap = altura - margem.topo - margem.base;
    const y = (v) => margem.topo + ap - ((v - escala.min) / (escala.max - escala.min || 1)) * ap;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${largura} ${altura}`, width: largura, height: altura,
      role: 'img', 'aria-label': atual.descricao || '', tabindex: 0, class: 'grafico-svg',
    });

    // Faixas de mandato (fundo neutro alternado, sem cores de partido).
    bandas.forEach((r, k) => {
      svgEl('rect', {
        x: r.x0, y: margem.topo, width: Math.max(0, r.x1 - r.x0), height: ap,
        class: `faixa ${k % 2 ? 'faixa-b' : 'faixa-a'}`,
      }, svg);
    });
    posicao.rotulos.filter((r) => r.visivel).forEach((r) => {
      const t = svgEl('text', {
        x: r.x, y: 4 + 11 + r.linha * 14, class: 'faixa-rotulo', 'text-anchor': 'middle',
      }, svg);
      t.textContent = r.rotulo;
    });

    // Grade e eixo Y.
    escala.ticks.forEach((t, k) => {
      const yy = Math.round(y(t)) + 0.5;
      svgEl('line', { x1: margem.esquerda, x2: margem.esquerda + lp, y1: yy, y2: yy, class: t === 0 ? 'eixo-base' : 'grade' }, svg);
      const r = svgEl('text', { x: margem.esquerda - 6, y: yy + 4, class: 'eixo-rotulo', 'text-anchor': 'end' }, svg);
      r.textContent = rotulosY[k];
    });

    // Eixo X com rótulos espaçados para não colidir.
    let ultimoX = -Infinity;
    rotulos.forEach((rot, i) => {
      const texto = atual.rotuloEixoX(rot, i);
      if (!texto) return;
      const meia = larguraTexto(texto, 12) / 2;
      // Rótulo das pontas encosta na borda em vez de sumir.
      const xx = Math.min(Math.max(x(i), meia + 2), largura - 2 - meia);
      if (xx - meia < ultimoX + 8) return;
      const t = svgEl('text', { x: xx, y: altura - 8, class: 'eixo-rotulo', 'text-anchor': 'middle' }, svg);
      t.textContent = texto;
      ultimoX = xx + meia;
    });

    // Séries.
    const marcas = [];
    series.forEach((s) => {
      if (tipo === 'colunas') {
        const larg = Math.max(2, Math.min(24, banda * 0.62));
        const grupo = svgEl('g', { class: s.classe }, svg);
        const y0 = y(Math.max(0, escala.min));
        s.valores.forEach((v, i) => {
          if (v == null) return;
          const x0 = x(i) - larg / 2;
          const yv = y(v);
          const topo = Math.min(yv, y0);
          const alt = Math.abs(y0 - yv);
          const r = Math.min(4, larg / 2, alt);
          const d = v >= 0
            ? `M${x0},${y0}V${topo + r}Q${x0},${topo} ${x0 + r},${topo}H${x0 + larg - r}Q${x0 + larg},${topo} ${x0 + larg},${topo + r}V${y0}Z`
            : `M${x0},${y0}V${topo + alt - r}Q${x0},${topo + alt} ${x0 + r},${topo + alt}H${x0 + larg - r}Q${x0 + larg},${topo + alt} ${x0 + larg},${topo + alt - r}V${y0}Z`;
          svgEl('path', { d, class: `coluna${s.parciais?.has(i) ? ' parcial' : ''}` }, grupo);
        });
      } else {
        let d = '';
        let anterior = null;
        s.valores.forEach((v, i) => {
          if (v == null) { anterior = null; return; }
          const xx = x(i).toFixed(1);
          const yy = y(v).toFixed(1);
          if (anterior == null) d += `M${xx},${yy}`;
          else if (s.degrau) d += `H${xx}V${yy}`;
          else d += `L${xx},${yy}`;
          anterior = v;
        });
        svgEl('path', { d, class: `linha ${s.classe}` }, svg);
      }
      marcas.push(s);
    });

    // Camada de leitura: cruz, pontos e área de captura.
    const cruz = svgEl('line', { y1: margem.topo, y2: margem.topo + ap, class: 'cruz', visibility: 'hidden' }, svg);
    const pontos = series.map((s) => svgEl('circle', { r: 4.5, class: `ponto ${s.classe}`, visibility: 'hidden' }, svg));
    const captura = svgEl('rect', {
      x: margem.esquerda, y: margem.topo, width: lp, height: ap, class: 'grafico-captura',
    }, svg);

    area.replaceChildren(svg);
    quadro = { svg, cruz, pontos, captura, x, y, banda, margem, largura, n, tipo };

    const indiceDoPonteiro = (ev) => {
      const ret = svg.getBoundingClientRect();
      const px = ((ev.clientX - ret.left) / ret.width) * largura;
      const i = tipo === 'colunas'
        ? Math.floor((px - margem.esquerda) / banda)
        : Math.round((px - margem.esquerda) / banda);
      return Math.max(0, Math.min(n - 1, i));
    };
    captura.addEventListener('pointermove', (ev) => mostrar(indiceDoPonteiro(ev)));
    captura.addEventListener('pointerdown', (ev) => mostrar(indiceDoPonteiro(ev)));
    captura.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') esconder(); });
    svg.addEventListener('keydown', (ev) => {
      const passo = { ArrowLeft: -1, ArrowRight: 1, PageDown: -12, PageUp: 12 }[ev.key];
      if (passo) {
        ev.preventDefault();
        mostrar(Math.max(0, Math.min(n - 1, (estadoIndice ?? n - 1) + passo)));
      } else if (ev.key === 'Home') { ev.preventDefault(); mostrar(0); }
      else if (ev.key === 'End') { ev.preventDefault(); mostrar(n - 1); }
      else if (ev.key === 'Escape') esconder();
    });
    svg.addEventListener('blur', esconder);
    if (estadoIndice != null) mostrar(Math.min(estadoIndice, n - 1));
  }

  let estadoIndice = null;

  function mostrar(i) {
    if (!quadro) return;
    estadoIndice = i;
    const { cruz, pontos, x, y, largura, tipo } = quadro;
    const xx = x(i);
    if (tipo === 'linhas') {
      cruz.setAttribute('x1', xx);
      cruz.setAttribute('x2', xx);
      cruz.setAttribute('visibility', 'visible');
    } else {
      cruz.setAttribute('visibility', 'hidden');
    }
    atual.series.forEach((s, k) => {
      const v = s.valores[i];
      if (v == null || tipo === 'colunas') { pontos[k].setAttribute('visibility', 'hidden'); return; }
      pontos[k].setAttribute('cx', xx);
      pontos[k].setAttribute('cy', y(v));
      pontos[k].setAttribute('visibility', 'visible');
    });

    dica.replaceChildren();
    htmlEl('div', 'dica-titulo', atual.tituloTooltip(i), dica);
    const extra = atual.extraTooltip ? atual.extraTooltip(i) : null;
    if (extra) htmlEl('div', 'dica-extra', extra, dica);
    for (const s of atual.series) {
      const linha = htmlEl('div', 'dica-linha', null, dica);
      htmlEl('span', `legenda-chave chave-linha ${s.classe}`, null, linha);
      htmlEl('strong', null, atual.formatoY(s.valores[i], false), linha);
      if (atual.series.length > 1) htmlEl('span', 'dica-nome', s.nome, linha);
      if (s.parciais?.has(i) && s.notaParcial) htmlEl('span', 'dica-nome', s.notaParcial(i), linha);
    }
    dica.hidden = false;
    const larguraDica = dica.offsetWidth;
    const escalaTela = quadro.svg.getBoundingClientRect().width / largura;
    let esquerda = xx * escalaTela + 12;
    if (esquerda + larguraDica > container.clientWidth) esquerda = Math.max(0, xx * escalaTela - larguraDica - 12);
    dica.style.transform = `translate(${Math.round(esquerda)}px, 0)`;
  }

  function esconder() {
    estadoIndice = null;
    dica.hidden = true;
    if (!quadro) return;
    quadro.cruz.setAttribute('visibility', 'hidden');
    quadro.pontos.forEach((p) => p.setAttribute('visibility', 'hidden'));
  }

  montarLegenda();
  desenhar();

  let pedido = 0;
  let larguraAnterior = area.clientWidth;
  const observador = new ResizeObserver(() => {
    if (Math.abs(area.clientWidth - larguraAnterior) < 2) return;
    larguraAnterior = area.clientWidth;
    cancelAnimationFrame(pedido);
    pedido = requestAnimationFrame(desenhar);
  });
  observador.observe(area);

  return {
    atualizar(novas) {
      atual = { ...atual, ...novas };
      estadoIndice = null;
      dica.hidden = true;
      montarLegenda();
      desenhar();
    },
  };
}

// Tabela a partir de cabeçalhos e linhas. Uma célula pode ser texto ou
// { texto, detalhe }, com o detalhe numa linha menor abaixo.
// colunasTexto: índices (além do 0) alinhados à esquerda.
export function preencherTabela(tabela, cabecalhos, linhas, rodape = null, colunasTexto = []) {
  tabela.replaceChildren();
  const ehTexto = (k) => k === 0 || colunasTexto.includes(k);
  const thead = htmlEl('thead', null, null, tabela);
  const tr = htmlEl('tr', null, null, thead);
  cabecalhos.forEach((c, k) => {
    const th = htmlEl('th', ehTexto(k) ? null : 'num', c, tr);
    th.scope = 'col';
  });
  const tbody = htmlEl('tbody', null, null, tabela);
  for (const linha of linhas) {
    const r = htmlEl('tr', null, null, tbody);
    linha.forEach((celula, k) => {
      const tag = k === 0 ? 'th' : 'td';
      const c = htmlEl(tag, ehTexto(k) ? null : 'num', null, r);
      if (k === 0) c.scope = 'row';
      if (celula != null && typeof celula === 'object') {
        c.append(document.createTextNode(celula.texto));
        if (celula.detalhe) htmlEl('span', celula.destaque ? 'detalhe destaque' : 'detalhe', celula.detalhe, c);
      } else {
        c.textContent = celula;
      }
    });
  }
  if (rodape) {
    const cap = document.createElement('caption');
    cap.textContent = rodape;
    tabela.prepend(cap);
  }
  avisarRolagem(tabela);
}

// Quando a tabela não cabe na largura, um aviso em texto diz que dá para
// deslizar (sem sombra nem gradiente). Some quando a tabela passa a caber.
function avisarRolagem(tabela) {
  const caixa = tabela.closest('.tabela-rolagem');
  if (!caixa) return;
  let dica = caixa.nextElementSibling?.classList.contains('rolagem-dica') ? caixa.nextElementSibling : null;
  if (!dica) {
    dica = document.createElement('p');
    dica.className = 'rolagem-dica';
    dica.textContent = 'Deslize a tabela para o lado para ver todas as colunas.';
    caixa.after(dica);
  }
  const conferir = () => { dica.hidden = caixa.scrollWidth <= caixa.clientWidth + 1; };
  conferir();
  if (!caixa.dataset.observada && 'ResizeObserver' in window) {
    caixa.dataset.observada = '1';
    new ResizeObserver(conferir).observe(caixa);
  }
}

// CSV com ";" e vírgula decimal, que abre direto no Excel e no Google Planilhas em português.
export function baixarCSV(nomeArquivo, cabecalhos, linhas) {
  const escapar = (v) => {
    if (v == null) return '';
    const texto = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[";\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  };
  const conteudo = [cabecalhos, ...linhas].map((l) => l.map(escapar).join(';')).join('\r\n');
  const blob = new Blob(['﻿', conteudo], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
