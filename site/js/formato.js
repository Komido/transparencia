// Formatação de números e datas em português do Brasil.
// "R$" e o número ficam unidos por espaço não separável, para não quebrarem
// em linhas diferentes.

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Valor ausente: "sem dado", que um leigo entende melhor que "n/d".
export const SEM_DADO = 'sem dado';

const cache = new Map();
function nf(min, max) {
  const chave = `${min}-${max}`;
  if (!cache.has(chave)) {
    cache.set(chave, new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max }));
  }
  return cache.get(chave);
}

// Sinal de menos tipográfico (−), mais legível que o hífen.
const menos = (txt) => txt.replace(/^-/, '\u2212');
// Em dinheiro, o sinal vem antes do símbolo: −R$ 8, não R$ -8.
const comSimbolo = (simbolo, v, casas) => {
  const txt = nf(casas, casas).format(Math.abs(v));
  return `${v < 0 && txt !== nf(casas, casas).format(0) ? '\u2212' : ''}${simbolo}\u00A0${txt}`;
};

export function numero(v, casas = 0) {
  if (v == null || !Number.isFinite(v)) return SEM_DADO;
  return menos(nf(casas, casas).format(v));
}

export function moeda(v, casas = 2) {
  if (v == null || !Number.isFinite(v)) return SEM_DADO;
  return comSimbolo('R$', v, casas);
}

export function dolar(v, casas = 2) {
  if (v == null || !Number.isFinite(v)) return SEM_DADO;
  return comSimbolo('US$', v, casas);
}

// Valor em reais, abreviado: R$ 2,89 tri / R$ 222,1 bi / R$ 850 mi.
export function reaisCompacto(v) {
  if (v == null || !Number.isFinite(v)) return SEM_DADO;
  const a = Math.abs(v);
  const s = v < 0 ? '\u2212' : '';
  if (a >= 1e12) return `${s}R$\u00A0${nf(2, 2).format(a / 1e12)} tri`;
  if (a >= 1e9) return `${s}R$\u00A0${nf(1, 1).format(a / 1e9)} bi`;
  if (a >= 1e6) return `${s}R$\u00A0${nf(0, 0).format(a / 1e6)} mi`;
  if (a >= 1e3) return `${s}R$\u00A0${nf(0, 0).format(a / 1e3)} mil`;
  return moeda(v, 0);
}

// Valor em reais por extenso, para frases: R$ 2,15 trilhões / R$ 222,1 bilhões.
export function reaisPorExtenso(v) {
  if (v == null || !Number.isFinite(v)) return SEM_DADO;
  const a = Math.abs(v);
  // Singular abaixo de 2: "R$ 1,4 trilhão", "R$ 1,9 bilhão". A regra olha o
  // número já arredondado, para não escrever "R$ 2,0 bilhão" quando o valor
  // é 1,97 bilhão.
  const escrever = (n, casas, singular, plural) => {
    const mostrado = Math.round(Math.abs(n) * 10 ** casas) / 10 ** casas;
    return `${n < 0 ? '\u2212' : ''}R$\u00A0${nf(casas, casas).format(Math.abs(n))} ${mostrado < 2 ? singular : plural}`;
  };
  if (a >= 1e12) return escrever(v / 1e12, a < 2e12 ? 1 : 2, 'trilhão', 'trilhões');
  if (a >= 1e9) return escrever(v / 1e9, 1, 'bilhão', 'bilhões');
  if (a >= 1e6) return escrever(v / 1e6, a < 1e7 ? 1 : 0, 'milhão', 'milhões');
  return moeda(v, 0);
}

export function porcentagem(v, casas = 1, sinal = false) {
  if (v == null || !Number.isFinite(v)) return SEM_DADO;
  const txt = menos(`${nf(casas, casas).format(v)}%`);
  return sinal && v > 0 ? `+${txt}` : txt;
}

// '2026-09' -> 'set/2026'
export function mesCurto(mes) {
  if (!mes) return SEM_DADO;
  const [a, m] = mes.split('-').map(Number);
  return `${MESES[m - 1]}/${a}`;
}

// '2026-09' -> 'setembro de 2026'
export function mesLongo(mes) {
  if (!mes) return SEM_DADO;
  const [a, m] = mes.split('-').map(Number);
  return `${MESES_LONGOS[m - 1]} de ${a}`;
}

// '2016-05-12' -> '12/05/2016'
export function dataCurta(iso) {
  if (!iso) return SEM_DADO;
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

// Timestamp ISO -> '15/11/2026'
export function dataDeTimestamp(ts) {
  if (!ts) return SEM_DADO;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return SEM_DADO;
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
