#!/usr/bin/env python3
"""Resume a cota parlamentar de deputados e senadores por parlamentar, estado
e tipo de despesa.

Fontes oficiais:
  Câmara: Cota para o Exercício da Atividade Parlamentar (CEAP), arquivo anual
          https://www.camara.leg.br/cotas/Ano-AAAA.csv.zip
          Deputados em exercício no ano: API de Dados Abertos da Câmara,
          /api/v2/deputados?dataInicio=AAAA-01-01&dataFim=AAAA-12-31
  Senado: Cota para o Exercício da Atividade Parlamentar dos Senadores (CEAPS)
          https://www.senado.leg.br/transparencia/LAI/verba/despesa_ceaps_AAAA.csv
          Senadores (sigla do estado e partido): Dados Abertos do Senado,
          /dadosabertos/senador/lista/legislatura/56/57.json e lista/atual.json

Saída:
  site/dados/cota/indice.json   (anos disponíveis e data da atualização)
  site/dados/cota/AAAA.json     (por ano: totais por parlamentar e por tipo de despesa)
  dados-fonte/cota/origem.json  (URL, tamanho e SHA-256 de cada arquivo original)

O site mostra só somas. Não grava CPF, CNPJ, fornecedor nem número de
documento. O valor usado é o líquido reembolsado (vlrLiquido na Câmara,
VALOR_REEMBOLSADO no Senado); créditos de passagens devolvidas entram com
sinal negativo, como no arquivo.

Os tipos de despesa das duas Casas são diferentes; cada um entra num grupo
comum por palavras do nome (ver GRUPOS). Tipo sem grupo vai para "outros" e
aparece em "tipos_em_outros", para conferência.

Se faltar coluna esperada, se um valor não for número ou se os totais forem
implausíveis, o script falha e não grava nada; o site continua com a versão
anterior.

Uso: python3 scripts/cota_para_json.py [--recentes]
  --recentes  só o ano corrente e o anterior (os outros anos ficam como estão)
"""

import csv
import datetime as dt
import hashlib
import io
import json
import os
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile

PRIMEIRO_ANO = 2019
DESTINO = "site/dados/cota"
ORIGEM = "dados-fonte/cota/origem.json"
AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"

UFS = {"AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB",
       "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"}

# Grupos comuns às duas Casas, na ordem em que o site mostra. A primeira regra
# que casar com o nome (sem acento, minúsculo) decide o grupo.
GRUPOS = [
    ("passagens", "Passagens", ("passage",)),
    ("divulgacao", "Divulgação do mandato", ("divulga",)),
    ("consultoria", "Consultorias e pesquisas", ("consultori",)),
    ("seguranca", "Segurança", ("seguranca",)),
    # Antes de "telefone": o tipo do Senado para material de escritório cita
    # "despesas postais".
    ("escritorio", "Escritório (aluguel, contas e material)", ("escritorio", "aluguel de imoveis", "material de consumo")),
    ("telefone", "Telefone e correio", ("telefon", "postais")),
    ("locomocao", "Carro, combustível, hospedagem e alimentação",
     ("combustiv", "veicul", "taxi", "pedagio", "hospedagem", "alimenta", "locomoc", "aeronave", "embarca")),
]
OUTROS = ("outros", "Outros")


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def sem_acento(texto):
    texto = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in texto if not unicodedata.combining(c)).strip()


def grupo_de(tipo):
    t = sem_acento(tipo).lower()
    for chave, _nome, palavras in GRUPOS:
        if any(p in t for p in palavras):
            return chave
    return OUTROS[0]


ORDEM_GRUPOS = [g[0] for g in GRUPOS] + [OUTROS[0]]


def baixar(url, tentativas=4, aceitar=None):
    cabecalhos = {"User-Agent": AGENTE}
    if aceitar:
        cabecalhos["Accept"] = aceitar
    for k in range(tentativas):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=cabecalhos), timeout=180) as r:
                return r.read()
        except Exception as erro:  # noqa: BLE001
            if k == tentativas - 1:
                falhar(f"não foi possível baixar {url}: {erro}")
            time.sleep(5 * (k + 1))
    return None


def decodificar(bruto):
    for codificacao in ("utf-8-sig", "cp1252"):
        try:
            return bruto.decode(codificacao)
        except UnicodeDecodeError:
            continue
    falhar("codificação desconhecida")
    return ""


def numero(texto, onde):
    t = (texto or "").strip()
    if t == "":
        return 0.0
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".")
    elif "," in t:
        t = t.replace(",", ".")
    try:
        return float(t)
    except ValueError:
        falhar(f"valor inválido {texto!r} em {onde}")
        return 0.0


