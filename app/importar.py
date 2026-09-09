"""
Trazer um deck pronto de fora: um link do Archidekt ou do Moxfield, ou a
lista em texto colada.

POR QUE ISTO EXISTE. Quem chega no deckbuilder quase nunca chega do zero —
chega com um deck que já mantém em outro lugar e quer proxiar. Sem importar,
o caminho é digitar 100 nomes numa caixa de busca, e ninguém faz isso duas
vezes.

O QUE SAI DAQUI. Sempre a mesma coisa, venha de onde vier: `{"nome",
"comandantes": [nome], "cartas": [{"nome", "quantidade", "categoria"}],
"maybeboard": [...], "fonte", "link"}`. Nomes, não cartas — quem resolve
nome em carta é a base local (`cartas.por_nomes`), do mesmo jeito que um
deck salvo é resolvido ao abrir.

O QUE ESTAVA FORA DO DECK AGORA VEM JUNTO. O deckbuilder ganhou maybeboard,
então descartar a parte da lista que o site marcou como "fora" passou a ser
perda de informação: quem mantém 20 cartas em dúvida lá teria que copiá-las
à mão. A regra é a do rótulo — o que o site chama de *sideboard* vira a
categoria `Sideboard` (fora das 100, dentro da cotação) e todo o resto do
que está fora (*maybeboard*, *considering*, *acquire*, *wishlist*) vira
maybeboard. Token continua sendo descartado: não é carta de deck.

CATEGORIA NÃO VEM DE FORA. O Archidekt tem categorias por carta, mas as
dele são quase sempre o TIPO ("Creature", "Land") — e o deckbuilder já
agrupa por tipo sozinho. Trazê-las criaria uma categoria à mão em cima de
cada grupo automático, duplicando a lista inteira em inglês. Só o rótulo de
tabuleiro (sideboard/maybeboard) atravessa.

AS DUAS FONTES NÃO SÃO IGUAIS, e isso não é escolha nossa:

  * **Archidekt** responde a `GET /api/decks/{id}/` sem chave, sem
    cadastro e sem bloqueio. É a API que o front-end deles usa, e ela traz o
    que precisamos: nome da carta, quantidade e a que categorias ela
    pertence — inclusive quais categorias contam pro deck, que é como o
    maybeboard fica de fora.

  * **Moxfield** está atrás de Cloudflare, e aí mora a coisa mais
    contraintuitiva deste módulo: **passar por navegador é o que leva 403**.
    `User-Agent: Mozilla/5.0` vindo de um servidor é exatamente o padrão que
    o bot-fight deles derruba, e foi o primeiro resultado que esta
    investigação obteve. Com o nosso User-Agent honesto — o do
    `identidade.py`, que diz quem somos e traz e-mail de contato — a mesma
    URL responde 200.

    Isso não é sorte: é a regra do `identidade.py` cobrando o preço dela ao
    contrário do esperado. Quem se identifica passa; quem se fantasia, não.
    **Não troque este User-Agent por um de navegador pra "resolver" um
    bloqueio** — é o que causaria o bloqueio.

    O `MOXFIELD_USER_AGENT` do `.env` existe pro dia em que eles pedirem um
    identificador combinado. Vazio, vale o de sempre.

E O TEXTO COLADO IMPORTA DO MESMO JEITO. Ele cobre todo site que exporta
decklist e nenhum dos dois cobre — e cobre também o dia em que um deles
mudar de ideia sobre robôs. O formato que todos exportam é o mesmo
(`1 Sol Ring`), com variações que este módulo já engole.
"""
import os
import re
import time

import requests

from . import decks, identidade as ident, log, ritmo

TIMEOUT = float(os.environ.get("IMPORTAR_TIMEOUT", "20"))
TENTATIVAS = int(os.environ.get("IMPORTAR_TENTATIVAS", "3"))
BACKOFF = float(os.environ.get("IMPORTAR_BACKOFF", "1"))
DELAY_SEGUNDOS = float(os.environ.get("IMPORTAR_DELAY_SEGUNDOS", "1"))

