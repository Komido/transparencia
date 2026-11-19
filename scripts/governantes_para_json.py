#!/usr/bin/env python3
"""Prefeitos e governadores eleitos, pelos dados abertos do TSE.

Fontes oficiais (Tribunal Superior Eleitoral, portal de dados abertos):
  Candidatos de cada eleição (um arquivo por ano, com todas as UFs):
    https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_AAAA.zip
  Códigos oficiais de municípios segundo o TSE e o IBGE:
    https://cdn.tse.jus.br/estatistica/sead/odsele/municipio_tse_ibge/municipio_tse_ibge.zip

Conferido em 17/11/2026 (inspeção pelo GitHub): CSV em latin-1, separado
por ";", com o arquivo consulta_cand_AAAA_BRASIL.csv dentro do zip. A cidade
vem com o código do TSE (SG_UE), não o do IBGE; a tabela de códigos do TSE
faz a ligação. Eleito: DS_CARGO "PREFEITO" ou "GOVERNADOR" e
DS_SIT_TOT_TURNO "ELEITO". Em 2024 eram 5.568 prefeitos eleitos; em 2020,
5.601, porque o arquivo inclui as eleições suplementares feitas depois de
cassações. Em 2022 e 2026, 27 governadores.

Partido: o arquivo traz o partido com o nome da data da eleição (em 2020,
469 prefeitos eleitos pelo DEM e 91 pelo PSL; "União" só aparece nas
eleições suplementares de 2023 e 2024, depois da fusão dos dois). O nome de
hoje de partidos que se fundiram, foram incorporados ou mudaram de nome
precisa de uma tabela à parte, com fonte oficial.

O arquivo registra quem foi eleito, não quem governou: se o titular morreu,
renunciou ou foi cassado e o vice assumiu sem nova eleição, a troca não
aparece (em São Paulo, Bruno Covas foi eleito em 2020 e Ricardo Nunes, o
vice, assumiu em 2021). Por isso o site mostra o vice junto do titular.

Só entram nome de urna, gênero (para escrever "prefeita" ou "prefeito"),
partido, cargo, o vice e a data e o tipo da eleição. CPF, e-mail, data
de nascimento e outros dados pessoais do arquivo não são lidos para a saída.

Saídas:
  site/dados/governantes/UF.json   prefeitos de cada cidade do estado e
                                   governadores do estado

Uso: python3 scripts/governantes_para_json.py
Se algo sair do formato conferido, o script falha sem gravar; vale a versão
anterior.
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

CANDIDATOS = "https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_{ano}.zip"
CODIGOS = "https://cdn.tse.jus.br/estatistica/sead/odsele/municipio_tse_ibge/municipio_tse_ibge.zip"
AGENTE = "ArrecadometroBrasil/1.0 (dados publicos; github.com/Komido/transparencia)"
DESTINO = "site/dados/governantes"

# Eleição -> (cargo, faixa plausível de eleitos, início e fim do mandato).
ELEICOES = {
    2020: ("PREFEITO", (5500, 5700), 2021, 2024),
    2024: ("PREFEITO", (5500, 5700), 2025, 2028),
    2018: ("GOVERNADOR", (27, 30), 2019, 2022),
    2022: ("GOVERNADOR", (27, 30), 2023, 2026),
    2026: ("GOVERNADOR", (27, 30), 2027, 2030),
}
UFS = {"AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB",
       "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"}
MINUSCULAS = {"da", "das", "de", "do", "dos", "e", "di", "du", "del"}


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def baixar(url, tentativas=4):
    for k in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE})
            with urllib.request.urlopen(req, timeout=600) as r:
                return r.read()
        except Exception as erro:  # noqa: BLE001
            print(f"  tentativa {k + 1}: {erro} em {url}", flush=True)
            time.sleep(20 * (k + 1))
    falhar(f"não consegui baixar {url}")
    return b""


def ler_csv(bruto, onde):
    for cod in ("utf-8-sig", "latin-1"):
        try:
            texto = bruto.decode(cod)
            break
        except UnicodeDecodeError:
            continue
    else:
        falhar(f"{onde}: codificação desconhecida")
    amostra = texto[:2000]
    sep = ";" if amostra.count(";") >= amostra.count(",") else ","
    return list(csv.DictReader(io.StringIO(texto), delimiter=sep))


def sem_acento(texto):
    texto = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in texto if not unicodedata.combining(c)).upper().strip()


def nome_proprio(texto):
    """'JOÃO DA SILVA' -> 'João da Silva'; mantém siglas curtas como 'DR.'."""
    palavras = []
    for i, p in enumerate((texto or "").strip().split()):
        baixa = p.lower()
        if i and baixa in MINUSCULAS:
            palavras.append(baixa)
        elif p.endswith(".") and len(p) <= 4:
            palavras.append(p[0] + p[1:].lower())
        else:
            palavras.append("-".join(s[:1].upper() + s[1:].lower() for s in p.split("-")))
    return " ".join(palavras)


def codigos_tse_ibge():
    z = zipfile.ZipFile(io.BytesIO(baixar(CODIGOS)))
    nomes = [n for n in z.namelist() if n.lower().endswith(".csv")]
    if not nomes:
        falhar("tabela de códigos sem CSV")
    linhas = ler_csv(z.read(nomes[0]), "tabela de códigos")
    colunas = list(linhas[0].keys())
    print("tabela de códigos, colunas:", colunas)

    def numericas(c, tamanho=None):
        vals = [(l.get(c) or "").strip() for l in linhas[:200]]
        vals = [v for v in vals if v]
        return vals and all(v.isdigit() and (tamanho is None or len(v) == tamanho) for v in vals)

    # Colunas conferidas em 17/11/2026: CD_UF_TSE, CD_UF_IBGE, SG_UF, NM_UF,
    # CD_MUNICIPIO_TSE, NM_MUNICIPIO_TSE, CD_MUNICIPIO_IBGE, NM_MUNICIPIO_IBGE.
    tse = "CD_MUNICIPIO_TSE" if "CD_MUNICIPIO_TSE" in colunas and numericas("CD_MUNICIPIO_TSE") else None
    ibge = "CD_MUNICIPIO_IBGE" if "CD_MUNICIPIO_IBGE" in colunas and numericas("CD_MUNICIPIO_IBGE", 7) else None
    if not tse or not ibge:
        falhar(f"tabela de códigos: colunas do TSE e do IBGE não encontradas em {colunas}")
    print(f"tabela de códigos: TSE em {tse}, IBGE em {ibge}")
    mapa = {}
    for l in linhas:
        t = (l.get(tse) or "").strip().lstrip("0")
        i = (l.get(ibge) or "").strip()
        if not t or not i:
            continue
        if not t.isdigit() or not (i.isdigit() and len(i) == 7):
            falhar(f"tabela de códigos: linha fora do padrão {l}")
        if t in mapa and mapa[t] != i:
            falhar(f"tabela de códigos: TSE {t} com dois códigos do IBGE")
        mapa[t] = i
    if not 5560 <= len(set(mapa.values())) <= 5600:
        falhar(f"tabela de códigos com {len(set(mapa.values()))} municípios do IBGE; esperado perto de 5.570")
    print(f"tabela de códigos: {len(mapa)} códigos do TSE, {len(set(mapa.values()))} do IBGE")
    return mapa


_CANDIDATOS = {}


def candidatos(ano):
    """Linhas do arquivo de candidatos do ano (baixado uma vez só)."""
    if ano not in _CANDIDATOS:
        z = zipfile.ZipFile(io.BytesIO(baixar(CANDIDATOS.format(ano=ano))))
        nome = f"consulta_cand_{ano}_BRASIL.csv"
        if nome not in z.namelist():
            falhar(f"{ano}: {nome} não está no zip")
        _CANDIDATOS[ano] = ler_csv(z.read(nome), f"candidatos {ano}")
    return _CANDIDATOS[ano]


# Vereadores eleitos na última eleição municipal. "ELEITO POR QP" (pelo
# quociente partidário) e "ELEITO POR MÉDIA" (pelas sobras); suplente e não
# eleito ficam de fora. Em 2024 eram cerca de 58 mil.
ELEICAO_VEREADORES = (2024, 2025, 2028)
# Mandato anterior: só a quantidade de vereadores eleitos em cada cidade, sem
# nomes, para o salário médio por vereador dos anos 2021 a 2024 na página da
# cidade (subsídio pago ÷ vereadores ÷ 12).
ELEICAO_ANTERIOR = (2020, 2021, 2024)
DESTINO_VEREADORES = "site/dados/vereadores"


def contar_vereadores(mapa, ano):
    """{UF: {código IBGE: vereadores eleitos}} da eleição do ano."""
    por_cidade = collections.Counter()
    sem_codigo = collections.Counter()
    for l in candidatos(ano):
        if l.get("DS_CARGO") != "VEREADOR" or not (l.get("DS_SIT_TOT_TURNO") or "").startswith("ELEITO"):
            continue
        ue = (l.get("SG_UE") or "").strip().lstrip("0")
        ibge = mapa.get(ue)
        if not ibge:
            sem_codigo[f"{l.get('NM_UE')} ({l.get('SG_UF')})"] += 1
            continue
        por_cidade[(l.get("SG_UF"), ibge)] += 1
    total = sum(por_cidade.values())
    if not 55000 <= total <= 62000:
        falhar(f"{total} vereadores eleitos em {ano}; esperado perto de 58 mil")
    if len(sem_codigo) > 5:
        falhar(f"{len(sem_codigo)} cidades sem código do IBGE nos vereadores de {ano}: {list(sem_codigo)[:10]}")
    por_uf = collections.defaultdict(dict)
    for (uf, ibge), n in por_cidade.items():
        if not 5 <= n <= 60:
            falhar(f"{ibge} ({uf}): {n} vereadores eleitos em {ano}; a lei permite de 9 a 55")
        por_uf[uf][ibge] = n
    print(f"vereadores {ano}: {total} eleitos em {len(por_cidade)} cidades (só a contagem)", flush=True)
    return por_uf


def vereadores(mapa):
    ano, inicio, fim = ELEICAO_VEREADORES
    por_cidade = collections.defaultdict(list)
    partidos, sem_codigo = {}, collections.Counter()
    for l in candidatos(ano):
        if l.get("DS_CARGO") != "VEREADOR" or not (l.get("DS_SIT_TOT_TURNO") or "").startswith("ELEITO"):
            continue
        ue = (l.get("SG_UE") or "").strip().lstrip("0")
        ibge = mapa.get(ue)
        if not ibge:
            sem_codigo[f"{l.get('NM_UE')} ({l.get('SG_UF')})"] += 1
            continue
        partido = (l.get("SG_PARTIDO") or "").strip()
        if not partido or partido == "#NULO":
            falhar(f"vereador sem partido: {l.get('NM_URNA_CANDIDATO')} em {l.get('NM_UE')}")
        partidos[partido] = nome_proprio(l.get("NM_PARTIDO"))
        por_cidade[(l.get("SG_UF"), ibge)].append([
            nome_proprio(l.get("NM_URNA_CANDIDATO") or l.get("NM_CANDIDATO")),
            int((l.get("DS_GENERO") or "").strip().upper() == "FEMININO"),
            partido,
            "media" if "MÉDIA" in (l.get("DS_SIT_TOT_TURNO") or "").upper() or "MEDIA" in sem_acento(l.get("DS_SIT_TOT_TURNO") or "") else "qp",
        ])
    total = sum(len(v) for v in por_cidade.values())
    if not 55000 <= total <= 62000:
        falhar(f"{total} vereadores eleitos em {ano}; esperado perto de 58 mil")
    if len(sem_codigo) > 5:
        falhar(f"{len(sem_codigo)} cidades sem código do IBGE nos vereadores: {list(sem_codigo)[:10]}")
    por_uf = collections.defaultdict(dict)
    for (uf, ibge), lista in por_cidade.items():
        if not 5 <= len(lista) <= 60:
            falhar(f"{ibge} ({uf}): {len(lista)} vereadores eleitos; a lei permite de 9 a 55")
        por_uf[uf][ibge] = sorted(lista, key=lambda x: sem_acento(x[0]))
    ano_ant, inicio_ant, fim_ant = ELEICAO_ANTERIOR
    anterior = contar_vereadores(mapa, ano_ant)
    for uf in UFS:
        gravar_json(f"{DESTINO_VEREADORES}/{uf}.json", {
            "uf": uf, "fonte": "TSE, dados abertos (candidatos e códigos de municípios)",
            "atualizado": dt.date.today().isoformat(), "eleicao": ano, "inicio": inicio, "fim": fim,
            "campos": ["nome", "feminino", "partido", "eleito_por"],
            "partidos": {p: partidos[p] for p in sorted({x[2] for lst in por_uf[uf].values() for x in lst})},
            "cidades": por_uf[uf],
            "anterior": {"eleicao": ano_ant, "inicio": inicio_ant, "fim": fim_ant,
                         "quantidade": dict(sorted(anterior.get(uf, {}).items()))},
        })
    print(f"vereadores {ano}: {total} eleitos em {len(por_cidade)} cidades", flush=True)
    return partidos


def eleitos(ano):
    cargo, (minimo, maximo), inicio, fim = ELEICOES[ano]
    vice_cargo = f"VICE-{cargo}"
    saida = []
    linhas = candidatos(ano)
    # Vice eleito: mesma eleição, mesma cidade ou UF e mesmo número na urna.
    vices = {}
    for l in linhas:
        if l.get("DS_CARGO") == vice_cargo and (l.get("DS_SIT_TOT_TURNO") or "").startswith("ELEITO"):
            vices[(l.get("CD_ELEICAO"), l.get("SG_UE"), l.get("NR_CANDIDATO"))] = nome_proprio(l.get("NM_URNA_CANDIDATO"))
    for l in linhas:
        if l.get("DS_CARGO") != cargo or l.get("DS_SIT_TOT_TURNO") != "ELEITO":
            continue
        uf = (l.get("SG_UF") or "").strip()
        if uf not in UFS:
            falhar(f"{ano}: UF {uf!r}")
        data = (l.get("DT_ELEICAO") or "").strip()
        try:
            data = dt.datetime.strptime(data, "%d/%m/%Y").date().isoformat()
        except ValueError:
            falhar(f"{ano}: data da eleição fora do formato: {data!r}")
        partido = (l.get("SG_PARTIDO") or "").strip()
        if not partido or partido == "#NULO":
            falhar(f"{ano}: eleito sem partido: {l.get('NM_URNA_CANDIDATO')} em {l.get('NM_UE')}")
        saida.append({
            "uf": uf, "ue": (l.get("SG_UE") or "").strip().lstrip("0"), "cidade": (l.get("NM_UE") or "").strip(),
            "eleicao": ano, "data": data, "turno": int(l.get("NR_TURNO") or 1),
            "suplementar": "SUPLEMENTAR" in sem_acento(l.get("NM_TIPO_ELEICAO") or "") or "SUPLEMENTAR" in sem_acento(l.get("DS_ELEICAO") or ""),
            "nome": nome_proprio(l.get("NM_URNA_CANDIDATO") or l.get("NM_CANDIDATO")),
            "feminino": (l.get("DS_GENERO") or "").strip().upper() == "FEMININO",
            "partido": partido, "partido_nome": nome_proprio(l.get("NM_PARTIDO")),
            "vice": vices.get((l.get("CD_ELEICAO"), l.get("SG_UE"), l.get("NR_CANDIDATO")), ""),
        })
    if not minimo <= len(saida) <= maximo:
        falhar(f"{ano}: {len(saida)} {cargo.lower()}s eleitos; esperado entre {minimo} e {maximo}")
    sem_vice = sum(1 for e in saida if not e["vice"])
    if sem_vice > 0.02 * len(saida):
        falhar(f"{ano}: {sem_vice} eleitos sem vice; a ligação pelo número na urna falhou?")
    print(f"{ano}: {len(saida)} {cargo.lower()}s eleitos", flush=True)
    return saida


def gravar_json(caminho, dados):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(temporario, caminho)


def main():
    mapa = codigos_tse_ibge()
    # Saída compacta: cada eleito é [eleição, data, suplementar, nome,
    # feminino, partido, vice]; o mandato de cada eleição e o nome de cada
    # partido ficam uma vez só no arquivo.
    campos = ["eleicao", "data", "suplementar", "nome", "feminino", "partido", "vice"]
    eleicoes = {str(a): {"cargo": c.lower(), "inicio": i, "fim": f} for a, (c, _, i, f) in ELEICOES.items()}
    por_uf = {uf: {"uf": uf, "fonte": "TSE, dados abertos (candidatos e códigos de municípios)",
                   "atualizado": dt.date.today().isoformat(), "campos": campos, "eleicoes": eleicoes,
                   "partidos": {}, "governadores": [], "prefeitos": {}} for uf in UFS}
    sem_codigo = []
    for ano, (cargo, *_resto) in sorted(ELEICOES.items()):
        for e in eleitos(ano):
            item = [e["eleicao"], e["data"], int(e["suplementar"]), e["nome"], int(e["feminino"]), e["partido"], e["vice"]]
            por_uf[e["uf"]]["partidos"][e["partido"]] = e["partido_nome"]
            if cargo == "GOVERNADOR":
                por_uf[e["uf"]]["governadores"].append(item)
                continue
            ibge = mapa.get(e["ue"])
            if not ibge:
                sem_codigo.append(f"{e['cidade']} ({e['uf']}, TSE {e['ue']})")
                continue
            if not ibge.startswith(str({"RO": 11, "AC": 12, "AM": 13, "RR": 14, "PA": 15, "AP": 16, "TO": 17,
                                        "MA": 21, "PI": 22, "CE": 23, "RN": 24, "PB": 25, "PE": 26, "AL": 27,
                                        "SE": 28, "BA": 29, "MG": 31, "ES": 32, "RJ": 33, "SP": 35, "PR": 41,
                                        "SC": 42, "RS": 43, "MS": 50, "MT": 51, "GO": 52, "DF": 53}[e["uf"]])):
                falhar(f"{e['cidade']} ({e['uf']}): código do IBGE {ibge} de outro estado")
            por_uf[e["uf"]]["prefeitos"].setdefault(ibge, []).append(item)
    if len(sem_codigo) > 5:
        falhar(f"{len(sem_codigo)} cidades sem código do IBGE: {sem_codigo[:10]}")
    if sem_codigo:
        print("sem código do IBGE (ficam de fora):", sem_codigo)
    for d in por_uf.values():
        d["governadores"].sort(key=lambda x: (x[0], x[1]))
        for lista in d["prefeitos"].values():
            lista.sort(key=lambda x: (x[0], x[1]))
        if d["uf"] != "DF" and not d["prefeitos"]:
            falhar(f"{d['uf']}: nenhum prefeito")
        if not d["governadores"]:
            falhar(f"{d['uf']}: nenhum governador")
        gravar_json(f"{DESTINO}/{d['uf']}.json", d)
    print(f"gravados {len(por_uf)} estados; {sum(len(d['prefeitos']) for d in por_uf.values())} cidades com prefeito")
    partidos = vereadores(mapa)
    # Siglas de todos os partidos que aparecem no site (prefeitos,
    # governadores e vereadores), com o nome registrado no TSE.
    for d in por_uf.values():
        for sigla, nome in d["partidos"].items():
            partidos.setdefault(sigla, nome)
    gravar_json("site/dados/partidos.json", {
        "fonte": "TSE, dados abertos (candidatos)", "atualizado": dt.date.today().isoformat(),
        "partidos": dict(sorted(partidos.items())),
    })
    print(f"partidos: {len(partidos)}")


if __name__ == "__main__":
    main()
