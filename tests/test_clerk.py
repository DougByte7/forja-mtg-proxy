"""
Confere a porta do Clerk (`app/clerk.py`) e a importação das contas antigas.

O que importa aqui:

* token válido vira o MESMO dicionário que a sessão própria devolve, e o `id`
  dele é o `forja_id` quando existe — é isso que mantém a pessoa dona dos
  decks e pedidos que já eram dela;
* token vencido, de outra chave, de outra origem, pendente ou com algoritmo
  trocado é anônimo, nunca erro;
* o perfil vem do token, e só os conhecidos valem — `admin` abre o painel;
* a sessão própria continua funcionando durante a troca;
* a importação só simula sem `--aplicar`, pula quem já foi e não leva conta
  sem e-mail.

As chaves são geradas aqui: não precisa de rede nem de conta no Clerk.

    python tests/test_clerk.py

Sai com código 1 se qualquer checagem falhar.
"""
import base64
import hashlib
import hmac
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

try:
    import jwt
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: falta PyJWT[crypto] ou fastapi (pip install -r requirements.txt)")
    sys.exit(0)


def par_de_chaves():
    privada = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    publica = privada.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return privada, publica


CHAVE, PUBLICA = par_de_chaves()
OUTRA_CHAVE, _ = par_de_chaves()
ORIGEM = "https://forja.test"

TMP = tempfile.mkdtemp(prefix="teste-clerk-")
os.environ["ADMIN_TOKEN"] = "token-de-teste-clerk"
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["SENHA_ITERACOES"] = "1000"
os.environ["SESSAO_SEGURA"] = "0"
# Como vem de um .env de uma linha só: com `\n` escrito.
os.environ["CLERK_JWT_KEY"] = PUBLICA.replace("\n", "\\n")
os.environ["CLERK_ORIGENS"] = ORIGEM

os.chdir(RAIZ)

from app import cartas, clerk, decks, storage, usuarios  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def token(sub="user_abc", chave=CHAVE, algoritmo="RS256", **extra):
    agora = int(time.time())
    claims = {"sub": sub, "iat": agora, "nbf": agora - 1, "exp": agora + 60,
              "azp": ORIGEM, "email": f"{sub}@exemplo.com", "name": "Fulana",
              **extra}
    return jwt.encode({k: v for k, v in claims.items() if v is not None},
                      chave, algorithm=algoritmo)


def conta(tok):
    return TestClient(app).get(
        "/conta", headers={"Authorization": f"Bearer {tok}"}).json()["usuario"]


DECK = {"nome": "Mudei", "comandantes": [], "cartas": []}