ARCHIDEKT_API = os.environ.get("ARCHIDEKT_API", "https://archidekt.com/api")
MOXFIELD_API = os.environ.get("MOXFIELD_API", "https://api2.moxfield.com/v3")
# Só pro dia em que o Moxfield pedir um identificador combinado. Vazio manda
# o User-Agent honesto de sempre, que é o que funciona hoje — ver o topo,
# "passar por navegador é o que leva 403".
MOXFIELD_USER_AGENT = os.environ.get("MOXFIELD_USER_AGENT", "")

# Teto de linhas distintas que aceitamos de fora. É o mesmo espírito do
# `decks.MAX_ENTRADAS`: impedir que um link estranho vire uma lista de 50 mil
# linhas, não policiar quem importa um cube grande.
MAX_LINHAS = 800

# O nome da categoria que o deckbuilder trata como "fora das 100, dentro da
# cotação". Vem de `decks` e não de uma string aqui: renomeá-la um dia não
# pode deixar o importador escrevendo num grupo que não existe mais.
SIDEBOARD = decks.CATEGORIA_SIDEBOARD

# Como reconhecer o rótulo que o site de origem deu ao que ficou fora do
# deck. É busca no nome da categoria, não casamento exato: o Archidekt
# aceita "Sideboard", "sideboard", "Sideboard (troca)".
_EH_SIDEBOARD = re.compile(r"side\s*board|reserva", re.I)
_EH_TOKEN = re.compile(r"\btokens?\b|\bemblems?\b|\bfichas?\b", re.I)

_freio = ritmo.Freio("importar", DELAY_SEGUNDOS)


class ImportarError(Exception):
    """Não deu pra trazer a lista. A mensagem diz o que a pessoa pode fazer."""


# ---------------------------------------------------------------------------
# Reconhecer o link
# ---------------------------------------------------------------------------

_ARCHIDEKT = re.compile(
    r"archidekt\.com/(?:api/)?decks/(\d+)", re.I)
# O id público do Moxfield é a parte depois de /decks/: letras, números,
# hífen e underscore. `/primer`, `#hash` e `?query` ficam de fora.
_MOXFIELD = re.compile(
    r"moxfield\.com/decks/([A-Za-z0-9_-]+)", re.I)


def identificar(url: str) -> tuple[str, str]:
    """`("archidekt", "1585124")` a partir do link. Levanta se não reconhecer."""
    texto = (url or "").strip()
    achado = _ARCHIDEKT.search(texto)
    if achado:
        return "archidekt", achado.group(1)
    achado = _MOXFIELD.search(texto)
    if achado:
        return "moxfield", achado.group(1)
    raise ImportarError(
        "não reconheci esse link. Vale o endereço de um deck do Archidekt "
        "(archidekt.com/decks/...) ou do Moxfield (moxfield.com/decks/...) — "
        "ou cole a lista em texto.")


# ---------------------------------------------------------------------------
# Rede
# ---------------------------------------------------------------------------


def _sessao(user_agent: str = "") -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": user_agent or ident.user_agent("importação de deck"),
        "Accept": "application/json",
    })
    return s


