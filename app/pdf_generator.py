"""
Monta o PDF A4 (3x3 por página) pra impressão, baixando as imagens direto
do Google Drive usando os IDs que já estão no XML do MPC Fill.

As artes vêm no gabarito de impressão da MPC, maior que a carta: cada uma
tem a sangria recortada aqui antes de entrar na folha, senão a carta sai
menor que os 63x88 mm (veja `_crop_bleed`).

AVISO: baixar imagens do Google Drive por link direto não é uma API oficial
suportada — funciona bem na maioria dos casos, mas pode falhar por limite de
taxa. As artes do MPC Fill são PNGs de ~10 MB cada, então o download é a
parte lenta e frágil daqui: cada imagem é baixada UMA vez por pedido (mesmo
aparecendo em vários slots), em paralelo, com tentativas e espera crescente.
Se isso começar a dar problema com pedidos grandes, o caminho mais robusto é
migrar pra API oficial do Google Drive com uma service account.
"""
import io
import os
import shutil
import tempfile
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from PIL import Image
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from reportlab import rl_config
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

# O reportlab embute os JPEGs sem recomprimir (o stream sai como DCTDecode, a
# imagem passa intacta), mas por padrão ele codifica cada stream em ASCII85 —
# que é texto, e infla os bytes em exatamente 1,25x. Num PDF que é quase só
# imagem, isso é 25% de peso morto sem um pixel de qualidade em troca, e num
# pedido grande são dezenas de MB atravessando o túnel à toa. Desligar deixa
# o stream binário, que todo leitor de PDF entende, e ainda corta o tempo de
# montagem — codificar em A85 é a parte cara do `drawImage`.
rl_config.useA85 = 0

CARD_W = 63 * mm
CARD_H = 88 * mm
COLS, ROWS = 3, 3
PAGE_W, PAGE_H = A4
OUTPUT_DIR = os.environ.get("PDF_OUTPUT_DIR", "/tmp")

# --- Sangria (bleed) do MPC Fill ---
# A arte que o MPC Fill guarda no Drive está no gabarito de IMPRESSÃO da
# MakePlayingCards, que é maior que a carta: 2,72 x 3,70 pol (69,1 x 94,0 mm),
# sendo 0,12 pol (3,05 mm) de sangria em CADA borda. Na fábrica esse contorno
# vai embora no refile e sobram os 2,48 x 3,46 pol (63 x 88 mm) do meio.
#
# Desenhar a arte inteira dentro do slot de 63 x 88 mm — que era o que este
# arquivo fazia — imprime a sangria junto e portanto ENCOLHE a carta: o
# desenho que deveria medir 63 x 88 mm sai com 57,5 x 82,4 mm, e ainda
# espremido, porque a sangria come 4,4% da largura contra 3,2% da altura.
#
# A correção é recortar a sangria de cada imagem antes de ela entrar no PDF,
# cada uma pelo seu próprio tamanho em pixels — as artes não vêm todas na
# mesma resolução, então o recorte é uma FRAÇÃO das dimensões da imagem, não
# um número fixo de pixels.
MPC_FULL_W_IN, MPC_FULL_H_IN = 2.72, 3.70   # gabarito com sangria
MPC_TRIM_W_IN, MPC_TRIM_H_IN = 2.48, 3.46   # o que sobra do refile
BLEED_X_FRAC = (MPC_FULL_W_IN - MPC_TRIM_W_IN) / 2 / MPC_FULL_W_IN  # 4,41%
BLEED_Y_FRAC = (MPC_FULL_H_IN - MPC_TRIM_H_IN) / 2 / MPC_FULL_H_IN  # 3,24%
FULL_RATIO = MPC_FULL_W_IN / MPC_FULL_H_IN  # 0,7351 — com sangria
TRIM_RATIO = MPC_TRIM_W_IN / MPC_TRIM_H_IN  # 0,7168 — já cortada
# Quanto a proporção da imagem pode fugir do gabarito e ainda ser tratada
# como gabarito. As duas proporções acima diferem em 0,019, então 0,01 separa
# uma da outra com folga e ainda deixa de fora arte de origem esquisita.
BLEED_RATIO_TOL = float(os.environ.get("BLEED_RATIO_TOL", "0.01"))
# 0 desliga o recorte e volta o comportamento antigo (arte inteira, com
# sangria, espremida no slot). Só serve pra comparar impressões.
CROP_BLEED = os.environ.get("CROP_BLEED", "1") == "1"

