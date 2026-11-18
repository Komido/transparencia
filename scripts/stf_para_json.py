#!/usr/bin/env python3
"""Quanto o Supremo Tribunal Federal pagou por ano, por tipo de despesa,
com conferência cruzada contra o relatório de pessoal do próprio STF.

Fonte principal: Tesouro Nacional, Tesouro Transparente, conjunto
"Despesas e Transferências Totais da União (critério valor pago)", uma
planilha por ano com a despesa de todos os órgãos da União, de todos os
Poderes (é a base do limite de gastos da Lei Complementar 200/2023):
  https://www.tesourotransparente.gov.br/ckan/dataset/despesas-e-transferencias-totais
A aba com o nome do ano tem uma linha por órgão, mês, grupo de despesa,
ação e fonte, com "PAGAMENTOS_TOTAIS" (o que foi pago no mês, inclusive
restos a pagar de anos anteriores). Conferido em 18/11/2026: em 2025, o STF
(órgão 10000) tem 250 linhas e R$ 987 milhões de pagamentos totais, dos
quais R$ 895 milhões sujeitos ao limite (a aba "Resumo LC 200 Sujeitas" da
mesma planilha dá os mesmos R$ 895,0 milhões).

Conta do site: os pagamentos do STF menos as despesas financeiras (a
contribuição que o STF faz ao fundo de previdência dos servidores da União,
uma operação dentro do próprio governo, que a planilha marca como
"FINANCEIRO"), em quatro grupos: servidores e ministros na ativa,
aposentadorias e pensões, funcionamento (as "outras despesas correntes":
contratos, sistemas, benefícios dos servidores) e obras e equipamentos
(investimentos).

Conferência cruzada: a despesa com pessoal da planilha (contribuição
patronal incluída) é comparada com a "despesa bruta com pessoal" dos 12
meses do Relatório de Gestão Fiscal que o próprio STF entrega ao Tesouro
(SICONFI, Anexo 1, 3º quadrimestre). As duas contas não são iguais por
definição (a planilha conta o que foi pago no ano; o relatório, o que foi
liquidado nos 12 meses), mas devem ficar perto; se a diferença passar de
15%, o script falha sem gravar. A diferença de cada ano vai para o site.

Saída: site/dados/stf.json
"""

import collections
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone

AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
CKAN = "https://www.tesourotransparente.gov.br/ckan/api/3/action/package_show?id=despesas-e-transferencias-totais"
PAGINA = "https://www.tesourotransparente.gov.br/ckan/dataset/despesas-e-transferencias-totais"
SICONFI = "https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rgf"
DESTINO = "site/dados/stf.json"
TEMPORARIO = os.environ.get("RUNNER_TEMP", "/tmp")
ORGAO = "10000"
PRIMEIRO_ANO = 2023
TOLERANCIA = 0.15
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
CATEGORIAS = [
    ("ativos", "Servidores e ministros na ativa"),
    ("aposentados", "Aposentadorias e pensões"),
    ("funcionamento", "Funcionamento"),
    ("investimentos", "Obras e equipamentos"),
]
INDICE = {k: i for i, (k, _) in enumerate(CATEGORIAS)}
COLUNAS = ["ID_ANO", "ORGAO_CODIGO", "ID_GRUPO_DESPESA_NADE", "ID_IN_RESULTADO_EOF", "ID_FUNCAO_PT", "PAGAMENTOS_TOTAIS"]


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def baixar(url, tempo=300, aceitar="*/*"):
    for k in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE, "Accept": aceitar})
            with urllib.request.urlopen(req, timeout=tempo) as r:
                return r.read()
        except (urllib.error.URLError, OSError) as erro:
            print(f"  tentativa {k + 1} em {url[:90]}: {erro}", flush=True)
            time.sleep(20 * (k + 1))
    falhar(f"não consegui baixar {url}")
    return b""


