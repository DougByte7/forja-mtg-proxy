"""
As artes do MPC Fill — quais existem pra cada carta, e qual arquivo imprime.

POR QUE ISTO EXISTE, E O QUE ELE NÃO É. O sistema já imprime artes do MPC
Fill desde sempre: o XML que o cliente sobe traz, pra cada carta, um id de
arquivo no Google Drive, e o `pdf_generator` baixa dali. O que faltava era
ESCOLHER esse id sem sair daqui — o caminho de hoje é exportar a decklist,
colar no site deles, escolher na tela deles e voltar com o XML.

Este módulo cobre só a escolha. Nada abaixo toca no PDF: o `pdf_generator`
continua recebendo um id do Drive e não sabe que este arquivo existe.

O CONTRATO É DELES, E É ABERTO. O MPC Fill é código aberto
(`chilli-axe/mpc-autofill`) e o site publica o mesmo backend Django que o
front-end deles consome. Quatro rotas interessam:

  * `GET  /2/sources/`      as bibliotecas de arte e a ORDEM delas
  * `POST /2/editorSearch/` os ids de todas as artes de cada nome pedido
  * `POST /2/cards/`        os metadados dos ids escolhidos
  * `GET  /2/DFCPairs/`     os pares frente→verso das cartas de duas faces

DUAS REQUISIÇÕES COBREM UM DECK INTEIRO, e é isso que torna a tela viável: a
busca aceita a lista toda de uma vez e devolve só ids (Sol Ring tem 713
artes, e 713 ids são alguns KB); os metadados vêm depois, só da página de
miniaturas que a pessoa está de fato olhando. Pedir metadados dos 713 × 100
cartas seria absurdo — a paginação sai da forma da API deles, não de uma
escolha de tela.

SÓ NO CLIQUE, NUNCA AUTOMÁTICO. Mesma regra do Spellbook e da cotação: o deck
muda a cada carta adicionada, e uma busca automática viraria uma requisição
por clique do usuário em cima de um serviço gratuito de outra pessoa. O freio,
o cache de uma semana e o `MPCFILL=0` são a etiqueta inteira deste módulo.

FALHA VIRA ERRO, NUNCA GRADE VAZIA. "Não consegui perguntar" e "essa carta não
tem arte" são respostas opostas, e a segunda faria a pessoa desistir de uma
carta que tem 500 artes. Mesma regra dos combos, do poder e das sugestões.
"""
import hashlib
import json
import os
import time

import requests

from . import identidade as ident, log, ritmo

BASE = os.environ.get("MPCFILL_URL", "https://mpcfill.com")
USER_AGENT = os.environ.get(
    "MPCFILL_USER_AGENT", ident.user_agent("escolha de arte"))
TIMEOUT = float(os.environ.get("MPCFILL_TIMEOUT", "30"))
TENTATIVAS = int(os.environ.get("MPCFILL_TENTATIVAS", "3"))
BACKOFF = float(os.environ.get("MPCFILL_BACKOFF", "1"))
DELAY_SEGUNDOS = float(os.environ.get("MPCFILL_DELAY_SEGUNDOS", "1"))
# Cache longo de propósito, ao contrário do Spellbook: biblioteca de arte muda
# devagar (alguém sobe um scan novo), e o custo de errar é mostrar uma arte a
# menos numa grade de centenas. Combo novo muda o que é verdade sobre o deck;
# arte nova, não.
CACHE_TTL = float(os.environ.get("MPCFILL_CACHE_TTL", str(7 * 24 * 3600)))
CACHE_DIR = os.environ.get("MPCFILL_CACHE_DIR", "/app/data/mpcfill-cache")
# Faz parte do nome de cada arquivo do cache. Subir o número descarta de uma
# vez tudo o que foi guardado com uma leitura errada da API — sem isso, um
# parse consertado continuaria servindo o resultado velho por uma semana, e o
# único jeito de sair seria entrar no servidor e apagar a pasta.
CACHE_VERSAO = 2
LIGADO = os.environ.get("MPCFILL", "1") == "1"

# O deck inteiro cabe numa busca. O teto existe pra impedir uma lista sem fim,
# não pra policiar quem tem deck grande.
MAX_NOMES = 120
# Quantos ids por consulta de metadados. Alto de propósito, e medido: os 713
# ids de Sol Ring — a carta com mais artes que se conhece — voltam com
# metadados completos em 0,6 s numa requisição só.
#
# Isto não é detalhe de performance, é o que faz o FILTRO funcionar. Carregar
# metadados por página deixaria o filtro de edição enxergando 24 arquivos de
# 713: filtrar por "Kaladesh" não acharia quase nada, e nada na tela diria por
# quê. Com tudo carregado, o filtro vê o conjunto inteiro.
#
# É UMA requisição por carta ABERTA (não por deck): quem abre a modal de três
# cartas paga três, e o cache de uma semana cobre a segunda visita.
MAX_IDS = 800

