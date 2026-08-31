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
import re
import time
import unicodedata

import requests

from . import cache_precos, identidade, log, ritmo
from .cotacao import Oferta

BASE = "https://api.scryfall.com"
# A Scryfall pede um User-Agent identificável — é regra deles, não gentileza.
# O e-mail de contato sai do .env, não do código — ver `identidade.py`.
USER_AGENT = os.environ.get(
    "SCRYFALL_USER_AGENT", identidade.user_agent("cotador de deck"))
# Eles pedem 50-100 ms entre requisições, mas na prática cortam bem antes
# disso, e o corte NÃO parece ser só por taxa: medindo aqui, o 429 chega
# depois de ~20 requisições mesmo a 0,25 s, e com o IP "descansado" demora
# mais pra aparecer que com ele quente. Parece orçamento móvel por IP, não
# uma taxa instantânea. Quando vem, vem com `Retry-After: 60`.
#
# Então 0,25 não elimina o 429 — só o deixa mais raro. Quem garante que a
# cotação não perde carta é o `Freio` (pausa global obedecendo o
# `Retry-After`) somado à repescagem do `cotacao.cotar`. O custo de subir de
# 0,12 pra 0,25 é ~19 s numa cotação de 75 cartas, contra os 4 minutos que a
# LigaMagic leva ao lado — ou seja, não muda o tempo total.
DELAY_SEGUNDOS = float(os.environ.get("SCRYFALL_DELAY_SEGUNDOS", "0.25"))
TIMEOUT = float(os.environ.get("SCRYFALL_TIMEOUT", "15"))
# 5, e não 3, porque a falha típica aqui não é "caiu": é a Scryfall cortando
# uma rajada e liberando alguns segundos depois. Com 3 tentativas de backoff
# curto, uma cotação de 75 cartas perdia blocos inteiros para uma pausa que
# duraria menos que o resto do trabalho.
TENTATIVAS = int(os.environ.get("SCRYFALL_TENTATIVAS", "5"))
BACKOFF = float(os.environ.get("SCRYFALL_BACKOFF", "1"))
# Quantas cartas em paralelo. Baixo de propósito, pelo mesmo motivo da
# LigaMagic: o `Freio` serializa o INÍCIO das requisições, então subir isto
# não acelera quase nada e só engorda a rajada que provoca o 429.
WORKERS = int(os.environ.get("SCRYFALL_WORKERS", "2"))
# 0 = não converte, mostra em dólar mesmo.
USD_BRL = float(os.environ.get("USD_BRL", "0"))
MOEDA = "BRL" if USD_BRL > 0 else "USD"
# Quantas páginas de edições diferentes buscar por carta. Carta muito
# reimpressa (Sol Ring, Lightning Bolt) passa de uma página; 3 cobre todas.
MAX_PAGINAS = int(os.environ.get("SCRYFALL_MAX_PAGINAS", "3"))


class ScryfallError(Exception):
    """Falha de rede ou resposta inesperada da Scryfall."""


# Compartilhado por todas as threads: além do intervalo mínimo, guarda a
# pausa global aplicada quando a Scryfall responde 429. Ver `ritmo.py`.
_freio = ritmo.Freio("scryfall", DELAY_SEGUNDOS)


def _sessao() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    return s


def _get(sessao, url, params=None, carta: str = ""):
    """GET com ritmo, retry e log. Ver `_requisicao`."""
    return _requisicao(sessao, "GET", url, params=params, carta=carta)


def _post(sessao, url, corpo: dict, carta: str = ""):
    """POST com o mesmo ritmo e retry do GET — usado pelo `/cards/collection`."""
    return _requisicao(sessao, "POST", url, corpo=corpo, carta=carta)


