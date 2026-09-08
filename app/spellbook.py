"""
Combos do deck, pelo Commander Spellbook.

AO CONTRÁRIO DA LIGAMAGIC, aqui é API pública e documentada, feita pra ser
consumida por robô — o `find-my-combos` existe exatamente pra isto: receber
uma decklist e dizer que combos ela tem. Não tem ofuscação, não tem contorno,
e o backend deles é código aberto (`SpaceCowMedia/commander-spellbook-backend`),
que é de onde este cliente tirou o contrato.

DUAS COISAS DO CONTRATO SURPREENDEM E ESTÃO CERTAS:

1. **É `GET` com corpo JSON.** Não é POST. A view deles (`FindMyCombosView`)
   só define `get`, e o corpo é o decklist. Incomum, mas é o que a API pede —
   mandar POST volta 405.
2. **A resposta vem em camelCase e embrulhada em paginação.** O Django deles
   usa `CamelCaseJSONRenderer`, então é `almostIncluded`, não
   `almost_included`; e o que interessa mora dentro de `results`.

UMA REQUISIÇÃO POR BUSCA, e a busca só acontece quando alguém clica — mesma
regra da cotação (ver `cotacao_job.py`). O deck muda a cada carta adicionada,
então uma busca automática viraria uma requisição por clique do usuário, o
que seria abusar de um serviço gratuito por nada.

O QUE ESTE MÓDULO ESCOLHE MOSTRAR. A API devolve seis listas; usamos duas:

  * `included` — os combos que o deck JÁ tem. É o que a pessoa quer ver.
  * `almostIncluded` — falta UMA peça, e ela cabe na identidade de cor do
    deck com os comandantes que já estão lá. É a sugestão acionável: dá pra
    adicionar a carta e fechar o combo.

As outras quatro (`...ByAddingColors`, `...ByChangingCommanders`) pedem
mudar a cor do deck ou trocar o comandante. Não são sugestão, são outro deck —
e listá-las junto afogaria as que dão pra usar.
"""
import hashlib
import json
import os
import time

import requests

from . import identidade as ident, log, ritmo

BASE = os.environ.get("SPELLBOOK_URL", "https://backend.commanderspellbook.com")
SITE = os.environ.get("SPELLBOOK_SITE", "https://commanderspellbook.com")
USER_AGENT = os.environ.get(
    "SPELLBOOK_USER_AGENT", ident.user_agent("busca de combos"))
TIMEOUT = float(os.environ.get("SPELLBOOK_TIMEOUT", "20"))
TENTATIVAS = int(os.environ.get("SPELLBOOK_TENTATIVAS", "3"))
BACKOFF = float(os.environ.get("SPELLBOOK_BACKOFF", "1"))
DELAY_SEGUNDOS = float(os.environ.get("SPELLBOOK_DELAY_SEGUNDOS", "1"))
# Cache do resultado por composição do deck. Vale por pouco tempo de
# propósito: o Spellbook publica combos novos toda semana, e o custo de
# perder o cache é UMA requisição.
CACHE_TTL = float(os.environ.get("SPELLBOOK_CACHE_TTL", str(6 * 3600)))
CACHE_DIR = os.environ.get("SPELLBOOK_CACHE_DIR", "/app/data/spellbook-cache")
LIGADO = os.environ.get("SPELLBOOK", "1") == "1"

# Limites do serializer deles (`common/serializers.py`): 600 linhas no deck e
# 12 comandantes. Cortar aqui evita mandar um pedido que já se sabe recusado.
MAX_CARTAS = 600
MAX_COMANDANTES = 12

# `bracket_tag` de cada combo, na escala deles. Serve pra tela dizer o peso do
# combo sem a pessoa precisar abrir o link — um combo "Exhibition" é piada de
# mesa, um "Ruthless" ganha o jogo.
BRACKETS = {
    "B": ("Banido", "carta banida em Commander"),
    "R": ("Impiedoso", "ganha o jogo na hora; mesa de alto nível"),
    "S": ("Picante", "trava ou controla a mesa"),
    "P": ("Poderoso", "combo rápido de duas cartas, ou game changer"),
    "O": ("Esquisito", "funciona, mas pede a mesa colaborando"),
    "C": ("Comum", "combo de deck comum"),
    "E": ("Exibição", "mais graça que ameaça"),
}

