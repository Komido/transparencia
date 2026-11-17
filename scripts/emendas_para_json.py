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

O arquivo traz o nome do município e o CNPJ de quem recebeu, não o código
do IBGE. Pagamento à prefeitura é ligado à cidade pelo CNPJ, com a lista de
entes do Tesouro (SICONFI), que traz o CNPJ e o código do IBGE de cada
prefeitura. Pagamento a fundo municipal (que tem CNPJ próprio) é ligado pelo
nome do município e pela UF, sem acento e sem diferença de maiúsculas, com a
lista de municípios do IBGE, os nomes da tabela oficial de códigos do TSE,
uma lista curta de grafias antigas conferidas no IBGE e os nomes que o
próprio arquivo usa nos pagamentos já ligados pelo CNPJ. Se mais de 0,5% do
valor ficar sem cidade, o script falha sem gravar.

Saídas:
  site/dados/emendas/UF.json   por cidade e ano: valor pago à prefeitura,
                               número de emendas e todos os autores, do que
                               mais mandou ao que menos mandou; os nomes
                               ficam uma vez só, na lista "nomes" do arquivo,
                               com o cargo ao lado (lista "cargos")

Cargo do autor: bancada, comissão e relator vêm do próprio nome; deputado e
senador, das listas oficiais da Câmara e do Senado já usadas na cota
parlamentar (site/dados/cota/AAAA.json), com o partido e a UF do ano mais
recente em que o nome aparece. Nome sem par nessas listas (ex-parlamentar,
suplente que não usou a cota) fica como "Câmara ou Senado".

Limite conhecido: parte das emendas é paga ao Banco do Brasil (CNPJ
00.000.000/0001-91, cidade "Brasília"), sem dizer qual prefeitura, estado ou
entidade recebeu; em 17/11/2026 eram R$ 33,98 bilhões desde 2023. Esse
dinheiro não entra na conta por cidade, que por isso é um piso.
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
SICONFI_ENTES = "https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes"
AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
DESTINO = "site/dados/emendas"
COTA = "site/dados/cota"
CNPJ_BANCO_DO_BRASIL = "00000000000191"
ARQUIVO = "EmendasParlamentares_PorFavorecido.csv"
COLUNAS = ["Código da Emenda", "Nome do Autor da Emenda", "Tipo de Emenda", "Ano/Mês", "Código do Favorecido",
           "Natureza Jurídica", "UF Favorecido", "Município Favorecido", "Valor Recebido"]
NATUREZAS = {"Município", "Fundo Público da Administração Direta Municipal"}
PRIMEIRO_ANO = 2019
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