def _pedir(url: str, fonte: str, user_agent: str = "") -> dict:
    """GET com freio, tentativas e erro que explica o que houve.

    Só tenta de novo o que pode melhorar sozinho (rede, 5xx, 429). 403 e 404
    são resposta, não falha: insistir neles é bater na porta de quem já disse
    não.
    """
    sessao = _sessao(user_agent)
    ultimo_erro = "?"

    for tentativa in range(1, TENTATIVAS + 1):
        _freio.esperar()
        try:
            resposta = sessao.get(url, timeout=TIMEOUT)
        except requests.RequestException as e:
            ultimo_erro = f"{type(e).__name__}: {e}"
            log.aviso("importar", "falhou", fonte=fonte, tentativa=tentativa,
                      motivo=ultimo_erro)
            time.sleep(ritmo.backoff(tentativa, BACKOFF))
            continue

        if resposta.status_code == 404:
            raise ImportarError(
                f"o {fonte} não achou esse deck. Confira o link — e lembre "
                f"que deck privado não abre de fora.")
        if resposta.status_code in (401, 403):
            raise ImportarError(_recado_de_bloqueio(fonte))
        if resposta.status_code == 429:
            _freio.recuar(60)
            ultimo_erro = "429 (pediram pra ir mais devagar)"
            continue
        if resposta.status_code >= 500:
            ultimo_erro = f"HTTP {resposta.status_code}"
            time.sleep(ritmo.backoff(tentativa, BACKOFF))
            continue
        if resposta.status_code != 200:
            raise ImportarError(
                f"o {fonte} respondeu HTTP {resposta.status_code}.")

        try:
            return resposta.json()
        except ValueError:
            # Cloudflare devolve HTML com 200 no desafio de navegador — é o
            # bloqueio disfarçado de página, e é o que o Moxfield faz.
            raise ImportarError(_recado_de_bloqueio(fonte))

    raise ImportarError(f"não consegui falar com o {fonte} ({ultimo_erro}).")


def _recado_de_bloqueio(fonte: str) -> str:
    """O recado de 403 e o de página de desafio, que são o mesmo problema.

    A saída sempre existe e é a mesma: exportar a lista e colar. Erro que só
    diz "bloqueado" deixa a pessoa sem próximo passo numa tela que TEM um.
    """
    if fonte.lower() == "moxfield":
        return ("o Moxfield recusou a consulta — pode ser deck privado, ou "
                "eles apertando o bloqueio de robô. Abra o deck lá, use "
                "Export → Copy to clipboard e cole a lista no campo de "
                "texto desta mesma janela.")
    return (f"o {fonte} recusou a consulta (bloqueio ou deck privado). "
            f"Se o deck for seu, exporte a lista e cole no campo de texto.")


# ---------------------------------------------------------------------------
# Archidekt
# ---------------------------------------------------------------------------


def _archidekt(deck_id: str) -> dict:
    dados = _pedir(f"{ARCHIDEKT_API}/decks/{deck_id}/", "Archidekt")
    if not isinstance(dados, dict) or "cards" not in dados:
        raise ImportarError(
            "o Archidekt respondeu num formato que eu não reconheço — o "
            "contrato da API deles mudou (esperava um campo 'cards').")

    # Categoria com `includedInDeck: false` é maybeboard, sideboard, lista de
    # desejos. A conta é do dono do deck, não nossa: ele é quem marcou o que
    # conta. Categoria que não aparece nesta lista (as de sistema) conta.
    fora = {c.get("name") for c in (dados.get("categories") or [])
            if isinstance(c, dict) and c.get("includedInDeck") is False}

    comandantes, cartas, maybeboard = [], [], []
    for item in dados.get("cards") or []:
        if not isinstance(item, dict):
            continue
        categorias = [c for c in (item.get("categories") or []) if c]
        nome = _nome_archidekt(item)
        if not nome:
            continue
        try:
            quantidade = int(item.get("quantity") or 1)
        except (TypeError, ValueError):
            quantidade = 1
        if quantidade <= 0:
            continue
        excluida = [c for c in categorias if c in fora]
        if excluida:
            if _EH_TOKEN.search(" ".join(excluida)):
                continue
            entrada = {"nome": nome, "quantidade": quantidade}
            # O rótulo do dono do deck decide: o que ele chamou de sideboard
            # continua sendo sideboard aqui; o resto do que ele tirou da
            # conta é dúvida, e dúvida é maybeboard.
            if _EH_SIDEBOARD.search(" ".join(excluida)):
                cartas.append({**entrada, "categoria": SIDEBOARD})
            else:
                maybeboard.append(entrada)
            continue
        if "Commander" in categorias:
            comandantes.append(nome)
        else:
            cartas.append({"nome": nome, "quantidade": quantidade})

    return _resultado(dados.get("name") or "", comandantes, cartas,
                      "Archidekt", f"https://archidekt.com/decks/{deck_id}",
                      maybeboard)


