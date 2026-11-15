// Formatação de números e datas em português do Brasil.
// "R$" e o número ficam unidos por espaço não separável, para não quebrarem
// em linhas diferentes.

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const cache = new Map();
function nf(min, max) {
  const chave = `${min}-${max}`;
  if (!cache.has(chave)) {
    cache.set(chave, new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max }));
  }
  return cache.get(chave);
}

export function numero(v, casas = 0) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  return nf(casas, casas).format(v);
}

export function moeda(v, casas = 2) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  return `R$\u00A0${nf(casas, casas).format(v)}`;
}

export function dolar(v, casas = 2) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  return `US$\u00A0${nf(casas, casas).format(v)}`;
}

// Valor em reais, abreviado: R$ 2,89 tri / R$ 222,1 bi / R$ 850 mi.
export function reaisCompacto(v) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  const a = Math.abs(v);
  if (a >= 1e12) return `R$\u00A0${nf(2, 2).format(v / 1e12)} tri`;
  if (a >= 1e9) return `R$\u00A0${nf(1, 1).format(v / 1e9)} bi`;
  if (a >= 1e6) return `R$\u00A0${nf(0, 0).format(v / 1e6)} mi`;
  return moeda(v, 0);
}

// Valor em reais por extenso, para frases: R$ 2,15 trilhões / R$ 222,1 bilhões.
export function reaisPorExtenso(v) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  const a = Math.abs(v);
  // Singular abaixo de 2: "R$ 1,4 trilhão", "R$ 1,9 bilhão". A regra olha o
  // número já arredondado, para não escrever "R$ 2,0 bilhão" quando o valor
  // é 1,97 bilhão.
  const escrever = (n, casas, singular, plural) => {
    const mostrado = Math.round(Math.abs(n) * 10 ** casas) / 10 ** casas;
    return `R$\u00A0${nf(casas, casas).format(n)} ${mostrado < 2 ? singular : plural}`;
  };
  if (a >= 1e12) return escrever(v / 1e12, a < 2e12 ? 1 : 2, 'trilhão', 'trilhões');
  if (a >= 1e9) return escrever(v / 1e9, 1, 'bilhão', 'bilhões');
  if (a >= 1e6) return escrever(v / 1e6, a < 1e7 ? 1 : 0, 'milhão', 'milhões');
  return moeda(v, 0);
}

export function porcentagem(v, casas = 1, sinal = false) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  const txt = `${nf(casas, casas).format(v)}%`;
  return sinal && v > 0 ? `+${txt}` : txt;
}

// '2026-09' -> 'set/2026'
export function mesCurto(mes) {
  if (!mes) return 'n/d';
  const [a, m] = mes.split('-').map(Number);
  return `${MESES[m - 1]}/${a}`;
}

// '2026-09' -> 'setembro de 2026'
export function mesLongo(mes) {
  if (!mes) return 'n/d';
  const [a, m] = mes.split('-').map(Number);
  return `${MESES_LONGOS[m - 1]} de ${a}`;
}

// '2016-05-12' -> '12/05/2016'
export function dataCurta(iso) {
  if (!iso) return 'n/d';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

// Timestamp ISO -> '15/11/2026'
export function dataDeTimestamp(ts) {
  if (!ts) return 'n/d';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'n/d';
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
