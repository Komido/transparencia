#!/usr/bin/env python3
"""Em que cada Câmara Municipal paranaense gastou, por ano e por tipo de despesa.

Fonte oficial: Tribunal de Contas do Estado do Paraná (TCE-PR), Portal
Informação para Todos (PIT), "Download de Dados" > "Consolidado", um zip por
ano com os dados de todas as 399 cidades:
  https://pit.tce.pr.gov.br/Dados/DadosConsulta/Consolidado
  https://pit.tce.pr.gov.br/Arquivos/AAAA_PIT_TodosArquivos.zip

Conferido em 19/11/2026 (inspeção pelo GitHub): o zip de 2025 tem 1,4 GB e
traz um zip por cidade e tema (2025_410690_Despesa.zip etc.); o de despesa
tem os XML de empenho (às vezes em partes: Empenho_1.xml, Empenho_2.xml).
Cada empenho traz o código do IBGE da cidade (6 dígitos), o órgão
(nmEntidade, por exemplo "CÂMARA MUNICIPAL DE CURITIBA"), o código completo
da despesa (categoria, grupo, modalidade, elemento e desdobramento), a
função, o valor empenhado, o liquidado e o pago, já descontados os estornos,
e a última remessa da prefeitura ao tribunal no ano ("2025/13" é a de
encerramento). O tribunal gera os arquivos uma vez por semana. Alguns XML
trazem referências a caracteres de controle (&#1;), que o XML não aceita:
viram espaço antes da leitura.

Conta: soma do valor pago dos empenhos do ano feitos pela Câmara, menos a
modalidade 91 (intra-orçamentária), como nos outros estados. O tipo vem do
código da despesa, nos mesmos grupos de SP; o subsídio dos vereadores é o
desdobramento 75 do elemento 11, como em SP. Na inspeção, o pago das
câmaras ficou com mediana de 1,00 contra o custo informado ao Tesouro
(SICONFI, função Legislativa) em 352 cidades; Abatiá bateu exatamente.

Em quatro cidades (São João, São Jorge do Patrocínio, Bom Jesus do Sul e
Bom Sucesso do Sul, em 2025) a Câmara não aparece como órgão próprio: os
gastos da função Legislativa são lançados pela prefeitura. Essas cidades
vão para "fora" com o motivo "na_prefeitura", para a página explicar.

Só entram anos fechados: pelo menos 90% das câmaras com a remessa de
encerramento. O ano fechado mais recente é baixado de novo até junho do ano
seguinte, mas só se o arquivo mudou (data e tamanho, lidos num pedido de 1
byte, porque o servidor não responde ao HEAD com esses dados); os anos
anteriores são reaproveitados. Sem nomes de pessoas na saída.

Saída: site/dados/camaras/PR.json, no formato de SP.json, mais "fora".
"""

import collections
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import urllib.robotparser
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camaras_sp_para_json as comum  # noqa: E402

AGENTE = comum.AGENTE
BASE = "https://pit.tce.pr.gov.br"
ARQUIVO = BASE + "/Arquivos/{ano}_PIT_TodosArquivos.zip"
FONTE = BASE + "/Dados/DadosConsulta/Consolidado"
DESTINO = "site/dados/camaras/PR.json"
MUNICIPIOS = "site/dados/municipios/PR.json"
TEMPORARIO = os.environ.get("RUNNER_TEMP", "/tmp")
ANOS_GUARDADOS = 2
ANOS_PROCURADOS = 4
MES_FIM_REVISAO = 6
MINIMO_DE_CAMARAS = 370
FRACAO_FECHADA = 0.9
MAXIMO_FORA = 0.1
VERSAO_DA_CONTA = 1
INTERVALO = 2.0
SUBSIDIO = ("75",)
CATEGORIAS = comum.CATEGORIAS
INDICE = comum.INDICE

ultimo = [0.0]
robots = urllib.robotparser.RobotFileParser()


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def pedir(url, cabecalhos=None, tempo=120):
    espera = INTERVALO - (time.time() - ultimo[0])
    if espera > 0:
        time.sleep(espera)
    ultimo[0] = time.time()
    if not url.endswith("/robots.txt") and not robots.can_fetch(AGENTE, url):
        falhar(f"o robots.txt do portal não permite {url}")
    req = urllib.request.Request(url, headers={"User-Agent": AGENTE, **(cabecalhos or {})})
    return urllib.request.urlopen(req, timeout=tempo)


