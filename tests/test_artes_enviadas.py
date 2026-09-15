"""
Confere a arte que não vem do MPC Fill: o arquivo enviado pela pessoa e a
imagem da Scryfall, da subida até a folha do PDF.

MOTIVO DE EXISTIR. As duas chegam de fora do gabarito que o PDF conhecia, e
cada erro aqui só aparece no papel:

1. **Proporção.** Arquivo fora do formato da carta sairia esticado. A subida
   tem que recusar, e aceitar as duas formas certas — com e sem sangria.
2. **Arquivo quebrado.** Imagem truncada guardada no disco vira "FALHA NO
   DOWNLOAD" num pedido já pago.
3. **Cantos transparentes.** O PNG da Scryfall tem cantos arredondados com
   branco por baixo; sem cuidado, a carta de borda preta sai com quatro
   cantos brancos.

E as rotas: enviar pede conta e dono, e a miniatura abre pra qualquer um que
abra o deck.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_artes_enviadas.py

Sai com código 1 se qualquer checagem falhar.
"""
import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-enviadas-")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["SENHA_ITERACOES"] = "1000"
os.environ["SESSAO_SEGURA"] = "0"
os.environ["ARTES_ENVIADAS_DIR"] = os.path.join(TMP, "enviadas")
os.environ["PDF_OUTPUT_DIR"] = os.path.join(TMP, "pdf")

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

from PIL import Image  # noqa: E402

os.chdir(RAIZ)

from app import arte_id, artes, artes_enviadas, cartas, decks, storage, usuarios  # noqa: E402
from app import pdf_generator as pg  # noqa: E402
from app.main import app  # noqa: E402

AZUL, MAGENTA = (0, 0, 255), (255, 0, 255)
IMP = "6904ea20-e504-47da-95a0-08739fdde260"

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def imagem(w, h, formato="PNG", com_sangria=False):
    """Moldura magenta = sangria, miolo azul = a carta (como no `test_bleed`)."""
    img = Image.new("RGB", (w, h), MAGENTA if com_sangria else AZUL)
    if com_sangria:
        bx, by = round(w * pg.BLEED_X_FRAC), round(h * pg.BLEED_Y_FRAC)
        img.paste(Image.new("RGB", (w - 2 * bx, h - 2 * by), AZUL), (bx, by))
    buf = io.BytesIO()
    img.save(buf, format=formato)
    return buf.getvalue()


def recusa(nome, dados, trecho):
    try:
        artes_enviadas.guardar(dados)
        check(nome, False, "(aceitou)")
    except ValueError as e:
        check(nome, trecho in str(e), str(e))


def cliente_logado(login, senha):
    c = TestClient(app)
    r = c.post("/conta/entrar", json={"login": login, "senha": senha})
    assert r.status_code == 200, r.text
    return c


