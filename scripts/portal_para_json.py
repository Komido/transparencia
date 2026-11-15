#!/usr/bin/env python3
"""Resume três bases do Portal da Transparência (CGU) por ano e por órgão
superior (ministério): cartão de pagamento do governo federal, execução da
despesa e viagens a serviço.

Fontes oficiais (downloads públicos, sem chave):
  Cartão:   https://portaldatransparencia.gov.br/download-de-dados/cpgf/AAAAMM
            (um zip por mês, desde 2013)
  Despesa:  https://portaldatransparencia.gov.br/download-de-dados/despesas-execucao/AAAAMM
            (um zip por mês, desde 2014; valores lançados no mês)
  Viagens:  https://portaldatransparencia.gov.br/download-de-dados/viagens/AAAA
            (um zip por ano, desde 2015; o de 2011 vem vazio)

Saída:
  site/dados/portal/cartao.json, ministerios.json, viagens.json (o que o site lê)
  dados-fonte/portal/<base>/AAAA.json (somas de cada ano, para refazer a saída
                                       sem baixar de novo os anos antigos)
  dados-fonte/portal/origem.json      (URL, tamanho e SHA-256 de cada original)

O site recebe só somas por ano e órgão. Não grava CPF, CNPJ, favorecido nem
nome de servidor. A exceção são as viagens de quem ocupa cargo de natureza
especial (os ministros de Estado e cargos do mesmo nível): nome, órgão,
número de viagens e valor, como o Portal publica.

Regras:
  Cartão: soma do VALOR TRANSAÇÃO. Lançamentos com "Informações protegidas por
          sigilo" entram no total e são contados à parte; saques em dinheiro
          também.
  Despesa: valor liquidado no mês, somado no ano. "Juros e Encargos da Dívida" e
          "Amortização/Refinanciamento da Dívida" ficam fora da conta por
          órgão e aparecem à parte.
  Viagens: diárias + passagens + outros gastos - devolução, de todas as
          viagens do arquivo. Viagens com dados sob sigilo entram no total e
          são contadas à parte.

Se faltar coluna esperada, se um valor não for número ou se os totais forem
implausíveis, o script falha e não grava nada; o site continua com a versão
anterior.

Uso: python3 scripts/portal_para_json.py [--recentes] [--so cartao|ministerios|viagens]
  --recentes  só o ano corrente e o anterior (os outros anos ficam como estão)
"""

import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
import zipfile

AGENTE = "Mozilla/5.0 (X11; Linux x86_64) ArrecadometroBrasil/1.0"
BASE = "https://portaldatransparencia.gov.br/download-de-dados"
DESTINO = "site/dados/portal"
INTERMEDIARIO = "dados-fonte/portal"
ORIGEM = "dados-fonte/portal/origem.json"
PRIMEIRO_ANO = {"cartao": 2013, "ministerios": 2014, "viagens": 2015}

# Faixas de conferência (valores do ano inteiro, em reais da época). Bem
# largas: servem para pegar arquivo trocado, vazio ou com vírgula lida errado.
FAIXA_ANO = {
    "cartao": (10e6, 1e9),
    "ministerios": (5e11, 1e13),
    "viagens": (1e8, 2e10),
}
MINIMO_LINHAS_MES = {"cartao": 1000, "ministerios": 10000}
MINIMO_LINHAS_ANO = {"viagens": 50000}


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def sem_acento(texto):
    texto = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in texto if not unicodedata.combining(c))


def numero(texto, onde):
    t = (texto or "").strip()
    if t == "":
        return 0.0
    t = t.replace(".", "").replace(",", ".") if "," in t else t
    try:
        return float(t)
    except ValueError:
        falhar(f"valor inválido {texto!r} em {onde}")
        return 0.0


