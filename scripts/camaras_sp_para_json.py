#!/usr/bin/env python3
"""Em que cada Câmara Municipal paulista gastou, por ano e por tipo de despesa.

Fonte oficial: Tribunal de Contas do Estado de São Paulo, Portal da
Transparência Municipal, "Conjunto de Dados", um arquivo por ano com todos os
lançamentos de despesa das prefeituras, câmaras e demais órgãos dos 644
municípios fiscalizados pelo TCE-SP (a capital fica de fora: é fiscalizada
pelo Tribunal de Contas do Município de São Paulo):
  https://transparencia.tce.sp.gov.br/conjunto-de-dados
  https://transparencia.tce.sp.gov.br/sites/default/files/conjunto-dados/despesas-AAAA.zip

Conferido em 17/11/2026 (inspeção pelo GitHub): o arquivo de 2025 tem 2,1 GB
compactados (um CSV, latin-1, ";", 25 colunas, com o código do IBGE da
cidade), e o servidor aceita baixar em partes. Uma tentativa de baixar tudo
de uma vez caiu depois de 22 minutos; por isso o download é feito em pedaços
de 100 MB, retomando de onde parou.

Cada lançamento é "Empenhado", "Valor Liquidado", "Valor Pago", "Anulação"
ou "Reforço". Entram só os de "Valor Pago": o dinheiro que de fato saiu no
ano. Fica de fora a modalidade 91 (intra-orçamentária), o que a Câmara paga
ao próprio município, como a contribuição ao fundo de aposentadoria dos
servidores municipais, como faz o relatório ao Tesouro. Entram só os órgãos que são a câmara da cidade (nome com "CÂMARA",
"LEGISLATIVO" ou "VEREADORES" e sem "PREFEITURA"; os nomes fora do padrão
"CÂMARA MUNICIPAL ..." aparecem no registro da execução para conferência). O tipo vem do elemento de despesa (ex.: "31901175 - SUBSÍDIOS -
AGENTES POLÍTICOS"), agrupado em poucas categorias para leigos (CATEGORIAS).
Não há nomes de pessoas na saída: só os totais de cada câmara.

Antes de baixar, o script pergunta ao servidor a data e o tamanho de cada
arquivo e só baixa de novo o que mudou desde a última vez (campo "arquivos").

Conferência: o total pago de cada câmara é comparado com a despesa da função
Legislativa que a prefeitura declarou ao Tesouro (SICONFI, RREO, já em
site/dados/municipios/SP.json). Se a mediana da razão fugir de 0,8 a 1,2, ou
se menos de 600 câmaras aparecerem num ano, o script falha sem gravar.

Saída:
  site/dados/camaras/SP.json  {"anos", "categorias": [[chave, rótulo]],
                               "cidades": {código IBGE: {ano: [total,
                               [valor por categoria]]}}}, valores em reais
"""

import collections
import csv
import io
import json
import os
import re
import statistics
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone

AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
PAGINA = "https://transparencia.tce.sp.gov.br/conjunto-de-dados"
ARQUIVO = "https://transparencia.tce.sp.gov.br/sites/default/files/conjunto-dados/despesas-{ano}.zip"
DESTINO = "site/dados/camaras/SP.json"
MUNICIPIOS = "site/dados/municipios/SP.json"
TEMPORARIO = os.environ.get("RUNNER_TEMP", "/tmp")
PEDACO = 100_000_000
ANOS_GUARDADOS = 2
# Muda quando a regra da conta muda, para refazer os anos já gravados.
VERSAO_DA_CONTA = 2
MINIMO_DE_CAMARAS = 600
COLUNAS = ["id_despesa_detalhe", "ano_exercicio", "ds_municipio", "codigo_municipio_ibge", "ds_orgao",
           "mes_referencia", "mes_ref_extenso", "tp_despesa", "nr_empenho", "tp_identificador_despesa",
           "nr_identificador_despesa", "ds_despesa", "dt_emissao_despesa", "vl_despesa", "ds_funcao_governo",
           "ds_subfuncao_governo", "cd_programa", "ds_programa", "cd_acao", "ds_acao", "ds_fonte_recurso",
           "ds_cd_aplicacao_fixo", "ds_modalidade_lic", "ds_elemento", "historico_despesa"]

