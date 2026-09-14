"""
Confere o estoque de material (aba Estoque da tela do operador).

O que se está travando aqui é o que dói se quebrar em silêncio:

1. **A baixa segue o status.** Avisou que pagou ou foi pago, o material sai;
   voltou pra pendente, foi cancelado ou apagado sem imprimir, volta. E o
   mesmo pedido nunca baixa duas vezes — é o descompasso que faria o saldo
   derreter sem ninguém ter impresso nada.
2. **A folha combinada devolve a sobra**, uma vez só por combinação.
3. **O custo de uma folha** soma papel, plástico e tinta nos dois
   acabamentos, ao lado do preço cobrado.
4. **A porta.** Toda rota de estoque exige o token.

O Drive fica de fora: `_fetch_all` é trocado por imagens de mentira.

Precisa do fastapi e do httpx instalados. Rode de dentro da raiz do projeto:

    python tests/test_estoque.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TOKEN = "token-de-teste-estoque"
os.environ["ADMIN_TOKEN"] = TOKEN
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "orders.db")
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["PDF_OUTPUT_DIR"] = tempfile.mkdtemp()
os.environ["PRINTER_QUEUE"] = ""

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from PIL import Image                                  # noqa: E402
from app import calc, pdf_generator, storage           # noqa: E402
from app.main import app                               # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def _fetch_falso(drive_ids, cache_dir, on_progress=None):
    resultado = {}
    for d in dict.fromkeys(drive_ids):
        caminho = os.path.join(cache_dir, f"{d}.jpg")
        Image.new("RGB", (272, 370), (40, 90, 160)).save(caminho, "JPEG")
        resultado[d] = caminho
    if on_progress:
        on_progress(len(resultado), len(resultado))
    return resultado


pdf_generator._fetch_all = _fetch_falso


def semear(nome, cartas, laminacao="single"):
    xml = "<order><fronts>" + "".join(
        f"<card><id>{nome}{i}</id><slots>{i}</slots></card>"
        for i in range(cartas)) + "</fronts></order>"
    return storage.create_order(xml, laminacao, nome, nome[:6],
                                calc.compute_cost(cartas, 0, laminacao))[0]


storage.init_db()
cliente = TestClient(app)
AUTH = {"X-Admin-Token": TOKEN}


def resumo():
    return cliente.get("/admin/estoque", headers=AUTH).json()


def saldo():
    itens = {i["id"]: i["quantidade"] for i in resumo()["itens"]}
    return itens["papel"], itens["plastico"]


# --- 1. a porta ----------------------------------------------------------
ROTAS = [
    ("GET", "/admin/estoque"),
    ("POST", "/admin/estoque/papel/entrada"),
    ("POST", "/admin/estoque/papel/contagem"),
    ("POST", "/admin/estoque/papel/ajustes"),
    ("POST", "/admin/estoque/custos"),
]
for metodo, rota in ROTAS:
    sem = cliente.request(metodo, rota, json={"quantidade": 10})
    errado = cliente.request(metodo, rota, json={"quantidade": 10},
                             headers={"X-Admin-Token": "chute"})
    check(f"{metodo} {rota} exige token",
          sem.status_code == 401 and errado.status_code == 401,
          f"{sem.status_code}/{errado.status_code}")
check("e nada entrou sem token", saldo() == (0, 0), saldo())

# --- 2. entrada, contagem e validação -----------------------------------
r = cliente.post("/admin/estoque/papel/entrada", headers=AUTH,
                 json={"quantidade": 500, "valor_pago": "25,00"})
check("entrada de papel", r.status_code == 200, r.text[:80])
cliente.post("/admin/estoque/plastico/entrada", headers=AUTH,
             json={"quantidade": 100, "valor_pago": 80})
check("saldo depois das compras", saldo() == (500, 100), saldo())
precos = {i["id"]: i["custo_unitario"] for i in resumo()["itens"]}
check("o preço por folha vem da compra",
      (round(precos["papel"], 4), round(precos["plastico"], 4)) == (0.05, 0.8),
      precos)

for corpo in ({"quantidade": 0}, {"quantidade": -3}, {"quantidade": "abc"},
              {"quantidade": 2.5}):
    r = cliente.post("/admin/estoque/papel/entrada", headers=AUTH, json=corpo)
    check(f"entrada inválida {corpo} = 400", r.status_code == 400, r.status_code)
r = cliente.post("/admin/estoque/tinta/entrada", headers=AUTH,
                 json={"quantidade": 1})
check("item inexistente = 404", r.status_code == 404, r.status_code)
check("e o saldo não mexeu", saldo() == (500, 100), saldo())

# --- 3. a baixa segue o status ------------------------------------------
duas = semear("Ana Prado", 18)                     # 2 folhas, um lado
check("pedido novo não baixa nada", saldo() == (500, 100), saldo())

storage.mark_notified(duas)
check("avisou que pagou: baixa 2 folhas e 2 plásticos",
      saldo() == (498, 98), saldo())
storage.mark_paid(duas)
check("pago depois do aviso não baixa de novo", saldo() == (498, 98), saldo())

cliente.post(f"/admin/pedidos/{duas}/status", data={"status": "pending"},
             headers=AUTH)
check("voltou pra pendente: o material volta", saldo() == (500, 100), saldo())

dupla = semear("Bruno Lima", 3, laminacao="double")   # 1 folha, dois lados
cliente.post(f"/admin/pedidos/{dupla}/status", data={"status": "paid"},
             headers=AUTH)
check("dois lados gasta 2 plásticos por folha", saldo() == (499, 98), saldo())
cliente.post(f"/admin/pedidos/{dupla}/status", data={"status": "cancelado"},
             headers=AUTH)
check("cancelado devolve", saldo() == (500, 100), saldo())

avisado = semear("Carla Reis", 9)
storage.mark_notified(avisado)
cliente.delete(f"/admin/pedidos/{avisado}", headers=AUTH)
check("apagado sem imprimir devolve", saldo() == (500, 100), saldo())

impresso = semear("Davi Nunes", 9)
storage.mark_paid(impresso)
cliente.delete(f"/admin/pedidos/{impresso}", headers=AUTH)
check("apagado depois de impresso não devolve", saldo() == (499, 99), saldo())

motivos = [m["motivo"] for m in resumo()["movimentos"]]
check("os movimentos contam a história",
      {"entrada", "pedido", "estorno"} <= set(motivos), motivos)

# --- 4. a folha combinada devolve a sobra -------------------------------
# 4 + 2 cartas: separadas são 2 folhas, juntas 1.
a = semear("Eva Souza", 4)
b = semear("Fabio Dias", 2)
antes = saldo()
combo = cliente.post("/admin/combos", data={"ids": f"{a},{b}"},
                     headers=AUTH).json()
r = cliente.post(f"/admin/combos/{combo['id']}/imprimir", headers=AUTH)
check("imprime a folha combinada", r.status_code == 200, r.text[:90])
check("gasta 1 folha, não 2",
      saldo() == (antes[0] - 1, antes[1] - 1), (antes, saldo()))
cliente.post(f"/admin/combos/{combo['id']}/imprimir", headers=AUTH)
check("imprimir de novo não devolve outra vez",
      saldo() == (antes[0] - 1, antes[1] - 1), (antes, saldo()))

# --- 5. contagem e mínimo ------------------------------------------------
cliente.post("/admin/estoque/papel/contagem", headers=AUTH,
             json={"quantidade": 450})
check("contagem troca o saldo", saldo()[0] == 450, saldo())
check("e deixa a diferença nos movimentos",
      resumo()["movimentos"][0]["motivo"] == "contagem"
      and resumo()["movimentos"][0]["saldo"] == 450, resumo()["movimentos"][0])

cliente.post("/admin/estoque/papel/ajustes", headers=AUTH, json={"minimo": 450})
papel = resumo()["itens"][0]
check("no mínimo acende o aviso", papel["baixo"] is True, papel)
cliente.post("/admin/estoque/papel/ajustes", headers=AUTH, json={"minimo": 100})
check("acima do mínimo apaga", resumo()["itens"][0]["baixo"] is False)

# --- 6. o custo de uma folha --------------------------------------------
r = cliente.post("/admin/estoque/custos", headers=AUTH,
                 json={"tinta_por_pagina": "0,30"})
check("ajusta a tinta", r.status_code == 200, r.text[:80])
custo = resumo()["custo_folha"]
check("um lado = papel + 1 plástico + tinta",
      round(custo["single"]["total"], 4) == 1.15, custo["single"])
check("dois lados = papel + 2 plásticos + tinta",
      round(custo["double"]["total"], 4) == 1.95, custo["double"])
check("ao lado do preço cobrado por página",
      (custo["single"]["cobrado"], custo["double"]["cobrado"])
      == (round(calc.PRICE_SINGLE_SIDE, 2),
          round(calc.PRICE_DOUBLE_SIDE_PER_PAGE, 2)), custo)
r = cliente.post("/admin/estoque/custos", headers=AUTH,
                 json={"tinta_por_pagina": "-1"})
check("tinta negativa = 400", r.status_code == 400, r.status_code)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