_freio = ritmo.Freio("spellbook", DELAY_SEGUNDOS)


class SpellbookError(Exception):
    """Não deu pra perguntar ao Spellbook, ou ele respondeu o que não entendo."""


def _sessao() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT,
                      "Accept": "application/json",
                      "Content-Type": "application/json"})
    return s


def _chave(comandantes: list[str], cartas: list[dict]) -> str:
    """Identidade da consulta: o deck, sem depender da ordem das listas."""
    cru = json.dumps({
        "c": sorted(n.lower() for n in comandantes),
        "m": sorted((c["nome"].lower(), c["quantidade"]) for c in cartas),
    }, ensure_ascii=False)
    return hashlib.sha256(cru.encode("utf-8")).hexdigest()[:16]


def _caminho_cache(chave: str, prefixo: str = "combos") -> str:
    return os.path.join(CACHE_DIR, f"{prefixo}-{chave}.json")


def _do_cache(chave: str, prefixo: str = "combos") -> dict | None:
    caminho = _caminho_cache(chave, prefixo)
    try:
        with open(caminho, encoding="utf-8") as f:
            guardado = json.load(f)
    except (OSError, ValueError):
        return None
    if time.time() - guardado.get("quando", 0) > CACHE_TTL:
        return None
    return guardado


def _guardar_cache(chave: str, dados: dict, prefixo: str = "combos") -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        # Escreve ao lado e renomeia: um processo morto no meio da escrita
        # deixaria um JSON pela metade que a próxima leitura teria que
        # adivinhar. Mesma ideia do `cache_precos`.
        temporario = _caminho_cache(chave, prefixo) + ".tmp"
        with open(temporario, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False)
        os.replace(temporario, _caminho_cache(chave, prefixo))
    except OSError as e:
        log.aviso("spellbook", "cache-nao-gravou",
                  motivo=f"{type(e).__name__}: {e}")