# Categorias, na ordem em que aparecem no site.
CATEGORIAS = [
    ("vereadores", "Salário dos vereadores"),
    ("pessoal", "Servidores, 13º, férias e encargos"),
    ("diarias", "Diárias"),
    ("viagens", "Passagens e locomoção"),
    ("servicos", "Serviços contratados"),
    ("material", "Material de consumo"),
    ("obras", "Obras, equipamentos e imóveis"),
    ("outros", "Outros"),
]
INDICE = {k: i for i, (k, _) in enumerate(CATEGORIAS)}


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def sem_acento(texto):
    return "".join(c for c in unicodedata.normalize("NFD", texto or "") if not unicodedata.combining(c)).upper()


def categoria(elemento, subsidio=("75",)):
    """Elemento de despesa (8 dígitos: categoria, grupo, modalidade, elemento,
    subelemento) para a categoria do site. O subelemento do subsídio dos
    vereadores muda de um tribunal para outro: 75 no TCE-SP, 74 no TCE-RS."""
    cod = (elemento or "").strip()[:8]
    if len(cod) < 6 or not cod[:6].isdigit():
        return "outros"
    grupo, elem, sub = cod[1], cod[4:6], cod[6:8]
    if grupo == "1":
        return "vereadores" if elem == "11" and sub in subsidio else "pessoal"
    if grupo == "3":
        if elem == "14" or (elem == "36" and sub == "02"):
            return "diarias"
        if elem == "33":
            return "viagens"
        if elem in ("30", "31", "32"):
            return "material"
        if elem in ("34", "35", "36", "37", "39", "40"):
            return "servicos"
        return "outros"
    if grupo in ("4", "5"):
        return "obras"
    return "outros"


def pedir(url, metodo="GET", cabecalhos=None, tempo=120):
    req = urllib.request.Request(url, method=metodo, headers={"User-Agent": AGENTE, **(cabecalhos or {})})
    return urllib.request.urlopen(req, timeout=tempo)


def anos_disponiveis():
    for k in range(4):
        try:
            with pedir(PAGINA) as r:
                html = r.read().decode("utf-8", "replace")
            anos = sorted({int(a) for a in re.findall(r"conjunto-dados/despesas-(\d{4})\.zip", html)})
            if anos:
                return anos
            falhar("a página do conjunto de dados não lista arquivos de despesas")
        except (urllib.error.URLError, OSError) as erro:
            print(f"  página do conjunto de dados, tentativa {k + 1}: {erro}", flush=True)
            time.sleep(30 * (k + 1))
    falhar("não consegui abrir a página do conjunto de dados do TCE-SP")
    return []


def cabecalho(url):
    for k in range(4):
        try:
            with pedir(url, metodo="HEAD") as r:
                return int(r.headers["Content-Length"]), r.headers.get("Last-Modified", ""), r.headers.get("Accept-Ranges", "")
        except (urllib.error.URLError, OSError, KeyError, ValueError) as erro:
            print(f"  cabeçalho, tentativa {k + 1}: {erro}", flush=True)
            time.sleep(30 * (k + 1))
    falhar(f"não consegui ler o tamanho de {url}")
    return 0, "", ""


def baixar_em_partes(url, destino, tamanho):
    """Baixa em pedaços de PEDACO bytes, retomando do tamanho já gravado."""
    inicio = time.time()
    falhas = 0
    feito = os.path.getsize(destino) if os.path.exists(destino) else 0
    while feito < tamanho:
        fim = min(feito + PEDACO, tamanho) - 1
        try:
            with pedir(url, cabecalhos={"Range": f"bytes={feito}-{fim}"}, tempo=180) as r:
                if r.status != 206:
                    falhar(f"o servidor não entregou a parte pedida (HTTP {r.status})")
                with open(destino, "ab") as fh:
                    while True:
                        bloco = r.read(1 << 20)
                        if not bloco:
                            break
                        fh.write(bloco)
            feito = os.path.getsize(destino)
            print(f"  {feito / 1e6:.0f} de {tamanho / 1e6:.0f} MB ({(time.time() - inicio) / 60:.0f} min)", flush=True)
        except (urllib.error.URLError, OSError, TimeoutError) as erro:
            falhas += 1
            feito = os.path.getsize(destino) if os.path.exists(destino) else 0
            print(f"  falha {falhas} em {feito / 1e6:.0f} MB: {erro}", flush=True)
            if falhas > 25:
                falhar(f"o download de {url} falhou demais")
            time.sleep(min(120, 10 * falhas))
    if os.path.getsize(destino) != tamanho:
        falhar(f"arquivo com tamanho errado: {os.path.getsize(destino)} em vez de {tamanho}")


