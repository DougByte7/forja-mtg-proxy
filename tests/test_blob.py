"""
Confere a arte enviada pelo Vercel Blob (`app/blob.py` e o caminho do Blob
em `app/artes_enviadas.py`).

Na Vercel o arquivo não passa pelo site: o navegador sobe direto pro Blob com
um token que o site assina, e depois avisa. O que se trava aqui:

1. **O token.** No formato que o Blob aceita (o mesmo do `@vercel/blob`), preso
   a UM caminho, a um tamanho e a tipos de imagem, e assinado com o token de
   escrita — que nunca vai pro navegador.
2. **A porta.** O site só baixa endereço público DESTA loja, debaixo do prefixo
   das artes: mandar o site buscar outra coisa não pode funcionar.
3. **A mesma conferência do envio direto.** Imagem fora de formato é recusada
   e apagada do Blob; a mesma imagem duas vezes fica uma só.
4. **O id é o mesmo.** `enviada:<sha>` serve igual, e `GET /artes/enviadas/...`
   redireciona pro Blob — inclusive pro worker da impressora.

O Blob é um dublê em memória (sem rede).

    python tests/test_blob.py
"""
import base64
import hashlib
import hmac
import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp()
TOKEN_RW = "vercel_blob_rw_Loja123abc_segredoDeEscrita"
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["ARTES_ENVIADAS_DIR"] = os.path.join(TMP, "enviadas")
os.environ["BLOB_READ_WRITE_TOKEN"] = TOKEN_RW

try:
    from fastapi.testclient import TestClient
    from PIL import Image
except ImportError:
    print("PULADO: fastapi/Pillow não estão instalados")
    sys.exit(0)

os.chdir(RAIZ)

import conta_clerk  # noqa: E402  (antes do app: põe a chave no ambiente)
from app import (arte_id, artes, artes_enviadas, blob, cartas, decks,  # noqa: E402
                 storage)
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def imagem(w, h, formato="PNG", cor=(30, 60, 200)):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), cor).save(buf, format=formato)
    return buf.getvalue()


# --- o Blob de mentira ----------------------------------------------------------
HOST = "https://loja123abc.public.blob.vercel-storage.com/"
guardados: dict[str, bytes] = {}
apagados: list[str] = []


def baixar(url, maximo):
    return guardados[url][:maximo + 1]


def enviar(pathname, dados, content_type, sobrescrever=False):
    url = HOST + pathname
    guardados[url] = dados
    return {"url": url, "pathname": pathname}


def apagar(urls):
    apagados.extend(urls)
    for u in urls:
        guardados.pop(u, None)


blob.baixar, blob.enviar, blob.apagar = baixar, enviar, apagar


def navegador_sobe(pathname, dados):
    """O que o `subirProBlob` do deckbuilder faz, do lado do Blob."""
    url = HOST + pathname
    guardados[url] = dados
    return url


# --- 1. o token -------------------------------------------------------------------
tok = blob.token_cliente("artes-enviadas/x", maximo_bytes=1000,
                         tipos=["image/png"], validade_segundos=60)
prefixo, loja, corpo = tok.split("_")[2], tok.split("_")[3], tok.split("_")[4]
check("o token é de cliente, da loja certa",
      tok.startswith("vercel_blob_client_") and loja == "Loja123abc", tok[:40])
assinatura, payload = base64.b64decode(corpo).decode().split(".")
dados_token = json.loads(base64.b64decode(payload))
check("preso ao caminho, ao tamanho e ao tipo",
      (dados_token["pathname"], dados_token["maximumSizeInBytes"],
       dados_token["allowedContentTypes"]) == ("artes-enviadas/x", 1000, ["image/png"]),
      dados_token)
check("não sobrescreve nem sorteia sufixo",
      dados_token["allowOverwrite"] is False and dados_token["addRandomSuffix"] is False)
check("vence em pouco tempo",
      0 < dados_token["validUntil"] / 1000 - time.time() <= 61, dados_token["validUntil"])
check("assinado com o token de escrita (HMAC-SHA256 do payload)",
      hmac.compare_digest(assinatura, hmac.new(TOKEN_RW.encode(), payload.encode(),
                                               hashlib.sha256).hexdigest()))
check("e o token de escrita não vai dentro dele", "segredoDeEscrita" not in
      base64.b64decode(corpo).decode())

# --- 2. a porta -------------------------------------------------------------------
check("endereço da loja, no prefixo, passa",
      blob.da_loja(HOST + "artes-enviadas/abc", "artes-enviadas/"))
check("outra loja não", not blob.da_loja(
    "https://outra.public.blob.vercel-storage.com/artes-enviadas/abc", "artes-enviadas/"))
check("outro site não", not blob.da_loja("https://exemplo.com/artes-enviadas/abc"))
check("http não", not blob.da_loja(HOST.replace("https", "http") + "artes-enviadas/a"))
check("fora do prefixo não", not blob.da_loja(HOST + "outra-pasta/abc", "artes-enviadas/"))

storage.init_db()
decks.init_db()
cartas.init_db()
artes.init_db()
artes_enviadas.criar_tabela()

ana = conta_clerk.cliente(app, "ana")
deck = decks.criar("Deck da Ana", ["Atraxa"], [{"nome": "Forest", "quantidade": 2}])
decks.reclamar(deck["id"], "ana")
base = f"/decks/{deck['id']}"

r = TestClient(app).post(f"{base}/artes/enviar/inicio")
check("anônimo não pede token", r.status_code == 401, r.status_code)
envio = ana.post(f"{base}/artes/enviar/inicio").json()
check("com o Blob ligado, o modo é blob", envio["modo"] == "blob", envio)
check("num caminho novo debaixo do prefixo",
      envio["pathname"].startswith("artes-enviadas/") and len(envio["pathname"]) > 20)
