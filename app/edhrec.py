"""
Sugestões de carta por sinergia, lidas do EDHREC.

AVISO, leia antes de mexer: isto NÃO é uma API oficial. O EDHREC não oferece
uma. O que existe é `json.edhrec.com`, o endpoint que o front-end do próprio
site chama pra desenhar as páginas — aberto, sem chave, e **sem contrato**:
pode mudar de forma ou sumir sem aviso nenhum.

Consequência prática, a mesma da LigaMagic: **este módulo quebra sem aviso
quando eles mudarem qualquer coisa**. Por isso ele grita alto (exceção com
mensagem explicando o quê) em vez de devolver lista vazia. Sugestão vazia é
indistinguível de "esse comandante não tem sinergia nenhuma", e as duas
coisas são opostas.

O QUE ESTE MÓDULO FAZ DIFERENTE das bibliotecas prontas que existem por aí:

  * **Se identifica.** O `User-Agent` diz quem é e traz o e-mail de contato
    do `.env` (ver `identidade.py`). Bibliotecas populares de EDHREC sorteiam
    um User-Agent de navegador a cada chamada pra parecer gente; aqui não. Se
    eles quiserem falar com a gente, ou bloquear, que seja pelo caminho
    fácil.
  * **Vai devagar.** Um pedido por segundo, que é o ritmo que a comunidade
    trata como aceitável ali, e o resultado fica em cache por horas. Uma
    página de comandante muda de conteúdo devagar — os dados são agregados de
    milhares de decks e não mudam de hora em hora.
  * **Pede pouco.** Uma requisição por consulta (duas quando há tema), e só
    quando alguém clica.

POR QUE ISSO EXISTE. A Scryfall responde "que cartas existem"; ela não sabe
dizer que *Deadly Rollick* combina com um comandante e *Murder* não. Sinergia
é dado agregado de decks reais, e quem tem isso é o EDHREC.
"""
import json
import os
import re
import time
import unicodedata

import requests

from . import identidade as ident, log, ritmo
from .cartas import face_da_frente
from .poder import NOME_DO_BRACKET

BASE = os.environ.get("EDHREC_URL", "https://json.edhrec.com/pages")
SITE = os.environ.get("EDHREC_SITE", "https://edhrec.com")
USER_AGENT = os.environ.get(
    "EDHREC_USER_AGENT", ident.user_agent("sugestões de deck"))
TIMEOUT = float(os.environ.get("EDHREC_TIMEOUT", "20"))
TENTATIVAS = int(os.environ.get("EDHREC_TENTATIVAS", "3"))
BACKOFF = float(os.environ.get("EDHREC_BACKOFF", "2"))
# Um pedido por segundo. Ver o aviso no topo.
DELAY_SEGUNDOS = float(os.environ.get("EDHREC_DELAY_SEGUNDOS", "1"))
# Cache longo de propósito: os números do EDHREC são agregados de milhares de
# decks e não mudam de hora em hora. Cada acerto aqui é um acesso a menos.
CACHE_TTL = float(os.environ.get("EDHREC_CACHE_TTL", str(24 * 3600)))
CACHE_DIR = os.environ.get("EDHREC_CACHE_DIR", "/app/data/edhrec-cache")
LIGADO = os.environ.get("EDHREC", "1") == "1"

_freio = ritmo.Freio("edhrec", DELAY_SEGUNDOS)


class EDHRECError(Exception):
    """Falha lendo o EDHREC. A mensagem diz se foi rede ou mudança de formato."""


class PaginaInexistente(EDHRECError):
    """O EDHREC não tem a página pedida. É informação, não falha de rede — e
    quem pediu às vezes sabe dizer POR QUE ela não existe melhor que o
    `_pedir` (ver `deck_medio`)."""


