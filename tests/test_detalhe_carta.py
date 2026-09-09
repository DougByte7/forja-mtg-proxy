"""
Confere o detalhe de carta que a modal do deckbuilder mostra.

MOTIVO DE EXISTIR. Esta é a única parte da tela que vai à rede pra responder a
um clique, e ela vai a um serviço que pede pra não ser martelado. Três coisas
precisam continuar valendo:

1. **O cache segura.** Reabrir a mesma carta não pode custar requisição de
   novo — quem monta deck abre a mesma carta várias vezes numa sessão.
2. **A Scryfall fora do ar não vira erro na cara de ninguém.** A modal já está
   aberta com o que a base local sabe; o detalhe é acréscimo, e um alerta
   vermelho no lugar dele seria pior que o silêncio.
3. **Carta de duas faces sai inteira.** Split e aventura têm duas faces de
   texto numa imagem só, e o formato precisa dizer isso sem repetir a arte.

Não precisa de rede nem de pytest — a Scryfall é substituída aqui dentro.
Rode de dentro da raiz do projeto:

    python tests/test_detalhe_carta.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# O diretório do cache é lido na importação do módulo.
TMP = tempfile.mkdtemp(prefix="teste-detalhe-carta-")
os.environ["CARTA_DETALHE_CACHE_DIR"] = TMP

from app import detalhe_carta, scryfall  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


# Uma carta partida: duas faces de texto, UMA imagem, e ruling de verdade.
CARD = {
    "name": "Fire // Ice", "layout": "split", "cmc": 4.0,
    "color_identity": ["R", "U"], "set": "dmr", "set_name": "Dominaria Remastered",
    "collector_number": "215", "rarity": "uncommon", "released_at": "2023-01-13",
    "keywords": [], "reserved": False, "edhrec_rank": 13027,
    "prices": {"usd": "0.22", "usd_foil": None},
    "scryfall_uri": "https://scryfall.com/card/dmr/215/fire-ice",
    "related_uris": {"gatherer": "https://gatherer.wizards.com/x"},
    "rulings_uri": "https://api.scryfall.com/cards/x/rulings",
    "image_uris": {"normal": "http://arte/fire-ice.jpg"},
    "card_faces": [
        {"name": "Fire", "mana_cost": "{1}{R}", "type_line": "Instant",
         "oracle_text": "Fire deals 2 damage divided as you choose.",
         "flavor_text": "Chandra sorriu.", "artist": "Franz Vohwinkel"},
        {"name": "Ice", "mana_cost": "{1}{U}", "type_line": "Instant",
         "oracle_text": "Tap target permanent.\nDraw a card.",
         "artist": "Franz Vohwinkel"},
    ],
}
RULINGS = {"data": [{"published_at": "2022-12-08", "source": "wotc",
                     "comment": "Escolha uma das metades pra conjurar."}]}

chamadas = []


def falsa_api(url, params=None, carta="", sessao=None):
    chamadas.append((url, params))
    if url.endswith("/rulings"):
        return RULINGS
    # `exact` é literal e não casa com o "//" de carta de duas faces; quem
    # resolve é o `fuzzy`, e o caminho de reserva precisa continuar existindo.
    if params and "exact" in params:
        return None
    return CARD


try:
    scryfall.nova_sessao = lambda: "sessão de mentira"
    scryfall.json_da_api = falsa_api

    d = detalhe_carta.detalhe("Fire // Ice")
    eq("nome vem da Scryfall, não do pedido", d["nome"], "Fire // Ice")
    eq("caiu no fuzzy depois do exact", len(chamadas), 3)
    eq("edição sai em sigla maiúscula", d["edicao_sigla"], "DMR")
    eq("as duas faces vêm", [f["nome"] for f in d["faces"]], ["Fire", "Ice"])
    eq("a face sem arte própria herda a da carta",
       [f["imagem"] for f in d["faces"]],
       ["http://arte/fire-ice.jpg", "http://arte/fire-ice.jpg"])
    eq("ambientação fica na face que a tem", d["faces"][0]["sabor"],
       "Chandra sorriu.")
    eq("a face sem ambientação vem vazia, não nula", d["faces"][1]["sabor"], "")
    eq("as notas de regras vêm no formato da tela", d["regras"],
       [{"data": "2022-12-08", "fonte": "wotc",
         "texto": "Escolha uma das metades pra conjurar."}])
    check("legalidade não vem: a modal não mostra formato",
          "legalidades" not in d)
    check("link da Scryfall vem junto", d["scryfall"].startswith("https://scryfall"))

    antes = len(chamadas)
    igual = detalhe_carta.detalhe("Fire // Ice")
    eq("reabrir não custa requisição nenhuma", len(chamadas), antes)
    eq("e devolve a mesma coisa", igual, d)

    # Carta que a Scryfall não conhece: 404 nos dois caminhos.
    scryfall.json_da_api = lambda *a, **k: None
    eq("nome que não existe devolve None",
       detalhe_carta.detalhe("Carta Que Não Existe"), None)
    eq("nome vazio nem tenta", detalhe_carta.detalhe("   "), None)

    # Rede fora do ar: o erro morre aqui, não sobe pra tela.
    def explode(*a, **k):
        raise scryfall.ScryfallError("timeout")

    scryfall.json_da_api = explode
    try:
        eq("Scryfall fora do ar devolve None",
           detalhe_carta.detalhe("Uma Carta Qualquer"), None)
    except Exception as e:
        check("Scryfall fora do ar devolve None", False, f"(levantou {e!r})")

    # Carta de face única: uma face só, montada do topo da resposta.
    scryfall.json_da_api = lambda url, params=None, carta="", sessao=None: (
        {"data": []} if url.endswith("/rulings") else {
            "name": "Llanowar Elves", "mana_cost": "{G}",
            "type_line": "Creature — Elf Druid", "oracle_text": "{T}: Add {G}.",
            "power": "1", "toughness": "1", "artist": "Chris Rahn",
            "image_uris": {"normal": "http://arte/elf.jpg"},
            "rulings_uri": "https://api.scryfall.com/cards/y/rulings",
        })
    e = detalhe_carta.detalhe("Llanowar Elves")
    eq("carta de face única tem uma face", len(e["faces"]), 1)
    eq("com poder e resistência",
       (e["faces"][0]["poder"], e["faces"][0]["resistencia"]), ("1", "1"))
    eq("carta sem ruling nenhum não é erro", e["regras"], [])

    # Gravar num lugar impossível avisa no log e segue a vida.
    salvo = detalhe_carta.DIR
    try:
        detalhe_carta.DIR = "/proc/nao-da-pra-escrever-aqui"
        detalhe_carta.detalhe("Outra Carta Qualquer")
        check("falha ao gravar o cache não derruba a busca", True)
    except Exception as e:
        check("falha ao gravar o cache não derruba a busca", False, f"({e})")
    finally:
        detalhe_carta.DIR = salvo
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
