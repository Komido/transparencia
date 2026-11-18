#!/usr/bin/env python3
"""Em que cada Câmara Municipal pernambucana gastou, por ano e por tipo de despesa.

Fonte oficial: Tribunal de Contas do Estado de Pernambuco (TCE-PE), API de
Dados Abertos (https://sistemas.tce.pe.gov.br/DadosAbertos/Exemplo!listar):
  UnidadesJurisdicionadas!json        órgãos fiscalizados; as câmaras têm
                                      NATUREZA "Câmara Municipal"
  Municipios!json?UNIDADEFEDERATIVA=PE código da cidade no tribunal (P001)
                                      e no IBGE (2600054)
  DespesasMunicipais!json?FUNCAO=Legislativa&ANOREFERENCIA=AAAA&MESREFERENCIA=M
                                      todos os empenhos da função Legislativa
                                      do estado emitidos no mês, cada um com o
                                      valor empenhado, liquidado e pago

Conferido em 18/11/2026 (inspeção pelo GitHub): a lista tem as 184 câmaras,
todas ativas, uma por cidade (Fernando de Noronha não tem câmara). A consulta
de um mês do estado inteiro traz uns 5 mil empenhos em cerca de 1 minuto; a
API devolve no máximo 100 mil linhas por consulta e informa quantas achou
(o script falha se uma consulta bater no limite). Consultar câmara por câmara
levava até 5 minutos cada. Na Câmara de Abreu e Lima, o pago somou
R$ 12.056.531,78 em 2024 e R$ 11.768.520,31 em 2025, o mesmo valor que a
prefeitura informou ao Tesouro (SICONFI, função Legislativa).

Conta: soma do valor pago de cada empenho das câmaras, menos a modalidade 91
(intra-orçamentária: o que a Câmara paga ao próprio município, como a
previdência dos servidores), como em SP e no RS. O tribunal manda o elemento
de despesa por extenso ("Vencimentos e Vantagens Fixas - Pessoal Civil") e o
grupo ("Pessoal e Encargos Sociais"), sem código; o tipo para o site sai do
grupo e do nome do elemento (classificar). O subsídio dos vereadores vem no
mesmo elemento do salário dos servidores, quase sempre "SEM SUBELEMENTO", por
isso os dois ficam juntos (CATEGORIAS_SEM_SUBSIDIO).

A Câmara do Recife veio com o valor pago zerado em todos os empenhos de 2025
(liquidado de R$ 96 milhões, contra R$ 237 milhões no Tesouro). Câmaras assim
saem da conta e vão para "fora", com o motivo, para a página explicar.

Só entram anos fechados: o de dezembro precisa trazer empenhos de pelo menos
MINIMO_EM_DEZEMBRO câmaras. O ano fechado mais recente é consultado de novo
todo mês até junho do ano seguinte (o prazo em que as prefeituras ainda
corrigem os dados); os anteriores são reaproveitados do arquivo gravado.
Sem nomes de pessoas na saída: só os totais de cada câmara.

Saída: site/dados/camaras/PE.json, no formato de SP.json, mais "fora".
"""

import collections
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camaras_sp_para_json as comum  # noqa: E402

AGENTE = comum.AGENTE
BASE = "https://sistemas.tce.pe.gov.br/DadosAbertos/"
FONTE = BASE + "Exemplo!listar"
DESTINO = "site/dados/camaras/PE.json"
MUNICIPIOS = "site/dados/municipios/PE.json"
ANOS_GUARDADOS = 2
ANOS_PROCURADOS = 4
MES_FIM_REVISAO = 6
MINIMO_DE_CAMARAS = 170
MINIMO_EM_DEZEMBRO = 150
MAXIMO_FORA = 0.1
VERSAO_DA_CONTA = 1
INTERVALO = 2.0
CATEGORIAS = comum.CATEGORIAS_SEM_SUBSIDIO
INDICE = comum.INDICE_SEM_SUBSIDIO

ultimo = [0.0]
pedidos = [0]


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def consultar(entidade, parametros=None, tempo=600):
    """Lista de registros de uma entidade da API, com até 3 tentativas."""
    url = BASE + f"{entidade}!json" + ("?" + urllib.parse.urlencode(parametros) if parametros else "")
    for tentativa in range(1, 4):
        espera = INTERVALO - (time.time() - ultimo[0])
        if espera > 0:
            time.sleep(espera)
        ultimo[0] = time.time()
        pedidos[0] += 1
        inicio = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=tempo) as r:
                tipo = r.headers.get("Content-Type", "")
                m = re.search(r"charset=([\w-]+)", tipo, re.I)
                texto = r.read().decode(m.group(1) if m else "iso-8859-1", "replace")
            d = json.loads(texto)["resposta"]
        except (urllib.error.URLError, OSError, TimeoutError, ValueError, KeyError) as erro:
            print(f"  falha {tentativa} em {url}: {erro}", flush=True)
            if tentativa == 3:
                falhar(f"a API do TCE-PE não respondeu: {url}")
            time.sleep(30 * tentativa)
            continue
        if d.get("status") != "OK":
            falhar(f"a API do TCE-PE respondeu {d.get('status')!r} em {url}")
        achados, limite = int(d.get("tamanhoResultado") or 0), int(d.get("limiteResultado") or 0)
        if limite and achados >= limite:
            falhar(f"a consulta bateu no limite de {limite} linhas: {url}")
        regs = d.get("conteudo") or []
        if len(regs) != achados:
            falhar(f"a API disse {achados} linhas e mandou {len(regs)}: {url}")
        print(f"  {entidade} {parametros or ''}: {len(regs)} linhas em {time.time() - inicio:.0f} s", flush=True)
        return regs
    return []


