#!/usr/bin/env python3
"""Em que cada Câmara Municipal cearense gastou, por ano e por tipo de despesa.

Fonte oficial: Tribunal de Contas do Estado do Ceará (TCE-CE), dados do SIM
(Sistema de Informações Municipais), API de Dados Abertos do SIM
(https://api-dados-abertos.tce.ce.gov.br/sim/, documentação em
openapi_prod.yaml):
  municipios                      código da cidade no tribunal (057) e no IBGE
  orgaos?codigo_municipio&exercicio_orcamento
                                  órgãos da prefeitura; a Câmara é o tipo de
                                  unidade "02"
  balancetes_despesas_orcamentarias?codigo_municipio&exercicio_orcamento
      &codigo_orgao&data_referencia_doc=AAAA12
                                  balancete da despesa do órgão, por ação e
                                  elemento, com o acumulado até dezembro
As respostas vêm em {"name", "elements"}, até 1.000 registros por página
($count e $start_index). A API antiga (api.tce.ce.gov.br), que o próprio
tribunal chama de obsoleta, deu os mesmos totais em Acarape e Fortaleza na
inspeção de 18/11/2026.

Conferido em 18/11/2026 (inspeção pelo GitHub): o código da Câmara costuma ser
"01", mas muda (15 em Paracuru, 19 em Quixeramobim); por isso o script lê os
órgãos de cada cidade e guarda o código achado ("orgaos"), conferindo nos
anos seguintes se o balancete daquele código é mesmo da função Legislativa.
O elemento vem com 8 dígitos e subelemento "00" (ex.: 31901100): o subsídio
dos vereadores fica junto com o salário dos servidores
(CATEGORIAS_SEM_SUBSIDIO).

Conta: pago até dezembro menos os estornos de pagamento, sem a modalidade 91
(intra-orçamentária: o que a Câmara paga ao próprio município, como a
previdência dos servidores), como em SP, no RS e em PE. Na Câmara de Acarape,
deu R$ 2.611.741,16 em 2024 e R$ 3.086.161,60 em 2025, o mesmo valor que a
prefeitura informou ao Tesouro (SICONFI, função Legislativa); em Fortaleza, a
diferença foi de 0,02% em 2024 e de 1,7% em 2025.

Só entram anos fechados: antes de consultar as 184 cidades, uma amostra
precisa ter o balancete de dezembro. O ano fechado mais recente é consultado
de novo todo mês até junho do ano seguinte; os anteriores são reaproveitados
do arquivo gravado. O robots.txt do tribunal não restringe nada; mesmo
assim, um pedido por vez, com intervalo. Sem nomes de pessoas na saída.

Saída: site/dados/camaras/CE.json, no formato de SP.json, mais "fora" e
"orgaos".
"""

import collections
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camaras_sp_para_json as comum  # noqa: E402

AGENTE = comum.AGENTE
BASE = "https://api-dados-abertos.tce.ce.gov.br/sim/"
FONTE = BASE
PAGINA = 1000
DESTINO = "site/dados/camaras/CE.json"
MUNICIPIOS = "site/dados/municipios/CE.json"
ANOS_GUARDADOS = 2
ANOS_PROCURADOS = 4
MES_FIM_REVISAO = 6
MINIMO_DE_CAMARAS = 165
FORTALEZA = "057"
TAMANHO_DA_AMOSTRA = 8
MINIMO_NA_AMOSTRA = 6
MAXIMO_FORA = 0.1
VERSAO_DA_CONTA = 1
INTERVALO = 1.0
TIPO_CAMARA = "02"
CATEGORIAS = comum.CATEGORIAS_SEM_SUBSIDIO
INDICE = comum.INDICE_SEM_SUBSIDIO

