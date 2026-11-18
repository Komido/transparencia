#!/usr/bin/env python3
"""Em que cada Câmara Municipal gaúcha gastou, por ano e por tipo de despesa.

Fonte oficial: Tribunal de Contas do Estado do Rio Grande do Sul, portal de
dados abertos, conjunto "Despesa orçamentária por empenhos <ano>"
(consolidado), um arquivo por ano com todos os empenhos, liquidações e
pagamentos dos órgãos dos 497 municípios gaúchos:
  https://dados.tce.rs.gov.br/dataset/despesa-orcamentaria-por-empenhos-AAAA
  https://dados.tce.rs.gov.br/dados/municipal/empenhos/AAAA.csv.zip

Conferido em 18/11/2026 (inspeção pelo GitHub): o arquivo de 2025 tem 1,35 GB
compactados (um CSV de 14,7 GB, UTF-8, ",", 48 colunas, 26,9 milhões de
linhas). Cada linha é uma operação: "E" (empenho), "L" (liquidação) ou "P"
(pagamento), com o ano e a data da operação. O tipo de unidade "CMM" é a
Câmara Municipal (tabela de apoio "Tipos de unidade orçamentária"); as 497
câmaras se chamam "CM DE <município>". O arquivo traz o código do órgão no
tribunal, não o do IBGE: a câmara é ligada à cidade pelo nome, sem acento e
sem pontuação, com a lista de municípios do site; se alguma não casar, o
script falha sem gravar.

O robots.txt do portal proíbe /api/ e pede 10 segundos entre pedidos: o
script só usa /dados/ e espera 10 segundos entre um pedido e outro.

Entram só as operações "P" do próprio ano e das câmaras, menos as
intra-orçamentárias (modalidade 91), como em SP. O tipo vem da rubrica (o
elemento com o subelemento), agrupado nas mesmas categorias de SP; no
TCE-RS, o subsídio dos vereadores é o subelemento 74. Só entram anos
completos: o arquivo do ano ainda em andamento não chega ao mês 12 de
recebimento e fica de fora. Sem nomes de pessoas na saída.

Saída: site/dados/camaras/RS.json, no mesmo formato de SP.json.
"""

import collections
import csv
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import urllib.robotparser
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camaras_sp_para_json as comum  # noqa: E402

AGENTE = comum.AGENTE
BASE = "https://dados.tce.rs.gov.br"
ARQUIVO = BASE + "/dados/municipal/empenhos/{ano}.csv.zip"
FONTE = BASE + "/dataset?q=%22Despesa+or%C3%A7ament%C3%A1ria+por+empenhos%22&tags=Consolidado"
DESTINO = "site/dados/camaras/RS.json"
MUNICIPIOS = "site/dados/municipios/RS.json"
TEMPORARIO = os.environ.get("RUNNER_TEMP", "/tmp")
ANOS_GUARDADOS = 2
ANOS_PROCURADOS = 4
MINIMO_DE_CAMARAS = 480
VERSAO_DA_CONTA = 1
SUBSIDIO = ("74",)
COLUNAS = ["mes_recebimento", "cd_orgao", "nome_orgao", "tp_unidade", "tipo_operacao", "ano_operacao",
           "cd_elemento", "cd_rubrica", "vl_pagamento"]

atraso = [10.0]
ultimo = [0.0]
robots = urllib.robotparser.RobotFileParser()


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def pedir(url, metodo="GET", cabecalhos=None, tempo=300):
    """Um pedido ao portal, com o intervalo que o robots.txt pede."""
    espera = atraso[0] - (time.time() - ultimo[0])
    if espera > 0:
        time.sleep(espera)
    ultimo[0] = time.time()
    if not url.endswith("/robots.txt") and not robots.can_fetch(AGENTE, url):
        falhar(f"o robots.txt do portal não permite {url}")
    req = urllib.request.Request(url, method=metodo, headers={"User-Agent": AGENTE, **(cabecalhos or {})})
    return urllib.request.urlopen(req, timeout=tempo)


def ler_robots():
    with pedir(BASE + "/robots.txt") as r:
        linhas = r.read().decode("utf-8", "replace").splitlines()
    robots.parse(linhas)
    atraso[0] = max(10.0, float(robots.crawl_delay(AGENTE) or 0))
    print(f"robots.txt: intervalo de {atraso[0]:.0f} s entre pedidos", flush=True)


def cabecalho(ano):
    """(tamanho, data) do arquivo do ano, ou None se não existe."""
    try:
        with pedir(ARQUIVO.format(ano=ano), metodo="HEAD", tempo=60) as r:
            return int(r.headers["Content-Length"]), r.headers.get("Last-Modified", "")
    except urllib.error.HTTPError as erro:
        if erro.code == 404:
            return None
        raise