# As categorias que valem a pena mostrar, na ordem em que aparecem, com o
# nome em português. O EDHREC devolve mais que isso (cartas novas, terrenos
# básicos, "cartas do topo do formato"); estas são as que respondem "o que
# mais falta no meu deck".
CATEGORIAS = [
    ("highsynergycards", "Alta sinergia"),
    ("newcards", "Cartas novas"),
    ("topcards", "Mais jogadas com ele"),
    ("creatures", "Criaturas"),
    ("instants", "Instantâneos"),
    ("sorceries", "Feitiços"),
    ("enchantments", "Encantamentos"),
    ("utilityartifacts", "Artefatos"),
    ("planeswalkers", "Planeswalkers"),
    ("battles", "Batalhas"),
    ("manaartifacts", "Rampa de artefato"),
    ("utilitylands", "Terrenos utilitários"),
    ("lands", "Terrenos"),
]
NOME_DA_CATEGORIA = dict(CATEGORIAS)

# A página de uma CARTA traz duas listas que a de comandante não tem: os
# comandantes mais jogados com ela e os recém-saídos. São resposta pra outra
# pergunta ("que deck eu monto com isso?"), e aqui a pergunta é "que carta
# entra agora?" — um comandante na lista de sugestões só teria como destino
# virar carta comum do deck, que não é o que quem clicou pediu.
LISTAS_DE_COMANDANTE = {"topcommanders", "newcommanders"}

# "Mais jogadas com ele" fala do comandante. Na página de uma carta a mesma
# etiqueta quer dizer outra coisa — "mais jogadas junto DESTA carta" — e o
# título tem que dizer qual das duas está na tela.
TITULO_NA_PAGINA_DE_CARTA = {"topcards": "Mais jogadas junto"}


def slug(nome: str) -> str:
    """O nome de uma carta no formato de URL do EDHREC.

    Apóstrofo e vírgula SOMEM; qualquer outra sequência de caractere que não
    é letra nem número vira um hífen só. "Atraxa, Praetors' Voice" ->
    "atraxa-praetors-voice".

    Acento é achatado antes disso: o EDHREC escreve "Jötun Grunt" como
    "jotun-grunt", e sem essa passagem o "ö" viraria hífen e o slug sairia
    "j-tun-grunt".

    Carta de duas faces entra pela FRENTE. O nome canônico que o deck guarda
    é o inteiro ("Ojer Taq, Deepest Foundation // Temple of Civilization"),
    mas a página do EDHREC é `ojer-taq-deepest-foundation` — juntar as duas
    faces num slug só dá uma página que não existe, que é como o comandante
    de face dupla virava erro na tela.
    """
    texto = unicodedata.normalize("NFKD", face_da_frente(nome).strip())
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    texto = texto.lower().replace("'", "").replace("’", "").replace(",", "")
    return re.sub(r"[^a-z0-9]+", "-", texto).strip("-")


def slug_do_deck(comandantes: list[str]) -> str:
    """O slug da página do deck: um comandante, ou os dois de uma parceria.

    Com dois comandantes o EDHREC junta os slugs em ordem alfabética. Se essa
    convenção mudar, a página some — e isso vira uma mensagem dizendo que não
    existe página pra essa dupla, que é o que a pessoa precisa saber. "Some"
    ali é 403, não 404: ver o comentário no `_pedir`.
    """
    slugs = [s for s in (slug(n) for n in comandantes) if s]
    if not slugs:
        raise EDHRECError("sem comandante não dá pra pedir sugestão: é ele "
                          "que define o que combina com o quê.")
    return "-".join(sorted(slugs))


def _sessao() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    return s


def _caminho_cache(caminho: str) -> str:
    limpo = re.sub(r"[^a-z0-9]+", "-", caminho.lower()).strip("-") or "vazio"
    return os.path.join(CACHE_DIR, f"{limpo[:120]}.json")


def _do_cache(caminho: str) -> dict | None:
    try:
        with open(_caminho_cache(caminho), encoding="utf-8") as f:
            guardado = json.load(f)
    except (OSError, ValueError):
        return None
    if time.time() - guardado.get("_quando", 0) > CACHE_TTL:
        return None
    return guardado


