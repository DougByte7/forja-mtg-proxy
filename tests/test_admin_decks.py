"""
Confere a listagem de baralhos do admin.

MOTIVO DE EXISTIR. Esta é a ÚNICA leitura do projeto que enumera decks. Todo
o resto do sistema é "quem tem o id, mexe": ninguém consegue perguntar o que
existe no banco, e é assim de propósito (ver `decks.py`). Esta rota quebra
essa regra deliberadamente, pra quem é dono do sistema — então a única coisa
que a separa de um vazamento é o `_check_admin`.

Três coisas que este teste trava:

1. **Sem token, ninguém lista.** É a checagem que justifica a rota existir.
   Token errado, token ausente e token de outro sistema têm que dar 401 — e
   401 é diferente de lista vazia: "não pode ver" e "não tem nada" não podem
   parecer a mesma coisa.
2. **A contagem do cartão é a mesma do `validar`.** O mesmo número pro mesmo
   deck em três telas agora (deckbuilder, /meus-decks e admin), e três contas
   é onde uma delas começa a divergir calada.
3. **O campo `dono` sai sempre**, mesmo antes de a coluna existir no banco.
   A tela do admin já lê esse campo; se ele sumisse do JSON quando o valor é
   nulo, a tela mostraria "undefined" no dia em que o login chegasse com
   metade dos decks reclamados.

Não precisa de rede. Rode de dentro da raiz do projeto:

    python tests/test_admin_decks.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# Antes de importar o app: os módulos leem o ambiente no import, e um banco de
# verdade não pode ser tocado por um teste que apaga deck.
TMP = tempfile.mkdtemp(prefix="teste-admin-decks-")
TOKEN = "token-de-teste-456"
os.environ["ADMIN_TOKEN"] = TOKEN
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from app import cartas, decks  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


try:
    cartas.init_db()
    decks.init_db()
    cliente = TestClient(app)
    AUTH = {"X-Admin-Token": TOKEN}

    a = decks.criar("Deck do Beltrano", ["Atraxa"], [
        {"nome": "Sol Ring", "quantidade": 1},
        {"nome": "Forest", "quantidade": 30},
        {"nome": "Lightning Bolt", "quantidade": 2, "categoria": "Sideboard"},
    ])
    b = decks.criar("Outro qualquer", [])

    print("\n--- a porta ---")

    eq("sem token, 401", cliente.get("/admin/decks").status_code, 401)
    eq("token errado, 401",
       cliente.get("/admin/decks", headers={"X-Admin-Token": "chute"}).status_code, 401)
    # 401 e não 200-com-lista-vazia: "não pode ver" e "não tem nada" são
    # respostas opostas, e confundi-las esconde um erro de configuração.
    check("recusa não devolve corpo com decks",
          "decks" not in cliente.get("/admin/decks").json())

    print("\n--- a listagem ---")

    r = cliente.get("/admin/decks", headers=AUTH)
    eq("com token, 200", r.status_code, 200)
    corpo = r.json()
    ids = [d["id"] for d in corpo["decks"]]
    check("lista TODOS os decks, sem precisar dos ids",
          a["id"] in ids and b["id"] in ids)
    eq("a contagem bate", corpo["contagem"]["total"], 2)

    achado = next(d for d in corpo["decks"] if d["id"] == a["id"])
    # 1 comandante + 1 + 30. Os 2 do sideboard ficam fora, como em `validar`.
    eq("a contagem do cartão é a do validar", achado["total"], 32)
    eq("e o validar concorda",
       decks.validar(["Atraxa"], [
           {"nome": "Sol Ring", "quantidade": 1},
           {"nome": "Forest", "quantidade": 30},
           {"nome": "Lightning Bolt", "quantidade": 2, "categoria": "Sideboard"},
       ])["total"], achado["total"])

    print("\n--- o dono ---")

    # A coluna ainda não existe: o campo sai mesmo assim, com o valor que é
    # verdade hoje. A tela do admin já lê isto.
    check("o campo `dono` está presente em toda linha",
          all("dono" in d for d in corpo["decks"]))
    check("e vale nulo enquanto o login não existe",
          all(d["dono"] is None for d in corpo["decks"]))
    eq("todos contam como sem dono", corpo["contagem"]["sem_dono"], 2)

    print("\n--- a busca do operador ---")

    def buscar(termo):
        return [d["id"] for d in cliente.get(
            f"/admin/decks?busca={termo}", headers=AUTH).json()["decks"]]

    eq("acha pelo nome do deck", buscar("beltrano"), [a["id"]])
    eq("acha pelo nome do comandante", buscar("atraxa"), [a["id"]])
    eq("acha pelo id", buscar(a["id"][:6]), [a["id"]])
    eq("busca que não casa devolve vazio", buscar("zzzzzz"), [])

    print("\n--- ordem e teto ---")

    # Mexer no deck B tem que trazê-lo pra frente: a lista é "o que está
    # vivo", e por isso ordena por atualizado_em, não por criado_em.
    decks.salvar(b["id"], "Outro qualquer", [], [{"nome": "Sol Ring", "quantidade": 1}])
    ordem = [d["id"] for d in cliente.get("/admin/decks", headers=AUTH).json()["decks"]]
    eq("o mais mexido vem primeiro", ordem[0], b["id"])

    eq("o limite tem teto e não estoura",
       cliente.get("/admin/decks?limite=99999", headers=AUTH).status_code, 200)
    eq("limite 1 devolve um só",
       len(cliente.get("/admin/decks?limite=1", headers=AUTH).json()["decks"]), 1)

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
