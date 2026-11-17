// Página de cada deputado e senador: /parlamentar/nome-uf (o Worker entrega
// parlamentar.html com o título e a manchete do parlamentar). Emendas pagas
// por ano, para quem foram e quais cidades receberam, e a cota do ano.

import * as f from './formato.js';
import { carregarPainel, carregarIndiceParlamentares, carregarEmendasParlamentar, carregarIndiceMunicipios, carregarCotaAno } from './dados.js';
import { caminhoDaCidade } from './endereco.js';
import { $, el, campo, definir, semAcento, inflacao, fatorParaHoje, arred, registrarDownload, barra, encurtarLista, montarBusca } from './comum.js';

const TIPOS = {
  prefeituras: ['Prefeituras e órgãos municipais', 'prefeitura, fundos municipais de saúde e outros'],
  estados: ['Governos e órgãos dos estados', 'governo do estado, secretarias e fundos estaduais'],
  entidades: ['Entidades sem fins lucrativos', 'associações, fundações e santas casas'],
  banco: ['Pago por meio do Banco do Brasil', 'o arquivo oficial não diz quem recebeu'],
  outros: ['Empresas e outros', 'empresas, consórcios e órgãos federais'],
};
const CASA = { camara: 'Câmara dos Deputados', senado: 'Senado', '': 'Câmara ou Senado' };

// Linha [endereço, nome, casa, partido, UF, total] -> "Câmara dos Deputados · PL-MG".
const rotulo = (p) => (p[2] ? `${CASA[p[2]]} · ${p[3] ? `${p[3]}-` : ''}${p[4]}` : 'Câmara ou Senado');
const sigla = (p) => (p[4] ? ` (${p[3] ? `${p[3]}-` : ''}${p[4]})` : '');
// Entre 1 e 10 milhões, com uma casa: "R$ 1,4 mi".
const valorCurto = (v) => (v >= 1e6 && v < 1e7 ? `R$ ${f.numero(v / 1e6, 1)} mi` : f.reaisCompacto(v));
const valorGrande = (v) => (v >= 1e6 ? f.reaisPorExtenso(v) : f.reaisCompacto(v));

const estado = { indice: null, ctx: null, p: null, d: null, cidades: null };

function enderecoDaPagina() {
  const m = /^\/parlamentar\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(location.pathname);
  return m ? m[1] : new URLSearchParams(location.search).get('p');
}

async function nomesDasCidades() {
  if (!estado.cidades) {
    const d = await carregarIndiceMunicipios();
    estado.cidades = new Map(d.cidades.map((c) => [String(c[0]).padStart(7, '0'), [c[1], c[2]]]));
  }
  return estado.cidades;
}

