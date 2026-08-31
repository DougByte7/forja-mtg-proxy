"""
Confere a conversa IPP com o CUPS que lê o nível de tinta.

Motivo de existir: este é o único lugar do projeto que fala um protocolo
binário no osso. Um byte fora de lugar no pedido não dá erro claro — o CUPS
responde `client-error-bad-request` e o indicador some sem explicação, que é
exatamente o sintoma de "impressora não informa". Então o pedido é conferido
byte a byte contra o RFC 8010, e a leitura é conferida contra uma resposta
montada à mão aqui, como uma impressora mandaria.

Não precisa de rede, de CUPS nem de pytest:

    python tests/test_tinta.py
"""
import struct
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from app import tinta  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado, f"(obtido {obtido!r}, esperado {esperado!r})"
          if obtido != esperado else "")


# --------------------------------------------------------------------------
# O pedido: Get-Printer-Attributes conforme o RFC 8010
# --------------------------------------------------------------------------
pedido = tinta._pedido("ipp://cups.local/printers/EPSON")

eq("versão 2.0", pedido[:2], b"\x02\x00")
eq("operação Get-Printer-Attributes (0x000B)", pedido[2:4], b"\x00\x0b")
eq("request-id 1", struct.unpack(">I", pedido[4:8])[0], 1)
eq("abre o grupo de atributos de operação", pedido[8], 0x01)
eq("termina com end-of-attributes-tag", pedido[-1], 0x03)
# Charset e idioma ANTES de tudo: é exigência do RFC, e servidor nenhum
# releva. Se alguém reordenar isto, o CUPS passa a recusar o pedido.
check("charset vem primeiro", pedido.index(b"attributes-charset") <
      pedido.index(b"attributes-natural-language") <
      pedido.index(b"printer-uri"))
check("a uri da fila viaja no pedido",
      b"ipp://cups.local/printers/EPSON" in pedido)
check("pergunta pelos níveis", b"marker-levels" in pedido)
check("pergunta pelo limite de 'baixo' da própria impressora",
      b"marker-low-levels" in pedido)
# Só o primeiro valor leva nome; os outros vão com nome vazio. Contar o nome
# repetido pega o erro clássico de mandar cada um como atributo novo.
eq("requested-attributes aparece uma vez só",
   pedido.count(b"requested-attributes"), 1)


# --------------------------------------------------------------------------
# A resposta: montada aqui como uma impressora mandaria
# --------------------------------------------------------------------------
def resposta(*atributos, status=0x0000):
    """Cabeçalho + grupo do printer + atributos, no formato do RFC 8010."""
    corpo = struct.pack(">BBHI", 2, 0, status, 1) + bytes([0x04])
    for tag, nome, valores in atributos:
        for i, v in enumerate(valores):
            bruto = struct.pack(">i", v) if isinstance(v, int) else v.encode()
            rotulo = nome.encode() if i == 0 else b""   # lista: só o 1º tem nome
            corpo += (struct.pack(">BH", tag, len(rotulo)) + rotulo
                      + struct.pack(">H", len(bruto)) + bruto)
    return corpo + bytes([0x03])


INT, NOME, KEYWORD = 0x21, 0x42, 0x44

lida = tinta._ler_resposta(resposta(
    (INT, "marker-levels", [12, 80, 64, 91]),
    (NOME, "marker-names", ["Black", "Cyan", "Magenta", "Yellow"]),
    (NOME, "marker-colors", ["#000000", "#00FFFF", "#FF00FF", "#FFFF00"]),
))
eq("lê a lista inteira de níveis", lida.get("marker-levels"), [12, 80, 64, 91])
eq("lê os nomes junto", lida.get("marker-names"),
   ["Black", "Cyan", "Magenta", "Yellow"])
eq("resposta truncada não explode", tinta._ler_resposta(b"\x02\x00\x00"), {})
eq("resposta vazia não explode", tinta._ler_resposta(b""), {})


# --------------------------------------------------------------------------
# A conta: quando é "baixo", quando é "ok", quando é não sei
# --------------------------------------------------------------------------
def marcadores(niveis, nomes=None, tipos=None, limites=None, cores=None):
    atrs = {"marker-levels": niveis}
    if nomes: atrs["marker-names"] = nomes
    if tipos: atrs["marker-types"] = tipos
    if limites: atrs["marker-low-levels"] = limites
    if cores: atrs["marker-colors"] = cores
    return tinta._marcadores(atrs)


m = marcadores([12, 80], ["Black", "Cyan"])
eq("nível abaixo do limite é baixo", [x["baixo"] for x in m], [True, False])
eq("o nível conhecido passa inteiro", [x["nivel"] for x in m], [12, 80])

