// Frases em linguagem simples, montadas sempre pelo mesmo modelo.
// Regras: frases curtas, uma ideia por frase, palavras do dia a dia e nenhum
// adjetivo de valor ("recorde", "histórico", "pior"). As frases descrevem o
// que os números mostram, igual para qualquer período ou governo.

import * as f from './formato.js';

// Quantidade legível: sem casas quando é inteira ou maior que 10; uma casa
// decimal nos demais casos ("1,3", "2", "62").
export function quantidade(q) {
  if (q == null || !Number.isFinite(q)) return 'n/d';
  if (q >= 10) return f.numero(q, 0);
  const arredondado = Math.round(q * 10) / 10;
  return Number.isInteger(arredondado) ? f.numero(arredondado, 0) : f.numero(arredondado, 1);
}

// "1 cesta básica", "2 cestas básicas", "1,3 cestas básicas".
export function quantidadeCom(q, singular, plural) {
  const texto = quantidade(q);
  return `${texto} ${texto === '1' ? singular : plural}`;
}

// Quanto o salário compra agora em relação a antes.
export function compraMaisOuMenos(nova, antiga) {
  if (nova == null || antiga == null || antiga <= 0) return null;
  const razao = nova / antiga;
  if (Math.abs(razao - 1) < 0.005) return 'a mesma quantidade';
  if (razao >= 1.5) return `${f.numero(razao, 1)} vezes mais`;
  if (razao > 1) return `${f.porcentagem((razao - 1) * 100, 0)} a mais`;
  return `${f.porcentagem((1 - razao) * 100, 0)} a menos`;
}

// Preço comparado: "15% mais barata", "42% mais caro". Devolve null quando a
// diferença é menor que 0,5% (o chamador escreve "praticamente o mesmo").
export function maisCaroOuBarato(atual, antigo, feminino = false) {
  if (atual == null || antigo == null || antigo <= 0) return null;
  const v = (atual / antigo - 1) * 100;
  if (Math.abs(v) < 0.5) return null;
  const palavra = v > 0 ? (feminino ? 'cara' : 'caro') : (feminino ? 'barata' : 'barato');
  return `${f.porcentagem(Math.abs(v), 0)} mais ${palavra}`;
}

// Variação de um valor: "4,8% a mais", "3,1% a menos".
export function variacao(percentual, casas = 1) {
  if (percentual == null || !Number.isFinite(percentual)) return null;
  if (Math.abs(percentual) < 0.05) return 'praticamente o mesmo valor';
  const valor = f.porcentagem(Math.abs(percentual), casas);
  return percentual > 0 ? `${valor} a mais` : `${valor} a menos`;
}

// Parte do salário mínimo em palavras quando é uma fração conhecida:
// "metade do salário mínimo", "um terço do salário mínimo", "1,4 salário mínimo".
export function parteDoSalario(percentual) {
  if (percentual == null || !Number.isFinite(percentual)) return 'n/d';
  if (percentual >= 115) {
    const vezes = percentual / 100;
    return `${f.numero(vezes, 1)} ${vezes < 2 ? 'salário mínimo' : 'salários mínimos'}`;
  }
  const fracoes = [[100, 'um salário mínimo inteiro'], [50, 'metade do salário mínimo'], [33.3, 'um terço do salário mínimo'], [25, 'um quarto do salário mínimo']];
  for (const [alvo, texto] of fracoes) {
    if (Math.abs(percentual - alvo) <= 1.5) return texto;
  }
  return `${f.porcentagem(percentual, percentual < 10 ? 1 : 0)} do salário mínimo`;
}

// Nomes dos grupos de tributos em palavras do dia a dia. A chave é o nome do
// grupo nos dados; grupos sem entrada aparecem com o nome original.
export const TRIBUTOS = {
  'Imposto de Renda': { nome: 'Imposto de Renda', explica: 'pago por pessoas e empresas' },
  'Receita previdenciária': { nome: 'Contribuição ao INSS', explica: 'paga por trabalhadores e empresas, financia aposentadorias' },
  Cofins: { nome: 'Cofins', explica: 'sobre o faturamento das empresas' },
  CSLL: { nome: 'CSLL', explica: 'sobre o lucro das empresas' },
  'PIS/Pasep': { nome: 'PIS/Pasep', explica: 'sobre o faturamento, paga seguro-desemprego e abono salarial' },
  IPI: { nome: 'IPI', explica: 'sobre produtos industrializados' },
  IOF: { nome: 'IOF', explica: 'sobre empréstimos, câmbio e seguros' },
  'Comércio exterior (II e IE)': { nome: 'Impostos de importação e exportação', explica: null },
  'CPMF e IPMF': { nome: 'CPMF', explica: 'sobre movimentação bancária, extinta em 2007' },
  'Cide-Combustíveis': { nome: 'Cide', explica: 'sobre combustíveis' },
  'Outras receitas': { nome: 'Outros tributos e receitas', explica: null },
  'Receitas de outros órgãos': { nome: 'Receitas de outros órgãos', explica: 'cobradas por outros órgãos federais' },
};

