"""
Lê as ofertas de uma carta no marketplace da LigaMagic.

AVISO, leia antes de mexer: isto NÃO é uma API. A LigaMagic não oferece uma,
e o site tem duas travas explícitas contra leitura automática de preço:

1. `robots.txt` pede `Crawl-delay: 360` — seis minutos entre requisições.
   `LIGAMAGIC_DELAY_SEGUNDOS` aqui é bem menor que isso, por decisão de quem
   toca o projeto. É uma divergência consciente do que o site pede, não
   descuido: se for pra rodar isso com frequência, converse com eles antes.
2. O preço não vem como texto. Vem como sprite de CSS, e o sprite, os nomes
   das classes e as coordenadas dentro da imagem são sorteados A CADA
   REQUISIÇÃO. Ler o preço exige reconhecer os dígitos na imagem, que é o que
   `_ocr_digito` faz.

`SCRAPING_NOTES.md` tem o mapeamento completo e o passo a passo de como isso
foi descoberto. Consequência prática: **este módulo quebra sem aviso quando a
LigaMagic mudar qualquer coisa**, então ele grita alto (exceção com mensagem
explicando o quê) em vez de devolver preço errado — preço errado calado é
muito pior que cotação que falhou.

Tudo que é específico da LigaMagic mora aqui. Quem chama recebe `Oferta` do
`cotacao.py` e não sabe de nada disso.
"""
import json
import os
import re
import time
from html import unescape  # importado assim porque `html` aqui é a página
from io import BytesIO

import requests
from PIL import Image

from . import cache_precos, identidade, log, ritmo
from .cotacao import Oferta, face_da_frente

BASE = "https://www.ligamagic.com.br/"

# Identifica quem está batendo, com contato. Se eles quiserem falar com a
# gente (ou bloquear), que seja pelo caminho fácil em vez de a gente se
# passar por navegador anônimo. O e-mail sai do .env — ver `identidade.py`.
USER_AGENT = os.environ.get(
    "LIGAMAGIC_USER_AGENT", identidade.user_agent("cotador de deck"))

# Segundos entre requisições PRA LIGAMAGIC (o sprite vem de outro host e não
# entra nessa conta). O robots.txt pede 360; ver o aviso no topo do arquivo.
DELAY_SEGUNDOS = float(os.environ.get("LIGAMAGIC_DELAY_SEGUNDOS", "3"))
# Quantas cartas em paralelo. Baixo de propósito: o gargalo é o delay acima,
# que é global, então subir isto não acelera quase nada e só aumenta o
# tamanho do tranco quando o delay é curto.
WORKERS = int(os.environ.get("LIGAMAGIC_WORKERS", "2"))
TIMEOUT_CONEXAO = float(os.environ.get("LIGAMAGIC_TIMEOUT_CONEXAO", "10"))
TIMEOUT_LEITURA = float(os.environ.get("LIGAMAGIC_TIMEOUT_LEITURA", "30"))
TENTATIVAS = int(os.environ.get("LIGAMAGIC_TENTATIVAS", "4"))
BACKOFF = float(os.environ.get("LIGAMAGIC_BACKOFF", "2"))


class LigaMagicError(Exception):
    """Falha lendo a LigaMagic. A mensagem diz se foi rede ou mudança de layout."""


