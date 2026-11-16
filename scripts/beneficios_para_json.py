#!/usr/bin/env python3
"""Bolsa Família e BPC pagos em cada cidade, mês a mês.

Fonte oficial: Portal da Transparência (CGU), API de dados, com chave de acesso
gratuita (cabeçalho chave-api-dados; aqui, variável de ambiente
PORTAL_TRANSPARENCIA_CHAVE):
  https://api.portaldatransparencia.gov.br/api-de-dados/novo-bolsa-familia-por-municipio?mesAno=AAAAMM&codigoIbge=CODIGO&pagina=1
  https://api.portaldatransparencia.gov.br/api-de-dados/bpc-por-municipio?mesAno=AAAAMM&codigoIbge=CODIGO&pagina=1
Lista de cidades: IBGE, API de localidades.
  https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado

Cada resposta traz uma linha por cidade e mês: valor pago no mês e quantidade
de beneficiados (famílias, no Bolsa Família; pessoas, no BPC). Conferido em
16/11/2026: São Paulo, setembro de 2026, R$ 407.982.179,00 para 614.917
famílias no Novo Bolsa Família; o último mês publicado era setembro (outubro
vinha vazio). O Novo Bolsa Família começa em março de 2023; antes vinham o
Auxílio Brasil e o Bolsa Família antigo, que são outros programas e ficam de
fora.

A API responde uma cidade por pedido. O limite do Portal é de 400 pedidos por
minuto de dia e 700 de madrugada; acima disso a chave é suspensa. O script faz
no máximo 1 pedido a cada INTERVALO segundos (cerca de 200 por minuto), em um
único processo.

Um mês só é gravado inteiro: se mais de 1% das cidades vier sem linha em um
programa, ou se o total do país sair da faixa plausível, o mês é descartado e
tentado de novo na próxima vez.

Ordem dos meses: o último publicado, o mesmo mês do ano anterior e depois os
outros, do mais novo para o mais velho, até março de 2023. Cada execução tem
um tempo máximo (--minutos); o que faltar fica para a próxima.

Saídas:
  dados-fonte/beneficios/AAAA-MM.json  (um arquivo por mês, todas as cidades)
  site/dados/beneficios/UF.json        (o que o site lê: últimos 13 meses)
  site/dados/beneficios/indice.json    (meses disponíveis e totais do país)

Uso:
  python3 scripts/beneficios_para_json.py --buscar [--minutos 300] [--meses 2026-09,2025-09]
  python3 scripts/beneficios_para_json.py --montar
"""

import argparse
import datetime as dt
import glob
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.portaldatransparencia.gov.br/api-de-dados"
IBGE = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado"
AGENTE = "ArrecadometroBrasil/1.0 (dados publicos)"
FONTE = "dados-fonte/beneficios"
DESTINO = "site/dados/beneficios"
INTERVALO = 0.3  # segundos entre o início de um pedido e o do próximo
PRIMEIRO_MES = "2023-03"  # início do Novo Bolsa Família
MESES_NO_SITE = 13
SAO_PAULO = "3550308"

# programa -> (caminho na API, id do tipo na resposta, faixa plausível do total
# do país no mês, em reais). Faixas largas, para pegar arquivo trocado ou vazio.
PROGRAMAS = {
    "nbf": ("novo-bolsa-familia-por-municipio", 8, (5e9, 4e10)),
    "bpc": ("bpc-por-municipio", 5, (3e9, 4e10)),
}
CAMPOS = ["nbf_valor", "nbf_qtd", "bpc_valor", "bpc_qtd"]
MAXIMO_VAZIOS = 0.01


class ChaveRecusada(Exception):
    pass


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


_ultimo_pedido = [0.0]


def pedir_json(url, cabecalhos, tentativas=6):
    """JSON da resposta, ou None se todas as tentativas falharem. Recusa da
    chave (401/403) interrompe tudo, para não insistir com chave inválida."""
    for k in range(tentativas):
        espera = INTERVALO - (time.monotonic() - _ultimo_pedido[0])
        if espera > 0:
            time.sleep(espera)
        _ultimo_pedido[0] = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE, "Accept": "application/json", **cabecalhos})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as erro:
            if erro.code in (401, 403):
                raise ChaveRecusada(f"HTTP {erro.code}")
            pausa = 60 * (k + 1) if erro.code == 429 or erro.code >= 500 else 10 * (k + 1)
            print(f"  tentativa {k + 1}: HTTP {erro.code}; nova tentativa em {pausa} s", flush=True)
        except Exception as erro:  # noqa: BLE001
            pausa = 10 * (k + 1)
            print(f"  tentativa {k + 1}: {erro}; nova tentativa em {pausa} s", flush=True)
        time.sleep(pausa)
    return None


def lista_de_cidades():
    d = pedir_json(IBGE, {})
    if not isinstance(d, list):
        falhar("lista de municípios do IBGE não respondeu")
    cidades = {}
    for m in d:
        cod = str(m.get("municipio-id") or "")
        uf = m.get("UF-sigla") or ""
        if len(cod) != 7 or not cod.isdigit() or len(uf) != 2:
            falhar(f"município do IBGE fora do padrão: {m}")
        cidades[cod] = {"nome": m.get("municipio-nome") or "", "uf": uf}
    if not 5560 <= len(cidades) <= 5580:
        falhar(f"lista do IBGE com {len(cidades)} municípios; esperado 5.570")
    return cidades


