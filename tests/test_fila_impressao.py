"""
Confere a fila de impressão: o site só grava `a_imprimir`, e quem imprime é
o worker (`worker/main.py`), que pergunta pela API.

O que se está travando aqui é o que custa papel se quebrar:

1. **Nada imprime duas vezes.** A reserva é atômica (`a_imprimir ->
   imprimindo`): a segunda tentativa leva 409 e o worker não manda pro CUPS.
   A página que acompanha a fila se atualiza sozinha e NÃO enfileira de novo.
2. **O resultado chega.** Se a rede cair depois de o CUPS aceitar, o worker
   guarda o relato e reenvia — sem imprimir outra vez.
3. **A folha combinada sai inteira.** Os pedidos dela não são pegos um a um.
4. **A porta do worker.** Só abre com o WORKER_TOKEN, e o erro cru do CUPS
   não vaza pro cliente.

O worker roda de verdade contra o app, pelo TestClient; só a impressora, o
Drive e o CUPS são dublês. Rode de dentro da raiz do projeto:

    python tests/test_fila_impressao.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TOKEN = "token-de-teste-123"
WORKER = "token-do-worker-456"
os.environ["ADMIN_TOKEN"] = TOKEN
os.environ["WORKER_TOKEN"] = WORKER
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "orders.db")
os.environ["PDF_OUTPUT_DIR"] = tempfile.mkdtemp()
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["FORJA_API_URL"] = "http://site-de-teste"
os.environ["PRINTER_QUEUE"] = "fila-de-teste"

try:
    import requests
    from fastapi.testclient import TestClient
    from PIL import Image
except ImportError:
    print("PULADO: fastapi/Pillow não estão instalados (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from app import calc, pdf_generator, printer, storage  # noqa: E402
from app import main as site  # noqa: E402
from app.main import app  # noqa: E402
from worker import main as worker  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


# --- dublês ----------------------------------------------------------------
def _fetch_falso(drive_ids, cache_dir, on_progress=None):
    resultado = {}
    for i, d in enumerate(dict.fromkeys(drive_ids)):
        caminho = os.path.join(cache_dir, f"{d}.jpg")
        Image.new("RGB", (272, 370), (i * 37 % 255, 90, 160)).save(caminho, "JPEG")
        resultado[d] = caminho
    return resultado


pdf_generator._fetch_all = _fetch_falso

impressos = []          # o que foi pro "CUPS", na ordem
recusar = []            # quantas recusas o CUPS ainda vai dar


def _print_falso(caminho):
    if recusar:
        recusar.pop()
        raise printer.PrintError("a fila está pausada (dublê)")
    impressos.append(os.path.basename(caminho))
    return "request id is fila-de-teste-1"


printer.print_pdf = _print_falso


def xml_de(n, prefixo):
    cartas = "".join(f"<card><id>{prefixo}{i}</id><slots>{i}</slots></card>"
                     for i in range(n))
    return f"<order><fronts>{cartas}</fronts></order>"


def semear(nome, deck, cartas=4):
    resultado = calc.compute_cost(cartas, 0, "single")
    return storage.create_order(xml_de(cartas, deck), "single", nome, deck,
                                resultado)[0]


storage.init_db()
cliente = TestClient(app)
AUTH = {"X-Admin-Token": TOKEN}
WAUTH = {"Authorization": f"Bearer {WORKER}"}


class ApiDeTeste(worker.Api):
    """O worker falando com o app pelo TestClient, em vez da rede."""

    def __init__(self):
        self.cair_em = None    # sufixo de caminho que vai "perder a rede" uma vez

    def get(self, caminho):
        r = cliente.get(caminho, headers=WAUTH)
        r.raise_for_status()
        return r.json()

    def post(self, caminho, corpo=None):
        if self.cair_em and caminho.endswith(self.cair_em):
            self.cair_em = None
            raise requests.ConnectionError("a rede caiu (dublê)")
        return cliente.post(caminho, json=corpo or {}, headers=WAUTH)


api = ApiDeTeste()


def status_de(order_id):
    return storage.get_order(order_id)["status"]


# --- 1. migração ------------------------------------------------------------
velho = semear("Velho Antigo", "vv")
conn = storage._conn()
conn.execute("UPDATE orders SET status='paid' WHERE id=?", (velho,))
conn.commit()
conn.close()
storage.init_db()
check("pedido 'paid' de antes da fila vira 'impresso'", status_de(velho) == "impresso")

# --- 2. a porta do worker ---------------------------------------------------
check("sem token o worker não entra", cliente.get("/worker/fila").status_code == 401)
check("token errado também não",
      cliente.get("/worker/fila", headers={"Authorization": "Bearer x"}).status_code == 401)
check("o token do admin não abre o worker",
      cliente.get("/worker/fila", headers={"Authorization": f"Bearer {TOKEN}"}
                  ).status_code == 401)
site.WORKER_TOKEN = ""
check("WORKER_TOKEN vazia desliga as rotas (503)",
      cliente.get("/worker/fila", headers=WAUTH).status_code == 503)
site.WORKER_TOKEN = WORKER

# --- 3. o link do e-mail ------------------------------------------------------
ana = semear("Ana Prado", "aa")
storage.mark_notified(ana)
link = urlsplit(site.fulfillment.print_url(ana))
r = cliente.get(f"{link.path}?{link.query}", follow_redirects=False)
check("o link Imprimir redireciona (303)", r.status_code == 303, r.status_code)
check("pra página que só acompanha", "/impressao?token=" in r.headers.get("location", ""),
      r.headers.get("location"))
check("e o pedido entrou na fila", status_de(ana) == "a_imprimir")
pagina = cliente.get(r.headers["location"])
check("a página diz que está na fila", "Na fila" in pagina.text)
check("e se atualiza sozinha", 'http-equiv="refresh"' in pagina.text)
check("avisa que a impressora nunca deu sinal", "nunca deu sinal" in pagina.text)
cliente.get(r.headers["location"])
check("recarregar a página não enfileira de novo", status_de(ana) == "a_imprimir")
check("sem token a página não abre",
      cliente.get(f"/orders/{ana}/impressao").status_code == 401)

# --- 4. o que o admin pode e não pode ----------------------------------------
r = cliente.post(f"/admin/pedidos/{ana}/status", data={"status": "a_imprimir"},
                 headers=AUTH)
check("a_imprimir não se escreve na mão (tem rota própria)", r.status_code == 400)
r = cliente.post(f"/admin/pedidos/{ana}/status", data={"status": "imprimindo"},
                 headers=AUTH)
check("imprimindo também não (é do worker)", r.status_code == 400)

# --- 5. reserva atômica -------------------------------------------------------
fila = cliente.get("/worker/fila", headers=WAUTH).json()
check("a fila do worker traz o pedido",
      {"tipo": "pedido", "id": ana} in fila["imprimir"], fila)
r1 = cliente.post(f"/worker/pedidos/{ana}/reservar", headers=WAUTH)
r2 = cliente.post(f"/worker/pedidos/{ana}/reservar", headers=WAUTH)
check("a primeira reserva leva", r1.status_code == 200, r1.status_code)
check("a segunda leva 409", r2.status_code == 409, r2.status_code)
check("e o pedido está imprimindo", status_de(ana) == "imprimindo")
r = cliente.post(f"/admin/pedidos/{ana}/imprimir", headers=AUTH)
check("imprimir de novo no meio da impressão = 409", r.status_code == 409, r.text[:80])
r = cliente.post(f"/worker/pedidos/{ana}/concluir", headers=WAUTH,
                 json={"mensagem": "CUPS em 10.0.0.5 aceitou", "falhas": 0})
check("concluir leva", r.status_code == 200)
check("e o pedido fica impresso", status_de(ana) == "impresso")
check("com a hora", storage.get_order(ana)["impresso_em"])
r = cliente.post(f"/worker/pedidos/{ana}/concluir", headers=WAUTH, json={})
check("concluir duas vezes = 409", r.status_code == 409)
publico = cliente.get(f"/orders/{ana}").json()
check("a resposta crua do CUPS não vai pro cliente",
      "impressao_msg" not in publico and "10.0.0.5" not in str(publico), publico)
check("mas o admin vê",
      "10.0.0.5" in cliente.get(f"/admin/pedidos/{ana}", headers=AUTH).json()["impressao_msg"])

# --- 6. o worker de ponta a ponta ---------------------------------------------
bruno = semear("Bruno Lima", "bb")
storage.mark_notified(bruno)
carla = semear("Carla Reis", "cc")
storage.mark_notified(carla)
cliente.post(f"/admin/pedidos/{bruno}/imprimir", headers=AUTH)

worker.uma_volta(api)
check("o worker imprime o que está na fila", impressos == [f"pedido-{bruno}.pdf"], impressos)
check("e conta que saiu", status_de(bruno) == "impresso")
check("com a resposta do CUPS",
      storage.get_order(bruno)["impressao_msg"] == "request id is fila-de-teste-1")
check("e adianta o PDF de quem só avisou que pagou",
      os.path.exists(os.path.join(pdf_generator.OUTPUT_DIR, f"pedido-{carla}.pdf")))
check("sem imprimir esse", status_de(carla) == "notified" and len(impressos) == 1)
worker.uma_volta(api)
check("outra volta não imprime de novo", len(impressos) == 1, impressos)

# --- 7. a impressora recusa -----------------------------------------------------
cliente.post(f"/admin/pedidos/{carla}/imprimir", headers=AUTH)
recusar.append(1)
worker.uma_volta(api)
check("recusa do CUPS vira erro_impressao", status_de(carla) == "erro_impressao")
check("com o motivo", "pausada" in (storage.get_order(carla)["impressao_msg"] or ""))
link = urlsplit(site.fulfillment.print_url(carla))
pagina = cliente.get(f"/orders/{carla}/impressao?{link.query}")
check("a página do link mostra a recusa", pagina.status_code == 502
      and "recusou" in pagina.text, pagina.status_code)
r = cliente.post(f"/admin/pedidos/{carla}/imprimir", headers=AUTH)
check("tentar de novo volta pra fila", r.status_code == 200 and status_de(carla) == "a_imprimir")
check("e limpa o erro anterior", storage.get_order(carla)["impressao_msg"] is None)
worker.uma_volta(api)
check("e agora sai", status_de(carla) == "impresso"
      and impressos[-1] == f"pedido-{carla}.pdf", impressos)

# --- 8. a rede cai depois do CUPS aceitar ---------------------------------------
davi = semear("Davi Nunes", "dd")
cliente.post(f"/admin/pedidos/{davi}/imprimir", headers=AUTH)
api.cair_em = "/concluir"
antes = len(impressos)
worker.uma_volta(api)
check("imprimiu uma vez", len(impressos) == antes + 1)
check("o site ainda acha que está imprimindo", status_de(davi) == "imprimindo")
worker.uma_volta(api)
check("na volta seguinte o relato chega", status_de(davi) == "impresso")
check("sem imprimir de novo", len(impressos) == antes + 1, impressos)

# --- 9. folha combinada -----------------------------------------------------------
eva, fabio = semear("Eva Souza", "ee", 4), semear("Fabio Dias", "ff", 2)
combo = cliente.post("/admin/combos", data={"ids": f"{eva},{fabio}"},
                     headers=AUTH).json()
r = cliente.post(f"/admin/combos/{combo['id']}/imprimir", headers=AUTH)
check("a folha combinada entra na fila", r.status_code == 200, r.text[:80])
fila = cliente.get("/worker/fila", headers=WAUTH).json()
check("a fila traz o combo, não os pedidos soltos",
      fila["imprimir"] == [{"tipo": "combo", "id": combo["id"]}], fila)
antes = len(impressos)
worker.uma_volta(api)
check("o worker imprime a folha combinada uma vez",
      impressos[antes:] == [f"combo-{combo['id']}.pdf"], impressos[antes:])
check("os dois pedidos saem impressos",
      status_de(eva) == "impresso" and status_de(fabio) == "impresso")
estado = cliente.get(f"/admin/combos/{combo['id']}", headers=AUTH).json()
check("e o combo também", estado["status"] == "impresso", estado.get("status"))
r = cliente.post(f"/admin/pedidos/{eva}/status", data={"status": "notified"},
                 headers=AUTH)
check("tirar um pedido do combo da fila solta ele do combo",
      storage.get_order(eva)["impressao_combo"] is None)

# --- 10. o painel pede, o laço monta ------------------------------------------
gil = semear("Gil Rocha", "gg")
storage.mark_notified(gil)
caminho_gil = os.path.join(pdf_generator.OUTPUT_DIR, f"pedido-{gil}.pdf")
worker.pedir_montagem("pedido", gil, refazer=True)
check("pedido do painel fica na fila do laço",
      worker.montagem("pedido", gil)["estado"] == "na-fila")
antes = len(impressos)
worker.atender_painel(api)
check("o laço monta o que o painel pediu", os.path.exists(caminho_gil))
check("e o painel vê a folha pronta",
      worker.montagem("pedido", gil)["estado"] == "pronto")
check("montar pelo painel não imprime nada", len(impressos) == antes)
check("nem tira o pedido de onde estava", status_de(gil) == "notified")
conferir = cliente.get("/worker/conferir", headers=WAUTH).json()
check("a lista de conferir traz quem avisou que pagou",
      gil in [p["id"] for p in conferir["pedidos"]])
check("e as folhas combinadas recentes, com os nomes",
      any(c["id"] == combo["id"] and "Eva Souza" in c["nomes"]
          for c in conferir["combos"]), conferir["combos"])
check("sem XML nenhum", "xml_text" not in str(conferir))
check("a lista de conferir é do worker",
      cliente.get("/worker/conferir").status_code == 401)

# --- 11. batida -------------------------------------------------------------------
worker.tinta.estado = lambda: {"estado": "baixo", "nivel": 12, "marcadores": [],
                               "fonte": "impressora"}
worker.tinta.diagnostico = lambda: {"fila": "fila-de-teste", "informa_nivel": True}
worker.printer.list_queues = lambda: {"filas": ["fila-de-teste"],
                                      "printer_queue_configurada": "fila-de-teste"}
worker.batida(api)
tinta = cliente.get("/impressora/tinta").json()
check("a tinta pública é a que o worker contou", tinta["estado"] == "baixo"
      and tinta["nivel"] == 12, tinta)
sessao = cliente.get("/admin/sessao", headers=AUTH).json()
check("o admin sabe que o worker está no ar", sessao["worker"]["visto_em"], sessao)
check("e qual fila ele usa", sessao["impressora"] == "fila-de-teste", sessao)
check("as filas do CUPS chegam no admin",
      cliente.get("/admin/printers", headers=AUTH).json()["filas"] == ["fila-de-teste"])

if falhas:
    print(f"\n{len(falhas)} checagem(ns) falharam.")
    sys.exit(1)
print("\ntudo certo")