def _nome_archidekt(item: dict) -> str:
    """O nome oracle da carta dentro de um item do deck.

    `oracleCard.name` e não `card.displayName`: o segundo é o nome da
    impressão escolhida e vem `null` na maioria das cartas.
    """
    carta = item.get("card")
    if not isinstance(carta, dict):
        return ""
    oracle = carta.get("oracleCard")
    if isinstance(oracle, dict) and oracle.get("name"):
        return str(oracle["name"]).strip()
    return str(carta.get("displayName") or "").strip()


# ---------------------------------------------------------------------------
# Moxfield
# ---------------------------------------------------------------------------

# Onde as cartas moram na resposta v3, e o que cada tabuleiro é pra nós.
# `commanders` vira comandante; `mainboard` e `companions` viram as 99;
# `sideboard` vira a categoria de mesmo nome e `maybeboard` vira o
# maybeboard. O que sobra (tokens, attractions, stickers, planes) fica de
# fora: não é carta de deck de Commander.
_MOX_COMANDANTE = ("commanders",)
_MOX_DECK = ("mainboard", "companions")
_MOX_SIDEBOARD = ("sideboard",)
_MOX_MAYBE = ("maybeboard",)


def _moxfield(public_id: str) -> dict:
    dados = _pedir(f"{MOXFIELD_API}/decks/all/{public_id}", "Moxfield",
                   MOXFIELD_USER_AGENT)
    tabuleiros = dados.get("boards")
    if not isinstance(tabuleiros, dict):
        raise ImportarError(
            "o Moxfield respondeu num formato que eu não reconheço — o "
            "contrato da API deles mudou (esperava um campo 'boards').")

    conhecidos = (_MOX_COMANDANTE + _MOX_DECK + _MOX_SIDEBOARD + _MOX_MAYBE)
    comandantes, cartas, maybeboard = [], [], []
    for chave, tabuleiro in tabuleiros.items():
        if chave not in conhecidos:
            continue
        for item in ((tabuleiro or {}).get("cards") or {}).values():
            if not isinstance(item, dict):
                continue
            nome = str(((item.get("card") or {}).get("name") or "")).strip()
            if not nome:
                continue
            try:
                quantidade = int(item.get("quantity") or 1)
            except (TypeError, ValueError):
                quantidade = 1
            if quantidade <= 0:
                continue
            if chave in _MOX_COMANDANTE:
                comandantes.append(nome)
            elif chave in _MOX_MAYBE:
                maybeboard.append({"nome": nome, "quantidade": quantidade})
            elif chave in _MOX_SIDEBOARD:
                cartas.append({"nome": nome, "quantidade": quantidade,
                               "categoria": SIDEBOARD})
            else:
                cartas.append({"nome": nome, "quantidade": quantidade})

    return _resultado(dados.get("name") or "", comandantes, cartas,
                      "Moxfield", f"https://www.moxfield.com/decks/{public_id}",
                      maybeboard)


# ---------------------------------------------------------------------------
# Lista em texto
# ---------------------------------------------------------------------------

