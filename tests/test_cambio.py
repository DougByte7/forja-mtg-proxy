"""
Confere o câmbio: o indicador de "carta cara aqui" e a régua que faz o
deckbuilder escrever em real um preço que a base guarda em dólar.

Motivo de existir: os dois usos são de apresentação, então a regra é NUNCA
atrapalhar. Se a API cair, mudar de formato ou devolver bobagem, vale a
reserva, depois o último valor de verdade, e por fim a taxa fixa — e o
cache (memória e banco) tem que segurar a requisição, pra uma cotação de 75
cartas, ou cem processos da Vercel, não virarem cem consultas de câmbio.

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


def zerar_banco():
    conn = cambio._conn()
    conn.execute("CREATE TABLE IF NOT EXISTS cambio_guardado "
                 "(id INTEGER PRIMARY KEY, valor TEXT)")
    conn.execute("DELETE FROM cambio_guardado")
    conn.commit()
    conn.close()


def responder(corpo=None, erro=None, reserva=None, erro_reserva=None,
              novo_processo=True, banco_limpo=True):
    """Troca a rede por respostas fixas: `corpo`/`erro` pra AwesomeAPI,
    `reserva`/`erro_reserva` pra Frankfurter. Por padrão começa do zero —
    sem memória (processo novo) e sem nada guardado no banco."""
    def falso(url, **kwargs):
        chamadas.append(url)
        if url == cambio.URL_RESERVA:
            if erro_reserva or reserva is None:
                raise erro_reserva or RuntimeError("reserva fora")
            return Resposta(reserva)
        if erro:
            raise erro
        return Resposta(corpo)
    cambio.requests.get = falso
    if novo_processo:
        cambio._cache = None
    if banco_limpo:
        zerar_banco()
    chamadas.clear()


salvo_get = cambio.requests.get
try:
    responder({"USDBRL": {"code": "USD", "bid": "5.4321"}})
    eq("cotação boa vira taxa", cambio.taxa()["valor"], 5.4321)
    eq("e a tela sabe de onde veio", cambio.taxa()["fonte"], "awesomeapi")
    eq("segunda chamada sai do cache, sem bater na rede", len(chamadas), 1)

    # Na Vercel cada processo nasce sem memória: o valor tem que vir do
    # banco, senão cada processo novo pergunta de novo e estoura a cota.
    responder({"USDBRL": {"bid": "9.99"}}, banco_limpo=False)
    eq("processo novo lê o valor do banco", cambio.taxa()["valor"], 5.4321)
    eq("sem tocar na rede", len(chamadas), 0)

    # A chave do par não é fixa no código: quem apontar a CAMBIO_URL pra
    # outro endpoint do mesmo formato continua funcionando.
    responder({"USDBRLT": {"bid": "5.10"}})
    eq("não depende do nome da chave", cambio.taxa()["valor"], 5.10)

    # A AwesomeAPI fora (é o 429 da Vercel): vale a reserva.
    responder(erro=RuntimeError("429 QuotaExceeded"),
              reserva={"amount": 1.0, "base": "USD", "rates": {"BRL": 5.37}})
    atual = cambio.taxa()
    eq("AwesomeAPI fora: a reserva responde", atual["valor"], 5.37)
    eq("e a tela sabe que foi ela", atual["fonte"], "frankfurter")

    # Toda falha, das duas, cai na taxa fixa quando não há nada guardado.
    responder(erro=RuntimeError("sem rede"))
    eq("rede caída não levanta, cai na fixa", cambio.taxa()["valor"], cambio.FIXA)
    eq("e diz que é fixa", cambio.taxa()["fonte"], "fixa")
    eq("e não insiste a cada pedido", len(chamadas), 2)

    responder({"USDBRL": {"bid": "0.0001"}}, reserva={"rates": {"BRL": 0.0001}})
    eq("valor fora da faixa é ignorado", cambio.taxa()["valor"], cambio.FIXA)
    responder({"USDBRL": {"bid": "1200"}})
    eq("valor absurdo também", cambio.taxa()["valor"], cambio.FIXA)
    responder({"USDBRL": {"bid": None}}, reserva={"rates": {}})
    eq("campo vazio também", cambio.taxa()["valor"], cambio.FIXA)
    responder("<html>manutenção</html>", reserva="<html>idem</html>")
    eq("resposta que não é JSON de câmbio também", cambio.taxa()["valor"],
       cambio.FIXA)

    # Falhou tudo mas já houve um valor de verdade: ele vale mais que a fixa.
    responder({"USDBRL": {"bid": "5.60"}})
    cambio.taxa()
    responder(erro=RuntimeError("sem rede"), banco_limpo=False)
    cambio._gravar_banco({**cambio._ler_banco(),
                          "atual": {**cambio._ler_banco()["atual"], "vale_ate": 0}})
    atual = cambio.taxa()
    eq("as duas fora: vale o último valor de verdade", atual["valor"], 5.60)
    eq("dizendo de onde ele veio", atual["fonte"], "awesomeapi")

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
    cambio._cache["vale_ate"] = 0
    cambio._gravar_banco({**cambio._ler_banco(),
                          "atual": {**cambio._ler_banco()["atual"], "vale_ate": 0}})
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