def novo_parlamentar(ident, nome, uf):
    return {"id": ident, "nome": nome, "uf": uf, "partido": None, "_mes_partido": -1,
            "total": 0.0, "meses": set(), "grupos": {g: 0.0 for g in ORDEM_GRUPOS}}


def fechar(parlamentares):
    saida = []
    for p in sorted(parlamentares.values(), key=lambda x: (sem_acento(x["nome"]).lower(), x["id"])):
        saida.append({
            "id": p["id"], "nome": p["nome"], "uf": p["uf"], "partido": p["partido"],
            "total": round(p["total"], 2), "meses": len(p["meses"]),
            "grupos": [round(p["grupos"][g], 2) for g in ORDEM_GRUPOS],
        })
    return saida


# ---------------------------------------------------------------------------
# Câmara
# ---------------------------------------------------------------------------

def deputados_em_exercicio(ano, hoje):
    fim = min(dt.date(ano, 12, 31), hoje)
    pagina = 1
    lista = {}
    while True:
        consulta = urllib.parse.urlencode({
            "dataInicio": f"{ano}-01-01", "dataFim": fim.isoformat(),
            "itens": 100, "pagina": pagina, "ordem": "ASC", "ordenarPor": "nome",
        })
        dados = json.loads(baixar(f"https://dadosabertos.camara.leg.br/api/v2/deputados?{consulta}", aceitar="application/json"))
        itens = dados.get("dados")
        if not isinstance(itens, list):
            falhar(f"API da Câmara sem lista de deputados ({ano}, página {pagina})")
        for d in itens:
            if d.get("id") is None or d.get("siglaUf") not in UFS:
                falhar(f"deputado sem id ou estado na API ({ano}): {d}")
            lista[str(d["id"])] = {"id": str(d["id"]), "nome": d.get("nome", ""), "uf": d["siglaUf"], "partido": d.get("siglaPartido")}
        if not any(l.get("rel") == "next" for l in dados.get("links", [])):
            break
        pagina += 1
        time.sleep(0.3)
    # 513 cadeiras; com suplentes que assumem no ano, um pouco mais.
    if not 513 <= len(lista) <= 800:
        falhar(f"API da Câmara: {len(lista)} deputados em exercício em {ano}, fora do esperado")
    return lista


def ler_camara(ano, origem):
    url = f"https://www.camara.leg.br/cotas/Ano-{ano}.csv.zip"
    bruto = baixar(url)
    origem[url] = {"bytes": len(bruto), "sha256": hashlib.sha256(bruto).hexdigest()}
    with zipfile.ZipFile(io.BytesIO(bruto)) as z:
        nomes = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if len(nomes) != 1:
            falhar(f"{url}: esperado um CSV no zip, veio {z.namelist()}")
        texto = decodificar(z.read(nomes[0]))
    leitor = csv.DictReader(io.StringIO(texto, newline=""), delimiter=";")
    colunas = set(leitor.fieldnames or [])
    exigidas = {"txNomeParlamentar", "ideCadastro", "sgUF", "sgPartido", "txtDescricao", "vlrLiquido", "numMes", "numAno"}
    if not exigidas <= colunas:
        falhar(f"{url}: faltam colunas {sorted(exigidas - colunas)}; colunas do arquivo: {sorted(colunas)}")

    deputados = {}
    tipos_em_outros = set()
    fora = 0.0
    linhas = 0
    ultimo_mes = 0
    for n, linha in enumerate(leitor, start=2):
        linhas += 1
        onde = f"{url}, linha {n}"
        valor = numero(linha["vlrLiquido"], onde)
        ident = (linha["ideCadastro"] or "").strip()
        uf = (linha["sgUF"] or "").strip()
        # Linhas sem deputado (lideranças de partido) ficam fora das somas por
        # parlamentar e são informadas à parte.
        if not ident or uf not in UFS:
            fora += valor
            continue
        try:
            ano_linha = int(linha["numAno"])
            mes = int(linha["numMes"])
        except ValueError:
            falhar(f"ano ou mês inválido em {onde}")
        if ano_linha != ano or not 1 <= mes <= 12:
            falhar(f"{onde}: ano {ano_linha}, mês {mes} fora do arquivo de {ano}")
        ultimo_mes = max(ultimo_mes, mes)
        d = deputados.setdefault(ident, novo_parlamentar(ident, linha["txNomeParlamentar"].strip(), uf))
        if mes >= d["_mes_partido"]:
            d["_mes_partido"] = mes
            d["partido"] = (linha["sgPartido"] or "").strip() or d["partido"]
        tipo = linha["txtDescricao"]
        g = grupo_de(tipo)
        if g == OUTROS[0]:
            tipos_em_outros.add(tipo.strip())
        d["grupos"][g] += valor
        d["total"] += valor
        d["meses"].add(mes)
    return deputados, sorted(tipos_em_outros), round(fora, 2), linhas, ultimo_mes


