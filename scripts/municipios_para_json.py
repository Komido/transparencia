#!/usr/bin/env python3
"""Resume as receitas de todas as prefeituras do país, ano a ano.

Fonte oficial: Tesouro Nacional, SICONFI, API de dados abertos.
  Lista de entes (código do IBGE, nome, UF, população):
    https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes
  Relatório Resumido da Execução Orçamentária, Anexo 3 (receita corrente
  líquida), 6º bimestre de cada ano, uma chamada por prefeitura:
    .../tt/rreo?an_exercicio=AAAA&nr_periodo=6&co_tipo_demonstrativo=RREO
       &no_anexo=RREO-Anexo%2003&co_esfera=M&id_ente=CODIGO_IBGE

A API não aceita pedido de todas as prefeituras de uma vez (sem id_ente a
resposta vem vazia, testado em 16/11/2026) e não há arquivo em lote no Tesouro
Transparente. Por isso o script pede uma prefeitura por vez, com pausa entre
os pedidos e espera longa quando o Tesouro recusa por excesso (HTTP 429).

O Anexo 3 traz, nos 12 meses do ano (coluna "TOTAL (ÚLTIMOS 12 MESES)"), a
receita corrente da prefeitura e de onde ela vem: impostos e taxas da própria
cidade (IPTU, ISS, ITBI, IR retido dos servidores, outros) e repasses (cota do
FPM, do ICMS, do IPVA e do ITR, FUNDEB e outros). Contas conferidas em
16/11/2026 nos relatórios de 2025 de São Paulo e de Angico (TO), em que as
partes somam exatamente o total.

Situação de cada prefeitura em cada ano ("s"):
  ok             relatório entregue e as partes somam o total (tolerância de
                 R$ 1 ou 0,1%)
  nao_fecha      relatório entregue, mas a soma das partes não bate com o
                 total; os números aparecem com aviso
  sem_relatorio  a prefeitura não entregou ao Tesouro o relatório do ano
                 completo (resposta vazia na data da coleta)
  erro           a API não respondeu depois de várias tentativas; vale o dado
                 anterior, se houver

Saídas:
  dados-fonte/municipios/UF.json  (por estado: números de cada prefeitura e
                                   SHA-256 de cada resposta da API)
  site/dados/municipios/UF.json   (o que o site lê, compacto)
  site/dados/municipios/indice.json (nomes para a busca e medianas do país
                                   por tamanho de cidade)

Uso:
  python3 scripts/municipios_para_json.py --uf SP [--anos 2024,2025]
      busca as prefeituras do estado e grava dados-fonte/municipios/SP.json
  python3 scripts/municipios_para_json.py --montar
      monta os arquivos do site a partir de todos os dados-fonte, sem baixar

Se a lista de entes vier implausível ou se mais da metade das prefeituras do
estado der erro, o script falha sem gravar; vale a versão anterior.
"""

import argparse
import datetime as dt
import glob
import hashlib
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://apidatalake.tesouro.gov.br/ords/siconfi/tt"
AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
FONTE = "dados-fonte/municipios"
DESTINO = "site/dados/municipios"
INTERVALO = 0.7  # segundos entre pedidos
COLUNA_ANO = "TOTAL (ÚLTIMOS 12 MESES)"
BRASILIA = 5300108

UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB",
       "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]

# Campos gravados, na ordem do vetor "v" do arquivo do site.
CONTAS = {
    "receita": "ReceitasCorrentesLiquidasExcetoTransferenciasEFUNDEB",  # RECEITAS CORRENTES (I)
    "tributos": "ReceitaTributariaLiquidaExcetoTransferenciasEFUNDEB",
    "iptu": "IPTULiquidoExcetoTransferenciasEFUNDEB",
    "iss": "ISSLiquidoExcetoTransferenciasEFUNDEB",
    "itbi": "ITBILiquidoExcetoTransferenciasEFUNDEB",
    "irrf": "IRRFLiquidoExcetoTransferenciasEFUNDEB",
    "outros_tributos": "OutrasReceitasTributarias",
    "transferencias": "RREO3TransferenciasCorrentes",
    "fpm": "RREO3CotaParteDoFPM",
    "icms": "RREO3CotaParteDoICMS",
    "ipva": "RREO3CotaParteDoIPVA",
    "itr": "RREO3CotaParteDoITR",
    "fundeb": "RREO3TransferenciasDoFUNDEB",
    "rcl": "RREO3ReceitaCorrenteLiquida",
    "deducoes": "DeducoesDaReceitaCorrenteLiquida",
}
CAMPOS_SITE = ["receita", "tributos", "iptu", "iss", "itbi", "irrf", "outros_tributos",
               "transferencias", "fpm", "icms", "ipva", "itr", "fundeb", "rcl"]

