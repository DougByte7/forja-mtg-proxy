"""
Arte que a pessoa sobe do próprio computador: no disco do servidor, ou no
Vercel Blob quando o site roda na Vercel.

O ARQUIVO É GUARDADO PELO CONTEÚDO. O nome dele é o sha256 dos bytes: a mesma
imagem subida duas vezes — no mesmo deck, em outro, ou num deck duplicado — é
um arquivo só no disco, e o id (`enviada:<sha256>`, ver `arte_id`) já diz qual
é, sem tabela nenhuma.

NADA AQUI APAGA ARQUIVO. O id vai pro XML do pedido, e o PDF é montado
depois: no aviso de pagamento, de novo no "montar do zero", e no PDF
combinado. Um arquivo apagado porque a pessoa trocou a arte ou apagou o deck
viraria "FALHA NO DOWNLOAD" num pedido já pago. Limpar exige cruzar os decks
com os pedidos, e isso fica pra quando o disco pedir.

ONDE MORA. Sem `BLOB_READ_WRITE_TOKEN`, no disco (`ARTES_ENVIADAS_DIR`), como
sempre: o navegador manda o arquivo pro site num POST só. Com ele, no Vercel
Blob — porque na Vercel o disco some com o processo, e porque uma função de
lá não aceita corpo maior que 4,5 MB. O navegador sobe o arquivo DIRETO pro
Blob, com um token que o site assina pra um caminho só (`iniciar_envio`), e
depois avisa o site (`registrar_do_blob`), que baixa, confere igual, gera a
miniatura e anota o endereço na tabela `artes_enviadas`, pelo sha256. O id
da arte é o mesmo nos dois casos, e `GET /artes/enviadas/{sha}` atende os
dois (o do Blob redireciona).

SÓ DUAS PROPORÇÕES ENTRAM: a da carta (63 x 88 mm) e a do gabarito da MPC,
com sangria. São as duas que o `sangria.crop_bleed` desenha no tamanho
certo; qualquer outra sairia esticada no papel, e é melhor recusar na subida
do que descobrir na folha.
"""
import hashlib
import io
import os
import re
import sqlite3
import time
import uuid

from PIL import Image, UnidentifiedImageError

from . import blob, db

DIR = os.environ.get("ARTES_ENVIADAS_DIR", "/app/data/artes-enviadas")
TAMANHO_MAXIMO_MB = int(os.environ.get("ARTE_ENVIADA_MAX_MB", "30"))
TAMANHO_MAXIMO = TAMANHO_MAXIMO_MB * 1024 * 1024
# Teto em pixels, conferido antes de decodificar. O gabarito da MPC a 1200 DPI
# tem 14,5 milhões; isto deixa folga pra quem exporta maior e barra a imagem
# feita pra estourar a memória na hora de abrir.
PIXELS_MAXIMOS = 60_000_000
# Abaixo disto a arte ganha o aviso de baixa resolução. É o DPI do PNG da
# Scryfall, o menor que ainda sai com o texto da carta nítido no papel.
DPI_SEM_AVISO = 300
LARGURA_MINIATURA = 500
TIPOS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}

_SHA = re.compile(r"^[0-9a-f]{64}$")
# Onde o navegador sobe o original no Blob. O nome é aleatório: o sha só se
# conhece depois de o site baixar e conferir.
PREFIXO_BLOB = "artes-enviadas/"
DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")


# ---------------------------------------------------------------------------
# A tabela do Blob (sha -> endereço). Fica no banco dos pedidos, e não no
# descartável: o id da arte vai pro XML do pedido e precisa achar o arquivo
# na hora de imprimir, semanas depois.
# ---------------------------------------------------------------------------

def _conn():
    return db.pedidos(DB_PATH)


