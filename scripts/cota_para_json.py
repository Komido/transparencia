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
import re
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
    # A Câmara paga pela cota a complementação do auxílio-moradia; fica num
    # grupo próprio para aparecer separado.
    ("moradia", "Complemento de auxílio-moradia", ("auxilio-moradia", "auxilio moradia")),
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


def chave_nome(nome):
    """Nome sem acento, sem pontuação e em maiúsculas, para casar o arquivo
    da cota do Senado com a lista oficial ("DR. HIRAN" = "DR HIRAN")."""
    t = re.sub(r"[^A-Z0-9 ]", " ", sem_acento(nome).upper())
    return " ".join(t.split())


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
        inicio = time.monotonic()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=cabecalhos), timeout=180) as r:
                bruto = r.read()
            if "api/v2/deputados" not in url:
                print(f"  baixado {url}: {len(bruto):,} bytes em {time.monotonic() - inicio:.0f} s", flush=True)
            return bruto
        except Exception as erro:  # noqa: BLE001
            print(f"  tentativa {k + 1} falhou para {url} depois de {time.monotonic() - inicio:.0f} s: {erro}", flush=True)
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


def fechar(parlamentares, ano_todo):
    """ano_todo: ids de quem esteve no cargo o ano todo, ou None quando não há
    como saber (o campo sai nulo)."""
    saida = []
    for p in sorted(parlamentares.values(), key=lambda x: (sem_acento(x["nome"]).lower(), x["id"])):
        saida.append({
            "id": p["id"], "nome": p["nome"], "uf": p["uf"], "partido": p["partido"],
            "total": round(p["total"], 2), "meses": len(p["meses"]),
            "grupos": [round(p["grupos"][g], 2) for g in ORDEM_GRUPOS],
            "ano_todo": None if ano_todo is None else p["id"] in ano_todo,
        })
    return saida


def trimestres(ano, hoje):
    """Trimestres do ano já começados, como (início, fim), com o último
    cortado em hoje."""
    fim_do_ano = min(dt.date(ano, 12, 31), hoje)
    saida = []
    for mes in (1, 4, 7, 10):
        inicio = dt.date(ano, mes, 1)
        if inicio > fim_do_ano:
            break
        fim = dt.date(ano + 1, 1, 1) if mes == 10 else dt.date(ano, mes + 3, 1)
        saida.append((inicio, min(fim - dt.timedelta(days=1), fim_do_ano)))
    return saida


# ---------------------------------------------------------------------------
# Câmara
# ---------------------------------------------------------------------------

def deputados_no_periodo(inicio, fim):
    """Deputados em exercício em algum momento entre as duas datas (API da Câmara)."""
    pagina = 1
    lista = {}
    while True:
        consulta = urllib.parse.urlencode({
            "dataInicio": inicio.isoformat(), "dataFim": fim.isoformat(),
            "itens": 100, "pagina": pagina, "ordem": "ASC", "ordenarPor": "nome",
        })
        dados = json.loads(baixar(f"https://dadosabertos.camara.leg.br/api/v2/deputados?{consulta}", aceitar="application/json"))
        itens = dados.get("dados")
        if not isinstance(itens, list):
            falhar(f"API da Câmara sem lista de deputados ({inicio} a {fim}, página {pagina})")
        for d in itens:
            if d.get("id") is None or d.get("siglaUf") not in UFS:
                falhar(f"deputado sem id ou estado na API ({inicio} a {fim}): {d}")
            lista[str(d["id"])] = {"id": str(d["id"]), "nome": d.get("nome", ""), "uf": d["siglaUf"], "partido": d.get("siglaPartido")}
        if not any(l.get("rel") == "next" for l in dados.get("links", [])):
            break
        pagina += 1
        time.sleep(0.3)
    return lista


def deputados_em_exercicio(ano, hoje):
    """Quem esteve em exercício no ano e quem esteve em todos os trimestres
    já começados (o ano todo, ou até hoje no ano corrente)."""
    fim = min(dt.date(ano, 12, 31), hoje)
    lista = deputados_no_periodo(dt.date(ano, 1, 1), fim)
    # 513 cadeiras; com suplentes que assumem no ano, um pouco mais. Nos anos
    # de troca de legislatura (2019, 2023, 2027), quem saiu em janeiro e quem
    # entrou em fevereiro contam no mesmo ano.
    if not 513 <= len(lista) <= 1100:
        falhar(f"API da Câmara: {len(lista)} deputados em exercício em {ano}, fora do esperado")
    todos_os_trimestres = None
    for inicio, fim_trimestre in trimestres(ano, hoje):
        ids = set(deputados_no_periodo(inicio, fim_trimestre))
        todos_os_trimestres = ids if todos_os_trimestres is None else todos_os_trimestres & ids
    return lista, todos_os_trimestres or set()


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


def primeiro(objeto, chave):
    """Primeiro valor não vazio da chave pedida, em qualquer nível."""
    for d in procurar(objeto, chave):
        if d.get(chave):
            return d[chave]
    return None