# Qualidade do JPEG que vai dentro do PDF. As imagens do Drive já são JPEG,
# então recomprimir sempre perde um pouco — 95 com subamostragem desligada
# (4:4:4) deixa essa perda invisível, que é o que se quer em papel
# fotográfico. Subamostragem é o que borra borda fina e texto pequeno de
# carta, então fica desligada de propósito.
JPEG_QUALITY = int(os.environ.get("JPEG_QUALITY", "95"))

# Reamostragem opcional. As artes do MPC Fill vêm com ~3264 px de largura,
# que viram ~2976 px depois de tirada a sangria: ~1200 DPI em 63 mm, umas 4x
# mais do que qualquer jato de tinta resolve. Reduzir pra 600 DPI corta o PDF
# em ~4x (o que importa quando o arquivo volta pro navegador por um túnel
# doméstico) e acelera bastante o
# JPEG, sem diferença visível no papel. 0 = desligado, mantém o original.
PRINT_DPI = float(os.environ.get("PRINT_DPI", "0"))

# --- Download das imagens ---
# DRIVE_READ_TIMEOUT vale por trecho recebido, não pelo download inteiro —
# ou seja, é um detector de conexão MORTA, não um orçamento de lentidão: ele
# só dispara depois de tantos segundos sem chegar UM byte. Download lento não
# esbarra nele por mais demorado que seja, então não adianta aumentar quando
# der timeout; se estourar, a conexão travou de vez — `diag_rede.py`, rodado
# de dentro do container, mostra onde.
DRIVE_CONNECT_TIMEOUT = float(os.environ.get("DRIVE_CONNECT_TIMEOUT", "15"))
DRIVE_READ_TIMEOUT = float(os.environ.get("DRIVE_READ_TIMEOUT", "60"))
# Teto de tempo por imagem somando TODAS as tentativas. Sem isso, uma conexão
# que trava toda vez custa 4 x DRIVE_READ_TIMEOUT antes de desistir, e o
# pedido inteiro fica pendurado por minutos sem nunca ir a lugar nenhum.
DRIVE_TOTAL_TIMEOUT = float(os.environ.get("DRIVE_TOTAL_TIMEOUT", "180"))
DRIVE_RETRIES = int(os.environ.get("DRIVE_RETRIES", "4"))
DRIVE_BACKOFF = float(os.environ.get("DRIVE_BACKOFF", "2"))  # segundos, dobra a cada erro
# Quantas imagens baixam ao mesmo tempo. Poucas de propósito: o gargalo é o
# limite de taxa do Drive, e subir muito aqui piora em vez de melhorar.
DRIVE_WORKERS = int(os.environ.get("DRIVE_WORKERS", "4"))
_CHUNK = 256 * 1024

# --- Guias de corte (mesma ideia do proxyprint.taxiera.net) ---
# As marcas ficam FORA das cartas, nas margens da folha, alinhadas com cada
# divisa da grade 3x3. A régua (ou o refile) apoia em duas marcas opostas e
# corta a folha inteira de uma vez, sem tinta nenhuma na carta.
#
# GUIDE_LENGTH_MM: comprimento de cada marca. 0 = automático, que estende a
#   linha da divisa até a borda do papel (é o "Extended Guides" do proxyprint).
# CARD_OUTLINE: 1 volta a desenhar a moldura em volta de cada carta, do jeito
#   antigo. Fica desligado porque essa linha cai exatamente em cima da borda
#   da arte — cortando nela sobra um fiapo preto na carta.
GUIDE_LENGTH_MM = float(os.environ.get("GUIDE_LENGTH_MM", "0"))
GUIDE_THICKNESS_MM = float(os.environ.get("GUIDE_THICKNESS_MM", "0.2"))
GUIDE_GRAY = float(os.environ.get("GUIDE_GRAY", "0"))  # 0 = preto, 1 = branco
CARD_OUTLINE = os.environ.get("CARD_OUTLINE", "0") == "1"

