"""
Confere o pedido com parte foil: o `POST /orders` com `xml_foil`.

A laminação é da folha, então o deck com algumas cartas foil vira DOIS
pedidos — cada um com a sua fila e o seu papel — e uma cobrança só. O que
precisa ficar travado aqui:

1. **Um Pix com a soma**, e cada pedido com o valor dele: o operador confere
   o Pix pelo total, e o admin cobra cada folha pelo que ela é.
2. **O grupo anda junto.** Avisar o pagamento de um avisa os dois (o Pix é
   um só), e cancelar um cancela os dois — metade de um Pix não se paga.
3. **O que não pode**: o resto do pedido misto em foil, e carta com verso na
   parte foil (o vinil holográfico só vai de um lado).

Precisa do fastapi instalado (`pip install -r requirements.txt`). Rode de
dentro da raiz do projeto:

    python tests/test_pedido_foil.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

os.environ["ADMIN_TOKEN"] = "token-de-teste-123"
os.environ["PIX_KEY"] = "chave-de-teste@exemplo.com"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "orders.db")
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"

try:
    from fastapi.testclient import TestClient  # noqa: F401
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

import conta_clerk  # noqa: E402  (antes do app: põe a chave no ambiente)
from app import main, storage  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


storage.init_db()
cliente = conta_clerk.cliente(app, "amiga", "amigo")

# O e-mail não sai de verdade: guarda o que teria saído.
enviados = []
main.notify.is_configured = lambda: True
main.notify.send_payment_claim_email = lambda pedidos, links: enviados.append(
    ([p["id"] for p in pedidos], links))


def xml_de(cartas, versos=0):
    """`cartas` frentes, as `versos` primeiras com verso."""
    frentes = "".join(f"<card><id>f{n}</id><slots>{n}</slots><query>Carta {n}</query></card>"
                      for n in range(cartas))
    costas = "".join(f"<card><id>v{n}</id><slots>{n}</slots><query>Verso {n}</query></card>"
                     for n in range(versos))
    return (f"<order><details><quantity>{cartas}</quantity></details>"
            f"<fronts>{frentes}</fronts>"
            + (f"<backs>{costas}</backs>" if versos else "") + "</order>")


def pedir(padrao, foil=None, lam="double"):
    arquivos = {"xml_file": ("pedido.xml", padrao, "text/xml")}
    if foil is not None:
        arquivos["xml_foil"] = ("foil.xml", foil, "text/xml")
    return cliente.post("/orders", files=arquivos,
                        data={"lamination": lam, "customer_name": "Ana"})


# --- 1. dois pedidos, um Pix ------------------------------------------------
r = pedir(xml_de(10, versos=2), xml_de(5))
check("o pedido misto é aceito", r.status_code == 200, r.text[:160])
corpo = r.json()
padrao, foil = corpo["pedidos"]
check("saem dois pedidos", len(corpo["pedidos"]) == 2)
check("cada um com a sua laminação",
      (padrao["lamination"], foil["lamination"]) == ("double", "foil"))
precos = main.estoque.precos_por_pagina()
check("o padrão cobra as folhas dele",
      padrao["amount"] == round(2 * precos["double"], 2), str(padrao))
check("o foil cobra as dele, 8 por folha",
      foil["amount"] == round(1 * float(precos["foil"]), 2) and foil["pages"] == 1, str(foil))
check("o Pix é a soma", corpo["amount"] == round(padrao["amount"] + foil["amount"], 2))
check("e leva o id do primeiro, que é o do grupo",
      corpo["order_id"] == padrao["order_id"]
      and padrao["order_id"] in corpo["pix_copia_cola"])
gravado = storage.get_order(foil["order_id"])
check("os dois ficam no mesmo grupo",
      gravado["grupo"] == padrao["order_id"]
      and storage.get_order(padrao["order_id"])["grupo"] == padrao["order_id"])
check("e cada um guarda o próprio valor", gravado["amount"] == foil["amount"])

sozinho = pedir(xml_de(3)).json()
check("o pedido sem foil continua sozinho",
      len(sozinho["pedidos"]) == 1 and storage.get_order(sozinho["order_id"])["grupo"] is None)

# --- 2. o grupo anda junto ----------------------------------------------------
r = cliente.post(f"/orders/{foil['order_id']}/notify-payment")
check("avisar pelo foil dá certo", r.status_code == 200, r.text[:160])
check("o e-mail é um só, com os dois pedidos e um link pra cada",
      enviados and enviados[-1][0] == [padrao["order_id"], foil["order_id"]]
      and len(enviados[-1][1]) == 2, str(enviados))
check("e os dois ficam avisados",
      {storage.get_order(p["order_id"])["status"] for p in (padrao, foil)} == {"notified"})
r = cliente.post(f"/orders/{padrao['order_id']}/cancel")
check("depois do aviso, nenhum dos dois cancela", r.status_code == 409, r.text[:160])

outro = pedir(xml_de(4), xml_de(2)).json()["pedidos"]
r = cliente.post(f"/orders/{outro[0]['order_id']}/cancel")
check("cancelar um cancela o grupo", r.status_code == 200
      and {storage.get_order(p["order_id"])["status"] for p in outro} == {"cancelado"},
      r.text[:160])

# --- 3. o que não pode -------------------------------------------------------
r = pedir(xml_de(4), xml_de(2), lam="foil")
check("o resto do pedido misto não sai em foil", r.status_code == 400, r.text[:160])
r = pedir(xml_de(4), xml_de(2, versos=1))
check("carta com verso não entra na parte foil", r.status_code == 400, r.text[:160])
antes = len(storage.list_orders())
pedir(xml_de(4), "isto não é xml")
check("parte inválida não deixa a outra criada", len(storage.list_orders()) == antes)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