def baixar(url, origem, tentativas=4):
    for k in range(tentativas):
        inicio = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE})
            with urllib.request.urlopen(req, timeout=900) as r:
                bruto = r.read()
            print(f"  baixado {url}: {len(bruto):,} bytes em {time.monotonic() - inicio:.0f} s", flush=True)
            origem[url] = {"bytes": len(bruto), "sha256": hashlib.sha256(bruto).hexdigest()}
            return bruto
        except urllib.error.HTTPError as erro:
            if erro.code in (403, 404):
                print(f"  {url}: HTTP {erro.code}, arquivo ainda não publicado", flush=True)
                return None
            print(f"  tentativa {k + 1} falhou para {url}: {erro}", flush=True)
        except Exception as erro:  # noqa: BLE001
            print(f"  tentativa {k + 1} falhou para {url} depois de {time.monotonic() - inicio:.0f} s: {erro}", flush=True)
        if k == tentativas - 1:
            falhar(f"não foi possível baixar {url}")
        time.sleep(10 * (k + 1))
    return None


def abrir_csv(bruto, sufixo, onde):
    """Leitor do CSV de dentro do zip, sem carregar o texto inteiro na memória."""
    try:
        z = zipfile.ZipFile(io.BytesIO(bruto))
    except zipfile.BadZipFile:
        falhar(f"{onde}: o arquivo baixado não é zip")
    nomes = [n for n in z.namelist() if n.lower().endswith(sufixo.lower())]
    if len(nomes) != 1:
        falhar(f"{onde}: esperado um arquivo terminado em {sufixo}, encontrados {z.namelist()}")
    texto = io.TextIOWrapper(z.open(nomes[0]), encoding="cp1252", errors="replace", newline="")
    leitor = csv.DictReader(texto, delimiter=";")
    if leitor.fieldnames:
        leitor.fieldnames = [c.strip().lstrip("﻿") for c in leitor.fieldnames]
    return leitor


def exigir(leitor, colunas, onde):
    faltam = [c for c in colunas if c not in (leitor.fieldnames or [])]
    if faltam:
        falhar(f"{onde}: faltam colunas {faltam}; colunas do arquivo: {leitor.fieldnames}")


def sigiloso(*textos):
    return any("sigilo" in (t or "").lower() for t in textos)


def nome_proprio(nome):
    """"CELSO SABINO DE OLIVEIRA" -> "Celso Sabino de Oliveira"."""
    pequenas = {"de", "da", "do", "das", "dos", "e"}
    palavras = (nome or "").strip().lower().split()
    return " ".join(p if (k and p in pequenas) else p.capitalize() for k, p in enumerate(palavras))


class Orgaos:
    """Nome de cada órgão superior por ano. O cartão e a despesa cortam o nome
    em cerca de 45 letras; as viagens trazem o nome inteiro. Vale o nome mais
    longo do mesmo código no mesmo ano, ou, em outro ano, um mais longo que
    comece igual."""

    def __init__(self):
        self.por_ano = {}

    def ver(self, ano, codigo, nome):
        codigo = (codigo or "").strip()
        nome = " ".join((nome or "").split())
        if not codigo or not nome:
            return
        atual = self.por_ano.setdefault(ano, {}).get(codigo, "")
        if len(nome) > len(atual):
            self.por_ano[ano][codigo] = nome

    def nome(self, ano, codigo):
        nome = self.por_ano.get(ano, {}).get(codigo, codigo)
        for outros in self.por_ano.values():
            maior = outros.get(codigo, "")
            if len(maior) > len(nome) and maior.startswith(nome):
                nome = maior
        return nome

    def para_json(self):
        return {str(a): v for a, v in self.por_ano.items()}

    def carregar(self, dados):
        for a, v in (dados or {}).items():
            for codigo, nome in v.items():
                self.ver(int(a), codigo, nome)


# ---------------------------------------------------------------------------
# Cartão de pagamento do governo federal
# ---------------------------------------------------------------------------

