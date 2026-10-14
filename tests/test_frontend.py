"""
Confere como as telas em Preact (`front/`) saem pelo FastAPI.

MOTIVO DE EXISTIR. O HTML do build é o que amarra a página aos assets com
hash no nome. Se ele vier do cache do navegador depois de um deploy, aponta
pra arquivos que não existem mais e a tela abre em branco — sem erro no
servidor, só na frente de quem abriu. Por isso o `no-cache` é conferido aqui.
E clone sem build não pode virar 500 com traceback: tem de dizer o comando.

Não precisa do build nem de Node: o `dist` é de mentira, numa pasta
temporária.

    python tests/test_frontend.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-frontend-")
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

from app import frontend  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


c = TestClient(app)

print("--- sem build ---")
frontend.DIST = Path(TMP) / "dist-vazio"
r = c.get("/entrar")
check("/entrar sem build responde 503", r.status_code == 503, r.status_code)
check("e diz o comando que falta", "pnpm build" in r.text)

print("\n--- com build ---")
frontend.DIST = Path(TMP) / "dist"
(frontend.DIST / "pages").mkdir(parents=True)
(frontend.DIST / "pages" / "login.html").write_text(
    '<!DOCTYPE html><script src="/dist/assets/login-abc123.js"></script>',
    encoding="utf-8")
r = c.get("/entrar")
check("/entrar serve o HTML do build", r.status_code == 200
      and "login-abc123.js" in r.text, r.status_code)
check("como HTML", r.headers["content-type"].startswith("text/html"))
check("com no-cache", r.headers.get("cache-control") == "no-cache",
      r.headers.get("cache-control"))

# Cada rota aponta pra tela certa do build: trocar o nome de um entry no
# vite.config.ts sem trocar aqui é tela em branco (503) só naquela rota.
TELAS = {"/entrar": "login", "/cadastro": "signup", "/meus-decks": "decks",
         "/admin": "admin", "/": "home", "/deckbuilder": "deckbuilder"}
for nome in TELAS.values():
    (frontend.DIST / "pages" / f"{nome}.html").write_text(
        f"<!DOCTYPE html><title>{nome}</title>", encoding="utf-8")
for rota, nome in TELAS.items():
    r = c.get(rota)
    check(f"{rota} serve a tela {nome}", r.status_code == 200
          and f"<title>{nome}</title>" in r.text, r.status_code)

for antigo in ("entrar.html", "cadastro.html", "decks.html", "admin.html",
               "index.html", "deckbuilder.html", "deckbuilder/abertura.js"):
    check(f"/{antigo} antigo não existe mais",
          c.get(f"/{antigo}").status_code == 404)

print()
if falhas:
    print(f"{len(falhas)} falha(s): {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
