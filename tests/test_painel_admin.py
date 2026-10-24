"""
Confere a tela de pedidos no painel do worker (`worker/painel.py`).

MOTIVO DE EXISTIR. A tela de pedidos saiu do site: só o painel, na rede de
casa, a serve, e repassa as chamadas dela pro site. O repasse é onde mora o
risco — a senha do painel (`Authorization`) não pode ir junto pro site, e o
`X-Admin-Token` do operador tem de ir. O "site" aqui é um servidor HTTP de
mentira, que guarda o que recebeu.

    python tests/test_painel_admin.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-painel-admin-")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["PDF_OUTPUT_DIR"] = TMP
os.environ["WORKER_PAINEL_SENHA"] = "senha-do-painel"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

recebido = []


class Site(BaseHTTPRequestHandler):
    def _responder(self):
        tamanho = int(self.headers.get("content-length") or 0)
        recebido.append((self.command, self.path,
                         {k.lower(): v for k, v in self.headers.items()},
                         self.rfile.read(tamanho)))
        ok = self.headers.get("x-admin-token") == "tok"
        self.send_response(200 if ok else 401)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    do_GET = do_POST = do_DELETE = _responder

    def log_message(self, *args):
        pass


site = HTTPServer(("127.0.0.1", 0), Site)
threading.Thread(target=site.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{site.server_port}"

from app import frontend  # noqa: E402
from worker import main as worker  # noqa: E402
from worker import painel  # noqa: E402

frontend.DIST = Path(TMP) / "dist"
(frontend.DIST / "pages").mkdir(parents=True)
(frontend.DIST / "assets").mkdir()
(frontend.DIST / "pages" / "admin.html").write_text(
    "<!DOCTYPE html><title>admin</title>", encoding="utf-8")
(frontend.DIST / "assets" / "admin-abc123.js").write_text("1", encoding="utf-8")

c = TestClient(painel.criar_app(worker.Api(BASE, "token-do-worker")))
SENHA = ("operador", "senha-do-painel")
TOKEN = {"X-Admin-Token": "tok"}

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHOU'} {nome} {detalhe if not condicao else ''}")
    if not condicao:
        falhas.append(nome)


check("sem a senha do painel, nada", c.get("/admin").status_code == 401)
r = c.get("/admin", auth=SENHA)
check("/admin serve a tela do build", r.status_code == 200
      and "<title>admin</title>" in r.text, r.status_code)
check("com no-cache", r.headers.get("cache-control") == "no-cache")
check("e os assets dela", c.get("/dist/assets/admin-abc123.js",
                                auth=SENHA).status_code == 200)

r = c.get("/admin/pedidos?status=notified", auth=SENHA, headers=TOKEN)
check("GET repassado com a resposta do site", r.status_code == 200
      and r.json() == {"ok": True}, r.status_code)
metodo, caminho, cabecalhos, _ = recebido[-1]
check("no mesmo caminho, com a busca", caminho == "/admin/pedidos?status=notified",
      caminho)
check("leva o token do operador", cabecalhos.get("x-admin-token") == "tok")
check("e não a senha do painel", "authorization" not in cabecalhos, cabecalhos)

r = c.post("/admin/pedidos/p1/status", auth=SENHA, headers=TOKEN,
           data={"status": "impresso"})
metodo, caminho, cabecalhos, corpo = recebido[-1]
check("POST de formulário repassado inteiro", r.status_code == 200
      and metodo == "POST" and corpo == b"status=impresso"
      and cabecalhos.get("content-type", "").startswith(
          "application/x-www-form-urlencoded"), (metodo, corpo))

r = c.delete("/decks/abc", auth=SENHA, headers={"X-Admin-Token": "errado"})
check("token errado: o 401 do site chega na tela", r.status_code == 401
      and recebido[-1][:2] == ("DELETE", "/decks/abc"), r.status_code)

r = c.get("/deckbuilder?deck=abc", auth=SENHA, follow_redirects=False)
check("Abrir um deck leva pro deckbuilder do site", r.status_code == 302
      and r.headers["location"] == f"{BASE}/deckbuilder?deck=abc",
      r.headers.get("location"))

site.shutdown()
r = c.get("/admin/sessao", auth=SENHA, headers=TOKEN)
check("site fora: 502, sem traceback", r.status_code == 502, r.status_code)

print()
if falhas:
    print(f"{len(falhas)} falha(s): {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
