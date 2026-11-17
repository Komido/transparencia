// Página de cada deputado e senador: /parlamentar/nome-uf (o Worker entrega
// parlamentar.html com o título e a manchete do parlamentar). Emendas pagas
// por ano, para quem foram e quais cidades receberam, e a cota do ano.

import * as f from './formato.js';
import { carregarPainel, carregarIndiceParlamentares, carregarEmendasParlamentar, carregarIndiceMunicipios, carregarCotaAno, carregarAtividade, carregarVotacoesAno } from './dados.js';
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
const sigla = (p) => (p[4] ? ` (${p[3] ? `${p[3]}-` : ''}${p[4]})` : '');
// Entre 1 e 10 milhões, com uma casa: "R$ 1,4 mi".
const valorCurto = (v) => (v >= 1e6 && v < 1e7 ? `R$ ${f.numero(v / 1e6, 1)} mi` : f.reaisCompacto(v));
const valorGrande = (v) => (v >= 1e6 ? f.reaisPorExtenso(v) : f.reaisCompacto(v));

const estado = { indice: null, ctx: null, p: null, d: null, cidades: null, atv: null };

// "Deputada federal · PT-MG", "Senador · PSD-MG"; sem a lista oficial, a casa.
function cargo(p) {
  const sexo = p[7] ?? estado.atv?.sexo ?? '';
  const casa = p[2];
  if (!casa) return 'Câmara ou Senado';
  const nome = casa === 'senado' ? (sexo === 'F' ? 'Senadora' : sexo === 'M' ? 'Senador' : 'Senado')
    : (sexo === 'F' ? 'Deputada federal' : sexo === 'M' ? 'Deputado federal' : 'Câmara dos Deputados');
  return `${nome} · ${p[3] ? `${p[3]}-` : ''}${p[4]}`;
}

const VOTO_TEXTO = { S: 'Sim', N: 'Não', A: 'Abstenção', O: 'Obstrução', V: 'Votou (voto secreto)', P: 'Presidiu a sessão' };
// Motivos de quem não votou, como o Senado registra.
const AUSENCIA_SENADO = { NCom: 'não compareceu', MIS: 'em missão oficial', LS: 'licença de saúde', LP: 'licença particular', 'P-NRV': 'presente, sem registrar voto' };
const linkProposicao = (casa, id) => (casa === 'camara'
  ? `https://www.camara.leg.br/propostas-legislativas/${id}`
  : `https://www25.senado.leg.br/web/atividade/materias/-/materia/${id}`);

function item(lista, { titulo, href, lado, texto, detalhe }) {
  const li = el('li', null, null, lista);
  const topo = el('div', 'item-topo', null, li);
  const t = el('span', 'item-titulo', null, topo);
  if (href) {
    const a = el('a', null, titulo, t);
    a.href = href;
    a.rel = 'noopener';
  } else t.textContent = titulo;
  if (lado) el('span', 'item-voto', lado, topo);
  if (texto) el('span', 'item-texto', texto, li);
  if (detalhe) el('span', 'item-detalhe', detalhe, li);
  return li;
}