def numero(texto):
    t = (texto or "").strip()
    if not t:
        return 0.0
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    return float(t)


def somar(caminho, ano):
    """{código IBGE: [total, [por categoria]]} das câmaras, só "Valor Pago"."""
    z = zipfile.ZipFile(caminho)
    nomes = [i for i in z.infolist() if i.filename.lower().endswith(".csv")]
    if len(nomes) != 1:
        falhar(f"esperava um CSV dentro do zip de {ano}, achei {[i.filename for i in z.infolist()]}")
    por_cidade = {}
    orgaos = collections.Counter()
    tipos = collections.Counter()
    sem_codigo = 0
    intra = 0.0
    linhas = 0
    inicio = time.time()
    with z.open(nomes[0]) as bruto:
        leitor = csv.reader(io.TextIOWrapper(bruto, encoding="latin-1", newline=""), delimiter=";")
        cab = next(leitor)
        if cab != COLUNAS:
            falhar(f"colunas mudaram no arquivo de {ano}: {cab}")
        i_cod, i_org, i_tipo, i_val, i_ano, i_elem = (COLUNAS.index(c) for c in (
            "codigo_municipio_ibge", "ds_orgao", "tp_despesa", "vl_despesa", "ano_exercicio", "ds_elemento"))
        for l in leitor:
            linhas += 1
            if len(l) != len(COLUNAS):
                falhar(f"linha {linhas} do arquivo de {ano} com {len(l)} colunas")
            tipos[l[i_tipo]] += 1
            if l[i_tipo] != "Valor Pago":
                continue
            orgao = sem_acento(l[i_org])
            if not ("CAMARA" in orgao or "LEGISLATIV" in orgao or "VEREADOR" in orgao) or "PREFEITURA" in orgao:
                continue
            if l[i_ano].strip() != str(ano):
                falhar(f"lançamento de {l[i_ano]} no arquivo de {ano}")
            cod = l[i_cod].strip()
            if not re.fullmatch(r"35\d{5}", cod):
                sem_codigo += 1
                continue
            orgaos[(cod, l[i_org].strip())] += 1
            try:
                valor = numero(l[i_val])
            except ValueError:
                falhar(f"valor inválido {l[i_val]!r} na linha {linhas} do arquivo de {ano}")
            # Modalidade 91 (intra-orçamentária): o que a Câmara paga ao próprio
            # município, como a contribuição ao fundo de aposentadoria dos
            # servidores. Fica fora, como no relatório ao Tesouro.
            if l[i_elem].strip()[2:4] == "91":
                intra += valor
                continue
            item = por_cidade.setdefault(cod, [0.0, [0.0] * len(CATEGORIAS)])
            item[0] += valor
            item[1][INDICE[categoria(l[i_elem])]] += valor
    print(f"  {ano}: {linhas} linhas lidas em {(time.time() - inicio) / 60:.1f} min; tipos: {dict(tipos)}")
    print(f"  {ano}: pagamentos intra-orçamentários deixados de fora: R$ {intra / 1e6:.1f} milhões")
    if sem_codigo:
        print(f"  {ano}: {sem_codigo} pagamentos de câmara sem código IBGE válido (ficaram fora)")
    fora_do_padrao = sorted({n for _, n in orgaos if not sem_acento(n).startswith("CAMARA MUNICIPAL")})
    print(f"  {ano}: órgãos aceitos como câmara fora do padrão \"CÂMARA MUNICIPAL ...\" ({len(fora_do_padrao)}): {fora_do_padrao[:40]}")
    por_codigo = collections.defaultdict(set)
    for cod, nome in orgaos:
        por_codigo[cod].add(nome)
    duplas = {c: sorted(n) for c, n in por_codigo.items() if len(n) > 1}
    if duplas:
        print(f"  {ano}: cidades com mais de um órgão de câmara (somados): {list(duplas.items())[:10]}")
    print(f"  {ano}: exemplos de órgãos: {sorted({n for _, n in orgaos})[:8]}")
    return por_cidade