def _guardar_cache(caminho: str, dados: dict) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        temporario = _caminho_cache(caminho) + ".tmp"
        with open(temporario, "w", encoding="utf-8") as f:
            json.dump({**dados, "_quando": time.time()}, f, ensure_ascii=False)
        os.replace(temporario, _caminho_cache(caminho))
    except OSError as e:
        log.aviso("edhrec", "cache-nao-gravou",
                  motivo=f"{type(e).__name__}: {e}")


def _pedir(caminho: str) -> dict:
    """Busca uma página do EDHREC, com cache, freio e tentativas.

    `caminho` é o pedaço depois de `/pages/`, sem o `.json` — por exemplo
    `commanders/atraxa-praetors-voice`.
    """
    guardado = _do_cache(caminho)
    if guardado is not None:
        log.debug("edhrec", "cache", caminho=caminho)
        return {**guardado, "_cache": True}

    sessao = _sessao()
    url = f"{BASE}/{caminho}.json"
    ultimo_erro = "?"

    for tentativa in range(1, TENTATIVAS + 1):
        _freio.esperar()
        try:
            resposta = sessao.get(url, timeout=TIMEOUT)
        except requests.RequestException as e:
            ultimo_erro = f"{type(e).__name__}: {e}"
            log.aviso("edhrec", "falhou", tentativa=tentativa, caminho=caminho,
                      motivo=ultimo_erro)
            time.sleep(ritmo.backoff(tentativa, BACKOFF))
            continue

        if resposta.status_code == 404 or (
                resposta.status_code == 403
                and "AccessDenied" in (resposta.text or "")):
            # "A página não existe" é informação, não falha de rede: insistir
            # não vai criá-la.
            #
            # O 404 é o que se espera, mas NÃO é o que o EDHREC responde.
            # `json.edhrec.com` é um bucket S3 atrás do CloudFront, e bucket
            # sem permissão de listagem devolve **403 com um
            # `<Error><Code>AccessDenied</Code>` de S3** quando a chave não
            # está lá — não dá pra distinguir "não existe" de "não pode ver"
            # sem olhar o corpo. Tratar isso como status inesperado gastava
            # as três tentativas e terminava num "não consegui ler o EDHREC
            # (HTTP 403)", que manda procurar problema de rede que não existe.
            #
            # 403 que não traz esse XML é outra coisa — bloqueio de verdade,
            # WAF, IP barrado — e continua caindo no caminho de tentar de
            # novo logo abaixo.
            raise PaginaInexistente(
                f"o EDHREC não tem página pra isso ({caminho}). Se for uma "
                f"dupla de parceiros, pode ser que ninguém tenha registrado "
                f"deck com ela ainda.")

        if resposta.status_code == 429:
            espera = ritmo.espera_pedida(resposta) or ritmo.backoff(tentativa, BACKOFF)
            _freio.recuar(espera, motivo="HTTP 429")
            ultimo_erro = "HTTP 429"
            continue

        if resposta.status_code != 200:
            ultimo_erro = f"HTTP {resposta.status_code}"
            log.aviso("edhrec", "status-inesperado", caminho=caminho,
                      status=resposta.status_code)
            time.sleep(ritmo.backoff(tentativa, BACKOFF))
            continue

        try:
            dados = resposta.json()
        except ValueError:
            raise EDHRECError(
                "o EDHREC respondeu algo que não é JSON. Isso costuma "
                "significar que o endpoint mudou de endereço ou que veio uma "
                "página de bloqueio no lugar dos dados.")

        _guardar_cache(caminho, dados)
        return {**dados, "_cache": False}

    raise EDHRECError(f"não consegui ler o EDHREC ({ultimo_erro})")


def _cardlists(dados: dict) -> list[dict]:
    """As listas de carta de dentro da página.

    Elas moram fundo (`container.json_dict.cardlists`) porque o JSON é o
    estado da página do site, não uma resposta desenhada pra gente. Se esse
    caminho deixar de existir, é sinal de que o formato mudou — e aí é erro,
    não lista vazia.
    """
    container = dados.get("container")
    if not isinstance(container, dict):
        raise EDHRECError("o formato do EDHREC mudou: não achei o 'container' "
                          "na resposta.")
    listas = (container.get("json_dict") or {}).get("cardlists")
    if listas is None:
        raise EDHRECError("o formato do EDHREC mudou: não achei "
                          "'cardlists' na resposta.")
    return [c for c in listas if isinstance(c, dict)]


