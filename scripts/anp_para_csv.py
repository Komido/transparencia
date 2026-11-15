#!/usr/bin/env python3
"""Converte as médias mensais de preços de combustíveis da ANP (Excel) em CSV.

Fonte: Levantamento de Preços de Combustíveis (LPC) da Agência Nacional do
Petróleo, Gás Natural e Biocombustíveis, médias mensais para o Brasil.

Saída:
  dados-fonte/anp/precos-mensais-brasil.csv  (mes, produto, unidade, preco_medio_revenda, postos_pesquisados)
  dados-fonte/anp/origem.json                (URL, tamanho e SHA-256 de cada arquivo original)

O script não interpreta nem corrige valores: só copia as colunas da planilha.
Se o layout mudar (cabeçalho não encontrado, mês ou preço inválido), ele falha
e não grava nada, e o site continua com a versão anterior.
"""

import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request

from openpyxl import load_workbook

BASE = "https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/precos-revenda-e-de-distribuicao-combustiveis/shlp"
ARQUIVOS = [
    f"{BASE}/2001-2012/mensal-brasil-2001-a-2012.xlsx",
    f"{BASE}/mensal/mensal-brasil-desde-jan2013.xlsx",
]
DESTINO = "dados-fonte/anp"
PRODUTOS_ESPERADOS = {"GASOLINA COMUM", "ETANOL HIDRATADO", "OLEO DIESEL", "GLP"}
MESES = {"JAN": 1, "FEV": 2, "MAR": 3, "ABR": 4, "MAI": 5, "JUN": 6,
         "JUL": 7, "AGO": 8, "SET": 9, "OUT": 10, "NOV": 11, "DEZ": 12}


def normalizar(texto):
    if texto is None:
        return ""
    texto = unicodedata.normalize("NFKD", str(texto))
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", texto).strip().upper()


def baixar(url):
    pedido = urllib.request.Request(url, headers={"User-Agent": "ArrecadometroBrasil/1.0 (dados publicos)"})
    with urllib.request.urlopen(pedido, timeout=120) as resposta:
        return resposta.read()


def mes_de(valor):
    """Aceita data do Excel ou texto como 'jan/13' ou '01/2013'."""
    if isinstance(valor, (dt.datetime, dt.date)):
        return f"{valor.year:04d}-{valor.month:02d}"
    texto = normalizar(valor)
    m = re.match(r"^([A-Z]{3})[/-](\d{2}|\d{4})$", texto)
    if m and m.group(1) in MESES:
        ano = int(m.group(2))
        ano = ano + 2000 if ano < 100 else ano
        return f"{ano:04d}-{MESES[m.group(1)]:02d}"
    m = re.match(r"^(\d{1,2})[/-](\d{4})$", texto)
    if m:
        return f"{int(m.group(2)):04d}-{int(m.group(1)):02d}"
    return None


def numero(valor):
    if isinstance(valor, (int, float)):
        return float(valor)
    texto = str(valor).strip().replace(".", "").replace(",", ".") if valor is not None else ""
    try:
        return float(texto)
    except ValueError:
        return None


def mostrar_estrutura(planilha, linhas):
    print(f"  planilha '{planilha}': primeiras linhas")
    for i, linha in enumerate(linhas[:22]):
        celulas = [str(c)[:28] for c in linha[:12] if c is not None]
        if celulas:
            print(f"    {i:>3}: {' | '.join(celulas)}")