def numero(v):
    try:
        return float(str(v or 0).strip() or 0)
    except ValueError:
        falhar(f"valor inválido {v!r}")


def classificar(grupo, elemento):
    """Tipo para o site a partir do grupo e do nome do elemento de despesa."""
    g, e = comum.sem_acento(grupo), comum.sem_acento(elemento).replace("?", "-")
    if g.startswith("PESSOAL"):
        return "salarios"
    if g.startswith("INVESTIMENTO") or g.startswith("INVERSO"):
        return "obras"
    if "DIARIAS" in e:
        return "diarias"
    if "PASSAGENS" in e:
        return "viagens"
    if "MATERIAL DE CONSUMO" in e or "DISTRIBUICAO GRATUITA" in e or "PREMIACO" in e:
        return "material"
    if ("SERVICOS DE TERCEIROS" in e or "CONSULTORIA" in e or "LOCACAO DE MAO" in e
            or "TERCEIRIZACAO" in e or "TECNOLOGIA DA INFORMACAO" in e):
        return "servicos"
    return "outros"


def intra(modalidade):
    """Modalidade 91: operação entre órgãos do mesmo município."""
    return "ENTRE ORG" in comum.sem_acento(modalidade)


def ler_camaras():
    """{unidade gestora: código IBGE} das câmaras de PE."""
    ibge = {r["CODIGO"]: str(r["CODIGOIBGE"]) for r in consultar("Municipios", {"UNIDADEFEDERATIVA": "PE"})}
    site = {str(x["c"]) for x in json.load(open(MUNICIPIOS, encoding="utf-8"))["municipios"]}
    camaras, sem = {}, []
    for r in consultar("UnidadesJurisdicionadas"):
        if (r.get("NATUREZA") or "").strip() != "Câmara Municipal" or r.get("UNIDADEFEDERATIVA") != "PE":
            continue
        cod = ibge.get(r.get("CODIGOMUNICIPIO"))
        if not cod or cod not in site:
            sem.append(r.get("ORGAO"))
            continue
        camaras[str(r["ID_UNIDADE_GESTORA"])] = cod
    if sem:
        falhar(f"câmaras sem cidade na lista do IBGE: {sem[:20]}")
    if len(camaras) < MINIMO_DE_CAMARAS:
        falhar(f"só {len(camaras)} câmaras na lista do tribunal")
    repetidas = [c for c, n in collections.Counter(camaras.values()).items() if n > 1]
    if repetidas:
        print(f"  cidades com mais de uma câmara (somadas): {repetidas}")
    print(f"  {len(camaras)} câmaras ligadas ao IBGE", flush=True)
    return camaras


def coletar(ano, camaras):
    """({código: [total, partes]}, {código: liquidado}) do ano, ou None se o ano não fechou."""
    meses = {}
    dezembro = consultar("DespesasMunicipais", {"FUNCAO": "Legislativa", "ANOREFERENCIA": ano, "MESREFERENCIA": 12})
    com_dezembro = {str(r.get("ID_UNIDADE_GESTORA")) for r in dezembro} & set(camaras)
    if len(com_dezembro) < MINIMO_EM_DEZEMBRO:
        print(f"{ano}: só {len(com_dezembro)} câmaras com empenhos em dezembro; o ano ainda não fechou", flush=True)
        return None
    meses[12] = dezembro
    for mes in range(1, 12):
        meses[mes] = consultar("DespesasMunicipais", {"FUNCAO": "Legislativa", "ANOREFERENCIA": ano, "MESREFERENCIA": mes})
    por_cidade, liquidado = {}, collections.defaultdict(float)
    tabela = collections.defaultdict(float)
    modalidades = collections.defaultdict(float)
    outras_unidades = collections.Counter()
    pago_intra = 0.0
    for mes, regs in sorted(meses.items()):
        for r in regs:
            ug = str(r.get("ID_UNIDADE_GESTORA"))
            if ug not in camaras:
                outras_unidades[r.get("NOMEUNIDADEGESTORA")] += 1
                continue
            if str(r.get("ANOREFERENCIA")) != str(ano):
                falhar(f"empenho de {r.get('ANOREFERENCIA')} na consulta de {ano}")
            cod = camaras[ug]
            pago = numero(r.get("VALORPAGO"))
            modalidades[r.get("MODALIDADE")] += pago
            if intra(r.get("MODALIDADE") or ""):
                pago_intra += pago
                continue
            liquidado[cod] += numero(r.get("VALORLIQUIDADO"))
            cat = classificar(r.get("NATUREZA") or "", r.get("ELEMENTODESPESA") or "")
            tabela[(cat, r.get("NATUREZA"), r.get("ELEMENTODESPESA"))] += pago
            item = por_cidade.setdefault(cod, [0.0, [0.0] * len(CATEGORIAS)])
            item[0] += pago
            item[1][INDICE[cat]] += pago
    print(f"  {ano}: {sum(len(v) for v in meses.values())} empenhos; {len(por_cidade)} câmaras; "
          f"intra-orçamentário deixado de fora R$ {pago_intra / 1e6:.1f} mi", flush=True)
    print(f"  {ano}: pago por modalidade: {[(k, round(v)) for k, v in sorted(modalidades.items(), key=lambda x: -x[1])]}")
    if outras_unidades:
        print(f"  {ano}: empenhos da função Legislativa de outros órgãos (fora da conta): {outras_unidades.most_common(10)}")
    print(f"  {ano}: tipo de cada elemento (pago, R$ mi):")
    for (cat, grupo, elem), v in sorted(tabela.items(), key=lambda x: -x[1]):
        print(f"    {v / 1e6:9.2f}  {cat:9s} {grupo} | {elem}")
    return por_cidade, liquidado


