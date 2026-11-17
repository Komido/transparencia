#!/usr/bin/env python3
"""Votações e projetos de cada deputado federal e senador, para a página de
cada parlamentar (site/parlamentar.html).

Câmara dos Deputados: arquivos anuais dos Dados Abertos (sem chave),
conferidos em 17/11/2026:
  https://dadosabertos.camara.leg.br/arquivos/deputados/csv/deputados.csv
  .../votacoes/csv/votacoes-AAAA.csv               votações (órgão, data, resultado)
  .../votacoesVotos/csv/votacoesVotos-AAAA.csv     o voto de cada deputado
  .../votacoesProposicoes/csv/votacoesProposicoes-AAAA.csv   o que foi votado
  .../proposicoes/csv/proposicoes-AAAA.csv         proposições do ano
  .../proposicoesAutores/csv/proposicoesAutores-AAAA.csv     quem assinou
Entram só as votações nominais do Plenário (órgão PLEN com voto registrado)
e, dos projetos, os tipos que viram lei ou mudam a Constituição: PL, PLP, PEC
e PDL, apresentados no ano.

Senado Federal: serviços de dados abertos (sem chave), conferidos em
17/11/2026 (os antigos, /plenario/lista/votacao e /senador/X/autorias, estão
marcados para desativação):
  https://legis.senado.leg.br/dadosabertos/votacao?dataInicio=AAAA-01-01&dataFim=AAAA-12-31
      votações nominais do Plenário, cada uma com os 81 senadores e o voto ou
      o motivo de não ter votado (licença, missão, não compareceu)
  https://legis.senado.leg.br/dadosabertos/processo?codigoParlamentarAutor=X&dataInicioApresentacao=...&dataFimApresentacao=...
      o que cada senador apresentou no ano
  https://legis.senado.leg.br/dadosabertos/senador/lista/atual.json
      senadores em exercício, com partido

Saídas:
  site/dados/parlamentares/oficiais.json          lista oficial: casa, id,
                                                  nome, sexo, partido, UF
  site/dados/parlamentares/votacoes/CASA-AAAA.json   votações do ano
  site/dados/parlamentares/CASA/ID.json           votos por ano e projetos
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

AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
DESTINO = "site/dados/parlamentares"
CAMARA = "https://dadosabertos.camara.leg.br/arquivos"
SENADO = "https://legis.senado.leg.br/dadosabertos"
# Tipos de documento do Senado que entram como projeto.
TIPOS_SENADO = {"PL": "PL", "PLS": "PL", "PLP": "PLP", "PLC": "PL", "PEC": "PEC", "PDL": "PDL", "PDS": "PDL"}
VOTO_SENADO = {"Sim": "S", "Não": "N", "Abstenção": "A", "Votou": "V"}
PRIMEIRO_ANO = 2023  # começo da legislatura 57
TIPOS_PROJETO = {
    "PL": "Projeto de lei",
    "PLP": "Projeto de lei complementar",
    "PEC": "Proposta de emenda à Constituição",
    "PDL": "Projeto de decreto legislativo",
}
# S sim, N não, A abstenção, O obstrução, P presidiu a sessão (artigo 17 do
# Regimento da Câmara: o presidente não vota), ? outro registro.
VOTO = {"Sim": "S", "Não": "N", "Abstenção": "A", "Obstrução": "O", "Artigo 17": "P"}


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def baixar(url, tentativas=4, aceitar=None):
    for k in range(tentativas):
        try:
            cab = {"User-Agent": AGENTE}
            if aceitar:
                cab["Accept"] = aceitar
            with urllib.request.urlopen(urllib.request.Request(url, headers=cab), timeout=600) as r:
                return r.read()
        except Exception as erro:  # noqa: BLE001
            print(f"  tentativa {k + 1} em {url}: {erro}", flush=True)
            time.sleep(20 * (k + 1))
    falhar(f"não consegui baixar {url}")
    return b""


def linhas_csv(url):
    csv.field_size_limit(10**8)
    texto = baixar(url).decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(texto), delimiter=";"))


def curto(texto, limite=220):
    t = " ".join((texto or "").split())
    return t if len(t) <= limite else t[: limite - 1].rstrip() + "…"


def gravar_json(caminho, dados):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(temporario, caminho)


def id_do_fim(uri):
    return (uri or "").rstrip("/").rsplit("/", 1)[-1]


# ---------------------------------------------------------------------------
# Câmara


def camara(anos):
    sexo = {}
    for l in linhas_csv(f"{CAMARA}/deputados/csv/deputados.csv"):
        sexo[id_do_fim(l.get("uri"))] = (l.get("siglaSexo") or "").strip()
    if len(sexo) < 5000:
        falhar(f"lista de deputados da Câmara com {len(sexo)} nomes")

    pessoas = {}  # id -> {nome, partido, uf, quando}
    def ver(did, nome, partido, uf, quando):
        atual = pessoas.get(did)
        if did and nome and (atual is None or quando >= atual["quando"]):
            pessoas[did] = {"nome": " ".join(nome.split()), "partido": (partido or "").strip(), "uf": (uf or "").strip(), "quando": quando}

    votos = collections.defaultdict(dict)       # id -> ano -> [[índice, voto]]
    projetos = collections.defaultdict(list)    # id -> [...]
    for ano in anos:
        votacoes = linhas_csv(f"{CAMARA}/votacoes/csv/votacoes-{ano}.csv")
        plen = {v["id"]: v for v in votacoes if v.get("siglaOrgao") == "PLEN"}
        objeto = {}
        for l in linhas_csv(f"{CAMARA}/votacoesProposicoes/csv/votacoesProposicoes-{ano}.csv"):
            objeto.setdefault(l["idVotacao"], l)
        registros = linhas_csv(f"{CAMARA}/votacoesVotos/csv/votacoesVotos-{ano}.csv")
        nominais = sorted({r["idVotacao"] for r in registros if r["idVotacao"] in plen},
                          key=lambda i: (plen[i].get("dataHoraRegistro") or plen[i].get("data") or "", i))
        posicao = {vid: k for k, vid in enumerate(nominais)}
        lista = []
        for vid in nominais:
            v, o = plen[vid], objeto.get(vid, {})
            lista.append([vid, (v.get("data") or "")[:10], o.get("proposicao_titulo") or "", curto(o.get("proposicao_ementa")),
                          curto(v.get("descricao")), int(v.get("votosSim") or 0), int(v.get("votosNao") or 0),
                          int(v.get("votosOutros") or 0), o.get("proposicao_id") or ""])
        por_dep = collections.defaultdict(list)
        for r in registros:
            k = posicao.get(r["idVotacao"])
            if k is None:
                continue
            did = r.get("deputado_id") or ""
            por_dep[did].append([k, VOTO.get(r.get("voto"), "?")])
            ver(did, r.get("deputado_nome"), r.get("deputado_siglaPartido"), r.get("deputado_siglaUf"), r.get("dataHoraVoto") or "")
        for did, lst in por_dep.items():
            votos[did][str(ano)] = sorted(lst)
        if ano < dt.date.today().year and len(lista) < 100:
            falhar(f"Câmara {ano}: só {len(lista)} votações nominais no Plenário")
        gravar_json(f"{DESTINO}/votacoes/camara-{ano}.json", {
            "casa": "camara", "ano": ano,
            "campos": ["id", "data", "proposicao", "ementa", "resultado", "sim", "nao", "outros", "id_proposicao"],
            "votacoes": lista,
        })
        print(f"Câmara {ano}: {len(lista)} votações nominais no Plenário, {len(por_dep)} deputados com voto", flush=True)

        props = {}
        for l in linhas_csv(f"{CAMARA}/proposicoes/csv/proposicoes-{ano}.csv"):
            if l.get("siglaTipo") in TIPOS_PROJETO and (l.get("dataApresentacao") or "")[:4] == str(ano):
                props[l["id"]] = l
        n = 0
        for a in linhas_csv(f"{CAMARA}/proposicoesAutores/csv/proposicoesAutores-{ano}.csv"):
            p = props.get(a.get("idProposicao"))
            did = a.get("idDeputadoAutor") or ""
            if not p or not did or a.get("codTipoAutor") != "10000":
                continue
            ver(did, a.get("nomeAutor"), a.get("siglaPartidoAutor"), a.get("siglaUFAutor"), (p.get("dataApresentacao") or "")[:10])
            projetos[did].append([p["id"], f'{p["siglaTipo"]} {p["numero"]}/{p["ano"]}', p["siglaTipo"], curto(p.get("ementa")),
                                  (p.get("dataApresentacao") or "")[:10], curto(p.get("ultimoStatus_descricaoSituacao"), 80),
                                  1 if a.get("ordemAssinatura") == "1" else 0])
            n += 1
        print(f"Câmara {ano}: {len(props)} projetos (PL, PLP, PEC, PDL), {n} assinaturas de deputados", flush=True)

    if len(pessoas) < 500:
        falhar(f"Câmara: só {len(pessoas)} deputados com voto ou projeto")
    oficiais = []
    for did, p in pessoas.items():
        lista_proj = sorted({x[0]: x for x in projetos.get(did, [])}.values(), key=lambda x: (x[4], x[0]), reverse=True)
        gravar_json(f"{DESTINO}/camara/{did}.json", {
            "casa": "camara", "id": did, "nome": p["nome"], "sexo": sexo.get(did, ""), "partido": p["partido"], "uf": p["uf"],
            "atualizado": dt.date.today().isoformat(),
            "votos": votos.get(did, {}),
            "campos_projeto": ["id", "numero", "tipo", "ementa", "data", "situacao", "autor_principal"],
            "projetos": lista_proj,
        })
        oficiais.append(["camara", did, p["nome"], sexo.get(did, ""), p["partido"], p["uf"]])
    return oficiais


# ---------------------------------------------------------------------------
# Senado


def json_do_senado(url):
    return json.loads(baixar(url, aceitar="application/json"))


def senado(anos):
    pessoas = {}  # código -> {nome, sexo, partido, uf, quando}
    def ver(cod, nome, sexo, partido, uf, quando):
        atual = pessoas.get(cod)
        if cod and nome and (atual is None or quando >= atual["quando"]):
            pessoas[cod] = {"nome": " ".join(nome.split()), "sexo": (sexo or "")[:1].upper(), "partido": (partido or "").strip(),
                            "uf": (uf or "").strip(), "quando": quando}

    votos = collections.defaultdict(dict)
    for ano in anos:
        lista_api = json_do_senado(f"{SENADO}/votacao?dataInicio={ano}-01-01&dataFim={ano}-12-31")
        if not isinstance(lista_api, list):
            falhar(f"Senado {ano}: resposta inesperada das votações")
        lista_api = [v for v in lista_api if (v.get("dataSessao") or "")[:4] == str(ano) and v.get("casaSessao") == "SF"]
        lista_api.sort(key=lambda v: (v.get("dataSessao") or "", int(v.get("sequencialVotacao") or 0)))
        lista, por_sen = [], collections.defaultdict(list)
        for k, v in enumerate(lista_api):
            secreta = v.get("votacaoSecreta") == "S"
            contagem = collections.Counter()
            for x in v.get("votos") or []:
                cod = str(x.get("codigoParlamentar") or "")
                sigla = (x.get("siglaVotoParlamentar") or "").strip()
                codigo = VOTO_SENADO.get(sigla) or ("P" if sigla.lower().startswith("presidente") else f"x:{sigla}" if sigla else "?")
                if secreta and codigo in ("S", "N", "A"):
                    codigo = "V"
                contagem[codigo] += 1
                por_sen[cod].append([k, codigo])
                ver(cod, x.get("nomeParlamentar"), x.get("sexoParlamentar"), x.get("siglaPartidoParlamentar"),
                    x.get("siglaUFParlamentar"), v.get("dataSessao") or "")
            lista.append([str(v.get("codigoSessaoVotacao")), (v.get("dataSessao") or "")[:10], v.get("identificacao") or "",
                          curto(v.get("ementa")), curto(v.get("descricaoVotacao")), contagem["S"], contagem["N"], contagem["A"],
                          str(v.get("codigoMateria") or ""), 1 if secreta else 0,
                          {"A": "Aprovada", "R": "Rejeitada"}.get(v.get("resultadoVotacao"), "")])
        for cod, lst in por_sen.items():
            votos[cod][str(ano)] = lst
        if ano < dt.date.today().year and len(lista) < 30:
            falhar(f"Senado {ano}: só {len(lista)} votações nominais")
        gravar_json(f"{DESTINO}/votacoes/senado-{ano}.json", {
            "casa": "senado", "ano": ano,
            "campos": ["id", "data", "proposicao", "ementa", "descricao", "sim", "nao", "abstencao", "id_materia", "secreta", "resultado"],
            "votacoes": lista,
        })
        print(f"Senado {ano}: {len(lista)} votações nominais, {len(por_sen)} senadores", flush=True)

    # Partido atual de quem está em exercício.
    atual = json_do_senado(f"{SENADO}/senador/lista/atual.json")
    for p in (((atual.get("ListaParlamentarEmExercicio") or {}).get("Parlamentares") or {}).get("Parlamentar") or []):
        i = p.get("IdentificacaoParlamentar") or {}
        cod = str(i.get("CodigoParlamentar") or "")
        ver(cod, i.get("NomeParlamentar"), i.get("SexoParlamentar"), i.get("SiglaPartidoParlamentar"), i.get("UfParlamentar"), "9999")
    if len(pessoas) < 81:
        falhar(f"Senado: só {len(pessoas)} senadores")

    oficiais = []
    for cod, p in pessoas.items():
        projetos = []
        for ano in anos:
            time.sleep(0.4)
            itens = json_do_senado(f"{SENADO}/processo?codigoParlamentarAutor={cod}"
                                   f"&dataInicioApresentacao={ano}-01-01&dataFimApresentacao={ano}-12-31")
            for x in itens if isinstance(itens, list) else []:
                ident = (x.get("identificacao") or "").strip()
                tipo = TIPOS_SENADO.get(ident.split(" ")[0])
                if not tipo or (x.get("dataApresentacao") or "")[:4] != str(ano):
                    continue
                autoria = (x.get("autoria") or "").split(",")[0]
                principal = 1 if p["nome"].lower() in autoria.lower() else 0
                projetos.append([str(x.get("codigoMateria") or x.get("id") or ""), ident, tipo, curto(x.get("ementa")),
                                 (x.get("dataApresentacao") or "")[:10], curto((x.get("situacaoAtual") or "").replace("_", " ").capitalize(), 80), principal])
        projetos = sorted({x[0]: x for x in projetos}.values(), key=lambda x: (x[4], x[0]), reverse=True)
        gravar_json(f"{DESTINO}/senado/{cod}.json", {
            "casa": "senado", "id": cod, "nome": p["nome"], "sexo": p["sexo"], "partido": p["partido"], "uf": p["uf"],
            "atualizado": dt.date.today().isoformat(),
            "votos": votos.get(cod, {}),
            "campos_projeto": ["id", "numero", "tipo", "ementa", "data", "situacao", "autor_principal"],
            "projetos": projetos,
        })
        oficiais.append(["senado", cod, p["nome"], p["sexo"], p["partido"], p["uf"]])
    print(f"Senado: {len(oficiais)} senadores", flush=True)
    return oficiais


# ---------------------------------------------------------------------------


def main():
    ano_atual = dt.date.today().year
    anos = list(range(PRIMEIRO_ANO, ano_atual + 1))
    oficiais = camara(anos) + senado(anos)
    oficiais.sort(key=lambda x: (x[0], x[2]))
    gravar_json(f"{DESTINO}/oficiais.json", {
        "atualizado": dt.date.today().isoformat(), "anos": anos,
        "campos": ["casa", "id", "nome", "sexo", "partido", "uf"],
        "parlamentares": oficiais,
    })
    print(f"oficiais: {collections.Counter(x[0] for x in oficiais)}")


if __name__ == "__main__":
    main()
