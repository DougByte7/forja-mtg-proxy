"""
Confere as regras de Commander e o guardado dos decks.

Motivo de existir: a validação é a única coisa que separa "deck montado" de
"deck que não pode ser jogado", e ela erra dos dois lados calada.

Errar pra MENOS (deixar passar carta de outra cor, ou quatro cópias da mesma
carta) entrega ao jogador um deck que só vai ser recusado na mesa. Errar pra
MAIS é pior no dia a dia: acusar singleton quebrado em 30 florestas, ou
identidade errada num terreno de duas cores, transforma a tela num alarme
que se aprende a ignorar — e aí o erro de verdade passa junto.

As exceções do formato (terreno básico, "any number of cards named", dois
comandantes com Partner) são o miolo do teste por isso.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_decks.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-decks-")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")

from app import cartas, cotacao, decks  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def tipos_de(validacao):
    """Só os tipos de apontamento, que é o que o teste compara."""
    return sorted({a["tipo"] for a in validacao["apontamentos"]})


def carta(nome, tipo="Creature — Elf", texto="", ident="G", **extra):
    return {
        "oracle_id": nome.lower(), "name": nome, "type_line": tipo,
        "oracle_text": texto, "cmc": extra.pop("cmc", 2.0),
        "mana_cost": extra.pop("custo", "{1}{G}"),
        "colors": list(ident), "color_identity": list(ident),
        "legalities": {"commander": extra.pop("legal", "legal")},
        "prices": {"usd": "1.00"}, "layout": "normal",
        "image_uris": {"normal": "http://exemplo/arte.jpg"},
    }


try:
    # Uma base de cartas de mentira, só com os casos que as regras tratam.
    cartas.init_db()
    povoar = [
        carta("Atraxa", tipo="Legendary Creature — Angel", ident="WUBG"),
        carta("Tymna the Weaver", tipo="Legendary Creature — Cleric",
              ident="WB", texto="Partner (You can have two commanders if both "
                                "have partner.)"),
        carta("Thrasios", tipo="Legendary Creature — Merfolk", ident="GU",
              texto="Partner"),
        carta("Krenko", tipo="Legendary Creature — Goblin", ident="R"),
        carta("Llanowar Elves", ident="G"),
        carta("Sol Ring", tipo="Artifact", ident="", custo="{1}"),
        carta("Lightning Bolt", tipo="Instant", ident="R", custo="{R}"),
        carta("Forest", tipo="Basic Land — Forest", ident="G", custo=""),
        carta("Island", tipo="Basic Land — Island", ident="U", custo=""),
        carta("Rat Colony", tipo="Creature — Rat", ident="B",
              texto="A deck can have any number of cards named Rat Colony."),
        carta("Black Lotus", tipo="Artifact", ident="", custo="{0}",
              legal="banned"),
    ]
    conn = cartas._conn()
    conn.executemany(
        f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
        f"VALUES ({cartas._INTERROGACOES})",
        [cartas._linha(c) for c in povoar])
    conn.commit()
    conn.close()
    decks.init_db()

    # -------------------------------------------------------------- entrada
    print("\n--- limpeza da lista que vem da tela ---")

    eq("duas linhas da mesma carta viram uma",
       decks.limpar_cartas([{"nome": "Sol Ring", "quantidade": 1},
                            {"nome": "sol ring", "quantidade": 2}]),
       [{"nome": "Sol Ring", "quantidade": 3}])
    eq("quantidade zero some",
       decks.limpar_cartas([{"nome": "Sol Ring", "quantidade": 0}]), [])
    eq("nome vazio some",
       decks.limpar_cartas([{"nome": "   ", "quantidade": 1}]), [])

    for descricao, entrada in [
        ("quantidade absurda", [{"nome": "Forest", "quantidade": 500}]),
        ("quantidade que não é número", [{"nome": "Forest", "quantidade": "muitas"}]),
        ("lista gigante", [{"nome": f"C{i}", "quantidade": 1} for i in range(401)]),
    ]:
        try:
            decks.limpar_cartas(entrada)
            check(f"{descricao} é recusada", False, "(passou)")
        except ValueError:
            check(f"{descricao} é recusada", True)

    try:
        decks.limpar_comandantes(["A", "B", "C"])
        check("três comandantes são recusados", False, "(passou)")
    except ValueError:
        check("três comandantes são recusados", True)

    # ------------------------------------------------------------ validação
    print("\n--- as regras do formato ---")

    # Deck legal: 1 comandante + 99 cartas, com básico repetido à vontade.
    legal = decks.validar(["Atraxa"], [
        {"nome": "Sol Ring", "quantidade": 1},
        {"nome": "Llanowar Elves", "quantidade": 1},
        {"nome": "Island", "quantidade": 40},
        {"nome": "Forest", "quantidade": 53},
        {"nome": "Rat Colony", "quantidade": 4},
    ])
    eq("deck de 100 cartas é legal", (legal["ok"], legal["total"]), (True, 100))
    eq("nenhum apontamento no deck legal", legal["apontamentos"], [])
    eq("identidade sai do comandante", legal["identidade"], "WUBG")

    # As duas exceções do singleton, que são o que mais dá falso positivo.
    check("40 ilhas não quebram singleton",
          "singleton" not in tipos_de(legal))
    check("4 Rat Colony não quebram singleton",
          "singleton" not in tipos_de(legal))

    # E o singleton de verdade.
    repetida = decks.validar(["Atraxa"], [{"nome": "Sol Ring", "quantidade": 2}])
    check("duas cópias de carta comum acusam singleton",
          "singleton" in tipos_de(repetida), f"({tipos_de(repetida)})")

    fora = decks.validar(["Atraxa"], [{"nome": "Lightning Bolt", "quantidade": 1}])
    check("carta vermelha em deck WUBG acusa identidade",
          "identidade" in tipos_de(fora), f"({tipos_de(fora)})")

    incolor = decks.validar(["Atraxa"], [{"nome": "Sol Ring", "quantidade": 1}])
    check("carta incolor cabe em qualquer identidade",
          "identidade" not in tipos_de(incolor))

    banida = decks.validar(["Atraxa"], [{"nome": "Black Lotus", "quantidade": 1}])
    check("carta banida acusa", "banida" in tipos_de(banida))

    repetido = decks.validar(["Atraxa"], [{"nome": "Atraxa", "quantidade": 1}])
    check("comandante repetido nas 99 acusa",
          "comandante-repetido" in tipos_de(repetido))

    sem_cmd = decks.validar([], [{"nome": "Sol Ring", "quantidade": 1}])
    check("deck sem comandante acusa", "sem-comandante" in tipos_de(sem_cmd))

    nao_lendaria = decks.validar(["Llanowar Elves"], [])
    check("criatura comum como comandante acusa",
          "comandante-invalido" in tipos_de(nao_lendaria))

    desconhecida = decks.validar(["Atraxa"], [{"nome": "Carta Inventada", "quantidade": 1}])
    check("carta fora da base é aviso, não erro",
          [a["nivel"] for a in desconhecida["apontamentos"]
           if a["tipo"] == "desconhecida"] == ["aviso"])

    # Dois comandantes: só com parceria, e a identidade é a união.
    parceiros = decks.validar(["Tymna the Weaver", "Thrasios"], [])
    check("dois parceiros são aceitos", "parceria" not in tipos_de(parceiros),
          f"({tipos_de(parceiros)})")
    eq("identidade de dois comandantes é a união",
       parceiros["identidade"], "WUBG")

    sem_parceria = decks.validar(["Atraxa", "Krenko"], [])
    check("dois comandantes sem Partner acusam",
          "parceria" in tipos_de(sem_parceria), f"({tipos_de(sem_parceria)})")

    # Contagem: os dois lados.
    eq("deck curto diz quantas faltam",
       decks.validar(["Atraxa"], [])["faltam"], 99)
    check("deck passado das 100 acusa",
          "sobram" in tipos_de(decks.validar(
              ["Atraxa"], [{"nome": "Forest", "quantidade": 99},
                           {"nome": "Sol Ring", "quantidade": 1}])))

    # ---------------------------------------------------------- persistência
    print("\n--- guardar, reler, duplicar ---")

    deck = decks.criar("Meu Atraxa", ["Atraxa"],
                       [{"nome": "Sol Ring", "quantidade": 1}])
    eq("id do deck tem 12 dígitos", len(deck["id"]), 12)
    relido = decks.obter(deck["id"])
    eq("o que salvou é o que volta",
       (relido["nome"], relido["comandantes"], relido["cartas"]),
       ("Meu Atraxa", ["Atraxa"], [{"nome": "Sol Ring", "quantidade": 1}]))

    decks.salvar(deck["id"], "Outro nome", ["Atraxa"],
                 [{"nome": "Forest", "quantidade": 9}])
    depois = decks.obter(deck["id"])
    eq("salvar troca o deck inteiro",
       (depois["nome"], depois["cartas"]),
       ("Outro nome", [{"nome": "Forest", "quantidade": 9}]))
    check("atualizado_em anda pra frente",
          depois["atualizado_em"] >= relido["atualizado_em"])

    copia = decks.duplicar(deck["id"])
    check("a cópia tem id novo", copia["id"] != deck["id"])
    eq("a cópia leva as cartas", copia["cartas"], depois["cartas"])
    eq("a cópia se identifica no nome", copia["nome"], "Outro nome (cópia)")
    check("o original não é tocado ao duplicar",
          decks.obter(deck["id"])["nome"] == "Outro nome")

    eq("deck que não existe volta None", decks.obter("naoexiste123"), None)
    eq("salvar em deck que não existe volta None",
       decks.salvar("naoexiste123", "x", [], []), None)
    eq("apagar deck que não existe é False", decks.apagar("naoexiste123"), False)
    eq("apagar apaga", decks.apagar(deck["id"]), True)
    eq("depois de apagar não volta mais", decks.obter(deck["id"]), None)

    # ------------------------------------------------------------- saídas
    print("\n--- decklist e cotação ---")

    deck = {"nome": "x", "comandantes": ["Tymna the Weaver", "Thrasios"],
            "cartas": [{"nome": "Sol Ring", "quantidade": 1},
                       {"nome": "Forest", "quantidade": 8}]}

    eq("decklist em texto, comandante primeiro",
       decks.lista_texto(deck).split("\n"),
       ["1 Tymna the Weaver", "1 Thrasios", "1 Sol Ring", "8 Forest"])

    # A cotação recebe a lista com o comandante DENTRO; quem tira é o
    # `filtrar_cotaveis`, pelo critério do Commander 500 — e com dois
    # comandantes ele tem que tirar os dois, senão o total não bate com o teto.
    lista = decks.para_cotacao(deck)
    eq("a lista pra cotação leva tudo", len(lista), 4)
    cotaveis, excluidas = cotacao.filtrar_cotaveis(lista, deck["comandantes"])
    eq("sobra só o que se compra", [c["nome"] for c in cotaveis], ["Sol Ring"])
    eq("os dois comandantes saem da conta",
       sorted(c["motivo"] for c in excluidas),
       ["comandante", "comandante", "terreno básico"])

    # O caminho antigo (um comandante em string) continua valendo.
    cotaveis, _ = cotacao.filtrar_cotaveis(
        [{"nome": "Atraxa", "quantidade": 1}, {"nome": "Sol Ring", "quantidade": 1}],
        "Atraxa")
    eq("comandante em string continua funcionando",
       [c["nome"] for c in cotaveis], ["Sol Ring"])

    # ----------------------------------------------------- cartas completas
    completo = decks.com_cartas(deck)
    eq("as cartas voltam resolvidas",
       [e["carta"]["tipo"] for e in completo["cartas_completas"]],
       ["Artifact", "Basic Land — Forest"])
    eq("os comandantes voltam resolvidos",
       [c["nome"] for c in completo["comandantes_completos"]],
       ["Tymna the Weaver", "Thrasios"])

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