def conferir_com_siconfi(cidades, anos, municipios=MUNICIPIOS, minimo=300):
    """Mediana da razão entre o pago (Tribunal de Contas) e a função Legislativa (SICONFI)."""
    try:
        m = json.load(open(municipios, encoding="utf-8"))
    except OSError:
        print(f"  sem {municipios} para conferir")
        return
    i_cam = m["campos_despesa"].index("camara")
    for ano in anos:
        razoes = []
        for r in m["municipios"]:
            a = r["a"].get(str(ano)) or {}
            sic = a.get("d")[i_cam] if a.get("ds") == "ok" and a.get("d") else None
            tce = cidades.get(str(r["c"]), {}).get(str(ano))
            if sic and sic > 0 and tce and tce[0] > 0:
                razoes.append(tce[0] / sic)
        if len(razoes) < minimo:
            print(f"  {ano}: só {len(razoes)} cidades com as duas fontes; conferência pulada")
            continue
        med = statistics.median(razoes)
        perto = sum(1 for x in razoes if 0.8 <= x <= 1.25) / len(razoes)
        print(f"  {ano}: Tribunal de Contas (pago) / SICONFI (liquidado, função Legislativa): mediana {med:.3f}; "
              f"{perto:.0%} das {len(razoes)} cidades entre 0,8 e 1,25")
        if not 0.8 <= med <= 1.2:
            falhar(f"em {ano}, o total das câmaras no Tribunal de Contas não bate com o SICONFI (mediana {med:.3f})")


def gravar_json(caminho, dados):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(temporario, caminho)


def main():
    try:
        antigo = json.load(open(DESTINO, encoding="utf-8"))
    except OSError:
        antigo = {}
    anos = anos_disponiveis()[-ANOS_GUARDADOS:]
    print(f"anos no TCE-SP (os {ANOS_GUARDADOS} mais recentes): {anos}", flush=True)
    arquivos = {}
    cidades = collections.defaultdict(dict)
    mudou = False
    for ano in anos:
        url = ARQUIVO.format(ano=ano)
        tamanho, modificado, faixas = cabecalho(url)
        visto = (antigo.get("arquivos") or {}).get(str(ano))
        arquivos[str(ano)] = {"tamanho": tamanho, "modificado": modificado}
        if visto == arquivos[str(ano)] and ano in (antigo.get("anos") or []) and antigo.get("versao") == VERSAO_DA_CONTA:
            print(f"{ano}: sem mudança desde a última vez ({modificado}, {tamanho / 1e6:.0f} MB)", flush=True)
            for cod, por_ano in (antigo.get("cidades") or {}).items():
                if str(ano) in por_ano:
                    cidades[cod][str(ano)] = por_ano[str(ano)]
            continue
        mudou = True
        if faixas.lower() != "bytes":
            print(f"  aviso: o servidor não anuncia download em partes (Accept-Ranges: {faixas!r})")
        print(f"{ano}: baixando {tamanho / 1e6:.0f} MB ({modificado})", flush=True)
        caminho = os.path.join(TEMPORARIO, f"despesas-{ano}.zip")
        baixar_em_partes(url, caminho, tamanho)
        for cod, (total, partes) in somar(caminho, ano).items():
            cidades[cod][str(ano)] = [round(total), [round(x) for x in partes]]
        os.remove(caminho)
    if not mudou:
        print("Nenhum arquivo mudou; nada a gravar.")
        return
    for ano in anos:
        n = sum(1 for por_ano in cidades.values() if str(ano) in por_ano)
        print(f"  {ano}: {n} câmaras com pagamentos", flush=True)
        if n < MINIMO_DE_CAMARAS:
            falhar(f"só {n} câmaras em {ano}; esperava pelo menos {MINIMO_DE_CAMARAS}")
    conferir_com_siconfi(cidades, anos)
    for ano in anos:
        tot = [0.0] * len(CATEGORIAS)
        for por_ano in cidades.values():
            for i, v in enumerate(por_ano.get(str(ano), [0, [0] * len(CATEGORIAS)])[1]):
                tot[i] += v
        soma = sum(tot) or 1
        print(f"  {ano}, todas as câmaras: " + "; ".join(f"{r} {v / 1e9:.2f} bi ({v / soma:.0%})"
                                                         for (_, r), v in zip(CATEGORIAS, tot)))
    gravar_json(DESTINO, {
        "uf": "SP",
        "versao": VERSAO_DA_CONTA,
        "tribunal": "Tribunal de Contas do Estado de São Paulo",
        "atualizado": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "fonte": PAGINA,
        "arquivos": arquivos,
        "anos": anos,
        "categorias": [list(c) for c in CATEGORIAS],
        "cidades": {cod: dict(sorted(v.items())) for cod, v in sorted(cidades.items())},
    })
    print(f"gravado {DESTINO}: {len(cidades)} câmaras")


if __name__ == "__main__":
    main()
