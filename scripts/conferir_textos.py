#!/usr/bin/env python3
"""Confere se as regras escritas à mão no site continuam iguais às das fontes.

A página Entenda (site/entenda.html) explica o Bolsa Família e o BPC com
valores tirados das páginas oficiais do MDS e do INSS. Esses valores só
mudam por decreto ou lei, sem aviso. Esta conferência baixa as páginas e
procura cada valor usado no site; se algum sumiu (a regra mudou ou a página
foi reescrita), termina com erro, e a tarefa do GitHub falha: é o sinal para
reler a fonte e atualizar o texto. O salário mínimo e o limite do BPC não
estão aqui, porque o site já os calcula pela série oficial do Banco Central.

Também confere a composição do STF mostrada na Entenda ("Quem está no STF
hoje"): a lista de ministros da página oficial de composição atual tem de ser
a mesma do site, com o mesmo presidente e vice-presidente. Se alguém entrar
ou sair, a tarefa falha para a lista ser refeita a partir das fontes
oficiais (tabela da linha sucessória e páginas dos ministros).

Uso: python3 scripts/conferir_textos.py
"""

import html
import re
import sys
import time
import urllib.request

AGENTE = "ArrecadometroBrasil/1.0 (dados publicos; github.com/Komido/transparencia)"
MDS = "https://www.gov.br/mds/pt-br/acoes-e-programas/bolsa-familia/paginas"
INSS = "https://www.gov.br/inss/pt-br/direitos-e-deveres/beneficios-assistenciais"

# (página, o que ela sustenta no site, textos que precisam aparecer; cada
# item pode ter alternativas separadas por "|").
CONFERIR = [
    (f"{MDS}/pagamentos-e-beneficios", "Bolsa Família: valores dos benefícios",
     ["R$ 164", "R$ 173", "R$ 58", "R$ 691"]),
    (f"{MDS}/regra-de-protecao", "Bolsa Família: regra de proteção",
     ["R$ 218", "R$ 706", "18 meses"]),
    (f"{MDS}/conheca-as-regras", "Bolsa Família: quem tem direito e compromissos",
     ["R$ 218", "60%", "75%"]),
    (f"{INSS}/beneficio-assistencial-a-pessoa-idosa-bpc-loas", "BPC: pessoa idosa",
     ["65 (sessenta e cinco) anos|65 anos", "1/4 do salário mínimo|¼ do salário mínimo"]),
    (f"{INSS}/beneficio-assistencial-a-pessoa-com-deficiencia-bpc-loas", "BPC: pessoa com deficiência",
     ["2 anos", "1/4 do salário mínimo|¼ de salário mínimo|¼ do salário mínimo"]),
]


STF = ("https://portal.stf.jus.br/textos/verTexto.asp?servico=bibliotecaConsultaProdutoBibliotecaPastaMinistro"
       "&pagina=ComposicaoAtual")
# Páginas dos ministros ligadas na composição atual, como aparecem nos links.
STF_MINISTROS = {"GilmarMendes", "CarmenLucia", "DiasToffoli", "LuizFux", "EdsonFachin", "AlexandreMoraes",
                 "NunesMarques", "AndreMendonca", "CristianoZanin", "FlavioDino"}
STF_CARGOS = ["Edson Fachin (Presidente)", "Alexandre de Moraes (Vice-Presidente)"]


def conferir_stf(problemas):
    print(f"== STF: composição atual\n   {STF}")
    try:
        req = urllib.request.Request(STF, headers={"User-Agent": AGENTE})
        with urllib.request.urlopen(req, timeout=60) as resp:
            bruto = resp.read().decode("utf-8", errors="replace")
    except Exception as erro:  # noqa: BLE001
        problemas.append(f"STF: a página de composição não abriu ({erro})")
        return
    achados = set(re.findall(r"pagina=([A-Za-z]+)Principal", bruto))
    texto = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", bruto)))
    print(f"   ministros na página: {sorted(achados)}")
    if achados != STF_MINISTROS:
        problemas.append(f"STF: a composição mudou (saíram {sorted(STF_MINISTROS - achados)}, entraram {sorted(achados - STF_MINISTROS)})")
    for cargo in STF_CARGOS:
        achou = cargo in texto
        print(f"   {'ok   ' if achou else 'SUMIU'} {cargo}")
        if not achou:
            problemas.append(f"STF: não achei \"{cargo}\" em {STF}")


def texto_da_pagina(url):
    for tentativa in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE})
            with urllib.request.urlopen(req, timeout=60) as resp:
                bruto = resp.read().decode("utf-8", errors="replace")
            break
        except Exception as erro:  # noqa: BLE001 - registra e tenta de novo
            print(f"  tentativa {tentativa + 1}: {erro}")
            time.sleep(10 * (tentativa + 1))
    else:
        return None
    bruto = re.sub(r"<script.*?</script>|<style.*?</style>", " ", bruto, flags=re.S)
    texto = html.unescape(re.sub(r"<[^>]+>", " ", bruto)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", texto)


def main():
    problemas = []
    for url, assunto, esperados in CONFERIR:
        print(f"== {assunto}\n   {url}")
        texto = texto_da_pagina(url)
        if texto is None:
            problemas.append(f"{assunto}: a página não abriu ({url})")
            continue
        for esperado in esperados:
            achou = any(alt in texto for alt in esperado.split("|"))
            print(f"   {'ok   ' if achou else 'SUMIU'} {esperado}")
            if not achou:
                problemas.append(f"{assunto}: não achei \"{esperado}\" em {url}")
    conferir_stf(problemas)
    if problemas:
        print("\nRegras a reler e, se mudaram, atualizar em site/entenda.html:")
        for p in problemas:
            print(f" - {p}")
        sys.exit(1)
    print("\nTudo igual às fontes.")


if __name__ == "__main__":
    main()