def _pedir(corpo: dict, caminho: str = "find-my-combos",
           metodo: str = "GET") -> dict:
    """A requisição, com as tentativas e o freio de 429.

    O método varia por rota, e não por gosto: o `find-my-combos` só define
    `get` (POST volta 405), enquanto o `estimate-bracket` define os dois e
    aceita POST — que é o que se usa lá, porque GET com corpo é o tipo de
    coisa que um proxy no meio do caminho pode descartar.

    Levanta `SpellbookError` quando não deu pra perguntar. Nunca devolve
    resultado parcial: combo que não veio é combo que a tela não pode
    inventar.
    """
    sessao = _sessao()
    url = f"{BASE}/{caminho}/"
    ultimo_erro = "?"

    for tentativa in range(1, TENTATIVAS + 1):
        _freio.esperar()
        try:
            resposta = sessao.request(metodo, url, data=json.dumps(corpo),
                                      timeout=TIMEOUT)
        except requests.RequestException as e:
            ultimo_erro = f"{type(e).__name__}: {e}"
            log.aviso("spellbook", "falhou", tentativa=tentativa,
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
            log.aviso("spellbook", "erro-do-servidor", tentativa=tentativa,
                      status=resposta.status_code)
            time.sleep(ritmo.backoff(tentativa, BACKOFF))
            continue

        if resposta.status_code != 200:
            # 4xx é pedido malfeito: repetir igual daria igual. O corpo da
            # resposta costuma dizer qual campo eles recusaram.
            raise SpellbookError(
                f"o Spellbook recusou a consulta (HTTP {resposta.status_code}): "
                f"{resposta.text[:200]}")

        try:
            return resposta.json()
        except ValueError:
            raise SpellbookError(
                "o Spellbook respondeu algo que não é JSON — provavelmente "
                "uma página de erro ou manutenção")

    raise SpellbookError(f"não consegui falar com o Spellbook ({ultimo_erro})")


def _nome_da_peca(uso: dict) -> str:
    return ((uso.get("card") or {}).get("name") or "").strip()


def _combo(bruto: dict, no_deck: set[str]) -> dict:
    """Um `variant` da API no formato que a tela desenha.

    `no_deck` são os nomes que o deck tem, já em minúsculas — é o que decide
    quais peças estão faltando. A conta é feita AQUI e não vem da API porque
    a API só classifica o combo inteiro ("falta uma"); qual peça falta é
    justamente o que a tela precisa dizer.
    """
    pecas, faltam = [], []
    for uso in bruto.get("uses") or []:
        nome = _nome_da_peca(uso)
        if not nome:
            continue
        tem = nome.lower() in no_deck
        pecas.append({
            "nome": nome,
            "quantidade": uso.get("quantity") or 1,
            "comandante": bool(uso.get("mustBeCommander")),
            "no_deck": tem,
        })
        if not tem:
            faltam.append(nome)

    # `requires` são peças GENÉRICAS ("uma criatura com vigilância"), não
    # cartas. Não dá pra adicionar uma delas com um clique, então elas viram
    # texto de requisito em vez de sugestão.
    requer = [((r.get("template") or {}).get("name") or "").strip()
              for r in bruto.get("requires") or []]

    produz = [((p.get("feature") or {}).get("name") or "").strip()
              for p in bruto.get("produces") or []]

    bracket = (bruto.get("bracketTag") or "").upper()
    rotulo, explicacao = BRACKETS.get(bracket, ("", ""))

    return {
        "id": bruto.get("id"),
        "link": f"{SITE}/combo/{bruto.get('id')}" if bruto.get("id") else SITE,
        "pecas": pecas,
        "faltam": faltam,
        "requer": [r for r in requer if r],
        "produz": [p for p in produz if p],
        "identidade": bruto.get("identity") or "",
        "mana": bruto.get("manaNeeded") or "",
        "prerequisitos": bruto.get("notablePrerequisites") or "",
        "passos": bruto.get("description") or "",
        "popularidade": bruto.get("popularity"),
        "bracket": bracket,
        "bracket_rotulo": rotulo,
        "bracket_explicacao": explicacao,
    }


def _corpo_do_deck(comandantes: list[str], cartas: list[dict]) -> dict:
    """O deck no formato que as duas rotas deles esperam.

    Comandante vai SEPARADO do resto, e não é firula: combo que exige a peça
    na zona de comando só conta se ela estiver lá, e o cálculo de bracket
    trata carta do comando de forma diferente na hora de decidir se um combo
    é "de duas cartas".
    """
    return {
        "commanders": [{"card": nome, "quantity": 1}
                       for nome in comandantes[:MAX_COMANDANTES]],
        "main": [{"card": c["nome"], "quantity": int(c["quantidade"])}
                 for c in cartas[:MAX_CARTAS]],
    }


def buscar(comandantes: list[str], cartas: list[dict],
           usar_cache: bool = True) -> dict:
    """Os combos do deck, pelo Commander Spellbook.

    `cartas` é a decklist no formato de sempre (`[{"nome", "quantidade"}]`),
    sem os comandantes — eles vão em `comandantes`, porque a API separa as
    duas coisas: combo que exige a peça NA ZONA DE COMANDO só conta se ela
    estiver lá.

    Levanta `SpellbookError` quando não deu pra perguntar. Quem chama trata
    isso como "não sei", nunca como "não tem combo": as duas coisas parecem
    iguais na tela e são opostas.
    """
    if not LIGADO:
        raise SpellbookError("a busca de combos está desligada no .env "
                             "(SPELLBOOK=0).")
    if not comandantes and not cartas:
        raise SpellbookError("deck vazio: não há o que procurar.")

    chave = _chave(comandantes, cartas)
    if usar_cache:
        guardado = _do_cache(chave)
        if guardado:
            log.debug("spellbook", "cache", chave=chave,
                      combos=len(guardado.get("no_deck", [])))
            return {**guardado, "cache": True}

    inicio = time.time()
    resposta = _pedir(_corpo_do_deck(comandantes, cartas))

    # A resposta vem paginada; o que interessa mora em `results`. Aceitar os
    # dois formatos deixa o cliente vivo se eles tirarem a paginação um dia.
    dados = resposta.get("results") if isinstance(resposta.get("results"), dict) \
            else resposta
    if not isinstance(dados, dict) or "included" not in dados:
        raise SpellbookError(
            "o Spellbook respondeu num formato que eu não reconheço — o "
            "contrato da API mudou (esperava um campo 'included')")

    no_deck_nomes = {n.lower() for n in comandantes}
    no_deck_nomes |= {c["nome"].lower() for c in cartas}

    achados = {
        "identidade": dados.get("identity") or "",
        "no_deck": [_combo(v, no_deck_nomes) for v in dados.get("included") or []],
        "faltando_uma": [_combo(v, no_deck_nomes)
                         for v in dados.get("almostIncluded") or []],
        "quando": time.time(),
    }
    # Ordena o que falta pelo combo mais popular: quem vai adicionar UMA carta
    # pra fechar combo quer ver primeiro o que a comunidade mais joga.
    achados["faltando_uma"].sort(key=lambda c: c["popularidade"] or 0,
                                 reverse=True)
    achados["no_deck"].sort(key=lambda c: c["popularidade"] or 0, reverse=True)

    log.evento("spellbook", "ok", cartas=len(cartas),
               combos=len(achados["no_deck"]),
               faltando_uma=len(achados["faltando_uma"]),
               ms=int((time.time() - inicio) * 1000))

    _guardar_cache(chave, achados)
    return {**achados, "cache": False}


def estimar_bracket(comandantes: list[str], cartas: list[dict],
                    usar_cache: bool = True) -> dict:
    """A classificação do deck pelo `estimate-bracket` deles, crua.

    Devolve o `bracket_tag` e — o que interessa tanto quanto — a lista do que
    o justifica: cada carta classificada como *game changer*, negação de
    terreno em massa, turno extra ou banida, e cada combo com a velocidade e
    se ele é de duas cartas. Quem transforma isso na nota que a tela mostra é
    o `poder.py`; aqui é só o transporte.

    Esta rota aceita POST (a de combos não), então vai POST: GET com corpo
    funciona, mas é o tipo de coisa que um proxy no meio do caminho descarta.

    Ao contrário do `find-my-combos`, a resposta NÃO vem paginada — é o
    objeto direto.
    """
    if not LIGADO:
        raise SpellbookError("a análise de poder está desligada no .env "
                             "(SPELLBOOK=0).")
    if not comandantes and not cartas:
        raise SpellbookError("deck vazio: não há o que classificar.")

    chave = _chave(comandantes, cartas)
    if usar_cache:
        guardado = _do_cache(chave, "bracket")
        if guardado:
            log.debug("spellbook", "cache-bracket", chave=chave)
            return {**guardado, "cache": True}

    inicio = time.time()
    dados = _pedir(_corpo_do_deck(comandantes, cartas),
                   caminho="estimate-bracket", metodo="POST")

    if not isinstance(dados, dict) or "bracketTag" not in dados:
        raise SpellbookError(
            "o Spellbook respondeu num formato que eu não reconheço — o "
            "contrato da API mudou (esperava um campo 'bracketTag')")

    resultado = {
        "bracket_tag": dados.get("bracketTag") or "",
        "cartas": dados.get("cards") or [],
        "templates": dados.get("templates") or [],
        "combos": dados.get("combos") or [],
        "quando": time.time(),
    }
    log.evento("spellbook", "bracket", cartas=len(cartas),
               tag=resultado["bracket_tag"], combos=len(resultado["combos"]),
               ms=int((time.time() - inicio) * 1000))

    _guardar_cache(chave, resultado, "bracket")
    return {**resultado, "cache": False}