def _requisicao(sessao, metodo, url, params=None, corpo=None, carta: str = ""):
    """Requisição com ritmo, retry e log. 404 devolve None — na Scryfall 404
    quer dizer "não existe essa carta", que é resposta legítima, não erro.

    Todo caminho de falha passa por aqui logando o MOTIVO. Antes a exceção
    subia até o `cotar`, virava a string "falha na busca: ..." e a tela
    mostrava só um travessão: não dava pra distinguir carta inexistente de
    429 de timeout, que é exatamente o que se precisa saber pra consertar.
    """
    erro = None
    for tentativa in range(1, TENTATIVAS + 1):
        esperou = _freio.esperar()
        if esperou > 1:
            log.debug("scryfall", "esperou", segundos=round(esperou, 1),
                      carta=carta or None)
        try:
            r = sessao.request(metodo, url, params=params, json=corpo,
                               timeout=TIMEOUT)
            if r.status_code == 404:
                return None
            if r.status_code == 429 or r.status_code >= 500:
                erro = f"HTTP {r.status_code}"
                pausa = (ritmo.espera_pedida(r)
                         or ritmo.backoff(tentativa, BACKOFF))
                if r.status_code == 429:
                    # Segura TODAS as threads, não só esta. É o ponto do
                    # conserto: quatro workers descobrindo o 429 em paralelo
                    # e recuando cada um por conta queimavam as tentativas
                    # todas em poucos segundos.
                    _freio.recuar(pausa, motivo=erro, carta=carta)
                else:
                    time.sleep(pausa)
                log.aviso("scryfall", "tentando-de-novo", carta=carta or None,
                          motivo=erro, tentativa=f"{tentativa}/{TENTATIVAS}",
                          pausa=round(pausa, 1))
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            erro = f"{type(e).__name__}: {e}"
            if tentativa < TENTATIVAS:
                pausa = ritmo.backoff(tentativa, BACKOFF)
                log.aviso("scryfall", "tentando-de-novo", carta=carta or None,
                          motivo=erro, tentativa=f"{tentativa}/{TENTATIVAS}",
                          pausa=round(pausa, 1))
                time.sleep(pausa)
    log.erro("scryfall", "desisti", carta=carta or None, url=url,
             motivo=erro, tentativas=TENTATIVAS)
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


# --------------------------------------------------------------------------
# Busca em lote
# --------------------------------------------------------------------------
# O `<query>` do MPC Fill é MUITO mais próximo do nome real do que este módulo
# supunha: medindo com um deck de verdade, 73 de 75 `<query>` batem direto no
# `/cards/collection`, que ignora caixa, vírgula, hífen, apóstrofo e o "!" de
# "Go Nuts!". Ele aceita 75 identificadores por requisição.
#
# Isso muda a conta toda. O caminho carta-a-carta gasta 2+ requisições POR
# CARTA (resolver o nome + listar as edições) — ~150 num Commander, que é
# justamente o que fazia a Scryfall bater no 429 e o deck voltar cheio de
# travessão. Em lote, as mesmas 75 cartas saem em ~20 requisições.
#
# O que NÃO casa direto são os `<query>` a que o MPC Fill tirou um artigo
# ("enter unknown" para "Enter the Unknown"). Esses caem no caminho antigo,
# carta a carta, onde a busca difusa do `/cards/named` os resolve. Ou seja: o
# lote é um atalho, não uma troca — nada deixa de ser cotado se ele falhar.
QUANTOS_POR_COLECAO = 75          # teto da API
MAX_CHARS_BUSCA = int(os.environ.get("SCRYFALL_MAX_CHARS_BUSCA", "900"))
# Teto de páginas por lote de edições. Cada página traz 175 impressões, então
# 40 cobre ~7000 — folga larga pra qualquer lote, e ainda impede laço infinito
# se a paginação deles mudar.
MAX_PAGINAS_LOTE = int(os.environ.get("SCRYFALL_MAX_PAGINAS_LOTE", "40"))


def _chave_nome(nome: str) -> str:
    """Chave de comparação entre o `<query>` do MPC e o nome canônico.

    O apóstrofo SOME (Nature's Lore -> "natures lore") e o resto da pontuação
    vira espaço (Shang-Chi, Master... -> "shang chi master..."), que é
    exatamente o que o MPC Fill faz ao montar o `<query>`.
    """
    limpo = unicodedata.normalize("NFKD", str(nome or "").lower())
    limpo = "".join(c for c in limpo if not unicodedata.combining(c))
    limpo = limpo.replace("'", "").replace("\u2019", "")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", limpo).split())


