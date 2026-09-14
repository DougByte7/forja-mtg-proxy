"""
Confere o estoque de material (aba Estoque da tela do operador).

O que se está travando aqui é o que dói se quebrar em silêncio:

1. **A baixa segue o status.** Avisou que pagou ou foi pago, o material sai;
   voltou pra pendente, foi cancelado ou apagado sem imprimir, volta. E o
   mesmo pedido nunca baixa duas vezes — é o descompasso que faria o saldo
   derreter sem ninguém ter impresso nada.
2. **O plástico conta folhas cobertas**: um lado, 1 plástico a cada 2 folhas
   (arredondando pra cima); dois lados, 1 por folha.
3. **A folha combinada devolve a sobra**, uma vez só por combinação.
4. **O custo de uma folha** soma papel, plástico e as quatro tintas.
5. **O preço cobrado** muda o pedido novo e não mexe no que já existe.
6. **A porta.** Toda rota de estoque exige o token.

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
os.environ["PIX_KEY"] = "teste@forja.local"

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


def xml_de(nome, cartas):
    return "<order><fronts>" + "".join(
        f"<card><id>{nome}{i}</id><slots>{i}</slots></card>"
        for i in range(cartas)) + "</fronts></order>"


def semear(nome, cartas, laminacao="single"):
    return storage.create_order(xml_de(nome, cartas), laminacao, nome, nome[:6],
                                calc.compute_cost(cartas, 0, laminacao))[0]


storage.init_db()
cliente = TestClient(app)
AUTH = {"X-Admin-Token": TOKEN}


def resumo():
    return cliente.get("/admin/estoque", headers=AUTH).json()


def saldo():
    itens = {i["id"]: i["quantidade"] for i in resumo()["itens"]}
    return itens["papel"], itens["plastico"]


def status(pedido, novo):
    cliente.post(f"/admin/pedidos/{pedido}/status", data={"status": novo},
                 headers=AUTH)


# --- 1. a porta ----------------------------------------------------------
ROTAS = [
    ("GET", "/admin/estoque"),
    ("POST", "/admin/estoque/papel/entrada"),
    ("POST", "/admin/estoque/papel/contagem"),
    ("POST", "/admin/estoque/papel/ajustes"),
    ("POST", "/admin/estoque/custos"),
    ("POST", "/admin/estoque/tinta"),
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
check("o preço por unidade vem da compra",
      (round(precos["papel"], 4), round(precos["plastico"], 4)) == (0.05, 0.8),
      precos)

for corpo in ({"quantidade": 0}, {"quantidade": -3}, {"quantidade": "abc"},
              {"quantidade": 2.5}, {"quantidade": 5, "valor_pago": "-1"}):
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
check("avisou que pagou: 2 folhas de um lado levam 1 plástico",
      saldo() == (498, 99), saldo())
storage.mark_paid(duas)
check("pago depois do aviso não baixa de novo", saldo() == (498, 99), saldo())
status(duas, "pending")
check("voltou pra pendente: o material volta", saldo() == (500, 100), saldo())

tres = semear("Gil Rocha", 27)                     # 3 folhas, um lado
storage.mark_notified(tres)
check("3 folhas de um lado levam 2 plásticos", saldo() == (497, 98), saldo())
status(tres, "cancelado")
check("cancelado devolve", saldo() == (500, 100), saldo())

dupla = semear("Bruno Lima", 3, laminacao="double")   # 1 folha, dois lados
status(dupla, "paid")
check("dois lados: 1 plástico por folha", saldo() == (499, 99), saldo())
status(dupla, "cancelado")
check("e cancelado devolve", saldo() == (500, 100), saldo())

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
def imprimir_combinado(ids):
    combo = cliente.post("/admin/combos", data={"ids": ",".join(ids)},
                         headers=AUTH).json()
    return combo["id"], cliente.post(f"/admin/combos/{combo['id']}/imprimir",
                                     headers=AUTH)


# 4 + 2 cartas: separadas são 2 folhas e 2 plásticos, juntas 1 e 1.
a, b = semear("Eva Souza", 4), semear("Fabio Dias", 2)
antes = saldo()
combo, r = imprimir_combinado([a, b])
check("imprime a folha combinada", r.status_code == 200, r.text[:90])
check("gasta 1 folha e 1 plástico, não 2 e 2",
      saldo() == (antes[0] - 1, antes[1] - 1), (antes, saldo()))
cliente.post(f"/admin/combos/{combo}/imprimir", headers=AUTH)
check("imprimir de novo não devolve outra vez",
      saldo() == (antes[0] - 1, antes[1] - 1), (antes, saldo()))

# 9 + 9 cartas: nenhuma folha economizada, mas as duas dividem um plástico.
c, d = semear("Hugo Melo", 9), semear("Iara Luz", 9)
antes = saldo()
imprimir_combinado([c, d])
check("duas folhas de um lado combinadas dividem o plástico",
      saldo() == (antes[0] - 2, antes[1] - 1), (antes, saldo()))

# --- 5. contagem e mínimo ------------------------------------------------
cliente.post("/admin/estoque/papel/contagem", headers=AUTH,
             json={"quantidade": 450})
check("contagem troca o saldo", saldo()[0] == 450, saldo())
check("e deixa a diferença nos movimentos",
      resumo()["movimentos"][0]["motivo"] == "contagem"
      and resumo()["movimentos"][0]["saldo"] == 450, resumo()["movimentos"][0])

cliente.post("/admin/estoque/papel/ajustes", headers=AUTH, json={"minimo": 450})
check("no mínimo acende o aviso", resumo()["itens"][0]["baixo"] is True)
cliente.post("/admin/estoque/papel/ajustes", headers=AUTH, json={"minimo": 100})
check("acima do mínimo apaga", resumo()["itens"][0]["baixo"] is False)

# --- 6. tinta e o custo de uma folha ------------------------------------
tintas = {t["cor"]: t for t in resumo()["tintas"]}
check("as quatro garrafas da 504",
      list(tintas) == ["preto", "amarelo", "magenta", "ciano"]
      and [t["ml_garrafa"] for t in tintas.values()] == [127, 70, 70, 70],
      tintas)
check("no papel brilhante o preto é o que menos desce",
      tintas["preto"]["ml_por_folha"]
      < min(tintas[c]["ml_por_folha"] for c in ("amarelo", "magenta", "ciano")))
check("sem preço de garrafa, a tinta não custa nada ainda",
      resumo()["custo_folha"]["single"]["tinta"] == 0)

r = cliente.post("/admin/estoque/tinta", headers=AUTH, json={
    "preto": {"preco_garrafa": "127", "ml_garrafa": 127, "ml_por_folha": "0,1"},
    "amarelo": {"preco_garrafa": 70, "ml_garrafa": 70, "ml_por_folha": 0.3},
    "magenta": {"preco_garrafa": 70, "ml_por_folha": 0.3},
    "ciano": {"preco_garrafa": 70, "ml_por_folha": 0.3},
})
check("ajusta as garrafas", r.status_code == 200, r.text[:80])
custo = resumo()["custo_folha"]
check("tinta da folha = soma de preço/ml × ml por folha das quatro",
      round(custo["single"]["tinta"], 4) == 1.0, custo["single"])
check("um lado = papel + meio plástico + tinta",
      round(custo["single"]["total"], 4) == 1.45, custo["single"])
check("dois lados = papel + um plástico + tinta",
      round(custo["double"]["total"], 4) == 1.85, custo["double"])

r = cliente.post("/admin/estoque/tinta", headers=AUTH, json={
    "magenta": {"preco_garrafa": 99}, "ciano": {"ml_garrafa": 0}})
check("garrafa de 0 ml = 400", r.status_code == 400, r.status_code)
check("e nada daquela chamada foi salvo",
      {t["cor"]: t for t in resumo()["tintas"]}["magenta"]["preco_garrafa"] == 70)

# --- 7. o preço cobrado --------------------------------------------------
check("nasce com o preço padrão",
      cliente.get("/precos").json() == {"single": calc.PRICE_SINGLE_SIDE,
                                        "double": calc.PRICE_DOUBLE_SIDE_PER_PAGE})
r = cliente.post("/admin/estoque/custos", headers=AUTH,
                 json={"preco_um_lado": "3,00"})
check("muda o preço de um lado", r.status_code == 200, r.text[:80])
check("a tabela mostra o novo cobrado",
      resumo()["custo_folha"]["single"]["cobrado"] == 3.0)
check("GET /precos é público e acompanha",
      cliente.get("/precos").json()["single"] == 3.0)

r = cliente.post("/orders", data={"lamination": "single", "customer_name": "Jó"},
                 files={"xml_file": ("deck.xml", xml_de("jo", 18), "text/xml")})
check("pedido novo sai com o preço novo",
      r.status_code == 200 and r.json()["amount"] == 6.0, r.text[:120])
check("pedido antigo mantém o valor com que foi criado",
      storage.get_order(duas)["amount"] == 5.0, storage.get_order(duas)["amount"])

for corpo in ({"preco_um_lado": "0"}, {"preco_dois_lados": "abc"},
              {"folhas_por_plastico_um_lado": 0}):
    r = cliente.post("/admin/estoque/custos", headers=AUTH, json=corpo)
    check(f"custo inválido {corpo} = 400", r.status_code == 400, r.status_code)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
