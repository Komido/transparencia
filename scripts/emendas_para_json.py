#!/usr/bin/env python3
"""Emendas parlamentares pagas a cada prefeitura, por ano e por autor.

Fonte oficial: Portal da Transparência (CGU), arquivo único de emendas
parlamentares (sem chave):
  https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/UNICO
  que redireciona para
  https://dadosabertos-download.cgu.gov.br/PortalDaTransparencia/saida/emendas-parlamentares/EmendasParlamentares.zip

Conferido em 17/11/2026 (inspeção pelo GitHub): zip de 47 MB com 6 arquivos.
O principal (EmendasParlamentares.csv) traz o lugar de aplicação de cada
emenda, mas em 2024 só R$ 1,9 de R$ 40,3 bilhões pagos tinham município; o
resto aparece como estado, nacional ou vários lugares. Por isso a conta da
cidade usa EmendasParlamentares_PorFavorecido.csv (latin-1, ";", 835 mil
linhas): cada pagamento com o autor, o tipo da emenda, o ano e mês do
pagamento, o favorecido, a natureza jurídica e o município do favorecido.

Entram só pagamentos à própria prefeitura e aos fundos municipais (natureza
jurídica "Município" ou "Fundo Público da Administração Direta Municipal"):
é o dinheiro de emenda que chegou à prefeitura. Pagamentos a empresas,
associações e pessoas ficam fora (estar sediado na cidade não quer dizer que
o dinheiro foi para a cidade). O ano é o do pagamento.

O arquivo traz o nome do município, não o código; a ligação com o código do
IBGE é pelo nome e pela UF, sem acento e sem diferença de maiúsculas, com a
lista de municípios do IBGE. Se mais de 0,5% do valor ficar sem cidade, o
script falha sem gravar.

Saídas:
  site/dados/emendas/UF.json   por cidade e ano: valor pago à prefeitura,
                               número de emendas, número de autores e os
                               autores que mais mandaram (até 5)
"""

import collections
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import unicodedata
import urllib.request
import zipfile

URL = "https://dadosabertos-download.cgu.gov.br/PortalDaTransparencia/saida/emendas-parlamentares/EmendasParlamentares.zip"
IBGE = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado"
AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
DESTINO = "site/dados/emendas"
ARQUIVO = "EmendasParlamentares_PorFavorecido.csv"
COLUNAS = ["Código da Emenda", "Nome do Autor da Emenda", "Tipo de Emenda", "Ano/Mês", "Natureza Jurídica",
           "UF Favorecido", "Município Favorecido", "Valor Recebido"]
NATUREZAS = {"Município", "Fundo Público da Administração Direta Municipal"}
PRIMEIRO_ANO = 2019
MAX_AUTORES = 5
MAXIMO_SEM_CIDADE = 0.005


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


def chave_nome(nome):
    """'Santa Bárbara d'Oeste' -> 'SANTA BARBARA D OESTE'."""
    t = unicodedata.normalize("NFKD", nome or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).upper()
    for c in "'`´-.":
        t = t.replace(c, " ")
    return " ".join(t.split())


def municipios_ibge():
    d = json.loads(baixar(IBGE))
    mapa = {}
    for m in d:
        cod, uf = str(m.get("municipio-id")), m.get("UF-sigla")
        if len(cod) != 7 or not cod.isdigit() or not uf:
            falhar(f"município do IBGE fora do padrão: {m}")
        mapa[(chave_nome(m.get("municipio-nome")), uf)] = cod
    if not 5560 <= len(mapa) <= 5580:
        falhar(f"lista do IBGE com {len(mapa)} municípios")
    return mapa


def gravar_json(caminho, dados):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(temporario, caminho)


def main():
    mapa = municipios_ibge()
    z = zipfile.ZipFile(io.BytesIO(baixar(URL)))
    if ARQUIVO not in z.namelist():
        falhar(f"{ARQUIVO} não está no zip: {z.namelist()}")
    leitor = csv.DictReader(io.StringIO(z.read(ARQUIVO).decode("latin-1")), delimiter=";")
    faltam = [c for c in COLUNAS if c not in (leitor.fieldnames or [])]
    if faltam:
        falhar(f"colunas ausentes: {faltam}")
    ano_atual = dt.date.today().year
    pago = collections.defaultdict(float)
    emendas = collections.defaultdict(set)
    autores = collections.defaultdict(lambda: collections.defaultdict(float))
    total_ano = collections.defaultdict(float)
    sem_cidade = collections.defaultdict(float)
    linhas = 0
    for n, l in enumerate(leitor, start=2):
        linhas += 1
        am = (l["Ano/Mês"] or "").strip()
        if len(am) != 6 or not am.isdigit() or not 2010 <= int(am[:4]) <= ano_atual or not 1 <= int(am[4:]) <= 12:
            falhar(f"linha {n}: ano/mês {am!r}")
        ano = int(am[:4])
        if ano < PRIMEIRO_ANO or (l["Natureza Jurídica"] or "").strip() not in NATUREZAS:
            continue
        valor = numero(l["Valor Recebido"], f"linha {n}")
        uf = (l["UF Favorecido"] or "").strip()
        cod = mapa.get((chave_nome(l["Município Favorecido"]), uf))
        total_ano[ano] += valor
        if not cod:
            sem_cidade[(l["Município Favorecido"], uf)] += valor
            continue
        chave = (cod, ano)
        pago[chave] += valor
        emendas[chave].add(l["Código da Emenda"])
        autor = (l["Nome do Autor da Emenda"] or "").strip() or "Sem informação"
        autores[chave][autor] += valor
    if not 500000 <= linhas <= 3000000:
        falhar(f"{linhas} linhas no arquivo; esperado perto de 835 mil")
    total = sum(total_ano.values())
    fora = sum(sem_cidade.values())
    print(f"pago a prefeituras e fundos municipais desde {PRIMEIRO_ANO}: R$ {total / 1e9:.2f} bi; sem cidade: R$ {fora / 1e6:.1f} mi")
    for ano in sorted(total_ano):
        print(f"  {ano}: R$ {total_ano[ano] / 1e9:.2f} bi")
    if sem_cidade:
        print("sem cidade (maiores):", sorted(sem_cidade.items(), key=lambda x: -x[1])[:15])
    if total <= 0 or fora > MAXIMO_SEM_CIDADE * total:
        falhar(f"R$ {fora:,.2f} sem cidade, mais de {MAXIMO_SEM_CIDADE:.1%} do total")
    anos = list(range(PRIMEIRO_ANO, ano_atual + 1))
    por_uf = collections.defaultdict(dict)
    uf_do_codigo = {cod: uf for (_, uf), cod in mapa.items()}
    for (cod, ano), v in pago.items():
        lista = sorted(autores[(cod, ano)].items(), key=lambda x: -x[1])
        topo = [[a, round(x)] for a, x in lista[:MAX_AUTORES] if x > 0]
        por_uf[uf_do_codigo[cod]].setdefault(cod, {})[str(ano)] = [round(v), len(emendas[(cod, ano)]), len(lista), topo]
    hoje = dt.date.today().isoformat()
    for uf, cidades in sorted(por_uf.items()):
        gravar_json(f"{DESTINO}/{uf}.json", {
            "uf": uf, "atualizado": hoje, "fonte": URL, "anos": anos,
            "campos": ["pago", "emendas", "autores", "maiores_autores"],
            "cidades": cidades,
        })
    print(f"gravados {len(por_uf)} estados, {sum(len(c) for c in por_uf.values())} cidades com emendas desde {PRIMEIRO_ANO}")


if __name__ == "__main__":
    main()