_freio = ritmo.Freio("mpcfill", DELAY_SEGUNDOS)


class MPCFillError(Exception):
    """Não deu pra perguntar ao MPC Fill, ou ele respondeu o que não entendo."""


def _sessao() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT,
                      "Accept": "application/json",
                      "Content-Type": "application/json"})
    return s


# ---------------------------------------------------------------------------
# Cache em disco
# ---------------------------------------------------------------------------

def _caminho(prefixo: str, chave: str) -> str:
    return os.path.join(CACHE_DIR, f"{prefixo}-v{CACHE_VERSAO}-{chave}.json")


def _do_cache(prefixo: str, chave: str) -> dict | None:
    try:
        with open(_caminho(prefixo, chave), encoding="utf-8") as f:
            guardado = json.load(f)
    except (OSError, ValueError):
        return None
    if time.time() - guardado.get("quando", 0) > CACHE_TTL:
        return None
    return guardado.get("dados")


def _guardar(prefixo: str, chave: str, dados) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        # Escreve ao lado e renomeia: um processo morto no meio da escrita
        # deixaria um JSON pela metade que a próxima leitura teria que
        # adivinhar. Mesma ideia do `cache_precos` e do `spellbook`.
        temporario = _caminho(prefixo, chave) + ".tmp"
        with open(temporario, "w", encoding="utf-8") as f:
            json.dump({"quando": time.time(), "dados": dados}, f,
                      ensure_ascii=False)
        os.replace(temporario, _caminho(prefixo, chave))
    except OSError as e:
        log.aviso("mpcfill", "cache-nao-gravou",
                  motivo=f"{type(e).__name__}: {e}")


