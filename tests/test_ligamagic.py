"""
Confere a decodificação do preço da LigaMagic sem tocar na rede.

Motivo de existir: `ligamagic.py` desmonta uma página que não foi feita pra
ser lida por robô — sprite de CSS com classes e coordenadas sorteadas a cada
requisição (veja SCRAPING_NOTES.md). Quando a LigaMagic mexer nisso, o
esperado é que a cotação FALHE ALTO, não que devolva preço errado. É isso
que este arquivo trava.

A página de teste é montada aqui: o sprite é desenhado a partir dos mesmos
bitmaps que o `ligamagic` usa pra reconhecer, e as classes e posições são
sorteadas a cada rodada, como o site faz. Isso não prova que os bitmaps
batem com a fonte real (isso foi conferido contra o site de verdade, e é o
que quebra se eles trocarem a fonte) — prova o resto: leitura do <style>,
extração do JSON, papel de cada classe dentro do grupo, vírgula decimal,
preferência pelo preço em texto puro e os filtros de oferta.

Precisa de Pillow (já é dependência do projeto), não precisa de rede.
Rode de dentro da raiz do projeto:

    python tests/test_ligamagic.py

Sai com código 1 se qualquer checagem falhar.
"""
import json
import random
import string
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from PIL import Image  # noqa: E402

from app import ligamagic  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


# --------------------------------------------------------------------------
# Uma página falsa da LigaMagic
# --------------------------------------------------------------------------
LARGURA, ALTURA = 600, 84
TINTA, FUNDO = (233, 90, 30), (255, 255, 255)


def classe(rng):
    return "".join(rng.choice(string.ascii_letters) for _ in range(5))


class PaginaFalsa:
    """Monta HTML + sprite com os dígitos em posições sorteadas, do jeito
    que a LigaMagic monta — inclusive embaralhando a ordem das classes
    dentro de cada grupo, que é o que impede ler o grupo por posição."""

    def __init__(self, semente=0):
        self.rng = random.Random(semente)
        self.img = Image.new("RGB", (LARGURA, ALTURA), FUNDO)
        self.regras, self.pos_de = [], {}
        self.cls_caixa, self.cls_img = classe(self.rng), classe(self.rng)
        self.url = "//cdn.exemplo/sprite-%d.jpg" % semente

        # Um dígito por posição sorteada, sem repetir célula.
        modelos = {d: b for b, d in ligamagic._TEMPLATES[:10]}
        usadas = set()
        for digito in range(10):
            while True:
                x = self.rng.randrange(0, LARGURA - 8, 8)
                y = self.rng.choice([2, 23, 44, 65])
                if (x, y) not in usadas:
                    usadas.add((x, y))
                    break
            self._desenhar(modelos[digito], x, y)
            nome = classe(self.rng)
            self.pos_de[digito] = nome
            self.regras.append(f".{nome}{{background-position:-{x}px -{y}px;}}")

        self.regras.append(
            f".{self.cls_caixa}{{width:7px;float:left;height:15px;}}")
        self.regras.append(
            f".{self.cls_img}{{background-image:url({self.url})}}")

    def _desenhar(self, modelo, x, y):
        for j, linha in enumerate(modelo):
            for i in range(7):
                if linha >> (6 - i) & 1:
                    self.img.putpixel((x + i, y + j), TINTA)

    def css_do_numero(self, texto: str) -> str:
        """"7,81" -> os grupos de classes que a LigaMagic mandaria."""
        grupos = []
        for c in texto:
            if c == ",":
                grupos.append("V")
                continue
            partes = [self.pos_de[int(c)], self.cls_caixa, self.cls_img]
            self.rng.shuffle(partes)      # a ordem dentro do grupo é aleatória
            grupos.append(" ".join(partes))
        return ";".join(grupos)

    def html(self, estoque, lojas, edicoes):
        return (
            "<html><head><style>" + "".join(self.regras) + "</style></head><body>"
            + "<script>var param = {\"card\":{\"id\":\"1\"}};\n"
            + "var cards_editions = " + json.dumps(edicoes) + ";\n"
            + "var cards_stock = " + json.dumps(estoque) + ";\n"
            + "var cards_stores = " + json.dumps(lojas) + ";\n"
            + "var dataQuality = " + json.dumps(
                [{"id": 1, "acron": "M"}, {"id": 2, "acron": "NM"},
                 {"id": 5, "acron": "HP"}]) + ";\n"
            + "var dataLanguage = " + json.dumps(
                [{"id": 2, "acron": "EN"}, {"id": 8, "acron": "PT"}]) + ";\n"
            + "var dataExtras = " + json.dumps([{"id": 2, "acron": "Foil"}]) + ";\n"
            + "</script></body></html>")