# --------------------------------------------------------------------------
# OCR dos dígitos
# --------------------------------------------------------------------------
# Cada dígito é uma janela de 7x15 px recortada de um PNG de 600x84, sobre
# fundo branco. As formas são as MESMAS a cada requisição — só mudam de lugar
# dentro da imagem — então dá pra reconhecer por comparação de bitmap, sem
# OCR de verdade. Cada linha aqui é um bitmask de 7 bits (bit mais alto = pixel
# da esquerda), 15 linhas por dígito.
#
# São duas fontes diferentes: uma no sprite de preço (`/imgnum/`) e outra no
# de quantidade (`/imgunid/`). Ficam na mesma tabela porque não há colisão
# nenhuma entre as 20 formas — a menor distância entre bitmaps de dígitos
# DIFERENTES é de 8 bits. Por isso `_MAX_DISTANCIA` pode ser folgado e ainda
# assim nunca confundir um dígito com outro.
_TEMPLATES: list[tuple[tuple[int, ...], int]] = [
    ((0, 0, 0, 0, 28, 54, 54, 119, 119, 119, 54, 54, 28, 0, 0), 0),
    ((0, 0, 0, 0, 3, 15, 31, 31, 7, 7, 7, 7, 7, 0, 0), 1),
    ((0, 0, 0, 0, 30, 51, 3, 7, 7, 14, 28, 56, 63, 0, 0), 2),
    ((0, 0, 0, 0, 30, 55, 7, 12, 3, 3, 3, 55, 30, 0, 0), 3),
    ((0, 0, 0, 0, 6, 14, 14, 30, 30, 54, 63, 6, 6, 0, 0), 4),
    ((0, 0, 0, 0, 31, 24, 24, 62, 51, 3, 3, 51, 30, 0, 0), 5),
    ((0, 0, 0, 0, 30, 51, 48, 62, 51, 51, 51, 59, 30, 0, 0), 6),
    ((0, 0, 0, 0, 63, 7, 6, 12, 12, 12, 24, 24, 24, 0, 0), 7),
    ((0, 0, 0, 0, 30, 55, 51, 55, 30, 51, 51, 51, 30, 0, 0), 8),
    ((0, 0, 0, 0, 30, 55, 51, 51, 51, 31, 3, 50, 30, 0, 0), 9),
    ((0, 0, 0, 0, 30, 27, 51, 51, 51, 51, 51, 27, 30, 0, 0), 0),
    ((0, 0, 0, 0, 6, 14, 30, 6, 6, 6, 6, 6, 6, 0, 0), 1),
    ((0, 0, 0, 0, 30, 51, 3, 3, 6, 14, 24, 48, 63, 0, 0), 2),
    ((0, 0, 0, 0, 30, 51, 3, 3, 14, 3, 3, 51, 30, 0, 0), 3),
    ((0, 0, 0, 0, 7, 7, 15, 31, 31, 55, 63, 7, 7, 0, 0), 4),
    ((0, 0, 0, 0, 15, 27, 48, 63, 59, 51, 51, 27, 14, 0, 0), 6),
    ((0, 0, 0, 0, 63, 3, 6, 6, 12, 12, 12, 12, 24, 0, 0), 7),
    ((0, 0, 0, 0, 30, 27, 59, 27, 14, 59, 51, 59, 31, 0, 0), 8),
    ((0, 0, 0, 0, 30, 59, 51, 51, 59, 31, 3, 51, 30, 0, 0), 9),
]
CELULA_W, CELULA_H = 7, 15
# Bits de diferença ainda aceitos. Na prática o casamento é exato (distância
# 0); a folga existe pra sobreviver a recompressão da imagem, não pra
# adivinhar. Como o dígito mais parecido com outro está a 8 bits, 3 nunca
# troca um pelo outro.
_MAX_DISTANCIA = 3
# Quanto um pixel precisa se afastar do branco pra contar como tinta. Somado
# nos três canais, então é tolerante à cor — eles trocam a cor dos dígitos
# entre o sprite de preço e o de quantidade.
_LIMIAR_TINTA = 60


def _bitmap(img: Image.Image, x: int, y: int) -> tuple[int, ...]:
    """A célula 7x15 em (x, y) como 15 bitmasks de 7 bits."""
    linhas = []
    px = img.load()
    for j in range(CELULA_H):
        linha = 0
        for i in range(CELULA_W):
            r, g, b = px[x + i, y + j]
            tinta = (255 - r) + (255 - g) + (255 - b) > _LIMIAR_TINTA
            linha = (linha << 1) | (1 if tinta else 0)
        linhas.append(linha)
    return tuple(linhas)


def _ocr_digito(img: Image.Image, x: int, y: int) -> int:
    """O dígito desenhado na célula (x, y), ou explode se não reconhecer.

    Explodir é o comportamento certo: se a LigaMagic trocar a fonte dos
    números, o casamento para de bater e a cotação inteira falha com uma
    mensagem clara. A alternativa — pegar o "mais parecido" de qualquer jeito
    — cuspiria preços errados sem ninguém perceber.
    """
    alvo = _bitmap(img, x, y)
    melhor, distancia = None, 10 ** 6
    for modelo, digito in _TEMPLATES:
        d = sum(bin(a ^ b).count("1") for a, b in zip(alvo, modelo))
        if d < distancia:
            melhor, distancia = digito, d
    if distancia > _MAX_DISTANCIA:
        raise LigaMagicError(
            f"não reconheci o dígito em ({x},{y}) do sprite (distância "
            f"{distancia}). A LigaMagic provavelmente trocou a fonte dos "
            f"números — os templates em ligamagic.py precisam ser refeitos.")
    return melhor


