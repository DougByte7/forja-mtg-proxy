"""
Arte que a pessoa sobe do próprio computador, guardada no disco do servidor.

O ARQUIVO É GUARDADO PELO CONTEÚDO. O nome dele é o sha256 dos bytes: a mesma
imagem subida duas vezes — no mesmo deck, em outro, ou num deck duplicado — é
um arquivo só no disco, e o id (`enviada:<sha256>`, ver `arte_id`) já diz qual
é, sem tabela nenhuma.

NADA AQUI APAGA ARQUIVO. O id vai pro XML do pedido, e o PDF é montado
depois: no aviso de pagamento, de novo no "montar do zero", e no PDF
combinado. Um arquivo apagado porque a pessoa trocou a arte ou apagou o deck
viraria "FALHA NO DOWNLOAD" num pedido já pago. Limpar exige cruzar os decks
com os pedidos, e isso fica pra quando o disco pedir.

SÓ DUAS PROPORÇÕES ENTRAM: a da carta (63 x 88 mm) e a do gabarito da MPC,
com sangria. São as duas que o `pdf_generator._crop_bleed` desenha no tamanho
certo; qualquer outra sairia esticada no papel, e é melhor recusar na subida
do que descobrir na folha.
"""
import hashlib
import io
import os
import re

from PIL import Image, UnidentifiedImageError

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


def caminho(sha: str) -> str | None:
    """Onde o original mora. `None` = não é um sha — o que vem da URL só vira
    caminho de disco passando por aqui."""
    return os.path.join(DIR, sha) if _SHA.match(sha or "") else None


def caminho_miniatura(sha: str) -> str | None:
    base = caminho(sha)
    return base + ".miniatura.jpg" if base else None


def existe(sha: str) -> bool:
    base = caminho(sha)
    return bool(base) and os.path.isfile(base)


def tipo(sha: str) -> str:
    """O tipo do original, lido do cabeçalho: o arquivo é guardado sem
    extensão, porque o nome dele é o conteúdo."""
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


def guardar(dados: bytes) -> dict:
    """Confere, guarda e devolve `{arte_id, dpi, baixa_resolucao}`.

    Levanta `ValueError` com a razão em português, pra tela mostrar como veio.
    """
    # Import local: o `pdf_generator` lê o disco por este módulo, e as medidas
    # do gabarito e o recorte da sangria moram lá.
    from . import arte_id
    from . import pdf_generator as pg

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
        mini = pg._crop_bleed(pg._sem_transparencia(img), "enviada")
        mini.thumbnail((LARGURA_MINIATURA, LARGURA_MINIATURA * 2), Image.LANCZOS)
        saida = io.BytesIO()
        mini.save(saida, format="JPEG", quality=85)
    except (OSError, ValueError, SyntaxError):
        raise ValueError("Não consegui ler essa imagem — o arquivo pode estar "
                         "corrompido.")

    sha = hashlib.sha256(dados).hexdigest()
    os.makedirs(DIR, exist_ok=True)
    if not existe(sha):
        _gravar(caminho(sha), dados)
    if not os.path.isfile(caminho_miniatura(sha)):
        _gravar(caminho_miniatura(sha), saida.getvalue())
    return {"arte_id": arte_id.enviada(sha), "dpi": dpi,
            "baixa_resolucao": dpi < DPI_SEM_AVISO}