# Nomes do Portal diferentes do nome do IBGE (grafia antiga ou município que
# mudou de nome), cada um conferido na lista de municípios do IBGE em
# 17/11/2026, com o código.
NOMES_ANTIGOS = {
    ("SAO LUIZ", "RR"): "1400605",                   # São Luiz do Anauá
    ("EMBU", "SP"): "3515004",                       # Embu das Artes
    ("SANTA ISABEL DO PARA", "PA"): "1506500",       # Santa Izabel do Pará
    ("ACU", "RN"): "2400208",                        # Assú
    ("PRESIDENTE JUSCELINO", "RN"): "2410306",       # Serra Caiada
    ("SANTO ANTONIO DO LEVERGER", "MT"): "5107800",  # Santo Antônio de Leverger
    ("SANTANA DO LIVRAMENTO", "RS"): "4317103",      # Sant'Ana do Livramento
    ("ITAPAGE", "CE"): "2306306",                    # Itapajé
    ("ELDORADO DOS CARAJAS", "PA"): "1502954",       # Eldorado do Carajás
    ("IGUARACI", "PE"): "2606903",                   # Iguaracy
    ("FORTALEZA DO TABOCAO", "TO"): "1708254",       # Tabocão
    ("GRACHO CARDOSO", "SE"): "2802601",             # Graccho Cardoso
    ("BARAO DE MONTE ALTO", "MG"): "3105509",        # Barão do Monte Alto
    ("SAO LUIS DO PARAITINGA", "SP"): "3550001",     # São Luiz do Paraitinga
    ("POXOREO", "MT"): "5107008",                    # Poxoréu
    ("MUQUEM DE SAO FRANCISCO", "BA"): "2922250",    # Muquém do São Francisco
    ("BRASOPOLIS", "MG"): "3108909",                 # Brazópolis
    ("DONA EUSEBIA", "MG"): "3122900",               # Dona Euzébia
    ("SAO THOME DAS LETRAS", "MG"): "3165206",       # São Tomé das Letras
    ("TRAJANO DE MORAIS", "RJ"): "3305901",          # Trajano de Moraes
    ("ARES", "RN"): "2401206",                       # Arez
    ("AMPARO DE SAO FRANCISCO", "SE"): "2800100",    # Amparo do São Francisco
    ("FLORINIA", "SP"): "3516101",                   # Florínea
    ("SANTA TERESINHA", "BA"): "2928505",            # Santa Terezinha (a única "Santa Te..." da BA)
}
# "Augusto Severo" (RN) e "Seridó" (PB) não estão no IBGE nem no TSE; a ligação
# pelo CNPJ os levou a Campo Grande (RN) e São Vicente do Seridó (PB) em
# 17/11/2026. Na mesma data, 31 pagamentos com cidade "Porto Alegre" (RS) tinham
# o CNPJ da prefeitura de Ponte Alta (SC), com autores de Santa Catarina: vale
# o CNPJ.
# Segunda fonte de nomes: a tabela oficial de códigos do TSE, que traz o nome
# usado pelo TSE (às vezes o antigo) ao lado do código do IBGE.
TSE_IBGE = "https://cdn.tse.jus.br/estatistica/sead/odsele/municipio_tse_ibge/municipio_tse_ibge.zip"


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
    codigos = set(mapa.values())
    z = zipfile.ZipFile(io.BytesIO(baixar(TSE_IBGE)))
    nome_csv = next((n for n in z.namelist() if n.lower().endswith(".csv")), None)
    if not nome_csv:
        falhar("tabela do TSE sem CSV")
    acrescentados = 0
    for l in csv.DictReader(io.StringIO(z.read(nome_csv).decode("latin-1")), delimiter=";"):
        cod, uf, nome = (l.get("CD_MUNICIPIO_IBGE") or "").strip(), (l.get("SG_UF") or "").strip(), l.get("NM_MUNICIPIO_TSE")
        if cod in codigos and (chave_nome(nome), uf) not in mapa:
            mapa[(chave_nome(nome), uf)] = cod
            acrescentados += 1
    print(f"nomes do TSE acrescentados: {acrescentados}")
    for chave, cod in NOMES_ANTIGOS.items():
        if cod not in codigos:
            falhar(f"código {cod} de {chave} não está na lista do IBGE")
        mapa.setdefault(chave, cod)
    return mapa


def cnpjs_das_prefeituras(codigos):
    """CNPJ (só dígitos) -> código do IBGE de cada prefeitura, pelo Tesouro."""
    d = json.loads(baixar(SICONFI_ENTES))
    mapa = {}
    for e in d.get("items", []):
        if e.get("esfera") != "M":
            continue
        cnpj = "".join(c for c in str(e.get("cnpj") or "") if c.isdigit())
        cod = str(e.get("cod_ibge") or "")
        if len(cnpj) == 14 and cod in codigos:
            mapa[cnpj] = cod
    if not 5500 <= len(mapa) <= 5580:
        falhar(f"lista de entes do Tesouro com {len(mapa)} prefeituras com CNPJ")
    print(f"prefeituras com CNPJ no Tesouro: {len(mapa)}")
    return mapa


MINUSCULAS = {"da", "das", "de", "do", "dos", "e"}


def nome_legivel(texto):
    """'COM. DA SAUDE' -> 'Comissão da Saude'; 'BANCADA DE MINAS GERAIS' ->
    'Bancada de Minas Gerais'. A grafia (acentos) fica como na fonte."""
    t = " ".join((texto or "").split())
    if not t or t.upper() in ("SEM INFORMAÇÃO", "SEM INFORMACAO", "S/I"):
        return "Sem informação"
    if t.upper().startswith("COM. "):
        t = "COMISSÃO " + t[5:]
    palavras = []
    for i, p in enumerate(t.split(" ")):
        b = p.lower()
        palavras.append(b if i and b in MINUSCULAS else "-".join(x[:1].upper() + x[1:] for x in b.split("-")))
    return " ".join(palavras)


ROTULO_CASA = {"camara": "Câmara", "senado": "Senado"}