def baixar(url, destino, tamanho):
    """Um pedido só; se cair, retoma do ponto em que parou."""
    if os.path.exists(destino):
        os.remove(destino)
    falhas = 0
    inicio = time.time()
    while (feito := os.path.getsize(destino) if os.path.exists(destino) else 0) < tamanho:
        cab = {"Range": f"bytes={feito}-"} if feito else None
        try:
            with pedir(url, cabecalhos=cab, tempo=600) as r, open(destino, "ab") as fh:
                if feito and r.status != 206:
                    falhar(f"o servidor não retomou o download (HTTP {r.status})")
                while bloco := r.read(1 << 20):
                    fh.write(bloco)
        except (urllib.error.URLError, OSError, TimeoutError) as erro:
            falhas += 1
            print(f"  falha {falhas} em {feito / 1e6:.0f} MB: {erro}", flush=True)
            if falhas > 10:
                falhar(f"o download de {url} falhou demais")
    if os.path.getsize(destino) != tamanho:
        falhar(f"arquivo com tamanho errado: {os.path.getsize(destino)} em vez de {tamanho}")
    print(f"  baixado em {(time.time() - inicio) / 60:.1f} min", flush=True)


def chave(nome):
    """'Sant'Ana do Livramento' -> 'SANT ANA DO LIVRAMENTO'."""
    t = "".join(c for c in unicodedata.normalize("NFD", nome or "") if not unicodedata.combining(c)).upper()
    return " ".join(re.sub(r"[^A-Z0-9]+", " ", t).split())


def somar(caminho, ano):
    """{cd_orgao: [total, [por categoria]]}, {cd_orgao: nome} e se o ano está completo."""
    z = zipfile.ZipFile(caminho)
    nomes = [i for i in z.infolist() if i.filename.lower().endswith(".csv")]
    if len(nomes) != 1:
        falhar(f"esperava um CSV no zip de {ano}, achei {[i.filename for i in z.infolist()]}")
    por_orgao = {}
    nome_do_orgao = {}
    meses = set()
    intra = 0.0
    linhas = 0
    inicio = time.time()
    ano_txt = str(ano)
    with z.open(nomes[0]) as bruto:
        leitor = csv.reader(io.TextIOWrapper(bruto, encoding="utf-8-sig", newline=""))
        cab = next(leitor)
        faltam = [c for c in COLUNAS if c not in cab]
        if faltam:
            falhar(f"colunas sumiram do arquivo de {ano}: {faltam}")
        i_mes, i_org, i_nome, i_tp, i_op, i_ano, i_el, i_rub, i_val = (cab.index(c) for c in COLUNAS)
        for l in leitor:
            linhas += 1
            if l[i_mes] not in meses:
                meses.add(l[i_mes])
            if l[i_tp] != "CMM" or l[i_op] != "P" or l[i_ano] != ano_txt:
                continue
            try:
                valor = float(l[i_val] or 0)
            except ValueError:
                falhar(f"valor inválido {l[i_val]!r} na linha {linhas} do arquivo de {ano}")
            cod = re.sub(r"\D", "", l[i_rub]) or re.sub(r"\D", "", l[i_el])
            if cod[2:4] == "91":
                intra += valor
                continue
            org = l[i_org].strip()
            nome_do_orgao.setdefault(org, l[i_nome].strip())
            item = por_orgao.setdefault(org, [0.0, [0.0] * len(comum.CATEGORIAS)])
            item[0] += valor
            item[1][comum.INDICE[comum.categoria(cod, SUBSIDIO)]] += valor
    completo = "12" in meses
    print(f"  {ano}: {linhas} linhas lidas em {(time.time() - inicio) / 60:.1f} min; meses de recebimento: "
          f"{sorted(meses, key=lambda m: int(m) if m.isdigit() else 0)}; {len(por_orgao)} câmaras; "
          f"intra-orçamentário deixado de fora: R$ {intra / 1e6:.1f} milhões", flush=True)
    return por_orgao, nome_do_orgao, completo


def ligar_cidades(nome_do_orgao):
    """{cd_orgao: código IBGE}, pelo nome "CM DE <município>"."""
    m = json.load(open(MUNICIPIOS, encoding="utf-8"))
    por_nome = {chave(x["n"]): str(x["c"]) for x in m["municipios"]}
    ligacao, sem_cidade = {}, []
    for org, nome in nome_do_orgao.items():
        cidade = re.sub(r"^\s*CM\s+DE\s+", "", nome.upper())
        cod = por_nome.get(chave(cidade))
        if cod:
            ligacao[org] = cod
        else:
            sem_cidade.append(nome)
    if sem_cidade:
        falhar(f"câmaras sem cidade na lista do IBGE: {sorted(sem_cidade)[:20]}")
    repetidas = [c for c, n in collections.Counter(ligacao.values()).items() if n > 1]
    if repetidas:
        falhar(f"mais de uma câmara ligada à mesma cidade: {repetidas[:10]}")
    return ligacao