def _chaves_do_card(card: dict) -> list[str]:
    """As chaves pelas quais um card pode ser procurado.

    Carta dupla-face tem nome canônico "Bruce Banner // The Incredible Hulk",
    mas o `<query>` traz só a frente ("bruce banner"). Sem indexar a frente
    separada, toda dupla-face escaparia do lote sem motivo.
    """
    nome = card.get("name") or ""
    chaves = [_chave_nome(nome)]
    if "//" in nome:
        chaves.append(_chave_nome(nome.split("//")[0]))
    return [c for c in chaves if c]


def _resolver_nomes(sessao, nomes: list[str]) -> dict[str, str]:
    """`{nome pedido: nome canônico}` via `/cards/collection`.

    Quem não aparecer aqui simplesmente não entra no lote — não é erro, é o
    caso que o caminho carta-a-carta resolve com busca difusa.
    """
    canonico_de: dict[str, str] = {}
    for i in range(0, len(nomes), QUANTOS_POR_COLECAO):
        lote = nomes[i:i + QUANTOS_POR_COLECAO]
        resposta = _post(sessao, f"{BASE}/cards/collection",
                         {"identifiers": [{"name": n} for n in lote]},
                         carta=f"lote de {len(lote)}")
        if not resposta:
            continue
        indice: dict[str, str] = {}
        for card in resposta.get("data", []):
            for chave in _chaves_do_card(card):
                indice.setdefault(chave, card["name"])
        for nome in lote:
            achado = indice.get(_chave_nome(nome))
            if achado:
                canonico_de[nome] = achado
    return canonico_de


def _edicoes_em_lote(sessao, canonicos: list[str]) -> dict[str, list[Oferta]]:
    """Todas as edições de vários nomes de uma vez, com `!"A" or !"B" or ...`.

    Uma página traz 175 impressões independentemente de quantas cartas o
    filtro tenha, então juntar nomes num filtro só corta requisição de
    verdade: as ~2500 impressões de um Commander saem em ~15 páginas em vez
    de 75 buscas separadas.
    """
    por_nome: dict[str, list[Oferta]] = {n: [] for n in canonicos}
    # Aspas no nome quebrariam o filtro; nenhuma carta tem, mas custa nada.
    limpos = [n for n in canonicos if '"' not in n]

    grupo, tamanho = [], 0
    grupos = []
    for nome in limpos:
        pedaco = len(nome) + 8              # !"..." mais o " or "
        if grupo and tamanho + pedaco > MAX_CHARS_BUSCA:
            grupos.append(grupo)
            grupo, tamanho = [], 0
        grupo.append(nome)
        tamanho += pedaco
    if grupo:
        grupos.append(grupo)

    # `_chave_nome` de novo aqui porque a Scryfall devolve o nome canônico
    # completo ("A // B") mesmo quando o filtro pediu só a frente.
    destino = {}
    for nome in limpos:
        for chave in ([_chave_nome(nome)] +
                      ([_chave_nome(nome.split("//")[0])] if "//" in nome else [])):
            destino[chave] = nome

    for numero, nomes_do_grupo in enumerate(grupos, 1):
        url = f"{BASE}/cards/search"
        params = {"q": " or ".join(f'!"{n}"' for n in nomes_do_grupo),
                  "unique": "prints"}
        for _ in range(MAX_PAGINAS_LOTE):
            pagina = _get(sessao, url, params,
                          carta=f"lote {numero}/{len(grupos)}")
            if not pagina:
                break
            for card in pagina.get("data", []):
                alvo = next((destino[c] for c in _chaves_do_card(card)
                             if c in destino), None)
                if alvo is None:
                    continue
                oferta = _oferta(card)
                if oferta:
                    por_nome[alvo].append(oferta)
            if not pagina.get("has_more"):
                break
            url, params = pagina["next_page"], None
    return por_nome


