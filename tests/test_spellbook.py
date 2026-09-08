"""
Confere o cliente do Commander Spellbook contra uma resposta sintética.

Motivo de existir. Este cliente conversa com uma API que ninguém aqui
controla, e o contrato dela tem três armadilhas que um teste pega e a leitura
do código não:

1. **É `GET` com corpo JSON**, não POST. Se alguém "consertar" isso pra POST
   achando que foi engano, a API responde 405 e a tela fica sem combo nenhum.
2. **A resposta é camelCase** (`almostIncluded`) e vem embrulhada em
   `results`. Ler `almost_included` devolve lista vazia — que na tela é
   indistinguível de "esse deck não tem combo".
3. **Qual peça está faltando é conta nossa**, não da API: ela só classifica o
   combo inteiro. Errar essa conta faz a tela sugerir adicionar uma carta que
   já está no deck.

O fixture abaixo copia o formato real, tirado do backend deles
(`SpaceCowMedia/commander-spellbook-backend`, serializers `VariantSerializer`
e `FindMyCombosResponseSerializer`).

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_spellbook.py

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

TMP = tempfile.mkdtemp(prefix="teste-spellbook-")
os.environ["SPELLBOOK_CACHE_DIR"] = os.path.join(TMP, "cache")
# Sem isso, cada tentativa de rede do teste esperaria o backoff de verdade.
os.environ["SPELLBOOK_BACKOFF"] = "0"
os.environ["SPELLBOOK_DELAY_SEGUNDOS"] = "0"
os.environ["SPELLBOOK_TENTATIVAS"] = "2"

from app import spellbook  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


# ---------------------------------------------------------------------------
# A resposta de mentira, no formato real: camelCase, dentro de `results`.
# ---------------------------------------------------------------------------


def uso(nome, comandante=False, quantidade=1):
    return {"card": {"id": abs(hash(nome)) % 10000, "name": nome,
                     "typeLine": "Creature", "imageUriFrontNormal": "http://x"},
            "quantity": quantidade, "mustBeCommander": comandante,
            "zoneLocations": ["B"]}


def variante(id_, usos, produz, popularidade=0, bracket="P", requer=()):
    return {
        "id": id_, "status": "OK", "uses": list(usos),
        "requires": [{"template": {"id": 1, "name": r,
                                   "scryfallQuery": "t:creature"},
                      "quantity": 1} for r in requer],
        "produces": [{"feature": {"id": 1, "name": p}, "quantity": 1}
                     for p in produz],
        "identity": "UB", "manaNeeded": "{2}{U}", "manaValueNeeded": 3,
        "easyPrerequisites": "Todas no campo de batalha.",
        "notablePrerequisites": "Nenhuma delas invocada neste turno.",
        "description": "Ative a primeira, responda com a segunda, repita.",
        "popularity": popularidade, "spoiler": False, "bracketTag": bracket,
        "variantCount": 2,
    }


RESPOSTA = {
    "next": None, "previous": None,
    "results": {
        "identity": "WUBG",
        # combo fechado: as duas peças estão no deck
        "included": [
            variante("1-a", [uso("Thassa's Oracle"), uso("Demonic Consultation")],
                     ["Win the game"], popularidade=900, bracket="R"),
            variante("1-b", [uso("Basalt Monolith"), uso("Rings of Brighthearth")],
                     ["Infinite colorless mana"], popularidade=400, bracket="P"),
        ],
        # falta uma peça — é o que vira sugestão
        "almost_included_errado": [],
        "almostIncluded": [
            variante("2-a", [uso("Dramatic Reversal"), uso("Isochron Scepter")],
                     ["Infinite mana"], popularidade=100),
            variante("2-b", [uso("Kiki-Jiki, Mirror Breaker", comandante=True),
                             uso("Zealous Conscripts")],
                     ["Infinite hasty creatures"], popularidade=800),
            # peça que falta é GENÉRICA (template), não carta: não dá pra
            # adicionar com um clique
            variante("2-c", [uso("Thassa's Oracle")], ["Draw your deck"],
                     popularidade=50, requer=["Uma criatura com vigilância"]),
        ],
        # as quatro que este cliente ignora de propósito
        "includedByChangingCommanders": [variante("3", [uso("X")], ["Y"])],
        "almostIncludedByAddingColors": [variante("4", [uso("X")], ["Y"])],
        "almostIncludedByChangingCommanders": [variante("5", [uso("X")], ["Y"])],
        "almostIncludedByAddingColorsAndChangingCommanders": [
            variante("6", [uso("X")], ["Y"])],
    },
}

COMANDANTES = ["Thrasios, Triton Hero"]
CARTAS = [
    {"nome": "Thassa's Oracle", "quantidade": 1},
    {"nome": "Demonic Consultation", "quantidade": 1},
    {"nome": "Basalt Monolith", "quantidade": 1},
    {"nome": "Rings of Brighthearth", "quantidade": 1},
    {"nome": "Isochron Scepter", "quantidade": 1},
    {"nome": "Zealous Conscripts", "quantidade": 1},
]


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
    """Guarda o que foi pedido, pra o teste conferir o contrato de saída."""

    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.chamadas = []
        self.headers = {}

    def request(self, metodo, url, **kwargs):
        self.chamadas.append({"metodo": metodo, "url": url, **kwargs})
        resposta = self.respostas.pop(0)
        if isinstance(resposta, Exception):
            raise resposta
        return resposta


def com_sessao(*respostas):
    """Troca a sessão HTTP por uma de mentira e devolve ela."""
    sessao = SessaoFalsa(respostas)
    spellbook._sessao = lambda: sessao
    return sessao


try:
    # ------------------------------------------------------- contrato de saída
    print("\n--- o que a gente manda ---")

    sessao = com_sessao(RespostaFalsa(RESPOSTA))
    achados = spellbook.buscar(COMANDANTES, CARTAS, usar_cache=False)
    pedido = sessao.chamadas[0]

    eq("é GET, não POST", pedido["metodo"], "GET")
    check("bate no find-my-combos",
          pedido["url"].endswith("/find-my-combos/"), f"({pedido['url']})")

    corpo = json.loads(pedido["data"])
    eq("comandante vai separado do resto",
       corpo["commanders"], [{"card": "Thrasios, Triton Hero", "quantity": 1}])
    eq("o deck vai em main com nome e quantidade",
       corpo["main"][0], {"card": "Thassa's Oracle", "quantity": 1})
    eq("o deck inteiro vai junto", len(corpo["main"]), 6)

    # ------------------------------------------------------ leitura da resposta
    print("\n--- o que a gente entende ---")

    eq("identidade vem do campo identity", achados["identidade"], "WUBG")
    eq("combos fechados são os de `included`",
       sorted(c["id"] for c in achados["no_deck"]), ["1-a", "1-b"])
    eq("sugestões são as de `almostIncluded`",
       sorted(c["id"] for c in achados["faltando_uma"]), ["2-a", "2-b", "2-c"])

    # As quatro listas que pedem trocar comandante ou cor não podem vazar pra
    # tela: elas não são sugestão, são outro deck.
    todos = [c["id"] for c in achados["no_deck"] + achados["faltando_uma"]]
    check("as listas de trocar comandante/cor ficam de fora",
          not {"3", "4", "5", "6"} & set(todos), f"({todos})")

    # A ordem é por popularidade: quem vai adicionar UMA carta quer ver
    # primeiro o combo que a comunidade mais joga.
    eq("sugestões saem da mais popular pra menos",
       [c["id"] for c in achados["faltando_uma"]], ["2-b", "2-a", "2-c"])
    eq("combos fechados também", [c["id"] for c in achados["no_deck"]],
       ["1-a", "1-b"])

    # ------------------------------------------------- qual peça está faltando
    print("\n--- a conta de qual peça falta ---")

    fechado = next(c for c in achados["no_deck"] if c["id"] == "1-a")
    eq("combo fechado não tem peça faltando", fechado["faltam"], [])
    eq("todas as peças marcadas como no deck",
       [p["no_deck"] for p in fechado["pecas"]], [True, True])

    sugestao = next(c for c in achados["faltando_uma"] if c["id"] == "2-a")
    eq("a peça que falta é identificada pelo nome",
       sugestao["faltam"], ["Dramatic Reversal"])
    eq("a peça que já está no deck não entra em `faltam`",
       [p["nome"] for p in sugestao["pecas"] if p["no_deck"]],
       ["Isochron Scepter"])

    comandante = next(c for c in achados["faltando_uma"] if c["id"] == "2-b")
    eq("peça que precisa estar no comando é marcada",
       [p["comandante"] for p in comandante["pecas"]], [True, False])

    generica = next(c for c in achados["faltando_uma"] if c["id"] == "2-c")
    eq("peça genérica vira requisito, não carta faltando",
       (generica["faltam"], generica["requer"]),
       ([], ["Uma criatura com vigilância"]))

    # ------------------------------------------------------------- outros campos
    print("\n--- o resto do que a tela mostra ---")

    eq("o que o combo produz", fechado["produz"], ["Win the game"])
    eq("link pro combo no site",
       fechado["link"], f"{spellbook.SITE}/combo/1-a")
    eq("bracket traduzido", fechado["bracket_rotulo"], "Impiedoso")
    eq("passos vêm de description",
       fechado["passos"], "Ative a primeira, responda com a segunda, repita.")
    eq("pré-requisitos vêm de notablePrerequisites",
       fechado["prerequisitos"], "Nenhuma delas invocada neste turno.")

    # ------------------------------------------------------------------- cache
    print("\n--- cache ---")

    # Deck próprio desta seção: a busca lá em cima passou com `usar_cache=False`,
    # que NÃO lê o cache mas grava nele — buscar de novo é justamente pra
    # atualizar o guardado —, então reusar aquele deck aqui já começaria quente.
    DECK_CACHE = [{"nome": "Isochron Scepter", "quantidade": 1},
                  {"nome": "Zealous Conscripts", "quantidade": 1}]

    sessao = com_sessao(RespostaFalsa(RESPOSTA))
    primeira = spellbook.buscar(COMANDANTES, DECK_CACHE)
    eq("primeira busca vai na rede", (primeira["cache"], len(sessao.chamadas)),
       (False, 1))

    sessao = com_sessao()   # sem resposta nenhuma: se pedir, explode
    segunda = spellbook.buscar(COMANDANTES, DECK_CACHE)
    eq("o mesmo deck volta do cache, sem rede",
       (segunda["cache"], len(sessao.chamadas)), (True, 0))
    eq("e o conteúdo é o mesmo",
       [c["id"] for c in segunda["no_deck"]],
       [c["id"] for c in primeira["no_deck"]])

    sessao = com_sessao(RespostaFalsa(RESPOSTA))
    spellbook.buscar(COMANDANTES, DECK_CACHE + [{"nome": "Sol Ring", "quantidade": 1}])
    eq("deck diferente é consulta nova", len(sessao.chamadas), 1)

    # A ordem da lista não pode virar consulta nova: é o mesmo deck.
    sessao = com_sessao()
    eq("a ordem das cartas não muda a chave",
       spellbook.buscar(COMANDANTES, list(reversed(DECK_CACHE)))["cache"], True)

    # E `usar_cache=False` tem que ir na rede mesmo com o cache quente.
    sessao = com_sessao(RespostaFalsa(RESPOSTA))
    forcada = spellbook.buscar(COMANDANTES, DECK_CACHE, usar_cache=False)
    eq("busca forçada ignora o cache",
       (forcada["cache"], len(sessao.chamadas)), (False, 1))

    # --------------------------------------------------------------- as falhas
    print("\n--- quando dá errado ---")

    def espera_erro(nome, *respostas, deck=None):
        com_sessao(*respostas)
        try:
            spellbook.buscar(COMANDANTES, deck or [
                {"nome": "Carta Só Deste Teste " + nome, "quantidade": 1}])
            check(nome, False, "(não levantou)")
        except spellbook.SpellbookError as e:
            check(nome, True, f"({str(e)[:60]}…)")

    espera_erro("resposta que não é JSON",
                RespostaFalsa(None, texto="<html>manutenção</html>"))
    espera_erro("HTTP 400 não é insistido",
                RespostaFalsa({"detail": "main: too many items"}, status=400))
    espera_erro("rede caída depois das tentativas",
                *[__import__("requests").ConnectionError("sem rota")] * 2)
    espera_erro("formato desconhecido",
                RespostaFalsa({"results": {"outra_coisa": []}}))

    # 500 é transitório: tenta de novo e a segunda resposta vale.
    sessao = com_sessao(RespostaFalsa({}, status=500), RespostaFalsa(RESPOSTA))
    tentou = spellbook.buscar(COMANDANTES, [{"nome": "Outro Deck", "quantidade": 1}])
    eq("erro de servidor é tentado de novo",
       (len(sessao.chamadas), len(tentou["no_deck"])), (2, 2))

    # 429 tem que obedecer o Retry-After, não o backoff nosso.
    sessao = com_sessao(
        RespostaFalsa({}, status=429, headers={"Retry-After": "0"}),
        RespostaFalsa(RESPOSTA))
    spellbook.buscar(COMANDANTES, [{"nome": "Mais Um Deck", "quantidade": 1}])
    eq("429 é respeitado e a busca segue", len(sessao.chamadas), 2)

    # Resposta sem a paginação por fora continua sendo entendida.
    sessao = com_sessao(RespostaFalsa(RESPOSTA["results"]))
    sem_pagina = spellbook.buscar(COMANDANTES,
                                  [{"nome": "Deck Sem Paginacao", "quantidade": 1}])
    eq("resposta sem o embrulho de paginação também é lida",
       len(sem_pagina["no_deck"]), 2)

    # Desligado no .env não pode virar "não tem combo".
    spellbook.LIGADO = False
    try:
        spellbook.buscar(COMANDANTES, CARTAS, usar_cache=False)
        check("desligado no .env levanta em vez de devolver vazio", False)
    except spellbook.SpellbookError:
        check("desligado no .env levanta em vez de devolver vazio", True)
    spellbook.LIGADO = True

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