def criar_tabela(conn=None) -> None:
    proprio = conn is None
    conn = conn or _conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artes_enviadas (
                sha TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                miniatura_url TEXT,
                tipo TEXT,
                tamanho INTEGER,
                em REAL
            )""")
        conn.commit()
    finally:
        if proprio:
            conn.close()


def _registro(sha: str) -> dict | None:
    """O que a tabela sabe deste sha, ou None. Tabela que ainda não existe
    (banco novo, ninguém migrou) é "não sabe nada"."""
    if not _SHA.match(sha or ""):
        return None
    conn = _conn()
    try:
        linha = conn.execute(
            "SELECT url, miniatura_url, tipo FROM artes_enviadas WHERE sha=?",
            (sha,)).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()
    return ({"url": linha[0], "miniatura_url": linha[1], "tipo": linha[2]}
            if linha else None)


def url(sha: str) -> str | None:
    """Endereço do original no Blob, ou None se ele mora no disco."""
    reg = _registro(sha)
    return reg["url"] if reg else None


def url_miniatura(sha: str) -> str | None:
    reg = _registro(sha)
    return reg["miniatura_url"] if reg else None


def caminho(sha: str) -> str | None:
    """Onde o original mora. `None` = não é um sha — o que vem da URL só vira
    caminho de disco passando por aqui."""
    return os.path.join(DIR, sha) if _SHA.match(sha or "") else None


def caminho_miniatura(sha: str) -> str | None:
    base = caminho(sha)
    return base + ".miniatura.jpg" if base else None


def existe(sha: str) -> bool:
    base = caminho(sha)
    return bool(base) and (os.path.isfile(base) or _registro(sha) is not None)


def tipo(sha: str) -> str:
    """O tipo do original NO DISCO, lido do cabeçalho: o arquivo é guardado
    sem extensão, porque o nome dele é o conteúdo."""
    with open(caminho(sha), "rb") as f:
        inicio = f.read(12)
    if inicio.startswith(b"\x89PNG"):
        return TIPOS["PNG"]
    if inicio[:4] == b"RIFF" and inicio[8:12] == b"WEBP":
        return TIPOS["WEBP"]
    return TIPOS["JPEG"]


def _gravar(destino: str, dados: bytes) -> None:
    parcial = destino + ".part"
    with open(parcial, "wb") as f:
        f.write(dados)
    os.replace(parcial, destino)


def validar(dados: bytes) -> dict:
    """Confere a imagem e prepara a miniatura, sem guardar nada.

    Devolve `{sha, dpi, baixa_resolucao, tipo, miniatura}` (a miniatura em
    bytes JPEG). Levanta `ValueError` com a razão em português, pra tela
    mostrar como veio.
    """
    # Import local: o `sangria` é leve, mas o import circular com o
    # `pdf_generator` (que lê o disco por este módulo) fica mais simples assim.
    from . import sangria as pg

    if not dados:
        raise ValueError("O arquivo veio vazio.")
    if len(dados) > TAMANHO_MAXIMO:
        raise ValueError(f"O arquivo passa de {TAMANHO_MAXIMO_MB} MB.")
    try:
        img = Image.open(io.BytesIO(dados))
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError):
        raise ValueError("Não consegui abrir esse arquivo como imagem.")
    if img.format not in TIPOS:
        raise ValueError("Use uma imagem PNG, JPG ou WebP.")
    largura, altura = img.size
    if largura * altura > PIXELS_MAXIMOS:
        raise ValueError("A imagem é grande demais.")

    proporcao = largura / altura
    if abs(proporcao - pg.TRIM_RATIO) <= pg.BLEED_RATIO_TOL:
        largura_da_carta = largura
    elif abs(proporcao - pg.FULL_RATIO) <= pg.BLEED_RATIO_TOL:
        largura_da_carta = largura * (1 - 2 * pg.BLEED_X_FRAC)
    else:
        raise ValueError("A imagem precisa estar no formato da carta "
                         "(63 × 88 mm), com ou sem sangria.")
    dpi = round(largura_da_carta / pg.MPC_TRIM_W_IN)

    # A miniatura sai antes de gravar o original: é ela que decodifica a
    # imagem inteira, e assim arquivo truncado não chega ao disco. Sem a
    # sangria, que é como a carta sai no papel.
    try:
        mini = pg.crop_bleed(pg.sem_transparencia(img), "enviada")
        mini.thumbnail((LARGURA_MINIATURA, LARGURA_MINIATURA * 2), Image.LANCZOS)
        saida = io.BytesIO()
        mini.save(saida, format="JPEG", quality=85)
    except (OSError, ValueError, SyntaxError):
        raise ValueError("Não consegui ler essa imagem — o arquivo pode estar "
                         "corrompido.")

    return {"sha": hashlib.sha256(dados).hexdigest(), "dpi": dpi,
            "baixa_resolucao": dpi < DPI_SEM_AVISO,
            "tipo": TIPOS[img.format], "miniatura": saida.getvalue()}


def _resposta(conferida: dict) -> dict:
    from . import arte_id
    return {"arte_id": arte_id.enviada(conferida["sha"]),
            "dpi": conferida["dpi"],
            "baixa_resolucao": conferida["baixa_resolucao"]}


def guardar(dados: bytes) -> dict:
    """Confere, guarda NO DISCO e devolve `{arte_id, dpi, baixa_resolucao}`.

    Levanta `ValueError` com a razão em português, pra tela mostrar como veio.
    """
    conferida = validar(dados)
    sha = conferida["sha"]
    os.makedirs(DIR, exist_ok=True)
    if not os.path.isfile(caminho(sha)):
        _gravar(caminho(sha), dados)
    if not os.path.isfile(caminho_miniatura(sha)):
        _gravar(caminho_miniatura(sha), conferida["miniatura"])
    return _resposta(conferida)


# ---------------------------------------------------------------------------
# Pelo Vercel Blob
# ---------------------------------------------------------------------------

def iniciar_envio() -> dict:
    """O que o navegador precisa pra subir o arquivo: `{"modo": "direto"}`
    (POST de sempre, pro disco) ou, com o Blob ligado, o endereço da API, o
    caminho e um token que só serve pra ESTE caminho, este tamanho e imagem.
    """
    if not blob.ligado():
        return {"modo": "direto"}
    pathname = f"{PREFIXO_BLOB}{uuid.uuid4().hex}"
    return {"modo": "blob", "api": blob.API, "api_version": blob.API_VERSION,
            "pathname": pathname,
            "token": blob.token_cliente(pathname, maximo_bytes=TAMANHO_MAXIMO,
                                        tipos=sorted(set(TIPOS.values()))),
            "maximo_bytes": TAMANHO_MAXIMO}


def registrar_do_blob(endereco: str) -> dict:
    """O navegador terminou de subir: confere o arquivo e anota o endereço.

    Só aceita endereço PÚBLICO desta loja, debaixo do prefixo das artes — é
    a porta contra quem mande o site baixar outra coisa. Arquivo que não
    passa na conferência (ou que é a mesma imagem de uma que já existe) é
    apagado do Blob; o que passa vira o original daquele sha.
    """
    if not blob.ligado():
        raise ValueError("O envio direto pro armazenamento está desligado.")
    if not blob.da_loja(endereco, PREFIXO_BLOB):
        raise ValueError("Esse endereço não é de um arquivo enviado aqui.")
    dados = blob.baixar(endereco, TAMANHO_MAXIMO)
    try:
        conferida = validar(dados)
    except ValueError:
        blob.apagar([endereco])
        raise
    sha = conferida["sha"]
    if _registro(sha):
        # A mesma imagem já estava guardada: fica a que já existia.
        blob.apagar([endereco])
        return _resposta(conferida)
    mini = blob.enviar(f"{PREFIXO_BLOB}{sha}.miniatura.jpg",
                       conferida["miniatura"], "image/jpeg", sobrescrever=True)
    conn = _conn()
    try:
        def gravar(c):
            c.execute("INSERT INTO artes_enviadas (sha, url, miniatura_url, "
                      "tipo, tamanho, em) VALUES (?,?,?,?,?,?) "
                      "ON CONFLICT(sha) DO NOTHING",
                      (sha, endereco, mini.get("url"), conferida["tipo"],
                       len(dados), time.time()))
            c.commit()
        try:
            gravar(conn)
        except sqlite3.OperationalError as e:
            if "no such table" not in str(e):
                raise
            criar_tabela(conn)
            gravar(conn)
    finally:
        conn.close()
    return _resposta(conferida)