def parlamentares_da_cota():
    """Nome (chave_nome) -> {nome, casa, partido, uf, ano}, pelo ano mais
    recente da cota em que o nome aparece. Nome nas duas casas no mesmo ano
    (quem passou da Câmara ao Senado): casa vazia."""
    achados = {}
    arquivos = sorted(f for f in os.listdir(COTA) if f[:4].isdigit() and f.endswith(".json"))
    for arq in arquivos:
        with open(os.path.join(COTA, arq), encoding="utf-8") as fh:
            d = json.load(fh)
        vistos = collections.defaultdict(list)
        for casa in ROTULO_CASA:
            for p in (d.get(casa) or {}).get("parlamentares", []):
                k = chave_nome(p.get("nome"))
                uf = (p.get("uf") or "").strip()
                if k and len(uf) == 2:
                    vistos[k].append({"nome": " ".join(str(p["nome"]).split()), "casa": casa,
                                      "partido": (p.get("partido") or "").strip(), "uf": uf, "ano": int(arq[:4])})
        for k, v in vistos.items():
            casas = {x["casa"] for x in v}
            achados[k] = v[-1] if len(casas) == 1 else {**v[-1], "casa": ""}
    if len(achados) < 500:
        falhar(f"listas da cota com só {len(achados)} parlamentares")
    return achados


def rotulo_da_cota(p):
    if not p.get("casa"):
        return "Câmara ou Senado"
    return f"{ROTULO_CASA[p['casa']]} · {p['partido']}-{p['uf']}" if p["partido"] else f"{ROTULO_CASA[p['casa']]} · {p['uf']}"


PREFIXOS = ("DEP ", "DEPUTADO ", "DEPUTADA ", "SEN ", "SENADOR ", "SENADORA ")


def chave_do_parlamentar(bruto):
    """Chave de um autor que é deputado ou senador; None para bancada,
    comissão, relator e autor sem informação."""
    k = chave_nome(bruto)
    if not k or k in ("SEM INFORMACAO", "S/I") or k.startswith(("BANCADA ", "COM ", "COMISSAO ", "RELATOR")):
        return None
    for pre in PREFIXOS:
        if k.startswith(pre):
            return k[len(pre):]
    return k


def cargo_do_autor(bruto, cota):
    k = chave_nome(bruto)
    if not k or k in ("SEM INFORMACAO", "S/I"):
        return ""
    if k.startswith("BANCADA "):
        return "Bancada do estado"
    if k.startswith("COM ") or k.startswith("COMISSAO "):
        return "Comissão do Congresso"
    if k.startswith("RELATOR"):
        return "Relator do orçamento"
    p = cota.get(chave_do_parlamentar(bruto))
    return rotulo_da_cota(p) if p else "Câmara ou Senado"


# Para quem a emenda foi paga, na página de cada parlamentar.
TIPOS_RECEBEDOR = ["prefeituras", "estados", "entidades", "banco", "outros"]
ENTIDADES = {"Associação Privada", "Fundação Privada", "Organização Religiosa", "Organização Social (OS)",
             "Serviço Social Autônomo", "Entidade Sindical"}


def tipo_do_recebedor(natureza, cnpj):
    if cnpj == CNPJ_BANCO_DO_BRASIL:
        return 3
    if natureza == "Município" or "Municipal" in natureza:
        return 0
    if "Estadual" in natureza or natureza == "Estado ou Distrito Federal":
        return 1
    if natureza in ENTIDADES:
        return 2
    return 4