def exercicios_de(item):
    """Períodos de exercício (início, fim) dos mandatos de um item da lista do
    Senado. Sem data de fim, o exercício continua."""
    periodos = []
    for mandato in procurar(item, "Exercicios"):
        bloco = mandato["Exercicios"]
        lista = bloco.get("Exercicio") if isinstance(bloco, dict) else bloco
        if isinstance(lista, dict):
            lista = [lista]
        for e in lista if isinstance(lista, list) else []:
            if not isinstance(e, dict):
                continue
            try:
                inicio = dt.date.fromisoformat(str(e.get("DataInicio"))[:10])
                fim = dt.date.fromisoformat(str(e["DataFim"])[:10]) if e.get("DataFim") else dt.date.max
            except ValueError:
                continue
            if fim >= inicio:
                periodos.append((inicio, fim))
    return periodos


def em_exercicio(periodos, inicio, fim):
    return any(a <= fim and b >= inicio for a, b in periodos)


def senadores_conhecidos():
    """Nome normalizado -> estado e partido, das legislaturas 55 a 57
    (2015 a 2027: em janeiro de 2019 ainda estavam no cargo senadores eleitos
    em 2010) e da lista atual. Vale o nome parlamentar e o nome completo."""
    mapa = {}
    atuais = set()
    for endereco, atual in (("https://legis.senado.leg.br/dadosabertos/senador/lista/legislatura/55/57.json", False),
                            ("https://legis.senado.leg.br/dadosabertos/senador/lista/atual.json", True)):
        dados = json.loads(baixar(endereco, aceitar="application/json"))
        for item in procurar(dados, "IdentificacaoParlamentar"):
            ident = item["IdentificacaoParlamentar"]
            nome = ident.get("NomeParlamentar") or ""
            chave = chave_nome(nome)
            if not chave:
                continue
            anterior = mapa.get(chave, {})
            # Em algumas listas o estado fica no bloco do mandato, não na
            # identificação do senador.
            uf = ident.get("UfParlamentar") or primeiro(item, "UfParlamentar")
            partido = ident.get("SiglaPartidoParlamentar") or primeiro(item, "SiglaPartidoParlamentar")
            info = {"nome": nome, "uf": uf if uf in UFS else anterior.get("uf"),
                    "partido": partido or anterior.get("partido"),
                    "codigo": ident.get("CodigoParlamentar"),
                    "exercicios": sorted(set(anterior.get("exercicios", [])) | set(exercicios_de(item)))}
            mapa[chave] = info
            completo = chave_nome(ident.get("NomeCompletoParlamentar") or "")
            if completo and completo not in mapa:
                mapa[completo] = info
            if atual:
                atuais.add(chave)
    if len(mapa) < 81 or len(atuais) < 70:
        falhar(f"listas do Senado com {len(mapa)} senadores conhecidos e {len(atuais)} atuais, fora do esperado")
    # O nome parlamentar pode mudar de uma lista para outra; o código do
    # senador não muda. Os períodos de exercício são juntados pelo código.
    por_codigo = {}
    for v in mapa.values():
        por_codigo.setdefault(v["codigo"], set()).update(v["exercicios"])
    for v in mapa.values():
        v["exercicios"] = sorted(por_codigo[v["codigo"]])
    com_exercicio = sum(1 for v in por_codigo.values() if v)
    print(f"Senado: {len(mapa)} nomes nas listas, {sum(1 for v in mapa.values() if v['uf'])} com estado, "
          f"{com_exercicio} com períodos de exercício; {len(atuais)} senadores atuais", flush=True)
    return mapa, atuais