# A impressora manda o limite DELA; ele ganha do nosso padrão.
m = marcadores([25, 25], ["Black", "Cyan"], limites=[30, 10])
eq("o limite da impressora manda", [x["baixo"] for x in m], [True, False])
m = marcadores([15], ["Black"], limites=[0])
check("limite 0 é 'não configurei' e cai no nosso padrão", m[0]["baixo"])

# Caixa de manutenção enche em vez de esvaziar: entrar na conta inverteria o
# aviso (caixa vazia = ótimo, contaria como suprimento no fim).
m = marcadores([90, 5], ["Black", "Waste Ink Box"], tipos=["ink", "wasteInk"])
eq("caixa de manutenção fica de fora", [x["nome"] for x in m], ["Black"])
m = marcadores([90, 5], ["Preto", "Caixa de manutenção"])
eq("caixa de manutenção em português também", [x["nome"] for x in m], ["Preto"])

# Os códigos negativos do CUPS.
eq("-1 é ignorância pura", marcadores([-1])[0], {"nome": "", "cor": "",
                                                 "nivel": None, "baixo": False})
check("-3 é 'não sei o número, mas está baixo'", marcadores([-3])[0]["baixo"])
check("-2 é 'não sei, mas está ok'", not marcadores([-2])[0]["baixo"])


# `_calcular` com a rede trocada por respostas de mentira.
def com_resposta(atributos, fila="EPSON", manual=""):
    tinta._perguntar = lambda: atributos
    tinta.printer.PRINTER_QUEUE = fila
    tinta.MANUAL = manual
    return tinta._calcular()

eq("tanque no fim vira 'baixo'",
   com_resposta({"marker-levels": [8, 70]})["estado"], "baixo")
eq("tudo cheio vira 'ok'",
   com_resposta({"marker-levels": [90, 70]})["estado"], "ok")
eq("o nível mostrado é o MENOR suprimento",
   com_resposta({"marker-levels": [90, 70]})["nivel"], 70)
# O caso da impressora de tanque: responde, mas sem número. Dizer "ok" aqui
# seria inventar — e inventar "cheio" é o erro que faz o cliente esperar duas
# semanas sem ter sido avisado.
eq("impressora que não conta fica 'desconhecido'",
   com_resposta({"marker-levels": [-1, -1]})["estado"], "desconhecido")
eq("resposta vazia fica 'desconhecido'", com_resposta({})["estado"], "desconhecido")
eq("sem fila configurada nem pergunta",
   com_resposta({"marker-levels": [8]}, fila="")["fonte"], "sem-fila")

# A mão ganha da impressora: quem enche o tanque viu com o olho.
eq("TINTA_ESTADO=baixo força o aviso",
   com_resposta({"marker-levels": [99]}, manual="baixo")["estado"], "baixo")
eq("TINTA_ESTADO=ok cala o aviso",
   com_resposta({"marker-levels": [1]}, manual="ok")["estado"], "ok")
eq("TINTA_ESTADO lixo é ignorado",
   com_resposta({"marker-levels": [99]}, manual="talvez")["estado"], "ok")

# CUPS fora do ar não pode virar erro na página.
def explode():
    raise OSError("connection refused")
tinta._perguntar = explode
tinta.MANUAL = ""
eq("CUPS fora do ar vira 'desconhecido'", tinta._calcular()["estado"], "desconhecido")
eq("e diz que ninguém respondeu", tinta._calcular()["fonte"], "sem-resposta")
eq("estado() nunca levanta exceção", tinta.estado(usar_cache=False)["estado"],
   "desconhecido")

# A resposta é pública: não pode carregar endereço de rede nem nome de fila.
tinta.printer.CUPS_HOST = "192.168.0.10:631"
tinta.printer.PRINTER_QUEUE = "EPSON-L4260"
tinta._perguntar = lambda: {"marker-levels": [8]}
publico = str(tinta.estado(usar_cache=False))
check("a resposta não vaza o endereço do CUPS", "192.168.0.10" not in publico)
check("a resposta não vaza o nome da fila", "EPSON-L4260" not in publico)

# Cache: o endereço é público, então uma visita a mais não pode virar uma
# pergunta a mais ao CUPS.
perguntas = []
tinta._perguntar = lambda: perguntas.append(1) or {"marker-levels": [50]}
tinta.estado(usar_cache=False)
tinta.estado()
tinta.estado()
eq("o cache segura as consultas seguintes", len(perguntas), 1)


print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