def _carta(bruta: dict) -> dict | None:
    """Uma carta sugerida, com os números que justificam a sugestão."""
    nome = (bruta.get("name") or "").strip()
    if not nome:
        return None
    # `synergy` vem como fração (0.42 = 42 pontos acima da média do formato).
    # Pode ser negativa: carta muito jogada em geral, mas menos com ESSE
    # comandante do que com os outros.
    #
    # A página de uma carta não manda `synergy`: manda `lift`, que é a mesma
    # comparação escrita como razão em vez de diferença — 1.09 quer dizer "9%
    # mais provável junto desta carta do que num deck qualquer". Menos 1 põe
    # os dois na mesma escala, e a tela mostra um número só.
    sinergia = bruta.get("synergy")
    if not isinstance(sinergia, (int, float)):
        lift = bruta.get("lift")
        sinergia = lift - 1 if isinstance(lift, (int, float)) else None
    inclusao = bruta.get("inclusion")
    potencial = bruta.get("potential_decks") or bruta.get("num_decks")
    return {
        "nome": nome,
        "sinergia": round(sinergia * 100) if isinstance(sinergia, (int, float))
                    else None,
        "decks": inclusao,
        "decks_possiveis": potencial,
        "porcento": (round(100 * inclusao / potencial)
                     if isinstance(inclusao, int) and isinstance(potencial, int)
                     and potencial else None),
    }


def temas_de(dados: dict) -> list[dict]:
    """Os temas que o EDHREC conhece pra esse comandante.

    Sai dos `panels.taglinks` da página. É o que enche o seletor de tema da
    tela — "Superfriends", "Aristocratas", "+1/+1 Counters". Nunca levanta:
    tema é enfeite útil, e uma página sem eles ainda serve pra sugerir carta.
    """
    painel = dados.get("panels")
    if not isinstance(painel, dict):
        return []
    achados = []
    for link in painel.get("taglinks") or []:
        if not isinstance(link, dict):
            continue
        nome = (link.get("value") or link.get("text") or "").strip()
        alvo = (link.get("slug") or link.get("href") or "").strip("/")
        if nome and alvo:
            achados.append({"nome": nome, "slug": alvo.split("/")[-1],
                            "decks": link.get("count")})
    return achados


def _listas_de(dados: dict, pular: set[str] = frozenset(),
               titulos: dict | None = None) -> list[dict]:
    """As listas de carta da página, traduzidas e na ordem de `CATEGORIAS`.

    `pular` tira etiquetas que a página traz e não respondem à pergunta desta
    tela — ver `LISTAS_DE_COMANDANTE`. `titulos` troca o nome de uma etiqueta
    que quer dizer coisas diferentes em cada página.
    """
    listas = []
    for lista in _cardlists(dados):
        etiqueta = (lista.get("tag") or "").strip()
        if etiqueta in pular:
            continue
        cartas = [c for c in (_carta(x) for x in lista.get("cardviews") or [])
                  if c]
        if not cartas:
            continue
        listas.append({
            "tag": etiqueta,
            # O título do EDHREC vem em inglês ("High Synergy Cards"); quando
            # a categoria é conhecida, usa o nome em português.
            "titulo": (titulos or {}).get(etiqueta)
                      or NOME_DA_CATEGORIA.get(etiqueta)
                      or (lista.get("header") or "Cartas").strip(),
            "cartas": cartas,
        })

    ordem = {tag: i for i, (tag, _) in enumerate(CATEGORIAS)}
    listas.sort(key=lambda l: ordem.get(l["tag"], len(ordem)))
    return listas