# --------------------------------------------------------------------------
# Leitura da página
# --------------------------------------------------------------------------
_RE_POSICAO = re.compile(
    r"\.([A-Za-z][A-Za-z0-9_-]*)\{background-position:\s*(-?\d+)px\s+(-?\d+)px")
_RE_IMAGEM = re.compile(
    r"\.([A-Za-z][A-Za-z0-9_-]*)\{background-image:\s*url\(([^)]+)\)")
_RE_STYLE = re.compile(r"<style[^>]*>(.*?)</style>", re.S)


def _extrair_json(html: str, nome: str):
    """O valor de `var <nome> = ...;` do HTML.

    Feito com varredura de colchetes em vez de regex porque os dados têm
    `];` e `};` dentro de strings (nome de loja, título de anúncio) — regex
    não-guloso corta no lugar errado e o JSON não abre.
    """
    m = re.search(r"var\s+%s\s*=\s*" % re.escape(nome), html)
    if not m:
        raise LigaMagicError(
            f"não achei `var {nome}` na página. A LigaMagic mudou o layout — "
            f"veja SCRAPING_NOTES.md.")
    inicio = m.end()
    abre = html[inicio]
    fecha = {"[": "]", "{": "}"}.get(abre)
    if not fecha:
        raise LigaMagicError(f"`var {nome}` não começa com [ ou {{.")

    nivel, i, na_string, escapado = 0, inicio, False, False
    while i < len(html):
        c = html[i]
        if na_string:
            if escapado:
                escapado = False
            elif c == "\\":
                escapado = True
            elif c == '"':
                na_string = False
        elif c == '"':
            na_string = True
        elif c == abre:
            nivel += 1
        elif c == fecha:
            nivel -= 1
            if nivel == 0:
                try:
                    return json.loads(html[inicio:i + 1])
                except json.JSONDecodeError as e:
                    raise LigaMagicError(f"`var {nome}` não é JSON válido: {e}")
        i += 1
    raise LigaMagicError(f"`var {nome}` não fecha na página.")


def _mapa_css(html: str, obrigatorio: bool = True) -> tuple[dict, dict]:
    """(classe -> (x, y) no sprite, classe -> URL do sprite).

    `obrigatorio=False` quando nenhum PREÇO depende do sprite (todos vieram
    em texto puro): aí a falta das regras só custa a quantidade, que é
    opcional, e devolver mapas vazios é melhor que derrubar a cotação.
    """
    css = "".join(_RE_STYLE.findall(html))
    posicoes = {c: (abs(int(x)), abs(int(y)))
                for c, x, y in _RE_POSICAO.findall(css)}
    imagens = {c: ("https:" + u if u.startswith("//") else u)
               for c, u in _RE_IMAGEM.findall(css)}
    if (not posicoes or not imagens) and obrigatorio:
        raise LigaMagicError(
            "não achei as regras de sprite no <style> da página. A LigaMagic "
            "mudou o jeito de esconder o preço — veja SCRAPING_NOTES.md.")
    return posicoes, imagens


def _decodificar(css: str, posicoes: dict, imagens: dict, sprites: dict) -> str:
    """Transforma um `precoCss`/`quantCss` no número que ele representa.

    O formato é um grupo de classes por dígito, separados por `;`, com o
    token literal `V` no lugar da vírgula decimal. Dentro de cada grupo as
    classes vêm embaralhadas e têm papéis diferentes: uma diz a posição no
    sprite, outra diz QUAL sprite, e a terceira é só a caixa de 7x15. Por
    isso o grupo é lido por papel, nunca por ordem.
    """
    saida = []
    for grupo in css.split(";"):
        if grupo == "V":
            saida.append(",")
            continue
        classes = grupo.split()
        pos = [c for c in classes if c in posicoes]
        img = [c for c in classes if c in imagens]
        if not pos:
            # Grupo sem classe de posição não é dígito — é separador de
            # milhar ou enfeite. Ignora em vez de explodir: preço de quatro
            # dígitos não pode derrubar a cotação.
            continue
        if len(pos) > 1 or not img:
            raise LigaMagicError(
                f"grupo de dígito inesperado: {grupo!r}. A LigaMagic mudou a "
                f"estrutura do preço — veja SCRAPING_NOTES.md.")
        sprite = sprites[imagens[img[0]]]
        x, y = posicoes[pos[0]]
        saida.append(str(_ocr_digito(sprite, x, y)))
    return "".join(saida)