def main():
    try:
        antigo = json.load(open(DESTINO, encoding="utf-8"))
    except OSError:
        antigo = {}
    ler_robots()
    atual = datetime.now(timezone.utc).year
    arquivos = {}
    cidades = collections.defaultdict(dict)
    anos = []
    mudou = False
    for ano in range(atual, atual - ANOS_PROCURADOS, -1):
        if len(anos) == ANOS_GUARDADOS:
            break
        info = cabecalho(ano)
        if info is None:
            print(f"{ano}: o portal ainda não tem o arquivo", flush=True)
            continue
        tamanho, modificado = info
        visto = (antigo.get("arquivos") or {}).get(str(ano)) or {}
        arquivos[str(ano)] = {"tamanho": tamanho, "modificado": modificado}
        mesmo = (visto.get("tamanho"), visto.get("modificado")) == (tamanho, modificado) and antigo.get("versao") == VERSAO_DA_CONTA
        if mesmo and visto.get("incompleto"):
            print(f"{ano}: sem mudança desde a última vez e ainda incompleto", flush=True)
            arquivos[str(ano)]["incompleto"] = True
            continue
        if mesmo and ano in (antigo.get("anos") or []):
            print(f"{ano}: sem mudança desde a última vez ({modificado})", flush=True)
            for cod, por_ano in (antigo.get("cidades") or {}).items():
                if str(ano) in por_ano:
                    cidades[cod][str(ano)] = por_ano[str(ano)]
            anos.append(ano)
            continue
        mudou = True
        print(f"{ano}: baixando {tamanho / 1e6:.0f} MB ({modificado})", flush=True)
        caminho = os.path.join(TEMPORARIO, f"rs-empenhos-{ano}.zip")
        baixar(ARQUIVO.format(ano=ano), caminho, tamanho)
        por_orgao, nome_do_orgao, completo = somar(caminho, ano)
        os.remove(caminho)
        if not completo:
            print(f"{ano}: o ano ainda não fechou no tribunal (sem o mês 12 de recebimento); fica de fora", flush=True)
            arquivos[str(ano)]["incompleto"] = True
            continue
        if len(por_orgao) < MINIMO_DE_CAMARAS:
            falhar(f"só {len(por_orgao)} câmaras em {ano}; esperava pelo menos {MINIMO_DE_CAMARAS}")
        ligacao = ligar_cidades(nome_do_orgao)
        for org, (total, partes) in por_orgao.items():
            cidades[ligacao[org]][str(ano)] = [round(total), [round(x) for x in partes]]
        anos.append(ano)
    if not mudou:
        print("Nenhum arquivo mudou; nada a gravar.")
        return
    anos.sort()
    if not anos:
        falhar("nenhum ano completo no portal")
    comum.conferir_com_siconfi(cidades, anos, MUNICIPIOS, minimo=200)
    for ano in anos:
        tot = [0.0] * len(comum.CATEGORIAS)
        for por_ano in cidades.values():
            for i, v in enumerate(por_ano.get(str(ano), [0, [0] * len(comum.CATEGORIAS)])[1]):
                tot[i] += v
        soma = sum(tot) or 1
        print(f"  {ano}, todas as câmaras: " + "; ".join(f"{r} {v / 1e6:.0f} mi ({v / soma:.0%})"
                                                         for (_, r), v in zip(comum.CATEGORIAS, tot)))
        sem = sum(1 for v in cidades.values() if str(ano) in v and v[str(ano)][1][0] <= 0)
        print(f"  {ano}: câmaras sem nenhum pagamento de subsídio: {sem}")
    comum.gravar_json(DESTINO, {
        "uf": "RS",
        "versao": VERSAO_DA_CONTA,
        "tribunal": "Tribunal de Contas do Estado do Rio Grande do Sul",
        "atualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "fonte": FONTE,
        "arquivos": arquivos,
        "anos": anos,
        "categorias": [list(c) for c in comum.CATEGORIAS],
        "cidades": {cod: dict(sorted(v.items())) for cod, v in sorted(cidades.items()) if any(a in v for a in map(str, anos))},
    })
    print(f"gravado {DESTINO}: {len(cidades)} câmaras")


if __name__ == "__main__":
    main()