def preparar(nomes, usar_cache: bool = True) -> dict:
    """Cota a lista INTEIRA em poucas requisições e deixa tudo no cache.

    Depois disto, `buscar_carta` de cada carta acha o resultado pronto e não
    toca na rede. É esse o ponto: o cache já existia por carta, então o lote
    não precisa de caminho novo pra entregar o resultado — ele só chega
    primeiro e enche a prateleira.

    Nunca levanta exceção. Se o lote falhar por qualquer motivo, a cotação
    segue carta a carta como antes: mais lenta, mas inteira. Um atalho que
    derruba o trabalho não é atalho.
    """
    inicio = time.monotonic()
    pendentes = []
    for nome in nomes:
        nome = " ".join(str(nome or "").split())
        if not nome or nome in pendentes:
            continue
        if usar_cache and cache_precos.ler("scryfall", nome) is not None:
            continue
        pendentes.append(nome)
    if not pendentes:
        log.debug("scryfall", "lote-desnecessario", cartas=len(nomes))
        return {"pedidas": len(nomes), "resolvidas": 0, "cacheadas": 0}

    try:
        sessao = _sessao()
        canonico_de = _resolver_nomes(sessao, pendentes)
        edicoes = _edicoes_em_lote(sessao, sorted(set(canonico_de.values())))

        gravadas = 0
        for nome, canonico in canonico_de.items():
            ofertas = edicoes.get(canonico) or []
            if not ofertas:
                # Achou o nome mas nenhuma edição com preço. Deixa pro
                # caminho carta-a-carta confirmar em vez de gravar um vazio
                # que ficaria 12h no cache escondendo um lote mal formado.
                continue
            cache_precos.gravar("scryfall", nome, ofertas)
            gravadas += 1

        log.evento("scryfall", "lote", pedidas=len(nomes),
                   buscadas=len(pendentes), resolvidas=len(canonico_de),
                   cacheadas=gravadas,
                   sobraram=len(pendentes) - gravadas,
                   segundos=int(time.monotonic() - inicio))
        return {"pedidas": len(nomes), "resolvidas": len(canonico_de),
                "cacheadas": gravadas}
    except Exception as e:
        log.aviso("scryfall", "lote-falhou", motivo=f"{type(e).__name__}: {e}",
                  nota="segue carta a carta")
        return {"pedidas": len(nomes), "resolvidas": 0, "cacheadas": 0}


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
            log.debug("scryfall", "cache", carta=nome, ofertas=len(cacheado))
            return cacheado
    inicio = time.monotonic()
    sessao = _sessao()

    # Primeiro resolve o nome: o XML do MPC Fill traz o que o usuário digitou
    # lá ("sol ring", "lighting bolt"), que nem sempre é o nome exato. A busca
    # difusa da Scryfall corrige isso e devolve o nome canônico.
    card = _get(sessao, f"{BASE}/cards/named", {"fuzzy": nome}, carta=nome)
    if not card:
        # Guarda o "não existe" também. Um nome que a Scryfall não conhece
        # (erro de digitação no MPC Fill, token, carta caseira) continuaria
        # batendo lá a cada cotação do mesmo deck se isso saísse sem cachear.
        cache_precos.gravar("scryfall", nome, [])
        log.aviso("scryfall", "nome-desconhecido", carta=nome)
        return []
    canonico = card.get("name") or nome

    # Com o nome certo em mãos, pega TODAS as edições pra achar a mais barata
    # — mesma lógica da Liga, que também lista uma linha por edição.
    ofertas, url = [], f"{BASE}/cards/search"
    params = {"q": f'!"{canonico}"', "unique": "prints"}
    for _ in range(MAX_PAGINAS):
        pagina = _get(sessao, url, params, carta=nome)
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
    log.evento("scryfall", "ok" if ofertas else "sem-preco", carta=nome,
               canonico=canonico if canonico.lower() != nome.lower() else None,
               ofertas=len(ofertas),
               ms=int((time.monotonic() - inicio) * 1000))
    return ofertas
