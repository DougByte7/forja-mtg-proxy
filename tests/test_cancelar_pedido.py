"""
Confere o cancelamento pelo cliente (`POST /orders/{id}/cancel`), que é o que
a tela "Meus Pedidos" usa.

Essa rota não tem token — quem sabe o id do pedido é quem pode mexer nele, a
mesma regra do notify-payment. Então o que precisa ficar travado aqui é a
JANELA: só dá pra cancelar enquanto ninguém do outro lado ficou sabendo do
pedido. Depois do aviso de pagamento o operador já está conferindo Pix, e
deixar cancelar dali em diante viraria um jeito de sumir com um pedido que
talvez já esteja pago.

Também confere que cancelar NÃO apaga: o pedido some dos abertos e continua
no histórico, que é como o admin trata 'cancelado'.

Precisa do fastapi instalado (`pip install -r requirements.txt`). Rode de
dentro da raiz do projeto:

    python tests/test_cancelar_pedido.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# Antes de importar o app: os módulos leem o ambiente na hora do import, e um
# banco de verdade não pode ser tocado por um teste que muda status.
os.environ["ADMIN_TOKEN"] = "token-de-teste-123"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "orders.db")
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from app import storage  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


storage.init_db()
cliente = TestClient(app)


def semear(nome, deck):
    return storage.create_order(
        "<order><details/></order>", "single", nome, deck,
        {"total": 12.5, "qty": 9, "backs_count": 0, "pages": 1, "blanks": 0},
    )[0]


# --- 1. o caminho normal: pedido novo, ninguém avisou nada ---------------
ana = semear("Ana Prado", "abc123")
r = cliente.post(f"/orders/{ana}/cancel")
check("cancela um pedido em 'pending'", r.status_code == 200, r.text[:120])
check("o status vira 'cancelado'", storage.get_order(ana)["status"] == "cancelado")
check("o pedido continua no banco", storage.get_order(ana) is not None)
check("sai da lista de abertos", ana not in [p["id"] for p in storage.list_open()])
check("mas continua no histórico do admin",
      ana in [p["id"] for p in storage.list_orders()])

# Clicar de novo não pode explodir na cara de quem já cancelou.
r = cliente.post(f"/orders/{ana}/cancel")
check("cancelar de novo é inofensivo",
      r.status_code == 200 and r.json()["status"] == "cancelado", r.text[:120])

# --- 2. a janela fecha depois do aviso de pagamento ----------------------
bruno = semear("Bruno Lima", "def456")
storage.mark_notified(bruno)
r = cliente.post(f"/orders/{bruno}/cancel")
check("pedido já avisado não cancela por aqui", r.status_code == 409, r.text[:120])
check("e o status dele não muda",
      storage.get_order(bruno)["status"] == "notified")

carla = semear("Carla Reis", "ghi789")
storage.mark_paid(carla)
r = cliente.post(f"/orders/{carla}/cancel")
check("pedido pago não cancela por aqui", r.status_code == 409, r.text[:120])
check("e o status dele não muda", storage.get_order(carla)["status"] == "paid")

# --- 3. id que não existe ------------------------------------------------
r = cliente.post("/orders/nao-existe/cancel")
check("id desconhecido dá 404", r.status_code == 404, r.text[:120])

# --- 4. o cliente consegue ler o próprio andamento -----------------------
# É o que a tela "Meus Pedidos" faz a cada abertura, com o id que ela guardou.
r = cliente.get(f"/orders/{ana}")
check("dá pra consultar o andamento sem token",
      r.status_code == 200 and r.json()["status"] == "cancelado", r.text[:120])
check("o XML do deck não vai junto na consulta", "xml_text" not in r.json())

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