# --------------------------------------------------------------------------
# Rede
# --------------------------------------------------------------------------
# Compartilhado por todas as threads: além do intervalo mínimo entre
# requisições, guarda a pausa global aplicada quando a Liga responde 429.
# A trava é do módulo inteiro, não de cada thread — o que importa é o
# intervalo entre requisições que CHEGAM lá, não o que cada worker espera
# sozinho. Ver `ritmo.py`.
_freio = ritmo.Freio("ligamagic", DELAY_SEGUNDOS)


def _sessao() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9",
    })
    return s


def _get(sessao: requests.Session, url: str, freiar: bool = True,
         carta: str = "") -> requests.Response:
    """GET com ritmo, retry e log do motivo da falha.

    O parâmetro se chama `freiar` (e não `ritmo`) porque `ritmo` agora é o
    módulo importado lá em cima. Vale False só pros sprites, que vêm de outro
    host e não contam como requisição à LigaMagic.
    """
    erro = None
    for tentativa in range(1, TENTATIVAS + 1):
        if freiar:
            esperou = _freio.esperar()
            if esperou > DELAY_SEGUNDOS * 2:
                log.debug("ligamagic", "esperou", segundos=round(esperou, 1),
                          carta=carta or None)
        try:
            r = sessao.get(url, timeout=(TIMEOUT_CONEXAO, TIMEOUT_LEITURA))
            if r.status_code == 429 or r.status_code >= 500:
                # 429 é o site pedindo pra ir mais devagar. Aqui isso segura
                # TODAS as threads, não só esta: recuar cada worker por conta
                # mantém a mesma rajada e é o caminho certo pro bloqueio.
                erro = f"HTTP {r.status_code}"
                pausa = (ritmo.espera_pedida(r)
                         or ritmo.backoff(tentativa, BACKOFF)
                         * (5 if r.status_code == 429 else 1))
                if freiar:
                    _freio.recuar(pausa, motivo=erro, carta=carta)
                else:
                    time.sleep(pausa)
                log.aviso("ligamagic", "tentando-de-novo", carta=carta or None,
                          motivo=erro, tentativa=f"{tentativa}/{TENTATIVAS}",
                          pausa=round(pausa, 1))
                continue
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            erro = f"{type(e).__name__}: {e}"
            if tentativa < TENTATIVAS:
                pausa = ritmo.backoff(tentativa, BACKOFF)
                log.aviso("ligamagic", "tentando-de-novo", carta=carta or None,
                          motivo=erro, tentativa=f"{tentativa}/{TENTATIVAS}",
                          pausa=round(pausa, 1))
                time.sleep(pausa)
    log.erro("ligamagic", "desisti", carta=carta or None, url=url,
             motivo=erro, tentativas=TENTATIVAS)
    raise LigaMagicError(f"não consegui buscar {url}: {erro}")


def _baixar_sprites(sessao, urls) -> dict:
    """Baixa os sprites citados e devolve `URL -> Image`.

    Não passa pelo controle de ritmo: os sprites vêm de outro host (o CDN
    `repositorio.sbrauble.com`), então não contam como requisição à
    LigaMagic. São ~12 KB cada e só dois por página.
    """
    sprites = {}
    for url in urls:
        r = _get(sessao, url, freiar=False)
        try:
            sprites[url] = Image.open(BytesIO(r.content)).convert("RGB")
        except Exception as e:
            raise LigaMagicError(f"sprite {url} não abriu como imagem: {e}")
    return sprites


# --------------------------------------------------------------------------
# API do módulo
# --------------------------------------------------------------------------
def url_da_carta(nome: str) -> str:
    return BASE + "?view=cards/card&card=" + requests.utils.quote(nome)


def _tabela(dados, campo="acron"):
    return {str(d["id"]): unescape(d.get(campo) or d.get("label") or "")
            for d in dados}


