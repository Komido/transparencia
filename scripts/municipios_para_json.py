#!/usr/bin/env python3
"""Resume as receitas de todas as prefeituras do país, ano a ano.

Fonte oficial: Tesouro Nacional, SICONFI, API de dados abertos.
  Lista de entes (código do IBGE, nome, UF, população):
    https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes
  Relatório Resumido da Execução Orçamentária, Anexo 3 (receita corrente
  líquida), 6º bimestre de cada ano, uma chamada por prefeitura:
    .../tt/rreo?an_exercicio=AAAA&nr_periodo=6&co_tipo_demonstrativo=RREO
       &no_anexo=RREO-Anexo%2003&co_esfera=M&id_ente=CODIGO_IBGE

Prefeituras com menos de 50 mil habitantes podem optar pelo regime
simplificado da Lei de Responsabilidade Fiscal (art. 63), e o Tesouro guarda o
relatório delas como "RREO Simplificado": pedir só "RREO" devolve vazio. Em
Minas Gerais, a maioria das prefeituras usa o simplificado (conferido em
16/11/2026 em Monte Carmelo, MG: extrato de entregas e Anexo 3 de 2025, com a
mesma coluna e as mesmas contas do RREO completo). Por isso o script pede os
dois tipos: primeiro o que a prefeitura usou da última vez (ou, sem
histórico, o simplificado para quem tem menos de 50 mil habitantes) e, se vier
vazio, o outro.

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

Despesas: Anexo 2 do mesmo relatório (despesa por função), coluna "DESPESAS
LIQUIDADAS ATÉ O BIMESTRE (d)" do 6º bimestre, que é o ano inteiro; só a
parte "exceto intra-orçamentárias", para não contar duas vezes o dinheiro que
a prefeitura passa para ela mesma (por exemplo, para o próprio fundo de
aposentadoria). As linhas das funções vêm todas com o mesmo cod_conta
(RREO2TotalDespesas) e são reconhecidas pelo nome da função (Portaria 42/1999
do antigo Ministério do Orçamento e Gestão). Conferido em 16/11/2026 em São
Paulo (RREO) e Monte Carmelo (RREO Simplificado), 2025: a soma das funções
bate com a linha "DESPESAS (EXCETO INTRA-ORÇAMENTÁRIAS) (I)". O Anexo 2 é
pedido com o mesmo tipo de relatório em que veio o Anexo 3.

Mínimos da Constituição: Anexo 14 do mesmo relatório ("Demonstrativo
Simplificado do RREO"), com o que a prefeitura declarou ter aplicado no ano
em educação (manutenção e desenvolvimento do ensino, mínimo de 25% da receita
de impostos e repasses constitucionais), no salário dos profissionais da
educação básica (mínimo de 70% do FUNDEB) e em saúde (mínimo de 15%), com o
valor apurado e o mínimo de cada um. Conferido em 18/11/2026 numa amostra de
18 cidades, 2024 e 2025: cerca de 80% trazem as linhas; a base implícita
(valor ÷ percentual) bate com impostos e repasses do Anexo 3 (educação, até
0,6%), com eles sem as parcelas extras de 1% do FPM (saúde, que a LC 141/2012
não conta; até 2% em 19 de 21) e com o FUNDEB recebido (até 2,6%). Para não
pedir 11 mil anexos todo mês, o Anexo 14 só é pedido de novo quando o Anexo 3
da prefeitura mudou (outro SHA-256), quando ainda não há dado bom ou nos
meses de RECOLETA_MINIMOS, em que todos são pedidos de novo. Situação ("ms"):
ok, sem_linhas (anexo sem essas linhas), sem_anexo e erro.

Situação das despesas ("ds"): ok, nao_fecha (soma das funções diferente do
total), formato (sem a coluna ou sem o total), sem_anexo (o Anexo 3 veio e o
2 não) e erro.

Situação de cada prefeitura em cada ano ("s"):
  ok             relatório entregue e as partes somam o total (tolerância de
                 R$ 1 ou 0,1%)
  nao_fecha      relatório entregue, mas a soma das partes não bate com o
                 total; os números aparecem com aviso
  sem_relatorio  a prefeitura não entregou ao Tesouro o relatório do ano
                 completo (resposta vazia nos dois tipos na data da coleta)
  formato        o relatório existe, mas sem a coluna dos 12 meses ou sem a
                 receita corrente; sem dado, para não mostrar número errado
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
  python3 scripts/municipios_para_json.py --uf SP --so-despesas
      busca só o Anexo 2 das prefeituras que já têm o Anexo 3 gravado
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
import re
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

COLUNA_DESPESA = "DESPESAS LIQUIDADAS ATÉ O BIMESTRE (d)"
ROTULO_DESPESA = "Exceto Intra"  # parte do rótulo "Total das Despesas Exceto Intra-Orçamentárias"
TOTAL_DESPESA = "DESPESAS (EXCETO INTRA-ORÇAMENTÁRIAS) (I)"
# As 28 funções de governo e a reserva de contingência (Portaria 42/1999).
FUNCOES = ["Legislativa", "Judiciária", "Essencial à Justiça", "Administração", "Defesa Nacional",
           "Segurança Pública", "Relações Exteriores", "Assistência Social", "Previdência Social", "Saúde",
           "Trabalho", "Educação", "Cultura", "Direitos da Cidadania", "Urbanismo", "Habitação", "Saneamento",
           "Gestão Ambiental", "Ciência e Tecnologia", "Agricultura", "Organização Agrária", "Indústria",
           "Comércio e Serviços", "Comunicações", "Energia", "Transporte", "Desporto e Lazer",
           "Encargos Especiais", "Reserva de Contingência"]
# Grupos que o site mostra, na ordem do vetor "d" do arquivo do site. O que
# não está em nenhum grupo vai para "outras".
GRUPOS_DESPESA = [
    ("saude", ["Saúde"]),
    ("educacao", ["Educação"]),
    ("urbanismo", ["Urbanismo"]),
    ("administracao", ["Administração"]),
    ("previdencia", ["Previdência Social"]),
    ("assistencia", ["Assistência Social"]),
    ("saneamento", ["Saneamento"]),
    ("transporte", ["Transporte"]),
    ("encargos", ["Encargos Especiais"]),
    ("camara", ["Legislativa"]),
    ("seguranca", ["Segurança Pública"]),
    ("cultura_esporte", ["Cultura", "Desporto e Lazer"]),
    ("habitacao", ["Habitação"]),
    ("outras", None),
]
CAMPOS_DESPESA = [g for g, _ in GRUPOS_DESPESA]

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
    """Valores do ano (coluna dos 12 meses) por campo e a situação. Só é
    chamada com resposta não vazia."""
    do_ano = [i for i in itens if i.get("coluna") == COLUNA_ANO]
    if not do_ano:
        return {"s": "formato", "motivo": f"sem a coluna {COLUNA_ANO}"}
    por_conta = {}
    for i in do_ano:
        conta = i.get("cod_conta")
        if conta in por_conta:
            return {"s": "nao_fecha", "motivo": f"conta repetida: {conta}"}
        valor = i.get("valor")
        por_conta[conta] = float(valor) if valor is not None else 0.0
    if CONTAS["receita"] not in por_conta:
        return {"s": "formato", "motivo": f"sem a conta {CONTAS['receita']}"}
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


TIPOS = {"completo": "RREO", "simplificado": "RREO Simplificado"}
LIMITE_SIMPLIFICADO = 50_000  # LRF, art. 63


def url_rreo(ano, cod, tipo="completo", anexo="RREO-Anexo 03"):
    q = urllib.parse.urlencode({"an_exercicio": ano, "nr_periodo": 6, "co_tipo_demonstrativo": TIPOS[tipo],
                                "no_anexo": anexo, "co_esfera": "M", "id_ente": cod},
                               quote_via=urllib.parse.quote)
    return f"{API}/rreo?{q}"


# Anexo 14: linhas reconhecidas pelo nome (a "conta"), colunas pelo título.
MINIMOS = (
    ("educacao", re.compile(r"Manuten[çc][ãa]o e Desenvolvimento do Ensino", re.I)),
    ("fundeb", re.compile(r"70\s*% do FUNDEB", re.I)),
    ("saude", re.compile(r"Servi[çc]os P[úu]blicos de Sa[úu]de", re.I)),
)
COLUNAS_MINIMO = (
    ("minimo", re.compile(r"M[íi]nimo a Aplicar", re.I)),
    ("aplicado", re.compile(r"% Aplicado", re.I)),
    ("valor", re.compile(r"^Valor Apurado", re.I)),
)
RECOLETA_MINIMOS = {3, 6, 9, 12}  # meses em que o Anexo 14 de todas é pedido de novo


def resumir_minimos(itens):
    """{"ms": situação, "min": {chave: [percentual aplicado, valor apurado,
    percentual mínimo]}} a partir das linhas do Anexo 14."""
    if not itens:
        return {"ms": "sem_anexo"}
    saida = {}
    for chave, padrao in MINIMOS:
        valores = {}
        for i in itens:
            if not padrao.search(i.get("conta") or "") or i.get("valor") is None:
                continue
            coluna = i.get("coluna") or ""
            nome = next((n for n, c in COLUNAS_MINIMO if c.search(coluna)), None)
            if nome and nome not in valores:
                valores[nome] = float(i["valor"])
        if "aplicado" in valores:
            saida[chave] = [round(valores["aplicado"], 2),
                            None if valores.get("valor") is None else round(valores["valor"], 2),
                            valores.get("minimo")]
    return {"ms": "ok", "min": saida} if saida else {"ms": "sem_linhas"}


def buscar_minimos(ano, cod, tipo):
    """Resumo do Anexo 14, ou {"ms": "erro"} se o pedido falhar."""
    resposta = pedir(url_rreo(ano, cod, tipo, "RREO-Anexo 14"))
    if resposta is None:
        return {"ms": "erro"}
    dados, sha = resposta
    resumo = resumir_minimos(dados.get("items") or [])
    resumo["msha256"] = sha
    return resumo


def manter_ou_buscar_minimos(resumo, antes_ano, ano, cod, recoletar):
    """Reaproveita o Anexo 14 anterior quando o Anexo 3 não mudou (mesmo
    SHA-256) e o pedido anterior deu certo; senão, e nos meses de recoleta,
    pede de novo."""
    mesmo = antes_ano.get("sha256") == resumo.get("sha256")
    if mesmo and not recoletar and antes_ano.get("ms") in ("ok", "sem_linhas", "sem_anexo"):
        for k in ("ms", "min", "msha256"):
            if k in antes_ano:
                resumo[k] = antes_ano[k]
        return
    resumo.update(buscar_minimos(ano, cod, resumo["tipo"]))


def resumir_despesas(itens):
    """Despesa liquidada do ano por função e a situação ("ds")."""
    if not itens:
        return {"ds": "sem_anexo"}
    linhas = [i for i in itens if i.get("coluna") == COLUNA_DESPESA and ROTULO_DESPESA in (i.get("rotulo") or "")]
    if not linhas:
        return {"ds": "formato", "dmotivo": f"sem a coluna {COLUNA_DESPESA}"}
    total = [i for i in linhas if (i.get("conta") or "").strip() == TOTAL_DESPESA]
    if len(total) != 1:
        return {"ds": "formato", "dmotivo": f"{len(total)} linhas de total"}
    por_funcao = {}
    for i in linhas:
        nome = (i.get("conta") or "").strip()
        if nome not in FUNCOES:
            continue
        if nome in por_funcao:
            return {"ds": "nao_fecha", "dmotivo": f"função repetida: {nome}"}
        valor = i.get("valor")
        por_funcao[nome] = float(valor) if valor is not None else 0.0
    valor_total = float(total[0].get("valor") or 0)
    soma = sum(por_funcao.values())
    saida = {"funcoes": {k: round(v, 2) for k, v in por_funcao.items() if v}, "dtotal": round(valor_total, 2)}
    if valor_total <= 0:
        saida.update(ds="nao_fecha", dmotivo="despesa total zerada")
    elif abs(soma - valor_total) > max(1.0, 0.001 * valor_total):
        saida.update(ds="nao_fecha", dmotivo=f"funções somam {soma:.2f}, total {valor_total:.2f}")
    else:
        saida["ds"] = "ok"
    return saida


def buscar_despesas(ano, cod, tipo):
    """Resumo das despesas, ou {"ds": "erro"} se o pedido falhar."""
    resposta = pedir(url_rreo(ano, cod, tipo, "RREO-Anexo 02"))
    if resposta is None:
        return {"ds": "erro"}
    dados, sha = resposta
    resumo = resumir_despesas(dados.get("items") or [])
    resumo["dsha256"] = sha
    return resumo


def grupos_de_despesa(funcoes):
    """Vetor do site: soma das funções de cada grupo; o resto em "outras"."""
    usados = set()
    saida = []
    for _, nomes in GRUPOS_DESPESA:
        if nomes is None:
            saida.append(sum(v for k, v in funcoes.items() if k not in usados))
        else:
            usados.update(nomes)
            saida.append(sum(funcoes.get(k, 0.0) for k in nomes))
    return saida


def ordem_dos_tipos(anterior, pop):
    """Tipo a pedir primeiro: o que a prefeitura usou da última vez; sem
    histórico, o simplificado para quem tem menos de 50 mil habitantes."""
    primeiro = anterior if anterior in TIPOS else (
        "simplificado" if 0 < pop < LIMITE_SIMPLIFICADO else "completo")
    return [primeiro] + [t for t in TIPOS if t != primeiro]


def buscar_relatorio(ano, cod, ordem):
    """Pede os tipos na ordem dada até achar um com itens. Devolve o resumo
    (com tipo e SHA-256 da resposta usada), {"s": "sem_relatorio"} se todos
    vierem vazios, ou None se algum pedido falhar sem que outro tenha itens."""
    falhou = False
    vazios = []
    for tipo in ordem:
        resposta = pedir(url_rreo(ano, cod, tipo))
        if resposta is None:
            falhou = True
            continue
        dados, sha = resposta
        itens = dados.get("items") or []
        if itens:
            resumo = resumir_relatorio(itens)
            resumo["tipo"] = tipo
            resumo["sha256"] = sha
            return resumo
        vazios.append(sha)
    if falhou:
        return None
    return {"s": "sem_relatorio", "sha256": vazios}


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


def buscar_uf(uf, anos, so_despesas=False, so_minimos=False):
    municipios = {c: m for c, m in lista_de_entes().items() if m["uf"] == uf}
    if not municipios:
        falhar(f"nenhum município na lista de entes para {uf}")
    caminho = f"{FONTE}/{uf}.json"
    anterior = ler_json(caminho, {"municipios": {}})
    saida = {"uf": uf, "atualizado": dt.date.today().isoformat(), "municipios": {}}
    erros = 0
    total = 0
    recoletar = so_minimos or dt.date.today().month in RECOLETA_MINIMOS
    for n, (cod, m) in enumerate(sorted(municipios.items()), start=1):
        antes = anterior["municipios"].get(str(cod), {})
        registro = {"nome": m["nome"], "pop": m["pop"], "anos": dict(antes.get("anos", {}))}
        for ano in anos:
            if cod == BRASILIA:
                registro["anos"][str(ano)] = {"s": "df"}
                continue
            total += 1
            if so_minimos:
                reg = registro["anos"].get(str(ano))
                if reg and reg.get("tipo") in TIPOS:
                    for k in ("ms", "min", "msha256"):
                        reg.pop(k, None)
                    reg.update(buscar_minimos(ano, cod, reg["tipo"]))
                continue
            if so_despesas:
                reg = registro["anos"].get(str(ano))
                if reg and reg.get("tipo") in TIPOS:
                    for k in ("ds", "dmotivo", "funcoes", "dtotal", "dsha256"):
                        reg.pop(k, None)
                    reg.update(buscar_despesas(ano, cod, reg["tipo"]))
                    if reg["ds"] == "erro":
                        erros += 1
                continue
            antes_ano = registro["anos"].get(str(ano)) or {}
            ordem = ordem_dos_tipos(antes_ano.get("tipo"), m["pop"])
            resumo = buscar_relatorio(ano, cod, ordem)
            if resumo is None:
                erros += 1
                # Vale o dado anterior, menos um "sem_relatorio" da versão que
                # só pedia o RREO completo (sem "tipo"), que pode estar errado.
                antes_ano = registro["anos"].get(str(ano))
                if not antes_ano or (antes_ano.get("s") == "sem_relatorio" and "tipo" not in antes_ano
                                     and not isinstance(antes_ano.get("sha256"), list)):
                    registro["anos"][str(ano)] = {"s": "erro"}
                continue
            if resumo.get("tipo") in TIPOS:
                resumo.update(buscar_despesas(ano, cod, resumo["tipo"]))
                manter_ou_buscar_minimos(resumo, antes_ano, ano, cod, recoletar)
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
    despesas = {}
    for r in saida["municipios"].values():
        for ano in anos:
            ds = r["anos"].get(str(ano), {}).get("ds")
            if ds:
                despesas[(ano, ds)] = despesas.get((ano, ds), 0) + 1
    for (ano, ds), q in sorted(despesas.items()):
        print(f"{uf} {ano} despesas: {q} {ds}")
    minimos = {}
    for r in saida["municipios"].values():
        for ano in anos:
            ms = r["anos"].get(str(ano), {}).get("ms")
            if ms:
                minimos[(ano, ms)] = minimos.get((ano, ms), 0) + 1
    for (ano, ms), q in sorted(minimos.items()):
        print(f"{uf} {ano} mínimos (Anexo 14): {q} {ms}")
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


def indicadores_despesa(reg_ano, pop):
    """Por morador: despesa total, saúde, educação e Câmara de Vereadores
    (função Legislativa). Só com despesas "ok"."""
    if reg_ano.get("ds") != "ok" or not pop or pop <= 0:
        return None
    f = reg_ano.get("funcoes") or {}
    total = reg_ano.get("dtotal") or 0
    if total <= 0:
        return None
    return {"despesa_hab": total / pop, "saude_hab": f.get("Saúde", 0.0) / pop,
            "educacao_hab": f.get("Educação", 0.0) / pop, "camara_hab": f.get("Legislativa", 0.0) / pop}


# Parte do FPM que são as parcelas extras de 1% (CF, art. 159, I, d, e, f):
# entram na base da educação, mas não na da saúde (LC 141/2012, art. 7º, só
# a alínea b). Total repassado: 22,5% + extras; a de setembro (EC 112/2021)
# foi de 0,25 ponto em 2022 e 2023, 0,5 em 2024 e 1 a partir de 2025.
def fpm_extra(ano):
    setembro = 0.0 if ano < 2022 else 0.25 if ano < 2024 else 0.5 if ano == 2024 else 1.0
    extras = (1.0 if ano >= 2008 else 0.0) + (1.0 if ano >= 2015 else 0.0) + setembro
    return extras / (22.5 + extras)


def bases_do_anexo3(v, ano):
    """Bases de comparação a partir do Anexo 3: impostos da cidade e cotas
    constitucionais (educação), o mesmo sem as parcelas extras do FPM
    (saúde) e o FUNDEB recebido."""
    base = sum(v[c] for c in ("iptu", "iss", "itbi", "irrf", "fpm", "icms", "ipva", "itr"))
    return {"educacao": base, "saude": base - v["fpm"] * fpm_extra(int(ano)), "fundeb": v["fundeb"]}


def minimos_do_site(reg):
    """[[percentual, base declarada, mínimo] ou None] na ordem de MINIMOS."""
    saida = []
    for chave, _ in MINIMOS:
        x = (reg.get("min") or {}).get(chave)
        if not x or x[0] is None or x[0] <= 0:
            saida.append(None)
            continue
        pct, valor, minimo = x
        base = round(valor * 100 / pct) if valor else None
        saida.append([pct, base, minimo])
    return saida


# Mediana máxima da diferença entre as bases antes de parar a atualização.
# Em SP e MG (18/11/2026), a mediana foi de 0,2% a 0,3% na educação, 0,6% a
# 0,9% na saúde e 0,6% a 1,6% no FUNDEB, cuja base inclui rendimentos e a
# complementação da União e por isso bate menos.
LIMITE_CONFERENCIA = {"educacao": 0.02, "saude": 0.03, "fundeb": 0.05}


def conferir_minimos(por_uf, anos):
    """Mediana da diferença entre a base declarada no Anexo 14 e a do Anexo 3.
    Se passar do LIMITE_CONFERENCIA num ano com muitas cidades, a atualização
    para."""
    for ano in anos:
        difs = {chave: [] for chave, _ in MINIMOS}
        for d in por_uf.values():
            for r in d["municipios"].values():
                reg = r["anos"].get(str(ano)) or {}
                if reg.get("s") != "ok" or reg.get("ms") != "ok" or "v" not in reg:
                    continue
                bases = bases_do_anexo3(reg["v"], ano)
                for (chave, _), x in zip(MINIMOS, minimos_do_site(reg)):
                    if x and x[1] and bases[chave] > 0:
                        difs[chave].append(abs(x[1] / bases[chave] - 1))
        for chave, xs in difs.items():
            if len(xs) < 300:
                print(f"  {ano} {chave}: só {len(xs)} cidades com as duas bases; conferência pulada")
                continue
            med = statistics.median(xs)
            ate2 = sum(1 for x in xs if x <= 0.02) / len(xs)
            ate5 = sum(1 for x in xs if x <= 0.05) / len(xs)
            print(f"  {ano} {chave}: base do Anexo 14 contra o Anexo 3, mediana {med:.2%}; "
                  f"{ate2:.0%} até 2%, {ate5:.0%} até 5%, em {len(xs)} cidades")
            if med > LIMITE_CONFERENCIA[chave]:
                falhar(f"{ano}: a base de {chave} do Anexo 14 não bate com o Anexo 3 (mediana {med:.2%})")


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
                pop = reg.get("pop") or r["pop"]
                ind.update(indicadores_despesa(reg, pop) or {})
                f = faixa_de(pop)
                for k, x in ind.items():
                    nacional.setdefault((ano, f, k), []).append(x)
                    estadual.setdefault((uf, ano, k), []).append(x)
    conferir_minimos(por_uf, anos)
    indice = {"atualizado": dt.date.today().isoformat(), "anos": anos, "campos": CAMPOS_SITE,
              "campos_despesa": CAMPOS_DESPESA, "minimos": [chave for chave, _ in MINIMOS],
              "faixas": [{"ate": teto, "rotulo": rotulo} for teto, rotulo in FAIXAS],
              "medianas": {}, "cidades": []}
    for (ano, f, k), xs in nacional.items():
        m = indice["medianas"].setdefault(ano, {}).setdefault(str(f), {})
        m[k] = mediana(xs)
        if k == "receita_hab":
            m["n"] = len(xs)
        if k == "despesa_hab":
            m["nd"] = len(xs)
    for uf, d in sorted(por_uf.items()):
        site = {"uf": uf, "atualizado": d.get("atualizado"), "anos": anos, "campos": CAMPOS_SITE,
                "campos_despesa": CAMPOS_DESPESA,
                "medianas": {}, "municipios": []}
        for (u, ano, k), xs in estadual.items():
            if u == uf:
                site["medianas"].setdefault(ano, {})[k] = mediana(xs)
                if k == "receita_hab":
                    site["medianas"][ano]["n"] = len(xs)
                if k == "despesa_hab":
                    site["medianas"][ano]["nd"] = len(xs)
        for cod, r in sorted(d["municipios"].items(), key=lambda x: x[1]["nome"]):
            item = {"c": int(cod), "n": r["nome"], "p": r["pop"], "a": {}}
            for ano, reg in sorted(r["anos"].items()):
                registro = {"s": reg["s"]}
                # "sem_relatorio" da versão que só pedia o RREO completo (sem
                # "tipo" e sem os dois SHA-256) não foi conferido no
                # simplificado: no site vira "erro" (sem dado), não "não
                # entregou".
                if reg["s"] == "sem_relatorio" and "tipo" not in reg and not isinstance(reg.get("sha256"), list):
                    registro["s"] = "erro"
                if reg.get("pop"):
                    registro["p"] = reg["pop"]
                if "v" in reg:
                    registro["v"] = [round(reg["v"][c]) for c in CAMPOS_SITE]
                if reg.get("motivo"):
                    registro["m"] = reg["motivo"]
                if reg.get("ds"):
                    registro["ds"] = reg["ds"]
                if reg.get("funcoes") is not None and reg.get("ds") in ("ok", "nao_fecha"):
                    registro["d"] = [round(x) for x in grupos_de_despesa(reg["funcoes"])]
                if reg.get("dmotivo"):
                    registro["dm"] = reg["dmotivo"]
                if reg.get("ms"):
                    registro["ms"] = reg["ms"]
                if reg.get("ms") == "ok":
                    registro["mi"] = minimos_do_site(reg)
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
    p.add_argument("--so-despesas", action="store_true", help="só o Anexo 2, para quem já tem o Anexo 3")
    p.add_argument("--so-minimos", action="store_true", help="só o Anexo 14, para quem já tem o Anexo 3")
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
    buscar_uf(a.uf, anos, so_despesas=a.so_despesas, so_minimos=a.so_minimos)


if __name__ == "__main__":
    main()