def planilhas_por_ano():
    """{ano: (url, data de modificação)} das planilhas anuais do conjunto."""
    d = json.loads(baixar(CKAN, aceitar="application/json"))
    anos = {}
    for r in d["result"]["resources"]:
        m = re.search(r"Uni[aã]o\s*-\s*(\d{4})\s*$", r.get("name") or "")
        if m and (r.get("format") or "").upper() == "XLSX":
            anos[int(m.group(1))] = (r["url"], r.get("last_modified") or r.get("metadata_modified") or "")
    if not anos:
        falhar("o conjunto do Tesouro não lista planilhas anuais")
    return anos


def aba_do_ano(caminho, ano):
    """Linhas da aba com o nome do ano, lendo o XML do xlsx (sem bibliotecas de fora)."""
    z = zipfile.ZipFile(caminho)
    compart = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            compart.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    livro = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    alvo = {r.get("Id"): r.get("Target") for r in rels}
    rid = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    arquivo = None
    for sh in livro.find("m:sheets", NS):
        if (sh.get("name") or "").strip() == str(ano):
            arquivo = "xl/" + alvo[sh.get(rid)].lstrip("/").removeprefix("xl/")
    if arquivo is None:
        # Sem aba com o nome do ano: a maior aba é a detalhada.
        arquivo = max((n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)), key=lambda n: z.getinfo(n).file_size)
        print(f"  {ano}: sem aba chamada {ano}; usando a maior ({arquivo})")
    linhas = []
    for row in ET.fromstring(z.read(arquivo)).iter("{%s}row" % NS["m"]):
        vals = []
        for c in row.findall("m:c", NS):
            # Respeita a coluna da célula (células vazias não aparecem no XML).
            col = re.match(r"[A-Z]+", c.get("r") or "")
            if col:
                n = 0
                for ch in col.group(0):
                    n = n * 26 + ord(ch) - 64
                while len(vals) < n - 1:
                    vals.append(None)
            v = c.find("m:v", NS)
            if v is None:
                vals.append(None)
            elif c.get("t") == "s":
                vals.append(compart[int(v.text)])
            else:
                vals.append(v.text)
        linhas.append(vals)
    return linhas


def somar(linhas, ano):
    cab = [str(c or "").strip() for c in linhas[0]]
    faltam = [c for c in COLUNAS if c not in cab]
    if faltam:
        falhar(f"colunas sumiram da planilha de {ano}: {faltam}")
    I = {c: cab.index(c) for c in cab}
    tem_rtn = "CATEGORIA_RTN" in I
    partes = [0.0] * len(CATEGORIAS)
    pessoal_com_patronal = 0.0
    financeiro = 0.0
    n = 0
    def pega(l, c):
        k = I[c]
        return l[k] if k < len(l) else None
    for l in linhas[1:]:
        if str(pega(l, "ORGAO_CODIGO") or "").strip() != ORGAO:
            continue
        if str(pega(l, "ID_ANO") or "").strip() != str(ano):
            falhar(f"linha de outro ano na planilha de {ano}")
        n += 1
        valor = float(pega(l, "PAGAMENTOS_TOTAIS") or 0)
        grupo = str(pega(l, "ID_GRUPO_DESPESA_NADE") or "").strip()
        if grupo == "1":
            pessoal_com_patronal += valor
        if str(pega(l, "ID_IN_RESULTADO_EOF") or "").strip() == "0":
            financeiro += valor
            continue
        if grupo == "1":
            rtn = str(pega(l, "CATEGORIA_RTN") or "") if tem_rtn else ""
            aposentado = rtn.startswith("2.2.3") if tem_rtn else str(pega(l, "ID_FUNCAO_PT") or "").strip() == "9"
            partes[INDICE["aposentados" if aposentado else "ativos"]] += valor
        elif grupo == "3":
            partes[INDICE["funcionamento"]] += valor
        elif grupo in ("4", "5"):
            partes[INDICE["investimentos"]] += valor
        else:
            falhar(f"grupo de despesa inesperado no STF em {ano}: {grupo!r}")
    if n < 50:
        falhar(f"só {n} linhas do STF na planilha de {ano}")
    total = sum(partes)
    print(f"  {ano}: {n} linhas do STF; pago (sem financeiro) R$ {total / 1e6:.1f} mi; financeiro deixado de fora "
          f"R$ {financeiro / 1e6:.1f} mi; pessoal com contribuição patronal R$ {pessoal_com_patronal / 1e6:.1f} mi", flush=True)
    if not 300e6 < total < 5e9:
        falhar(f"total implausível do STF em {ano}: {total}")
    return total, partes, pessoal_com_patronal