def oferta(pagina, **campos):
    base = {"id": 1, "idEdicao": "100", "qualid": "2", "idioma": "2",
            "extras": 0, "lj_id": 10, "sellType": 1, "is_graded": 0}
    base.update(campos)
    return base


# Substitui o download do sprite: o teste não fala com a rede.
def sem_rede(pagina):
    def _baixar(sessao, urls):
        return {("https:" + pagina.url): pagina.img}
    return _baixar


P = PaginaFalsa(semente=7)
ligamagic._baixar_sprites = sem_rede(P)

LOJAS = {
    "10": {"lj_name": "Loja Boa", "lj_cidade": "São Paulo", "lj_recesso": 0},
    "11": {"lj_name": "Loja de Férias", "lj_recesso": 1},
    "12": {"lj_name": "Campe&otilde;es Cards", "lj_recesso": 0},
}
EDICOES = [{"id": 100, "name": "Campe&otilde;es de Kamigawa"}]

ESTOQUE = [
    # preço ofuscado no sprite — o caminho que exige o OCR
    oferta(P, id=1, precoCss=P.css_do_numero("7,81"),
           quantCss=P.css_do_numero("4")),
    # preço em texto puro: a LigaMagic manda assim em parte das ofertas
    oferta(P, id=2, precoFinal="12.34", preco="19.99",
           quantCss=P.css_do_numero("2")),
    # quatro dígitos, pra provar que preço alto não quebra
    oferta(P, id=3, precoCss=P.css_do_numero("2299,99"), qualid="1"),
    # leilão: preço é lance de usuário, não oferta de loja
    oferta(P, id=4, sellType=2, price="1.00"),
    # carta gradeada: outro mercado
    oferta(P, id=5, precoCss=P.css_do_numero("0,99"), is_graded=1),
    # loja em recesso: não vende
    oferta(P, id=6, precoCss=P.css_do_numero("0,50"), lj_id=11),
    # sem preço em campo nenhum
    oferta(P, id=7, quantCss=P.css_do_numero("9")),
    # entidade HTML no nome da loja
    oferta(P, id=8, precoFinal="5.00", lj_id=12, qualid="5", idioma="8"),
]

HTML = P.html(ESTOQUE, LOJAS, EDICOES)
ofertas = ligamagic.extrair_ofertas(HTML, "Carta de Teste")
por_preco = sorted(o.preco for o in ofertas)

eq("só as ofertas de loja aproveitáveis entram", len(ofertas), 4)
eq("preços decodificados", por_preco, [5.00, 7.81, 12.34, 2299.99])

um = next(o for o in ofertas if o.preco == 7.81)
eq("OCR do sprite lê o preço", um.preco, 7.81)
eq("OCR do sprite lê a quantidade", um.quantidade, 4)
eq("condição vem da tabela", um.condicao, "NM")
eq("idioma vem da tabela", um.idioma, "EN")
eq("entidade HTML na edição é decodificada", um.edicao, "Campeões de Kamigawa")
eq("nome da loja", um.loja, "Loja Boa")

dois = next(o for o in ofertas if o.preco == 12.34)
# `precoFinal` é o preço COM desconto; `preco` é o cheio, riscado na tela.
eq("preço em texto puro é preferido ao OCR", dois.preco, 12.34)
eq("preço cheio riscado é ignorado", 19.99 in por_preco, False)

