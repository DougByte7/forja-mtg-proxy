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

O MAYBEBOARD E O SIDEBOARD são o segundo miolo, e pelo mesmo motivo ao
contrário: eles existem pra NÃO participar, e o jeito de essa promessa
quebrar é silencioso. Maybeboard que entra na cotação cobra do jogador uma
carta que ele estava só namorando; sideboard que entra na conta das 100
deixa o contador acusando "5 cartas além das 100" pra sempre num deck legal.
Nenhum dos dois erros aparece na tela como erro — aparecem como um número
errado que parece certo.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_decks.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-decks-")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
# As rotas das versões pedem conta. O `app.main` é importado mais de uma vez
# neste arquivo, e os dois valores são lidos no primeiro import: sem o
# SESSAO_SEGURA desligado o cookie não é gravado em http://testserver.
os.environ["SENHA_ITERACOES"] = "1000"
os.environ["SESSAO_SEGURA"] = "0"

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
       [{"nome": "Sol Ring", "quantidade": 3, "categoria": ""}])
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

    # -------------------------------------------- categorias e maybeboard
    print("\n--- categorias, sideboard e maybeboard ---")

    eq("a categoria da carta sobrevive à limpeza",
       decks.limpar_cartas([{"nome": "Sol Ring", "quantidade": 1,
                             "categoria": "Combo principal"}]),
       [{"nome": "Sol Ring", "quantidade": 1, "categoria": "Combo principal"}])
    # Juntar duas linhas da mesma carta não pode inventar uma categoria:
    # vale a primeira que tinha uma.
    eq("ao juntar linhas repetidas vale a primeira categoria",
       decks.limpar_cartas([{"nome": "Sol Ring", "quantidade": 1,
                             "categoria": "Combo principal"},
                            {"nome": "sol ring", "quantidade": 1,
                             "categoria": "Rampa"}]),
       [{"nome": "Sol Ring", "quantidade": 2, "categoria": "Combo principal"}])
    eq("categoria em branco na primeira linha cede pra da segunda",
       decks.limpar_cartas([{"nome": "Sol Ring", "quantidade": 1},
                            {"nome": "sol ring", "quantidade": 1,
                             "categoria": "Rampa"}]),
       [{"nome": "Sol Ring", "quantidade": 2, "categoria": "Rampa"}])

    eq("categoria repetida (mesmo com caixa diferente) entra uma vez só",
       decks.limpar_categorias(["Sac outlet", "SAC OUTLET", " "]),
       ["Sac outlet"])
    # Categoria usada por uma carta e ausente da lista viraria grupo órfão na
    # tela: com cartas dentro e sem jeito de renomear nem apagar.
    eq("categoria que só as cartas conhecem é recolhida",
       decks.limpar_categorias([], [{"nome": "x", "categoria": "Sac outlet"}]),
       ["Sac outlet"])
    eq("Sideboard não entra na lista das feitas à mão",
       decks.limpar_categorias(["Sideboard", "Combo"]), ["Combo"])
    eq("categoria vazia é guardada mesmo sem carta nenhuma",
       decks.limpar_categorias(["Ainda vazia"]), ["Ainda vazia"])

    # A regra que o sideboard traz, e a única: fora da conta das 100.
    cem = [{"nome": "Forest", "quantidade": 99}]
    eq("deck de 100 com sideboard continua completo",
       decks.validar(["Atraxa"], cem + [
           {"nome": "Sol Ring", "quantidade": 1, "categoria": "Sideboard"}]
       )["total"], 100)
    check("carta em categoria à mão continua contando pras 100",
          decks.validar(["Atraxa"], cem + [
              {"nome": "Sol Ring", "quantidade": 1,
               "categoria": "Combo principal"}])["total"] == 101)
    # Fora da CONTA, não fora das REGRAS: uma carta guardada pra trocar
    # depois precisa caber no deck em que vai entrar.
    check("sideboard fora da identidade continua sendo acusado",
          "identidade" in tipos_de(decks.validar(["Atraxa"], [
              {"nome": "Lightning Bolt", "quantidade": 1,
               "categoria": "Sideboard"}])))

    guardado = decks.criar("Com dúvida", ["Atraxa"],
                           [{"nome": "Sol Ring", "quantidade": 1}],
                           [{"nome": "Forest", "quantidade": 2}],
                           ["Combo principal"])
    relido = decks.obter(guardado["id"])
    eq("o maybeboard volta do banco",
       relido["maybeboard"],
       [{"nome": "Forest", "quantidade": 2, "categoria": ""}])
    eq("as categorias voltam do banco", relido["categorias"], ["Combo principal"])
    # O que a pessoa mais nota se quebrar: o maybeboard entrando no preço.
    eq("o maybeboard não entra na cotação",
       [c["nome"] for c in decks.para_cotacao(relido)], ["Atraxa", "Sol Ring"])
    eq("o maybeboard não entra na lista de impressão",
       decks.lista_texto(relido), "1 Atraxa\n1 Sol Ring")
    eq("o maybeboard não conta pras 100",
       decks.validar(relido["comandantes"], relido["cartas"])["total"], 2)
    eq("o maybeboard volta resolvido em carta",
       [e["carta"]["nome"] for e in decks.com_cartas(relido)["maybeboard_completo"]],
       ["Forest"])
    copia = decks.duplicar(guardado["id"])
    eq("a cópia leva o maybeboard", copia["maybeboard"], relido["maybeboard"])
    eq("a cópia leva as categorias", copia["categorias"], relido["categorias"])
    decks.apagar(guardado["id"])
    decks.apagar(copia["id"])

    # O sideboard é o oposto do maybeboard aqui: ele é carta que a pessoa
    # quer ter, então entra no preço e na impressão.
    com_side = {"nome": "x", "comandantes": ["Atraxa"], "cartas": [
        {"nome": "Sol Ring", "quantidade": 1},
        {"nome": "Forest", "quantidade": 1, "categoria": "Sideboard"}]}
    eq("o sideboard entra na cotação",
       [c["nome"] for c in decks.para_cotacao(com_side)],
       ["Atraxa", "Sol Ring", "Forest"])
    eq("cartas_contadas tira o sideboard e mais nada",
       [c["nome"] for c in decks.cartas_contadas(com_side)], ["Sol Ring"])

    # ---------------------------------------------------------- persistência
    print("\n--- guardar, reler, duplicar ---")

    deck = decks.criar("Meu Atraxa", ["Atraxa"],
                       [{"nome": "Sol Ring", "quantidade": 1}])
    eq("id do deck tem 12 dígitos", len(deck["id"]), 12)
    relido = decks.obter(deck["id"])
    eq("o que salvou é o que volta",
       (relido["nome"], relido["comandantes"], relido["cartas"]),
       ("Meu Atraxa", ["Atraxa"],
        [{"nome": "Sol Ring", "quantidade": 1, "categoria": ""}]))

    decks.salvar(deck["id"], "Outro nome", ["Atraxa"],
                 [{"nome": "Forest", "quantidade": 9}])
    depois = decks.obter(deck["id"])
    eq("salvar troca o deck inteiro",
       (depois["nome"], depois["cartas"]),
       ("Outro nome", [{"nome": "Forest", "quantidade": 9, "categoria": ""}]))
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


    # ------------------------------------------------------- custo do combo
    print("\n--- peças e custo dos combos ---")

    # O Spellbook manda só o NOME de cada peça. A tela precisa de mais três
    # coisas, e todas saem da base local: a arte (pra prévia no hover), o
    # preço (pra dizer quanto custa fechar) e se a carta sequer existe aqui —
    # sem isso o botão "+ Fulano" some pra carta que não dá pra adicionar.
    conn = cartas._conn()
    conn.execute("UPDATE cartas SET preco_usd = 5.5 WHERE nome = 'Sol Ring'")
    conn.execute("UPDATE cartas SET preco_usd = 2.0 WHERE nome = 'Llanowar Elves'")
    conn.execute("UPDATE cartas SET preco_usd = NULL WHERE nome = 'Krenko'")
    conn.commit()
    conn.close()

    def peca(nome, no_deck):
        return {"nome": nome, "quantidade": 1, "comandante": False,
                "no_deck": no_deck}

    achado = decks.combos_com_cartas({
        "no_deck": [{"pecas": [peca("Sol Ring", True),
                               peca("Llanowar Elves", True)]}],
        "faltando_uma": [
            {"pecas": [peca("Sol Ring", True), peca("Llanowar Elves", False)]},
            # A que falta é a que a base não conhece: o custo pra fechar é
            # zero E desconhecido ao mesmo tempo, e são coisas diferentes.
            {"pecas": [peca("Sol Ring", True), peca("Krenko", False)]},
            {"pecas": [peca("Sol Ring", True), peca("Carta Fantasma", False)]},
        ],
    })

    fechado = achado["no_deck"][0]
    eq("a peça ganha a arte da base local",
       fechado["pecas"][0]["imagem"], "http://exemplo/arte.jpg")
    eq("a peça ganha o tipo", fechado["pecas"][1]["tipo"], "Creature — Elf")
    eq("custo do combo fechado é a soma das peças", fechado["custo_usd"], 7.5)
    eq("combo fechado não tem nada a pagar", fechado["custo_faltando_usd"], 0.0)

    falta_uma = achado["faltando_uma"][0]
    eq("custo total conta as duas peças", falta_uma["custo_usd"], 7.5)
    # É este o número que decide o clique: não interessa quanto o combo
    # inteiro vale, interessa quanto falta gastar.
    eq("custo pra fechar conta só o que falta",
       falta_uma["custo_faltando_usd"], 2.0)

    sem_preco = achado["faltando_uma"][1]
    check("peça que existe na base é marcada como tal",
          sem_preco["pecas"][0]["na_base"] is True)
    eq("peça sem preço na base não vira zero", sem_preco["pecas"][1]["preco_usd"], None)
    # As duas contagens existem separadas por isto: o total do combo é
    # confiável (só a peça que falta é desconhecida), o custo pra fechar não.
    # Uma contagem só não distinguiria os dois, e a tela mostraria
    # "fechar por US$ 0,00" — a mentira mais cara que ela saberia contar.
    eq("conta as peças sem preço no combo inteiro",
       sem_preco["pecas_sem_preco"], 1)
    eq("e conta separado as que faltam e não têm preço",
       sem_preco["pecas_faltando_sem_preco"], 1)
    eq("custo pra fechar fica zero quando o que falta não tem preço",
       sem_preco["custo_faltando_usd"], 0.0)

    fantasma = achado["faltando_uma"][2]
    # Carta que a base não conhece é o caso do botão desabilitado: sem a
    # carta local não há o que adicionar num clique.
    check("peça que a base não conhece é marcada",
          fantasma["pecas"][1]["na_base"] is False)
    eq("peça desconhecida não tem arte", fantasma["pecas"][1]["imagem"], "")

    # -------------------------------------------------------------- resumo
    print("\n--- resumo pra página de decks ---")

    # A regra que faz esta seção existir: o cartão da lista e o contador do
    # deckbuilder têm que dizer o MESMO número pro mesmo deck. São duas contas
    # em dois arquivos, e divergir é o tipo de erro que ninguém percebe até
    # alguém conferir na mão.
    d1 = decks.criar("Primeiro", ["Atraxa"], [
        {"nome": "Sol Ring", "quantidade": 1},
        {"nome": "Forest", "quantidade": 30},
        {"nome": "Lightning Bolt", "quantidade": 2, "categoria": "Sideboard"},
    ], maybeboard=[{"nome": "Llanowar Elves", "quantidade": 3}])
    d2 = decks.criar("Segundo", ["Krenko"])

    r = decks.resumo([d2["id"], d1["id"]])
    eq("a ordem de saída é a de entrada",
       [d["id"] for d in r], [d2["id"], d1["id"]])

    um = next(d for d in r if d["id"] == d1["id"])
    # 1 comandante + 1 Sol Ring + 30 Forest. Os 2 do sideboard ficam fora,
    # exatamente como em `validar`.
    eq("conta as mesmas 100 que a validação", um["total"], 32)
    eq("e a validação concorda",
       decks.validar(["Atraxa"], [
           {"nome": "Sol Ring", "quantidade": 1},
           {"nome": "Forest", "quantidade": 30},
           {"nome": "Lightning Bolt", "quantidade": 2, "categoria": "Sideboard"},
       ])["total"], um["total"])
    eq("faltam bate com o total", um["faltam"], 100 - 32)
    eq("o maybeboard é contado à parte, não no total", um["talvez"], 3)
    eq("distintas conta as linhas, sideboard incluído", um["distintas"], 3)
    eq("a identidade sai dos comandantes", um["identidade"], "WUBG")
    check("a arte do comandante vem junto", bool(um["arte"]))

    # Deck apagado no meio da lista não pode derrubar os outros: quem chama é
    # a lista do navegador, que envelhece sozinha.
    r2 = decks.resumo([d1["id"], "naoexisteid", d2["id"]])
    eq("id inexistente sai calado, sem derrubar o resto",
       [d["id"] for d in r2], [d1["id"], d2["id"]])

    # Nenhum caminho daqui pode significar "todos": sem dono, isso seria os
    # decks de todo mundo.
    eq("lista vazia devolve lista vazia, nunca todos", decks.resumo([]), [])
    eq("lista só de ids inválidos também", decks.resumo([None, ""]), [])

    # Deck sem comandante escolhido: a capa da tela precisa saber a diferença
    # entre "não tem comandante" e "a base não conhece o que está lá".
    d3 = decks.criar("Sem líder", [], [{"nome": "Sol Ring", "quantidade": 1}])
    orfao = decks.resumo([d3["id"]])[0]
    eq("deck sem comandante não inventa arte", orfao["arte"], "")
    eq("nem identidade", orfao["identidade"], "")
    eq("mas conta as cartas que tem", orfao["total"], 1)

    # ----------------------------------------------------------- a rota
    print("\n--- a rota do resumo ---")

    try:
        from fastapi.testclient import TestClient
    except ImportError:
        print("PULADO: fastapi não está instalado")
    else:
        os.chdir(RAIZ)
        from app.main import app

        cliente = TestClient(app)
        resp = cliente.post("/decks/resumo",
                            json={"ids": [d1["id"], "naoexisteid"]})
        eq("responde 200", resp.status_code, 200)
        corpo = resp.json()
        eq("devolve os que existem", [d["id"] for d in corpo["decks"]], [d1["id"]])
        eq("e separa os que não existem", corpo["desconhecidos"], ["naoexisteid"])

        eq("corpo que não é lista vira 400, não 500",
           cliente.post("/decks/resumo", json={"ids": "abc"}).status_code, 400)
        eq("sem `ids` também",
           cliente.post("/decks/resumo", json={}).status_code, 400)
        # Truncar esconderia decks sem dizer; recusar é honesto.
        eq("mais que o teto é recusado, não truncado",
           cliente.post("/decks/resumo",
                        json={"ids": ["x"] * (decks.MAX_RESUMO + 1)}).status_code, 400)
        eq("no teto exato ainda passa",
           cliente.post("/decks/resumo",
                        json={"ids": ["x"] * decks.MAX_RESUMO}).status_code, 200)

        # A armadilha da ordem de rota: `/decks/resumo` declarado depois do
        # `/decks/{deck_id}` viraria "o deck de id resumo", em silêncio.
        eq("GET /decks/resumo não é confundido com um deck chamado 'resumo'",
           cliente.get("/decks/resumo").status_code, 404)

        eq("a página /meus-decks é servida", cliente.get("/meus-decks").status_code, 200)

    # ------------------------------------------------------------- versões
    print("\n--- versões ---")

    # Um banco de antes das versões: a tabela sem a coluna `versao` e sem a
    # tabela de fotografias. O deck que já existia tem que abrir WIP.
    antigo = os.path.join(TMP, "antigo.db")
    conn = sqlite3.connect(antigo)
    conn.execute("CREATE TABLE decks (id TEXT PRIMARY KEY, nome TEXT, "
                 "comandantes TEXT, cartas TEXT, maybeboard TEXT, categorias "
                 "TEXT, criado_em REAL, atualizado_em REAL, dono TEXT)")
    conn.execute("INSERT INTO decks VALUES ('velho0000001', 'Velho', "
                 "'[\"Atraxa\"]', '[]', '[]', '[]', 1, 1, NULL)")
    conn.commit()
    conn.close()
    caminho_de_verdade = decks.DB_PATH
    decks.DB_PATH = antigo
    try:
        eq("banco antigo: deck lido antes da migração é WIP",
           decks.obter("velho0000001")["versao"], None)
        eq("e a situação dele também",
           decks.situacao_da_versao(decks.obter("velho0000001"))["atual"], None)
        decks.init_db()
        eq("depois da migração continua WIP",
           decks.resumo(["velho0000001"])[0]["versao"], None)
    finally:
        decks.DB_PATH = caminho_de_verdade

    def cem(**trocas):
        """Atraxa + 99 cartas legais: 99 Forest, menos o que `trocas` põe."""
        cartas_ = [{"nome": nome, "quantidade": q, "categoria": cat}
                   for nome, (q, cat) in trocas.items()]
        usadas = sum(q for q, cat in trocas.values() if cat != "Sideboard")
        return [{"nome": "Forest", "quantidade": 99 - usadas}] + cartas_

    wip = decks.criar("WIP", ["Atraxa"], [{"nome": "Forest", "quantidade": 40}])
    eq("deck novo nasce WIP", wip["versao"], None)
    eq("a situação do WIP não tem versão", decks.situacao_da_versao(wip)["atual"], None)
    try:
        decks.concluir_versao(wip["id"])
        check("WIP com lista inválida não vira v0", False, "(concluiu)")
    except decks.VersaoRecusada as e:
        check("WIP com lista inválida não vira v0", True)
        check("e a recusa diz o que falta", "Faltam 59" in str(e), str(e))
    eq("recusada, não sobra versão nenhuma", decks.historico(wip)["versoes"], [])
    eq("concluir deck que não existe devolve None",
       decks.concluir_versao("naoexiste123"), None)

    vd = decks.criar("Versionado", ["Atraxa"], cem(), maybeboard=[
        {"nome": "Sol Ring", "quantidade": 1}])
    eq("lista válida vira v0", decks.concluir_versao(vd["id"]), 0)
    eq("o deck guarda o número", decks.obter(vd["id"])["versao"], 0)
    eq("o cartão da lista também", decks.resumo([vd["id"]])[0]["versao"], 0)
    situ = decks.situacao_da_versao(decks.obter(vd["id"]))
    eq("logo depois de concluir, nada mudou",
       (situ["atual"], situ["mudou"]), (0, False))

    try:
        decks.concluir_versao(vd["id"])
        check("lista igual à última não vira versão", False, "(concluiu)")
    except decks.VersaoRecusada as e:
        check("lista igual à última não vira versão", "v0" in str(e), str(e))

    # O que não é a lista da mesa: categoria própria, maybeboard, ordem.
    decks.salvar(vd["id"], "Renomeado", ["Atraxa"],
                 list(reversed(cem(**{"Llanowar Elves": (1, "Ramp")}))),
                 maybeboard=[], categorias=["Ramp"])
    decks.salvar(vd["id"], "Renomeado", ["Atraxa"],
                 cem(**{"Llanowar Elves": (1, "Outra categoria")}),
                 maybeboard=[{"nome": "Island", "quantidade": 3}])
    situ = decks.situacao_da_versao(decks.obter(vd["id"]))
    eq("trocar uma Forest por Elves conta 1 entrou e 1 saiu",
       (situ["mudou"], situ["entraram"], situ["sairam"]), (True, 1, 1))
    decks.concluir_versao(vd["id"])
    decks.salvar(vd["id"], "Renomeado", ["Atraxa"],
                 list(reversed(cem(**{"Llanowar Elves": (1, "Ramp")}))),
                 maybeboard=[])
    check("categoria própria, maybeboard e ordem não mudam a lista",
          not decks.situacao_da_versao(decks.obter(vd["id"]))["mudou"])

    # Sol Ring entra no sideboard e Elves vai pra lá também.
    decks.salvar(vd["id"], "Renomeado", ["Atraxa"],
                 cem(**{"Llanowar Elves": (1, "Sideboard"),
                        "Sol Ring": (1, "Sideboard")}))
    hist = decks.historico(decks.obter(vd["id"]))
    pend = hist["pendente"]
    eq("pendente: o que entrou, por zona",
       [(c["zona"], c["nome"], c["quantidade"]) for c in pend["entraram"]],
       [("deck", "Forest", 1), ("side", "Llanowar Elves", 1),
        ("side", "Sol Ring", 1)])
    eq("pendente: o que saiu",
       [(c["zona"], c["nome"], c["quantidade"]) for c in pend["sairam"]],
       [("deck", "Llanowar Elves", 1)])
    check("cada linha traz a carta pra prévia",
          pend["entraram"][2]["carta"]["nome"] == "Sol Ring")
    eq("v2 sai da lista nova", decks.concluir_versao(vd["id"]), 2)

    # Depois da v0 a validação não trava: só o WIP precisa de lista válida.
    decks.salvar(vd["id"], "Renomeado", ["Atraxa"],
                 [{"nome": "Forest", "quantidade": 50}])
    eq("depois da v0, lista incompleta ainda vira versão",
       decks.concluir_versao(vd["id"]), 3)

    hist = decks.historico(decks.obter(vd["id"]))
    eq("histórico da mais nova pra mais antiga",
       [v["numero"] for v in hist["versoes"]], [3, 2, 1, 0])
    eq("atual é a última", hist["atual"], 3)
    eq("a v0 não tem diferença", hist["versoes"][-1]["diferenca"], None)
    eq("o total da versão é o das 100", hist["versoes"][-1]["total"], 100)
    eq("a v1 diz o que trocou",
       ([c["nome"] for c in hist["versoes"][2]["diferenca"]["entraram"]],
        [c["nome"] for c in hist["versoes"][2]["diferenca"]["sairam"]]),
       (["Llanowar Elves"], ["Forest"]))
    eq("sem mudança desde a última, nada pendente", hist["pendente"], None)

    copia = decks.duplicar(vd["id"])
    eq("a cópia nasce WIP", copia["versao"], None)
    eq("e sem histórico", decks.historico(copia)["versoes"], [])

    decks.apagar(vd["id"])
    conn = sqlite3.connect(decks.DB_PATH)
    eq("apagar o deck leva as versões junto",
       conn.execute("SELECT COUNT(*) FROM deck_versoes WHERE deck_id=?",
                    (vd["id"],)).fetchone()[0], 0)
    conn.close()

    print("\n--- as rotas das versões ---")
    try:
        from fastapi.testclient import TestClient
    except ImportError:
        print("PULADO: fastapi não está instalado")
    else:
        os.chdir(RAIZ)
        from app import usuarios
        from app.main import app

        # Gravar deck pede conta (ver `test_login.py`); aqui a conta é só o
        # ingresso pras rotas das versões.
        usuarios.init_db()
        usuarios.criar("montador", "senha-do-montador")
        cliente = TestClient(app)
        cliente.post("/conta/entrar",
                     json={"login": "montador", "senha": "senha-do-montador"})
        rd = decks.criar("Pela rota", ["Atraxa"], cem())
        resp = cliente.put(f"/decks/{rd['id']}", json={
            "nome": "Pela rota", "comandantes": ["Atraxa"], "cartas": cem()})
        eq("o autosave diz que o deck é WIP", resp.json()["versao"]["atual"], None)

        resp = cliente.post(f"/decks/{rd['id']}/versoes")
        eq("concluir responde 200", resp.status_code, 200)
        corpo = resp.json()
        eq("com a situação nova", corpo["versao"]["atual"], 0)
        eq("e o histórico junto", [v["numero"] for v in corpo["historico"]["versoes"]], [0])
        eq("o deck da resposta traz o número", corpo["deck"]["versao"], 0)

        resp = cliente.post(f"/decks/{rd['id']}/versoes")
        eq("lista igual vira 409", resp.status_code, 409)
        check("com o motivo", "igual" in resp.json()["detail"], resp.json())

        eq("GET do histórico", cliente.get(f"/decks/{rd['id']}/versoes")
           .json()["atual"], 0)
        eq("histórico de deck que não existe é 404",
           cliente.get("/decks/naoexiste123/versoes").status_code, 404)
        eq("concluir deck que não existe é 404",
           cliente.post("/decks/naoexiste123/versoes").status_code, 404)

        eq("sem conta não conclui versão",
           TestClient(app).post(f"/decks/{rd['id']}/versoes").status_code, 401)
        decks.definir_dono(rd["id"], "alguem")
        eq("deck de outra pessoa: não conclui versão",
           cliente.post(f"/decks/{rd['id']}/versoes").status_code, 403)

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
