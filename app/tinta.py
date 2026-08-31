"""
Nível de tinta da impressora — o que a tela usa pra avisar que vai demorar.

Por que IPP na mão e não `lpstat`: o lpstat NÃO mostra nível de tinta. Quem
sabe disso é o próprio CUPS, nos atributos `marker-*` da fila (são eles que
desenham a barrinha de tinta na interface web dele), e a única forma de ler
isso é perguntando por IPP. O `ipptool` faria a pergunta, mas não vem junto
do `cups-client` que o Dockerfile instala — então o pedido é montado aqui, à
mão, com a biblioteca padrão. São dez linhas de bytes e três atributos; não
paga uma dependência nova nem um pacote a mais na imagem.

QUEM RESPONDE É A IMPRESSORA, E NEM TODA IMPRESSORA RESPONDE. Impressora de
tanque (a L4260 é uma) não tem chip no tanque pra medir nada: ela estima por
contador de páginas, quando estima — e o que chega aqui é -1, "não sei".
Por isso o padrão é SUMIR: sem número confiável, indicador nenhum é melhor
que um chute, e quem olha a página não fica sabendo de nada errado. Quando o
tanque está no fim e a impressora não conta, quem enche olha e escreve
`TINTA_ESTADO=baixo` no .env — a mão é a fonte mais confiável que existe
nesse caso.

Nada aqui levanta exceção. Tinta é recado, não serviço: CUPS fora do ar,
fila errada, impressora muda ou resposta estranha viram "desconhecido", e a
página segue igual.
"""
import http.client
import os
import socket
import struct
import threading
import time

from . import log, printer

# Abaixo disto a tinta é "baixa" — usado só quando a impressora não diz o
# limite dela (`marker-low-levels`), que é o número que o fabricante
# considera fim de cartucho.
LIMITE = int(os.environ.get("TINTA_LIMITE", "20"))
# A resposta vale por um dia: este endereço é público e responde a TODO
# mundo que abre a página, e nível de tinta não muda de hora em hora — ele
# anda no ritmo de quem imprime, que aqui é um deck de vez em quando.
# O cache é em memória, então reiniciar o container zera na hora: é o que
# fazer depois de reabastecer, e é o mesmo passo que já se dá pra trocar o
# TINTA_ESTADO no .env.
CACHE_SEGUNDOS = int(os.environ.get("TINTA_CACHE_SEGUNDOS", "86400"))
# Curto de propósito: é uma consulta de enfeite dentro do carregamento da
# página. Impressora dormindo não pode segurar ninguém.
TIMEOUT = float(os.environ.get("TINTA_TIMEOUT_SEGUNDOS", "4"))
# Sobrepõe o que a impressora disser: "ok", "baixo" ou vazio (automático).
MANUAL = os.environ.get("TINTA_ESTADO", "").strip().lower()
# Caminho do socket local, usado quando não há CUPS_HOST (mesma regra do
# `printer.list_queues`: sem host, o CUPS é o da própria máquina).
CUPS_SOCKET = os.environ.get("CUPS_SOCKET", "/run/cups/cups.sock")

# --------------------------------------------------------------------------
# IPP (RFC 8010) — só o pedaço necessário pra fazer UMA pergunta
# --------------------------------------------------------------------------
_OP_GET_PRINTER_ATTRIBUTES = 0x000B
_TAG_FIM = 0x03
_TAG_OPERACAO = 0x01
_TAG_INTEIRO, _TAG_BOOLEANO, _TAG_ENUM = 0x21, 0x22, 0x23
_TAG_CHARSET, _TAG_IDIOMA, _TAG_URI, _TAG_KEYWORD, _TAG_NOME = (
    0x47, 0x48, 0x45, 0x44, 0x42)
# O que se pergunta. `marker-levels` é o nível de cada suprimento em %;
# `marker-low-levels` é o limite que a própria impressora chama de baixo.
_ATRIBUTOS = ["marker-levels", "marker-names", "marker-colors",
              "marker-types", "marker-low-levels", "printer-state"]


def _campo(tag: int, nome: str, valor: bytes) -> bytes:
    n = nome.encode()
    return struct.pack(">BH", tag, len(n)) + n + struct.pack(">H", len(valor)) + valor