caro = next(o for o in ofertas if o.preco == 2299.99)
eq("preço de 4 dígitos", caro.preco, 2299.99)

outro = next(o for o in ofertas if o.preco == 5.00)
eq("entidade HTML no nome da loja", outro.loja, "Campeões Cards")
eq("condição HP", outro.condicao, "HP")

check("leilão fica de fora", all(o.preco != 1.00 for o in ofertas))
check("gradeada fica de fora", all(o.preco != 0.99 for o in ofertas))
check("loja em recesso fica de fora", all(o.preco != 0.50 for o in ofertas))
check("sem preço fica de fora", len(ofertas) == 4)


# --------------------------------------------------------------------------
# Sorteio novo: o mesmo preço, codificado de outro jeito, tem que dar igual
# --------------------------------------------------------------------------
Q = PaginaFalsa(semente=99)
ligamagic._baixar_sprites = sem_rede(Q)
HTML2 = Q.html([oferta(Q, id=1, precoCss=Q.css_do_numero("7,81"),
                       quantCss=Q.css_do_numero("4"))], LOJAS, EDICOES)
check("classes sorteadas de novo são mesmo diferentes",
      set(P.pos_de.values()) != set(Q.pos_de.values()))
o2 = ligamagic.extrair_ofertas(HTML2, "Carta de Teste")
eq("mesmo preço com sprite e classes novos", [o.preco for o in o2], [7.81])


# --------------------------------------------------------------------------
# O que tem que falhar alto, e o que não pode falhar
# --------------------------------------------------------------------------
ligamagic._baixar_sprites = sem_rede(P)

# Página de busca vazia: a carta não existe. Isso NÃO é erro de layout.
eq("carta inexistente devolve lista vazia",
   ligamagic.extrair_ofertas("<html><body>nada aqui</body></html>", "X"), [])

# Carta que existe mas ninguém vende: sem <style> de dígito na página.
vazia = ("<html><body><script>var param = {};\n"
         "var cards_stock = [];\nvar cards_stores = {};\n"
         "var cards_editions = [];\n</script></body></html>")
eq("carta sem oferta devolve lista vazia",
   ligamagic.extrair_ofertas(vazia, "X"), [])

# Sprite trocado por um em branco: o casamento não bate e tem que explodir,
# em vez de chutar um dígito e devolver preço errado.
branco = PaginaFalsa(semente=7)
branco.img = Image.new("RGB", (LARGURA, ALTURA), FUNDO)
ligamagic._baixar_sprites = sem_rede(branco)
try:
    ligamagic.extrair_ofertas(HTML, "Carta de Teste")
    check("sprite irreconhecível explode em vez de chutar", False)
except ligamagic.LigaMagicError as e:
    check("sprite irreconhecível explode em vez de chutar",
          "dígito" in str(e).lower())

# Sumiu o <style> mas as ofertas continuam citando sprite: layout mudou.
ligamagic._baixar_sprites = sem_rede(P)
import re as _re  # noqa: E402
sem_style = _re.sub(r"<style>.*?</style>", "", HTML, flags=_re.S)
try:
    ligamagic.extrair_ofertas(sem_style, "Carta de Teste")
    check("sumiço das regras de sprite explode", False)
except ligamagic.LigaMagicError as e:
    check("sumiço das regras de sprite explode", "sprite" in str(e).lower())


# --------------------------------------------------------------------------
# O extrator de JSON precisa aguentar `];` dentro de string
# --------------------------------------------------------------------------
truque = ('<html><script>var param = {};\n'
          'var cards_stock = [{"title":"promo [x]; leia","id":1}];\n'
          '</script></html>')
eq("`];` dentro de string não corta o JSON no lugar errado",
   ligamagic._extrair_json(truque, "cards_stock"),
   [{"title": "promo [x]; leia", "id": 1}])

try:
    ligamagic._extrair_json("<html>nada</html>", "cards_stock")
    check("variável ausente explode com mensagem clara", False)
except ligamagic.LigaMagicError as e:
    check("variável ausente explode com mensagem clara", "cards_stock" in str(e))


print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