ultimo = [0.0]
pedidos = [0]


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def consultar(metodo, parametros=None, tempo=240):
    """Todos os registros de um método da API, página a página, com até 3
    tentativas por página. 404 (sem registro) vira lista vazia."""
    saida = []
    while True:
        params = dict(parametros or {}, **{"$format": "json", "$count": PAGINA, "$start_index": len(saida)})
        url = BASE + metodo + "?" + urllib.parse.urlencode(params)
        for tentativa in range(1, 4):
            espera = INTERVALO - (time.time() - ultimo[0])
            if espera > 0:
                time.sleep(espera)
            ultimo[0] = time.time()
            pedidos[0] += 1
            try:
                req = urllib.request.Request(url, headers={"User-Agent": AGENTE, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=tempo) as r:
                    d = json.loads(r.read().decode("utf-8", "replace"))
                break
            except urllib.error.HTTPError as erro:
                if erro.code == 404:
                    return saida
                if erro.code == 400:
                    falhar(f"a API do TCE-CE recusou a consulta {url}: {erro.read(300)!r}")
                print(f"  falha {tentativa} em {url}: HTTP {erro.code}", flush=True)
            except (urllib.error.URLError, OSError, TimeoutError, ValueError) as erro:
                print(f"  falha {tentativa} em {url}: {erro}", flush=True)
            if tentativa == 3:
                falhar(f"a API do TCE-CE não respondeu: {url}")
            time.sleep(30 * tentativa)
        regs = d.get("elements") if isinstance(d, dict) else None
        if not isinstance(regs, list):
            falhar(f"resposta fora do formato em {url}: {str(d)[:300]}")
        saida.extend(regs)
        if len(regs) < PAGINA:
            return saida


def numero(v):
    try:
        return float(str(v or 0).strip() or 0)
    except ValueError:
        falhar(f"valor inválido {v!r}")


def ler_cidades():
    """{código no tribunal: código IBGE}."""
    site = {str(x["c"]) for x in json.load(open(MUNICIPIOS, encoding="utf-8"))["municipios"]}
    cidades = {}
    for r in consultar("municipios"):
        cod = str(r.get("codigo_municipio_ibge") or "").strip()
        if not cod:
            continue  # "T.C.M.", o antigo Tribunal de Contas dos Municípios
        if cod not in site:
            falhar(f"cidade do tribunal sem código IBGE válido: {r}")
        cidades[str(r["codigo_municipio"]).strip()] = cod
    if len(cidades) < MINIMO_DE_CAMARAS:
        falhar(f"só {len(cidades)} cidades na lista do tribunal")
    print(f"  {len(cidades)} cidades ligadas ao IBGE", flush=True)
    return cidades


def orgao_da_camara(municipio, ano):
    camaras = [o for o in consultar("orgaos", {"codigo_municipio": municipio, "exercicio_orcamento": int(f"{ano}00")})
               if str(o.get("codigo_tipo_unidade")).strip() == TIPO_CAMARA]
    if len(camaras) > 1:
        print(f"  {municipio}/{ano}: mais de um órgão do tipo Câmara: {[o.get('nome_orgao') for o in camaras]}")
    return str(camaras[0]["codigo_orgao"]).strip() if camaras else None


def balancete(municipio, ano, orgao):
    return consultar("balancetes_despesas_orcamentarias", {
        "codigo_municipio": municipio, "exercicio_orcamento": int(f"{ano}00"),
        "codigo_orgao": orgao, "data_referencia_doc": int(f"{ano}12")})


def eh_legislativo(linhas):
    """Mais de 90% do pago do órgão na função Legislativa (01)."""
    pago = sum(numero(r.get("valor_pago_ate_mes")) for r in linhas)
    leg = sum(numero(r.get("valor_pago_ate_mes")) for r in linhas if str(r.get("codigo_funcao")).strip() == "01")
    return pago <= 0 or leg >= 0.9 * pago


def linhas_da_camara(municipio, ano, guardado):
    """(código do órgão, linhas do balancete de dezembro) da Câmara."""
    linhas = []
    if guardado:
        linhas = balancete(municipio, ano, guardado)
        if linhas and eh_legislativo(linhas):
            return guardado, linhas
    orgao = orgao_da_camara(municipio, ano)
    if not orgao:
        return None, []
    if orgao != guardado:
        linhas = balancete(municipio, ano, orgao)
    if linhas and not eh_legislativo(linhas):
        print(f"  {municipio}/{ano}: órgão {orgao} do tipo Câmara gasta fora da função Legislativa; conferir")
    return orgao, linhas


def coletar(ano, cidades, orgaos):
    """({código IBGE: [total, partes]}, {código IBGE: liquidado}) ou None se o ano não fechou."""
    com_dezembro = 0
    amostra = [m for m in ([FORTALEZA] + sorted(cidades)[::23]) if m in cidades][:TAMANHO_DA_AMOSTRA]
    for mun in amostra:
        org, linhas = linhas_da_camara(mun, ano, orgaos.get(cidades[mun]))
        com_dezembro += bool(linhas)
        if org:
            orgaos[cidades[mun]] = org
    if com_dezembro < MINIMO_NA_AMOSTRA:
        print(f"{ano}: só {com_dezembro} cidades da amostra com o balancete de dezembro; o ano ainda não fechou", flush=True)
        return None
    por_cidade, liquidado = {}, {}
    tabela = collections.defaultdict(float)
    sem, inicio, pago_intra = [], time.time(), 0.0
    for i, (mun, cod) in enumerate(sorted(cidades.items()), 1):
        org, linhas = linhas_da_camara(mun, ano, orgaos.get(cod))
        if org:
            orgaos[cod] = org
        if not linhas:
            sem.append(mun)
            continue
        item = [0.0, [0.0] * len(CATEGORIAS)]
        liq = 0.0
        for r in linhas:
            if str(r.get("exercicio_orcamento")).strip() != f"{ano}00" or str(r.get("data_referencia_doc")).strip() != f"{ano}12":
                falhar(f"linha de outro período no balancete de {mun}/{ano}: {r}")
            elem = str(r.get("codigo_elemento_despesa") or "").strip()
            pago = numero(r.get("valor_pago_ate_mes")) - numero(r.get("valor_estornos_pagos_ate_mes"))
            if elem[2:4] == "91":
                pago_intra += pago
                continue
            liq += numero(r.get("valor_liquidado_ate_mes")) - numero(r.get("valor_estornos_liquidacao_ate_mes"))
            cat = comum.categoria_sem_subsidio(comum.categoria(elem))
            tabela[(cat, elem[:6])] += pago
            item[0] += pago
            item[1][INDICE[cat]] += pago
        por_cidade[cod] = item
        liquidado[cod] = liq
        if i % 20 == 0:
            print(f"  {ano}: {i} de {len(cidades)} cidades em {(time.time() - inicio) / 60:.0f} min", flush=True)
    print(f"  {ano}: {len(por_cidade)} câmaras; sem balancete de dezembro: {len(sem)} {sem[:20]}; "
          f"intra-orçamentário deixado de fora R$ {pago_intra / 1e6:.1f} mi", flush=True)
    print(f"  {ano}: tipo de cada elemento (pago, R$ mi):")
    for (cat, elem), v in sorted(tabela.items(), key=lambda x: -x[1]):
        print(f"    {v / 1e6:9.2f}  {cat:9s} {elem}")
    return por_cidade, liquidado


def main():
    try:
        antigo = json.load(open(DESTINO, encoding="utf-8"))
    except OSError:
        antigo = {}
    agora = datetime.now(timezone.utc)
    cidades_tce = ler_cidades()
    orgaos = dict(antigo.get("orgaos") or {})
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
        print(f"{ano}: consultando as {len(cidades_tce)} cidades", flush=True)
        r = coletar(ano, cidades_tce, orgaos)
        if r is None:
            continue
        por_cidade, liquidado = r
        if len(por_cidade) < MINIMO_DE_CAMARAS:
            falhar(f"só {len(por_cidade)} câmaras com balancete em {ano}")
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
        "uf": "CE",
        "versao": VERSAO_DA_CONTA,
        "tribunal": "Tribunal de Contas do Estado do Ceará",
        "atualizado": agora.strftime("%Y-%m-%d"),
        "fonte": FONTE,
        "anos": anos,
        "categorias": [list(c) for c in CATEGORIAS],
        "cidades": {cod: dict(sorted(v.items())) for cod, v in sorted(cidades.items()) if any(str(a) in v for a in anos)},
        "fora": {cod: dict(sorted(v.items())) for cod, v in sorted(fora.items()) if any(str(a) in v for a in anos)},
        "orgaos": dict(sorted(orgaos.items())),
    })
    print(f"gravado {DESTINO}: {len(cidades)} câmaras, {len(fora)} fora; {pedidos[0]} pedidos")


if __name__ == "__main__":
    main()