def _chave(*partes) -> str:
    cru = json.dumps(partes, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(cru.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# A requisição
# ---------------------------------------------------------------------------

def _pedir(caminho: str, corpo: dict | None = None):
    """Uma requisição ao MPC Fill, com tentativas e freio de 429.

    `corpo` decide o método: sem corpo é GET, com corpo é POST. Não é gosto —
    é o que cada rota deles define, e mandar o outro volta 405.

    Levanta `MPCFillError` quando não deu. Nunca devolve resultado parcial:
    meia grade de artes é pior que grade nenhuma, porque a pessoa escolhe
    dentro do que vê sem saber que faltou.
    """
    if not LIGADO:
        raise MPCFillError(
            "A escolha de arte está desligada neste servidor (MPCFILL=0).")

    sessao = _sessao()
    url = f"{BASE}/{caminho}"
    ultimo_erro = "?"

    for tentativa in range(1, TENTATIVAS + 1):
        _freio.esperar()
        try:
            if corpo is None:
                resposta = sessao.get(url, timeout=TIMEOUT)
            else:
                resposta = sessao.post(url, data=json.dumps(corpo),
                                       timeout=TIMEOUT)
        except requests.RequestException as e:
            ultimo_erro = f"{type(e).__name__}: {e}"
            log.aviso("mpcfill", "falhou", tentativa=tentativa,
                      motivo=ultimo_erro)
            time.sleep(ritmo.backoff(tentativa, BACKOFF))
            continue

        if resposta.status_code == 429:
            espera = ritmo.espera_pedida(resposta) or ritmo.backoff(tentativa, BACKOFF)
            _freio.recuar(espera, motivo="HTTP 429")
            ultimo_erro = "HTTP 429"
            continue

        if resposta.status_code >= 500:
            ultimo_erro = f"HTTP {resposta.status_code}"
            log.aviso("mpcfill", "erro-do-servidor", tentativa=tentativa,
                      status=resposta.status_code)
            time.sleep(ritmo.backoff(tentativa, BACKOFF))
            continue

        if resposta.status_code != 200:
            # 4xx é pedido malfeito: repetir igual daria igual.
            raise MPCFillError(
                f"o MPC Fill recusou a consulta (HTTP {resposta.status_code}): "
                f"{resposta.text[:200]}")

        try:
            return resposta.json()
        except ValueError:
            raise MPCFillError(
                "o MPC Fill respondeu algo que não é JSON — provavelmente uma "
                "página de erro ou manutenção")

    raise MPCFillError(f"não consegui falar com o MPC Fill ({ultimo_erro})")


# ---------------------------------------------------------------------------
# As quatro consultas
# ---------------------------------------------------------------------------

def fontes() -> list[dict]:
    """As bibliotecas de arte, NA ORDEM DELES.

    A ordem importa e não é alfabética: é a prioridade que o próprio site usa
    pra decidir qual arte aparece primeiro. Respeitá-la faz "a primeira" daqui
    ser a mesma "primeira" que a pessoa veria lá — que é o fluxo sendo
    substituído.
    """
    guardado = _do_cache("fontes", "todas")
    if guardado is not None:
        return guardado

    bruto = _pedir("2/sources/")
    # `results` vem como DICIONÁRIO indexado pela pk ("1", "2", …), e não como
    # lista — e os campos são camelCase (`sourceType`), porque o Django deles
    # usa um renderer camelCase. Medido contra a API de verdade.
    saida = []
    for f in (bruto.get("results") or {}).values():
        pk = f.get("pk")
        if pk is None:
            continue
        saida.append({
            "pk": int(pk),
            "chave": f.get("key") or "",
            "nome": f.get("name") or f.get("key") or "",
            "tipo": f.get("sourceType") or "",
        })
    if not saida:
        raise MPCFillError("o MPC Fill devolveu uma lista de fontes vazia.")
    # Na ordem de prioridade deles, que é a `pk`.
    saida.sort(key=lambda f: f["pk"])
    _guardar("fontes", "todas", saida)
    return saida


def buscar(nomes: list[str]) -> dict[str, list[str]]:
    """Os ids de arte de cada nome, numa requisição só pro deck inteiro.

    Devolve `{nome_pedido: [drive_id, ...]}`, na ordem de prioridade das
    fontes. SÓ IDS: os metadados (nome do arquivo, DPI, tamanho, miniatura)
    vêm depois, só da página que a pessoa está olhando — Sol Ring tem 713
    artes, e pedir metadados de todas seria buscar o que ninguém vai ver.

    Nome que a busca deles não conhece volta com lista VAZIA, não some do
    dicionário: quem chama precisa distinguir "não tem arte" de "não perguntei".
    """
    nomes = [str(n).strip() for n in nomes if str(n or "").strip()]
    if not nomes:
        return {}
    if len(nomes) > MAX_NOMES:
        raise MPCFillError(
            f"são até {MAX_NOMES} cartas por busca; vieram {len(nomes)}.")

    chave = _chave(sorted(n.lower() for n in nomes))
    guardado = _do_cache("busca", chave)
    if guardado is not None:
        return guardado

    # O formato do `editorSearch` deles: uma "query" por carta, com o tipo de
    # face. `CARD` é a frente; o verso sai do `/2/DFCPairs/`, que é chaveado
    # por nome e não por id.
    consultas = {nome: _consulta(nome) for nome in nomes}
    corpo = {
        "searchSettings": _busca_padrao(),
        "queries": [{"query": q, "cardType": "CARD"}
                    for q in dict.fromkeys(consultas.values())],
    }
    bruto = _pedir("2/editorSearch/", corpo)
    resultados = (bruto.get("results") or {})

    saida: dict[str, list[str]] = {}
    for nome, q in consultas.items():
        # A chave da resposta é a query como foi mandada; o minúsculo fica de
        # reserva, porque o casamento do lado deles ignora caixa.
        achado = resultados.get(q) or resultados.get(q.lower()) or {}
        ids = achado.get("CARD") if isinstance(achado, dict) else achado
        saida[nome] = [str(i) for i in (ids or [])]

    achadas = sum(1 for v in saida.values() if v)
    # Nenhuma carta com arte é quase sempre consulta quebrada, não verdade —
    # o deck inteiro sem uma arte sequer não acontece. Guardar isso travaria a
    # grade vazia por uma semana; sem guardar, o próximo clique pergunta de novo.
    if achadas:
        _guardar("busca", chave, saida)
    log.evento("mpcfill", "buscou", cartas=len(nomes), achadas=achadas)
    return saida


def _consulta(nome: str) -> str:
    """O que se pergunta ao MPC Fill por uma carta: o nome da FRENTE.

    A base local guarda carta de duas faces como "Delver of Secrets //
    Insectile Aberration", e a biblioteca deles indexa cada face pelo próprio
    nome — o nome inteiro volta com zero artes, e a grade diria que a carta
    não tem nenhuma.
    """
    return nome.split(" // ")[0].strip() or nome


def _busca_padrao() -> dict:
    """Os ajustes de busca que o site deles manda por padrão.

    Todas as fontes ligadas, na ordem que `/2/sources/` devolve, e sem filtro
    de DPI nem de tamanho — filtrar aqui esconderia arte da grade sem a pessoa
    ter pedido. O filtro de verdade é na tela, onde ela vê o que está tirando.
    """
    # Por PK, e não pela `key`: o schema deles pede o número. Mandar a string
    # volta 400 com "Schema error/s" — e um 400 não é retentável, então isso
    # vira 502 na primeira tentativa, sem nada na tela explicando.
    #
    # Sem as fontes, a busca não sai: com a lista de fontes vazia o MPC Fill
    # responde 200 com zero artes pra toda carta, e isso se leria como "essa
    # carta não tem arte". O `MPCFillError` de `fontes()` sobe como está.
    pks = [f["pk"] for f in fontes()]
    return {
        "searchTypeSettings": {"fuzzySearch": False, "filterCardbacks": False},
        "sourceSettings": {"sources": [[pk, True] for pk in pks]},
        "filterSettings": {"minimumDPI": 0, "maximumDPI": 1500,
                           "maximumSize": 30, "languages": [], "includesTags": [],
                           "excludesTags": ["NSFW"]},
    }


def metadados(ids: list[str]) -> dict[str, dict]:
    """Os metadados dos ids escolhidos: nome do arquivo, DPI, tamanho, fonte.

    É o que a grade precisa pra mostrar mais que um retângulo, e o que o
    `revalidar` usa pra saber se um id guardado ainda existe na biblioteca.

    Id que eles não conhecem simplesmente não volta no dicionário — e é assim
    que se descobre arte que sumiu.
    """
    ids = [str(i).strip() for i in ids if str(i or "").strip()]
    if not ids:
        return {}
    if len(ids) > MAX_IDS:
        raise MPCFillError(f"são até {MAX_IDS} artes por consulta; vieram {len(ids)}.")

    chave = _chave(sorted(ids))
    guardado = _do_cache("cards", chave)
    if guardado is not None:
        return guardado

    bruto = _pedir("2/cards/", {"cardIdentifiers": ids})
    saida = {}
    for ident_id, c in ((bruto.get("results") or {})).items():
        saida[str(ident_id)] = {
            "id": str(ident_id),
            "nome": c.get("name") or "",
            "arquivo": _arquivo(c),
            # camelCase, como todo o resto da API deles.
            "fonte": c.get("sourceName") or c.get("source") or "",
            "dpi": int(c.get("dpi") or 0),
            "tamanho": int(c.get("size") or 0),
            # ELES já devolvem a URL da miniatura pronta. Preferir a deles a
            # montar a nossa é o certo: se um dia mudarem de hospedagem, a
            # grade acompanha sozinha.
            "miniatura": c.get("smallThumbnailUrl") or miniatura(str(ident_id)),
        }
    _guardar("cards", chave, saida)
    return saida


def _arquivo(c: dict) -> str:
    """O `<name>` que vai no XML: nome do arquivo, com extensão.

    O XML do MPC Fill carrega isso junto do id, e o `calc._card_name` o trata
    como reserva do `<query>`. Guardar o nome do arquivo é metade do "caminho
    de volta" quando um id do Drive envelhece: com ele dá pra reconhecer a
    arte que a pessoa tinha escolhido, mesmo depois de o arquivo sumir.
    """
    nome = (c.get("name") or "").strip()
    ext = (c.get("extension") or "png").strip().lstrip(".")
    return f"{nome}.{ext}" if nome else ""


def pares_dfc() -> dict[str, str]:
    """Os pares frente→verso das cartas de duas faces, chaveados pelo NOME.

    Chaveado por nome e não por id de propósito — é assim que eles publicam, e
    é o que a base local já tem na mão. Cache junto com o resto: são poucas
    centenas de pares e mudam quando sai coleção nova.
    """
    guardado = _do_cache("dfc", "todos")
    if guardado is not None:
        return guardado

    bruto = _pedir("2/DFCPairs/")
    # A chave de topo é `dfcPairs`, não `results` — é a única das quatro rotas
    # que foge do padrão. Medido contra a API de verdade.
    pares = {}
    for frente, verso in ((bruto.get("dfcPairs") or bruto.get("results") or {})).items():
        if frente and verso:
            pares[str(frente).strip().lower()] = str(verso).strip()
    _guardar("dfc", "todos", pares)
    return pares


def miniatura(drive_id: str, largura: int = 300) -> str:
    """A URL da miniatura de uma arte.

    Aponta direto pro Google Drive: o navegador carrega sem passar por aqui,
    que é o que torna uma grade de 24 imagens barata pra este servidor. É a
    MESMA forma que o `index.html` já usa pra prévia da folha — inclusive o
    fallback `lh3.googleusercontent.com`, que mora lá.
    """
    return (f"https://drive.google.com/thumbnail?id={drive_id}&sz=w{int(largura)}")