# `1 Sol Ring`, `1x Sol Ring`, `4 Lightning Bolt (2X2) 117`, `Sol Ring`.
# A quantidade é opcional: quem cola de um site que não numera fica com 1.
_LINHA = re.compile(r"""
    ^\s*
    (?:(?P<qtd>\d{1,3})\s*[xX]?\s+)?    # quantidade, com ou sem o "x"
    (?P<nome>.+?)                       # o nome, o mais curto que der
    \s*$
""", re.X)
# O que vem DEPOIS do nome e não é nome: edição entre parênteses e o número
# de coleção que costuma vir junto, marcadores de foil e a categoria que o
# Archidekt escreve entre colchetes.
_SUFIXOS = re.compile(r"""
    \s*(?:
        \((?P<ed>[^)]{1,12})\)(?:\s+[A-Za-z0-9\-★]+)?  # (2X2) 117
      | \[[^\]]*\]                                          # [Commander{top}]
      | \*[^*]*\*                                           # *CMDR* / *F*
      | \#[^#]*$                                            # #tag no fim
    )\s*$
""", re.X)
# Cabeçalhos de seção que os sites escrevem. O que vier depois de um de
# "fora" é ignorado até a próxima seção.
_CABECALHO_COMANDANTE = re.compile(
    r"^(?:\/\/\s*)?(?:commander|comandante)s?\s*[:(]?", re.I)
# As três seções que não são o deck, agora com destinos diferentes: o que o
# exportador chamou de sideboard vira a categoria `Sideboard`; o que ele
# chamou de dúvida vira maybeboard; token é descartado.
_CABECALHO_SIDEBOARD = re.compile(
    r"^(?:\/\/\s*)?(?:sideboard|reserva)\s*(?:de\b[^:(]*)?[:(]?", re.I)
_CABECALHO_MAYBE = re.compile(
    r"^(?:\/\/\s*)?(?:maybe\s*board|maybeboard|maybe|considering|"
    r"consider|acquire|wishlist|lista de desejos|talvez)\s*[:(]?", re.I)
_CABECALHO_DESCARTE = re.compile(
    r"^(?:\/\/\s*)?(?:tokens?|emblems?|fichas?)\s*[:(]?", re.I)
_CABECALHO_DECK = re.compile(
    r"^(?:\/\/\s*)?(?:deck|mainboard|main|creature|land|artifact|enchantment|"
    r"instant|sorcery|planeswalker|battle|companion)s?\s*[:(]?", re.I)
# TappedOut e Archidekt marcam o comandante na própria linha.
_MARCA_COMANDANTE = re.compile(r"\*CMDR\*|\[[^\]]*commander[^\]]*\]", re.I)


def de_texto(texto: str, nome_deck: str = "") -> dict:
    """A lista colada virando deck.

    Aceita o que os sites exportam: com ou sem quantidade, com ou sem edição
    entre parênteses, com cabeçalho de seção ou sem nenhum. O comandante sai
    de um cabeçalho "Commander", de um `*CMDR*` na linha, ou — se não houver
    nem um nem outro — fica pra tela decidir, porque adivinhar qual das 100
    é o comandante daria errado calado.

    Um cabeçalho de sideboard manda o que vem depois pra categoria
    `Sideboard`; um de maybeboard (ou "considering", "wishlist"), pro
    maybeboard; um de tokens, pro lixo. Antes tudo isso era descartado junto.
    """
    comandantes, cartas, maybeboard = [], [], []
    secao = "deck"

    for linha in (texto or "").splitlines():
        crua = linha.strip()
        if not crua:
            # Linha em branco separa seções em vários exportadores, mas NÃO
            # volta pro deck: se a anterior era sideboard, o que vem depois
            # continua sendo, até um cabeçalho dizer o contrário.
            continue
        if not _tem_carta(crua):
            # A ordem importa: "Maybeboard" casaria com o cabeçalho de deck
            # se ele viesse antes, e "Sideboard" precisa ser testado antes do
            # de dúvida pra não ser engolido por um `maybe` genérico.
            if _CABECALHO_COMANDANTE.match(crua):
                secao = "comandante"
                continue
            if _CABECALHO_SIDEBOARD.match(crua):
                secao = "sideboard"
                continue
            if _CABECALHO_MAYBE.match(crua):
                secao = "maybe"
                continue
            if _CABECALHO_DESCARTE.match(crua):
                secao = "descarte"
                continue
            if _CABECALHO_DECK.match(crua):
                secao = "deck"
                continue
        if crua.startswith("//") or crua.startswith("#"):
            continue
        if secao == "descarte":
            continue

        marcada = bool(_MARCA_COMANDANTE.search(crua))
        achado = _LINHA.match(crua)
        if not achado:
            continue
        nome = _limpar_nome(achado.group("nome"))
        if not nome:
            continue
        try:
            quantidade = int(achado.group("qtd") or 1)
        except (TypeError, ValueError):
            quantidade = 1
        if quantidade <= 0:
            continue

        if marcada or secao == "comandante":
            comandantes.append(nome)
        elif secao == "maybe":
            maybeboard.append({"nome": nome, "quantidade": quantidade})
        elif secao == "sideboard":
            cartas.append({"nome": nome, "quantidade": quantidade,
                           "categoria": SIDEBOARD})
        else:
            cartas.append({"nome": nome, "quantidade": quantidade})
        if len(cartas) + len(maybeboard) > MAX_LINHAS:
            raise ImportarError(
                f"a lista passa de {MAX_LINHAS} linhas distintas — isso não "
                f"é um deck de Commander.")

    if not comandantes and not cartas and not maybeboard:
        raise ImportarError(
            "não achei carta nenhuma nesse texto. O formato é uma carta por "
            "linha, tipo \"1 Sol Ring\".")
    return _resultado(nome_deck, comandantes, cartas, "lista colada", "",
                      maybeboard)