def casar_senador(chave, conhecidos):
    """Chave da lista oficial para um nome do arquivo da cota. Primeiro o nome
    igual; depois, se houver um único candidato, o nome em que um começa com
    as palavras do outro ("WEVERTON ROCHA" no arquivo e "WEVERTON" na lista).
    Sem candidato único, devolve None."""
    if chave in conhecidos:
        return chave
    palavras = chave.split()
    candidatos = {k for k in conhecidos
                  if (len(k.split()) <= len(palavras) and palavras[:len(k.split())] == k.split())
                  or (len(k.split()) > len(palavras) and k.split()[:len(palavras)] == palavras)}
    canonicos = {chave_nome(conhecidos[k]["nome"]) for k in candidatos}
    if len(canonicos) == 1:
        return next(iter(candidatos))
    return None


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
        # O senador entra pela chave da lista oficial, para que a conferência
        # de quem não usou a cota compare o mesmo nome dos dois lados.
        encontrada = casar_senador(chave_nome(nome), conhecidos)
        chave = chave_nome(conhecidos[encontrada]["nome"]) if encontrada else chave_nome(nome)
        info = conhecidos.get(encontrada, {}) if encontrada else {}
        if not info:
            sem_estado.add(f"{nome} (nome não encontrado)")
        elif not info.get("uf"):
            sem_estado.add(f"{nome} (sem estado na lista)")
        s = senadores.setdefault(chave, novo_parlamentar(chave, info.get("nome") or nome.title(), info.get("uf")))
        s["partido"] = info.get("partido")
        s["codigo"] = info.get("codigo")
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
        conferir("Câmara", ano, deputados, total_c, mes_c, 5_000_000, (300, 1100))
        exercicio, ano_todo_c = deputados_em_exercicio(ano, hoje)
        # "ano_todo": esteve em exercício em algum momento de cada trimestre do
        # ano (até hoje, no ano corrente). Quem ficou só parte do ano gasta
        # menos por isso; o site separa e não põe essas pessoas no ranking.
        sem_gasto_c = sorted(({**v, "ano_todo": k in ano_todo_c} for k, v in exercicio.items() if k not in deputados),
                             key=lambda x: (not x["ano_todo"], sem_acento(x["nome"]).lower()))
        print(f"{ano}: Câmara, {len(exercicio)} deputados em exercício, {len(ano_todo_c)} o ano todo", flush=True)

        senadores, outros_senado, linhas_s, mes_s = ler_senado(ano, origem, conhecidos)
        total_s = sum(s["total"] for s in senadores.values())
        conferir("Senado", ano, senadores, total_s, mes_s, 500_000, (60, 160))
        # Com os períodos de exercício das listas oficiais: quem esteve no
        # cargo no ano, quem esteve o ano todo e quem não usou a cota. Se as
        # listas não trouxerem os períodos (ou trouxerem algo fora do
        # esperado), volta ao que dá para afirmar sem eles: no ano corrente,
        # os senadores atuais sem gasto.
        # Um senador por código; nome, estado e partido da lista atual quando
        # ele está nela.
        unicos = {}
        for k, v in conhecidos.items():
            if v["codigo"] not in unicos or k in senadores_atuais:
                unicos[v["codigo"]] = v
        fim_do_ano = min(dt.date(ano, 12, 31), hoje)
        no_ano = {c: v for c, v in unicos.items() if em_exercicio(v["exercicios"], dt.date(ano, 1, 1), fim_do_ano)}
        codigos_ano_todo = {c for c, v in no_ano.items() if all(em_exercicio(v["exercicios"], a, b) for a, b in trimestres(ano, hoje))}
        codigos_com_gasto = {x["codigo"] for x in senadores.values()}
        sem_dono = [x["nome"] for x in senadores.values() if x["codigo"] not in no_ano]
        # Em ano de troca de legislatura, quem saiu em janeiro e quem entrou
        # em fevereiro contam juntos (134 em 2019).
        if 81 <= len(no_ano) <= 160 and 70 <= len(codigos_ano_todo) <= 81 and len(sem_dono) <= 3:
            ano_todo_s = {k for k, x in senadores.items() if x["codigo"] in codigos_ano_todo}
            sem_gasto_s = sorted(({"id": str(c), "nome": v["nome"], "uf": v["uf"], "partido": v["partido"], "ano_todo": c in codigos_ano_todo}
                                  for c, v in no_ano.items() if c not in codigos_com_gasto),
                                 key=lambda x: (not x["ano_todo"], sem_acento(x["nome"]).lower()))
            print(f"{ano}: Senado, {len(no_ano)} senadores em exercício, {len(codigos_ano_todo)} o ano todo; "
                  f"com gasto e sem exercício no ano: {sem_dono}", flush=True)
        else:
            print(f"Aviso: períodos de exercício do Senado fora do esperado em {ano} ({len(no_ano)} no ano, "
                  f"{len(codigos_ano_todo)} o ano todo, {len(sem_dono)} com gasto sem exercício: {sem_dono[:10]}); "
                  "sem ranking do Senado nesse ano", flush=True)
            ano_todo_s = None
            sem_gasto_s = None
            if ano == hoje.year:
                sem_gasto_s = sorted(({"id": k, "nome": conhecidos[k]["nome"], "uf": conhecidos[k]["uf"], "partido": conhecidos[k]["partido"]}
                                      for k in senadores_atuais if chave_nome(conhecidos[k]["nome"]) not in senadores),
                                     key=lambda x: sem_acento(x["nome"]).lower())

        saidas[ano] = {
            "ano": ano,
            "ate_mes": {"camara": mes_c, "senado": mes_s},
            "grupos": [{"id": g[0], "nome": g[1]} for g in GRUPOS] + [{"id": OUTROS[0], "nome": OUTROS[1]}],
            "camara": {"total": round(total_c, 2), "parlamentares": fechar(deputados, ano_todo_c), "sem_gasto": sem_gasto_c,
                       "liderancas": fora, "linhas": linhas_c, "tipos_em_outros": outros_camara},
            "senado": {"total": round(total_s, 2), "parlamentares": fechar(senadores, ano_todo_s), "sem_gasto": sem_gasto_s,
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