def _e_pagina_de_carta(html: str) -> bool:
    """Se a busca não casou com carta nenhuma, a LigaMagic devolve HTTP 200
    com a página de busca vazia (~34 KB, título "Busca: ..."), sem NENHUMA
    das variáveis de dados. `var param` está em toda página de carta e em
    nenhuma página de busca, então é ela que separa "essa carta não existe"
    de "o site mudou" — dois casos que precisam de tratamento oposto."""
    return re.search(r"var\s+param\s*=", html) is not None


def _e_oferta_de_loja(o: dict) -> bool:
    """Se este anúncio é uma oferta de loja que dá pra comprar.

    Fica de fora: `sellType` 2, que é o bazar/leilão (o "preço" é lance de
    usuário, ainda sobe e some na data de encerramento); carta gradeada, que
    é item de colecionador em cápsula, com preço de outro mercado; e anúncio
    sem preço em campo nenhum.
    """
    if o.get("sellType") != 1 or o.get("is_graded"):
        return False
    return bool(o.get("precoFinal") or o.get("precoCss"))


def _preco_da_oferta(o: dict, nome: str, posicoes, imagens, sprites) -> float | None:
    """O preço de uma oferta, do jeito que ela trouxe.

    A ofuscação da LigaMagic é PARCIAL, e isso não é detalhe: na página do
    Sol Ring, 959 ofertas vêm com `precoCss` (sprite) e 217 vêm com
    `precoFinal` em texto limpo. Em carta pouco anunciada (Underground Sea)
    às vezes vêm todas em texto. Quando o texto está lá, é ele que vale —
    é o mesmo número, sem OCR no meio pra dar errado.

    `precoFinal` é o preço com desconto da loja, e `preco` (quando existe) é
    o cheio riscado ao lado. Quem paga paga o `precoFinal`.
    """
    bruto = o.get("precoFinal")
    if bruto:
        try:
            return float(str(bruto).replace(",", "."))
        except ValueError:
            raise LigaMagicError(
                f"precoFinal não virou número: {bruto!r} (carta {nome!r})")

    texto = _decodificar(o["precoCss"], posicoes, imagens, sprites)
    try:
        # O separador decimal decodificado é vírgula; ponto, se aparecer, é
        # separador de milhar e some.
        return float(texto.replace(".", "").replace(",", "."))
    except ValueError:
        raise LigaMagicError(
            f"preço decodificado não virou número: {texto!r} (carta {nome!r})")


def extrair_ofertas(html: str, nome: str, sessao=None) -> list[Oferta]:
    """Ofertas a partir do HTML já baixado. Separado de `buscar_carta` pra
    dar pra testar a decodificação com um HTML salvo, sem rede."""
    if not _e_pagina_de_carta(html):
        return []

    estoque = _extrair_json(html, "cards_stock")
    candidatas = [o for o in estoque if _e_oferta_de_loja(o)]
    # Carta que existe mas ninguém tem à venda (Power 9, por exemplo) chega
    # aqui sem candidata nenhuma. Sair antes de `_mapa_css` é o que faz esse
    # caso virar "sem oferta" em vez de "não achei as regras de sprite":
    # numa página sem preço pra mostrar, a LigaMagic não manda o <style>
    # dos dígitos.
    if not candidatas:
        return []

    posicoes, imagens = _mapa_css(html, obrigatorio=any(
        o.get("precoCss") for o in candidatas))
    lojas = _extrair_json(html, "cards_stores")
    # Os textos vêm com entidade HTML dentro do JSON ("Campe&otilde;es de
    # Kamigawa"), porque o mesmo campo é cuspido direto no HTML da página.
    edicoes = {str(e["id"]): unescape(e.get("name", ""))
               for e in _extrair_json(html, "cards_editions")}
    qualidades = _tabela(_extrair_json(html, "dataQuality"))
    idiomas = _tabela(_extrair_json(html, "dataLanguage"))
    extras = _tabela(_extrair_json(html, "dataExtras"))

    # Só baixa os sprites que alguma oferta realmente cita. Numa carta cujos
    # preços vieram todos em texto puro, o único sprite necessário é o da
    # quantidade — e se nem esse for citado, não baixa nada.
    precisa = set()
    for o in candidatas:
        for campo in ("precoCss", "quantCss"):
            for grupo in (o.get(campo) or "").split(";"):
                for c in grupo.split():
                    if c in imagens:
                        precisa.add(imagens[c])
    sprites = _baixar_sprites(sessao or _sessao(), precisa)

    ofertas = []
    for o in candidatas:
        loja = lojas.get(str(o.get("lj_id")), {})
        if loja.get("lj_recesso"):
            continue  # loja de férias: aparece na lista, mas não vende

        preco = _preco_da_oferta(o, nome, posicoes, imagens, sprites)
        if preco is None:
            continue

        # A quantidade é sempre ofuscada, mas é só uma preferência de
        # desempate no `escolher_oferta` — não vale derrubar a cotação
        # inteira por causa dela. Se não der pra ler, fica 0 ("não sei").
        quantidade = 0
        if o.get("quantCss"):
            try:
                bruto = _decodificar(o["quantCss"], posicoes, imagens, sprites)
                quantidade = int(bruto) if bruto.isdigit() else 0
            except LigaMagicError as e:
                print(f"[ligamagic] {nome!r}: não li a quantidade de uma "
                      f"oferta ({e}) — seguindo com estoque desconhecido.")

        ofertas.append(Oferta(
            loja=unescape(loja.get("lj_name") or "") or f"loja {o.get('lj_id')}",
            preco=preco,
            condicao=qualidades.get(str(o.get("qualid")), ""),
            idioma=idiomas.get(str(o.get("idioma")), ""),
            edicao=edicoes.get(str(o.get("idEdicao")), ""),
            quantidade=quantidade,
            link=url_da_carta(nome),
            extras=extras.get(str(o.get("extras")), ""),
        ))

    if candidatas and not ofertas:
        print(f"[ligamagic] {nome!r}: {len(candidatas)} oferta(s) de loja na "
              f"página, mas nenhuma sobrou (lojas em recesso?).")
    return ofertas


