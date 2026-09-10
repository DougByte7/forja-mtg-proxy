"""
Confere o câmbio: o indicador de "carta cara aqui" e a régua que faz o
deckbuilder escrever em real um preço que a base guarda em dólar.

Motivo de existir: os dois usos são de apresentação, então a regra é NUNCA
atrapalhar. Se a API cair, mudar de formato ou devolver bobagem, a cotação
inteira tem que seguir com a taxa fixa — e o cache tem que segurar a
requisição, pra uma cotação de 75 cartas não virar 75 consultas de câmbio.

Desde que o deckbuilder passou a converter preço, uma coisa a mais precisa
valer: `GET /cambio` tem que responder SEMPRE, inclusive sem rede. A tela
cai pra dólar se ela falhar, mas cair pra dólar é o plano B — o plano A é
esta rota nunca ser o motivo.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_cambio.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# Antes de importar qualquer coisa do app: os módulos leem o ambiente no
# import, e um teste não pode encostar num banco de verdade.
os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(), "orders.db"))
os.environ.setdefault("CARTAS_DB_PATH",
                      os.path.join(tempfile.mkdtemp(), "cartas.db"))
os.environ.setdefault("LOG_DIR", tempfile.mkdtemp())
os.environ.setdefault("LOG_NIVEL", "ERROR")

from app import cambio  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


class Resposta:
    def __init__(self, corpo):
        self._corpo = corpo

    def raise_for_status(self):
        pass

    def json(self):
        return self._corpo


chamadas = []


def responder(corpo=None, erro=None):
    """Troca a rede por uma resposta fixa e zera o cache do módulo."""
    def falso(url, **kwargs):
        chamadas.append(url)
        if erro:
            raise erro
        return Resposta(corpo)
    cambio.requests.get = falso
    cambio._cache = None
    chamadas.clear()


salvo_get = cambio.requests.get
try:
    responder({"USDBRL": {"code": "USD", "bid": "5.4321"}})
    eq("cotação boa vira taxa", cambio.taxa()["valor"], 5.4321)
    eq("e a tela sabe de onde veio", cambio.taxa()["fonte"], "awesomeapi")
    eq("segunda chamada sai do cache, sem bater na rede", len(chamadas), 1)

    # A chave do par não é fixa no código: quem apontar a CAMBIO_URL pra
    # outro endpoint do mesmo formato continua funcionando.
    responder({"USDBRLT": {"bid": "5.10"}})
    eq("não depende do nome da chave", cambio.taxa()["valor"], 5.10)

    # Daqui pra baixo é o que interessa: toda falha cai na taxa fixa.
    responder(erro=RuntimeError("sem rede"))
    eq("rede caída não levanta, cai na fixa", cambio.taxa()["valor"], cambio.FIXA)
    eq("e diz que é fixa", cambio.taxa()["fonte"], "fixa")

    responder({"USDBRL": {"bid": "0.0001"}})
    eq("valor fora da faixa é ignorado", cambio.taxa()["valor"], cambio.FIXA)
    responder({"USDBRL": {"bid": "1200"}})
    eq("valor absurdo também", cambio.taxa()["valor"], cambio.FIXA)
    responder({"USDBRL": {"bid": None}})
    eq("campo vazio também", cambio.taxa()["valor"], cambio.FIXA)
    responder("<html>manutenção</html>")
    eq("resposta que não é JSON de câmbio também", cambio.taxa()["valor"],
       cambio.FIXA)

    # Quem desligar a busca no .env não pode ver requisição nenhuma saindo.
    salvo_buscar = cambio.BUSCAR
    try:
        cambio.BUSCAR = False
        responder({"USDBRL": {"bid": "5.4321"}})
        eq("busca desligada usa a fixa", cambio.taxa()["valor"], cambio.FIXA)
        eq("busca desligada não toca na rede", len(chamadas), 0)
    finally:
        cambio.BUSCAR = salvo_buscar

    # Cache vencido busca de novo — senão um processo longo congelaria a
    # taxa do dia em que subiu.
    responder({"USDBRL": {"bid": "5.55"}})
    cambio.taxa()
    cambio._cache["quando"] -= cambio.TTL + 1
    cambio.taxa()
    eq("cache vencido busca de novo", len(chamadas), 2)
finally:
    cambio.requests.get = salvo_get
    cambio._cache = None


# ---------------------------------------------------------------------------
# A rota
# ---------------------------------------------------------------------------
#
# `GET /cambio` é a régua que o deckbuilder usa pra escrever preço em real.
# O que se trava aqui é que ela responde mesmo com a busca desligada — se ela
# devolvesse 502 quando a AwesomeAPI está fora, a tela perderia a moeda por
# causa de um enfeite.

print("\n--- a rota ---")

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
else:
    os.chdir(RAIZ)
    from app.main import app  # noqa: E402

    cliente = TestClient(app)
    salvo_buscar, salvo_get = cambio.BUSCAR, cambio.requests.get
    try:
        # Sem rede e sem busca: é o pior caso, e é o que tem que funcionar.
        cambio.BUSCAR = False
        cambio._cache = None
        cambio.requests.get = lambda *a, **k: (_ for _ in ()).throw(
            RuntimeError("o teste não vai à rede"))

        r = cliente.get("/cambio")
        eq("responde 200 mesmo sem rede", r.status_code, 200)
        corpo = r.json()
        check("o valor é utilizável pra multiplicar",
              isinstance(corpo.get("valor"), (int, float)) and corpo["valor"] > 0,
              f"(obtido {corpo.get('valor')!r})")
        eq("e diz que veio da taxa fixa", corpo.get("fonte"), "fixa")
        check("traz quando foi apurado", isinstance(corpo.get("quando"), (int, float)))
    finally:
        cambio.BUSCAR, cambio.requests.get = salvo_buscar, salvo_get
        cambio._cache = None

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