def sugerir(comandantes: list[str], tema: str | None = None) -> dict:
    """As sugestões do EDHREC pro comandante (e tema) pedidos.

    Devolve as listas por categoria, já com o nome em português, e os temas
    disponíveis. NÃO filtra o que já está no deck — quem faz isso é quem
    chama, que é quem conhece o deck.

    Levanta `EDHRECError` quando não deu pra ler. Nunca devolve lista vazia
    fingindo que não há sugestão.
    """
    if not LIGADO:
        raise EDHRECError("as sugestões estão desligadas no .env (EDHREC=0).")

    base = f"commanders/{slug_do_deck(comandantes)}"
    caminho = f"{base}/{slug(tema)}" if tema else base

    inicio = time.time()
    dados = _pedir(caminho)
    listas = _listas_de(dados)

    log.evento("edhrec", "sugeriu", caminho=caminho, listas=len(listas),
               cartas=sum(len(l["cartas"]) for l in listas),
               cache=dados.get("_cache"),
               ms=int((time.time() - inicio) * 1000))

    return {
        "alvo": {"tipo": "comandante", "nome": ", ".join(comandantes)},
        "comandantes": comandantes,
        "tema": tema,
        "temas": temas_de(dados),
        "listas": listas,
        "link": f"{SITE}/commanders/{slug_do_deck(comandantes)}",
        "cache": bool(dados.get("_cache")),
        "quando": time.time(),
    }


def sugerir_por_carta(nome: str) -> dict:
    """O que o EDHREC vê aparecendo junto de UMA carta.

    Mesma forma de resposta de `sugerir`, e de propósito: quem chama e quem
    desenha tratam as duas do mesmo jeito, e o que muda é só o `alvo`.

    A diferença de fonte importa pra ler o número. A página do comandante
    compara "com ele" contra "com os outros comandantes"; a página da carta
    compara "junto desta carta" contra "num deck qualquer do formato" — daí a
    sinergia sair de `lift` e não de `synergy` (ver `_carta`).

    Sem tema: a página de carta não tem `taglinks`. Por isso `temas` volta
    vazio, e a tela não desenha seletor nenhum.
    """
    if not LIGADO:
        raise EDHRECError("as sugestões estão desligadas no .env (EDHREC=0).")

    alvo = slug(nome)
    if not alvo:
        raise EDHRECError("preciso do nome de uma carta pra pedir sugestão.")

    caminho = f"cards/{alvo}"
    inicio = time.time()
    dados = _pedir(caminho)
    listas = _listas_de(dados, LISTAS_DE_COMANDANTE, TITULO_NA_PAGINA_DE_CARTA)

    log.evento("edhrec", "sugeriu-carta", caminho=caminho, listas=len(listas),
               cartas=sum(len(l["cartas"]) for l in listas),
               cache=dados.get("_cache"),
               ms=int((time.time() - inicio) * 1000))

    return {
        "alvo": {"tipo": "carta", "nome": nome},
        "comandantes": [],
        "tema": None,
        "temas": [],
        "listas": listas,
        "link": f"{SITE}/cards/{alvo}",
        "cache": bool(dados.get("_cache")),
        "quando": time.time(),
    }


# O deck médio mora em `average-decks/<comandante>[/<bracket>][/<orçamento>]`,
# os filtros nessa ordem e nenhum obrigatório. Os brackets são os slugs que o
# EDHREC usa na URL, na ordem oficial de 1 a 5; o nome em português sai do
# `poder.py`, que é quem fala de bracket no resto da tela.
BRACKETS = ("exhibition", "core", "upgraded", "optimized", "cedh")
# As contagens da página falam em "middle" também, mas ele não tem página
# própria: o meio é o que se vê sem filtro de orçamento nenhum.
ORCAMENTOS = {"budget": "econômico", "expensive": "caro"}


