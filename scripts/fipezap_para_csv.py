#!/usr/bin/env python3
"""Converte o preço médio de aluguel do Índice FipeZAP (Excel) em CSV.

Fonte: Índice FipeZAP, da Fipe, calculado com anúncios de apartamentos para
locação nos portais do Grupo OLX (Zap, Viva Real e OLX). Planilha pública
"séries históricas", aba "Índice FipeZAP" (média das cidades acompanhadas).
Segundo a própria planilha, os preços mensais são médias móveis de 3 meses.

Saída:
  dados-fonte/fipezap/aluguel-indice-fipezap.csv  (mes, aluguel_m2)
  dados-fonte/fipezap/origem.json                 (URL, tamanho e SHA-256 do original)

aluguel_m2 é a coluna "Locação > Preço médio (R$/m²) > Total". O script só
copia o valor da planilha. Se o layout mudar, ele falha sem gravar nada e o
site continua com a versão anterior.
"""

import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import unicodedata
import urllib.request

from openpyxl import load_workbook

URL = "https://downloads.fipe.org.br/indices/fipezap/fipezap-serieshistoricas.xlsx"
DESTINO = "dados-fonte/fipezap"
ABA = "INDICE FIPEZAP"


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


def localizar_coluna(linhas):
    """Coluna do preço médio de locação, total de dormitórios."""
    inicio_locacao = None
    for linha in linhas[:10]:
        norm = [normalizar(c) for c in linha]
        if "LOCACAO" in norm:
            inicio_locacao = norm.index("LOCACAO")
            break
    if inicio_locacao is None:
        raise SystemExit("Bloco 'Locação' não encontrado na aba do índice.")

    for i, linha in enumerate(linhas[:10]):
        norm = [normalizar(c) for c in linha]
        colunas = [k for k, c in enumerate(norm) if c == "PRECO MEDIO (R$/M2)" and k >= inicio_locacao]
        if not colunas:
            continue
        col = colunas[0]
        abaixo = [normalizar(c) for c in linhas[i + 1]]
        if abaixo[col] != "TOTAL":
            raise SystemExit(f"Esperava 'Total' abaixo do preço médio de locação; achei '{abaixo[col]}'.")
        col_data = next((k for k, c in enumerate(abaixo) if c == "DATA"), None)
        if col_data is None:
            raise SystemExit("Coluna 'Data' não encontrada.")
        return i + 2, col_data, col
    raise SystemExit("Coluna 'Preço médio (R$/m²)' de locação não encontrada.")


def ler(conteudo):
    livro = load_workbook(io.BytesIO(conteudo), read_only=True, data_only=True)
    aba = next((p for p in livro.worksheets if normalizar(p.title) == ABA), None)
    if aba is None:
        raise SystemExit(f"Aba '{ABA}' não encontrada. Abas: {livro.sheetnames}")
    linhas = [tuple(l) for l in aba.iter_rows(values_only=True)]
    primeira, col_data, col_preco = localizar_coluna(linhas)
    print(f"dados a partir da linha {primeira + 1}; data na coluna {col_data}, preço na coluna {col_preco}")

    registros = []
    for linha in linhas[primeira:]:
        data = linha[col_data] if col_data < len(linha) else None
        if not isinstance(data, (dt.datetime, dt.date)):
            continue  # notas de rodapé
        valor = linha[col_preco]
        if not isinstance(valor, (int, float)):
            continue  # "." marca mês sem dado
        if not 5 <= valor <= 500:
            raise SystemExit(f"Preço por m² fora do esperado em {data:%Y-%m}: {valor}")
        registros.append({"mes": f"{data.year:04d}-{data.month:02d}", "aluguel_m2": round(float(valor), 4)})

    meses = [r["mes"] for r in registros]
    if len(registros) < 150:
        raise SystemExit(f"Poucos meses ({len(registros)}); o layout pode ter mudado.")
    if meses != sorted(set(meses)):
        raise SystemExit("Meses fora de ordem ou repetidos.")

    # Conferência cruzada: o último valor precisa aparecer na aba de resumo.
    resumo = next((p for p in livro.worksheets if normalizar(p.title) == "RESUMO"), None)
    if resumo is not None:
        numeros = [c for l in resumo.iter_rows(values_only=True) if normalizar(l[0]) == "INDICE FIPEZAP"
                   for c in l if isinstance(c, (int, float))]
        if not any(abs(n - registros[-1]["aluguel_m2"]) < 1e-3 for n in numeros):
            raise SystemExit("O último preço da série não aparece na aba de resumo.")
    return registros


def main():
    print(f"Baixando {URL}")
    conteudo = baixar(URL)
    registros = ler(conteudo)
    print(f"OK: {len(registros)} meses, de {registros[0]['mes']} a {registros[-1]['mes']}; último R$ {registros[-1]['aluguel_m2']}/m²")

    os.makedirs(DESTINO, exist_ok=True)
    caminho_csv = os.path.join(DESTINO, "aluguel-indice-fipezap.csv")
    buffer = io.StringIO()
    escritor = csv.DictWriter(buffer, fieldnames=["mes", "aluguel_m2"], lineterminator="\n")
    escritor.writeheader()
    escritor.writerows(registros)
    novo = buffer.getvalue()

    anterior = open(caminho_csv, encoding="utf-8").read() if os.path.exists(caminho_csv) else None
    if novo == anterior:
        print("CSV sem mudança.")
        return
    with open(caminho_csv, "w", encoding="utf-8") as f:
        f.write(novo)
    with open(os.path.join(DESTINO, "origem.json"), "w", encoding="utf-8") as f:
        json.dump({
            "fonte": "Fipe, Índice FipeZAP, locação residencial, preço médio (R$/m²), média das cidades acompanhadas",
            "convertido_em": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "arquivos": [{"url": URL, "bytes": len(conteudo), "sha256": hashlib.sha256(conteudo).hexdigest()}],
        }, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("CSV atualizado.")


if __name__ == "__main__":
    main()