check("com o teto de tamanho", envio["maximo_bytes"] == artes_enviadas.TAMANHO_MAXIMO)
check("e o token de escrita não sai", TOKEN_RW not in json.dumps(envio))

r = ana.post(f"{base}/artes/enviar/blob",
             json={"url": "https://exemplo.com/qualquer.png", "nome": "Forest"})
check("endereço de fora é recusado (400)", r.status_code == 400, r.status_code)

# --- 3. a conferência ----------------------------------------------------------------
ruim = navegador_sobe(envio["pathname"], imagem(1000, 1000))
r = ana.post(f"{base}/artes/enviar/blob", json={"url": ruim, "nome": "Forest"})
check("imagem fora do formato da carta é recusada",
      r.status_code == 400 and "formato da carta" in r.json()["detail"], r.text[:100])
check("e sai do Blob", ruim in apagados and ruim not in guardados)

envio = ana.post(f"{base}/artes/enviar/inicio").json()
boa = navegador_sobe(envio["pathname"], imagem(745, 1040))
r = ana.post(f"{base}/artes/enviar/blob",
             json={"url": boa, "nome": "Forest", "face": "frente", "copia": 0,
                   "arquivo": "minha arte.png"})
check("imagem boa entra", r.status_code == 200, r.text[:120])
escolha = r.json()["escolha"]
sha = arte_id.sha_da_enviada(escolha["arte_id"])
check("com o id de sempre, pelo conteúdo",
      sha == hashlib.sha256(imagem(745, 1040)).hexdigest())
check("já escolhida como arte da carta",
      artes.do_deck(deck["id"])["forest"]["frente"]["arte_id"] == escolha["arte_id"])
check("com o DPI", escolha["dpi"] == 300, escolha)
check("a miniatura foi pro Blob", any(u.endswith(f"{sha}.miniatura.jpg") for u in guardados))
check("nada no disco", not os.path.exists(artes_enviadas.DIR)
      or not os.listdir(artes_enviadas.DIR))
check("e a arte existe pro resto do sistema", artes_enviadas.existe(sha))

envio = ana.post(f"{base}/artes/enviar/inicio").json()
repetida = navegador_sobe(envio["pathname"], imagem(745, 1040))
r = ana.post(f"{base}/artes/enviar/blob", json={"url": repetida, "nome": "Forest"})
check("a mesma imagem de novo dá o mesmo id",
      r.status_code == 200 and r.json()["escolha"]["arte_id"] == escolha["arte_id"])
check("e a cópia repetida sai do Blob", repetida in apagados)
check("ficando o original de antes", artes_enviadas.url(sha) == boa)

# --- 4. servir --------------------------------------------------------------------
r = ana.get(f"/artes/enviadas/{sha}", follow_redirects=False)
check("o original redireciona pro Blob", r.status_code == 307
      and r.headers["location"] == boa, (r.status_code, r.headers.get("location")))
check("e o redirecionamento pode ficar em cache",
      "immutable" in r.headers.get("cache-control", ""))
r = ana.get(f"/artes/enviadas/{sha}/miniatura", follow_redirects=False)
check("a miniatura também", r.status_code == 307
      and r.headers["location"].endswith(f"{sha}.miniatura.jpg"))
check("sha que não existe = 404",
      ana.get("/artes/enviadas/" + "0" * 64, follow_redirects=False).status_code == 404)

# --- 5. a virada: as artes do disco vão pro Blob ----------------------------------
from app import tarefas  # noqa: E402

velha_pasta = os.path.join(TMP, "do-homelab")
os.makedirs(velha_pasta)
velhas = [imagem(745, 1040, cor=(200, 10, 10)), imagem(745, 1040, "JPEG", cor=(10, 200, 10))]
shas = []
for dados in velhas:
    s_ = hashlib.sha256(dados).hexdigest()
    shas.append(s_)
    Path(velha_pasta, s_).write_bytes(dados)
Path(velha_pasta, shas[0] + ".miniatura.jpg").write_bytes(imagem(100, 140, "JPEG"))
Path(velha_pasta, "f" * 64).write_bytes(b"truncado")      # nome que não bate
Path(velha_pasta, "qualquer.txt").write_bytes(b"lixo")      # nem é arte

contagem = tarefas.artes_pro_blob(velha_pasta)
check("leva as artes do disco pro Blob", contagem["levadas"] == 2, contagem)
check("recusa a que não confere com o nome", contagem["recusadas"] == ["f" * 64])
check("e anota cada uma", all(artes_enviadas.url(s_) for s_ in shas))
check("com a miniatura que já existia, ou gerada",
      all(artes_enviadas.url_miniatura(s_) for s_ in shas))
check("o tipo certo do JPEG",
      artes_enviadas._registro(shas[1])["tipo"] == "image/jpeg")
check("rodar de novo não leva nada outra vez",
      tarefas.artes_pro_blob(velha_pasta)["ja_estavam"] == 2)
check("pelo comando também", tarefas.main(["artes-pro-blob", velha_pasta]) == 0)
check("sem pasta, o comando diz o que falta",
      tarefas.main(["artes-pro-blob"]) == 2)

# --- 6. sem Blob, tudo como antes -------------------------------------------------
os.environ["BLOB_READ_WRITE_TOKEN"] = ""
check("sem o token de escrita, o modo é o direto",
      ana.post(f"{base}/artes/enviar/inicio").json() == {"modo": "direto"})
r = ana.post(f"{base}/artes/enviar/blob", json={"url": boa, "nome": "Forest"})
check("e o caminho do Blob fica fechado", r.status_code == 400, r.status_code)

if falhas:
    print(f"\n{len(falhas)} checagem(ns) falharam.")
    sys.exit(1)
print("\ntudo certo")