def _tem_carta(linha: str) -> bool:
    """A linha é cabeçalho ou é uma carta que por azar começa igual?

    "Creatures (23)" é cabeçalho; "Creature Guildpact" é carta. A diferença
    prática é a quantidade na frente — quem exporta com seção também exporta
    com número.
    """
    return bool(re.match(r"^\s*\d{1,3}\s*[xX]?\s+\S", linha))


def _limpar_nome(bruto: str) -> str:
    """Tira da linha o que não é nome: edição, número, marcadores, categoria.

    Roda em laço porque os sufixos se acumulam — o Archidekt escreve
    `1x Sol Ring (LTC) 285 [Artifact{top}]`, que são dois de uma vez.
    """
    nome = (bruto or "").strip()
    for _ in range(4):
        limpo = _SUFIXOS.sub("", nome).strip()
        if limpo == nome:
            break
        nome = limpo
    # "Fire // Ice" continua inteiro: é o nome da carta. Barra sozinha no fim
    # (`1 Sol Ring /`) some.
    return nome.strip(" \t-").strip()


# ---------------------------------------------------------------------------
# Saída comum
# ---------------------------------------------------------------------------


def _resultado(nome: str, comandantes: list[str], cartas: list[dict],
               fonte: str, link: str, maybeboard: list[dict] | None = None) -> dict:
    maybeboard = maybeboard or []
    # Um deck que só tem maybeboard não é deck vazio: é alguém que guarda a
    # lista de compras num site e vem cotar aqui.
    if not comandantes and not cartas and not maybeboard:
        raise ImportarError(
            f"o deck veio vazio do {fonte}. Se ele é privado ou está sem "
            f"cartas, não tem o que trazer.")
    log.evento("importar", "ok", fonte=fonte,
               comandantes=len(comandantes), linhas=len(cartas),
               maybe=len(maybeboard))
    return {
        "nome": (nome or "").strip(),
        "comandantes": comandantes,
        "cartas": cartas,
        "maybeboard": maybeboard,
        "fonte": fonte,
        "link": link,
    }


def de_url(url: str) -> dict:
    """O deck de um link do Archidekt ou do Moxfield."""
    site, chave = identificar(url)
    if site == "archidekt":
        return _archidekt(chave)
    return _moxfield(chave)
