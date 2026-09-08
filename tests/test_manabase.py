"""
Confere a análise de mana base.

Motivo de existir. É a única análise do deckbuilder feita aqui dentro, e o
erro típico dela não é exceção — é número plausível e errado. "Faltam 3
fontes de verde" parece certo pra qualquer deck, então um terreno de duas
cores contado como uma só, ou um custo de ativação lido como produção de
mana, passaria meses sem ninguém notar.

Três lugares onde isso mora:

1. **Que cores um terreno produz.** Sai do subtipo ("Forest Island") ou do
   texto, e só do que vem DEPOIS de "Add" — "{G}: Add {C}" não produz verde.
   "Any color" vira as cores da identidade, não as cinco.
2. **As duas regras da heurística** (terrenos pela curva, fontes pelos
   símbolos), com os pisos e os limites onde elas param de subir.
3. **As sugestões**: básico só da cor que falta e só até a vaga que sobra;
   fixador só dentro da identidade, só com duas cores que o deck pede, e
   nunca um que já está no deck.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_manabase.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-manabase-")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")

from app import cartas, decks, manabase  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def carta(nome, tipo="Creature — Elf", texto="", cmc=2.0, custo="{1}{G}",
          ident="G", preco="1.00", legal="legal"):
    """No formato que a tela consome (o que `cartas._dict` devolve)."""
    return {"nome": nome, "tipo": tipo, "texto": texto, "cmc": cmc,
            "mana_cost": custo, "identidade": ident, "preco_usd": float(preco),
            "legal": legal == "legal", "basico": "basic" in tipo.lower(),
            "imagem": "", "comandante": False, "parceiro": False,
            "ilimitada": False}


def bulk(nome, tipo, texto="", cmc=0.0, custo="", ident="", preco="1.00",
         legal="legal"):
    """No formato do bulk da Scryfall, pra semear a base."""
    return {"oracle_id": nome.lower(), "name": nome, "type_line": tipo,
            "oracle_text": texto, "cmc": cmc, "mana_cost": custo,
            "colors": list(ident), "color_identity": list(ident),
            "legalities": {"commander": legal}, "prices": {"usd": preco},
            "layout": "normal", "image_uris": {"normal": "http://x"}}


try:
    # ---------------------------------------------------- cores que produz
    print("\n--- que cores um terreno produz ---")

    def produz(tipo, texto="", identidade="WUBRG"):
        return "".join(sorted(manabase.cores_que_produz(
            carta("x", tipo=tipo, texto=texto), identidade)))

    eq("básico, pelo subtipo", produz("Basic Land — Forest"), "G")
    eq("dual, pelos dois subtipos", produz("Land — Forest Island"), "GU")
    eq("dual pelo texto", produz("Land", "{T}: Add {B} or {R}."), "BR")
    eq("tri pelo texto com vírgula",
       produz("Land", "{T}: Add {G}, {W}, or {U}."), "GUW")
    eq("custo de ativação NÃO é produção",
       produz("Land", "{G}: Add {C}{C}."), "")
    eq("só incolor não produz cor", produz("Land", "{T}: Add {C}."), "")
    eq("'any color' vira a identidade, não as cinco",
       produz("Land", "{T}: Add one mana of any color.", "BG"), "BG")
    eq("'any one color' também",
       produz("Land", "{T}: Add two mana of any one color.", "UR"), "RU")
    eq("fora da identidade é cortado",
       produz("Land — Mountain", identidade="G"), "")
    eq("híbrido no texto produz as duas",
       produz("Land", "{T}: Add {G/U}."), "GU")
    eq("frase sem 'add' não conta símbolo",
       produz("Land", "Whenever {W} is spent, draw a card."), "")

    # ---------------------------------------------------------- rampa barata
    print("\n--- rampa barata ---")

    eq("rock de custo 1 é rampa", manabase.eh_rampa_barata(
        carta("Sol Ring", "Artifact", "{T}: Add {C}{C}.", cmc=1, custo="{1}")), True)
    eq("dork de custo 1 é rampa", manabase.eh_rampa_barata(
        carta("Birds", "Creature — Bird", "{T}: Add one mana of any color.",
              cmc=1, custo="{G}")), True)
    eq("rock de custo 3 não conta", manabase.eh_rampa_barata(
        carta("Lantern", "Artifact", "{T}: Add one mana of any color.",
              cmc=3, custo="{3}")), False)
    eq("terreno não é rampa", manabase.eh_rampa_barata(
        carta("Forest", "Basic Land — Forest")), False)
    eq("feitiço de busca de terreno não conta (não 'adiciona')",
       manabase.eh_rampa_barata(carta("Cultivate", "Sorcery",
                                      "Search your library for two basic lands.",
                                      cmc=3, custo="{2}{G}")), False)

    # ------------------------------------------------------ as duas regras
    print("\n--- terrenos pela curva ---")

    eq("curva 3,2 sem rampa dá 36", manabase.terrenos_recomendados(3.2, 0), 36)
    eq("curva 4,0 sobe", manabase.terrenos_recomendados(4.0, 0), 39)
    eq("curva 2,5 desce", manabase.terrenos_recomendados(2.5, 0), 33)
    eq("cada rampa barata vale meio terreno",
       manabase.terrenos_recomendados(3.2, 4), 34)
    eq("rampa tem teto de quatro terrenos",
       manabase.terrenos_recomendados(3.2, 20), 32)
    eq("nunca passa de 40", manabase.terrenos_recomendados(9.0, 0), 40)
    eq("nunca fica abaixo de 32", manabase.terrenos_recomendados(1.0, 20), 32)

    print("\n--- fontes pelos símbolos ---")

    eq("híbrido divide o peso", manabase.pips_de("{G/U}{G/U}{2}"),
       {"W": 0, "U": 1.0, "B": 0, "R": 0, "G": 1.0})
    eq("símbolo genérico não é cor", manabase.pips_de("{3}{X}{C}")["G"], 0)

    pedidas = manabase.fontes_pedidas({"G": 30, "U": 10, "W": 0, "B": 0, "R": 0}, 36)
    eq("proporcional aos símbolos", pedidas["G"], 27)
    eq("cor com um quarto dos símbolos", pedidas["U"], 12)
    check("cor sem símbolo não pede fonte", "W" not in pedidas)

    piso = manabase.fontes_pedidas({"G": 38, "U": 2, "W": 0, "B": 0, "R": 0}, 36)
    eq("respingo (menos de 12%) tem piso 8", piso["U"], 8)
    piso2 = manabase.fontes_pedidas({"G": 30, "U": 6, "W": 0, "B": 0, "R": 0}, 36)
    eq("cor de verdade tem piso 12", piso2["U"], 12)

    # --------------------------------------------------------- a análise
    print("\n--- a análise inteira ---")

    cartas.init_db()
    conn = cartas._conn()
    conn.executemany(
        f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
        f"VALUES ({cartas._INTERROGACOES})",
        [cartas._linha(c) for c in [
            bulk("Forest", "Basic Land — Forest", "({T}: Add {G}.)", ident="G"),
            bulk("Island", "Basic Land — Island", "({T}: Add {U}.)", ident="U"),
            bulk("Swamp", "Basic Land — Swamp", "({T}: Add {B}.)", ident="B"),
            bulk("Breeding Pool", "Land — Forest Island", "", ident="GU", preco="14"),
            bulk("Hinterland Harbor", "Land",
                 "{T}: Add {G} or {U}.", ident="GU", preco="2.5"),
            bulk("Command Tower", "Land",
                 "{T}: Add one mana of any color in your commander's color identity.",
                 ident="", preco="0.5"),
            bulk("Watery Grave", "Land — Island Swamp", "", ident="BU", preco="12"),
            bulk("Sunpetal Grove", "Land", "{T}: Add {G} or {W}.", ident="GW",
                 preco="3"),
            bulk("Tomb of Yawgmoth", "Land", "{T}: Add {C}.", ident="", preco="1"),
        ]])
    conn.commit()
    conn.close()

    magia = lambda nome, custo, cmc, ident: {   # noqa: E731
        "carta": carta(nome, tipo="Instant", custo=custo, cmc=cmc, ident=ident),
        "quantidade": 1}
    terreno = lambda nome, tipo, texto="", q=1: {   # noqa: E731
        "carta": carta(nome, tipo=tipo, texto=texto, cmc=0, custo=""),
        "quantidade": q}

    deck = {
        "comandantes_completos": [carta("Thrasios", "Legendary Creature",
                                        custo="{1}{G}{U}", ident="GU")],
        "cartas_completas": [
            magia("A", "{G}{G}", 2, "G"), magia("B", "{1}{G}", 2, "G"),
            magia("C", "{2}{U}", 3, "U"), magia("D", "{3}{U}{U}", 5, "U"),
            {"carta": carta("Sol Ring", "Artifact", "{T}: Add {C}{C}.",
                            cmc=1, custo="{1}", ident=""), "quantidade": 1},
            terreno("Forest", "Basic Land — Forest", q=5),
            terreno("Island", "Basic Land — Island", q=2),
            terreno("Breeding Pool", "Land — Forest Island"),
            terreno("Command Tower", "Land",
                    "{T}: Add one mana of any color in your commander's color identity."),
        ],
    }
    a = manabase.analisar(deck, "GU", teto_usd=3)

    eq("conta os terrenos", a["terrenos"]["tem"], 9)
    eq("conta as magias (sem terreno)", a["magias"], 5)
    eq("curva média das magias", a["cmc_media"], 2.6)
    eq("Sol Ring é rampa barata", a["rampas_baratas"], 1)
    eq("terrenos recomendados batem com a regra",
       a["terrenos"]["recomendado"], manabase.terrenos_recomendados(2.6, 1))

    por_cor = {c["cor"]: c for c in a["cores"]}
    # G: Forest ×5 + Breeding Pool + Command Tower = 7. A dual conta pras duas.
    eq("dual conta como fonte das duas cores",
       (por_cor["G"]["fontes"], por_cor["U"]["fontes"]), (7, 4))
    # Símbolos: A(2G) B(1G) C(1U) D(2U) + comandante (1G 1U) = G 4, U 4.
    eq("os símbolos do comandante entram", por_cor["G"]["pips"], 4.0)
    check("déficit é pedidas menos fontes",
          por_cor["U"]["faltam"] == max(0, por_cor["U"]["pedidas"] - 4))

    print("\n--- básicos sugeridos ---")
    nomes_basicos = {b["nome"]: b["quantidade"] for b in a["basicos"]}
    check("sugere a ilha, que é a cor descoberta",
          "Island" in nomes_basicos, f"({nomes_basicos})")
    check("a carta completa vai junto pra adicionar num clique",
          all(b["carta"] for b in a["basicos"]))
    vaga = a["terrenos"]["recomendado"] - a["terrenos"]["tem"]
    check("básicos não passam da vaga que sobra",
          sum(nomes_basicos.values()) <= vaga, f"({nomes_basicos}, vaga {vaga})")

    # Deck já com os terrenos no lugar: não sugere básico nenhum.
    cheio = dict(deck)
    cheio["cartas_completas"] = deck["cartas_completas"] + [
        terreno("Island", "Basic Land — Island", q=40)]
    eq("sem vaga não sugere básico",
       manabase.analisar(cheio, "GU")["basicos"], [])

    print("\n--- fixadores ---")
    baratos = [f["nome"] for f in a["fixadores"]["baratos"]]
    caros = [f["nome"] for f in a["fixadores"]["caros"]]
    check("dual barata da identidade entra em 'baratos'",
          "Hinterland Harbor" in baratos, f"({baratos})")
    check("dual cara vai pra 'caros'", "Breeding Pool" not in baratos + caros
          or "Breeding Pool" in caros, f"({caros})")
    check("o que já está no deck não é sugerido",
          "Breeding Pool" not in baratos + caros and
          "Command Tower" not in baratos + caros, f"({baratos + caros})")
    check("terreno fora da identidade não entra",
          "Watery Grave" not in baratos + caros and
          "Sunpetal Grove" not in baratos + caros, f"({baratos + caros})")
    check("terreno de uma cor só não é fixador",
          "Tomb of Yawgmoth" not in baratos + caros)
    check("o que produz vai junto",
          all(len(f["produz"]) >= 2 for f in a["fixadores"]["baratos"]))

    eq("teto alto joga tudo em 'baratos'",
       [f["nome"] for f in manabase.analisar(deck, "GU", teto_usd=999)
        ["fixadores"]["caros"]], [])

    mono = manabase.analisar(deck, "G")
    eq("deck de uma cor é marcado", mono["monocolor"], True)
    eq("e não recebe fixador", mono["fixadores"], {"baratos": [], "caros": []})

    vazio = manabase.analisar({"cartas_completas": [], "comandantes_completos": []}, "GU")
    eq("deck vazio não explode",
       (vazio["terrenos"]["tem"], vazio["magias"], vazio["cmc_media"]), (0, 0, 0.0))

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
