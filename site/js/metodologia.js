// Preenche as tabelas de referência da página de metodologia a partir dos
// mesmos dados usados no painel, para que as duas páginas nunca divirjam.
import { carregarPainel, ehLinkSeguro } from './dados.js';
import { preencherTabela } from './graficos.js';
import * as f from './formato.js';

async function iniciar() {
  let d;
  try {
    d = await carregarPainel();
  } catch (erro) {
    console.error(erro);
    return;
  }

  preencherTabela(document.getElementById('tabela-mandatos'),
    ['Mandato', 'Nome', 'Partido na eleição', 'Início', 'Fim', 'Observação'],
    d.mandatos.map((m) => [m.rotulo, m.nome, m.partido, f.dataCurta(m.inicio), m.fim ? f.dataCurta(m.fim) : 'em curso', m.observacao ?? '']),
    'Períodos de exercício da Presidência desde 1995.');

  preencherTabela(document.getElementById('tabela-ir'),
    ['Vigência', 'Limite da tabela', 'Desconto simplificado', 'Isenção efetiva', 'Norma', 'Conferido na fonte'],
    d.ir_tabela.map((t) => [
      f.mesCurto(t.inicio),
      f.moeda(t.limite_tabela, 2),
      t.desconto_simplificado == null ? 'não havia' : f.moeda(t.desconto_simplificado, 2),
      f.moeda(t.isencao_efetiva, 2),
      t.norma,
      t.conferido_na_fonte ? 'sim' : 'não (ver limitações)',
    ]),
    'Tabela mensal do IRPF. Fonte: páginas de tabelas da Receita Federal.');

  const rubricas = d.arrecadacao?.rubricas ?? [];
  preencherTabela(document.getElementById('tabela-rubricas'),
    ['Rubrica da Receita', 'Grupo no site', 'Na série comparável'],
    rubricas.map((r) => [r.nome, r.grupo, r.comparavel ? 'sim' : 'não']),
    'Colunas do arquivo da Receita e como cada uma é agrupada.');

  // Notas das linhas do IR, com link para a página da Receita quando houver.
  const tabelaIR = document.getElementById('tabela-ir');
  const linhas = tabelaIR.querySelectorAll('tbody tr');
  d.ir_tabela.forEach((t, i) => {
    const celula = linhas[i]?.querySelectorAll('td')[3];
    if (!celula || !ehLinkSeguro(t.fonte_url)) return;
    const a = document.createElement('a');
    a.href = t.fonte_url;
    a.rel = 'noopener';
    a.textContent = celula.textContent;
    celula.replaceChildren(a);
  });

  document.querySelectorAll('[data-campo="atualizado-em"]').forEach((e) => { e.textContent = f.dataDeTimestamp(d.gerado_em); });
}

iniciar();