function desenharEmendas(ano) {
  const { p, d, ctx } = estado;
  const anos = estado.indice.anos;
  const emAndamento = Math.max(...anos);
  const doAno = (a) => {
    const x = d.anos[String(a)];
    if (!x) return null;
    const fator = fatorParaHoje(ctx, a) ?? 1;
    return { pago: x.pago * fator, tipos: x.tipos.map((v) => v * fator), cidades: x.cidades.map(([cod, v]) => [cod, v * fator]) };
  };
  const x = doAno(ano);
  const dl = $('#parl-numeros');
  dl.replaceChildren();
  const linha = (rot, valor, detalhes) => {
    const div = el('div', null, null, dl);
    el('dt', null, rot, div);
    el('dd', null, valor, div);
    detalhes.forEach((t) => el('dd', 'detalhe', t, div));
  };
  const rotAno = ano === emAndamento ? `Pago em ${ano} (ano em andamento)` : `Pago em ${ano}`;
  if (x && x.pago > 0) {
    linha(rotAno, valorGrande(x.pago), [x.cidades.length
      ? `${f.numero(x.cidades.length)} ${x.cidades.length === 1 ? 'cidade recebeu' : 'cidades receberam'} por meio da prefeitura`
      : 'Nenhuma cidade identificada']);
  } else linha(rotAno, f.moeda(0, 0), ['Nenhuma emenda individual paga neste ano']);
  const todos = anos.reduce((s, a) => s + (doAno(a)?.pago ?? 0), 0);
  linha(`De ${Math.min(...anos)} a ${emAndamento}`, valorGrande(todos), ['Soma dos anos, em dinheiro de hoje']);

  const tipos = $('#parl-tipos');
  tipos.replaceChildren();
  const temTipos = Boolean(x && x.pago > 0);
  campo('parl-tipos-titulo')[0].hidden = tipos.hidden = !temTipos;
  if (temTipos) {
    d.tipos.forEach((t, i) => {
      const v = x.tipos[i];
      if (v > 0) barra(tipos, { nome: TIPOS[t][0], explica: TIPOS[t][1], valor: `${valorCurto(v)} · ${f.parteDoTotal((v / x.pago) * 100)}`, pct: (v / x.pago) * 100 });
    });
  }

  const lista = $('#parl-cidades');
  const botao = $('#parl-cidades-todas');
  lista.replaceChildren();
  botao.hidden = true;
  const temCidades = Boolean(x?.cidades.length);
  campo('parl-cidades-titulo')[0].hidden = lista.hidden = !temCidades;
  if (temCidades) {
    definir('parl-cidades-titulo', `Cidades que receberam em ${ano}, da que mais recebeu para a que menos recebeu`);
    nomesDasCidades().catch(() => new Map()).then((nomes) => {
      if (Number($('#parl-ano').value) !== ano) return;
      lista.replaceChildren();
      x.cidades.forEach(([cod, v]) => {
        const [nome, uf] = nomes.get(cod) ?? [cod, ''];
        barra(lista, {
          nome: uf ? `${nome} (${uf})` : nome,
          href: uf ? caminhoDaCidade(nome, uf) : null,
          valor: `${valorCurto(v)} · ${f.parteDoTotal((v / x.pago) * 100)}`,
          pct: (v / x.pago) * 100,
        });
      });
      encurtarLista(lista, botao, 6, { abrir: `Ver todas as ${f.numero(x.cidades.length)} cidades`, fechar: 'Mostrar só as 6 que mais receberam' });
    });
  }
  definir('parl-nota', `Emendas individuais de ${p[1]} pagas em ${ano}, em dinheiro de hoje (IPCA). A porcentagem é do total pago no ano. Emendas de bancada e de comissão não entram.`);
  $('#parl-baixar').hidden = false;
}

async function desenharCota(ano) {
  const { p } = estado;
  const dl = $('#parl-cota');
  dl.replaceChildren();
  definir('parl-cota-nota', '');
  const secao = $('#cota');
  if (!p[2]) { secao.hidden = true; return; }
  secao.hidden = false;
  let cota;
  try {
    cota = await carregarCotaAno(ano);
  } catch {
    definir('parl-cota-nota', `Sem dado da cota em ${ano}.`);
    return;
  }
  if (Number($('#parl-ano').value) !== ano) return;
  const alvo = semAcento(p[1]);
  const casa = cota[p[2]];
  const achado = (casa?.parlamentares ?? []).find((x) => semAcento(x.nome) === alvo && x.uf === p[4]);
  if (!achado) {
    definir('parl-cota-nota', `Nenhum reembolso da cota em ${ano} nas listas oficiais.`);
    return;
  }
  const div = el('div', null, null, dl);
  el('dt', null, `Gasto da cota em ${ano}`, div);
  el('dd', null, f.reaisCompacto(achado.total), div);
  el('dd', 'detalhe', `${achado.meses} ${achado.meses === 1 ? 'mês' : 'meses'} com gasto${achado.ano_todo ? '' : '; não ficou o ano todo no cargo'}`, div);
  const media = (casa.parlamentares.filter((x) => x.uf === p[4] && x.ano_todo).map((x) => x.total));
  if (media.length >= 2) {
    const m = media.reduce((s, v) => s + v, 0) / media.length;
    const div2 = el('div', null, null, dl);
    el('dt', null, `Média de ${p[2] === 'senado' ? 'senadores' : 'deputados'} de ${p[4]}`, div2);
    el('dd', null, f.reaisCompacto(m), div2);
    el('dd', 'detalhe', 'Mesmo limite de gasto, porque o limite muda conforme o estado', div2);
  }
  definir('parl-cota-nota', `Valores da época, como reembolsados. Gasto alto não quer dizer irregularidade. Mais detalhes na seção da cota da página inicial.`);
}

