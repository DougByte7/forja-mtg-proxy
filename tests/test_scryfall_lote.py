"""
Confere o casamento entre o `<query>` do MPC Fill e o nome canônico da carta.

Motivo de existir: o `<query>` é MUITO mais próximo do nome real do que este
projeto supunha. Medindo com um deck de verdade, 73 de 75 `<query>` batem
direto no `/cards/collection` da Scryfall, que ignora caixa, vírgula, hífen,
apóstrofo e o "!" final. Foi o que permitiu trocar ~150 requisições por ~13.

O que este arquivo trava é a NORMALIZAÇÃO que faz esse casamento, porque é
ela que decide se a carta entra no lote ou cai no caminho lento. Sem rede:
os "cards" são inventados aqui.

    python tests/test_scryfall_lote.py
"""
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from app.scryfall import _chave_nome, _chaves_do_card  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


# Cada par é (query que o MPC Fill gerou, nome canônico da Scryfall) — todos
# tirados de um XML real.
PARES = [
    ("vorinclex voice of hunger", "Vorinclex, Voice of Hunger"),   # vírgula
    ("natures lore", "Nature's Lore"),                             # apóstrofo
    ("tyvars stand", "Tyvar's Stand"),
    ("hulks thunderclap", "Hulk's Thunderclap"),
    ("shang chi master of kung fu", "Shang-Chi, Master of Kung Fu"),  # hífen
    ("go nuts", "Go Nuts!"),                                       # "!"
    ("domri anarch of bolas", "Domri, Anarch of Bolas"),
    ("sol ring", "Sol Ring"),                                      # trivial
    ("doc samson super psychiatrist", "Doc Samson, Super Psychiatrist"),
]
for query, canonico in PARES:
    check(f"{query!r:32} casa com {canonico!r}",
          _chave_nome(query) == _chave_nome(canonico),
          f"({_chave_nome(query)!r} vs {_chave_nome(canonico)!r})")

# Dupla-face: o canônico traz as duas faces, o `<query>` só a da frente.
# Sem indexar a frente, TODA dupla-face escaparia do lote sem motivo.
chaves = _chaves_do_card({"name": "Bruce Banner // The Incredible Hulk"})
check("dupla-face indexa o nome inteiro",
      _chave_nome("Bruce Banner // The Incredible Hulk") in chaves)
check("dupla-face indexa também a face da frente",
      _chave_nome("bruce banner") in chaves, str(chaves))

chaves = _chaves_do_card({"name": "Command Tower // Command Tower"})
check("dupla-face de faces iguais não some", _chave_nome("command tower") in chaves)

check("carta normal gera uma chave só",
      _chaves_do_card({"name": "Sol Ring"}) == ["sol ring"])

# O que o MPC Fill quebra de verdade: ele derruba artigos, e aí nenhuma
# normalização salva — tem que sobrar pro caminho carta-a-carta, onde a busca
# difusa resolve. Este teste existe pra ninguém "consertar" isso à força e
# acabar casando carta errada.
for query, canonico in [("enter unknown", "Enter the Unknown"),
                        ("return of wildspeaker", "Return of the Wildspeaker")]:
    check(f"{query!r} NÃO casa (artigo faltando) e cai no caminho difuso",
          _chave_nome(query) != _chave_nome(canonico))

# Nomes diferentes não podem colidir, senão o lote atribui preço errado.
check("nomes distintos não colidem",
      _chave_nome("Fire // Ice") != _chave_nome("Fire"))
check("acento não atrapalha", _chave_nome("Márton Stromgald") == "marton stromgald")
check("espaço extra some", _chave_nome("  Sol   Ring  ") == "sol ring")
check("vazio não quebra", _chave_nome(None) == "" and _chave_nome("") == "")

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