def ler_robots():
    """O PIT responde ao robots.txt com uma página HTML: sem regras."""
    try:
        with pedir(BASE + "/robots.txt") as r:
            texto = r.read(200_000).decode("utf-8", "replace")
    except urllib.error.HTTPError:
        texto = ""
    linhas = [] if "<html" in texto[:500].lower() else texto.splitlines()
    robots.parse(linhas)
    print(f"robots.txt: {len(linhas)} linhas de regras", flush=True)


def cabecalho(ano):
    """(tamanho, data) do zip do ano, por um pedido de 1 byte; None se não existe."""
    try:
        with pedir(ARQUIVO.format(ano=ano), cabecalhos={"Range": "bytes=0-0"}) as r:
            total = (r.headers.get("Content-Range") or "").rpartition("/")[2]
            tamanho = int(total) if total.isdigit() else int(r.headers.get("Content-Length") or 0)
            return tamanho, r.headers.get("Last-Modified", "")
    except urllib.error.HTTPError as erro:
        if erro.code == 404:
            return None
        raise


def baixar(url, destino, tamanho):
    """Download retomando de onde parou, se a conexão cair."""
    if os.path.exists(destino):
        os.remove(destino)
    falhas, inicio = 0, time.time()
    while (feito := os.path.getsize(destino) if os.path.exists(destino) else 0) < tamanho:
        cab = {"Range": f"bytes={feito}-"} if feito else None
        try:
            with pedir(url, cabecalhos=cab, tempo=900) as r, open(destino, "ab") as fh:
                if feito and r.status != 206:
                    falhar(f"o servidor não retomou o download (HTTP {r.status})")
                while bloco := r.read(1 << 20):
                    fh.write(bloco)
        except (urllib.error.URLError, OSError, TimeoutError) as erro:
            falhas += 1
            print(f"  falha {falhas} em {feito / 1e6:.0f} MB: {erro}", flush=True)
            if falhas > 10:
                falhar(f"o download de {url} falhou demais")
    if os.path.getsize(destino) != tamanho:
        falhar(f"arquivo com tamanho errado: {os.path.getsize(destino)} em vez de {tamanho}")
    print(f"  baixado em {(time.time() - inicio) / 60:.1f} min", flush=True)


def sem_controle(bruto):
    """Troca referências a caracteres de controle (&#1;), que o XML recusa, por espaço."""
    def troca(m):
        ref = m.group(1)
        n = int(ref[1:], 16) if ref[:1] in b"xX" else int(ref)
        return b" " if n < 32 and n not in (9, 10, 13) else m.group(0)
    return re.sub(rb"&#([xX][0-9a-fA-F]+|[0-9]+);", troca, bruto)


def eh_camara(nome):
    nome = comum.sem_acento(nome)
    return ("CAMARA" in nome or "LEGISLATIV" in nome) and not re.search(r"PREFEITURA|FUNDO|CONSORCIO", nome)


def empenhos(dados):
    """Atributos de cada <Empenho> de um XML, sem guardar a árvore inteira."""
    for _, el in ET.iterparse(io.BytesIO(sem_controle(dados))):
        if el.tag == "Empenho":
            yield el.attrib
        el.clear()