def ano_cartao(ano, ate_mes, origem, orgaos):
    por = {}
    meses = 0
    for mes in range(1, ate_mes + 1):
        url = f"{BASE}/cpgf/{ano}{mes:02d}"
        bruto = baixar(url, origem)
        if bruto is None:
            break
        leitor = abrir_csv(bruto, ".csv", url)
        exigir(leitor, ["CÓDIGO ÓRGÃO SUPERIOR", "NOME ÓRGÃO SUPERIOR", "TRANSAÇÃO", "VALOR TRANSAÇÃO", "ANO EXTRATO", "MÊS EXTRATO"], url)
        n = 0
        for k, l in enumerate(leitor, start=2):
            n += 1
            onde = f"{url}, linha {k}"
            if l["ANO EXTRATO"].strip() != str(ano) or int(l["MÊS EXTRATO"] or 0) != mes:
                falhar(f"{onde}: extrato {l['ANO EXTRATO']}/{l['MÊS EXTRATO']} fora do arquivo {ano}/{mes}")
            codigo = l["CÓDIGO ÓRGÃO SUPERIOR"].strip()
            orgaos.ver(ano, codigo, l["NOME ÓRGÃO SUPERIOR"])
            v = numero(l["VALOR TRANSAÇÃO"], onde)
            x = por.setdefault(codigo, {"total": 0.0, "sigilo": 0.0, "saque": 0.0, "n": 0})
            x["total"] += v
            x["n"] += 1
            transacao = l["TRANSAÇÃO"]
            if sigiloso(transacao, l.get("NOME PORTADOR")):
                x["sigilo"] += v
            elif "SAQUE" in transacao.upper():
                x["saque"] += v
        if n < MINIMO_LINHAS_MES["cartao"]:
            falhar(f"{url}: só {n} lançamentos no mês")
        meses = mes
    return {"ano": ano, "ate_mes": meses, "orgaos": {c: {k: round(v, 2) if isinstance(v, float) else v for k, v in x.items()} for c, x in por.items()}}


# ---------------------------------------------------------------------------
# Execução da despesa
# ---------------------------------------------------------------------------

GRUPOS_DIVIDA = {"Juros e Encargos da Dívida": "juros", "Amortização/Refinanciamento da Dívida": "amortizacao"}


def ano_ministerios(ano, ate_mes, origem, orgaos):
    por = {}
    divida = {"juros": 0.0, "amortizacao": 0.0}
    meses = 0
    for mes in range(1, ate_mes + 1):
        url = f"{BASE}/despesas-execucao/{ano}{mes:02d}"
        bruto = baixar(url, origem)
        if bruto is None:
            break
        leitor = abrir_csv(bruto, ".csv", url)
        colunas = ["Ano e mês do lançamento", "Código Órgão Superior", "Nome Órgão Superior", "Nome Grupo de Despesa",
                   "Modalidade da Despesa", "Valor Liquidado (R$)"]
        exigir(leitor, colunas, url)
        n = 0
        for k, l in enumerate(leitor, start=2):
            n += 1
            onde = f"{url}, linha {k}"
            # O formato da data varia ("2025/09", "09/2025"); basta ter o ano e o mês.
            partes = re.findall(r"\d+", l["Ano e mês do lançamento"])
            if partes and not (str(ano) in partes and any(p.isdigit() and int(p) == mes for p in partes if p != str(ano))):
                falhar(f"{onde}: lançamento de {l['Ano e mês do lançamento']!r} no arquivo de {ano}/{mes:02d}")
            v = numero(l["Valor Liquidado (R$)"], onde)
            grupo = l["Nome Grupo de Despesa"].strip()
            if grupo in GRUPOS_DIVIDA:
                divida[GRUPOS_DIVIDA[grupo]] += v
                continue
            codigo = l["Código Órgão Superior"].strip()
            orgaos.ver(ano, codigo, l["Nome Órgão Superior"])
            x = por.setdefault(codigo, {"liquidado": 0.0, "transferencias": 0.0})
            x["liquidado"] += v
            if l["Modalidade da Despesa"].strip().startswith(("Transferências a Estados", "Transferências a Municípios")):
                x["transferencias"] += v
        if n < MINIMO_LINHAS_MES["ministerios"]:
            falhar(f"{url}: só {n} linhas no mês")
        meses = mes
    return {"ano": ano, "ate_mes": meses,
            "divida": {k: round(v, 2) for k, v in divida.items()},
            "orgaos": {c: {k: round(v, 2) for k, v in x.items()} for c, x in por.items()}}


# ---------------------------------------------------------------------------
# Viagens a serviço
# ---------------------------------------------------------------------------

