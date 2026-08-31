"""
Confere a tela de pedidos do operador (/admin) e as rotas que ela usa.

O que se está travando aqui é o que dói se quebrar em silêncio:

1. **Ninguém entra sem o token.** A página é um arquivo estático que qualquer
   um pode abrir, então a proteção toda mora nas rotas — se uma delas passar a
   responder sem o `X-Admin-Token`, a lista de clientes vira pública.
2. **O que sai na resposta.** O XML do deck não pode ir junto da listagem, e o
   link do PDF tem que sair assinado.
3. **Efeito das ações.** Cancelar tira o pedido dos abertos sem apagar nada;
   voltar pra 'pending' limpa o aviso do cliente; apagar apaga mesmo.

Impressora e montagem de PDF ficam de fora de propósito: dependem de CUPS e
do Drive, e o que interessa aqui é a porta de entrada.

Precisa do fastapi instalado (`pip install -r requirements.txt`). Rode de
dentro da raiz do projeto:

    python tests/test_admin_pedidos.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# Antes de importar o app: os módulos leem o ambiente na hora do import, e um
# banco de verdade não pode ser tocado por um teste que apaga pedido.
TOKEN = "token-de-teste-123"
os.environ["ADMIN_TOKEN"] = TOKEN
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "orders.db")
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"  # o teste não é sobre o log; só o que quebrar aparece

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)  # a rota /admin serve app/static/admin.html por caminho relativo

from app import storage  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


storage.init_db()
cliente = TestClient(app)
AUTH = {"X-Admin-Token": TOKEN}


def semear(nome, deck, qty, pages):
    return storage.create_order(
        "<order><details/></order>", "single", nome, deck,
        {"total": 12.5, "qty": qty, "backs_count": 0, "pages": pages,
         "blanks": 2},
    )[0]


ana = semear("Ana Prado", "abc123", 9, 1)
bruno = semear("Bruno Lima", "def456", 18, 2)
carla = semear("Carla Reis", "ghi789", 4, 1)
storage.mark_notified(bruno)
storage.mark_paid(carla)

# --- 1. a porta ----------------------------------------------------------
# Cada rota nova tem que barrar duas coisas: quem não manda token nenhum e
# quem manda um token errado.
ROTAS = [
    ("GET", "/admin/sessao"),
    ("GET", "/admin/pedidos"),
    ("GET", f"/admin/pedidos/{ana}"),
    ("POST", f"/admin/pedidos/{ana}/pdf"),
    ("POST", f"/admin/pedidos/{ana}/imprimir"),
    ("DELETE", f"/admin/pedidos/{ana}"),
]
for metodo, rota in ROTAS:
    sem = cliente.request(metodo, rota)
    errado = cliente.request(metodo, rota, headers={"X-Admin-Token": "chute"})
    check(f"{metodo} {rota} exige token",
          sem.status_code == 401 and errado.status_code == 401,
          f"{sem.status_code}/{errado.status_code}")

r = cliente.post(f"/admin/pedidos/{ana}/status", data={"status": "paid"})
check("POST status exige token", r.status_code == 401, r.status_code)
check("e o pedido não mudou", storage.get_order(ana)["status"] == "pending")

check("sessão com o token certo abre",
      cliente.get("/admin/sessao", headers=AUTH).status_code == 200)

# A página em si é pública (é só HTML), mas não pode trazer dado dentro.
pagina = cliente.get("/admin")
check("a página /admin abre", pagina.status_code == 200, pagina.status_code)
check("a página não carrega pedido nenhum embutido",
      "Bruno Lima" not in pagina.text and "def456" not in pagina.text)

# --- 2. o que a listagem devolve ----------------------------------------
dados = cliente.get("/admin/pedidos", headers=AUTH).json()
ids = [p["id"] for p in dados["pedidos"]]
check("lista todos os pedidos", sorted(ids) == sorted([ana, bruno, carla]), ids)
check("do mais novo pro mais antigo", ids[0] == carla, ids)
check("contagem por status",
      (dados["contagem"]["pending"], dados["contagem"]["notified"],
       dados["contagem"]["paid"], dados["contagem"]["total"]) == (1, 1, 1, 3),
      dados["contagem"])
primeiro = dados["pedidos"][0]
check("o XML do deck não vai junto", "xml_text" not in primeiro, list(primeiro))
check("o link do PDF sai assinado e relativo",
      primeiro["pdf_url"].startswith(f"/orders/{carla}/pdf?token="),
      primeiro["pdf_url"])

filtrado = cliente.get("/admin/pedidos?status=notified", headers=AUTH).json()
check("filtro por status", [p["id"] for p in filtrado["pedidos"]] == [bruno])

for termo, esperado in [("ANA", ana), ("def456", bruno), (bruno, bruno)]:
    achado = cliente.get(f"/admin/pedidos?busca={termo}", headers=AUTH).json()
    check(f"busca por {termo!r}",
          [p["id"] for p in achado["pedidos"]] == [esperado], achado["pedidos"])

# A busca vai parar dentro de um LIKE; se algum dia virar concatenação de
# string, é aqui que aparece.
r = cliente.get("/admin/pedidos", headers=AUTH,
                params={"busca": "x'; DROP TABLE orders;--"})
check("busca com aspas não derruba nada",
      r.status_code == 200 and r.json()["pedidos"] == [], r.status_code)
check("a tabela continua de pé", len(storage.list_orders()) == 3)

# --- 3. as ações ---------------------------------------------------------
r = cliente.post(f"/admin/pedidos/{ana}/status", data={"status": "cancelado"},
                 headers=AUTH)
check("cancela", r.status_code == 200 and r.json()["status"] == "cancelado",
      r.text[:70])
check("cancelado sai da lista de abertos",
      ana not in [p["id"] for p in storage.list_open()])
check("mas continua no histórico",
      ana in [p["id"] for p in storage.list_orders()])

r = cliente.post(f"/admin/pedidos/{bruno}/status", data={"status": "pending"},
                 headers=AUTH).json()
check("voltar pra pendente limpa o aviso do cliente",
      r["status"] == "pending" and r["notified_at"] is None, r)

r = cliente.post(f"/admin/pedidos/{ana}/status", data={"status": "impresso?"},
                 headers=AUTH)
check("status inventado = 400", r.status_code == 400, r.status_code)
r = cliente.post("/admin/pedidos/naoexiste/status", data={"status": "paid"},
                 headers=AUTH)
check("pedido inexistente = 404", r.status_code == 404, r.status_code)

r = cliente.delete(f"/admin/pedidos/{ana}", headers=AUTH)
check("apaga", r.status_code == 200 and r.json()["ok"], r.text[:70])
check("sumiu do banco", storage.get_order(ana) is None)
check("apagar de novo = 404",
      cliente.delete(f"/admin/pedidos/{ana}", headers=AUTH).status_code == 404)

# --- 4. o que já existia continua de pé ---------------------------------
check("/admin/orders continua respondendo",
      cliente.get("/admin/orders", headers=AUTH).status_code == 200)
check("o status público do pedido continua aberto",
      cliente.get(f"/orders/{bruno}").status_code == 200)
check("a tela do cliente continua na raiz",
      "Forja de Proxies" in cliente.get("/").text)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
