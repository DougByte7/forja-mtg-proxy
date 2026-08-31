"""
Confere a leitura da decklist do XML do MPC Fill e a escolha de preço.

Motivo de existir: a parte frágil do cotador é o scraping, que quebra sozinho
quando o site muda de layout — testar aquilo dá teste que falha por motivo
errado. Já a matemática (quem é a oferta mais barata, quanto dá o total,
o que fazer quando uma carta não aparece) tem que estar certa
independentemente de onde o preço veio, e é isso que este arquivo trava.

Não precisa de pytest nem de rede — as ofertas são inventadas aqui mesmo.
Rode de dentro da raiz do projeto:

    python tests/test_cotacao.py

Sai com código 1 se qualquer checagem falhar.
"""
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from app import calc  # noqa: E402
from app.cotacao import (Oferta, comparar, cotar, e_basica,  # noqa: E402
                         escolher_oferta, filtrar_cotaveis, normalizar_nome)

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado, f"(obtido {obtido!r}, esperado {esperado!r})"
          if obtido != esperado else "")


# --------------------------------------------------------------------------
# Leitura da decklist a partir do XML do MPC Fill
# --------------------------------------------------------------------------
XML = """<?xml version="1.0" encoding="UTF-8"?>
<order>
  <details><quantity>7</quantity></details>
  <fronts>
    <card><id>aaa</id><slots>0,1,2,3</slots><query>lightning bolt</query>
          <name>Lightning Bolt (Beta).png</name></card>
    <card><id>bbb</id><slots>4</slots><query>sol ring</query>
          <name>Sol Ring.png</name></card>
    <card><id>ccc</id><slots>5</slots><query>  Sol   Ring  </query>
          <name>Sol Ring (outra arte).png</name></card>
    <card><id>ddd</id><slots>6</slots><query></query>
          <name>Delver of Secrets.png</name></card>
  </fronts>
  <backs>
    <card><id>eee</id><slots>6</slots><query>insectile aberration</query>
          <name>Insectile Aberration.png</name></card>
  </backs>
</order>"""

lista = calc.parse_card_list(XML)

eq("XML: uma entrada por carta distinta", len(lista), 3)
# 4 slots num <card> só = 4 cópias, não 1: é o mesmo critério que o
# parse_order usa pra cobrar a impressão.
eq("XML: quantidade vem dos slots", lista[0], {"nome": "lightning bolt", "quantidade": 4})
# Duas artes diferentes da mesma carta viram uma linha só de quantidade 2.
eq("XML: mesma carta em <card> diferentes soma", lista[1],
   {"nome": "sol ring", "quantidade": 2})
# <query> vazio cai pro nome do arquivo, sem a extensão atrapalhar a busca
# não é tratada aqui de propósito — quem consome decide.
eq("XML: sem <query>, usa <name>", lista[2]["nome"], "Delver of Secrets.png")
# O verso da dupla face não é uma carta pra comprar.
check("XML: ignora os backs",
      all("aberration" not in c["nome"].lower() for c in lista))
eq("XML: ordem é a dos slots", [c["nome"] for c in lista],
   ["lightning bolt", "sol ring", "Delver of Secrets.png"])

try:
    calc.parse_card_list("<order><fronts>")
    check("XML: XML quebrado levanta ValueError", False)
except ValueError:
    check("XML: XML quebrado levanta ValueError", True)

eq("XML: sem fronts devolve lista vazia", calc.parse_card_list("<order/>"), [])


# --------------------------------------------------------------------------
# Escolha da oferta
# --------------------------------------------------------------------------
OFERTAS = [
    Oferta(loja="Loja Cara", preco=30.00, condicao="NM", quantidade=10),
    Oferta(loja="Loja Media", preco=12.00, condicao="NM", quantidade=4),
    Oferta(loja="Loja Barata", preco=9.00, condicao="NM", quantidade=1),
    Oferta(loja="Loja Detonada", preco=3.00, condicao="HP", quantidade=20),
]

eq("oferta: pega a mais barata quando 1 cópia basta",
   escolher_oferta(OFERTAS, quantidade=1).loja, "Loja Detonada")