def ano_viagens(ano, origem, orgaos):
    url = f"{BASE}/viagens/{ano}"
    bruto = baixar(url, origem)
    if bruto is None:
        return None
    leitor = abrir_csv(bruto, "_Viagem.csv", url)
    colunas = ["Situação", "Código do órgão superior", "Nome do órgão superior", "Nome", "Cargo", "Função", "Descrição Função",
               "Período - Data de início", "Valor diárias", "Valor passagens", "Valor devolução", "Valor outros gastos"]
    exigir(leitor, colunas, url)
    por = {}
    ne = {}
    total = {"diarias": 0.0, "passagens": 0.0, "outros": 0.0, "devolucao": 0.0, "n": 0, "sigilo": 0.0, "n_sigilo": 0}
    ultimo_mes = 0
    for k, l in enumerate(leitor, start=2):
        onde = f"{url}, linha {k}"
        d = numero(l["Valor diárias"], onde)
        p = numero(l["Valor passagens"], onde)
        o = numero(l["Valor outros gastos"], onde)
        dev = numero(l["Valor devolução"], onde)
        v = d + p + o - dev
        total["diarias"] += d
        total["passagens"] += p
        total["outros"] += o
        total["devolucao"] += dev
        total["n"] += 1
        inicio = l["Período - Data de início"].strip()
        m = re.match(r"(\d{2})/(\d{2})/(\d{4})", inicio)
        if m and int(m.group(3)) == ano:
            ultimo_mes = max(ultimo_mes, int(m.group(2)))
        secreto = sigiloso(l["Nome"], l["Cargo"], l["Nome do órgão superior"])
        if secreto:
            total["sigilo"] += v
            total["n_sigilo"] += 1
        codigo = l["Código do órgão superior"].strip()
        nome_orgao = l["Nome do órgão superior"]
        if sigiloso(nome_orgao) or not codigo:
            codigo = "sigiloso"
        else:
            orgaos.ver(ano, codigo, nome_orgao)
        x = por.setdefault(codigo, {"valor": 0.0, "n": 0})
        x["valor"] += v
        x["n"] += 1
        # Cargo de natureza especial: ministros de Estado e cargos do mesmo nível.
        if not secreto and "natureza especial" in sem_acento(l["Descrição Função"]).lower():
            chave = (l["Nome"].strip().upper(), codigo)
            y = ne.setdefault(chave, {"nome": nome_proprio(l["Nome"]), "orgao": codigo, "viagens": 0, "valor": 0.0})
            y["viagens"] += 1
            y["valor"] += v
    if total["n"] < MINIMO_LINHAS_ANO["viagens"]:
        falhar(f"{url}: só {total['n']} viagens no ano")
    return {"ano": ano, "ate_mes": ultimo_mes,
            "total": {k: round(v, 2) if isinstance(v, float) else v for k, v in total.items()},
            "orgaos": {c: {"valor": round(x["valor"], 2), "n": x["n"]} for c, x in por.items()},
            "natureza_especial": sorted(({**y, "valor": round(y["valor"], 2)} for y in ne.values()), key=lambda y: -y["valor"])}


# ---------------------------------------------------------------------------

def total_do_ano(base, dados):
    if base == "cartao":
        return sum(x["total"] for x in dados["orgaos"].values())
    if base == "ministerios":
        return sum(x["liquidado"] for x in dados["orgaos"].values())
    return dados["total"]["diarias"] + dados["total"]["passagens"] + dados["total"]["outros"] - dados["total"]["devolucao"]


def conferir(base, dados, hoje):
    ano, ate = dados["ano"], dados["ate_mes"]
    total = total_do_ano(base, dados)
    minimo, maximo = FAIXA_ANO[base]
    meses = max(ate, 1)
    # Ano incompleto: o mínimo é proporcional aos meses publicados.
    if not minimo * meses / 12 <= total <= maximo:
        falhar(f"{base} {ano}: total de R$ {total:,.2f} em {ate} meses, fora do esperado")
    if ano < hoje.year and base != "viagens" and ate < 12:
        falhar(f"{base} {ano}: ano fechado com só {ate} meses publicados")


def gravar_json(caminho, dados, indentar=False):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, indent=1 if indentar else None, separators=None if indentar else (",", ":"))


