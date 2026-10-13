"""
Confere o veredito do `GET /admin/fontes` (`app/diagnostico.py`): a rota que
diz se as fontes de fora respondem a este servidor depois de mudar de lugar.

O que importa é não confundir as coisas: 404 é a fonte respondendo (chegamos
nela); 403/429/503 e o desafio da Cloudflare são bloqueio; e sem resposta
nenhuma é "fora". Sem rede: as respostas são de mentira.

    python tests/test_diagnostico.py
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))
TMP = tempfile.mkdtemp()
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["ADMIN_TOKEN"] = "adm"

import requests  # noqa: E402

from app import diagnostico  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def resposta(status, corpo="", **cab):
    r = requests.Response()
    r.status_code = status
    r._content = corpo.encode()
    r.headers.update({"content-type": "text/html", **cab})
    return r


check("200 responde", diagnostico._veredito(resposta(200))[0] == "responde")
check("404 também: a fonte respondeu que não tem",
      diagnostico._veredito(resposta(404))[0] == "responde")
check("403 é bloqueio", diagnostico._veredito(resposta(403))[0] == "bloqueado")
check("429 é bloqueio", diagnostico._veredito(resposta(429))[0] == "bloqueado")
check("o desafio da Cloudflare é bloqueio, mesmo com 200",
      diagnostico._veredito(resposta(200, "<title>Just a moment...</title>"))
      == ("bloqueado", "desafio da Cloudflare"))
check("e pelo cabeçalho também",
      diagnostico._veredito(resposta(403, "", **{"cf-mitigated": "challenge"}))[1]
      == "desafio da Cloudflare")
check("500 é erro, não bloqueio", diagnostico._veredito(resposta(500))[0] == "erro")

respostas = {"ligamagic": resposta(200), "moxfield": resposta(403)}


def get_falso(url, **kw):
    for fonte in diagnostico._fontes():
        if fonte["url"] == url:
            if fonte["id"] == "cambio":
                raise requests.ConnectionError("sem rota (dublê)")
            return respostas.get(fonte["id"], resposta(200))
    raise AssertionError(url)


diagnostico.requests.get = get_falso
r = diagnostico.testar_fontes()
por = {f["fonte"]: f["situacao"] for f in r["fontes"]}
check("uma linha por fonte", set(por) == {"ligamagic", "scryfall", "edhrec",
                                          "spellbook", "mpcfill", "archidekt",
                                          "moxfield", "cambio"}, por)
check("o bloqueio aparece na fonte certa", por["moxfield"] == "bloqueado", por)
check("sem resposta é fora", por["cambio"] == "fora", por)
check("e o resumo diz que nem todas respondem", r["todas_respondem"] is False)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

cliente = TestClient(app)
check("a rota é do admin", cliente.get("/admin/fontes").status_code == 401)
check("com o token, responde",
      cliente.get("/admin/fontes", headers={"X-Admin-Token": "adm"}).status_code == 200)

if falhas:
    print(f"\n{len(falhas)} checagem(ns) falharam.")
    sys.exit(1)
print("\ntudo certo")