def url_programa(programa, mes, cod):
    caminho = PROGRAMAS[programa][0]
    q = urllib.parse.urlencode({"mesAno": mes.replace("-", ""), "codigoIbge": cod, "pagina": 1})
    return f"{API}/{caminho}?{q}"


def ler_linha(resposta, programa, mes, cod):
    """(valor, quantidade) de uma resposta, None se vier vazia. Falha em
    qualquer coisa fora do formato conferido."""
    if not isinstance(resposta, list):
        falhar(f"{programa} {mes} {cod}: resposta não é lista")
    if not resposta:
        return None
    if len(resposta) != 1:
        falhar(f"{programa} {mes} {cod}: {len(resposta)} linhas; esperada 1")
    r = resposta[0]
    tipo = (r.get("tipo") or {}).get("id")
    if tipo != PROGRAMAS[programa][1]:
        falhar(f"{programa} {mes} {cod}: tipo {tipo}")
    if str((r.get("municipio") or {}).get("codigoIBGE")) != cod:
        falhar(f"{programa} {mes} {cod}: veio a cidade {(r.get('municipio') or {}).get('codigoIBGE')}")
    if r.get("dataReferencia") != f"{mes}-01":
        falhar(f"{programa} {mes} {cod}: veio o mês {r.get('dataReferencia')}")
    valor, qtd = r.get("valor"), r.get("quantidadeBeneficiados")
    if not isinstance(valor, (int, float)) or valor < 0 or not isinstance(qtd, int) or qtd < 0:
        falhar(f"{programa} {mes} {cod}: valor {valor!r}, quantidade {qtd!r}")
    return round(float(valor), 2), qtd


def mes_publicado(mes, chave):
    """O mês conta como publicado quando os dois programas têm São Paulo."""
    return all(pedir_json(url_programa(p, mes, SAO_PAULO), chave) for p in PROGRAMAS)


def meses_entre(inicio, fim):
    a, m = map(int, inicio.split("-"))
    saida = []
    while f"{a}-{m:02d}" <= fim:
        saida.append(f"{a}-{m:02d}")
        a, m = (a + 1, 1) if m == 12 else (a, m + 1)
    return saida


def mes_anterior(mes, n=1):
    a, m = map(int, mes.split("-"))
    total = a * 12 + (m - 1) - n
    return f"{total // 12}-{total % 12 + 1:02d}"


def buscar_mes(mes, cidades, chave):
    inicio = time.monotonic()
    linhas = {}
    vazios = {p: [] for p in PROGRAMAS}
    resumo = hashlib.sha256()
    for n, cod in enumerate(sorted(cidades), start=1):
        valores = []
        for programa in PROGRAMAS:
            resposta = pedir_json(url_programa(programa, mes, cod), chave)
            if resposta is None:
                print(f"{mes}: {programa} de {cod} não respondeu; mês descartado", flush=True)
                return None
            resumo.update(json.dumps(resposta, sort_keys=True, ensure_ascii=False).encode())
            linha = ler_linha(resposta, programa, mes, cod)
            if linha is None:
                vazios[programa].append(cod)
                valores += [None, None]
            else:
                valores += list(linha)
        linhas[cod] = valores
        if n % 500 == 0:
            print(f"{mes}: {n} de {len(cidades)} cidades ({(time.monotonic() - inicio) / 60:.0f} min)", flush=True)
    totais = {}
    for k, programa in enumerate(PROGRAMAS):
        if len(vazios[programa]) > MAXIMO_VAZIOS * len(cidades):
            print(f"{mes}: {len(vazios[programa])} cidades sem {programa}; mês descartado", flush=True)
            return None
        total = sum(v[2 * k] or 0 for v in linhas.values())
        pessoas = sum(v[2 * k + 1] or 0 for v in linhas.values())
        piso, teto = PROGRAMAS[programa][2]
        if not piso <= total <= teto:
            print(f"{mes}: total de {programa} R$ {total:,.2f} fora da faixa; mês descartado", flush=True)
            return None
        totais[programa] = {"valor": round(total, 2), "qtd": pessoas, "vazios": vazios[programa]}
    minutos = (time.monotonic() - inicio) / 60
    print(f"{mes}: ok em {minutos:.0f} min; " + "; ".join(
        f"{p} R$ {t['valor'] / 1e9:.2f} bi, {t['qtd']} beneficiados, {len(t['vazios'])} sem linha" for p, t in totais.items()),
        flush=True)
    return {"mes": mes, "coletado_em": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "fonte": API, "campos": CAMPOS, "totais": totais, "sha256_respostas": resumo.hexdigest(),
            "municipios": linhas}, minutos


def gravar_json(caminho, dados, compacto=True):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, ensure_ascii=False, separators=(",", ":") if compacto else None,
                  indent=None if compacto else 1)
        fh.write("\n")
    os.replace(temporario, caminho)