eq("oferta: filtro de condição corta a carta destruída",
   escolher_oferta(OFERTAS, quantidade=1, condicoes_aceitas=["M", "NM"]).loja,
   "Loja Barata")
# A de R$ 9,00 tem 1 cópia; pra 4 cópias ela não resolve.
eq("oferta: prefere quem tem estoque pra quantidade pedida",
   escolher_oferta(OFERTAS, quantidade=4, condicoes_aceitas=["NM"]).loja,
   "Loja Media")
# Ninguém tem 50 — em vez de devolver nada, volta a mais barata.
eq("oferta: sem ninguém com estoque, cai na mais barata mesmo assim",
   escolher_oferta(OFERTAS, quantidade=50, condicoes_aceitas=["NM"]).loja,
   "Loja Barata")
# Estoque 0 = fonte não informou, não = esgotado.
eq("oferta: estoque 0 conta como suficiente",
   escolher_oferta([Oferta(loja="Sem Info", preco=5.0, condicao="NM",
                           quantidade=0)], quantidade=4).loja, "Sem Info")
eq("oferta: nenhuma na condição pedida devolve None",
   escolher_oferta(OFERTAS, quantidade=1, condicoes_aceitas=["M"]), None)
eq("oferta: lista vazia devolve None", escolher_oferta([], quantidade=1), None)


# --------------------------------------------------------------------------
# Cotação da decklist inteira
# --------------------------------------------------------------------------
CATALOGO = {
    "lightning bolt": [Oferta(loja="A", preco=5.00, condicao="NM", quantidade=9)],
    "sol ring": [Oferta(loja="B", preco=7.81, condicao="NM", quantidade=9)],
    "black lotus": [Oferta(loja="C", preco=250.00, condicao="SP", quantidade=1)],
    "so hp": [Oferta(loja="D", preco=1.00, condicao="HP", quantidade=9)],
}


def buscar(nome):
    if nome == "carta que explode":
        raise RuntimeError("timeout")
    if nome not in CATALOGO:
        return []
    return CATALOGO[nome]


deck = [
    {"nome": "lightning bolt", "quantidade": 4},   # 20,00
    {"nome": "sol ring", "quantidade": 1},         #  7,81
    {"nome": "black lotus", "quantidade": 1},      # 250,00
    {"nome": "carta inexistente", "quantidade": 2},
    {"nome": "carta que explode", "quantidade": 1},
    {"nome": "so hp", "quantidade": 3},
]
r = cotar(deck, buscar, condicoes_aceitas=["M", "NM", "SP"])

eq("cotação: total soma o menor preço de cada carta", r["total"], 277.81)
eq("cotação: 3 cartas cotadas", len(r["itens"]), 3)
# Ordena pelo subtotal, não pelo unitário: 4x R$ 5,00 pesa mais no bolso
# que 1x R$ 7,81, mesmo a segunda sendo a carta mais cara da lista.
eq("cotação: ordenado do subtotal maior pro menor",
   [i["nome"] for i in r["itens"]], ["black lotus", "lightning bolt", "sol ring"])
eq("cotação: subtotal = unitário x quantidade",
   [i["subtotal"] for i in r["itens"]], [250.00, 20.00, 7.81])
eq("cotação: soma as cópias, não as linhas", r["cartas_cotadas"], 6)

# Uma carta que falha não pode derrubar o resto da cotação.
faltando = {c["nome"]: c["motivo"] for c in r["nao_encontradas"]}
eq("cotação: 3 cartas ficaram de fora", len(faltando), 3)
check("cotação: carta desconhecida é sinalizada",
      "sem oferta" in faltando.get("carta inexistente", ""))
check("cotação: exceção na busca vira falha daquela carta só",
      "timeout" in faltando.get("carta que explode", ""))
check("cotação: carta só em HP é sinalizada, não some calada",
      "condição" in faltando.get("so hp", ""))
eq("cotação: conta as cópias que faltaram", r["cartas_faltando"], 6)
eq("cotação: avisa que o total não inclui frete", r["inclui_frete"], False)
eq("cotação: conta as lojas distintas", r["lojas_distintas"], 3)

eq("cotação: decklist vazia não quebra",
   cotar([], buscar)["total"], 0)