def main():
    try:
        antigo = json.load(open(DESTINO, encoding="utf-8"))
    except OSError:
        antigo = {}
    agora = datetime.now(timezone.utc)
    camaras = ler_camaras()
    cidades = collections.defaultdict(dict)
    fora = {}
    anos, mudou = [], False
    for ano in range(agora.year - 1, agora.year - 1 - ANOS_PROCURADOS, -1):
        if len(anos) == ANOS_GUARDADOS:
            break
        revisar = ano == agora.year - 1 and agora.month <= MES_FIM_REVISAO
        if ano in (antigo.get("anos") or []) and antigo.get("versao") == VERSAO_DA_CONTA and not revisar:
            print(f"{ano}: já gravado; reaproveitado", flush=True)
            for cod, por_ano in (antigo.get("cidades") or {}).items():
                if str(ano) in por_ano:
                    cidades[cod][str(ano)] = por_ano[str(ano)]
            for cod, por_ano in (antigo.get("fora") or {}).items():
                if str(ano) in por_ano:
                    fora.setdefault(cod, {})[str(ano)] = por_ano[str(ano)]
            anos.append(ano)
            continue
        print(f"{ano}: consultando os 12 meses", flush=True)
        r = coletar(ano, camaras)
        if r is None:
            continue
        por_cidade, liquidado = r
        if len(por_cidade) < MINIMO_DE_CAMARAS:
            falhar(f"só {len(por_cidade)} câmaras com pagamentos em {ano}")
        novas = {cod: {str(ano): [round(t), [round(x) for x in p]]} for cod, (t, p) in por_cidade.items()}
        liq = {cod: {str(ano): v} for cod, v in liquidado.items()}
        f = comum.separar_incompletas(novas, liq, [ano], MUNICIPIOS)
        if len(f) > MAXIMO_FORA * len(por_cidade):
            falhar(f"{len(f)} câmaras com pagamentos faltando em {ano}; esperava no máximo {MAXIMO_FORA:.0%}")
        for cod, v in novas.items():
            cidades[cod].update(v)
        for cod, v in f.items():
            fora.setdefault(cod, {}).update(v)
        anos.append(ano)
        mudou = True
    if not mudou:
        print("Nenhum ano novo ou em revisão; nada a gravar.")
        return
    anos.sort()
    if not anos:
        falhar("nenhum ano fechado no tribunal")
    comum.conferir_com_siconfi(cidades, anos, MUNICIPIOS, minimo=120)
    for ano in anos:
        tot = [0.0] * len(CATEGORIAS)
        for por_ano in cidades.values():
            for i, v in enumerate(por_ano.get(str(ano), [0, [0] * len(CATEGORIAS)])[1]):
                tot[i] += v
        soma = sum(tot) or 1
        print(f"  {ano}, todas as câmaras: " + "; ".join(f"{r} {v / 1e6:.0f} mi ({v / soma:.0%})"
                                                         for (_, r), v in zip(CATEGORIAS, tot)))
    comum.gravar_json(DESTINO, {
        "uf": "PE",
        "versao": VERSAO_DA_CONTA,
        "tribunal": "Tribunal de Contas do Estado de Pernambuco",
        "atualizado": agora.strftime("%Y-%m-%d"),
        "fonte": FONTE,
        "anos": anos,
        "categorias": [list(c) for c in CATEGORIAS],
        "cidades": {cod: dict(sorted(v.items())) for cod, v in sorted(cidades.items()) if any(str(a) in v for a in anos)},
        "fora": {cod: dict(sorted(v.items())) for cod, v in sorted(fora.items()) if any(str(a) in v for a in anos)},
    })
    print(f"gravado {DESTINO}: {len(cidades)} câmaras, {len(fora)} fora; {pedidos[0]} pedidos")


if __name__ == "__main__":
    main()
