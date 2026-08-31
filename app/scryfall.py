"""
Preços da Scryfall — a segunda fonte da cotação.

Ao contrário da LigaMagic, aqui é API pública, documentada e feita pra ser
consumida por robô: sem ofuscação, sem contorno nenhum. A Scryfall só pede
duas coisas, e as duas estão atendidas abaixo: um `User-Agent` que identifique
quem chama, e ~100 ms entre requisições.

O CONTRAPONTO, que precisa ficar claro na tela: os preços da Scryfall são do
mercado americano/europeu (TCGplayer e Cardmarket), em **dólar**, e não são o
preço de comprar no Brasil. Não dá pra somar com o total da LigaMagic; servem
pra comparar ordem de grandeza e pra pegar carta que a Liga não achou.

`USD_BRL` converte pra real quando você quiser ver os dois lados na mesma
moeda. É uma taxa fixa que VOCÊ coloca no .env — não busca câmbio em lugar
nenhum, porque câmbio automático seria mais uma dependência frágil pra manter
por uma conversão que é só ilustrativa (não inclui imposto, frete nem IOF).
"""
import os
import threading
import time

import requests

from . import cache_precos, identidade
from .cotacao import Oferta

BASE = "https://api.scryfall.com"
# A Scryfall pede um User-Agent identificável — é regra deles, não gentileza.
# O e-mail de contato sai do .env, não do código — ver `identidade.py`.
USER_AGENT = os.environ.get(
    "SCRYFALL_USER_AGENT", identidade.user_agent("cotador de deck"))
# Eles pedem 50-100 ms entre requisições. 0,12 s dá folga.
DELAY_SEGUNDOS = float(os.environ.get("SCRYFALL_DELAY_SEGUNDOS", "0.12"))
TIMEOUT = float(os.environ.get("SCRYFALL_TIMEOUT", "15"))
TENTATIVAS = int(os.environ.get("SCRYFALL_TENTATIVAS", "3"))
# 0 = não converte, mostra em dólar mesmo.
USD_BRL = float(os.environ.get("USD_BRL", "0"))
MOEDA = "BRL" if USD_BRL > 0 else "USD"
# Quantas páginas de edições diferentes buscar por carta. Carta muito
# reimpressa (Sol Ring, Lightning Bolt) passa de uma página; 3 cobre todas.
MAX_PAGINAS = int(os.environ.get("SCRYFALL_MAX_PAGINAS", "3"))


class ScryfallError(Exception):
    """Falha de rede ou resposta inesperada da Scryfall."""


_trava_ritmo = threading.Lock()
_ultimo_acesso = 0.0


def _respeitar_ritmo():
    global _ultimo_acesso
    with _trava_ritmo:
        espera = DELAY_SEGUNDOS - (time.monotonic() - _ultimo_acesso)
        if espera > 0:
            time.sleep(espera)
        _ultimo_acesso = time.monotonic()


def _sessao() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    return s


def _get(sessao, url, params=None):
    """GET com ritmo e retry. 404 devolve None — na Scryfall 404 quer dizer
    "não existe essa carta", que é resposta legítima, não erro."""
    erro = None
    for tentativa in range(TENTATIVAS):
        _respeitar_ritmo()
        try:
            r = sessao.get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 404:
                return None
            if r.status_code == 429 or r.status_code >= 500:
                erro = f"HTTP {r.status_code}"
                time.sleep(1.0 * (2 ** tentativa))
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            erro = str(e)
            if tentativa < TENTATIVAS - 1:
                time.sleep(1.0 * (2 ** tentativa))
    raise ScryfallError(f"não consegui falar com a Scryfall ({url}): {erro}")


def _preco(card: dict) -> float | None:
    bruto = (card.get("prices") or {}).get("usd")
    if bruto in (None, ""):
        # Carta só existente em foil (Secret Lair, promos) não tem `usd`.
        bruto = (card.get("prices") or {}).get("usd_foil")
    if bruto in (None, ""):
        return None
    try:
        usd = float(bruto)
    except ValueError:
        return None
    return round(usd * USD_BRL, 2) if USD_BRL > 0 else usd


def _oferta(card: dict) -> Oferta | None:
    preco = _preco(card)
    if preco is None:
        return None
    compra = card.get("purchase_uris") or {}
    ehfoil = not (card.get("prices") or {}).get("usd")
    return Oferta(
        loja="TCGplayer",
        preco=preco,
        # A Scryfall publica preço de mercado de carta NM; não existe preço
        # por condição na API, então marcar outra coisa seria invenção.
        condicao="NM",
        idioma="EN",
        edicao=card.get("set_name", ""),
        # A Scryfall não sabe estoque de ninguém. 0 = "não informado", que é
        # como o cotacao.py trata (não vira filtro).
        quantidade=0,
        link=compra.get("tcgplayer") or card.get("scryfall_uri", ""),
        extras="Foil" if ehfoil else "",
    )


def buscar_carta(nome: str, usar_cache: bool = True) -> list[Oferta]:
    """Uma "oferta" por edição da carta, pra bater de frente com a lista de
    ofertas da LigaMagic e o `escolher_oferta` funcionar igual nos dois lados.

    Lista vazia = a Scryfall não conhece essa carta (ou nenhuma edição dela
    tem preço publicado).
    """
    nome = " ".join(nome.split())
    if not nome:
        return []
    if usar_cache:
        cacheado = cache_precos.ler("scryfall", nome)
        if cacheado is not None:
            return cacheado
    sessao = _sessao()

    # Primeiro resolve o nome: o XML do MPC Fill traz o que o usuário digitou
    # lá ("sol ring", "lighting bolt"), que nem sempre é o nome exato. A busca
    # difusa da Scryfall corrige isso e devolve o nome canônico.
    card = _get(sessao, f"{BASE}/cards/named", {"fuzzy": nome})
    if not card:
        # Guarda o "não existe" também. Um nome que a Scryfall não conhece
        # (erro de digitação no MPC Fill, token, carta caseira) continuaria
        # batendo lá a cada cotação do mesmo deck se isso saísse sem cachear.
        cache_precos.gravar("scryfall", nome, [])
        return []
    canonico = card.get("name") or nome

    # Com o nome certo em mãos, pega TODAS as edições pra achar a mais barata
    # — mesma lógica da Liga, que também lista uma linha por edição.
    ofertas, url = [], f"{BASE}/cards/search"
    params = {"q": f'!"{canonico}"', "unique": "prints"}
    for _ in range(MAX_PAGINAS):
        pagina = _get(sessao, url, params)
        if not pagina:
            break
        for c in pagina.get("data", []):
            oferta = _oferta(c)
            if oferta:
                ofertas.append(oferta)
        if not pagina.get("has_more"):
            break
        url, params = pagina["next_page"], None

    if not ofertas:
        # A busca por nome exato pode falhar em carta de dupla face, cujo
        # nome canônico tem "//". Nesse caso o resultado do `cards/named`
        # já basta: é uma edição só, mas é melhor que nada.
        sozinha = _oferta(card)
        if sozinha:
            ofertas.append(sozinha)

    cache_precos.gravar("scryfall", nome, ofertas)
    return ofertas