# O caminho de verdade: XML -> lista -> cotação, sem nada no meio.
ponta_a_ponta = cotar(calc.parse_card_list(XML), buscar,
                      condicoes_aceitas=["M", "NM"])
eq("ponta a ponta: XML do MPC Fill cota direto",
   ponta_a_ponta["total"], round(4 * 5.00 + 2 * 7.81, 2))


# --------------------------------------------------------------------------
# Duas fontes lado a lado
# --------------------------------------------------------------------------
CATALOGO_USD = {
    "lightning bolt": [Oferta(loja="TCGplayer", preco=0.61, condicao="NM")],
    "sol ring": [Oferta(loja="TCGplayer", preco=1.41, condicao="NM")],
    "so em dolar": [Oferta(loja="TCGplayer", preco=9.00, condicao="NM")],
}


def buscar_usd(nome):
    return CATALOGO_USD.get(nome, [])


FONTES = [
    {"id": "liga", "rotulo": "LigaMagic", "moeda": "BRL", "buscar": buscar,
     "observacao": "lojas brasileiras"},
    {"id": "scry", "rotulo": "Scryfall", "moeda": "USD", "buscar": buscar_usd},
]

deck2 = [
    {"nome": "lightning bolt", "quantidade": 4},
    {"nome": "black lotus", "quantidade": 1},   # só a fonte BRL tem
    {"nome": "so em dolar", "quantidade": 2},   # só a fonte USD tem
]
comp = comparar(deck2, FONTES, condicoes_aceitas=["M", "NM", "SP"])

eq("comparar: uma linha por carta", len(comp["linhas"]), 3)
eq("comparar: uma entrada por fonte", [f["id"] for f in comp["fontes"]],
   ["liga", "scry"])
# Cada fonte guarda o seu total, na sua moeda. Somar os dois seria misturar
# mercado e câmbio, então eles nunca aparecem somados.
eq("comparar: total da fonte BRL", comp["fontes"][0]["total"], 20.00 + 250.00)
eq("comparar: total da fonte USD", comp["fontes"][1]["total"],
   round(0.61 * 4 + 9.00 * 2, 2))
eq("comparar: moeda vai junto do total",
   [f["moeda"] for f in comp["fontes"]], ["BRL", "USD"])

linhas = {l["nome"]: l for l in comp["linhas"]}
eq("comparar: carta nas duas fontes tem os dois preços",
   [linhas["lightning bolt"]["precos"]["liga"]["preco_unitario"],
    linhas["lightning bolt"]["precos"]["scry"]["preco_unitario"]], [5.00, 0.61])
# Carta que só uma fonte tem continua na tabela, com o motivo do lado —
# sumir com ela esconderia justamente o que precisa de atenção.
check("comparar: carta só na fonte BRL aparece com erro na outra",
      "erro" in linhas["black lotus"]["precos"]["scry"]
      and "preco_unitario" in linhas["black lotus"]["precos"]["liga"])
check("comparar: carta só na fonte USD aparece com erro na outra",
      "erro" in linhas["so em dolar"]["precos"]["liga"]
      and "preco_unitario" in linhas["so em dolar"]["precos"]["scry"])
# Ordena pelo subtotal na fonte PRINCIPAL (a primeira). A carta que a
# principal não achou vai pro fim, não some.
eq("comparar: ordena pelo subtotal da fonte principal",
   [l["nome"] for l in comp["linhas"]],
   ["black lotus", "lightning bolt", "so em dolar"])
eq("comparar: conta cartas e cópias", (comp["cartas_distintas"], comp["copias_total"]),
   (3, 7))
eq("comparar: avisa que não inclui frete", comp["inclui_frete"], False)

# O progresso conta uma vez por (carta, fonte), mesmo com as fontes rodando
# em paralelo.
vistos = []
comparar(deck2, FONTES, on_progress=lambda f, t: vistos.append((f, t)))
eq("comparar: progresso conta carta x fonte", len(vistos), 6)
eq("comparar: progresso sabe o total desde o começo",
   {t for _, t in vistos}, {6})
eq("comparar: progresso não pula nem repete número",
   sorted(f for f, _ in vistos), [1, 2, 3, 4, 5, 6])

