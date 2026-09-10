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


# As formas abaixo foram MEDIDAS contra a API de verdade em 10/09/2026, e
# cada uma delas foge do que "parecia óbvio" — foi por isso que a primeira
# versão deste cliente devolvia 502 na primeira requisição:
#
#   * `/2/sources/` devolve um DICIONÁRIO indexado pela pk, não uma lista em
#     `results.sources`, e em camelCase (`sourceType`).
#   * o `editorSearch` quer as fontes pela **pk numérica**; mandar a `key`
#     volta 400 "Schema error/s".
#   * o resultado da busca vem indexado pela query **como foi mandada**.
#   * com a lista de fontes vazia, a busca responde 200 com ZERO artes pra
#     toda carta — não é erro do lado deles, e por isso tem que ser do nosso.
#   * carta de duas faces só acha arte pelo nome da frente.
#   * o `/2/DFCPairs/` devolve em `dfcPairs`, não em `results`.
FONTES = {"results": {
    "1": {"key": "MrTeferi", "name": "MrTeferi", "pk": 1, "sourceType": "Google Drive"},
    "3": {"key": "Chilli_Axe", "name": "Chilli_Axe", "pk": 3, "sourceType": "Google Drive"},
}}

BUSCA = {"results": {
    "Sol Ring": {"CARD": ["aaa", "bbb", "ccc"]},
    "Carta Inventada": {"CARD": []},
}}

CARDS = {"results": {
    "aaa": {"name": "Sol Ring (Kaladesh)", "extension": "png",
            "sourceName": "Chilli_Axe", "dpi": 800, "size": 9_000_000,
            "smallThumbnailUrl": "https://drive.google.com/thumbnail?sz=w400-h400&id=aaa"},
}}

try:
    print("\n--- fontes ---")

    sessao = ligar(RespostaFalsa(FONTES))
    fontes = mpcfill.fontes()
    eq("lê as fontes do dicionário indexado por pk",
       [f["chave"] for f in fontes], ["MrTeferi", "Chilli_Axe"])
    # A pk é o que a busca pede. Guardar só a `key` foi o bug que fez a
    # primeira versão devolver 400 e virar 502 na tela.
    eq("guarda a pk, que é o que a busca pede", [f["pk"] for f in fontes], [1, 3])
    # A ordem é a prioridade que o próprio site deles usa. Ordenar por conta
    # própria faria "a primeira arte" daqui ser outra que a de lá — e o fluxo
    # que isto substitui é justamente o de escolher lá.
    eq("na ordem de prioridade deles", fontes[0]["nome"], "MrTeferi")

    mpcfill.fontes()
    eq("a segunda chamada sai do cache, sem tocar na rede", len(sessao.chamadas), 1)

    # Lista vazia é resposta quebrada, não "não há fontes": sem fonte nenhuma
    # a busca inteira devolveria vazio, e isso se leria como "não tem arte".
    ligar(RespostaFalsa({"results": {}}))
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
    # Por PK e não pela key: mandar string volta 400, que não é retentável e
    # vira 502 imediato na tela — exatamente o sintoma que isto conserta.
    eq("as fontes vão pela pk numérica",
       [s[0] for s in corpo["searchSettings"]["sourceSettings"]["sources"]], [1, 3])

    sessao = ligar(RespostaFalsa(FONTES), RespostaFalsa(BUSCA))
    mpcfill.buscar(["Sol Ring", "Carta Inventada"])
    antes = len(sessao.chamadas)
    mpcfill.buscar(["Carta Inventada", "Sol Ring"])   # a ordem não muda a chave
    eq("a mesma busca em outra ordem sai do cache", len(sessao.chamadas), antes)

    eq("busca vazia não vira requisição", mpcfill.buscar([]), {})

    # Sem fontes a busca devolveria zero artes pra tudo, e a tela diria "não
    # tem arte" pro deck inteiro. Tem que gritar antes de perguntar.
    sessao = ligar(RespostaFalsa({}, status=500), RespostaFalsa({}, status=500))
    try:
        mpcfill.buscar(["Sol Ring"])
        check("sem as fontes a busca grita, não sai sem fonte", False, "(passou)")
    except mpcfill.MPCFillError:
        check("sem as fontes a busca grita, não sai sem fonte",
              not any("editorSearch" in url for url, _ in sessao.chamadas))

    # Nenhuma carta com arte não é guardado: senão uma resposta ruim travaria
    # a grade vazia pela semana inteira do cache.
    sessao = ligar(RespostaFalsa(FONTES),
                   RespostaFalsa({"results": {"Sol Ring": {"CARD": []}}}),
                   RespostaFalsa(BUSCA))
    mpcfill.buscar(["Sol Ring"])
    eq("resultado sem arte nenhuma não fica no cache",
       mpcfill.buscar(["Sol Ring"])["Sol Ring"], ["aaa", "bbb", "ccc"])

    # A base local guarda "Frente // Verso"; lá cada face tem o próprio nome.
    sessao = ligar(RespostaFalsa(FONTES), RespostaFalsa({"results": {
        "Delver of Secrets": {"CARD": ["ddd"]}}}))
    achado = mpcfill.buscar(["Delver of Secrets // Insectile Aberration"])
    corpo = json.loads(sessao.chamadas[-1][1])
    eq("dupla face pergunta pelo nome da frente",
       [q["query"] for q in corpo["queries"]], ["Delver of Secrets"])
    eq("e devolve chaveado pelo nome que veio do deck",
       achado, {"Delver of Secrets // Insectile Aberration": ["ddd"]})

    # A versão no nome do arquivo é o que descarta um cache gravado com uma
    # leitura errada da API, sem ninguém entrar no servidor.
    check("o arquivo do cache carrega a versão",
          f"-v{mpcfill.CACHE_VERSAO}-" in mpcfill._caminho("busca", "x"))

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
    eq("e a fonte, que vem em camelCase", meta["aaa"]["fonte"], "Chilli_Axe")
    # É assim que se descobre arte que sumiu da biblioteca: o id não volta.
    check("id que eles não conhecem simplesmente não volta", "zzz" not in meta)

    # Eles já devolvem a URL pronta; preferir a deles faz a grade acompanhar
    # sozinha se um dia mudarem de hospedagem.
    eq("usa a miniatura que eles mandam",
       meta["aaa"]["miniatura"],
       "https://drive.google.com/thumbnail?sz=w400-h400&id=aaa")

    try:
        mpcfill.metadados(["x"] * (mpcfill.MAX_IDS + 1))
        check("acima do teto de ids é recusado", False, "(passou)")
    except mpcfill.MPCFillError:
        check("acima do teto de ids é recusado", True)

    print("\n--- pares de dupla face ---")

    sessao = ligar(RespostaFalsa({"dfcPairs": {"Delver of Secrets": "Insectile Aberration"}}))
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