export const nomeDoTributo = (grupo) => TRIBUTOS[grupo]?.nome ?? grupo;

// Áreas de gasto do governo federal em palavras do dia a dia. Cada área junta
// uma ou mais contas da declaração anual (função "10", subfunção "28.843"...).
// A rolagem da dívida (28.841 e 28.842) fica fora: é dívida velha paga com
// dívida nova, não dinheiro que sai para serviços ou pessoas.
export const ROLAGEM = ['28.841', '28.842'];
export const AREAS_DE_GASTO = [
  { id: '09', contas: ['09'], nome: 'Aposentadorias e pensões', explica: 'INSS e aposentadorias dos servidores federais' },
  { id: 'divida', contas: ['28.843', '28.844'], nome: 'Juros e pagamento da dívida', explica: 'juros da dívida pública e parte do valor que venceu' },
  { id: 'transferencias', contas: ['28.845'], nome: 'Repasses a estados, municípios e outras transferências', explica: 'inclui a parte dos impostos federais que a Constituição manda repassar' },
  { id: 'outros_encargos', contas: ['28.846', '28.999', 'FU28'], nome: 'Outros encargos', explica: 'despesas que o orçamento não liga a uma área específica' },
  { id: '08', contas: ['08'], nome: 'Assistência social', explica: 'assistência a idosos e a pessoas com deficiência e programas de renda' },
  { id: '10', contas: ['10'], nome: 'Saúde', explica: null },
  { id: '12', contas: ['12'], nome: 'Educação', explica: 'inclui universidades e institutos federais' },
  { id: 'educacao_basica', contas: ['28.847'], nome: 'Repasses para a educação básica', explica: 'dinheiro da União para as redes de ensino de estados e municípios' },
  { id: '11', contas: ['11'], nome: 'Trabalho', explica: 'proteção e benefícios ao trabalhador' },
  { id: '05', contas: ['05'], nome: 'Defesa', explica: 'Forças Armadas' },
  { id: '02', contas: ['02'], nome: 'Poder Judiciário', explica: null },
  { id: '20', contas: ['20'], nome: 'Agricultura', explica: null },
  { id: '04', contas: ['04'], nome: 'Administração do governo', explica: null },
  { id: '18', contas: ['18'], nome: 'Meio ambiente', explica: null },
  { id: '19', contas: ['19'], nome: 'Ciência e tecnologia', explica: null },
  { id: '06', contas: ['06'], nome: 'Segurança pública', explica: 'policiamento e defesa civil' },
  { id: '26', contas: ['26'], nome: 'Transporte', explica: null },
  { id: '01', contas: ['01'], nome: 'Poder Legislativo', explica: 'Câmara, Senado e Tribunal de Contas da União' },
  { id: '03', contas: ['03'], nome: 'Ministério Público, Defensoria e Advocacia da União', explica: null },
  { id: '07', contas: ['07'], nome: 'Relações exteriores', explica: null },
  { id: '13', contas: ['13'], nome: 'Cultura', explica: null },
  { id: '14', contas: ['14'], nome: 'Direitos da cidadania', explica: null },
  { id: '15', contas: ['15'], nome: 'Urbanismo', explica: null },
  { id: '16', contas: ['16'], nome: 'Habitação', explica: null },
  { id: '17', contas: ['17'], nome: 'Saneamento', explica: null },
  { id: '21', contas: ['21'], nome: 'Reforma agrária', explica: null },
  { id: '22', contas: ['22'], nome: 'Indústria', explica: null },
  { id: '23', contas: ['23'], nome: 'Comércio e serviços', explica: null },
  { id: '24', contas: ['24'], nome: 'Comunicações', explica: null },
  { id: '25', contas: ['25'], nome: 'Energia', explica: null },
  { id: '27', contas: ['27'], nome: 'Esporte e lazer', explica: null },
];