def somar(caminho, ano, cidades7):
    """({código IBGE: [total, partes]}, {código: liquidado}, {código: motivo}) ou None se o ano não fechou."""
    z = zipfile.ZipFile(caminho)
    despesas = [i for i in z.infolist() if re.fullmatch(rf"{ano}_\d{{6}}_Despesa\.zip", i.filename)]
    if len(despesas) < MINIMO_DE_CAMARAS:
        falhar(f"só {len(despesas)} cidades com despesa no zip de {ano}")
    por_cidade, liquidado = {}, collections.defaultdict(float)
    nomes, remessas = collections.defaultdict(set), {}
    legislativa_fora = collections.Counter()
    puladas, outros_anos, pago_intra = [], collections.Counter(), 0.0
    tabela = collections.defaultdict(float)
    inicio = time.time()
    for info in despesas:
        cod6 = info.filename.split("_")[1]
        cod = cidades7.get(cod6)
        if not cod:
            falhar(f"cidade {cod6} do tribunal sem código IBGE na lista do site")
        try:
            interno = zipfile.ZipFile(io.BytesIO(z.read(info)))
            partes = sorted(n for n in interno.namelist() if re.search(r"_Empenho(_\d+)?\.xml$", n))
            if not partes:
                raise ValueError(f"sem Empenho.xml: {interno.namelist()[:6]}")
            for parte in partes:
                for r in empenhos(interno.read(parte)):
                    if str(r.get("cdIBGE")) != cod6:
                        raise ValueError(f"empenho de outra cidade ({r.get('cdIBGE')}) no arquivo")
                    if not eh_camara(r.get("nmEntidade")):
                        if r.get("cdFuncao") == "01":
                            legislativa_fora[cod] += 1
                        continue
                    if r.get("nrAnoEmpenho") != str(ano):
                        outros_anos[r.get("nrAnoEmpenho")] += 1
                        continue
                    nomes[cod].add(r.get("nmEntidade"))
                    remessas[cod] = max(remessas.get(cod, ""), r.get("ultimoEnvioSIMAMNesteExercicio") or "")
                    pago = comum.numero(r.get("vlPagamento") or "0")
                    if r.get("cdModalidade") == "91":
                        pago_intra += pago
                        continue
                    liquidado[cod] += comum.numero(r.get("vlLiquidacao") or "0")
                    codigo = "".join((r.get("cdCategoriaEconomica") or "", r.get("cdGrupoNatureza") or "",
                                      (r.get("cdModalidade") or "").zfill(2), (r.get("cdElemento") or "").zfill(2),
                                      (r.get("cdDesdobramento") or "").zfill(2)))
                    cat = comum.categoria(codigo, subsidio=SUBSIDIO)
                    tabela[(cat, codigo[:6])] += pago
                    item = por_cidade.setdefault(cod, [0.0, [0.0] * len(CATEGORIAS)])
                    item[0] += pago
                    item[1][INDICE[cat]] += pago
        except (zipfile.BadZipFile, ET.ParseError, ValueError) as erro:
            puladas.append((cod6, str(erro)[:160]))
            continue
    print(f"  {ano}: {len(despesas)} cidades lidas em {(time.time() - inicio) / 60:.1f} min; "
          f"câmaras com pagamentos: {len(por_cidade)}; intra-orçamentário deixado de fora R$ {pago_intra / 1e6:.1f} mi", flush=True)
    if puladas:
        print(f"  {ano}: cidades puladas por arquivo com erro ({len(puladas)}): {puladas[:10]}")
    if len(puladas) > 10:
        falhar(f"{len(puladas)} cidades com arquivo de despesa ilegível em {ano}")
    if outros_anos:
        print(f"  {ano}: empenhos de câmara de outros anos deixados de fora: {dict(outros_anos)}")
    duplas = {c: sorted(n) for c, n in nomes.items() if len(n) > 1}
    if duplas:
        print(f"  {ano}: cidades com mais de um órgão de câmara (somados): {list(duplas.items())[:10]}")
    fechadas = sum(1 for v in remessas.values() if v.startswith(f"{ano}/13"))
    print(f"  {ano}: câmaras com a remessa de encerramento ({ano}/13): {fechadas} de {len(remessas)}; "
          f"outras: {collections.Counter(v for v in remessas.values() if not v.startswith(f'{ano}/13')).most_common(5)}", flush=True)
    if fechadas < FRACAO_FECHADA * len(remessas):
        print(f"{ano}: o ano ainda não fechou no tribunal; fica de fora", flush=True)
        return None
    na_prefeitura = {c: "na_prefeitura" for c in legislativa_fora if c not in por_cidade}
    if na_prefeitura:
        print(f"  {ano}: cidades sem câmara própria, com gastos da função Legislativa lançados pela prefeitura: {sorted(na_prefeitura)}")
    print(f"  {ano}: tipo de cada elemento (pago, R$ mi):")
    for (cat, cod), v in sorted(tabela.items(), key=lambda x: -x[1])[:40]:
        print(f"    {v / 1e6:9.2f}  {cat:10s} {cod}")
    return por_cidade, liquidado, na_prefeitura