try:
    cartas.init_db()
    decks.init_db()
    storage.init_db()
    usuarios.init_db()

    ana = usuarios.criar("ana@exemplo.com", "senha-da-ana-1", nome="Ana")

    # =====================================================================
    print("\n--- token válido ---")
    # =====================================================================

    eu = conta(token(role="amigo"))
    check("o cabeçalho Bearer entra", eu is not None, eu)
    eq("sem forja_id, o id é o sub", eu["id"], "user_abc")
    eq("o login é o e-mail", eu["login"], "user_abc@exemplo.com")
    eq("o nome vem do token", eu["nome"], "Fulana")
    eq("o perfil vem do token", eu["perfil"], "amigo")

    c = TestClient(app)
    c.cookies.set("__session", token())
    check("o cookie __session também entra",
          (c.get("/conta").json()["usuario"] or {}).get("id") == "user_abc")

    eq("com forja_id, o id é o de antes",
       conta(token(sub="user_ana", forja_id=ana["id"]))["id"], ana["id"])
    eq("perfil desconhecido vale como cliente",
       conta(token(role="dono-do-mundo"))["perfil"], "cliente")
    eq("sem perfil é cliente", conta(token())["perfil"], "cliente")

    # =====================================================================
    print("\n--- token que não vale é anônimo ---")
    # =====================================================================

    agora = int(time.time())
    eq("vencido", conta(token(exp=agora - 60)), None)
    eq("antes da hora", conta(token(nbf=agora + 600)), None)
    eq("sem exp", conta(token(exp=None)), None)
    eq("assinado por outra chave", conta(token(chave=OUTRA_CHAVE)), None)
    eq("de outra origem", conta(token(azp="https://malvado.test")), None)
    eq("sessão pendente", conta(token(sts="pending")), None)
    # A troca clássica: assinar HS256 usando a chave PÚBLICA como segredo.
    # Montado à mão porque o próprio PyJWT se recusa a assinar assim.
    def b64(dados):
        return base64.urlsafe_b64encode(dados).rstrip(b"=").decode()
    cabeca = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    carga = b64(json.dumps({"sub": "x", "exp": agora + 60, "nbf": agora,
                            "azp": ORIGEM}).encode())
    assinatura = b64(hmac.new(PUBLICA.encode(), f"{cabeca}.{carga}".encode(),
                              hashlib.sha256).digest())
    eq("algoritmo trocado pra HS256",
       conta(f"{cabeca}.{carga}.{assinatura}"), None)
    eq("lixo", conta("isto.nao.e-jwt"), None)

    def motivo(tok):
        return TestClient(app).get(
            "/conta", headers={"Authorization": f"Bearer {tok}"}).json().get("clerk")

    check("/conta diz que o token venceu",
          "Expired" in (motivo(token(exp=agora - 60)) or ""))
    check("e que a origem não é das nossas",
          "malvado.test" in (motivo(token(azp="https://malvado.test")) or ""))
    check("e que a assinatura não confere",
          "Signature" in (motivo(token(chave=OUTRA_CHAVE)) or ""))
    eq("sem token não há o que explicar",
       "clerk" in TestClient(app).get("/conta").json(), False)
    eq("token bom não traz motivo", "clerk" in TestClient(app).get(
        "/conta", headers={"Authorization": f"Bearer {token()}"}).json(), False)

    salvo = clerk._CHAVE
    clerk._CHAVE = ""
    eq("sem CLERK_JWT_KEY o Clerk fica desligado", conta(token()), None)
    eq("e o /conta diz isso", motivo(token()), "sem CLERK_JWT_KEY no servidor")
    clerk._CHAVE = salvo

    # =====================================================================
    print("\n--- origens ---")
    # =====================================================================

    eq("sem nada, nenhuma (e a conferência é pulada)",
       clerk.origens_permitidas({}), set())
    eq("as bases do .env, sem barra no fim",
       clerk.origens_permitidas({"PUBLIC_BASE_URL": "https://forja.app/",
                                 "LOCAL_BASE_URL": "http://192.168.1.10:8000"}),
       {"https://forja.app", "http://192.168.1.10:8000"})
    eq("CLERK_ORIGENS manda sobre as bases",
       clerk.origens_permitidas({"CLERK_ORIGENS": "https://a.test, https://b.test",
                                 "PUBLIC_BASE_URL": "https://forja.app"}),
       {"https://a.test", "https://b.test"})
    eq("as URLs da Vercel entram sozinhas",
       clerk.origens_permitidas({"PUBLIC_BASE_URL": "https://forja.app",
                                 "VERCEL_URL": "forja-abc123.vercel.app",
                                 "VERCEL_BRANCH_URL": "forja-git-main.vercel.app",
                                 "VERCEL_PROJECT_PRODUCTION_URL": "forja.vercel.app"}),
       {"https://forja.app", "https://forja-abc123.vercel.app",
        "https://forja-git-main.vercel.app", "https://forja.vercel.app"})

    # =====================================================================
    print("\n--- perfil e dono ---")
    # =====================================================================

    def com(tok):
        c = TestClient(app)
        c.headers["Authorization"] = f"Bearer {tok}"
        return c

    eq("admin pelo Clerk abre o painel",
       com(token(role="admin")).get("/admin/usuarios").status_code, 200)
    eq("cliente pelo Clerk não abre",
       com(token()).get("/admin/usuarios").status_code, 401)

    deck_da_ana = decks.criar("Deck da Ana", dono=ana["id"])["id"]
    eq("a Ana pelo Clerk grava o deck que já era dela",
       com(token(sub="user_ana", forja_id=ana["id"]))
       .put(f"/decks/{deck_da_ana}", json=DECK).status_code, 200)
    eq("outra conta do Clerk não grava",
       com(token(sub="user_outra"))
       .put(f"/decks/{deck_da_ana}", json=DECK).status_code, 403)

    novo = com(token(sub="user_nova")).post("/decks", json={"nome": "Novo"})
    eq("conta nova do Clerk cria deck", novo.status_code, 200)
    eq("e o dono é o sub dela", decks.dono_de(novo.json()["deck"]["id"])[1],
       "user_nova")

    # =====================================================================
    print("\n--- a sessão própria continua valendo ---")
    # =====================================================================

    c_ana = TestClient(app)
    eq("login antigo entra",
       c_ana.post("/conta/entrar", json={"login": "ana@exemplo.com",
                                         "senha": "senha-da-ana-1"}).status_code,
       200)
    eq("e /conta responde com ela", c_ana.get("/conta").json()["usuario"]["id"],
       ana["id"])

    # =====================================================================
    print("\n--- importação ---")
    # =====================================================================

    class Resposta:
        def __init__(self, corpo, status=200):
            self._corpo, self.status_code = corpo, status
            self.ok, self.text = status < 400, str(corpo)

        def json(self):
            return self._corpo

        def raise_for_status(self):
            assert self.ok

    class ClerkFalso:
        def __init__(self, existentes=()):
            self.headers, self.criados = {}, []
            self.existentes = set(existentes)

        def get(self, url, params=None, timeout=None):
            return Resposta([{"id": "x"}] if params["external_id"]
                            in self.existentes else [])

        def post(self, url, json=None, timeout=None):
            self.criados.append(json)
            return Resposta({"id": "user_novo"})

    contas = [
        {"id": "a1", "login": "ana@exemplo.com", "nome": "Ana",
         "perfil": "cliente", "criado_em": 1700000000},
        {"id": "c1", "login": "chefe@exemplo.com", "nome": "Chefe",
         "perfil": "admin", "criado_em": None},
        {"id": "f1", "login": "fulano", "nome": "Fulano", "perfil": "cliente"},
        {"id": "j1", "login": "ja@exemplo.com", "nome": "Já", "perfil": "cliente"},
    ]

    falso = ClerkFalso(existentes={"j1"})
    r = clerk.importar(contas, chave="sk_test", sessao=falso)
    eq("simulação não cria nada", falso.criados, [])
    eq("mas lista quem criaria", r["criadas"],
       ["ana@exemplo.com (amigo)", "chefe@exemplo.com (admin)"])
    eq("login sem e-mail fica de fora", r["sem_email"], ["fulano"])
    eq("quem já existe é pulado", r["ja_existiam"], ["ja@exemplo.com"])
    eq("a chave vai no cabeçalho", falso.headers.get("Authorization"),
       "Bearer sk_test")

    falso = ClerkFalso(existentes={"j1"})
    clerk.importar(contas, aplicar=True, chave="sk_test", sessao=falso)
    eq("aplicando, cria as duas", len(falso.criados), 2)
    corpo = falso.criados[0]
    eq("com o id de antes no external_id", corpo["external_id"], "a1")
    eq("e no forja_id", corpo["public_metadata"]["forja_id"], "a1")
    eq("cliente vira amigo", corpo["public_metadata"]["role"], "amigo")
    eq("admin continua admin", falso.criados[1]["public_metadata"]["role"],
       "admin")
    check("sem senha", corpo["skip_password_requirement"] is True)
    eq("o e-mail vai como lista", corpo["email_address"], ["ana@exemplo.com"])
    eq("a data de criação é preservada", corpo["created_at"],
       "2023-11-14T22:13:20Z")
    check("sem criado_em, não manda data", "created_at" not in falso.criados[1])

    try:
        clerk.importar(contas, chave="", sessao=ClerkFalso())
        check("sem CLERK_SECRET_KEY recusa", False)
    except RuntimeError:
        check("sem CLERK_SECRET_KEY recusa", True)

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