def buscar_carta(nome: str, usar_cache: bool = True) -> list[Oferta]:
    """Ofertas de UMA carta. Lista vazia = a LigaMagic não tem essa carta.

    Levanta `LigaMagicError` quando a falha é de rede ou de layout: quem
    chama precisa distinguir "não existe" de "não consegui ler", senão uma
    mudança no site vira "deck inteiro sem preço" em silêncio.
    """
    nome = " ".join(nome.split())
    if not nome:
        return []
    if usar_cache:
        cacheado = cache_precos.ler("ligamagic", nome)
        if cacheado is not None:
            log.debug("ligamagic", "cache", carta=nome, ofertas=len(cacheado))
            return cacheado

    inicio = time.monotonic()
    sessao = _sessao()
    usado = nome
    html = _get(sessao, url_da_carta(nome), carta=nome).text
    try:
        ofertas = extrair_ofertas(html, nome, sessao=sessao)

        # Carta de duas partes: a Liga é INCONSISTENTE entre os dois tipos,
        # e não dá pra saber qual é olhando só o nome.
        #
        #   "Fire // Ice"                          -> 388 ofertas
        #   "Fire"                                 ->   0
        #   "Bruce Banner // The Incredible Hulk"  ->   0
        #   "Bruce Banner"                         -> 164
        #
        # Split card fica com o nome inteiro; dupla-face de transformar fica
        # só com a frente. Como o nome não diz qual é, tenta a outra forma
        # quando a primeira não acha nada — uma requisição a mais, só pras
        # cartas com "//", que são poucas.
        frente = face_da_frente(nome)
        if not ofertas and frente != nome:
            log.debug("ligamagic", "tentando-a-frente", carta=nome,
                      frente=frente)
            html = _get(sessao, url_da_carta(frente), carta=frente).text
            ofertas = extrair_ofertas(html, frente, sessao=sessao)
            if ofertas:
                usado = frente
    except LigaMagicError as e:
        # Falha de LAYOUT, não de rede: o site mudou e o parser não acompanha
        # mais. Vale ERROR e não WARNING porque não passa sozinho — alguém
        # precisa olhar o `SCRAPING_NOTES.md` e refazer o mapeamento.
        log.erro("ligamagic", "layout-mudou", carta=nome, motivo=str(e))
        raise
    cache_precos.gravar("ligamagic", nome, ofertas)
    log.evento("ligamagic", "ok" if ofertas else "sem-oferta", carta=nome,
               achada_como=usado if usado != nome else None,
               ofertas=len(ofertas),
               ms=int((time.monotonic() - inicio) * 1000))
    return ofertas
