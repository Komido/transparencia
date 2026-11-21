#!/usr/bin/env python3
"""Converte o preço médio de aluguel do Índice FipeZAP (Excel) em CSV.

Fonte: Índice FipeZAP, da Fipe, calculado com anúncios de apartamentos para
locação nos portais do Grupo OLX (Zap, Viva Real e OLX). Planilha pública
"séries históricas", aba "Índice FipeZAP" (média das cidades acompanhadas).
Segundo a própria planilha, os preços mensais são médias móveis de 3 meses.

Saída:
  dados-fonte/fipezap/aluguel-indice-fipezap.csv   (mes, aluguel_m2): média das cidades
  dados-fonte/fipezap/aluguel-cidades-fipezap.csv  (mes, cidade, uf, aluguel_m2): uma aba por cidade
  dados-fonte/fipezap/origem.json                  (URL, tamanho e SHA-256 do original)

Cidades sem preço de locação na planilha ("não disponível") ficam de fora.
A UF de cada cidade vem da aba de resumo.

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
import time
import unicodedata
import urllib.error
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


def baixar(url, tentativas=4):
    """O servidor às vezes derruba a conexão (21/11/2026: "connection reset").
    Tenta de novo com espera crescente; erro 4xx (fora 429) não se repete."""
    for k in range(tentativas):
        try:
            pedido = urllib.request.Request(url, headers={"User-Agent": "ArrecadometroBrasil/1.0 (dados publicos)"})
            with urllib.request.urlopen(pedido, timeout=120) as resposta:
                return resposta.read()
        except (urllib.error.URLError, OSError) as erro:
            definitivo = isinstance(erro, urllib.error.HTTPError) and erro.code < 500 and erro.code != 429
            if definitivo or k == tentativas - 1:
                raise
            print(f"  tentativa {k + 1} falhou: {erro}; nova tentativa em {30 * (k + 1)} s", flush=True)
            time.sleep(30 * (k + 1))


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


def ler_aba(aba, obrigatoria):
    """Série de preço de locação de uma aba, ou None se a aba não tem locação."""
    linhas = [tuple(l) for l in aba.iter_rows(values_only=True)]
    try:
        primeira, col_data, col_preco = localizar_coluna(linhas)
    except SystemExit:
        if obrigatoria:
            raise
        return None

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

    if not registros:
        if obrigatoria:
            raise SystemExit(f"Aba '{aba.title}' sem preços de locação.")
        return None
    meses = [r["mes"] for r in registros]
    if meses != sorted(set(meses)):
        raise SystemExit(f"Meses fora de ordem ou repetidos na aba '{aba.title}'.")
    return registros


def ler(conteudo):
    livro = load_workbook(io.BytesIO(conteudo), read_only=True, data_only=True)
    abas = {normalizar(p.title): p for p in livro.worksheets}
    if ABA not in abas or "RESUMO" not in abas:
        raise SystemExit(f"Abas esperadas não encontradas. Abas: {livro.sheetnames}")

    # Resumo: nome da cidade, UF e os números do último mês de cada linha.
    resumo = {}
    for linha in abas["RESUMO"].iter_rows(values_only=True):
        nome = normalizar(linha[0])
        uf = linha[2] if len(linha) > 2 else None
        numeros = [c for c in linha if isinstance(c, (int, float))]
        if nome:
            resumo[nome] = {"uf": uf, "numeros": numeros}

    def conferir(nome, registros):
        # O último valor da série precisa aparecer na linha da aba de resumo.
        linha = resumo.get(normalizar(nome))
        if linha is None or not any(abs(n - registros[-1]["aluguel_m2"]) < 1e-3 for n in linha["numeros"]):
            raise SystemExit(f"O último preço de '{nome}' não aparece na aba de resumo.")

    indice = ler_aba(abas[ABA], obrigatoria=True)
    if len(indice) < 150:
        raise SystemExit(f"Poucos meses no índice ({len(indice)}); o layout pode ter mudado.")
    conferir("Índice FipeZAP", indice)

    cidades = []
    for chave, aba in abas.items():
        if chave in (ABA, "RESUMO", "AUX"):
            continue
        registros = ler_aba(aba, obrigatoria=False)
        if registros is None:
            print(f"  {aba.title}: sem locação")
            continue
        uf = resumo.get(chave, {}).get("uf")
        if not (isinstance(uf, str) and re.fullmatch(r"[A-Z]{2}", uf)):
            raise SystemExit(f"UF de '{aba.title}' não encontrada na aba de resumo.")
        conferir(aba.title, registros)
        for r in registros:
            cidades.append({"mes": r["mes"], "cidade": aba.title.strip(), "uf": uf, "aluguel_m2": r["aluguel_m2"]})
        print(f"  {aba.title} ({uf}): {len(registros)} meses, último R$ {registros[-1]['aluguel_m2']}/m²")
    if len({c["cidade"] for c in cidades}) < 15:
        raise SystemExit("Poucas cidades com locação; o layout pode ter mudado.")
    return indice, cidades


def main():
    print(f"Baixando {URL}")
    conteudo = baixar(URL)
    registros, cidades = ler(conteudo)
    print(f"OK: {len(registros)} meses, de {registros[0]['mes']} a {registros[-1]['mes']}; último R$ {registros[-1]['aluguel_m2']}/m²")
    print(f"OK: {len({c['cidade'] for c in cidades})} cidades com locação")

    def gerar(campos, linhas):
        buffer = io.StringIO()
        escritor = csv.DictWriter(buffer, fieldnames=campos, lineterminator="\n")
        escritor.writeheader()
        escritor.writerows(linhas)
        return buffer.getvalue()

    os.makedirs(DESTINO, exist_ok=True)
    arquivos = {
        "aluguel-indice-fipezap.csv": gerar(["mes", "aluguel_m2"], registros),
        "aluguel-cidades-fipezap.csv": gerar(["mes", "cidade", "uf", "aluguel_m2"],
                                             sorted(cidades, key=lambda c: (c["uf"], c["cidade"], c["mes"]))),
    }
    mudou = False
    for nome, novo in arquivos.items():
        caminho = os.path.join(DESTINO, nome)
        anterior = open(caminho, encoding="utf-8").read() if os.path.exists(caminho) else None
        if novo != anterior:
            with open(caminho, "w", encoding="utf-8") as f:
                f.write(novo)
            mudou = True
    if not mudou:
        print("CSVs sem mudança.")
        return
    with open(os.path.join(DESTINO, "origem.json"), "w", encoding="utf-8") as f:
        json.dump({
            "fonte": "Fipe, Índice FipeZAP, locação residencial, preço médio (R$/m²), média das cidades e cada cidade",
            "convertido_em": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "arquivos": [{"url": URL, "bytes": len(conteudo), "sha256": hashlib.sha256(conteudo).hexdigest()}],
        }, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("CSV atualizado.")


if __name__ == "__main__":
    main()