# Uma fonte que explode inteira não pode derrubar a outra.
def buscar_quebrado(nome):
    raise RuntimeError("fonte fora do ar")


meia = comparar([{"nome": "sol ring", "quantidade": 1}],
                [FONTES[0], {"id": "morta", "rotulo": "Morta", "moeda": "USD",
                             "buscar": buscar_quebrado}])
eq("comparar: fonte fora do ar não derruba a outra",
   meia["fontes"][0]["total"], 7.81)
eq("comparar: fonte fora do ar zera só o total dela",
   meia["fontes"][1]["total"], 0)
check("comparar: o motivo da fonte morta chega na linha",
      "fora do ar" in meia["linhas"][0]["precos"]["morta"]["erro"])


# --------------------------------------------------------------------------
# O que fica de fora da cotação
# --------------------------------------------------------------------------
eq("normaliza: espaço sobrando e caixa", normalizar_nome("  Sol   RING "), "sol ring")
eq("normaliza: tira acento", normalizar_nome("Planície"), "planicie")
# "Sol Ring (C17)" e "Sol Ring" são a mesma carta pra cotar; sem tirar o
# sufixo, escolher o comandante na tela não casaria com a carta no XML.
eq("normaliza: tira sufixo de edição", normalizar_nome("Sol Ring (C17)"), "sol ring")
eq("normaliza: não mexe em parêntese no meio",
   normalizar_nome("Erayo (teste) Soratami"), "erayo (teste) soratami")

for nome in ["Island", "ilha", "Plains", "Snow-Covered Forest", "Pântano",
             "Wastes", "Terra Devastada", "Forest (M21)"]:
    check(f"básica: {nome}", e_basica(nome))
for nome in ["Sol Ring", "Island Sanctuary", "Misty Rainforest", "Ilha do Tesouro"]:
    check(f"não é básica: {nome}", not e_basica(nome))

DECK_CMD = [
    {"nome": "Atraxa, Praetors' Voice", "quantidade": 1},
    {"nome": "Sol Ring", "quantidade": 1},
    {"nome": "Forest", "quantidade": 12},
    {"nome": "Ilha", "quantidade": 8},
    {"nome": "Cultivate", "quantidade": 1},
]
cotaveis, excluidas = filtrar_cotaveis(DECK_CMD, "Atraxa, Praetors' Voice")
eq("filtro: sobram só as cotáveis",
   [c["nome"] for c in cotaveis], ["Sol Ring", "Cultivate"])
eq("filtro: 20 terrenos + 1 comandante saíram",
   sum(c["quantidade"] for c in excluidas), 21)
motivos = {c["nome"]: c["motivo"] for c in excluidas}
eq("filtro: comandante marcado como tal",
   motivos["Atraxa, Praetors' Voice"], "comandante")
eq("filtro: básica em inglês marcada", motivos["Forest"], "terreno básico")
eq("filtro: básica em português marcada", motivos["Ilha"], "terreno básico")

# Sem comandante escolhido, só as básicas saem.
cotaveis2, excluidas2 = filtrar_cotaveis(DECK_CMD)
eq("filtro: sem comandante, ele fica na conta", len(cotaveis2), 3)
check("filtro: sem comandante, nenhuma exclusão por comandante",
      all(c["motivo"] == "terreno básico" for c in excluidas2))

# O casamento do comandante ignora acento, caixa e sufixo de edição — é o que
# faz o nome vindo do select bater com o nome que está no XML.
cot3, exc3 = filtrar_cotaveis(
    [{"nome": "Ghired, Conclave Exile", "quantidade": 1}],
    "  ghired,   conclave exile (C19)  ")
eq("filtro: comandante casa apesar de caixa/espaço/sufixo", cot3, [])
eq("filtro: e sai marcado", exc3[0]["motivo"], "comandante")

# Comandante que não está no deck não tira nada nem quebra.
cot4, exc4 = filtrar_cotaveis([{"nome": "Sol Ring", "quantidade": 1}], "Não Existe")
eq("filtro: comandante fora do deck não tira nada", len(cot4), 1)
eq("filtro: e não inventa exclusão", exc4, [])

eq("filtro: lista vazia não quebra", filtrar_cotaveis([]), ([], []))


print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