def pessoal_no_rgf(ano):
    """Despesa bruta com pessoal dos 12 meses do RGF do STF (3º quadrimestre)."""
    q = {"an_exercicio": ano, "in_periodicidade": "Q", "nr_periodo": 3, "co_tipo_demonstrativo": "RGF",
         "no_anexo": "RGF-Anexo 01", "co_esfera": "U", "co_poder": "J", "id_ente": 1}
    offset = 0
    while True:
        url = f"{SICONFI}?{urllib.parse.urlencode(q)}&offset={offset}"
        d = json.loads(baixar(url, aceitar="application/json"))
        itens = d.get("items") or []
        for x in itens:
            if (x.get("instituicao") == "Supremo Tribunal Federal" and str(x.get("conta", "")).startswith("DESPESA BRUTA COM PESSOAL")
                    and str(x.get("coluna", "")).startswith("TOTAL (ÚLTIMOS 12 MESES)")):
                return float(x["valor"])
        if not d.get("hasMore") or not itens:
            return None
        offset += len(itens)
        time.sleep(1)


def gravar_json(caminho, dados):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(temporario, caminho)


def main():
    try:
        antigo = json.load(open(DESTINO, encoding="utf-8"))
    except OSError:
        antigo = {}
    atual = datetime.now(timezone.utc).year
    disponiveis = planilhas_por_ano()
    # Só anos fechados: a planilha do ano em andamento ainda muda todo mês.
    anos = sorted(a for a in disponiveis if PRIMEIRO_ANO <= a < atual)
    print(f"planilhas no Tesouro: {sorted(disponiveis)}; anos usados: {anos}", flush=True)
    versoes = {str(a): disponiveis[a][1] for a in anos}
    if antigo.get("versoes") == versoes:
        print("Nenhuma planilha mudou; nada a gravar.")
        return
    valores, conferencia = {}, {}
    for ano in anos:
        url = disponiveis[ano][0]
        caminho = os.path.join(TEMPORARIO, f"stf-{ano}.xlsx")
        with open(caminho, "wb") as fh:
            fh.write(baixar(url, tempo=600))
        total, partes, pessoal = somar(aba_do_ano(caminho, ano), ano)
        os.remove(caminho)
        rgf = pessoal_no_rgf(ano)
        if rgf is None:
            falhar(f"o RGF do STF de {ano} não está no SICONFI")
        dif = pessoal / rgf - 1
        print(f"  {ano}: pessoal na planilha R$ {pessoal / 1e6:.1f} mi; no RGF R$ {rgf / 1e6:.1f} mi; diferença {dif:+.1%}", flush=True)
        if abs(dif) > TOLERANCIA:
            falhar(f"em {ano}, a despesa com pessoal da planilha e a do RGF diferem {dif:+.1%}")
        valores[str(ano)] = [round(total), [round(x) for x in partes]]
        conferencia[str(ano)] = {"planilha": round(pessoal), "rgf": round(rgf)}
    gravar_json(DESTINO, {
        "atualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "fonte": PAGINA,
        "versoes": versoes,
        "anos": anos,
        "categorias": [list(c) for c in CATEGORIAS],
        "valores": valores,
        "conferencia": conferencia,
    })
    print(f"gravado {DESTINO}")


if __name__ == "__main__":
    main()
