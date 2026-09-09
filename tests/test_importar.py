"""
Confere a importação de deck: link do Archidekt/Moxfield e lista colada.

Motivo de existir. A importação é a única entrada da tela em que o usuário
NÃO confere carta por carta — ele cola um link, vê "100 cartas" e confia.
Isso torna dois erros especialmente caros, e os dois são silenciosos:

1. **Misturar o que não é do deck com o deck.** Maybeboard do Archidekt e
   sideboard do Moxfield entram na mesma resposta que o mainboard. Somar
   essas cartas às 100 dá um deck de 120 que a pessoa vai ter que podar na
   mão sem saber o que sobra. Desde que o deckbuilder ganhou maybeboard elas
   não são mais descartadas — o que troca um erro por outro, mais sutil: uma
   carta que era pra estar em dúvida entrando calada nas 100, ou uma carta
   do deck caindo no maybeboard e sumindo da cotação. Por isso os testes
   daqui conferem o DESTINO de cada uma, não só a contagem.
2. **Perder o comandante.** Ele vem num lugar diferente em cada fonte (uma
   categoria no Archidekt, um tabuleiro no Moxfield, um cabeçalho ou um
   `*CMDR*` no texto). Perdê-lo não dá erro nenhum: dá um deck sem
   identidade de cor, e a tela abre perguntando "quem é o comandante?" como
   se nada tivesse sido importado.

A LISTA COLADA é onde mora a maior parte do teste, porque é onde mora a
maior parte da variedade: cada site exporta o mesmo formato com um enfeite
diferente (edição entre parênteses, número de coleção, categoria entre
colchetes, `*CMDR*`, cabeçalho de seção), e o parser tem que engolir todos
sem confundir "Creatures (23)" — que é cabeçalho — com uma carta.

Não precisa de rede nem de pytest: as duas fontes são respondidas por uma
sessão de mentira. Rode de dentro da raiz do projeto:

    python tests/test_importar.py

Sai com código 1 se qualquer checagem falhar.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-importar-")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
# Sem espera entre requisições: o freio existe pra não abusar de site de
# fora, e aqui não sai requisição nenhuma.
os.environ["IMPORTAR_DELAY_SEGUNDOS"] = "0"

from app import cartas, decks, importar  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def erro(nome, funcao, pedaco=""):
    """A chamada tem que levantar ImportarError — e dizer o porquê."""
    try:
        funcao()
    except importar.ImportarError as e:
        check(nome, pedaco in str(e).lower(),
              "" if pedaco in str(e).lower() else f"(mensagem: {e})")
    else:
        check(nome, False, "(não levantou)")


def cartas_de(resultado):
    """As cartas do deck, sem as que foram pro sideboard."""
    return [(c["nome"], c["quantidade"]) for c in resultado["cartas"]
            if not c.get("categoria")]


def sideboard_de(resultado):
    return [(c["nome"], c["quantidade"]) for c in resultado["cartas"]
            if c.get("categoria") == "Sideboard"]


def maybe_de(resultado):
    return [(c["nome"], c["quantidade"])
            for c in resultado.get("maybeboard") or []]


# --------------------------------------------------------------------------
# Respostas de mentira, no formato exato das duas APIs
# --------------------------------------------------------------------------

class RespostaFalsa:
    def __init__(self, corpo, status=200, e_json=True):
        self.status_code = status
        self._corpo = corpo
        self._e_json = e_json

    def json(self):
        if not self._e_json:
            raise ValueError("não é JSON")
        return self._corpo


class SessaoFalsa:
    """Devolve sempre a mesma resposta e guarda o que foi pedido."""

    def __init__(self, resposta):
        self.resposta = resposta
        self.pedidos = []
        self.headers = {}

    def get(self, url, timeout=None):
        self.pedidos.append(url)
        return self.resposta


def com_sessao(resposta, funcao):
    """Roda `funcao` com a rede trocada pela `resposta`. Devolve (saída, sessão)."""
    real = importar._sessao
    sessao = SessaoFalsa(resposta)
    importar._sessao = lambda user_agent="": sessao
    try:
        return funcao(), sessao
    finally:
        importar._sessao = real


def item_archidekt(nome, quantidade=1, categorias=None):
    return {
        "quantity": quantidade,
        "categories": categorias or [],
        "card": {"oracleCard": {"name": nome}},
    }


def item_moxfield(nome, quantidade=1):
    return {"quantity": quantidade, "card": {"name": nome}}


try:
    # ------------------------------------------------------------ reconhecer
    print("\n--- reconhecer o link ---")

    eq("archidekt com slug",
       importar.identificar("https://archidekt.com/decks/1585124/baby-lasagna"),
       ("archidekt", "1585124"))
    eq("archidekt sem slug",
       importar.identificar("archidekt.com/decks/42"), ("archidekt", "42"))
    eq("archidekt com âncora",
       importar.identificar("https://www.archidekt.com/decks/42#Commander"),
       ("archidekt", "42"))
    eq("moxfield",
       importar.identificar("https://www.moxfield.com/decks/j-0aJlxuOUm9FnKRvJcfZw"),
       ("moxfield", "j-0aJlxuOUm9FnKRvJcfZw"))
    # O /primer não pode virar parte do id: com ele na chave, a API responde
    # 404 e a pessoa lê "deck não encontrado" olhando pro deck aberto.
    eq("moxfield com /primer",
       importar.identificar("https://moxfield.com/decks/AbC-123/primer"),
       ("moxfield", "AbC-123"))
    erro("link de outro site é recusado com nome dos aceitos",
         lambda: importar.identificar("https://tappedout.net/mtg-decks/x/"),
         "archidekt")

    # ------------------------------------------------------------- archidekt
    print("\n--- archidekt ---")

    deck_archidekt = {
        "name": "Deck de Teste",
        "categories": [
            {"name": "Maybeboard", "includedInDeck": False},
            {"name": "Considerando", "includedInDeck": False},
            {"name": "Sideboard", "includedInDeck": False},
            {"name": "Tokens", "includedInDeck": False},
            {"name": "Rampa", "includedInDeck": True},
        ],
        "cards": [
            item_archidekt("Atraxa, Praetors' Voice", 1, ["Commander"]),
            item_archidekt("Sol Ring", 1, ["Rampa"]),
            item_archidekt("Arcane Signet", 1, []),          # categoria de sistema
            item_archidekt("Forest", 10, ["Land"]),
            item_archidekt("Blood Moon", 1, ["Maybeboard"]),  # dúvida
            item_archidekt("Mana Crypt", 1, ["Rampa", "Considerando"]),  # dúvida
            item_archidekt("Swords to Plowshares", 1, ["Sideboard"]),
            item_archidekt("Soldier", 1, ["Tokens"]),         # lixo
        ],
    }
    saida, sessao = com_sessao(RespostaFalsa(deck_archidekt),
                               lambda: importar.de_url(
                                   "https://archidekt.com/decks/7/x"))
    eq("archidekt: pede o deck pelo id",
       sessao.pedidos, ["https://archidekt.com/api/decks/7/"])
    eq("archidekt: nome do deck", saida["nome"], "Deck de Teste")
    eq("archidekt: comandante sai da categoria Commander",
       saida["comandantes"], ["Atraxa, Praetors' Voice"])
    # O maybeboard é o erro caro: entra na mesma lista que o deck e só se
    # distingue pela categoria que o DONO marcou como fora.
    eq("archidekt: só o que conta pro deck entra nas 100", cartas_de(saida),
       [("Sol Ring", 1), ("Arcane Signet", 1), ("Forest", 10)])
    check("archidekt: carta em duas categorias, uma fora, sai das 100",
          "Mana Crypt" not in [c[0] for c in cartas_de(saida)])
    # E não some: vai pro maybeboard, que é onde ela estava lá.
    eq("archidekt: o que o dono tirou da conta vira maybeboard",
       sorted(maybe_de(saida)), [("Blood Moon", 1), ("Mana Crypt", 1)])
    eq("archidekt: sideboard de lá vira a categoria Sideboard daqui",
       sideboard_de(saida), [("Swords to Plowshares", 1)])
    check("archidekt: token não vira carta de deck nem maybeboard",
          "Soldier" not in [c[0] for c in maybe_de(saida) + cartas_de(saida)])

    erro("archidekt: resposta sem 'cards' acusa mudança de contrato",
         lambda: com_sessao(RespostaFalsa({"name": "x"}),
                            lambda: importar.de_url("archidekt.com/decks/7")),
         "contrato")
    erro("archidekt: 404 fala de link e de deck privado",
         lambda: com_sessao(RespostaFalsa({}, status=404),
                            lambda: importar.de_url("archidekt.com/decks/7")),
         "privado")

    # -------------------------------------------------------------- moxfield
    print("\n--- moxfield ---")

    deck_moxfield = {
        "name": "Winota Stax",
        "boards": {
            "commanders": {"cards": {"a": item_moxfield("Winota, Joiner of Forces")}},
            "mainboard": {"cards": {
                "b": item_moxfield("Sol Ring"),
                "c": item_moxfield("Plains", 12),
            }},
            "companions": {"cards": {"d": item_moxfield("Lurrus of the Dream-Den")}},
            "sideboard": {"cards": {"e": item_moxfield("Blood Moon")}},
            "maybeboard": {"cards": {"f": item_moxfield("Mana Crypt")}},
            "tokens": {"cards": {"g": item_moxfield("Soldier")}},
        },
    }
    saida, sessao = com_sessao(RespostaFalsa(deck_moxfield),
                               lambda: importar.de_url(
                                   "https://www.moxfield.com/decks/abc123"))
    eq("moxfield: pede o deck pelo id público",
       sessao.pedidos, ["https://api2.moxfield.com/v3/decks/all/abc123"])
    eq("moxfield: comandante sai do tabuleiro 'commanders'",
       saida["comandantes"], ["Winota, Joiner of Forces"])
    eq("moxfield: mainboard e companion são as 100",
       sorted(cartas_de(saida)),
       [("Lurrus of the Dream-Den", 1), ("Plains", 12), ("Sol Ring", 1)])
    eq("moxfield: o tabuleiro sideboard vira a categoria Sideboard",
       sideboard_de(saida), [("Blood Moon", 1)])
    eq("moxfield: o tabuleiro maybeboard vira o maybeboard",
       maybe_de(saida), [("Mana Crypt", 1)])
    check("moxfield: token continua fora de tudo",
          "Soldier" not in [c[0] for c in
                            cartas_de(saida) + sideboard_de(saida) + maybe_de(saida)])

    erro("moxfield: resposta sem 'boards' acusa mudança de contrato",
         lambda: com_sessao(RespostaFalsa({"name": "x"}),
                            lambda: importar.de_url("moxfield.com/decks/x")),
         "contrato")
    # O Cloudflare responde 200 com uma página HTML no desafio de navegador.
    # Isso não é "resposta estranha": é bloqueio, e o recado tem que dizer
    # o que fazer, não só que deu errado.
    erro("moxfield: HTML com 200 é tratado como bloqueio, com saída",
         lambda: com_sessao(RespostaFalsa("<html>", e_json=False),
                            lambda: importar.de_url("moxfield.com/decks/x")),
         "export")
    erro("moxfield: 403 manda exportar e colar",
         lambda: com_sessao(RespostaFalsa({}, status=403),
                            lambda: importar.de_url("moxfield.com/decks/x")),
         "export")

    # ---------------------------------------------------------- lista colada
    print("\n--- lista colada ---")

    saida = importar.de_texto(
        "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n10 Forest\n")
    eq("texto: cabeçalho Commander marca o comandante",
       saida["comandantes"], ["Atraxa, Praetors' Voice"])
    eq("texto: quantidade vem da frente da linha",
       cartas_de(saida), [("Sol Ring", 1), ("Forest", 10)])

    saida = importar.de_texto("1x Sol Ring (LTC) 285 [Artifact{top}]\n"
                              "1x Atraxa, Praetors' Voice (CMR) 267 [Commander{top}]\n"
                              "1x Fire // Ice (MH2) 290 [Instant]\n")
    eq("texto: edição, número e categoria saem do nome",
       cartas_de(saida), [("Sol Ring", 1), ("Fire // Ice", 1)])
    # "//" é parte do nome de carta de duas faces e não pode ser limpado
    # junto com os enfeites — sem ele, a base local não acha a carta.
    check("texto: o // da carta de duas faces sobrevive",
          ("Fire // Ice", 1) in cartas_de(saida))
    eq("texto: [Commander] na linha marca o comandante",
       saida["comandantes"], ["Atraxa, Praetors' Voice"])

    saida = importar.de_texto("1x Atraxa, Praetors' Voice *CMDR*\n1x Sol Ring\n")
    eq("texto: *CMDR* do TappedOut marca o comandante",
       saida["comandantes"], ["Atraxa, Praetors' Voice"])

    saida = importar.de_texto("Deck\n1 Sol Ring\n\nSideboard\n1 Blood Moon\n"
                              "1 Pyroblast\n")
    eq("texto: sideboard fica fora das 100", cartas_de(saida), [("Sol Ring", 1)])
    # Linha em branco NÃO devolve pro deck: se devolvesse, o Pyroblast (que
    # vem depois de uma quebra dentro do sideboard) entraria nas 100.
    eq("texto: linha em branco não tira do sideboard",
       sideboard_de(saida), [("Blood Moon", 1), ("Pyroblast", 1)])

    # Os três rótulos de "fora do deck" têm destinos diferentes, e é só o
    # rótulo que os separa — errar aqui é pôr na cotação o que a pessoa
    # ainda não decidiu, ou tirar dela o que ela já decidiu.
    saida = importar.de_texto(
        "1 Sol Ring\nSideboard\n1 Blood Moon\nMaybeboard\n1 Rhystic Study\n"
        "Considering\n1 Mana Crypt\nTokens\n1 Soldier\n")
    eq("texto: as 100 são só o que não tem rótulo", cartas_de(saida),
       [("Sol Ring", 1)])
    eq("texto: sideboard vira categoria", sideboard_de(saida),
       [("Blood Moon", 1)])
    eq("texto: maybeboard e 'considering' viram maybeboard",
       maybe_de(saida), [("Rhystic Study", 1), ("Mana Crypt", 1)])
    check("texto: seção de tokens continua sendo descartada",
          "Soldier" not in [c[0] for c in
                            cartas_de(saida) + sideboard_de(saida) + maybe_de(saida)])

    # Só maybeboard não é lista vazia: é quem guarda a lista de compras num
    # site e vem cotar aqui.
    saida = importar.de_texto("Maybeboard\n1 Rhystic Study\n")
    eq("texto: lista só com maybeboard não é erro",
       maybe_de(saida), [("Rhystic Study", 1)])

    saida = importar.de_texto("Creatures (2)\n1 Llanowar Elves\n1 Birds of Paradise\n")
    eq("texto: 'Creatures (2)' é cabeçalho, não carta",
       cartas_de(saida), [("Llanowar Elves", 1), ("Birds of Paradise", 1)])

    saida = importar.de_texto("1 Creature Guildpact\n")
    eq("texto: carta cujo nome começa como cabeçalho é carta",
       cartas_de(saida), [("Creature Guildpact", 1)])

    saida = importar.de_texto("Sol Ring\nArcane Signet\n")
    eq("texto: sem quantidade vale 1",
       cartas_de(saida), [("Sol Ring", 1), ("Arcane Signet", 1)])

    saida = importar.de_texto("// comentário\n# outro\n1 Sol Ring\n")
    eq("texto: comentário é ignorado", cartas_de(saida), [("Sol Ring", 1)])

    erro("texto: sem carta nenhuma diz qual é o formato",
         lambda: importar.de_texto("\n\n   \n"), "1 sol ring")

    # -------------------------------------------- resolver contra a base local
    print("\n--- resolver na base local ---")

    cartas.init_db()
    conn = cartas._conn()
    linhas = [cartas._linha({
        "oracle_id": n.lower(), "name": n, "type_line": t,
        "oracle_text": "", "cmc": 1.0, "mana_cost": "{1}",
        "colors": [], "color_identity": [],
        "legalities": {"commander": "legal"}, "prices": {"usd": "1.00"},
        "layout": "normal", "image_uris": {"normal": "http://x/arte.jpg"},
    }) for n, t in [("Sol Ring", "Artifact"), ("Forest", "Basic Land — Forest"),
                    ("Atraxa, Praetors' Voice", "Legendary Creature — Angel")]]
    conn.executemany(
        f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
        f"VALUES ({cartas._INTERROGACOES})", linhas)
    conn.commit()
    conn.close()

    pronto = decks.importado_para_deck({
        "nome": "Um nome bem grande " * 10,
        "comandantes": ["Atraxa, Praetors' Voice"],
        "cartas": [{"nome": "Sol Ring", "quantidade": 1},
                   {"nome": "Forest", "quantidade": 10},
                   {"nome": "Carta Que Não Existe", "quantidade": 2}],
        "fonte": "Archidekt", "link": "http://x",
    })
    eq("resolve o comandante",
       [c["nome"] for c in pronto["comandantes_completos"]],
       ["Atraxa, Praetors' Voice"])
    eq("resolve as cartas conhecidas",
       [(e["carta"]["nome"], e["quantidade"]) for e in pronto["cartas_completas"]],
       [("Sol Ring", 1), ("Forest", 10)])
    # O que a base não conhece não pode sumir calado: quem importa 100 e
    # recebe 97 precisa saber QUAIS três ficaram de fora.
    eq("o que a base não conhece volta na lista, com a quantidade",
       pronto["nao_encontradas"],
       [{"nome": "Carta Que Não Existe", "quantidade": 2, "categoria": "",
         "comandante": False}])
    check("o nome do deck é cortado no limite do campo",
          len(pronto["nome"]) <= 80)

    pronto = decks.importado_para_deck({
        "nome": "", "comandantes": ["Comandante Inventado"],
        "cartas": [{"nome": "Sol Ring", "quantidade": 1}],
        "fonte": "lista colada", "link": "",
    })
    # Comandante que não resolve é caso à parte: sem ele o deck não tem
    # identidade de cor, e a tela precisa dizer isso em vez de abrir vazia.
    eq("comandante que não resolve é marcado como comandante",
       pronto["nao_encontradas"],
       [{"nome": "Comandante Inventado", "quantidade": 1, "comandante": True}])

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
