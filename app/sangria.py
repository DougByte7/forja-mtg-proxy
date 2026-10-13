"""
A sangria do gabarito da MakePlayingCards: as medidas e o recorte.

Mora fora do `pdf_generator` pra não arrastar o reportlab junto: o site
precisa disto pra conferir a arte que a pessoa envia (`artes_enviadas`) e não
monta PDF nenhum — quem monta é o worker da impressora. Só Pillow aqui.
"""
import os

from PIL import Image

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


def crop_bleed(img: Image.Image, drive_id: str) -> Image.Image:
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
        print(f"[sangria] {drive_id}: proporção {ratio:.4f} "
              f"({img.width}x{img.height}) não bate com o gabarito do MPC Fill "
              f"({FULL_RATIO:.4f}) nem com a carta cortada ({TRIM_RATIO:.4f}); "
              f"desenhando sem recorte")
        return img

    left = round(img.width * BLEED_X_FRAC)
    top = round(img.height * BLEED_Y_FRAC)
    return img.crop((left, top, img.width - left, img.height - top))


def sem_transparencia(img: Image.Image) -> Image.Image:
    """A imagem em RGB, com o que era transparente pintado da cor da borda.

    O PNG da Scryfall vem com os cantos arredondados transparentes, e por
    baixo da transparência o pixel é branco: o `convert("RGB")` puro deixaria
    quatro cantos brancos numa carta de borda preta, e o corte reto da folha
    não os tira. A cor sai da própria borda — do meio de cada lado, longe dos
    cantos — e não de um preto fixo, porque carta de borda branca existe.
    """
    transparente = img.mode in ("RGBA", "LA", "PA") or (
        img.mode == "P" and "transparency" in img.info)
    if not transparente:
        return img.convert("RGB")
    rgba = img.convert("RGBA")
    w, h = rgba.size
    dentro = max(1, round(min(w, h) * 0.01))
    amostras = [rgba.getpixel(p) for p in ((w // 2, dentro), (w // 2, h - 1 - dentro),
                                           (dentro, h // 2), (w - 1 - dentro, h // 2))]
    opacas = [a[:3] for a in amostras if a[3] > 200] or [(0, 0, 0)]
    cor = tuple(sorted(c[i] for c in opacas)[len(opacas) // 2] for i in range(3))
    fundo = Image.new("RGBA", rgba.size, cor + (255,))
    return Image.alpha_composite(fundo, rgba).convert("RGB")
