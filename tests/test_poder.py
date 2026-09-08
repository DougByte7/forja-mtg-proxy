"""
Confere a estimativa de nível de poder (brackets do Commander).

Motivo de existir. O número que sai daqui é o tipo de coisa que ninguém
confere: "bracket 3" parece plausível para qualquer deck, então um erro no
mapa ou no agrupamento passaria despercebido por meses — e o estrago é
alguém levar pra mesa um deck classificado errado.

Três armadilhas específicas:

1. **O mapa de tag pra número** é copiado do backend deles
   (`Variant.bracket`). Duas tags diferentes caem no mesmo número (Picante e
   Poderoso são 3; Esquisito e Comum são 2), e a de carta banida não cai em
   número nenhum — um deck com carta banida não está em bracket baixo, está
   fora do formato.
2. **A contagem de game changers** é o que separa o bracket 3 do 4: três
   cabem, o quarto empurra. A mensagem muda com isso.
3. **As duas rotas do Spellbook compartilham a chave de cache** (as duas
   partem do mesmo deck). Sem prefixos separados, pedir o bracket devolveria
   a resposta guardada da busca de combos — que tem outro formato inteiro.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_poder.py

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

TMP = tempfile.mkdtemp(prefix="teste-poder-")
os.environ["SPELLBOOK_CACHE_DIR"] = os.path.join(TMP, "cache")
os.environ["SPELLBOOK_BACKOFF"] = "0"
os.environ["SPELLBOOK_DELAY_SEGUNDOS"] = "0"
os.environ["SPELLBOOK_TENTATIVAS"] = "2"

from app import poder, spellbook  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def tipos(leitura):
    return [m["tipo"] for m in leitura["motivos"]]


def motivo(leitura, tipo):
    return next((m for m in leitura["motivos"] if m["tipo"] == tipo), None)


# ---------------------------------------------------------------------------
# Peças da resposta, no formato real: camelCase, sem paginação.
# ---------------------------------------------------------------------------


def carta(nome, **marcas):
    return {"card": {"id": 1, "name": nome, "typeLine": "Artifact"},
            "quantity": 1, "banned": marcas.get("banned", False),
            "gameChanger": marcas.get("gameChanger", False),
            "massLandDenial": marcas.get("massLandDenial", False),
            "extraTurn": marcas.get("extraTurn", False)}


def template(nome, **marcas):
    return {"template": {"id": 1, "name": nome}, "quantity": 1,
            "massLandDenial": marcas.get("massLandDenial", False),
            "extraTurn": marcas.get("extraTurn", False)}


def combo(pecas, velocidade=3, duas=True, **marcas):
    return {
        "combo": {"id": "x-1",
                  "uses": [{"card": {"id": 1, "name": p}, "quantity": 1}
                           for p in pecas]},
        "relevant": True, "borderlineRelevant": True,
        "arguablyTwoCard": duas,
        "definitelyTwoCard": duas and marcas.get("certeza", True),
        "speed": velocidade,
        "massLandDenial": marcas.get("massLandDenial", False),
        "extraTurn": marcas.get("extraTurn", False),
        "lock": marcas.get("lock", False),
        "skipTurns": marcas.get("skipTurns", False),
        "controlAllOpponents": marcas.get("controlAllOpponents", False),
        "controlSomeOpponents": False,
    }


def estimativa(tag, cartas=(), templates=(), combos=()):
    return {"bracket_tag": tag, "cartas": list(cartas),
            "templates": list(templates), "combos": list(combos)}


class RespostaFalsa:
    def __init__(self, corpo, status=200, texto=None, headers=None):
        self.status_code = status
        self._corpo = corpo
        self.text = texto if texto is not None else json.dumps(corpo)
        self.headers = headers or {}

    def json(self):
        if self._corpo is None:
            raise ValueError("não é json")
        return self._corpo


class SessaoFalsa:
    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.chamadas = []
        self.headers = {}

    def request(self, metodo, url, **kwargs):
        self.chamadas.append({"metodo": metodo, "url": url, **kwargs})
        return self.respostas.pop(0)


def com_sessao(*respostas):
    sessao = SessaoFalsa(respostas)
    spellbook._sessao = lambda: sessao
    return sessao


try:
    # ------------------------------------------------------- o mapa de brackets
    print("\n--- de tag pra número ---")

    # Copiado do `Variant.bracket` do backend deles. Duas tags caem no mesmo
    # número de propósito.
    esperado = {"R": 4, "S": 3, "P": 3, "O": 2, "C": 2, "E": 1, "B": None}
    for tag, numero in esperado.items():
        eq(f"tag {tag} vira bracket {numero}",
           poder.ler(estimativa(tag))["bracket"], numero)

    eq("o mapa não tem tag sobrando",
       sorted(poder.BRACKET_DA_TAG), sorted(esperado))

    eq("bracket 4 tem nome", poder.ler(estimativa("R"))["nome"], "Otimizado")
    eq("bracket 1 tem nome", poder.ler(estimativa("E"))["nome"], "Exibição")
    eq("tag desconhecida não inventa número",
       poder.ler(estimativa("ZZ"))["bracket"], None)

    # ------------------------------------------------------------ game changers
    print("\n--- game changers ---")

    tres = poder.ler(estimativa("S", cartas=[
        carta("Rhystic Study", gameChanger=True),
        carta("Cyclonic Rift", gameChanger=True),
        carta("Mana Vault", gameChanger=True),
        carta("Sol Ring"),
    ]))
    m = motivo(tres, "game_changers")
    eq("conta só os marcados como game changer", len(m["cartas"]), 3)
    eq("os nomes vêm junto", "Rhystic Study" in m["cartas"], True)
    check("com três, a mensagem diz que ainda cabem no bracket 3",
          "cabem no bracket 3" in m["detalhe"], f"({m['detalhe']})")

    quatro = poder.ler(estimativa("R", cartas=[
        carta(f"GC {i}", gameChanger=True) for i in range(4)]))
    m = motivo(quatro, "game_changers")
    check("com quatro, a mensagem diz que o deck vai pro 4",
          "bracket 4" in m["detalhe"], f"({m['detalhe']})")
    check("game changer é peso, não erro", m["nivel"] == "peso")

    sem = poder.ler(estimativa("E", cartas=[carta("Llanowar Elves")]))
    check("sem game changer não aparece o motivo",
          "game_changers" not in tipos(sem), f"({tipos(sem)})")

    # ------------------------------------------------------------ carta banida
    print("\n--- carta banida ---")

    banida = poder.ler(estimativa("B", cartas=[
        carta("Black Lotus", banned=True), carta("Sol Ring")]))
    eq("deck com carta banida não tem bracket", banida["bracket"], None)
    m = motivo(banida, "banidas")
    eq("a banida é apontada como erro", m["nivel"], "erro")
    eq("e só ela", m["cartas"], ["Black Lotus"])

    # ------------------------------------------------- terra, turnos e combos
    print("\n--- o que mais pesa ---")

    terra = poder.ler(estimativa("S",
                                 cartas=[carta("Armageddon", massLandDenial=True)],
                                 templates=[template("Um Ravages of War",
                                                     massLandDenial=True)]))
    m = motivo(terra, "terra")
    eq("negação de terreno junta carta e peça genérica",
       m["cartas"], ["Armageddon", "Um Ravages of War"])

    turnos = poder.ler(estimativa("C", cartas=[
        carta("Time Warp", extraTurn=True), carta("Sol Ring")]))
    eq("turno extra é apontado", motivo(turnos, "turnos")["cartas"], ["Time Warp"])

    combos_lidos = poder.ler(estimativa("R", combos=[
        combo(["Thassa's Oracle", "Demonic Consultation"], velocidade=5),
        combo(["Basalt Monolith", "Rings of Brighthearth"], velocidade=4),
        combo(["Peça A", "Peça B", "Peça C"], velocidade=2, duas=False),
    ]))
    m = motivo(combos_lidos, "combos")
    check("combo de três cartas não conta como de duas",
          "2 combo(s)" in m["titulo"], f"({m['titulo']})")
    check("diz quantos são baratos de fechar",
          "2 deles fecham com pouca mana" in m["detalhe"], f"({m['detalhe']})")
    eq("as peças aparecem juntas",
       m["cartas"][0], "Thassa's Oracle + Demonic Consultation")

    lentos = poder.ler(estimativa("C", combos=[
        combo(["Peça A", "Peça B"], velocidade=2)]))
    check("combo caro é dito como caro",
          "Nenhum deles é barato" in motivo(lentos, "combos")["detalhe"])

    # "1 deles fecham" se lê como descuido e faz duvidar do resto do painel.
    um_rapido = poder.ler(estimativa("P", combos=[
        combo(["Peça A", "Peça B"], velocidade=5),
        combo(["Peça C", "Peça D"], velocidade=1)]))
    detalhe = motivo(um_rapido, "combos")["detalhe"]
    check("um combo rápido sozinho conjuga no singular",
          detalhe.startswith("1 deles fecha com"), f"({detalhe})")

    travas = poder.ler(estimativa("S", combos=[
        combo(["Peça A", "Peça B"], lock=True)]))
    check("trava vira motivo próprio", "travas" in tipos(travas), f"({tipos(travas)})")

    # ------------------------------------------------------------ deck sem nada
    print("\n--- deck sem nada que puxe pra cima ---")

    limpo = poder.ler(estimativa("E", cartas=[carta("Llanowar Elves"),
                                              carta("Forest")]))
    eq("nenhum motivo", limpo["motivos"], [])
    eq("e a tela sabe disso", limpo["sem_motivos"], True)
    eq("mas o bracket continua vindo", limpo["bracket"], 1)

    # --------------------------------------------------- o pedido ao Spellbook
    print("\n--- a conversa com a API ---")

    RESPOSTA = {
        "bracketTag": "P",
        "cards": [carta("Rhystic Study", gameChanger=True)],
        "templates": [],
        "combos": [combo(["A", "B"], velocidade=4)],
    }
    DECK = [{"nome": "Rhystic Study", "quantidade": 1}]
    CMD = ["Thrasios, Triton Hero"]

    sessao = com_sessao(RespostaFalsa(RESPOSTA))
    crua = spellbook.estimar_bracket(CMD, DECK, usar_cache=False)
    pedido = sessao.chamadas[0]

    # Esta rota aceita POST (a de combos não): GET com corpo é o tipo de coisa
    # que um proxy no meio do caminho descarta.
    eq("vai como POST", pedido["metodo"], "POST")
    check("bate no estimate-bracket",
          pedido["url"].endswith("/estimate-bracket/"), f"({pedido['url']})")
    corpo = json.loads(pedido["data"])
    eq("comandante separado do resto",
       corpo["commanders"], [{"card": "Thrasios, Triton Hero", "quantity": 1}])
    eq("o deck vai em main", corpo["main"],
       [{"card": "Rhystic Study", "quantity": 1}])

    # A resposta desta rota NÃO vem paginada — é o objeto direto.
    eq("lê o bracketTag do objeto direto", crua["bracket_tag"], "P")
    eq("e as cartas classificadas", len(crua["cartas"]), 1)
    eq("ponta a ponta vira bracket 3", poder.ler(crua)["bracket"], 3)

    # ------------------------------------------------- cache separado por rota
    print("\n--- o cache das duas rotas não se mistura ---")

    # As duas partem do MESMO deck, então a chave é a mesma. Sem prefixo
    # separado, pedir o bracket devolveria a resposta guardada dos combos.
    COMBOS = {"next": None, "results": {
        "identity": "UB", "included": [], "almostIncluded": [],
        "includedByChangingCommanders": [],
        "almostIncludedByAddingColors": [],
        "almostIncludedByChangingCommanders": [],
        "almostIncludedByAddingColorsAndChangingCommanders": []}}
    DECK2 = [{"nome": "Carta Do Teste De Cache", "quantidade": 1}]

    sessao = com_sessao(RespostaFalsa(COMBOS))
    spellbook.buscar(CMD, DECK2)
    sessao = com_sessao(RespostaFalsa(RESPOSTA))
    bracket = spellbook.estimar_bracket(CMD, DECK2)
    eq("o bracket não vem do cache dos combos",
       (bracket["cache"], bracket["bracket_tag"]), (False, "P"))
    eq("e foi buscado de verdade", len(sessao.chamadas), 1)

    sessao = com_sessao()
    de_novo = spellbook.estimar_bracket(CMD, DECK2)
    eq("mas o segundo pedido de bracket vem do cache",
       (de_novo["cache"], de_novo["bracket_tag"]), (True, "P"))

    sessao = com_sessao()
    combos_cache = spellbook.buscar(CMD, DECK2)
    eq("e os combos continuam vindo do cache deles",
       combos_cache["cache"], True)

    # ----------------------------------------------------------------- falhas
    print("\n--- quando dá errado ---")

    com_sessao(RespostaFalsa({"outra": "coisa"}))
    try:
        spellbook.estimar_bracket(CMD, [{"nome": "Deck Sem Bracket", "quantidade": 1}])
        check("resposta sem bracketTag levanta", False, "(passou)")
    except spellbook.SpellbookError as e:
        check("resposta sem bracketTag levanta", True, f"({str(e)[:50]}…)")

    spellbook.LIGADO = False
    try:
        spellbook.estimar_bracket(CMD, DECK, usar_cache=False)
        check("desligado no .env levanta em vez de dar nota", False)
    except spellbook.SpellbookError:
        check("desligado no .env levanta em vez de dar nota", True)
    spellbook.LIGADO = True

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