def main():
    try:
        antigo = json.load(open(DESTINO, encoding="utf-8"))
    except OSError:
        antigo = {}
    m = json.load(open(MUNICIPIOS, encoding="utf-8"))
    cidades7 = {str(x["c"])[:6]: str(x["c"]) for x in m["municipios"]}
    ler_robots()
    agora = datetime.now(timezone.utc)
    cidades = collections.defaultdict(dict)
    fora, arquivos = {}, {}
    anos, mudou = [], False
    for ano in range(agora.year - 1, agora.year - 1 - ANOS_PROCURADOS, -1):
        if len(anos) == ANOS_GUARDADOS:
            break
        guardado = ano in (antigo.get("anos") or []) and antigo.get("versao") == VERSAO_DA_CONTA
        visto = (antigo.get("arquivos") or {}).get(str(ano)) or {}
        revisar = ano == agora.year - 1 and agora.month <= MES_FIM_REVISAO
        info = None
        if not guardado or revisar:
            info = cabecalho(ano)
            if info is None:
                print(f"{ano}: o portal ainda não tem o arquivo", flush=True)
                continue
            arquivos[str(ano)] = {"tamanho": info[0], "modificado": info[1]}
        if guardado and (not revisar or (visto.get("tamanho"), visto.get("modificado")) == info):
            print(f"{ano}: já gravado e sem mudança; reaproveitado", flush=True)
            arquivos[str(ano)] = visto
            for cod, por_ano in (antigo.get("cidades") or {}).items():
                if str(ano) in por_ano:
                    cidades[cod][str(ano)] = por_ano[str(ano)]
            for cod, por_ano in (antigo.get("fora") or {}).items():
                if str(ano) in por_ano:
                    fora.setdefault(cod, {})[str(ano)] = por_ano[str(ano)]
            anos.append(ano)
            continue
        tamanho, modificado = info
        print(f"{ano}: baixando {tamanho / 1e6:.0f} MB ({modificado})", flush=True)
        caminho = os.path.join(TEMPORARIO, f"pr-pit-{ano}.zip")
        baixar(ARQUIVO.format(ano=ano), caminho, tamanho)
        r = somar(caminho, ano, cidades7)
        os.remove(caminho)
        if r is None:
            arquivos[str(ano)]["incompleto"] = True
            continue
        por_cidade, liquidado, na_prefeitura = r
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
        for cod, motivo in na_prefeitura.items():
            fora.setdefault(cod, {})[str(ano)] = motivo
        anos.append(ano)
        mudou = True
    if not mudou:
        print("Nenhum ano novo ou com arquivo novo; nada a gravar.")
        return
    anos.sort()
    if not anos:
        falhar("nenhum ano fechado no tribunal")
    comum.conferir_com_siconfi(cidades, anos, MUNICIPIOS, minimo=250)
    for ano in anos:
        tot = [0.0] * len(CATEGORIAS)
        for por_ano in cidades.values():
            for i, v in enumerate(por_ano.get(str(ano), [0, [0] * len(CATEGORIAS)])[1]):
                tot[i] += v
        soma = sum(tot) or 1
        print(f"  {ano}, todas as câmaras: " + "; ".join(f"{r} {v / 1e6:.0f} mi ({v / soma:.0%})"
                                                         for (_, r), v in zip(CATEGORIAS, tot)))
        sem = sum(1 for v in cidades.values() if str(ano) in v and v[str(ano)][1][0] <= 0)
        print(f"  {ano}: câmaras sem nenhum pagamento de subsídio: {sem}")
    comum.gravar_json(DESTINO, {
        "uf": "PR",
        "versao": VERSAO_DA_CONTA,
        "tribunal": "Tribunal de Contas do Estado do Paraná",
        "atualizado": agora.strftime("%Y-%m-%d"),
        "fonte": FONTE,
        "arquivos": dict(sorted(arquivos.items())),
        "anos": anos,
        "categorias": [list(c) for c in CATEGORIAS],
        "cidades": {cod: dict(sorted(v.items())) for cod, v in sorted(cidades.items()) if any(str(a) in v for a in anos)},
        "fora": {cod: dict(sorted(v.items())) for cod, v in sorted(fora.items()) if any(str(a) in v for a in anos)},
    })
    print(f"gravado {DESTINO}: {len(cidades)} câmaras, {len(fora)} fora")


if __name__ == "__main__":
    main()