function desenhar() {
  const ano = Number($('#parl-ano').value);
  desenharEmendas(ano);
  desenharCota(ano);
  const q = new URLSearchParams(location.search);
  q.delete('p');
  q.set('ano', String(ano));
  history.replaceState(null, '', `/parlamentar/${estado.p[0]}?${q}${location.hash}`);
}

registrarDownload('parlamentar', () => {
  const { p, d, ctx } = estado;
  const nomes = estado.cidades ?? new Map();
  const linhas = [];
  for (const [a, x] of Object.entries(d?.anos ?? {})) {
    const fator = arred(fatorParaHoje(ctx, Number(a)) ?? 1, 6);
    d.tipos.forEach((t, i) => linhas.push([a, p[1], 'tipo de recebedor', TIPOS[t][0], '', x.tipos[i], fator]));
    x.cidades.forEach(([cod, v]) => linhas.push([a, p[1], 'cidade', nomes.get(cod)?.join(' - ') ?? '', cod, v, fator]));
  }
  return {
    nome: `emendas-${p?.[0] ?? 'parlamentar'}.csv`,
    cabecalhos: ['ano', 'parlamentar', 'tipo da linha', 'recebedor ou cidade', 'codigo_ibge', 'pago_reais_da_epoca', 'fator para dinheiro de hoje (IPCA)'],
    linhas,
  };
});

async function iniciar() {
  const status = (t) => definir('parl-status', t);
  let painel;
  try {
    [painel, estado.indice] = await Promise.all([carregarPainel(), carregarIndiceParlamentares()]);
  } catch (erro) {
    console.error(erro);
    status('Não foi possível carregar os dados agora. Tente de novo mais tarde.');
    return;
  }
  if (!estado.indice) { status('A lista de parlamentares ainda não está disponível.'); return; }
  estado.ctx = inflacao(painel);
  definir('parl-atualizado', f.dataCurta(estado.indice.atualizado));

  montarBusca({
    entrada: $('#parl-busca'),
    lista: $('#parl-sugestoes'),
    prefixo: 'parl-op',
    itens: () => estado.indice.parlamentares,
    texto: (x) => `${x[1]} ${x[4]}`,
    rotulo: (x) => [x[1], rotulo(x)],
    vazio: 'Nenhum deputado ou senador com esse nome',
    aoEscolher: (x) => { location.href = `/parlamentar/${x[0]}`; },
  });

  const endereco = enderecoDaPagina();
  const p = endereco ? estado.indice.parlamentares.find((x) => x[0] === endereco) : null;
  if (!p) {
    status(endereco ? 'Parlamentar não encontrado. Procure pelo nome acima.' : 'Procure um deputado federal ou senador pelo nome acima.');
    return;
  }
  estado.p = p;
  try {
    estado.d = await carregarEmendasParlamentar(p[0]);
  } catch (erro) {
    console.error(erro);
    status('Não foi possível carregar as emendas agora. Tente de novo mais tarde.');
    return;
  }
  definir('parl-nome', p[1]);
  definir('trilha-nome', p[1]);
  definir('parl-cargo', rotulo(p));
  document.title = `${p[1]}${sigla(p)}: emendas e cota parlamentar · Arrecadômetro Brasil`;
  const selAno = $('#parl-ano');
  [...estado.indice.anos].reverse().forEach((a) => { el('option', null, String(a), selAno).value = String(a); });
  const pedido = new URLSearchParams(location.search).get('ano');
  const anoAtual = new Date().getFullYear();
  if (pedido && [...selAno.options].some((o) => o.value === pedido)) selAno.value = pedido;
  else if (estado.indice.anos.includes(anoAtual - 1)) selAno.value = String(anoAtual - 1);
  selAno.addEventListener('change', desenhar);
  campo('parl-status')[0].hidden = true;
  $('#parl-pagina').hidden = false;
  desenhar();
}

iniciar();