# --- Cruzes-guia nos cantos das cartas ---
# Um "+" centrado em cada cruzamento da grade, ou seja, em cada canto de
# carta. Diferente das marcas acima, essas ficam POR CIMA da arte: são elas
# que dizem o ponto exato onde os dois cortes se encontram, o que ajuda a
# não sair torto quando a folha entrou meio enviesada na impressora.
# O verde forte é de propósito — destaca em cima de arte escura e some
# depois do corte.
CROSS_COLOR = os.environ.get("CROSS_COLOR", "#8aff0c")
CROSS_ARM_MM = float(os.environ.get("CROSS_ARM_MM", "3"))  # cada braço do "+"
CROSS_THICKNESS_MM = float(os.environ.get("CROSS_THICKNESS_MM", "0.2"))
CORNER_CROSSES = os.environ.get("CORNER_CROSSES", "1") == "1"


def _margins():
    margin_x = (PAGE_W - CARD_W * COLS) / 2
    margin_y = (PAGE_H - CARD_H * ROWS) / 2
    return margin_x, margin_y


def _grid_lines():
    """Coordenadas das divisas da grade: 4 verticais e 4 horizontais."""
    margin_x, margin_y = _margins()
    xs = [margin_x + i * CARD_W for i in range(COLS + 1)]
    ys = [margin_y + i * CARD_H for i in range(ROWS + 1)]
    return xs, ys


def _draw_cut_guides(c):
    """Marcas de corte nas margens, alinhadas com cada divisa da grade."""
    xs, ys = _grid_lines()
    left, right = xs[0], xs[-1]
    bottom, top = ys[0], ys[-1]
    length = GUIDE_LENGTH_MM * mm

    c.saveState()
    c.setLineWidth(GUIDE_THICKNESS_MM * mm)
    c.setStrokeGray(GUIDE_GRAY)
    c.setLineCap(0)

    for x in xs:  # marcas acima e abaixo do bloco de cartas
        c.line(x, top, x, top + length if length else PAGE_H)
        c.line(x, bottom, x, bottom - length if length else 0)
    for y in ys:  # marcas à esquerda e à direita do bloco
        c.line(left, y, left - length if length else 0, y)
        c.line(right, y, right + length if length else PAGE_W, y)

    c.restoreState()


def _draw_corner_crosses(c):
    """Cruz-guia em cada canto de carta (todo cruzamento da grade)."""
    xs, ys = _grid_lines()
    arm = CROSS_ARM_MM * mm

    c.saveState()
    c.setLineWidth(CROSS_THICKNESS_MM * mm)
    c.setStrokeColor(HexColor(CROSS_COLOR))
    c.setLineCap(0)

    for x in xs:
        for y in ys:
            c.line(x - arm, y, x + arm, y)
            c.line(x, y - arm, x, y + arm)

    c.restoreState()


def _make_session() -> requests.Session:
    """Sessão com pool de conexões e retentativa no aperto de mão. A
    retentativa do urllib3 só cobre até os cabeçalhos chegarem; cair no meio
    do corpo é tratado no laço de `_download`."""
    session = requests.Session()
    # `read=0` de propósito: cair no meio do corpo é o caso comum aqui e quem
    # trata é o laço de `_download`. Deixar as duas camadas retentando faz o
    # número de tentativas se multiplicar e o pedido travar por minutos.
    retry = Retry(total=2, connect=2, read=0, status=2,
                  backoff_factor=DRIVE_BACKOFF,
                  status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=frozenset(["GET"]))
    adapter = HTTPAdapter(max_retries=retry,
                          pool_connections=DRIVE_WORKERS,
                          pool_maxsize=DRIVE_WORKERS)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def _backoff(drive_id: str, attempt: int, error: Exception, deadline: float) -> None:
    """Espera antes da próxima tentativa, sem passar do teto do download."""
    delay = min(DRIVE_BACKOFF * (2 ** (attempt - 1)),
                max(0.0, deadline - time.monotonic()))
    print(f"[pdf_generator] {drive_id}: tentativa {attempt}/{DRIVE_RETRIES} "
          f"falhou ({error}); tentando de novo em {delay:g}s")
    time.sleep(delay)