def _cartas_do_deck_medio(dados: dict) -> list[dict]:
    """As 99 do deck médio, com quantidade.

    Saem de `deck.cards`, que agrupa por tipo (`{"Creature": [["Birds of
    Paradise", 1], ...]}`) e traz os básicos já somados (`["Forest", 4]`). O
    agrupamento é jogado fora: a tela agrupa por tipo sozinha, e a categoria
    de uma carta aqui é o nome que a PESSOA dá — "combo principal" —, não o
    tipo.

    As listas de `cardlists` da mesma página descrevem o mesmo deck, mas o
    básico vem ali como etiqueta ("4 Forest") e não como quantidade.
    """
    deck = dados.get("deck")
    grupos = deck.get("cards") if isinstance(deck, dict) else None
    if not isinstance(grupos, dict):
        raise EDHRECError("o formato do EDHREC mudou: não achei 'deck.cards' "
                          "na página do deck médio.")
    cartas = []
    for linhas in grupos.values():
        for linha in linhas if isinstance(linhas, list) else []:
            if (not isinstance(linha, list) or len(linha) != 2
                    or not isinstance(linha[1], int)):
                continue
            nome = str(linha[0] or "").strip()
            if nome and linha[1] > 0:
                cartas.append({"nome": nome, "quantidade": linha[1]})
    if not cartas:
        raise EDHRECError("a página do deck médio veio sem carta nenhuma — o "
                          "formato do EDHREC deve ter mudado.")
    return cartas


def deck_medio(comandantes: list[str], bracket: str | None = None,
               orcamento: str | None = None) -> dict:
    """O deck médio do EDHREC pro comandante, no formato de `importar.py`.

    É a lista que junta as cartas mais jogadas nos decks registrados com esse
    comandante — o ponto de partida que muita gente usa pra começar um deck.
    `bracket` e `orcamento` estreitam os decks que entram na média.

    O comandante que volta é o que foi PEDIDO, não o que a página escreve: o
    nome canônico da base local é o de duas faces inteiro, e o do EDHREC é o
    da frente. Trocar um pelo outro faria o deck mudar de comandante ao ser
    importado.

    Levanta `ValueError` pra filtro desconhecido e `EDHRECError` pra o resto,
    `PaginaInexistente` incluída.
    """
    if not LIGADO:
        raise EDHRECError("as sugestões estão desligadas no .env (EDHREC=0).")
    if bracket and bracket not in BRACKETS:
        raise ValueError(f"Bracket desconhecido: {bracket}.")
    if orcamento and orcamento not in ORCAMENTOS:
        raise ValueError(f"Orçamento desconhecido: {orcamento}.")

    caminho = "/".join([f"average-decks/{slug_do_deck(comandantes)}"]
                       + [f for f in (bracket, orcamento) if f])
    inicio = time.time()
    try:
        dados = _pedir(caminho)
    except PaginaInexistente:
        if not (bracket or orcamento):
            raise
        # Com filtro, "não existe" quase sempre quer dizer "poucos decks
        # assim": o EDHREC não publica média de um punhado de listas. O
        # recado genérico do `_pedir` mandaria procurar erro de parceria.
        raise PaginaInexistente(
            "o EDHREC não tem deck médio desse comandante com esse bracket e "
            "orçamento — poucos decks registrados assim. Tente um filtro "
            "mais largo.")
    cartas = _cartas_do_deck_medio(dados)

    filtros = []
    if bracket:
        filtros.append(NOME_DO_BRACKET[BRACKETS.index(bracket) + 1][0])
    if orcamento:
        filtros.append(ORCAMENTOS[orcamento])
    nome = f"Deck médio de {' e '.join(comandantes)}"
    if filtros:
        nome += f" ({', '.join(filtros)})"

    card = ((dados.get("container") or {}).get("json_dict") or {}).get("card")
    num_decks = card.get("num_decks") if isinstance(card, dict) else None

    log.evento("edhrec", "deck-medio", caminho=caminho, cartas=len(cartas),
               decks=num_decks, cache=dados.get("_cache"),
               ms=int((time.time() - inicio) * 1000))

    return {
        "nome": nome,
        "comandantes": list(comandantes),
        "cartas": cartas,
        "maybeboard": [],
        "fonte": "EDHREC",
        "link": f"{SITE}/{caminho}",
        "decks": num_decks if isinstance(num_decks, int) else None,
        "cache": bool(dados.get("_cache")),
    }