# Faixas de população do IBGE, para comparar cidades do mesmo tamanho.
FAIXAS = [(5_000, "até 5 mil habitantes"), (10_000, "de 5 mil a 10 mil"), (20_000, "de 10 mil a 20 mil"),
          (50_000, "de 20 mil a 50 mil"), (100_000, "de 50 mil a 100 mil"), (500_000, "de 100 mil a 500 mil"),
          (None, "mais de 500 mil")]


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def pedir(url, tentativas=6):
    """Devolve (json, sha256) ou None se todas as tentativas falharem.
    Espera INTERVALO antes de cada pedido; com 429 ou 5xx, espera minutos."""
    for k in range(tentativas):
        time.sleep(INTERVALO)
        espera = 15 * (k + 1)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                bruto = r.read()
            return json.loads(bruto), hashlib.sha256(bruto).hexdigest()
        except urllib.error.HTTPError as erro:
            if erro.code == 429 or erro.code >= 500:
                espera = 60 * (k + 1)
            print(f"  tentativa {k + 1}: HTTP {erro.code} em {url}; nova tentativa em {espera} s", flush=True)
        except Exception as erro:  # noqa: BLE001
            print(f"  tentativa {k + 1}: {erro} em {url}; nova tentativa em {espera} s", flush=True)
        time.sleep(espera)
    return None


def lista_de_entes():
    resposta = pedir(f"{API}/entes")
    if not resposta:
        falhar("a lista de entes do Tesouro não respondeu")
    itens = resposta[0].get("items") or []
    municipios = {}
    pop_df = next((int(e.get("populacao") or 0) for e in itens if str(e.get("cod_ibge")) == "53"), 0)
    for e in itens:
        # Brasília entra mesmo que a lista a classifique como distrito.
        if e.get("esfera") != "M" and str(e.get("cod_ibge")) != str(BRASILIA):
            continue
        cod = int(e["cod_ibge"])
        if not 1100000 <= cod <= 5399999:
            falhar(f"código de município fora do padrão: {cod}")
        municipios[cod] = {"nome": (e.get("ente") or "").strip(), "uf": (e.get("uf") or "").strip(),
                           "pop": int(e.get("populacao") or 0)}
    if BRASILIA not in municipios:
        municipios[BRASILIA] = {"nome": "Brasília", "uf": "DF", "pop": pop_df}
    # O Brasil tem 5.570 municípios (5.569 mais Brasília, que é distrito).
    if not 5550 <= len(municipios) <= 5590:
        falhar(f"lista de entes com {len(municipios)} municípios; esperado perto de 5.570")
    return municipios