def _pedido(uri: str) -> bytes:
    """O Get-Printer-Attributes inteiro, em bytes.

    A ordem importa: charset e idioma vêm ANTES de qualquer outro atributo de
    operação, é exigência do RFC 8010 e servidor nenhum releva.
    """
    corpo = struct.pack(">BBHI", 2, 0, _OP_GET_PRINTER_ATTRIBUTES, 1)
    corpo += bytes([_TAG_OPERACAO])
    corpo += _campo(_TAG_CHARSET, "attributes-charset", b"utf-8")
    corpo += _campo(_TAG_IDIOMA, "attributes-natural-language", b"en-us")
    corpo += _campo(_TAG_URI, "printer-uri", uri.encode())
    # Vários valores do MESMO atributo: o primeiro leva o nome, os outros vêm
    # com nome vazio. É assim que o IPP representa lista.
    corpo += _campo(_TAG_KEYWORD, "requested-attributes", _ATRIBUTOS[0].encode())
    for extra in _ATRIBUTOS[1:]:
        corpo += _campo(_TAG_KEYWORD, "", extra.encode())
    return corpo + bytes([_TAG_FIM])


def _ler_resposta(dados: bytes) -> dict:
    """`{nome do atributo: [valores]}`. Ignora o que não souber ler.

    Devolve dicionário vazio (em vez de explodir) pra resposta truncada ou
    fora do formato: uma impressora esquisita não pode virar erro 500 numa
    página que só queria mostrar uma bolinha.
    """
    atributos: dict[str, list] = {}
    if len(dados) < 9:
        return atributos
    i, atual = 8, None                     # 8 = versão, status e request-id
    while i < len(dados):
        tag = dados[i]
        i += 1
        if tag == _TAG_FIM:
            break
        if tag < 0x10:                     # marca de grupo, não tem valor
            atual = None
            continue
        if i + 2 > len(dados):
            break
        (tam_nome,) = struct.unpack(">H", dados[i:i + 2])
        i += 2
        nome = dados[i:i + tam_nome].decode("utf-8", "replace")
        i += tam_nome
        if i + 2 > len(dados):
            break
        (tam_valor,) = struct.unpack(">H", dados[i:i + 2])
        i += 2
        bruto = dados[i:i + tam_valor]
        i += tam_valor
        if tag in (_TAG_INTEIRO, _TAG_ENUM) and tam_valor == 4:
            valor = struct.unpack(">i", bruto)[0]
        elif tag == _TAG_BOOLEANO and tam_valor == 1:
            valor = bool(bruto[0])
        else:
            valor = bruto.decode("utf-8", "replace")
        # Nome vazio = mais um valor do atributo anterior (ver `_pedido`).
        chave = nome or atual
        if not chave:
            continue
        atributos.setdefault(chave, []).append(valor)
        atual = chave
    return atributos


