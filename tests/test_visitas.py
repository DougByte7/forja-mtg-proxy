"""
Confere a classificação pessoa/bot e o agrupamento de visitas.

O que se está travando aqui não é "detectar bot" — isso é palpite e sempre
vai ser. É que o palpite não INVERTA: navegador de verdade não pode virar
"bot", e quem se anuncia como robô não pode virar "pessoa", porque é sobre
esses dois casos que o log vai ser lido.

    python tests/test_visitas.py
"""
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from app import visitas  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/127.0 Safari/537.36")
IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile Safari/604.1")

navegador = {"sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate",
             "accept-language": "pt-BR,pt;q=0.9", "sec-ch-ua": '"Chromium";v="127"'}
safari = {"sec-fetch-mode": "navigate", "accept-language": "pt-BR"}

classe, sinal = visitas.classificar(CHROME, navegador)
check("Chrome com cabeçalhos completos = pessoa", classe == "pessoa", sinal)

classe, sinal = visitas.classificar(IPHONE, safari)
check("Safari do iPhone (sem sec-ch-ua) = pessoa", classe == "pessoa", sinal)

for ua, esperado in [
    ("curl/8.4.0", "curl"),
    ("python-requests/2.31.0", "python-requests"),
    ("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
     "Googlebot"),
    ("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0",
     "HeadlessChrome"),
    ("GPTBot/1.0", "GPTBot"),
    ("Mozilla/5.0 (compatible; SomeNewCrawler/1.0)", "diz ser bot no User-Agent"),
]:
    classe, sinal = visitas.classificar(ua, {})
    check(f"{ua[:34]!r:38} = bot", classe == "bot-conhecido" and sinal == esperado,
          f"({classe}, {sinal})")

classe, _ = visitas.classificar("", {})
check("sem User-Agent = bot", classe == "bot")

# O caso interessante: UA copiado de um Chrome, sem os cabeçalhos que o
# Chrome manda. Não dá pra afirmar que é bot, então fica marcado.
classe, sinal = visitas.classificar(CHROME, {})
check("UA de navegador sem cabeçalho de navegador = suspeito",
      classe == "suspeito", sinal)

# HeadlessChrome tem UA de navegador E manda Sec-Fetch — só o nome o entrega,
# e por isso a checagem de bot conhecido vem ANTES da de navegador.
classe, _ = visitas.classificar(
    "Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/120.0", navegador)
check("headless não passa por pessoa só por mandar Sec-Fetch",
      classe == "bot-conhecido")


# --- agrupamento em visita ---
class PedidoFalso:
    def __init__(self, cabecalhos, host="10.0.0.1"):
        self.headers = cabecalhos
        self.client = type("C", (), {"host": host})()


ip = visitas.ip_do_pedido(PedidoFalso({"cf-connecting-ip": "189.4.22.7"}))
check("IP vem do CF-Connecting-IP, não do túnel", ip == "189.4.22.7", ip)

ip = visitas.ip_do_pedido(PedidoFalso({"x-forwarded-for": "189.4.22.7, 10.1.1.1"}))
check("sem Cloudflare, usa o primeiro do X-Forwarded-For", ip == "189.4.22.7", ip)

ip = visitas.ip_do_pedido(PedidoFalso({}))
check("sem cabeçalho nenhum, usa o IP da conexão", ip == "10.0.0.1", ip)

registro = visitas._Visitas()
v1 = registro.registrar("1.2.3.4", CHROME, "/", "pessoa", "x")
v2 = registro.registrar("1.2.3.4", CHROME, "/app.css", "pessoa", "x")
v3 = registro.registrar("1.2.3.9", CHROME, "/", "pessoa", "x")
check("mesma pessoa carregando a página = UMA visita", v1["id"] == v2["id"])
check("e ela só é anunciada uma vez", v1["nova"] and not v2["nova"])
check("IP diferente = outra visita", v3["id"] != v1["id"])
check("as duas aparecem como ativas", len(registro.ativas()) == 2)

registro.anotar(v1["id"], "cotou preços")
registro.anotar(v1["id"], "cotou preços")
ativa = next(v for v in registro.ativas() if v["id"] == v1["id"])
check("ação registrada sem repetir", ativa["acoes"] == ["cotou preços"])
check("estático não vira 'último caminho'", ativa["ultimo"] == "/")
check("contagem de pedidos inclui o estático", ativa["pedidos"] == 2)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