def resumir_relatorio(itens):
    """Valores do ano (coluna dos 12 meses) por campo e a situação."""
    do_ano = [i for i in itens if i.get("coluna") == COLUNA_ANO]
    if not do_ano:
        return {"s": "sem_relatorio"}
    por_conta = {}
    for i in do_ano:
        conta = i.get("cod_conta")
        if conta in por_conta:
            return {"s": "nao_fecha", "motivo": f"conta repetida: {conta}"}
        valor = i.get("valor")
        por_conta[conta] = float(valor) if valor is not None else 0.0
    if CONTAS["receita"] not in por_conta:
        return {"s": "sem_relatorio"}
    v = {campo: por_conta.get(conta, 0.0) for campo, conta in CONTAS.items()}
    pop = next((int(i["populacao"]) for i in do_ano if i.get("populacao")), 0)

    def perto(a, b):
        return abs(a - b) <= max(1.0, 0.001 * max(abs(a), abs(b)))

    motivos = []
    soma_tributos = v["iptu"] + v["iss"] + v["itbi"] + v["irrf"] + v["outros_tributos"]
    if not perto(soma_tributos, v["tributos"]):
        motivos.append(f"impostos: partes {soma_tributos:.2f}, total {v['tributos']:.2f}")
    if v["tributos"] + v["transferencias"] > v["receita"] + max(1.0, 0.001 * v["receita"]):
        motivos.append("impostos mais repasses passam da receita corrente")
    if v["rcl"] and not perto(v["receita"] - v["deducoes"], v["rcl"]):
        motivos.append(f"receita corrente líquida: {v['receita'] - v['deducoes']:.2f} contra {v['rcl']:.2f}")
    if v["receita"] <= 0:
        motivos.append("receita corrente zerada")
    saida = {"s": "nao_fecha" if motivos else "ok", "pop": pop,
             "v": {campo: round(v[campo], 2) for campo in CAMPOS_SITE}}
    if motivos:
        saida["motivo"] = "; ".join(motivos)
    return saida


def url_rreo(ano, cod):
    q = urllib.parse.urlencode({"an_exercicio": ano, "nr_periodo": 6, "co_tipo_demonstrativo": "RREO",
                                "no_anexo": "RREO-Anexo 03", "co_esfera": "M", "id_ente": cod},
                               quote_via=urllib.parse.quote)
    return f"{API}/rreo?{q}"


def anos_padrao(hoje):
    """Os dois últimos anos com relatório do 6º bimestre já vencido (prazo de
    30 de janeiro do ano seguinte)."""
    ultimo = hoje.year - 1 if hoje.month >= 2 else hoje.year - 2
    return [ultimo - 1, ultimo]


def ler_json(caminho, padrao):
    if not os.path.exists(caminho):
        return padrao
    with open(caminho, encoding="utf-8") as fh:
        return json.load(fh)


def gravar_json(caminho, dados, indentar=False):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, indent=1 if indentar else None,
                  separators=None if indentar else (",", ":"))
    os.replace(temporario, caminho)


def buscar_uf(uf, anos):
    municipios = {c: m for c, m in lista_de_entes().items() if m["uf"] == uf}
    if not municipios:
        falhar(f"nenhum município na lista de entes para {uf}")
    caminho = f"{FONTE}/{uf}.json"
    anterior = ler_json(caminho, {"municipios": {}})
    saida = {"uf": uf, "atualizado": dt.date.today().isoformat(), "municipios": {}}
    erros = 0
    total = 0
    for n, (cod, m) in enumerate(sorted(municipios.items()), start=1):
        antes = anterior["municipios"].get(str(cod), {})
        registro = {"nome": m["nome"], "pop": m["pop"], "anos": dict(antes.get("anos", {}))}
        for ano in anos:
            if cod == BRASILIA:
                registro["anos"][str(ano)] = {"s": "df"}
                continue
            total += 1
            url = url_rreo(ano, cod)
            resposta = pedir(url)
            if resposta is None:
                erros += 1
                if str(ano) not in registro["anos"]:
                    registro["anos"][str(ano)] = {"s": "erro"}
                continue
            dados, sha = resposta
            resumo = resumir_relatorio(dados.get("items") or [])
            resumo["sha256"] = sha
            registro["anos"][str(ano)] = resumo
        saida["municipios"][str(cod)] = registro
        if n % 25 == 0 or n == len(municipios):
            print(f"{uf}: {n} de {len(municipios)} prefeituras", flush=True)
    if total and erros > total / 2:
        falhar(f"{uf}: {erros} de {total} pedidos sem resposta; nada gravado")
    situacoes = {}
    for r in saida["municipios"].values():
        for ano in anos:
            s = r["anos"].get(str(ano), {}).get("s", "?")
            situacoes[(ano, s)] = situacoes.get((ano, s), 0) + 1
    for (ano, s), q in sorted(situacoes.items()):
        print(f"{uf} {ano}: {q} {s}")
    gravar_json(caminho, saida, indentar=True)


def faixa_de(pop):
    for i, (teto, _rotulo) in enumerate(FAIXAS):
        if teto is None or pop <= teto:
            return i
    return len(FAIXAS) - 1