# ---------------------------------------------------------------------------
# Senado
# ---------------------------------------------------------------------------

def procurar(objeto, chave):
    """Todos os dicionários com a chave pedida, em qualquer nível do JSON."""
    if isinstance(objeto, dict):
        if chave in objeto:
            yield objeto
        for v in objeto.values():
            yield from procurar(v, chave)
    elif isinstance(objeto, list):
        for v in objeto:
            yield from procurar(v, chave)


def senadores_conhecidos():
    """Nome normalizado -> estado e partido, das legislaturas desde 2019 e da lista atual."""
    mapa = {}
    atuais = set()
    for endereco, atual in (("https://legis.senado.leg.br/dadosabertos/senador/lista/legislatura/56/57.json", False),
                            ("https://legis.senado.leg.br/dadosabertos/senador/lista/atual.json", True)):
        dados = json.loads(baixar(endereco, aceitar="application/json"))
        for item in procurar(dados, "IdentificacaoParlamentar"):
            ident = item["IdentificacaoParlamentar"]
            nome = ident.get("NomeParlamentar") or ""
            chave = sem_acento(nome).upper()
            if not chave:
                continue
            uf = ident.get("UfParlamentar")
            mapa[chave] = {"nome": nome, "uf": uf if uf in UFS else mapa.get(chave, {}).get("uf"),
                           "partido": ident.get("SiglaPartidoParlamentar") or mapa.get(chave, {}).get("partido"),
                           "codigo": ident.get("CodigoParlamentar")}
            if atual:
                atuais.add(chave)
    if len(mapa) < 81 or len(atuais) < 70:
        falhar(f"listas do Senado com {len(mapa)} senadores conhecidos e {len(atuais)} atuais, fora do esperado")
    return mapa, atuais


def ler_senado(ano, origem, conhecidos):
    url = f"https://www.senado.leg.br/transparencia/LAI/verba/despesa_ceaps_{ano}.csv"
    bruto = baixar(url)
    origem[url] = {"bytes": len(bruto), "sha256": hashlib.sha256(bruto).hexdigest()}
    texto = decodificar(bruto)
    # A primeira linha traz a data da última atualização; o cabeçalho vem depois.
    inicio = texto.find("ANO")
    if inicio < 0:
        falhar(f"{url}: cabeçalho não encontrado")
    inicio = texto.rfind("\n", 0, inicio) + 1
    leitor = csv.DictReader(io.StringIO(texto[inicio:], newline=""), delimiter=";")
    colunas = set(leitor.fieldnames or [])
    exigidas = {"ANO", "MES", "SENADOR", "TIPO_DESPESA", "VALOR_REEMBOLSADO"}
    if not exigidas <= colunas:
        falhar(f"{url}: faltam colunas {sorted(exigidas - colunas)}; colunas do arquivo: {sorted(colunas)}")

    senadores = {}
    tipos_em_outros = set()
    sem_estado = set()
    linhas = 0
    ultimo_mes = 0
    for n, linha in enumerate(leitor, start=2):
        linhas += 1
        onde = f"{url}, linha {n}"
        try:
            ano_linha = int(linha["ANO"])
            mes = int(linha["MES"])
        except (TypeError, ValueError):
            falhar(f"ano ou mês inválido em {onde}")
        if ano_linha != ano or not 1 <= mes <= 12:
            falhar(f"{onde}: ano {ano_linha}, mês {mes} fora do arquivo de {ano}")
        ultimo_mes = max(ultimo_mes, mes)
        nome = (linha["SENADOR"] or "").strip()
        chave = sem_acento(nome).upper()
        info = conhecidos.get(chave, {})
        if not info.get("uf"):
            sem_estado.add(nome)
        s = senadores.setdefault(chave, novo_parlamentar(chave, info.get("nome") or nome.title(), info.get("uf")))
        s["partido"] = info.get("partido")
        valor = numero(linha["VALOR_REEMBOLSADO"], onde)
        tipo = linha["TIPO_DESPESA"]
        g = grupo_de(tipo)
        if g == OUTROS[0]:
            tipos_em_outros.add(tipo.strip())
        s["grupos"][g] += valor
        s["total"] += valor
        s["meses"].add(mes)
    if sem_estado:
        print(f"Aviso: senadores sem estado na lista oficial ({ano}): {sorted(sem_estado)}")
    return senadores, sorted(tipos_em_outros), linhas, ultimo_mes


