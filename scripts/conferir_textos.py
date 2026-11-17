#!/usr/bin/env python3
"""Confere se as regras escritas à mão no site continuam iguais às das fontes.

A página Entenda (site/entenda.html) explica o Bolsa Família e o BPC com
valores tirados das páginas oficiais do MDS e do INSS. Esses valores só
mudam por decreto ou lei, sem aviso. Esta conferência baixa as páginas e
procura cada valor usado no site; se algum sumiu (a regra mudou ou a página
foi reescrita), termina com erro, e a tarefa do GitHub falha: é o sinal para
reler a fonte e atualizar o texto. O salário mínimo e o limite do BPC não
estão aqui, porque o site já os calcula pela série oficial do Banco Central.

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
    if problemas:
        print("\nRegras a reler e, se mudaram, atualizar em site/entenda.html:")
        for p in problemas:
            print(f" - {p}")
        sys.exit(1)
    print("\nTudo igual às fontes.")


if __name__ == "__main__":
    main()