def ler(conteudo, url):
    livro = load_workbook(io.BytesIO(conteudo), read_only=True, data_only=True)
    registros = []
    for planilha in livro.worksheets:
        linhas = [tuple(l) for l in planilha.iter_rows(values_only=True)]
        mostrar_estrutura(planilha.title, linhas)
        cabecalho = None
        for i, linha in enumerate(linhas[:80]):
            norm = [normalizar(c) for c in linha]
            if "PRODUTO" in norm and any(c in ("MES", "DATA") for c in norm) and "PRECO MEDIO REVENDA" in norm:
                cabecalho = (i, norm)
                break
        if not cabecalho:
            continue
        inicio, norm = cabecalho
        i_mes = next(k for k, c in enumerate(norm) if c in ("MES", "DATA"))
        i_prod = norm.index("PRODUTO")
        i_preco = norm.index("PRECO MEDIO REVENDA")
        i_unid = next((k for k, c in enumerate(norm) if c.startswith("UNIDADE")), None)
        i_postos = next((k for k, c in enumerate(norm) if "POSTOS" in c), None)
        print(f"  cabeçalho na linha {inicio}: mês={i_mes} produto={i_prod} preço={i_preco} unidade={i_unid} postos={i_postos}")
        for linha in linhas[inicio + 1:]:
            if all(c is None for c in linha):
                continue
            mes = mes_de(linha[i_mes])
            produto = normalizar(linha[i_prod])
            preco = numero(linha[i_preco])
            if mes is None or not produto:
                raise SystemExit(f"Linha inválida em {url}: {linha[:6]}")
            if preco is None or preco <= 0:
                # A ANP deixa em branco produtos não pesquisados naquele mês.
                continue
            registros.append({
                "mes": mes,
                "produto": produto,
                "unidade": normalizar(linha[i_unid]) if i_unid is not None else "",
                "preco_medio_revenda": round(preco, 4),
                "postos_pesquisados": int(numero(linha[i_postos])) if i_postos is not None and numero(linha[i_postos]) else "",
            })
    if not registros:
        raise SystemExit(f"Nenhum cabeçalho reconhecido em {url}. Veja a estrutura impressa acima.")
    return registros


def main():
    todos = {}
    origem = []
    for url in ARQUIVOS:
        print(f"Baixando {url}")
        conteudo = baixar(url)
        origem.append({"url": url, "bytes": len(conteudo), "sha256": hashlib.sha256(conteudo).hexdigest()})
        for r in ler(conteudo, url):
            chave = (r["mes"], r["produto"])
            if chave in todos and todos[chave]["preco_medio_revenda"] != r["preco_medio_revenda"]:
                raise SystemExit(f"Valores diferentes para o mesmo mês e produto: {chave}")
            todos[chave] = r

    produtos = {r["produto"] for r in todos.values()}
    faltando = PRODUTOS_ESPERADOS - produtos
    if faltando:
        raise SystemExit(f"Produtos esperados ausentes: {sorted(faltando)}. Encontrados: {sorted(produtos)}")
    meses = sorted({r["mes"] for r in todos.values()})
    if len(meses) < 200:
        raise SystemExit(f"Poucos meses ({len(meses)}); o layout pode ter mudado.")
    print(f"OK: {len(todos)} registros, {len(meses)} meses ({meses[0]} a {meses[-1]}), produtos: {sorted(produtos)}")

    os.makedirs(DESTINO, exist_ok=True)
    caminho_csv = os.path.join(DESTINO, "precos-mensais-brasil.csv")
    buffer = io.StringIO()
    escritor = csv.DictWriter(buffer, fieldnames=["mes", "produto", "unidade", "preco_medio_revenda", "postos_pesquisados"], lineterminator="\n")
    escritor.writeheader()
    for chave in sorted(todos):
        escritor.writerow(todos[chave])
    novo = buffer.getvalue()

    anterior = open(caminho_csv, encoding="utf-8").read() if os.path.exists(caminho_csv) else None
    if novo == anterior:
        print("CSV sem mudança.")
        return
    with open(caminho_csv, "w", encoding="utf-8") as f:
        f.write(novo)
    with open(os.path.join(DESTINO, "origem.json"), "w", encoding="utf-8") as f:
        json.dump({
            "fonte": "ANP, Levantamento de Preços de Combustíveis, médias mensais Brasil",
            "convertido_em": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "arquivos": origem,
        }, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("CSV atualizado.")


if __name__ == "__main__":
    main()
