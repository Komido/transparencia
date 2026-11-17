#!/usr/bin/env python3
"""Emendas parlamentares que chegaram a cada cidade, por ano e por autor.

Fonte oficial: Portal da Transparência (CGU), arquivo único de emendas
parlamentares (sem chave):
  https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/UNICO
  que redireciona para
  https://dadosabertos-download.cgu.gov.br/PortalDaTransparencia/saida/emendas-parlamentares/EmendasParlamentares.zip

Conferido em 17/11/2026 (inspeção pelo GitHub): zip de 47 MB com 6 arquivos;
o principal, EmendasParlamentares.csv (latin-1, ";", 94.929 linhas, anos
2014 a 2026), traz por emenda e lugar de aplicação: código, ano, tipo,
autor, código IBGE do município (-1 quando o destino é o estado, o país ou
vários lugares), função e os valores empenhado, liquidado, pago e de restos
a pagar.

Valor pago = "Valor Pago" (no ano da emenda) + "Valor Restos A Pagar Pagos"
(pago nos anos seguintes). Só entram linhas com município; emendas para o
estado inteiro, nacionais ou para vários lugares ficam fora da conta da
cidade. Autor "Sem informação" fica assim (emendas antigas e de relator).

Saídas:
  site/dados/emendas/UF.json   por cidade e ano: valor pago, empenhado,
                               número de emendas e os autores que mais
                               mandaram (até 5)
"""

import collections
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.request
import zipfile

URL = "https://dadosabertos-download.cgu.gov.br/PortalDaTransparencia/saida/emendas-parlamentares/EmendasParlamentares.zip"
AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
DESTINO = "site/dados/emendas"
ARQUIVO = "EmendasParlamentares.csv"
COLUNAS = ["Código da Emenda", "Ano da Emenda", "Tipo de Emenda", "Nome do Autor da Emenda", "Código Município IBGE",
           "Município", "Nome Função", "Valor Empenhado", "Valor Pago", "Valor Restos A Pagar Pagos"]
PRIMEIRO_ANO = 2019
MAX_AUTORES = 5
UF_DO_CODIGO = {"11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO", "21": "MA",
                "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA",
                "31": "MG", "32": "ES", "33": "RJ", "35": "SP", "41": "PR", "42": "SC", "43": "RS", "50": "MS",
                "51": "MT", "52": "GO", "53": "DF"}


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def baixar(url, tentativas=4):
    for k in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE})
            with urllib.request.urlopen(req, timeout=900) as r:
                return r.read()
        except Exception as erro:  # noqa: BLE001
            print(f"  tentativa {k + 1}: {erro}", flush=True)
            time.sleep(30 * (k + 1))
    falhar(f"não consegui baixar {url}")
    return b""


def numero(texto, onde):
    t = (texto or "").strip()
    if not t:
        return 0.0
    try:
        return float(t.replace(".", "").replace(",", "."))
    except ValueError:
        falhar(f"valor inválido {texto!r} em {onde}")
        return 0.0


def gravar_json(caminho, dados):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(temporario, caminho)


def main():
    z = zipfile.ZipFile(io.BytesIO(baixar(URL)))
    if ARQUIVO not in z.namelist():
        falhar(f"{ARQUIVO} não está no zip: {z.namelist()}")
    texto = z.read(ARQUIVO).decode("latin-1")
    leitor = csv.DictReader(io.StringIO(texto), delimiter=";")
    faltam = [c for c in COLUNAS if c not in (leitor.fieldnames or [])]
    if faltam:
        falhar(f"colunas ausentes: {faltam}")
    ano_atual = dt.date.today().year
    # (cidade, ano) -> totais e autores
    pago = collections.defaultdict(float)
    empenhado = collections.defaultdict(float)
    emendas = collections.defaultdict(set)
    autores = collections.defaultdict(lambda: collections.defaultdict(float))
    total_ano = collections.defaultdict(float)
    sem_cidade = collections.defaultdict(float)
    linhas = 0
    for n, l in enumerate(leitor, start=2):
        linhas += 1
        try:
            ano = int(l["Ano da Emenda"])
        except ValueError:
            falhar(f"linha {n}: ano {l['Ano da Emenda']!r}")
        if not 2010 <= ano <= ano_atual:
            falhar(f"linha {n}: ano {ano} fora do intervalo")
        valor_pago = numero(l["Valor Pago"], f"linha {n}") + numero(l["Valor Restos A Pagar Pagos"], f"linha {n}")
        valor_emp = numero(l["Valor Empenhado"], f"linha {n}")
        total_ano[ano] += valor_pago
        if ano < PRIMEIRO_ANO:
            continue
        cod = (l["Código Município IBGE"] or "").strip()
        if cod in ("", "-1"):
            sem_cidade[ano] += valor_pago
            continue
        if len(cod) != 7 or not cod.isdigit() or cod[:2] not in UF_DO_CODIGO:
            falhar(f"linha {n}: código IBGE {cod!r}")
        chave = (cod, ano)
        pago[chave] += valor_pago
        empenhado[chave] += valor_emp
        emendas[chave].add(l["Código da Emenda"])
        autor = (l["Nome do Autor da Emenda"] or "").strip() or "Sem informação"
        autores[chave][autor] += valor_pago
    if not 80000 <= linhas <= 200000:
        falhar(f"{linhas} linhas no arquivo; esperado perto de 95 mil")
    for ano in sorted(total_ano):
        if ano >= PRIMEIRO_ANO:
            print(f"{ano}: pago R$ {total_ano[ano] / 1e9:.2f} bi; sem cidade R$ {sem_cidade[ano] / 1e9:.2f} bi")
    anos = list(range(PRIMEIRO_ANO, ano_atual + 1))
    por_uf = collections.defaultdict(dict)
    for (cod, ano), v in pago.items():
        lista = sorted(autores[(cod, ano)].items(), key=lambda x: -x[1])
        topo = [[a, round(x)] for a, x in lista[:MAX_AUTORES] if x > 0]
        registro = [round(v), round(empenhado[(cod, ano)]), len(emendas[(cod, ano)]), len(lista), topo]
        por_uf[UF_DO_CODIGO[cod[:2]]].setdefault(cod, {})[str(ano)] = registro
    hoje = dt.date.today().isoformat()
    for uf, cidades in sorted(por_uf.items()):
        gravar_json(f"{DESTINO}/{uf}.json", {
            "uf": uf, "atualizado": hoje, "fonte": URL, "anos": anos,
            "campos": ["pago", "empenhado", "emendas", "autores", "maiores_autores"],
            "cidades": cidades,
        })
    print(f"gravados {len(por_uf)} estados, {sum(len(c) for c in por_uf.values())} cidades com emendas desde {PRIMEIRO_ANO}")


if __name__ == "__main__":
    main()