async function desenharVotacoes(ano) {
  const secao = $('#votacoes');
  const atv = estado.atv;
  const casa = estado.p[2];
  if (!atv || !casa) { secao.hidden = true; $('#parl-resumo-votacoes').hidden = true; return; }
  let vot;
  try { vot = await carregarVotacoesAno(casa, ano); } catch { vot = null; }
  if (Number($('#parl-ano').value) !== ano) return;
  secao.hidden = false;
  const meus = atv.votos[String(ano)] ?? [];
  const numeros = $('#parl-votos-numeros');
  const lista = $('#parl-votacoes');
  numeros.replaceChildren();
  lista.replaceChildren();
  const linha = (rot, valor, detalhes) => {
    const div = el('div', null, null, numeros);
    el('dt', null, rot, div);
    el('dd', null, valor, div);
    detalhes.forEach((t) => el('dd', 'detalhe', t, div));
  };
  if (!vot) {
    definir('parl-votos-nota', `Sem dado de votações de ${ano}.`);
    campo('parl-votacoes-titulo')[0].hidden = true;
    resumo('parl-resumo-votacoes', 'sem dado', null);
    return;
  }
  const total = vot.votacoes.length;
  const registrados = meus.filter(([, v]) => ['S', 'N', 'A', 'O', 'V', 'P'].includes(v));
  const conta = (cod) => meus.filter(([, v]) => v === cod).length;
  if (casa === 'camara') {
    linha(`Votou em ${ano}`, `${f.numero(registrados.length)} de ${f.numero(total)}`, ['votações nominais do Plenário no ano']);
    resumo('parl-resumo-votacoes', `${f.numero(registrados.length)} de ${f.numero(total)}`, 'votações em que registrou voto');
  } else {
    const ausencias = {};
    meus.filter(([, v]) => v.startsWith('x:')).forEach(([, v]) => { const m = v.slice(2); ausencias[m] = (ausencias[m] ?? 0) + 1; });
    const motivos = Object.entries(ausencias).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${AUSENCIA_SENADO[m] ?? `registro "${m}"`}: ${n}`);
    linha(`Votou em ${ano}`, `${f.numero(registrados.length)} de ${f.numero(meus.length)}`, [
      'votações nominais em que estava no mandato',
      ...(motivos.length ? [`Não votou: ${motivos.join('; ')}`] : []),
    ]);
    resumo('parl-resumo-votacoes', `${f.numero(registrados.length)} de ${f.numero(meus.length)}`, 'votações em que registrou voto');
  }
  const partes = [['S', 'Sim'], ['N', 'Não'], ['A', 'Abstenção'], ['O', 'Obstrução'], ['V', 'Voto secreto']].map(([c, t]) => [t, conta(c)]).filter(([, n]) => n > 0);
  if (partes.length) linha('Como votou', partes.map(([t, n]) => `${t}: ${f.numero(n)}`).join(' · '), ['contagem das votações em que registrou voto']);

  // A lista: da votação mais recente para a mais antiga.
  const iVoto = new Map(meus.map(([k, v]) => [k, v]));
  const ordem = vot.votacoes.map((v, k) => [v, k]).filter(([, k]) => iVoto.has(k)).reverse();
  campo('parl-votacoes-titulo')[0].hidden = !ordem.length;
  ordem.forEach(([v, k]) => {
    const cod = iVoto.get(k);
    const voto = VOTO_TEXTO[cod] ?? (cod.startsWith('x:') ? `Não votou (${AUSENCIA_SENADO[cod.slice(2)] ?? cod.slice(2)})` : 'Outro registro');
    const resultado = casa === 'camara' ? v[4] : [v[4], v[10]].filter(Boolean).join(' ');
    const idProp = casa === 'camara' ? v[8] : v[8];
    item(lista, {
      titulo: v[2] || 'Votação',
      href: idProp ? linkProposicao(casa, idProp) : null,
      lado: voto,
      texto: v[3],
      detalhe: [f.dataCurta(v[1]), resultado].filter(Boolean).join(' · '),
    });
  });
  encurtarLista(lista, $('#parl-votacoes-todas'), 10, { abrir: `Ver todas as ${f.numero(ordem.length)} votações`, fechar: 'Mostrar só as 10 mais recentes' });
  definir('parl-votos-nota', casa === 'camara'
    ? 'Fonte: Câmara dos Deputados, dados abertos. O arquivo da Câmara traz só quem votou: quem estava de licença, era ministro ou secretário, ou ainda não tinha assumido aparece como não tendo votado, sem o motivo.'
    : 'Fonte: Senado Federal, dados abertos. Em votação secreta, o Senado registra só que o senador votou.');
}

function desenharProjetos(ano) {
  const secao = $('#projetos');
  const atv = estado.atv;
  if (!atv) { secao.hidden = true; $('#parl-resumo-projetos').hidden = true; return; }
  secao.hidden = false;
  const casa = estado.p[2];
  const doAno = atv.projetos.filter((x) => x[4].startsWith(String(ano)));
  const numeros = $('#parl-projetos-numeros');
  numeros.replaceChildren();
  const div = el('div', null, null, numeros);
  el('dt', null, `Apresentados em ${ano}`, div);
  el('dd', null, f.numero(doAno.length), div);
  const principal = doAno.filter((x) => x[6] === 1).length;
  if (doAno.length) el('dd', 'detalhe', `${f.numero(principal)} como autor principal`, div);
  const div2 = el('div', null, null, numeros);
  el('dt', null, `Desde ${Math.min(...estado.indice.anos)}`, div2);
  el('dd', null, f.numero(atv.projetos.length), div2);
  resumo('parl-resumo-projetos', f.numero(doAno.length), `${f.numero(principal)} como autor principal`);
  const lista = $('#parl-projetos');
  lista.replaceChildren();
  doAno.forEach((x) => item(lista, {
    titulo: x[1],
    href: linkProposicao(casa, x[0]),
    lado: x[6] === 1 ? 'Autor principal' : 'Coautor',
    texto: x[3],
    detalhe: [f.dataCurta(x[4]), x[5]].filter(Boolean).join(' · '),
  }));
  encurtarLista(lista, $('#parl-projetos-todos'), 10, { abrir: `Ver todos os ${f.numero(doAno.length)} projetos`, fechar: 'Mostrar só os 10 mais recentes' });
  definir('parl-projetos-nota', `Fonte: ${casa === 'camara' ? 'Câmara dos Deputados' : 'Senado Federal'}, dados abertos. Quantidade não mede qualidade: um projeto pode ser importante ou uma homenagem, e muitos são assinados em conjunto. O link leva à página oficial, com o texto e a tramitação.`);
}

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
  resumo('parl-resumo-emendas', x && x.pago > 0 ? valorGrande(x.pago) : f.moeda(0, 0), 'em dinheiro de hoje');
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

// Um número do resumo do topo: o valor e uma linha de detalhe.
function resumo(id, valor, detalhe) {
  const div = document.getElementById(id);
  div.hidden = false;
  div.querySelectorAll('dd').forEach((dd) => dd.remove());
  el('dd', null, valor, div);
  if (detalhe) el('dd', 'detalhe', detalhe, div);
}

async function desenharCota(ano) {
  const { p } = estado;
  const dl = $('#parl-cota');
  const grupos = $('#parl-cota-grupos');
  dl.replaceChildren();
  grupos.replaceChildren();
  grupos.hidden = campo('parl-cota-grupos-titulo')[0].hidden = true;
  definir('parl-cota-nota', '');
  const secao = $('#cota');
  if (!p[2]) { secao.hidden = true; $('#parl-resumo-cota').hidden = true; return; }
  secao.hidden = false;
  let cota;
  try {
    cota = await carregarCotaAno(ano);
  } catch {
    definir('parl-cota-nota', `Sem dado da cota em ${ano}.`);
    resumo('parl-resumo-cota', 'sem dado', null);
    return;
  }
  if (Number($('#parl-ano').value) !== ano) return;
  const alvo = semAcento(p[1]);
  const casa = cota[p[2]];
  const achado = (casa?.parlamentares ?? []).find((x) => semAcento(x.nome) === alvo && x.uf === p[4]);
  if (!achado) {
    definir('parl-cota-nota', `Nenhum reembolso da cota em ${ano} nas listas oficiais.`);
    resumo('parl-resumo-cota', f.moeda(0, 0), 'nenhum reembolso no ano');
    return;
  }
  resumo('parl-resumo-cota', f.reaisCompacto(achado.total), 'valor da época');
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
  // Com o que gastou: cada tipo de despesa, do maior para o menor.
  const itens = cota.grupos.map((g, i) => [g.nome, achado.grupos?.[i] ?? 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (itens.length && achado.total > 0) {
    itens.forEach(([nome, v]) => barra(grupos, { nome, valor: `${f.reaisCompacto(v)} · ${f.parteDoTotal((v / achado.total) * 100)}`, pct: (v / achado.total) * 100 }));
    grupos.hidden = campo('parl-cota-grupos-titulo')[0].hidden = false;
  }
  definir('parl-cota-nota', `Valores da época, como reembolsados ${p[2] === 'senado' ? 'pelo Senado' : 'pela Câmara'}. Gasto alto não quer dizer irregularidade, e gasto baixo não quer dizer mais trabalho. Mais detalhes na seção da cota da página inicial.`);
}

function desenhar() {
  const ano = Number($('#parl-ano').value);
  definir('parl-resumo-titulo', `Resumo de ${ano}`);
  desenharEmendas(ano);
  desenharCota(ano);
  desenharVotacoes(ano);
  desenharProjetos(ano);
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
    rotulo: (x) => [x[1], cargo(x)],
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
  // Votos e projetos, pela identificação oficial na Câmara ou no Senado.
  const [casaOficial, idOficial] = (p[6] ?? '').split(':');
  if (casaOficial && idOficial) {
    try { estado.atv = await carregarAtividade(casaOficial, idOficial); } catch (erro) { console.error(erro); estado.atv = null; }
  }
  definir('parl-nome', p[1]);
  definir('trilha-nome', p[1]);
  definir('parl-cargo', cargo(p));
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