def buscar(minutos, meses_pedidos):
    chave_valor = os.environ.get("PORTAL_TRANSPARENCIA_CHAVE", "").strip()
    if not chave_valor:
        falhar("variável PORTAL_TRANSPARENCIA_CHAVE vazia")
    chave = {"chave-api-dados": chave_valor}
    limite = time.monotonic() + minutos * 60
    feitos = {os.path.basename(a)[:-5] for a in glob.glob(f"{FONTE}/????-??.json")}
    try:
        if meses_pedidos:
            fila = meses_pedidos
        else:
            hoje = dt.date.today()
            ultimo = None
            for n in range(0, 5):
                mes = mes_anterior(f"{hoje.year}-{hoje.month:02d}", n)
                if mes_publicado(mes, chave):
                    ultimo = mes
                    break
            if not ultimo:
                falhar("nenhum mês publicado nos últimos 5 meses para São Paulo; API mudou?")
            print(f"último mês publicado: {ultimo}", flush=True)
            fila = [ultimo, mes_anterior(ultimo, 12)] + list(reversed(meses_entre(PRIMEIRO_MES, ultimo)))
        fila = [m for i, m in enumerate(fila) if m >= PRIMEIRO_MES and m not in fila[:i] and m not in feitos]
        if not fila:
            print("nenhum mês novo para buscar")
            return
        cidades = lista_de_cidades()
        estimativa = 2 * len(cidades) * INTERVALO / 60 * 1.15
        for mes in fila:
            restam = (limite - time.monotonic()) / 60
            if restam < estimativa:
                print(f"tempo restante ({restam:.0f} min) menor que o de um mês ({estimativa:.0f} min); "
                      f"faltam {len(fila) - fila.index(mes)} meses para a próxima execução", flush=True)
                break
            resultado = buscar_mes(mes, cidades, chave)
            if resultado is None:
                continue
            dados, gasto = resultado
            estimativa = max(estimativa, gasto * 1.1)
            gravar_json(f"{FONTE}/{mes}.json", dados)
    except ChaveRecusada as erro:
        falhar(f"o Portal recusou a chave ({erro}); confira o secret PORTAL_TRANSPARENCIA_CHAVE")


def montar():
    arquivos = sorted(glob.glob(f"{FONTE}/????-??.json"))
    if not arquivos:
        print("nenhum mês gravado ainda; nada a montar")
        return
    todos = {}
    for a in arquivos:
        with open(a, encoding="utf-8") as fh:
            d = json.load(fh)
        if d.get("campos") != CAMPOS:
            falhar(f"{a}: campos diferentes de {CAMPOS}")
        todos[d["mes"]] = d
    meses = sorted(todos)
    ultimo = meses[-1]
    # O site mostra o último mês e o mesmo mês do ano anterior; ficam os 13
    # meses que cobrem os dois.
    no_site = [m for m in meses if m >= mes_anterior(ultimo, MESES_NO_SITE - 1)]
    por_uf = {}
    cidades = lista_de_cidades()
    for mes in no_site:
        for cod in todos[mes]["municipios"]:
            if cod not in cidades:
                falhar(f"cidade {cod} dos dados de {mes} não está na lista do IBGE")
    for cod, c in cidades.items():
        # Reais inteiros no site; os centavos ficam em dados-fonte.
        serie = [None if (v := todos[m]["municipios"].get(cod)) is None
                 else [None if x is None else round(x) for x in v] for m in no_site]
        por_uf.setdefault(c["uf"], {})[cod] = serie
    indice = {"atualizado": dt.date.today().isoformat(), "fonte": API, "campos": CAMPOS, "meses": no_site,
              "todos_os_meses": meses,
              "totais": {m: {p: {"valor": todos[m]["totais"][p]["valor"], "qtd": todos[m]["totais"][p]["qtd"]}
                             for p in PROGRAMAS} for m in meses}}
    for uf, municipios in sorted(por_uf.items()):
        gravar_json(f"{DESTINO}/{uf}.json", {"uf": uf, "campos": CAMPOS, "meses": no_site,
                                             "municipios": municipios})
    gravar_json(f"{DESTINO}/indice.json", indice, compacto=False)
    print(f"montados {len(por_uf)} estados; meses no site {no_site[0]} a {no_site[-1]}; {len(meses)} meses gravados")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--buscar", action="store_true")
    p.add_argument("--montar", action="store_true")
    p.add_argument("--minutos", type=float, default=300)
    p.add_argument("--meses", help="meses AAAA-MM separados por vírgula (padrão: automático)")
    a = p.parse_args()
    if a.buscar:
        meses = None
        if a.meses:
            meses = [m.strip() for m in a.meses.split(",") if m.strip()]
            if any(len(m) != 7 or m[4] != "-" for m in meses):
                falhar(f"meses inválidos: {a.meses}")
        buscar(a.minutos, meses)
    if a.montar:
        montar()
    if not (a.buscar or a.montar):
        falhar("informe --buscar e/ou --montar")


if __name__ == "__main__":
    main()
