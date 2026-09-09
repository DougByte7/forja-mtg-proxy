"""
A carta inteira, do jeito que a tela de detalhe mostra.

A base local do `cartas.py` guarda o que a BUSCA precisa: nome, custo, tipo,
oracle, cor, preço e arte. A modal do deckbuilder pede o resto — raridade,
edição, artista, texto de ambientação, poder/resistência, legalidade em cada
formato e as **notas de regras** (o "Notes and Rules Information" da página da
Scryfall, que são os rulings). Nada disso está no bulk data que a base local
carrega: rulings vêm de outro endpoint, e guardar todos eles em disco seria
multiplicar por vários o tamanho de uma base que já passa de 100 MB.

Então isto vai à API da Scryfall na hora, carta a carta, e guarda a resposta
em disco. É o mesmo desenho do `cache_precos`: por carta, não por deck, pra
quem abre a mesma carta em dois decks pagar uma requisição só.

O TTL é de um dia porque a resposta carrega preço junto. Oracle e ruling mudam
poucas vezes por ano; preço muda todo dia, e é ele quem manda no prazo.
"""
import json
import os
import re
import time

from . import log, scryfall

DIR = os.environ.get("CARTA_DETALHE_CACHE_DIR", "/tmp/forja-carta-detalhe")
TTL = float(os.environ.get("CARTA_DETALHE_TTL", str(24 * 3600)))


def _caminho(nome: str) -> str:
    limpo = re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-") or "sem-nome"
    return os.path.join(DIR, limpo[:120] + ".json")


def _do_cache(nome: str) -> dict | None:
    caminho = _caminho(nome)
    try:
        if time.time() - os.path.getmtime(caminho) > TTL:
            return None
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        # Arquivo corrompido ou de um formato antigo: trata como ausente.
        # Cache nunca pode derrubar a tela.
        return None


def _pro_cache(nome: str, dados: dict) -> None:
    caminho = _caminho(nome)
    try:
        os.makedirs(os.path.dirname(caminho), exist_ok=True)
        with open(caminho, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False)
    except OSError as e:
        log.aviso("detalhe", "nao-gravei", carta=nome, motivo=str(e))


# ---------------------------------------------------------------------------
# Formato
#
# A resposta é redesenhada aqui em vez de repassar o JSON da Scryfall cru: a
# tela consome os mesmos nomes de campo que a base local usa (`nome`, `tipo`,
# `texto`, `mana_cost`), e assim a modal desenha carta que veio do banco e
# carta que veio da API com o mesmo código.
# ---------------------------------------------------------------------------

def _arte(fonte: dict) -> str:
    urls = fonte.get("image_uris") or {}
    return urls.get("normal") or urls.get("large") or urls.get("small") or ""


def _face(face: dict, arte_de_reserva: str = "") -> dict:
    """Uma face desenhável. `arte_de_reserva` é a imagem da carta inteira,
    usada por layout que tem duas faces de TEXTO numa imagem só — split,
    adventure, flip: a arte mora no topo da carta, não dentro da face."""
    return {
        "nome": face.get("name") or "",
        "mana_cost": face.get("mana_cost") or "",
        "tipo": face.get("type_line") or "",
        "texto": face.get("oracle_text") or "",
        "sabor": face.get("flavor_text") or "",
        "poder": face.get("power"),
        "resistencia": face.get("toughness"),
        "lealdade": face.get("loyalty"),
        "defesa": face.get("defense"),
        "artista": face.get("artist") or "",
        "imagem": _arte(face) or arte_de_reserva,
    }


def _faces(card: dict) -> list[dict]:
    partes = card.get("card_faces") or []
    if not partes:
        return [_face(card)]
    return [_face(f, _arte(card)) for f in partes]


def _regra(ruling: dict) -> dict:
    return {
        "data": ruling.get("published_at") or "",
        "fonte": ruling.get("source") or "",
        "texto": ruling.get("comment") or "",
    }


def _formato(card: dict, rulings: list) -> dict:
    return {
        "nome": card.get("name") or "",
        "layout": card.get("layout") or "",
        "cmc": card.get("cmc"),
        "identidade": "".join(sorted(card.get("color_identity") or [])),
        "faces": _faces(card),
        "raridade": card.get("rarity") or "",
        "edicao": card.get("set_name") or "",
        "edicao_sigla": (card.get("set") or "").upper(),
        "numero": card.get("collector_number") or "",
        "lancamento": card.get("released_at") or "",
        "palavras": card.get("keywords") or [],
        "reservada": bool(card.get("reserved")),
        # Posição da carta no EDHREC. Vale como "quão jogada em Commander",
        # que é o formato do deckbuilder — quanto menor, mais jogada.
        "edhrec": card.get("edhrec_rank"),
        "legalidades": card.get("legalities") or {},
        "precos": card.get("prices") or {},
        "scryfall": card.get("scryfall_uri") or "",
        "gatherer": (card.get("related_uris") or {}).get("gatherer") or "",
        "regras": [_regra(r) for r in rulings],
    }


# ---------------------------------------------------------------------------
# Busca
# ---------------------------------------------------------------------------

def _da_api(nome: str) -> dict | None:
    """Duas requisições: a carta e os rulings dela. `None` = não existe.

    A sessão é uma só pras duas — a segunda chamada é sempre no mesmo host, e
    reaproveitar a conexão poupa um handshake TLS por carta aberta.
    """
    sessao = scryfall.nova_sessao()
    card = scryfall.json_da_api(f"{scryfall.BASE}/cards/named", {"exact": nome},
                               carta=nome, sessao=sessao)
    if card is None:
        # `exact` é literal: acento, vírgula e o "//" da carta de duas faces
        # já derrubam o casamento. O `fuzzy` resolve esses, e é o mesmo
        # caminho de reserva que a cotação usa.
        card = scryfall.json_da_api(f"{scryfall.BASE}/cards/named",
                                    {"fuzzy": nome}, carta=nome, sessao=sessao)
    if card is None:
        return None

    # Carta sem ruling nenhum é comum (a maioria das cartas não tem), e o
    # endpoint responde uma lista vazia — não é erro, e a modal desenha a
    # seção só quando vem alguma coisa.
    rulings = []
    uri = card.get("rulings_uri")
    if uri:
        resposta = scryfall.json_da_api(uri, carta=nome, sessao=sessao)
        rulings = (resposta or {}).get("data") or []
    return _formato(card, rulings)


def detalhe(nome: str) -> dict | None:
    """A carta completa pelo nome, do cache ou da Scryfall. `None` = não achei.

    Falha de rede não vira erro pra quem chamou: a modal já está aberta com o
    que a base local sabe quando isto é chamado, e um alerta vermelho sobre a
    Scryfall estar fora do ar não ajudaria quem só queria reler o oracle. O
    log guarda o motivo.
    """
    nome = (nome or "").strip()
    if not nome:
        return None
    guardado = _do_cache(nome)
    if guardado is not None:
        return guardado
    try:
        dados = _da_api(nome)
    except scryfall.ScryfallError as e:
        log.aviso("detalhe", "sem-resposta", carta=nome, motivo=str(e))
        return None
    if dados is not None:
        _pro_cache(nome, dados)
    return dados