def _download(session: requests.Session, drive_id: str) -> bytes:
    """Baixa um arquivo do Drive, tentando de novo se a conexão cair.

    Vai direto no `drive.usercontent.google.com` com `confirm=t`: é pra onde
    o velho `drive.google.com/uc` redireciona, e o `confirm` já pula a tela
    de "não conseguimos verificar se tem vírus" que aparece em arquivo
    grande — sem isso o Drive devolve um HTML e o Pillow estoura com um erro
    que não diz nada sobre a causa real.
    """
    url = ("https://drive.usercontent.google.com/download"
           f"?id={drive_id}&export=download&confirm=t")
    deadline = time.monotonic() + DRIVE_TOTAL_TIMEOUT
    last_error = None

    for attempt in range(1, DRIVE_RETRIES + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            read_timeout = min(DRIVE_READ_TIMEOUT, remaining)
            with session.get(url, stream=True, timeout=(DRIVE_CONNECT_TIMEOUT,
                                                        read_timeout)) as resp:
                resp.raise_for_status()
                if "text/html" in resp.headers.get("Content-Type", ""):
                    raise RuntimeError(
                        "o Drive devolveu uma página HTML em vez do arquivo — "
                        "normalmente é limite de taxa ou o arquivo não está "
                        "compartilhado com 'qualquer pessoa com o link'")
                buf = io.BytesIO()
                for chunk in resp.iter_content(_CHUNK):
                    buf.write(chunk)
                    if time.monotonic() > deadline:
                        raise RuntimeError(
                            f"passou de DRIVE_TOTAL_TIMEOUT ({DRIVE_TOTAL_TIMEOUT:g}s) "
                            f"com {buf.tell() / 1e6:.1f} MB baixados")
            data = buf.getvalue()
            if not data:
                raise RuntimeError("o Drive devolveu uma resposta vazia")
            return data
        except requests.HTTPError as e:
            # 404/403 é id errado ou arquivo não compartilhado: insistir não
            # muda nada. Só o 429 (limite de taxa) e o 408 valem retentativa.
            status = e.response.status_code if e.response is not None else None
            if status and 400 <= status < 500 and status not in (408, 429):
                raise
            last_error = e
            if attempt < DRIVE_RETRIES:
                _backoff(drive_id, attempt, e, deadline)
        except Exception as e:
            last_error = e
            if attempt < DRIVE_RETRIES:
                _backoff(drive_id, attempt, e, deadline)

    raise last_error


def _crop_bleed(img: Image.Image, drive_id: str) -> Image.Image:
    """Tira a sangria do gabarito da MPC, deixando só o que sobra do refile.

    A decisão é POR IMAGEM, pela proporção dela, porque nem todo arquivo que
    aparece num pedido veio do gabarito:

    * proporção de gabarito (2,72 x 3,70) -> recorta 4,41% da largura e 3,24%
      da altura em cada borda, e o que sobra é exatamente a carta;
    * proporção de carta (2,48 x 3,46) -> passa intacta; a arte já veio
      cortada e recortar de novo comeria a borda do desenho;
    * qualquer outra proporção -> passa intacta e avisa no log. É arte de
      fora do MPC Fill, e chutar recorte nela estraga mais do que conserta.

    O recorte é em fração, não em pixels fixos: as artes chegam em resoluções
    diferentes e cada uma tem que ser cortada na sua própria escala.
    """
    if not CROP_BLEED:
        return img

    ratio = img.width / img.height
    if abs(ratio - TRIM_RATIO) <= abs(ratio - FULL_RATIO):
        return img
    if abs(ratio - FULL_RATIO) > BLEED_RATIO_TOL:
        print(f"[pdf_generator] {drive_id}: proporção {ratio:.4f} "
              f"({img.width}x{img.height}) não bate com o gabarito do MPC Fill "
              f"({FULL_RATIO:.4f}) nem com a carta cortada ({TRIM_RATIO:.4f}); "
              f"desenhando sem recorte")
        return img

    left = round(img.width * BLEED_X_FRAC)
    top = round(img.height * BLEED_Y_FRAC)
    return img.crop((left, top, img.width - left, img.height - top))


def _prepare_image(session: requests.Session, drive_id: str, cache_dir: str) -> str:
    """Baixa, tira a sangria, converte pra JPEG e devolve o caminho no cache
    do pedido.

    Converter em disco antes de desenhar mantém a memória sob controle: as
    artes chegam como PNG de 3264x4440, o que daria ~58 MB por imagem se
    todas ficassem descompactadas na RAM."""
    path = os.path.join(cache_dir, f"{drive_id}.jpg")
    img = Image.open(io.BytesIO(_download(session, drive_id))).convert("RGB")
    # Antes do reamostrar: depois daqui a imagem cobre exatamente CARD_W x
    # CARD_H, que é o que a conta de DPI abaixo assume.
    img = _crop_bleed(img, drive_id)

    if PRINT_DPI > 0:
        # Teto em pixels pro tamanho físico da carta. Só encolhe: imagem que
        # já vem menor que o alvo passa intacta, porque ampliar não inventa
        # detalhe nenhum, só engorda o arquivo.
        alvo_w = int(CARD_W / mm / 25.4 * PRINT_DPI)
        alvo_h = int(CARD_H / mm / 25.4 * PRINT_DPI)
        if img.width > alvo_w or img.height > alvo_h:
            img.thumbnail((alvo_w, alvo_h), Image.LANCZOS)

    partial = path + ".part"
    img.save(partial, format="JPEG", quality=JPEG_QUALITY,
             subsampling=0, optimize=True)
    os.replace(partial, path)
    return path


def _fetch_all(drive_ids: list[str], cache_dir: str, on_progress=None) -> dict:
    """Baixa cada drive_id UMA vez, em paralelo.

    A fila de impressão repete o mesmo id em cada slot — um playset de 4
    cópias aparece 4 vezes, e o verso costuma se repetir no pedido inteiro.
    Baixar por slot, como era antes, multiplicava por 4 uns 10 MB à toa e era
    justamente o que fazia o Drive começar a estrangular.

    Devolve `{drive_id: caminho_do_jpeg}` pros que deram certo e
    `{drive_id: exceção}` pros que falharam — quem falhou vira uma carta
    "FALHA NO DOWNLOAD" no PDF em vez de derrubar o pedido todo.
    """
    unique = list(dict.fromkeys(drive_ids))
    if not unique:
        return {}

    results = {}
    session = _make_session()
    workers = max(1, min(DRIVE_WORKERS, len(unique)))
    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_prepare_image, session, d, cache_dir): d
                       for d in unique}
            for future in as_completed(futures):
                drive_id = futures[future]
                try:
                    results[drive_id] = future.result()
                except Exception as e:
                    results[drive_id] = e
                    print(f"[pdf_generator] erro baixando {drive_id}: {e}")
                if on_progress:
                    on_progress(len(results), len(unique))
    finally:
        session.close()

    ok = sum(1 for v in results.values() if isinstance(v, str))
    print(f"[pdf_generator] {ok}/{len(unique)} imagem(ns) distinta(s) baixada(s) "
          f"({len(drive_ids)} slot(s) na folha)")
    return results