def _conexao():
    """Fala com o CUPS pelo mesmo caminho que o resto do projeto usa: pela
    rede quando há CUPS_HOST, pelo socket local quando não há."""
    if printer.CUPS_HOST:
        host, _, porta = printer.CUPS_HOST.partition(":")
        return http.client.HTTPConnection(host, int(porta or 631), timeout=TIMEOUT)

    class _PeloSocket(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(TIMEOUT)
            self.sock.connect(CUPS_SOCKET)

    return _PeloSocket("localhost", timeout=TIMEOUT)


def _perguntar() -> dict:
    """Os atributos `marker-*` da fila configurada, ou {} se não deu."""
    fila = printer.PRINTER_QUEUE
    caminho = f"/printers/{fila}"
    destino = printer.CUPS_HOST or "localhost"
    conn = _conexao()
    try:
        conn.request("POST", caminho, body=_pedido(f"ipp://{destino}{caminho}"),
                     headers={"Content-Type": "application/ipp"})
        resp = conn.getresponse()
        dados = resp.read()
        if resp.status != 200:
            log.aviso("tinta", "cups-recusou", status=resp.status, fila=fila)
            return {}
        return _ler_resposta(dados)
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Leitura
# --------------------------------------------------------------------------
def _e_descarte(nome: str, tipo: str) -> bool:
    """Caixa de manutenção não é tinta: ela ENCHE em vez de esvaziar.

    Deixar junto inverteria o aviso — uma caixa quase vazia (ótimo) contaria
    como suprimento no fim.
    """
    texto = f"{nome} {tipo}".lower()
    return any(p in texto for p in ("waste", "descarte", "maintenance", "manuten"))


def _marcadores(atributos: dict) -> list[dict]:
    niveis = atributos.get("marker-levels") or []
    nomes = atributos.get("marker-names") or []
    cores = atributos.get("marker-colors") or []
    tipos = atributos.get("marker-types") or []
    limites = atributos.get("marker-low-levels") or []

    def em(lista, i, padrao=""):
        return lista[i] if i < len(lista) else padrao

    saida = []
    for i, nivel in enumerate(niveis):
        if not isinstance(nivel, int):
            continue
        nome, tipo = str(em(nomes, i)), str(em(tipos, i))
        if _e_descarte(nome, tipo):
            continue
        limite = em(limites, i, 0)
        # A impressora só manda um limite útil quando manda um limite > 0;
        # 0 é "não configurei", e aí quem decide é o nosso LIMITE.
        limite = limite if isinstance(limite, int) and 0 < limite <= 100 else LIMITE
        # -3 é o "não sei o número, mas está baixo" do CUPS; -2 é "não sei,
        # mas está ok"; -1 e o resto é ignorância pura.
        if nivel == -3:
            conhecido, baixo = None, True
        elif nivel >= 0:
            conhecido, baixo = nivel, nivel <= limite
        else:
            conhecido, baixo = None, False
        saida.append({"nome": nome, "cor": str(em(cores, i)),
                      "nivel": conhecido, "baixo": baixo})
    return saida


def _calcular() -> dict:
    if MANUAL in ("ok", "baixo"):
        # A mão ganha da impressora: quem enche o tanque viu com o olho, e a
        # impressora de tanque não tem como ver.
        return {"estado": MANUAL, "nivel": None, "marcadores": [],
                "fonte": "manual"}
    if not printer.PRINTER_QUEUE:
        return {"estado": "desconhecido", "nivel": None, "marcadores": [],
                "fonte": "sem-fila"}
    try:
        atributos = _perguntar()
    except Exception as e:
        # Endereço errado, CUPS fora, timeout: nada disso é problema de quem
        # abriu a página. Fica no log e a tela não mostra indicador.
        log.aviso("tinta", "nao-consegui-ler", motivo=f"{type(e).__name__}: {e}")
        return {"estado": "desconhecido", "nivel": None, "marcadores": [],
                "fonte": "sem-resposta"}

    marcadores = _marcadores(atributos)
    conhecidos = [m["nivel"] for m in marcadores if m["nivel"] is not None]
    if any(m["baixo"] for m in marcadores):
        estado = "baixo"
    elif conhecidos or any(n == -2 for n in atributos.get("marker-levels") or []):
        estado = "ok"
    else:
        # A fila respondeu, mas sem nível nenhum — o caso da impressora de
        # tanque. É "desconhecido", não "ok": dizer que está cheia seria
        # inventar.
        estado = "desconhecido"
    return {"estado": estado,
            "nivel": min(conhecidos) if conhecidos else None,
            "marcadores": marcadores,
            "fonte": "impressora"}


_trava = threading.Lock()
_cache: dict = {}
_cache_em = 0.0


def estado(usar_cache: bool = True) -> dict:
    """O nível de tinta como a tela precisa ver. Nunca levanta exceção.

    `estado` é "ok", "baixo" ou "desconhecido" — e "desconhecido" é o normal
    quando a impressora não conta. `nivel` é o menor suprimento em %, ou None.
    Nada aqui pode carregar endereço de rede nem nome de fila: a resposta é
    pública.
    """
    global _cache, _cache_em
    with _trava:
        if usar_cache and _cache and time.time() - _cache_em < CACHE_SEGUNDOS:
            return dict(_cache)
    try:
        novo = _calcular()
    except Exception as e:
        log.aviso("tinta", "falhou", motivo=f"{type(e).__name__}: {e}")
        novo = {"estado": "desconhecido", "nivel": None, "marcadores": [],
                "fonte": "erro"}
    with _trava:
        _cache, _cache_em = novo, time.time()
    return dict(novo)


def diagnostico() -> dict:
    """Tudo o que a fila respondeu, cru, pra saber se a impressora informa.

    Só o admin vê: aqui saem endereço, nome de fila e mensagem de erro, que
    são justamente o que a resposta pública não pode carregar. É a forma de
    descobrir, sem terminal, se aquele modelo conta o nível ou não — se
    `atributos` vier sem nenhum `marker-*`, ele não conta, e o caminho é o
    `TINTA_ESTADO` no .env.
    """
    fora = {
        "cups_host": printer.CUPS_HOST or f"(socket local {CUPS_SOCKET})",
        "fila": printer.PRINTER_QUEUE,
        "limite_baixo": LIMITE,
        "cache_segundos": CACHE_SEGUNDOS,
        "tinta_estado_manual": MANUAL or "(automático)",
    }
    try:
        atributos = _perguntar()
        fora["atributos"] = atributos
        fora["informa_nivel"] = any(
            isinstance(n, int) and n >= 0
            for n in atributos.get("marker-levels") or [])
    except Exception as e:
        fora["erro"] = f"{type(e).__name__}: {e}"
        fora["dica"] = printer._hint(str(e)) or None
    fora["estado"] = estado(usar_cache=False)
    return fora