# ---------------------------------------------------------------------------

def conferir(nome, ano, parlamentares, total, ultimo_mes, minimo_por_mes, faixa):
    meses = max(ultimo_mes, 1)
    if not faixa[0] <= len(parlamentares) <= faixa[1]:
        falhar(f"{nome} {ano}: {len(parlamentares)} parlamentares com gasto, fora do esperado {faixa}")
    if total < minimo_por_mes * meses:
        falhar(f"{nome} {ano}: total de R$ {total:,.2f} em {meses} meses, abaixo do esperado")


def main():
    recentes = "--recentes" in sys.argv[1:]
    hoje = dt.date.today()
    anos = list(range(PRIMEIRO_ANO, hoje.year + 1))
    if recentes:
        anos = [a for a in anos if a >= hoje.year - 1]
    origem = {}
    if os.path.exists(ORIGEM):
        with open(ORIGEM, encoding="utf-8") as fh:
            origem = json.load(fh).get("arquivos", {})

    conhecidos, senadores_atuais = senadores_conhecidos()
    saidas = {}
    for ano in anos:
        deputados, outros_camara, fora, linhas_c, mes_c = ler_camara(ano, origem)
        total_c = sum(d["total"] for d in deputados.values())
        conferir("Câmara", ano, deputados, total_c, mes_c, 5_000_000, (300, 800))
        exercicio = deputados_em_exercicio(ano, hoje)
        sem_gasto_c = sorted((v for k, v in exercicio.items() if k not in deputados),
                             key=lambda x: sem_acento(x["nome"]).lower())

        senadores, outros_senado, linhas_s, mes_s = ler_senado(ano, origem, conhecidos)
        total_s = sum(s["total"] for s in senadores.values())
        conferir("Senado", ano, senadores, total_s, mes_s, 500_000, (60, 120))
        # Sem a data de exercício de cada senador, quem não usou a cota só é
        # listado no ano corrente, entre os senadores atuais.
        sem_gasto_s = None
        if ano == hoje.year:
            sem_gasto_s = sorted(({"id": k, "nome": conhecidos[k]["nome"], "uf": conhecidos[k]["uf"], "partido": conhecidos[k]["partido"]}
                                  for k in senadores_atuais if k not in senadores),
                                 key=lambda x: sem_acento(x["nome"]).lower())

        saidas[ano] = {
            "ano": ano,
            "ate_mes": {"camara": mes_c, "senado": mes_s},
            "grupos": [{"id": g[0], "nome": g[1]} for g in GRUPOS] + [{"id": OUTROS[0], "nome": OUTROS[1]}],
            "camara": {"total": round(total_c, 2), "parlamentares": fechar(deputados), "sem_gasto": sem_gasto_c,
                       "liderancas": fora, "linhas": linhas_c, "tipos_em_outros": outros_camara},
            "senado": {"total": round(total_s, 2), "parlamentares": fechar(senadores), "sem_gasto": sem_gasto_s,
                       "linhas": linhas_s, "tipos_em_outros": outros_senado},
        }
        print(f"{ano}: Câmara {len(deputados)} deputados, R$ {total_c:,.2f} até o mês {mes_c}, {len(sem_gasto_c)} sem gasto; "
              f"Senado {len(senadores)} senadores, R$ {total_s:,.2f} até o mês {mes_s}; "
              f"em 'outros': Câmara {outros_camara}, Senado {outros_senado}")

    os.makedirs(DESTINO, exist_ok=True)
    os.makedirs(os.path.dirname(ORIGEM), exist_ok=True)
    for ano, dados in saidas.items():
        with open(os.path.join(DESTINO, f"{ano}.json"), "w", encoding="utf-8") as fh:
            json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
    existentes = sorted(int(n[:4]) for n in os.listdir(DESTINO) if n[:4].isdigit() and n.endswith(".json"))
    with open(os.path.join(DESTINO, "indice.json"), "w", encoding="utf-8") as fh:
        json.dump({"anos": existentes, "atualizado_em": hoje.isoformat()}, fh, ensure_ascii=False)
    with open(ORIGEM, "w", encoding="utf-8") as fh:
        json.dump({"atualizado_em": hoje.isoformat(), "arquivos": origem}, fh, ensure_ascii=False, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