def _slots_of(card: ET.Element) -> list[int]:
    """Índices de slot de um <card>, ignorando lixo e espaço em branco."""
    text = card.findtext("slots") or ""
    partes = (parte.strip() for parte in text.split(","))
    return [int(parte) for parte in partes if parte.isdigit()]


def _build_print_queue(root: ET.Element):
    """Lista ordenada de drive_ids: primeiro os fronts (por slot), depois
    os versos especiais (backs), que também precisam ser impressos e
    recortados/colados à parte.

    Os backs são expandidos POR SLOT, igual aos fronts: um <card> de verso
    com `slots` `0,1,2,3` é uma carta dupla-face pedida em 4 cópias, e cada
    cópia física precisa do seu próprio verso no papel. Antes daqui saía uma
    cópia só por <card>, enquanto o `calc.parse_order` já contava (e cobrava)
    slot a slot — ou seja, o cliente pagava 4 versos e recebia 1.
    """
    front_items = []
    for card in root.findall("fronts/card"):
        drive_id = (card.findtext("id") or "").strip()
        if drive_id:
            front_items.extend((s, drive_id) for s in _slots_of(card))

    back_items = []
    for card in root.findall("backs/card"):
        drive_id = (card.findtext("id") or "").strip()
        if drive_id:
            back_items.extend((s, drive_id) for s in _slots_of(card))

    front_items.sort(key=lambda t: t[0])
    back_items.sort(key=lambda t: t[0])

    return ([drive_id for _, drive_id in front_items]
            + [drive_id for _, drive_id in back_items])