def indicadores(reg_ano):
    v = reg_ano["v"]
    pop = reg_ano.get("pop") or 0
    if pop <= 0 or v["receita"] <= 0:
        return None
    return {"receita_hab": v["receita"] / pop, "tributos_hab": v["tributos"] / pop,
            "repasses_pct": 100 * v["transferencias"] / v["receita"]}


def mediana(valores):
    return round(statistics.median(valores), 2) if valores else None


def montar():
    arquivos = sorted(glob.glob(f"{FONTE}/*.json"))
    if not arquivos:
        falhar(f"nenhum arquivo em {FONTE}")
    por_uf = {os.path.basename(a)[:-5]: ler_json(a, {}) for a in arquivos}
    anos = sorted({int(a) for d in por_uf.values() for r in d["municipios"].values() for a in r["anos"]})
    # Medianas do país por tamanho de cidade e de cada estado, por ano, só com
    # prefeituras em situação "ok".
    nacional = {}
    estadual = {}
    for uf, d in por_uf.items():
        for r in d["municipios"].values():
            for ano, reg in r["anos"].items():
                if reg.get("s") != "ok":
                    continue
                ind = indicadores(reg)
                if not ind:
                    continue
                f = faixa_de(reg.get("pop") or r["pop"])
                for k, x in ind.items():
                    nacional.setdefault((ano, f, k), []).append(x)
                    estadual.setdefault((uf, ano, k), []).append(x)
    indice = {"atualizado": dt.date.today().isoformat(), "anos": anos, "campos": CAMPOS_SITE,
              "faixas": [{"ate": teto, "rotulo": rotulo} for teto, rotulo in FAIXAS],
              "medianas": {}, "cidades": []}
    for (ano, f, k), xs in nacional.items():
        m = indice["medianas"].setdefault(ano, {}).setdefault(str(f), {})
        m[k] = mediana(xs)
        if k == "receita_hab":
            m["n"] = len(xs)
    for uf, d in sorted(por_uf.items()):
        site = {"uf": uf, "atualizado": d.get("atualizado"), "anos": anos, "campos": CAMPOS_SITE,
                "medianas": {}, "municipios": []}
        for (u, ano, k), xs in estadual.items():
            if u == uf:
                site["medianas"].setdefault(ano, {})[k] = mediana(xs)
                if k == "receita_hab":
                    site["medianas"][ano]["n"] = len(xs)
        for cod, r in sorted(d["municipios"].items(), key=lambda x: x[1]["nome"]):
            item = {"c": int(cod), "n": r["nome"], "p": r["pop"], "a": {}}
            for ano, reg in sorted(r["anos"].items()):
                registro = {"s": reg["s"]}
                if reg.get("pop"):
                    registro["p"] = reg["pop"]
                if "v" in reg:
                    registro["v"] = [round(reg["v"][c]) for c in CAMPOS_SITE]
                if reg.get("motivo"):
                    registro["m"] = reg["motivo"]
                item["a"][ano] = registro
            site["municipios"].append(item)
            indice["cidades"].append([int(cod), r["nome"], uf, r["pop"]])
        gravar_json(f"{DESTINO}/{uf}.json", site)
    indice["cidades"].sort(key=lambda c: (c[1], c[2]))
    gravar_json(f"{DESTINO}/indice.json", indice)
    print(f"montados {len(por_uf)} estados e {len(indice['cidades'])} cidades; anos {anos}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--uf", choices=UFS)
    p.add_argument("--anos", help="anos separados por vírgula; padrão: os dois últimos com relatório vencido")
    p.add_argument("--montar", action="store_true")
    a = p.parse_args()
    if a.montar:
        montar()
        return
    if not a.uf:
        falhar("informe --uf ou --montar")
    anos = [int(x) for x in a.anos.split(",")] if a.anos else anos_padrao(dt.date.today())
    if any(not 2015 <= x <= dt.date.today().year for x in anos):
        falhar(f"anos fora do intervalo: {anos}")
    print(f"{a.uf}: anos {anos}", flush=True)
    buscar_uf(a.uf, anos)


if __name__ == "__main__":
    main()
