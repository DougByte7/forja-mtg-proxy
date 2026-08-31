"""
Confere o recorte da sangria do MPC Fill e o tamanho final da carta no PDF.

Motivo de existir: a arte do MPC Fill vem no gabarito de impressão da
MakePlayingCards (2,72 x 3,70 pol), maior que a carta. Se a sangria não for
recortada, a carta sai com 57,5 x 82,4 mm no papel em vez de 63 x 88 mm — um
erro que só aparece de régua na mão, depois de imprimir. Este teste mede isso
sem gastar papel: monta um PDF de verdade e lê de volta o tamanho com que cada
imagem foi desenhada.

Não precisa de pytest nem de rede — as imagens são sintéticas e o download é
substituído. Rode de dentro da raiz do projeto:

    python tests/test_bleed.py

Sai com código 1 se qualquer checagem falhar.
"""
import base64
import io
import os
import re
import shutil
import sys
import tempfile
import zlib
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# OUTPUT_DIR é lido na importação do módulo, então tem que vir antes dele.
SAIDA = tempfile.mkdtemp(prefix="teste-bleed-")
os.environ["PDF_OUTPUT_DIR"] = SAIDA

from PIL import Image  # noqa: E402

from app import pdf_generator as pg  # noqa: E402

MAGENTA, AZUL = (255, 0, 255), (0, 0, 255)

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def arte(w, h, com_sangria=True):
    """Arte de teste: moldura magenta = sangria, miolo azul = a carta.

    Assim dá pra afirmar duas coisas de uma vez só olhando as cores do
    resultado: que sobrou a carta inteira (tem azul) e que a sangria foi
    embora (não tem magenta nenhum).
    """
    img = Image.new("RGB", (w, h), MAGENTA if com_sangria else AZUL)
    if com_sangria:
        bx, by = round(w * pg.BLEED_X_FRAC), round(h * pg.BLEED_Y_FRAC)
        img.paste(Image.new("RGB", (w - 2 * bx, h - 2 * by), AZUL), (bx, by))
    return img


def cores(img):
    return {c for _, c in img.convert("RGB").getcolors(maxcolors=1 << 20)}


def streams(pdf_bytes):
    """Streams do PDF, desembrulhando o ASCII85 e o Flate do reportlab."""
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", pdf_bytes, re.S):
        bruto = m.group(1).strip()
        try:
            bruto = base64.a85decode(bruto, adobe=True)
        except Exception:
            pass
        try:
            yield zlib.decompress(bruto)
        except Exception:
            yield bruto


def main():
    # --- 1. gabarito do MPC Fill (3264x4440, 1200 DPI) ---
    img = pg._crop_bleed(arte(3264, 4440), "gabarito")
    esperado = (3264 - 2 * round(3264 * pg.BLEED_X_FRAC),
                4440 - 2 * round(4440 * pg.BLEED_Y_FRAC))
    check("gabarito 3264x4440 recortado", img.size == esperado,
          f"-> {img.width}x{img.height} (esperado {esperado[0]}x{esperado[1]})")
    check("nada de sangria sobrou", cores(img) == {AZUL}, f"cores={cores(img)}")

    # --- 2. mesma arte em outra resolução: o recorte é proporcional ---
    img = pg._crop_bleed(arte(2176, 2960), "gabarito-800dpi")
    check("gabarito 2176x2960 recortado", cores(img) == {AZUL},
          f"-> {img.width}x{img.height}, cores={cores(img)}")

    # --- 3. arte que já veio cortada (1488x2079, 600 DPI) passa intacta ---
    img = pg._crop_bleed(arte(1488, 2079, com_sangria=False), "ja-cortada")
    check("arte já cortada passa intacta", img.size == (1488, 2079),
          f"-> {img.width}x{img.height}")

    # --- 4. proporção de fora do MPC Fill passa intacta (e avisa no log) ---
    img = pg._crop_bleed(arte(1000, 1000, com_sangria=False), "quadrada")
    check("proporção estranha passa intacta", img.size == (1000, 1000))

    # --- 5. ponta a ponta: a carta no PDF tem que medir 63 x 88 mm ---
    png = io.BytesIO()
    arte(3264, 4440).save(png, format="PNG")
    pg._download = lambda session, drive_id: png.getvalue()

    xml = ("<order><fronts><card><id>x</id><slots>0,1</slots></card>"
           "</fronts></order>")
    caminho, erros = pg.generate_pdf(xml, "teste-bleed")
    raw = Path(caminho).read_bytes()
    fluxos = list(streams(raw))

    # As matrizes miúdas são das guias de corte; só interessam as do tamanho
    # de uma carta.
    desenhos = [t for t in re.findall(
        rb"([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm", b"".join(fluxos))
        if float(t[0]) > 72]
    larguras = {round(float(w) / 72 * 25.4, 2) for w, _, _, _ in desenhos}
    alturas = {round(float(h) / 72 * 25.4, 2) for _, h, _, _ in desenhos}

    check("PDF sem falhas", erros == 0, f"falhas={erros}")
    check("uma imagem por slot", len(desenhos) == 2, f"{len(desenhos)} desenho(s)")
    check("carta desenhada com 63 mm de largura", larguras == {63.0}, f"mm={larguras}")
    check("carta desenhada com 88 mm de altura", alturas == {88.0}, f"mm={alturas}")

    # --- 6. o JPEG que entrou no PDF é a carta, não o gabarito ---
    jpeg = next((f for f in fluxos if f[:3] == b"\xff\xd8\xff"), None)
    img_pdf = Image.open(io.BytesIO(jpeg)) if jpeg else None
    proporcao = round(img_pdf.width / img_pdf.height, 4) if img_pdf else None
    check("JPEG embutido está na proporção da carta",
          proporcao is not None and abs(proporcao - pg.TRIM_RATIO) < 0.005,
          f"tamanho={img_pdf.size if img_pdf else None}, proporção={proporcao}")

    # Canto da imagem: tem que ser o azul da carta, nunca o magenta da sangria
    # (o JPEG é com perdas, então a comparação é por distância de cor).
    cantos = ([img_pdf.getpixel((1, 1)),
               img_pdf.getpixel((img_pdf.width - 2, img_pdf.height - 2))]
              if img_pdf else [])
    check("JPEG embutido sem sangria nos cantos",
          bool(cantos) and all(abs(c[0] - 255) + c[1] + abs(c[2] - 255) > 60
                               for c in cantos),
          f"cantos={cantos}")

    print("\nRESULTADO:",
          "TUDO OK" if not falhas else f"{len(falhas)} falha(s): {falhas}")
    return 1 if falhas else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        shutil.rmtree(SAIDA, ignore_errors=True)