def _draw_failure(c, x, y, drive_id: str):
    """Carta que não baixou. Fica bem visível de propósito: esse PDF é
    conferido na tela antes de ir pro papel, então a falha tem que saltar
    aos olhos em vez de virar um quadrado quase vazio."""
    c.saveState()
    c.setFillColorRGB(0.98, 0.90, 0.88)
    c.rect(x, y, CARD_W, CARD_H, stroke=0, fill=1)
    c.setFillColorRGB(0.75, 0.20, 0.10)
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(x + CARD_W / 2, y + CARD_H / 2 + 6, "FALHA NO DOWNLOAD")
    c.setFont("Helvetica", 6)
    c.drawCentredString(x + CARD_W / 2, y + CARD_H / 2 - 8, drive_id[:28])
    c.restoreState()


def generate_pdf(xml_text: str, order_id: str, on_progress=None) -> tuple[str, int]:
    """Monta o PDF e devolve `(caminho, quantidade_de_imagens_que_falharam)`."""
    root = ET.fromstring(xml_text)
    print_queue = _build_print_queue(root)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, f"pedido-{order_id}.pdf")

    # Cache de imagens só deste pedido: some no fim, dê certo ou não. Fica
    # dentro do OUTPUT_DIR pra não vazar pro /tmp do container e pra ficar no
    # mesmo sistema de arquivos.
    cache_dir = tempfile.mkdtemp(prefix=f"imgs-{order_id}-", dir=OUTPUT_DIR)
    inicio = time.monotonic()
    try:
        images = _fetch_all(print_queue, cache_dir, on_progress)

        c = canvas.Canvas(out_path, pagesize=A4)
        c.setTitle(f"Forja de Proxies — pedido {order_id}")
        margin_x, margin_y = _margins()
        per_page = COLS * ROWS
        failures = 0
        # Um ImageReader por imagem distinta: assim o reportlab embute o
        # JPEG uma vez só e as cópias repetidas apenas apontam pra ele, em
        # vez de engordar o PDF a cada slot.
        readers = {}

        for page_start in range(0, len(print_queue), per_page):
            page_items = print_queue[page_start:page_start + per_page]
            for i, drive_id in enumerate(page_items):
                col, row = i % COLS, i // COLS
                x = margin_x + col * CARD_W
                y = PAGE_H - margin_y - (row + 1) * CARD_H
                result = images.get(drive_id)
                if isinstance(result, str):
                    try:
                        reader = readers.get(drive_id)
                        if reader is None:
                            reader = readers[drive_id] = ImageReader(result)
                        # A imagem já veio sem sangria de `_crop_bleed`, ou
                        # seja, é a carta de 63 x 88 mm inteira e nada mais:
                        # esticar até o slot é o tamanho certo, não um zoom.
                        c.drawImage(reader, x, y, width=CARD_W, height=CARD_H)
                    except Exception as e:
                        failures += 1
                        _draw_failure(c, x, y, drive_id)
                        print(f"[pdf_generator] erro desenhando {drive_id}: {e}")
                else:
                    failures += 1
                    _draw_failure(c, x, y, drive_id)
                if CARD_OUTLINE:
                    c.rect(x, y, CARD_W, CARD_H)
            _draw_cut_guides(c)
            if CORNER_CROSSES:
                _draw_corner_crosses(c)
            c.showPage()

        c.save()
        print(f"[pdf_generator] pedido {order_id} pronto em "
              f"{time.monotonic() - inicio:.0f}s — "
              f"{os.path.getsize(out_path) / 1e6:.0f} MB, "
              f"{len(print_queue)} carta(s), {failures} falha(s)")
        return out_path, failures
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)