def montar_saida(base, anos_dados, orgaos):
    anos = sorted(anos_dados)
    saida = {"anos": anos, "ate_mes": {str(a): anos_dados[a]["ate_mes"] for a in anos}}
    codigos = sorted({c for d in anos_dados.values() for c in d["orgaos"]})
    lista = []
    for c in codigos:
        item = {"codigo": c, "nomes": {}, "valores": {}}
        for a in anos:
            x = anos_dados[a]["orgaos"].get(c)
            if not x:
                continue
            item["nomes"][str(a)] = "Sigiloso" if c == "sigiloso" else orgaos.nome(a, c)
            if base == "cartao":
                item["valores"][str(a)] = [x["total"], x["sigilo"], x["saque"], x["n"]]
            elif base == "ministerios":
                item["valores"][str(a)] = [x["liquidado"], x["transferencias"]]
            else:
                item["valores"][str(a)] = [x["valor"], x["n"]]
        lista.append(item)
    saida["orgaos"] = lista
    if base == "cartao":
        saida["colunas"] = ["total", "sigilo", "saque", "lancamentos"]
    elif base == "ministerios":
        saida["colunas"] = ["liquidado sem dívida", "transferências a estados e municípios"]
        saida["divida"] = {str(a): anos_dados[a]["divida"] for a in anos}
    else:
        saida["colunas"] = ["valor", "viagens"]
        saida["total"] = {str(a): anos_dados[a]["total"] for a in anos}
        saida["natureza_especial"] = {
            str(a): [{**y, "orgao": orgaos.nome(a, y["orgao"])} for y in anos_dados[a]["natureza_especial"]] for a in anos}
    return saida


def main():
    args = sys.argv[1:]
    recentes = "--recentes" in args
    so = args[args.index("--so") + 1] if "--so" in args else None
    hoje = dt.date.today()
    origem = {}
    if os.path.exists(ORIGEM):
        with open(ORIGEM, encoding="utf-8") as fh:
            origem = json.load(fh).get("arquivos", {})
    orgaos = Orgaos()
    caminho_orgaos = os.path.join(INTERMEDIARIO, "orgaos.json")
    if os.path.exists(caminho_orgaos):
        with open(caminho_orgaos, encoding="utf-8") as fh:
            orgaos.carregar(json.load(fh))

    novos = {}
    for base in ("viagens", "cartao", "ministerios"):
        if so and base != so:
            continue
        anos = list(range(PRIMEIRO_ANO[base], hoje.year + 1))
        if recentes:
            anos = [a for a in anos if a >= hoje.year - 1]
        for ano in anos:
            print(f"== {base} {ano}", flush=True)
            ate = 12 if ano < hoje.year else hoje.month
            if base == "cartao":
                dados = ano_cartao(ano, ate, origem, orgaos)
            elif base == "ministerios":
                dados = ano_ministerios(ano, ate, origem, orgaos)
            else:
                dados = ano_viagens(ano, origem, orgaos)
            if dados is None or (dados["ate_mes"] == 0 and base != "viagens"):
                print(f"  {base} {ano}: nada publicado ainda", flush=True)
                continue
            conferir(base, dados, hoje)
            print(f"  {base} {ano}: R$ {total_do_ano(base, dados):,.2f} até o mês {dados['ate_mes']}, {len(dados['orgaos'])} órgãos", flush=True)
            novos[(base, ano)] = dados

    # Só grava depois de tudo conferido.
    for (base, ano), dados in novos.items():
        gravar_json(os.path.join(INTERMEDIARIO, base, f"{ano}.json"), dados)
    gravar_json(caminho_orgaos, orgaos.para_json(), indentar=True)
    for base in ("cartao", "ministerios", "viagens"):
        pasta = os.path.join(INTERMEDIARIO, base)
        if not os.path.isdir(pasta):
            continue
        anos_dados = {}
        for nome in os.listdir(pasta):
            if re.fullmatch(r"\d{4}\.json", nome):
                with open(os.path.join(pasta, nome), encoding="utf-8") as fh:
                    anos_dados[int(nome[:4])] = json.load(fh)
        saida = montar_saida(base, anos_dados, orgaos)
        saida["atualizado_em"] = hoje.isoformat()
        gravar_json(os.path.join(DESTINO, f"{base}.json"), saida)
    gravar_json(ORIGEM, {"atualizado_em": hoje.isoformat(), "arquivos": origem}, indentar=True)


if __name__ == "__main__":
    main()
