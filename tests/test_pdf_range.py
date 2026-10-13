"""
Confere como o PDF montado volta pro navegador — hoje pelo painel do worker
da impressora (`worker/painel.py`, `GET /pdf/{tipo}/{id}`), que é o único
lugar onde a folha é vista antes de ir pro papel.

Não é sobre montar a folha — é sobre os bytes voltarem de um jeito que o
visualizador consiga usar. O arquivo é grande (centenas de MB num pedido
grande), então duas coisas mudam "lento" pra "parece travado", e é isso que
está travado aqui:

1. **Range.** Sem `Accept-Ranges` e sem 206, o visualizador não consegue ler o
   índice no fim do arquivo pra desenhar a primeira página antes do resto:
   ele baixa tudo e só então mostra alguma coisa, e conexão que cai recomeça
   do zero. O `FileResponse` do Starlette 0.38 não faz isso sozinho, então
   quem faz é o `worker/entrega.py` — se alguém trocar de volta por um
   FileResponse pelado, estes testes caem.
2. **Revalidação.** ETag: 304 enquanto o arquivo for o mesmo, bytes novos
   depois do "Refazer".

E o resto do painel: a senha, a lista que vem do site, e o "Montar" que só
deixa pedido na fila do laço do worker (quem monta é sempre o laço).

    python tests/test_pdf_range.py
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

SENHA = "senha-do-painel"
os.environ["PDF_OUTPUT_DIR"] = tempfile.mkdtemp()
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["FORJA_API_URL"] = "http://site-de-teste"
os.environ["WORKER_PAINEL_SENHA"] = SENHA

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from worker import main as worker  # noqa: E402
from worker.painel import criar_app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


pedido = "abc12345"


class ApiFalsa:
    """O site, do jeito que o painel o vê: só a lista de conferir."""
    fora = False

    def get(self, caminho):
        if self.fora:
            raise ConnectionError("site fora (dublê)")
        assert caminho == "/worker/conferir", caminho
        return {"pedidos": [{"id": pedido, "status": "notified",
                             "customer_name": "Ana <Prado>", "pages": 1,
                             "lamination": "single", "deck_hash": "abc123"},
                            {"id": "naomontado", "status": "a_imprimir",
                             "customer_name": "Bruno", "pages": 2,
                             "lamination": "double", "deck_hash": "def456"}],
                "combos": []}


def basic(usuario, senha):
    import base64
    return {"Authorization": "Basic " + base64.b64encode(
        f"{usuario}:{senha}".encode()).decode()}


api = ApiFalsa()
cliente = TestClient(criar_app(api), headers=basic("qualquer", SENHA))
sem_senha = TestClient(criar_app(api))

# O "PDF": conteúdo qualquer, só precisa ser reconhecível byte a byte. O
# worker considera pronto todo arquivo que existe sem o marcador
# `.incompleto` do lado.
CORPO = bytes(range(256)) * 40          # 10 240 bytes
CAMINHO = worker._caminho("pedido", pedido)
Path(CAMINHO).write_bytes(CORPO)

URL = f"/pdf/pedido/{pedido}"

# --- 1. a porta ----------------------------------------------------------
check("sem senha = 401", sem_senha.get(URL).status_code == 401)
check("e pede usuário e senha ao navegador",
      "Basic" in sem_senha.get(URL).headers.get("www-authenticate", ""))
check("senha errada = 401",
      TestClient(criar_app(api), headers=basic("x", "chute")).get(URL).status_code == 401)
check("a lista também é fechada", sem_senha.get("/").status_code == 401)

# --- 2. resposta inteira -------------------------------------------------
r = cliente.get(URL)
etag = r.headers.get("etag")
check("200 com o arquivo inteiro",
      r.status_code == 200 and r.content == CORPO, r.status_code)
check("anuncia Accept-Ranges",
      r.headers.get("accept-ranges") == "bytes", r.headers.get("accept-ranges"))
check("tem ETag", bool(etag), etag)
check("abre inline no navegador",
      "inline" in r.headers.get("content-disposition", ""),
      r.headers.get("content-disposition"))
check("cache revalidado, não proibido",
      "no-store" not in r.headers.get("cache-control", "")
      and "must-revalidate" in r.headers.get("cache-control", ""),
      r.headers.get("cache-control"))

# --- 3. as faixas --------------------------------------------------------
r = cliente.get(URL, headers={"Range": "bytes=0-99"})
check("faixa do começo = 206",
      r.status_code == 206 and r.content == CORPO[:100], r.status_code)
check("Content-Range do começo",
      r.headers.get("content-range") == f"bytes 0-99/{len(CORPO)}",
      r.headers.get("content-range"))
check("Content-Length é o do pedaço",
      r.headers.get("content-length") == "100", r.headers.get("content-length"))

# É assim que o visualizador de PDF procura o índice: os últimos N bytes.
r = cliente.get(URL, headers={"Range": "bytes=-50"})
check("sufixo pega o FIM do arquivo",
      r.status_code == 206 and r.content == CORPO[-50:], r.status_code)
check("Content-Range do sufixo",
      r.headers.get("content-range") == f"bytes {len(CORPO)-50}-{len(CORPO)-1}/{len(CORPO)}",
      r.headers.get("content-range"))

r = cliente.get(URL, headers={"Range": "bytes=10000-"})
check("faixa aberta vai até o fim",
      r.status_code == 206 and r.content == CORPO[10000:], r.status_code)

r = cliente.get(URL, headers={"Range": f"bytes=0-{len(CORPO) + 500}"})
check("fim além do arquivo é aparado, não recusado",
      r.status_code == 206 and r.content == CORPO,
      f"{r.status_code} {r.headers.get('content-range')}")

# --- 4. o que não dá pra atender ----------------------------------------
r = cliente.get(URL, headers={"Range": "bytes=999999-"})
check("faixa fora do arquivo = 416", r.status_code == 416, r.status_code)
check("416 diz o tamanho real",
      r.headers.get("content-range") == f"bytes */{len(CORPO)}",
      r.headers.get("content-range"))

# Várias faixas de uma vez: mandar o arquivo inteiro é resposta legítima e
# poupa o multipart/byteranges, que ninguém aqui precisa.
r = cliente.get(URL, headers={"Range": "bytes=0-9,20-29"})
check("multi-faixa cai pro arquivo inteiro",
      r.status_code == 200 and r.content == CORPO, r.status_code)

r = cliente.get(URL, headers={"Range": "cartas=0-9"})
check("unidade desconhecida cai pro arquivo inteiro",
      r.status_code == 200 and r.content == CORPO, r.status_code)

# --- 5. reabrir não paga de novo ----------------------------------------
r = cliente.get(URL, headers={"If-None-Match": etag})
check("mesmo arquivo = 304 sem corpo",
      r.status_code == 304 and not r.content, f"{r.status_code} {len(r.content)}B")

r = cliente.get(URL, headers={"If-None-Match": '"outra-coisa"'})
check("ETag diferente = manda os bytes",
      r.status_code == 200 and r.content == CORPO, r.status_code)

# If-Range: retomar um download só vale se for o MESMO arquivo. Se o "Refazer
# PDF" remontou a folha no meio, emendar pedaços de dois arquivos daria um PDF
# corrompido — melhor mandar inteiro e o cliente começar de novo.
r = cliente.get(URL, headers={"Range": "bytes=0-99", "If-Range": etag})
check("If-Range batendo = retoma o pedaço", r.status_code == 206, r.status_code)

r = cliente.get(URL, headers={"Range": "bytes=0-99", "If-Range": '"velho"'})
check("If-Range diferente = arquivo inteiro",
      r.status_code == 200 and r.content == CORPO, r.status_code)

# --- 6. remontar a folha invalida o cache -------------------------------
NOVO = CORPO[::-1]
Path(CAMINHO).write_bytes(NOVO)
os.utime(CAMINHO, (0, 0))  # mtime diferente, garantido
r = cliente.get(URL, headers={"If-None-Match": etag})
check("PDF remontado não volta 304",
      r.status_code == 200 and r.content == NOVO, r.status_code)
check("e o ETag mudou", r.headers.get("etag") != etag, r.headers.get("etag"))

# --- 7. o que não é folha não sai ---------------------------------------
check("folha não montada = 404",
      cliente.get("/pdf/pedido/naomontado").status_code == 404)
check("tipo inventado = 404", cliente.get(f"/pdf/outro/{pedido}").status_code == 404)
check("id com cara de caminho = 404",
      cliente.get("/pdf/pedido/..%2F..%2Fetc").status_code == 404)

# --- 8. a lista ----------------------------------------------------------
r = cliente.get("/")
check("a lista abre", r.status_code == 200, r.status_code)
check("com o nome escapado (veio do cliente)",
      "Ana &lt;Prado&gt;" in r.text and "Ana <Prado>" not in r.text)
check("folha pronta tem Ver PDF", f'href="/pdf/pedido/{pedido}"' in r.text)
check("e a não montada tem Montar", f'action="/montar/pedido/naomontado"' in r.text)
api.fora = True
r = cliente.get("/")
check("site fora: a página abre e diz o que houve",
      r.status_code == 200 and "Não consegui falar com o site" in r.text)
api.fora = False

# --- 9. Montar só deixa na fila do laço ---------------------------------
r = cliente.post("/montar/pedido/naomontado", data={"refazer": "0"},
                 follow_redirects=False)
check("Montar volta pra lista (303)", r.status_code == 303, r.status_code)
check("e deixa o pedido na fila do laço",
      worker._pedidos_do_painel.get_nowait() == ("pedido", "naomontado", False))
check("e acorda o laço", worker._acordar.is_set())
check("a lista mostra que está na fila",
      "Na fila do worker" in cliente.get("/").text)
check("montar tipo inventado = 404",
      cliente.post("/montar/outro/x", data={"refazer": "0"}).status_code == 404)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
