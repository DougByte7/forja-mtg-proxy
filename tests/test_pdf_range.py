"""
Confere como o backend ENTREGA o PDF pronto (`GET /orders/{id}/pdf`).

Não é sobre montar a folha — é sobre os bytes voltarem de um jeito que o
visualizador consiga usar. O arquivo é grande (centenas de MB num pedido
grande) e sobe por um link doméstico, então duas coisas mudam "lento" pra
"parece travado", e é isso que está travado aqui:

1. **Range.** Sem `Accept-Ranges` e sem 206, o visualizador não consegue ler o
   índice no fim do arquivo pra desenhar a primeira página antes do resto:
   ele baixa tudo e só então mostra alguma coisa, e conexão que cai recomeça
   do zero. O `FileResponse` do Starlette 0.38 não faz isso sozinho, então
   quem faz é o `_servir_pdf` — se alguém trocar de volta por um FileResponse
   pelado, estes testes caem.
2. **Revalidação.** Antes era `no-store`, e reabrir o mesmo PDF pagava o
   download inteiro de novo. Agora vale ETag: 304 enquanto o arquivo for o
   mesmo, bytes novos depois do "Refazer PDF".

A montagem em si (Drive, reportlab) fica de fora de propósito: aqui o PDF é
um arquivo qualquer plantado no lugar onde o `fulfillment` procura.

    python tests/test_pdf_range.py
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TOKEN = "token-de-teste-123"
os.environ["ADMIN_TOKEN"] = TOKEN
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "orders.db")
os.environ["PDF_OUTPUT_DIR"] = tempfile.mkdtemp()
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from app import fulfillment, storage  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


storage.init_db()
cliente = TestClient(app)

pedido = storage.create_order(
    "<order><details/></order>", "single", "Ana Prado", "abc123",
    {"total": 12.5, "qty": 9, "backs_count": 0, "pages": 1, "blanks": 0},
)[0]

# O "PDF": conteúdo qualquer, só precisa ser reconhecível byte a byte. O
# `fulfillment` considera pronto todo arquivo que existe sem o marcador
# `.incompleto` do lado.
CORPO = bytes(range(256)) * 40          # 10 240 bytes
Path(fulfillment.pdf_path(pedido)).write_bytes(CORPO)

URL = fulfillment.pdf_url(pedido, base="")
AUTH = {"X-Admin-Token": TOKEN}

# --- 1. a porta continua fechada ----------------------------------------
check("sem token = 401",
      cliente.get(f"/orders/{pedido}/pdf").status_code == 401)
check("token errado = 401",
      cliente.get(f"/orders/{pedido}/pdf?token=chute").status_code == 401)

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
Path(fulfillment.pdf_path(pedido)).write_bytes(NOVO)
os.utime(fulfillment.pdf_path(pedido), (0, 0))  # mtime diferente, garantido
r = cliente.get(URL, headers={"If-None-Match": etag})
check("PDF remontado não volta 304",
      r.status_code == 200 and r.content == NOVO, r.status_code)
check("e o ETag mudou", r.headers.get("etag") != etag, r.headers.get("etag"))

# --- 7. o header de admin também abre -----------------------------------
r = cliente.get(f"/orders/{pedido}/pdf", headers=AUTH)
check("X-Admin-Token serve no lugar do link assinado",
      r.status_code == 200, r.status_code)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
