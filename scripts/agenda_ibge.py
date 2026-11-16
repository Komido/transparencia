#!/usr/bin/env python3
"""Próximas divulgações do IBGE que mudam números do site.

Fonte oficial: API de calendário do IBGE
  https://servicodados.ibge.gov.br/api/v3/calendario/?qtd=500&de=MM-DD-AAAA&ate=MM-DD-AAAA

Fica só o que o site usa: IPCA, INPC e PNAD Contínua mensal (desemprego e
renda). A data de divulgação vem como "DD/MM/AAAA HH:MM:SS"; o site mostra só
o dia. O arquivo não guarda a data da busca, para só mudar quando a agenda
mudar.

Uso: python3 scripts/agenda_ibge.py calendario.json site/dados/agenda.json

Se a resposta não tiver o formato esperado, o script falha sem gravar; vale a
versão anterior.
"""

import datetime as dt
import json
import os
import re
import sys

FONTE = "https://servicodados.ibge.gov.br/api/v3/calendario/"

# Título exato no calendário -> (chave, nome para o leitor, seção do site).
PRODUTOS = {
    "Índice Nacional de Preços ao Consumidor Amplo": ("ipca", "Inflação oficial (IPCA)", "#hoje"),
    "Índice Nacional de Preços ao Consumidor": ("inpc", "Inflação das famílias de menor renda (INPC), usada no reajuste do salário mínimo", "#salario"),
    "Pesquisa Nacional por Amostra de Domicílios Contínua Mensal": ("pnad", "Desemprego e renda de quem trabalha (PNAD Contínua)", "#hoje"),
}


def falhar(mensagem):
    print(f"ERRO: {mensagem}", file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) != 3:
        falhar("uso: agenda_ibge.py calendario.json destino.json")
    with open(sys.argv[1], encoding="utf-8") as fh:
        d = json.load(fh)
    itens = d.get("items") if isinstance(d, dict) else None
    if not isinstance(itens, list):
        falhar("resposta sem a lista 'items'")
    if isinstance(d.get("totalPages"), int) and d["totalPages"] > 1:
        falhar(f"resposta em {d['totalPages']} páginas; aumente qtd")
    saida = []
    for i in itens:
        titulo = (i.get("titulo") or "").strip()
        if titulo not in PRODUTOS:
            continue
        m = re.match(r"^(\d{2})/(\d{2})/(\d{4})", i.get("data_divulgacao") or "")
        if not m:
            falhar(f"data fora do formato em {titulo}: {i.get('data_divulgacao')}")
        data = dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        chave, nome, secao = PRODUTOS[titulo]
        saida.append({"data": data.isoformat(), "produto": chave, "nome": nome, "secao": secao})
    saida.sort(key=lambda x: (x["data"], x["produto"]))
    vistos = set()
    unicos = []
    for x in saida:
        if (x["data"], x["produto"]) not in vistos:
            vistos.add((x["data"], x["produto"]))
            unicos.append(x)
    if not any(x["produto"] == "ipca" for x in unicos):
        falhar("nenhuma divulgação do IPCA no período; calendário incompleto?")
    destino = sys.argv[2]
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    with open(destino, "w", encoding="utf-8") as fh:
        json.dump({"fonte": FONTE, "itens": unicos}, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"{len(unicos)} divulgações gravadas em {destino}")


if __name__ == "__main__":
    main()