def slug(nome, uf=""):
    """O mesmo endereço de site/js/endereco.js: sem acento, minúsculas."""
    t = unicodedata.normalize("NFD", nome or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    t = "".join(c if c.isascii() and c.isalnum() else "-" for c in t)
    t = "-".join(x for x in t.split("-") if x)
    return f"{t}-{uf.lower()}" if uf else t


def gravar_json(caminho, dados):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(temporario, caminho)


def main():
    mapa = municipios_ibge()
    por_cnpj = cnpjs_das_prefeituras(set(mapa.values()))
    cota = parlamentares_da_cota()
    z = zipfile.ZipFile(io.BytesIO(baixar(URL)))
    if ARQUIVO not in z.namelist():
        falhar(f"{ARQUIVO} não está no zip: {z.namelist()}")
    leitor = csv.DictReader(io.StringIO(z.read(ARQUIVO).decode("latin-1")), delimiter=";")
    faltam = [c for c in COLUNAS if c not in (leitor.fieldnames or [])]
    if faltam:
        falhar(f"colunas ausentes: {faltam}")
    ano_atual = dt.date.today().year
    # Primeiro guarda só as linhas que interessam; o nome do município que o
    # arquivo usa nos pagamentos à prefeitura (ligados pelo CNPJ) também
    # serve para os fundos municipais da mesma cidade.
    linhas = 0
    uteis = []
    pelo_banco = collections.defaultdict(float)
    tipos_autor = collections.defaultdict(lambda: [0.0] * len(TIPOS_RECEBEDOR))
    nome_do_autor = {}
    for n, l in enumerate(leitor, start=2):
        linhas += 1
        am = (l["Ano/Mês"] or "").strip()
        if len(am) != 6 or not am.isdigit() or not 2010 <= int(am[:4]) <= ano_atual or not 1 <= int(am[4:]) <= 12:
            falhar(f"linha {n}: ano/mês {am!r}")
        cnpj = "".join(c for c in l.get("Código do Favorecido") or "" if c.isdigit())
        if int(am[:4]) >= PRIMEIRO_ANO and cnpj == CNPJ_BANCO_DO_BRASIL:
            pelo_banco[int(am[:4])] += numero(l["Valor Recebido"], f"linha {n}")
        if int(am[:4]) >= ano_atual - 3:
            kp = chave_do_parlamentar(l["Nome do Autor da Emenda"])
            if kp:
                tipos_autor[(kp, int(am[:4]))][tipo_do_recebedor((l["Natureza Jurídica"] or "").strip(), cnpj)] += numero(l["Valor Recebido"], f"linha {n}")
                nome_do_autor.setdefault(kp, l["Nome do Autor da Emenda"])
        if int(am[:4]) >= PRIMEIRO_ANO and (l["Natureza Jurídica"] or "").strip() in NATUREZAS:
            uteis.append((n, l))
    if not 500000 <= linhas <= 3000000:
        falhar(f"{linhas} linhas no arquivo; esperado perto de 835 mil")
    aprendidos = collections.defaultdict(set)
    divergentes = collections.Counter()
    for _, l in uteis:
        if l["Natureza Jurídica"].strip() != "Município":
            continue
        cod = por_cnpj.get("".join(c for c in l["Código do Favorecido"] or "" if c.isdigit()))
        if not cod:
            continue
        chave = (chave_nome(l["Município Favorecido"]), (l["UF Favorecido"] or "").strip())
        aprendidos[chave].add(cod)
        if chave in mapa and mapa[chave] != cod:
            divergentes[(chave, mapa[chave], cod)] += 1
    if divergentes:
        print("nome e CNPJ apontam cidades diferentes (vale o CNPJ):", divergentes.most_common(10))
    novos = {k: next(iter(v)) for k, v in aprendidos.items() if len(v) == 1 and k not in mapa}
    print(f"nomes ligados pelo CNPJ que não estavam nas listas: {sorted(novos.items())}")
    autores_por_codigo = collections.defaultdict(set)
    bruto_do_autor = {}
    pago = collections.defaultdict(float)
    emendas = collections.defaultdict(set)
    autores = collections.defaultdict(lambda: collections.defaultdict(float))
    total_ano = collections.defaultdict(float)
    sem_cidade = collections.defaultdict(float)
    pelo_cnpj = 0.0
    for n, l in uteis:
        ano = int(l["Ano/Mês"].strip()[:4])
        valor = numero(l["Valor Recebido"], f"linha {n}")
        uf = (l["UF Favorecido"] or "").strip()
        chave_mun = (chave_nome(l["Município Favorecido"]), uf)
        cod = None
        if l["Natureza Jurídica"].strip() == "Município":
            cod = por_cnpj.get("".join(c for c in l["Código do Favorecido"] or "" if c.isdigit()))
            if cod:
                pelo_cnpj += valor
        cod = cod or mapa.get(chave_mun) or novos.get(chave_mun)
        total_ano[ano] += valor
        if not cod:
            sem_cidade[(l["Município Favorecido"], uf)] += valor
            continue
        chave = (cod, ano)
        pago[chave] += valor
        autor = nome_legivel(l["Nome do Autor da Emenda"]) or "Sem informação"
        bruto_do_autor.setdefault(autor, l["Nome do Autor da Emenda"])
        # Emenda sem código ("Sem informação", como as de relator antigas)
        # conta como uma por autor; com código, cada código é uma emenda.
        emendas[chave].add((l["Código da Emenda"], autor))
        autores[chave][autor] += valor
        autores_por_codigo[l["Código da Emenda"]].add(autor)
    total = sum(total_ano.values())
    fora = sum(sem_cidade.values())
    print(f"pago a prefeituras e fundos municipais desde {PRIMEIRO_ANO}: R$ {total / 1e9:.2f} bi; sem cidade: R$ {fora / 1e6:.1f} mi")
    print(f"ligado pelo CNPJ da prefeitura: R$ {pelo_cnpj / 1e9:.2f} bi")
    print("pago ao Banco do Brasil, sem dizer quem recebeu (fica fora):",
          {a: f"R$ {v / 1e9:.2f} bi" for a, v in sorted(pelo_banco.items())})
    varios = {c: sorted(a) for c, a in autores_por_codigo.items() if len(a) > 1}
    print(f"códigos de emenda com mais de um autor: {len(varios)} de {len(autores_por_codigo)}; exemplos: {list(varios.items())[:12]}")
    for ano in sorted(total_ano):
        print(f"  {ano}: R$ {total_ano[ano] / 1e9:.2f} bi")
    if sem_cidade:
        print("sem cidade (maiores):", sorted(sem_cidade.items(), key=lambda x: -x[1])[:15])
    if total <= 0 or fora > MAXIMO_SEM_CIDADE * total:
        falhar(f"R$ {fora:,.2f} sem cidade, mais de {MAXIMO_SEM_CIDADE:.1%} do total")
    # No site, os últimos quatro anos (o ano das contas e o atual cabem).
    anos = list(range(ano_atual - 3, ano_atual + 1))
    por_uf = collections.defaultdict(dict)
    nomes_uf = collections.defaultdict(dict)  # uf -> {nome: índice}
    uf_do_codigo = {cod: uf for (_, uf), cod in mapa.items()}
    for (cod, ano), v in sorted(pago.items()):
        if ano not in anos:
            continue
        uf = uf_do_codigo[cod]
        indice = nomes_uf[uf]
        # Todos os autores, do que mais mandou ao que menos mandou; valor
        # zero ou negativo (estorno) fica de fora da lista, não da soma.
        lista = [[indice.setdefault(a, len(indice)), round(x)]
                 for a, x in sorted(autores[(cod, ano)].items(), key=lambda x: (-x[1], x[0])) if round(x) > 0]
        por_uf[uf].setdefault(cod, {})[str(ano)] = [round(v), len(emendas[(cod, ano)]), lista]
    hoje = dt.date.today().isoformat()
    paginas = paginas_dos_parlamentares(cota, tipos_autor, nome_do_autor, autores, bruto_do_autor, anos, hoje)
    # Um arquivo por UF todas as vezes, mesmo sem cidade (o Distrito Federal
    # não tem prefeitura: o dinheiro vai ao governo do DF, que fica de fora),
    # para nunca sobrar arquivo de uma execução antiga.
    for uf in sorted({u for (_, u) in mapa}):
        cidades = por_uf.get(uf, {})
        gravar_json(f"{DESTINO}/{uf}.json", {
            "uf": uf, "atualizado": hoje, "fonte": URL, "anos": anos,
            "campos": ["pago", "emendas", "autores"],
            "nomes": list(nomes_uf[uf]),
            "cargos": [cargo_do_autor(bruto_do_autor.get(n, n), cota) for n in nomes_uf[uf]],
            "paginas": [paginas.get(chave_do_parlamentar(bruto_do_autor.get(n, n)), "") for n in nomes_uf[uf]],
            "cidades": cidades,
        })
    print(f"gravados {len(por_uf)} estados, {sum(len(c) for c in por_uf.values())} cidades com emendas desde {PRIMEIRO_ANO}")
    rotulos = collections.Counter(cargo_do_autor(b, cota).split(" · ")[0] for b in bruto_do_autor.values())
    print("cargos dos autores:", rotulos.most_common())


PARLAMENTARES = "site/dados/parlamentares"


def paginas_dos_parlamentares(cota, tipos_autor, nome_do_autor, autores, bruto_do_autor, anos, hoje):
    """Grava o índice e um arquivo por deputado ou senador com as emendas de
    cada ano: o total por tipo de recebedor e as cidades (prefeitura e fundos
    municipais). Entram todos os da cota desses anos e todos os autores
    individuais de emenda. Devolve chave -> endereço (slug)."""
    cidades = collections.defaultdict(lambda: collections.defaultdict(dict))  # chave -> ano -> cod -> valor
    for (cod, ano), por_autor in autores.items():
        if ano not in anos:
            continue
        for autor, valor in por_autor.items():
            kp = chave_do_parlamentar(bruto_do_autor.get(autor, autor))
            if kp and round(valor) > 0:
                cidades[kp][ano][cod] = cidades[kp][ano].get(cod, 0) + valor
    # Lista oficial da Câmara e do Senado (scripts/congresso_para_json.py), com
    # o código de cada um; tem precedência sobre a cota para nome, partido e UF.
    oficiais = collections.defaultdict(list)
    caminho = f"{PARLAMENTARES}/oficiais.json"
    if os.path.exists(caminho):
        with open(caminho, encoding="utf-8") as fh:
            for casa, ident, nome, sexo, partido, uf in json.load(fh).get("parlamentares", []):
                oficiais[chave_nome(nome)].append({"nome": nome, "casa": casa, "partido": partido, "uf": uf,
                                                   "oficial": f"{casa}:{ident}", "sexo": sexo})
    print(f"lista oficial: {sum(len(v) for v in oficiais.values())} parlamentares")
    chaves = {k for k, p in cota.items() if p["ano"] >= min(anos)} | {k for (k, _) in tipos_autor} | set(oficiais)
    usados, enderecos, indice = set(), {}, []
    for k in sorted(chaves):
        candidatos = oficiais.get(k, [])
        if len(candidatos) > 1 and cota.get(k):
            candidatos = [c for c in candidatos if c["uf"] == cota[k]["uf"]] or candidatos
        p = candidatos[0] if candidatos else (
            cota.get(k) or {"nome": nome_legivel(nome_do_autor.get(k, k)), "casa": "", "partido": "", "uf": ""})
        base = slug(p["nome"], p["uf"])
        endereco, n = base, 2
        while endereco in usados:
            endereco, n = f"{base}-{n}", n + 1
        usados.add(endereco)
        enderecos[k] = endereco
        por_ano = {}
        for ano in anos:
            t = tipos_autor.get((k, ano))
            c = cidades[k].get(ano, {})
            if t is None and not c:
                continue
            t = t or [0.0] * len(TIPOS_RECEBEDOR)
            por_ano[str(ano)] = {
                "pago": round(sum(t)),
                "tipos": [round(x) for x in t],
                "cidades": [[cod, round(v)] for cod, v in sorted(c.items(), key=lambda x: (-x[1], x[0])) if round(v) > 0],
            }
        indice.append([endereco, p["nome"], p["casa"], p["partido"], p["uf"], sum(x["pago"] for x in por_ano.values()),
                       p.get("oficial", ""), p.get("sexo", "")])
        gravar_json(f"{PARLAMENTARES}/emendas/{endereco}.json", {
            "endereco": endereco, "nome": p["nome"], "casa": p["casa"], "partido": p["partido"], "uf": p["uf"],
            "atualizado": hoje, "fonte": URL, "tipos": TIPOS_RECEBEDOR, "anos": por_ano,
        })
    # Arquivo de quem saiu da lista não fica para trás.
    for arq in os.listdir(f"{PARLAMENTARES}/emendas"):
        if arq.endswith(".json") and arq[:-5] not in usados:
            os.remove(f"{PARLAMENTARES}/emendas/{arq}")
    indice.sort(key=lambda x: (chave_nome(x[1]), x[4]))
    gravar_json(f"{PARLAMENTARES}/indice.json", {
        "atualizado": hoje, "anos": anos, "campos": ["endereco", "nome", "casa", "partido", "uf", "emendas_pagas", "oficial", "sexo"],
        "parlamentares": indice,
    })
    print(f"parlamentares: {len(indice)} páginas; com emendas: {sum(1 for x in indice if x[5] > 0)}; "
          f"sem casa: {sum(1 for x in indice if not x[2])}; com código oficial: {sum(1 for x in indice if x[6])}")
    return enderecos


if __name__ == "__main__":
    main()
