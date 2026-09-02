"""
Confere o câmbio que alimenta o indicador de "carta cara aqui".

Motivo de existir: o câmbio é enfeite de comparação, então a regra dele é
NUNCA atrapalhar. Se a API cair, mudar de formato ou devolver bobagem, a
cotação inteira tem que seguir com a taxa fixa — e o cache tem que segurar
a requisição, pra uma cotação de 75 cartas não virar 75 consultas de câmbio.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_cambio.py

Sai com código 1 se qualquer checagem falhar.
"""
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

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

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