try:
    cartas.init_db()
    decks.init_db()
    artes.init_db()
    storage.init_db()
    usuarios.init_db()

    print("\n--- o que entra ---")

    cortada = artes_enviadas.guardar(imagem(745, 1040))
    check("a carta no tamanho do refile entra", cortada["arte_id"].startswith("enviada:"))
    eq("com o DPI da largura dela", (cortada["dpi"], cortada["baixa_resolucao"]),
       (300, False))
    eq("a mesma imagem de novo é o mesmo arquivo",
       artes_enviadas.guardar(imagem(745, 1040))["arte_id"], cortada["arte_id"])
    eq("um original e uma miniatura no disco", len(os.listdir(artes_enviadas.DIR)), 2)

    sangria = artes_enviadas.guardar(imagem(816, 1110, com_sangria=True))
    eq("o gabarito da MPC, com sangria, também — e o DPI é o da carta sem ela",
       sangria["dpi"], 300)
    sha = arte_id.sha_da_enviada(sangria["arte_id"])
    canto = Image.open(artes_enviadas.caminho_miniatura(sha)).convert("RGB").getpixel((1, 1))
    check("a miniatura já vem sem a sangria", canto[0] < 60 and canto[2] > 180,
          f"canto={canto}")
    eq("o original se serve com o tipo dele", artes_enviadas.tipo(sha), "image/png")
    eq("JPG entra", artes_enviadas.guardar(imagem(745, 1040, "JPEG"))["dpi"], 300)
    pequena = artes_enviadas.guardar(imagem(372, 520))
    eq("arte pequena entra, marcada como baixa resolução",
       (pequena["dpi"], pequena["baixa_resolucao"]), (150, True))

    print("\n--- o que é recusado ---")

    recusa("proporção de fora sairia esticada", imagem(1000, 1000), "formato da carta")
    recusa("GIF não é formato de impressão", imagem(745, 1040, "GIF"), "PNG, JPG ou WebP")
    recusa("arquivo que não é imagem", b"isto nao e uma imagem", "abrir")
    recusa("arquivo vazio", b"", "vazio")
    teto, artes_enviadas.TAMANHO_MAXIMO = artes_enviadas.TAMANHO_MAXIMO, 10
    recusa("arquivo acima do teto", imagem(745, 1040), "passa de")
    artes_enviadas.TAMANHO_MAXIMO = teto

    ruido = io.BytesIO()
    Image.effect_noise((745, 1040), 60).convert("RGB").save(ruido, format="PNG")
    antes = len(os.listdir(artes_enviadas.DIR))
    recusa("imagem truncada", ruido.getvalue()[:len(ruido.getvalue()) // 2], "corrompido")
    eq("e não deixa nada no disco", len(os.listdir(artes_enviadas.DIR)), antes)
    eq("o que não é sha não vira caminho", artes_enviadas.caminho("../../etc/passwd"), None)

    print("\n--- no PDF ---")

    xml = (f"<order><fronts><card><id>{cortada['arte_id']}</id><slots>0</slots></card>"
           f"<card><id>{sangria['arte_id']}</id><slots>1</slots></card></fronts></order>")
    _, falhas_pdf = pg.generate_pdf(xml, "teste-enviada")
    eq("as artes enviadas vão do disco pro PDF, sem falha", falhas_pdf, 0)
    try:
        pg._bytes_da_arte(None, "enviada:" + "f" * 64)
        check("arquivo que sumiu do disco é falha que diz o motivo", False, "(leu)")
    except RuntimeError as e:
        check("arquivo que sumiu do disco é falha que diz o motivo",
              "não está mais" in str(e), str(e))

    pedidas = []

    def png_da_scryfall(session, url, rotulo, dica_html=""):
        """Uma carta de borda escura com os quatro cantos transparentes —
        brancos por baixo, como vêm os PNG da Scryfall."""
        pedidas.append(url)
        carta = Image.new("RGBA", (745, 1040), (10, 10, 10, 255))
        carta.paste(Image.new("RGBA", (665, 960), AZUL + (255,)), (40, 40))
        for x, y in ((0, 0), (725, 0), (0, 1020), (725, 1020)):
            carta.paste(Image.new("RGBA", (20, 20), (255, 255, 255, 0)), (x, y))
        buf = io.BytesIO()
        carta.save(buf, format="PNG")
        return buf.getvalue()

    pg._baixar = png_da_scryfall
    preparada = Image.open(pg._prepare_image(None, f"scryfall:{IMP}:back", TMP))
    eq("a Scryfall é baixada pelo PNG do lado certo", pedidas,
       [f"https://cards.scryfall.io/png/back/6/9/{IMP}.png"])
    canto = preparada.convert("RGB").getpixel((2, 2))
    check("o canto transparente sai da cor da borda, e não branco", max(canto) < 60,
          f"canto={canto}")
    eq("e a carta da Scryfall passa inteira pelo recorte", preparada.size, (745, 1040))

    print("\n--- as rotas ---")

    ana = usuarios.criar("ana", "senha-da-ana-1", perfil="cliente")
    usuarios.criar("beto", "senha-do-beto-1", perfil="cliente")
    c_ana = cliente_logado("ana", "senha-da-ana-1")
    c_beto = cliente_logado("beto", "senha-do-beto-1")
    anonimo = TestClient(app)

    deck = decks.criar("Deck da Ana", ["Atraxa"], [{"nome": "Forest", "quantidade": 2}])
    decks.reclamar(deck["id"], ana["id"])
    rota = f"/decks/{deck['id']}/artes/enviar"
    arquivo = {"arquivo": ("minha arte.png", imagem(745, 1040), "image/png")}

    eq("anônimo não envia",
       anonimo.post(rota, files=arquivo, data={"nome": "Forest"}).status_code, 401)
    eq("nem quem não é dono",
       c_beto.post(rota, files=arquivo, data={"nome": "Forest"}).status_code, 403)
    r = c_ana.post(rota, files=arquivo, data={"nome": "Forest", "face": "frente",
                                              "copia": "2"})
    eq("a dona envia", r.status_code, 200)
    escolha = r.json()["escolha"]
    eq("e o arquivo já fica escolhido pra cópia, com o nome que tinha",
       (escolha["copia"], escolha["arquivo"], escolha["fonte"]),
       (2, "minha arte.png", "Enviada"))
    r = c_ana.post(rota, data={"nome": "Forest"},
                   files={"arquivo": ("quadrada.png", imagem(1000, 1000), "image/png")})
    eq("proporção errada volta 400 com a razão",
       (r.status_code, "formato da carta" in r.json().get("detail", "")), (400, True))

    sha = arte_id.sha_da_enviada(escolha["arte_id"])
    r = anonimo.get(f"/artes/enviadas/{sha}/miniatura")
    eq("a miniatura abre pra qualquer um", (r.status_code, r.headers["content-type"]),
       (200, "image/jpeg"))
    check("e o navegador pode guardar pra sempre",
          "immutable" in r.headers.get("cache-control", ""))
    eq("o original também abre, com o tipo dele",
       anonimo.get(f"/artes/enviadas/{sha}").headers["content-type"], "image/png")
    eq("sha que ninguém enviou é 404",
       anonimo.get("/artes/enviadas/" + "0" * 64).status_code, 404)

    r = c_ana.put(f"/decks/{deck['id']}/artes", json={
        "nome": "Atraxa", "arte_id": f"scryfall:{IMP}:front", "baixa_resolucao": True})
    eq("a imagem da Scryfall se escolhe pela rota de sempre",
       (r.status_code, r.json()["escolha"]["baixa_resolucao"]), (200, True))
    r = c_ana.post(f"/decks/{deck['id']}/artes/padrao")
    eq("a arte padrão volta com as escolhas do deck",
       (r.status_code, "atraxa" in r.json()["escolhas"]), (200, True))
    eq("quem não é dono não aplica a arte padrão",
       c_beto.post(f"/decks/{deck['id']}/artes/padrao").status_code, 403)
    r = c_ana.delete(f"/decks/{deck['id']}/artes/copias", params={"nome": "Forest"})
    eq("desligar a arte por cópia", (r.status_code, r.json()), (200, {"apagadas": 1}))

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
