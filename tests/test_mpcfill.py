"""
Confere o cliente do MPC Fill: o parse, o cache e a etiqueta.

MOTIVO DE EXISTIR. Este módulo fala com o servidor gratuito de outra pessoa
pra buscar centenas de artes por deck. Duas famílias de erro importam, e são
opostas:

1. **Errar pra menos, calado.** Uma resposta que este parse não entende NÃO
   pode virar `{}`. Na tela, dicionário vazio se lê como "essa carta não tem
   arte nenhuma" — e a pessoa desiste de uma carta que tem quinhentas. "Não
   consegui perguntar" e "não tem" são respostas opostas, e é a mesma regra
   dos combos, do poder e das sugestões.
2. **Errar pra mais, em cima de quem hospeda.** Sem cache e sem teto, uma
   grade de miniaturas viraria uma consulta por rolagem, e o deck inteiro
   viraria uma busca por tecla digitada. O freio, o cache de uma semana e os
   dois tetos (`MAX_NOMES`, `MAX_IDS`) são a etiqueta inteira deste módulo, e
   quebrá-los não dá erro em lugar nenhum — só nos torna o problema de
   alguém.

Também trava o formato de duas requisições: a busca devolve SÓ IDS (Sol Ring
tem 713 artes; pedir metadados de todas seria buscar o que ninguém vai ver), e
os metadados vêm depois, da página que a pessoa está olhando.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_mpcfill.py

Sai com código 1 se qualquer checagem falhar.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-mpcfill-")
os.environ["MPCFILL_CACHE_DIR"] = os.path.join(TMP, "cache")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["MPCFILL_BACKOFF"] = "0"
os.environ["MPCFILL_DELAY_SEGUNDOS"] = "0"
os.environ["MPCFILL_TENTATIVAS"] = "2"

from app import mpcfill  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


class RespostaFalsa:
    def __init__(self, corpo, status=200, texto=None, headers=None):
        self.status_code = status
        self._corpo = corpo
        self.text = texto if texto is not None else json.dumps(corpo)
        self.headers = headers or {}

    def json(self):
        if self._corpo is None:
            raise ValueError("não é json")
        return self._corpo


class SessaoFalsa:
    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.chamadas = []
        self.headers = {}

    def _responder(self, url, **kwargs):
        self.chamadas.append((url, kwargs.get("data")))
        resposta = self.respostas.pop(0)
        if isinstance(resposta, Exception):
            raise resposta
        return resposta

    get = _responder
    post = _responder


def ligar(*respostas):
    """Troca a sessão do módulo e limpa o cache — cada bloco começa do zero."""
    shutil.rmtree(os.environ["MPCFILL_CACHE_DIR"], ignore_errors=True)
    sessao = SessaoFalsa(respostas)
    mpcfill._sessao = lambda: sessao
    return sessao


FONTES = {"results": {"sources": [
    {"key": "chilli", "name": "Chilli Axe MPC Proxies", "source_type": "Google Drive"},
    {"key": "nofrills", "name": "No Frills", "source_type": "Google Drive"},
]}}

BUSCA = {"results": {
    "Sol Ring": {"CARD": ["aaa", "bbb", "ccc"]},
    "Carta Inventada": {"CARD": []},
}}

CARDS = {"results": {
    "aaa": {"name": "Sol Ring (Kaladesh)", "extension": "png",
            "source_name": "Chilli Axe MPC Proxies", "dpi": 800, "size": 9_000_000},
}}

try:
    print("\n--- fontes ---")

    sessao = ligar(RespostaFalsa(FONTES))
    fontes = mpcfill.fontes()
    eq("lê as fontes", [f["chave"] for f in fontes], ["chilli", "nofrills"])
    # A ordem é a prioridade que o próprio site deles usa. Ordenar por conta
    # própria faria "a primeira arte" daqui ser outra que a de lá — e o fluxo
    # que isto substitui é justamente o de escolher lá.
    eq("na ordem que eles mandaram", fontes[0]["nome"], "Chilli Axe MPC Proxies")

    mpcfill.fontes()
    eq("a segunda chamada sai do cache, sem tocar na rede", len(sessao.chamadas), 1)

    # Lista vazia é resposta quebrada, não "não há fontes": sem fonte nenhuma
    # a busca inteira devolveria vazio, e isso se leria como "não tem arte".
    ligar(RespostaFalsa({"results": {"sources": []}}))
    try:
        mpcfill.fontes()
        check("fonte vazia grita em vez de virar lista vazia", False, "(passou)")
    except mpcfill.MPCFillError:
        check("fonte vazia grita em vez de virar lista vazia", True)

    print("\n--- busca ---")

    sessao = ligar(RespostaFalsa(FONTES), RespostaFalsa(BUSCA))
    achado = mpcfill.buscar(["Sol Ring", "Carta Inventada"])
    eq("devolve os ids de cada carta", achado["Sol Ring"], ["aaa", "bbb", "ccc"])
    # Lista vazia em vez de sumir do dicionário: quem chama precisa distinguir
    # "não tem arte" de "não perguntei por essa".
    eq("carta sem arte volta com lista vazia, não some",
       achado["Carta Inventada"], [])

    corpo = json.loads(sessao.chamadas[-1][1])
    eq("manda uma query por carta", len(corpo["queries"]), 2)
    check("com o tipo de face que a API pede",
          all(q["cardType"] == "CARD" for q in corpo["queries"]))
    check("e as fontes ligadas, na ordem delas",
          [s[0] for s in corpo["searchSettings"]["sourceSettings"]["sources"]]
          == ["chilli", "nofrills"])

    sessao = ligar(RespostaFalsa(FONTES), RespostaFalsa(BUSCA))
    mpcfill.buscar(["Sol Ring", "Carta Inventada"])
    antes = len(sessao.chamadas)
    mpcfill.buscar(["Carta Inventada", "Sol Ring"])   # a ordem não muda a chave
    eq("a mesma busca em outra ordem sai do cache", len(sessao.chamadas), antes)

    eq("busca vazia não vira requisição", mpcfill.buscar([]), {})

    try:
        mpcfill.buscar(["x"] * (mpcfill.MAX_NOMES + 1))
        check("acima do teto é recusado antes de sair daqui", False, "(passou)")
    except mpcfill.MPCFillError:
        check("acima do teto é recusado antes de sair daqui", True)

    print("\n--- metadados ---")

    sessao = ligar(RespostaFalsa(CARDS))
    meta = mpcfill.metadados(["aaa", "zzz"])
    eq("lê o nome do arquivo com extensão",
       meta["aaa"]["arquivo"], "Sol Ring (Kaladesh).png")
    eq("o DPI", meta["aaa"]["dpi"], 800)
    eq("e a fonte", meta["aaa"]["fonte"], "Chilli Axe MPC Proxies")
    # É assim que se descobre arte que sumiu da biblioteca: o id não volta.
    check("id que eles não conhecem simplesmente não volta", "zzz" not in meta)

    check("a miniatura aponta pro Drive, sem passar por este servidor",
          "drive.google.com" in meta["aaa"]["miniatura"] and "aaa" in meta["aaa"]["miniatura"])

    try:
        mpcfill.metadados(["x"] * (mpcfill.MAX_IDS + 1))
        check("acima do teto de ids é recusado", False, "(passou)")
    except mpcfill.MPCFillError:
        check("acima do teto de ids é recusado", True)

    print("\n--- pares de dupla face ---")

    sessao = ligar(RespostaFalsa({"results": {"Delver of Secrets": "Insectile Aberration"}}))
    pares = mpcfill.pares_dfc()
    # Chaveado pelo nome ACHATADO: a base local casa nomes assim, e a busca do
    # verso parte do nome da frente que ela tem.
    eq("o par é chaveado por nome minúsculo",
       pares["delver of secrets"], "Insectile Aberration")

    print("\n--- quando o serviço falha ---")

    # A família de erro que mais importa: nada aqui pode virar dicionário
    # vazio, que na tela se lê como "essa carta não tem arte".
    for nome, resposta in [
        ("HTTP 500 esgota as tentativas e grita",
         [RespostaFalsa({}, status=500), RespostaFalsa({}, status=500)]),
        ("HTTP 400 grita na hora (repetir daria igual)",
         [RespostaFalsa({}, status=400, texto="pedido malfeito")]),
        ("resposta que não é JSON grita",
         [RespostaFalsa(None, texto="<html>manutenção</html>")]),
    ]:
        ligar(*resposta)
        try:
            mpcfill._pedir("2/sources/")
            check(nome, False, "(não levantou)")
        except mpcfill.MPCFillError:
            check(nome, True)

    import requests
    ligar(requests.ConnectionError("sem rede"), requests.ConnectionError("sem rede"))
    try:
        mpcfill._pedir("2/sources/")
        check("rede caída grita", False, "(não levantou)")
    except mpcfill.MPCFillError:
        check("rede caída grita", True)

    print("\n--- o botão de desligar ---")

    # `MPCFILL=0` tem que ser um NÃO explícito, com a razão. Se virasse
    # resultado vazio, a tela diria "essa carta não tem arte" pra tudo.
    mpcfill.LIGADO = False
    try:
        mpcfill._pedir("2/sources/")
        check("desligado recusa com a razão, não com vazio", False, "(passou)")
    except mpcfill.MPCFillError as e:
        check("desligado recusa com a razão, não com vazio", "MPCFILL=0" in str(e))
    finally:
        mpcfill.LIGADO = True

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
