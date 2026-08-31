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

from app.cotacao import face_da_frente  # noqa: E402
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

# O /cards/collection NÃO aceita o nome completo "A // B": pedir
# "Bruce Banner // The Incredible Hulk" cai em not_found, pedir
# "Bruce Banner" devolve a carta. Só apareceu quando os nomes passaram a
# chegar no lote já canônicos; antes vinham do XML, que traz só a frente.
check("identificador de dupla-face usa a face da frente",
      face_da_frente("Bruce Banner // The Incredible Hulk") == "Bruce Banner")
check("dupla-face de faces iguais também",
      face_da_frente("Command Tower // Command Tower") == "Command Tower")
check("carta normal passa inteira", face_da_frente("Sol Ring") == "Sol Ring")
check("espaço em volta do // some", face_da_frente("Fire // Ice") == "Fire")

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


# --------------------------------------------------------------------------
# A troca do <query> pelo nome real, que é o que faz a LigaMagic achar a carta
# --------------------------------------------------------------------------
# A busca da Liga é por nome EXATO: "natures lore" devolve 0 oferta e
# "Nature's Lore" devolve 245. Sem esta troca, toda carta com vírgula,
# apóstrofo, hífen, "!" ou artigo no nome sumia da coluna dela em silêncio.
from app import cotacao_job  # noqa: E402

MAPA = {"natures lore": "Nature's Lore", "go nuts": "Go Nuts!",
        "Sol Ring": "Sol Ring"}
# O tipo vem de carona no mesmo `resolver_nomes` (é o que a Scryfall já
# devolve junto do nome), e é o que a tela usa pra agrupar a tabela.
TIPOS = {"Nature's Lore": "Sorcery", "Sol Ring": "Artifact"}

def resolve(nomes, tipos=None):
    if tipos is not None:
        tipos.update(TIPOS)
    return dict(MAPA)

cotacao_job.scryfall.resolver_nomes = resolve

cartas = [{"nome": n, "quantidade": 1} for n in
          ["natures lore", "go nuts", "Sol Ring", "carta que nao existe"]]
saida = cotacao_job._com_nome_real(cartas)
nomes = [c["nome"] for c in saida]
check("nome com apóstrofo é trocado", nomes[0] == "Nature's Lore", nomes[0])
check("nome com '!' é trocado", nomes[1] == "Go Nuts!", nomes[1])
check("nome que já estava certo não muda", nomes[2] == "Sol Ring")
check("nome que não resolve fica como estava (nunca piora)",
      nomes[3] == "carta que nao existe")
check("a quantidade sobrevive à troca",
      all(c["quantidade"] == 1 for c in saida))
check("o nome do XML fica guardado pra referência",
      saida[0].get("nome_xml") == "natures lore")
check("o tipo da carta vem junto do nome resolvido",
      saida[0].get("tipo") == "Sorcery", saida[0].get("tipo"))
check("carta que não resolve fica sem tipo (a tela agrupa em 'outras')",
      not saida[3].get("tipo"))

# Se a resolução falhar (Scryfall fora do ar), a cotação tem que seguir com
# os nomes do XML — como antes. É o que mantém isto como melhoria pura.
cotacao_job.scryfall.resolver_nomes = lambda nomes, tipos=None: {}
check("resolução vazia devolve a lista intacta",
      [c["nome"] for c in cotacao_job._com_nome_real(cartas)] ==
      [c["nome"] for c in cartas])

def explode(nomes, tipos=None):
    raise RuntimeError("Scryfall fora do ar")
cotacao_job.scryfall.resolver_nomes = explode
# `resolver_nomes` já engole os erros dele, mas a cotação não pode DEPENDER
# disso: se o dicionário explodir, o orçamento tem que sair mesmo assim.
try:
    intacta = [c["nome"] for c in cotacao_job._com_nome_real(cartas)]
    check("exceção na resolução não derruba a cotação",
          intacta == [c["nome"] for c in cartas])
except Exception as e:
    check("exceção na resolução não derruba a cotação", False,
          f"deixou subir {type(e).__name__}")

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
