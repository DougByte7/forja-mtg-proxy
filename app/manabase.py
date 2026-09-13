"""
Mana base: quantos terrenos o deck pede, de que cores, e o que falta.

É A ÚNICA ANÁLISE DO DECKBUILDER QUE NÃO SAI DAQUI. Combos, bracket e
sugestão vêm de serviços de fora; isto é conta sobre o próprio deck e a base
local de cartas, sem rede nenhuma — por isso é a única que pode acompanhar
cada clique em vez de esperar um botão.

A HEURÍSTICA É NOSSA E É SIMPLES DE PROPÓSITO. Existe análise séria sobre
quantos terrenos um deck precisa (a de Frank Karsten é a referência), e ela
depende de simulação e de tabela por custo de mana. O que está aqui é a
versão de mesa, em duas regras que qualquer um confere de cabeça:

  1. **Terrenos:** 36 num deck de curva média 3,2; um a mais a cada 0,25 de
     curva pra cima, um a menos pra baixo; e cada rampa barata (rock ou dork
     de custo até 2) vale meio terreno a menos, até quatro. Preso entre 32 e
     40, porque fora disso o problema não é a conta, é o deck.

  2. **Fontes por cor:** proporcionais aos símbolos de mana que o deck pede
     de cada cor, sobre o total de terrenos — com um piso, porque uma cor
     que aparece pouco ainda precisa ser encontrável: 8 fontes pra um respingo
     (menos de 12% dos símbolos), 12 pra cor de verdade.

Dois avisos que a tela repete. Fonte é o que PRODUZ a cor, então um terreno
de duas cores conta pras duas — é por isso que num deck de três cores as
fontes pedidas somam mais que os terrenos, e é exatamente essa diferença que
os terrenos de fixação cobrem. E o preço usado no teto é o da Scryfall no dia
da sincronização, em dólar, só pra ordem de grandeza (ver `cartas.py`).

OS TERRENOS DE FIXAÇÃO VÊM POR CICLO. Quem monta mana base pensa em "shock
lands", "fetch lands", "pain lands" — o ciclo diz de uma vez se o terreno
entra desvirado, o que custa e o que faz a mais. A base da Scryfall não traz
o ciclo, então ele é reconhecido pelo texto de regras (`categoria_de`), na
ordem de `CATEGORIAS`, que é também a ordem de qualidade em que a tela os
mostra: os que entram desvirados sem condição primeiro, os viradas por último.
"""
import math
import os
import re

from . import cartas as base_cartas

CORES = "WUBRG"
NOME_DA_COR = {"W": "Branco", "U": "Azul", "B": "Preto", "R": "Vermelho",
               "G": "Verde"}
BASICO_DA_COR = {"W": "Plains", "U": "Island", "B": "Swamp", "R": "Mountain",
                 "G": "Forest"}
SUBTIPO_COR = {"plains": "W", "island": "U", "swamp": "B", "mountain": "R",
               "forest": "G"}

# Teto de preço padrão da lista de fixação. Dólar da Scryfall, ordem de
# grandeza — ver o cabeçalho.
TETO_USD = float(os.environ.get("MANABASE_TETO_USD", "3"))

# Os ciclos, na ordem em que a tela os lista: (id, nome, grupo, descrição).
# O grupo é a pergunta que decide a mana base — o terreno entra desvirado? —
# e a descrição é o que o ciclo faz, dito pra quem joga.
CATEGORIAS = [
    ("duais", "Duals originais", "desviradas", "Dois tipos básicos, sem custo nenhum."),
    ("shock", "Shock lands", "desviradas", "Entram desviradas pagando 2 de vida."),
    ("fetch", "Fetch lands", "desviradas", "Sacrificam pra buscar um terreno, que entra desvirado."),
    ("qualquer", "Qualquer cor", "desviradas", "Produzem qualquer cor da identidade."),
    ("bond", "Bond lands", "desviradas", "Entram desviradas com dois ou mais oponentes."),
    ("pain", "Pain lands", "desviradas", "Mana colorida custa 1 de dano."),
    ("horizon", "Horizon lands", "desviradas", "Mana colorida custa 1 de vida; depois viram uma carta."),
    ("pathway", "Pathways", "desviradas", "Uma cor em cada face — você escolhe ao jogar."),
    ("verge", "Verges", "desviradas", "Uma cor sempre; a outra se você tiver o tipo certo."),
    ("filter", "Filter lands", "desviradas", "Pagam uma mana pra produzir duas das cores."),
    ("check", "Check lands", "condicionais", "Desviradas se você já controla um dos tipos."),
    ("fast", "Fast lands", "condicionais", "Desviradas até o terceiro terreno."),
    ("slow", "Slow lands", "condicionais", "Desviradas a partir do terceiro terreno."),
    ("snarl", "Reveal lands", "condicionais", "Desviradas se você revelar um dos tipos da mão."),
    ("battle", "Battle lands", "condicionais", "Desviradas com dois básicos em campo."),
    ("mdfc", "MDFCs", "condicionais", "Magia de um lado, terreno do outro."),
    ("manland", "Man lands", "condicionais", "Viram criatura."),
    ("tri", "Tri-lands", "viradas", "Três cores, entram viradas."),
    ("fetch_lenta", "Fetch lentas", "viradas", "Sacrificam pra buscar um básico, que entra virado."),
    ("bounce", "Bounce lands", "viradas", "Viradas; devolvem um terreno e produzem duas manas."),
    ("scry", "Scry lands", "viradas", "Viradas, com vidência 1."),
    ("surveil", "Surveil lands", "viradas", "Viradas, com vigiar 1."),
    ("gain", "Gain lands", "viradas", "Viradas, ganham 1 de vida."),
    ("cycling", "Cycling lands", "viradas", "Viradas, com ciclagem."),
    ("pure", "Pure tap", "viradas", "Viradas, sem nada em troca."),
    ("restrita", "Mana restrita", "outros", "Qualquer cor, só pra certos tipos de magia."),
    ("outros", "Outros", "outros", "Fixação com regras próprias."),
]

_SIMBOLO = re.compile(r"\{([^}]+)\}")
_QUALQUER_COR = re.compile(r"mana of any (?:one )?color", re.I)
# Texto de lembrete — "({T}: Add {U} or {B}.)" do terreno com tipo básico.
# Sai antes de classificar: a dual original tem SÓ o lembrete, e é por não ter
# mais nada que ela é reconhecida.
_LEMBRETE = re.compile(r"\([^)]*\)")
_VIRADO = re.compile(r"enters (?:the battlefield )?tapped|onto the battlefield tapped")
# O que transforma "entra virado" em "às vezes entra virado".
_CONDICAO = re.compile(r"tapped unless|if you don't|you may reveal|"
                       r"if you control .* enters tapped")
# "Qualquer cor" de verdade: de graça, ou só com vida. "{1}, {T}: Add one mana
# of any color" é fixação que custa a jogada, e fica em "Outros".
_QUALQUER_LIVRE = re.compile(r"^\{t\}(?:, pay 1 life)?: add one mana of any color", re.M)
# A fetch sacrifica a si mesma pra buscar; "sacrifice it. When you do, search"
# é a das Streets of New Capenna. A Demolition Field também diz "search your
# library", mas quem busca é o oponente.
_FETCH = re.compile(r"sacrifice (?:this land|it)\b[^.:]*(?::|\. when you do,) "
                    r"search your library for")
# As de Shadowmoor ("{U/R}, {T}: Add {U}{U}, {U}{R}, or {R}{R}") e as de
# Odyssey ("{1}, {T}: Add {W}{U}").
_FILTRO = re.compile(r"^(?:\{[wubrg]/[wubrg]\}|\{1\}), \{t\}: add \{[wubrg]\}\{[wubrg]\}", re.M)
_TRES_CORES = re.compile(r"^\{t\}: add \{[wubrg]\}, \{[wubrg]\}, or \{[wubrg]\}", re.M)
# A linha que um pure tap pode ter: produzir mana, entrar virado e — nas
# Thriving lands — escolher a cor.
_SO_PRODUZ = re.compile(r"\{t\}: add [^.]*\.|this land enters tapped\.|"
                        r"as this land enters, choose a color[^.]*\.")


def eh_terreno(carta: dict) -> bool:
    return "land" in (carta.get("tipo") or "").lower()


def cores_que_produz(carta: dict, identidade: str) -> set[str]:
    """As cores de mana que uma carta produz, dentro da identidade do deck.

    Dois caminhos, porque terreno diz isso de dois jeitos:

    * pelo **subtipo** — "Land — Forest Island" produz G e U sem dizer nada
      no texto (a habilidade é intrínseca ao tipo básico);
    * pelo **texto**, nas frases com "Add": "Add {G} or {U}", "Add one mana
      of any color". Só o que vem DEPOIS do "add" conta — "{G}: Add {C}" tem
      um {G} no custo de ativação que não é produção nenhuma.

    "Any color" (Command Tower, Exotic Orchard, Mana Confluence) vira todas as
    cores da identidade: é o que ele vai produzir neste deck.
    """
    permitidas = set(identidade or "")
    cores: set[str] = set()
    tipo = (carta.get("tipo") or "").lower()
    for subtipo, cor in SUBTIPO_COR.items():
        if subtipo in tipo:
            cores.add(cor)

    for frase in re.split(r"[.\n]", carta.get("texto") or ""):
        baixo = frase.lower()
        if "add" not in baixo:
            continue
        depois = frase[baixo.index("add") + 3:]
        if _QUALQUER_COR.search(depois):
            cores |= permitidas
        for simbolo in _SIMBOLO.findall(depois):
            # {G/U} híbrido e {G/P} phyrexiano produzem a(s) cor(es) da letra.
            for letra in simbolo.split("/"):
                if letra in CORES:
                    cores.add(letra)
    return cores & permitidas


def cores_que_busca(carta: dict, identidade: str) -> set[str]:
    """As cores que uma fetch land alcança, dentro da identidade.

    "Search your library for an Island or Swamp card" alcança U e B;
    "for a basic land card" alcança qualquer básico, ou seja, a identidade
    inteira. Carta que não busca terreno devolve vazio.
    """
    texto = (carta.get("texto") or "").lower()
    achado = re.search(r"search your library for (.*?) cards?", texto)
    if not achado or not _FETCH.search(texto):
        return set()
    alvo = achado.group(1)
    cores = {cor for subtipo, cor in SUBTIPO_COR.items() if subtipo in alvo}
    if not cores and "basic land" in alvo:
        cores = set(CORES)
    return cores & set(identidade or "")


def _face_de_terreno(carta: dict) -> tuple[str, str]:
    """Tipo e texto só da face que é terreno — numa MDFC, o verso."""
    tipos = (carta.get("tipo") or "").split(" // ")
    textos = (carta.get("texto") or "").split("\n//\n")
    for i, tipo in enumerate(tipos):
        if "land" in tipo.lower():
            return tipo, textos[i] if i < len(textos) else ""
    return tipos[0], textos[0]


def categoria_de(carta: dict, produz: set[str]) -> str:
    """O ciclo de um terreno, pelo texto de regras da face de terreno.

    A ordem dos testes importa: um terreno pode bater em mais de uma frase
    (a Zagoth Triome é virada E tem ciclagem; a Mana Confluence produz
    qualquer cor E custa vida), e o primeiro teste que casa é o que diz mais
    sobre ele.
    """
    tipo, texto = _face_de_terreno(carta)
    t = _LEMBRETE.sub("", texto).lower().strip()
    linhas = [l.strip() for l in t.split("\n") if l.strip()]
    tipos_basicos = sum(1 for s in SUBTIPO_COR if s in tipo.lower())
    virado = bool(_VIRADO.search(t))

    if (carta.get("layout") or "") == "modal_dfc":
        frente = (carta.get("tipo") or "").split(" // ")[0].lower()
        return "pathway" if "land" in frente else "mdfc"
    if _FETCH.search(t) and cores_que_busca(carta, CORES):
        return "fetch_lenta" if virado else "fetch"
    if "spend this mana only" in t:
        return "restrita"
    if _QUALQUER_LIVRE.search(t):
        return "qualquer"
    if "creature" in t and "still a land" in t:
        return "manland"
    if not t and tipos_basicos >= 2:
        return "duais"
    if "pay 2 life" in t:
        return "shock"
    if "return a land you control" in t:
        return "bounce"
    if _FILTRO.search(t):
        return "filter"
    if "damage to you" in t:
        return "pain"
    if re.search(r"pay 1 life: add", t):
        return "horizon"
    if "two or more opponents" in t:
        return "bond"
    if "two or fewer other lands" in t:
        return "fast"
    if "two or more other lands" in t:
        return "slow"
    if "two or more basic lands" in t:
        return "battle"
    if "you may reveal" in t:
        return "snarl"
    if re.search(r"tapped unless you control an? ", t):
        return "check"
    if "activate only if you control" in t and "{c}" not in t:
        return "verge"
    if virado and not _CONDICAO.search(t):
        if tipos_basicos >= 3 or _TRES_CORES.search(t):
            return "tri"
        if "scry" in t:
            return "scry"
        if "surveil" in t:
            return "surveil"
        if "gain 1 life" in t:
            return "gain"
        if "cycling" in t:
            return "cycling"
        if all(_SO_PRODUZ.fullmatch(l) for l in linhas):
            return "pure"
    return "outros"


def entrada_de(carta: dict) -> str:
    """"desvirada", "condicional" ou "virada" — como o terreno chega à mesa."""
    _, texto = _face_de_terreno(carta)
    t = _LEMBRETE.sub("", texto).lower()
    if not _VIRADO.search(t):
        return "desvirada"
    return "condicional" if _CONDICAO.search(t) else "virada"


def eh_rampa_barata(carta: dict) -> bool:
    """Rock ou dork de custo até 2 — o que substitui terreno na conta."""
    if eh_terreno(carta) or (carta.get("cmc") or 0) > 2:
        return False
    return bool(re.search(r"\badd\b.*(\{[WUBRGC]\}|mana)",
                          carta.get("texto") or "", re.I | re.S))


def pips_de(mana_cost: str) -> dict[str, float]:
    """Quantos símbolos de cada cor um custo pede. Híbrido divide o peso."""
    pips = {c: 0.0 for c in CORES}
    for simbolo in _SIMBOLO.findall(mana_cost or ""):
        letras = [l for l in simbolo.split("/") if l in CORES]
        for letra in letras:
            pips[letra] += 1.0 / len(letras)
    return pips


def terrenos_recomendados(cmc_media: float, rampas_baratas: int) -> int:
    """Regra 1 do cabeçalho."""
    alvo = 36 + (cmc_media - 3.2) * 4
    alvo -= min(4.0, rampas_baratas * 0.5)
    return int(round(min(40, max(32, alvo))))


def fontes_pedidas(pips: dict[str, float], terrenos: int) -> dict[str, int]:
    """Regra 2 do cabeçalho: proporcional aos símbolos, com piso."""
    total = sum(pips.values())
    pedidas = {}
    for cor, n in pips.items():
        if n <= 0:
            continue
        parte = n / total if total else 0
        piso = 8 if parte < 0.12 else 12
        pedidas[cor] = max(piso, int(round(terrenos * parte)))
    return pedidas


# Quantos terrenos de cada ciclo vão na visão geral. O ciclo aberto na tela
# vem inteiro; os outros, só os primeiros — é o que cabe numa olhada, e é o
# que deixa a resposta leve o bastante pra acompanhar cada autosave.
POR_CICLO = int(os.environ.get("MANABASE_POR_CICLO", "4"))
_ORDEM_ENTRADA = {"desvirada": 0, "condicional": 1, "virada": 2}


def fixadores(identidade: str, cores: list[dict], no_deck: set[str],
              teto_usd: float, categoria: str | None = None) -> list[dict]:
    """Os terrenos da base que servem a este deck, agrupados por ciclo.

    Serve quem produz — ou busca — duas ou mais das cores que o deck pede;
    MDFC serve com uma só, porque o que ela resolve é a vaga de terreno, não
    a cor. Terreno que o deck já tem vem marcado `no_deck` no fim do seu
    ciclo: saber que já há três shock lands é parte de decidir a quarta.
    Terreno acima do teto sai da lista e entra só na contagem
    `acima_do_teto` do ciclo; preço desconhecido fica.

    Cada ciclo leva `total` (os que servem e o deck não tem) e `terrenos`:
    todos, se for o `categoria` pedido; senão os `POR_CICLO` primeiros.
    """
    pedidas = {c["cor"] for c in cores if c["pips"] > 0} or set(identidade)
    faltando = {c["cor"] for c in cores if c["faltam"] > 0}
    grupos: dict[str, list] = {}
    acima: dict[str, int] = {}
    for terreno in base_cartas.terrenos(identidade):
        # Transform, meld e aventura com terreno só no verso não se jogam
        # como terreno: a carta chega à mesa pela face de magia.
        frente = (terreno.get("tipo") or "").split(" // ")[0].lower()
        if "land" not in frente and terreno.get("layout") != "modal_dfc":
            continue
        produz = (cores_que_produz(terreno, identidade)
                  | cores_que_busca(terreno, identidade)) & pedidas
        ciclo = categoria_de(terreno, produz)
        if len(produz) < (1 if ciclo == "mdfc" else 2):
            continue
        tem = base_cartas.normalizar(terreno["nome"]) in no_deck
        preco = terreno.get("preco_usd")
        if not tem and preco is not None and preco > teto_usd:
            acima[ciclo] = acima.get(ciclo, 0) + 1
            continue
        entrada = entrada_de(terreno)
        _, texto = _face_de_terreno(terreno)
        linhas = len([l for l in _LEMBRETE.sub("", texto).split("\n") if l.strip()])
        # Cobrir cor que FALTA pesa mais que produzir muitas: uma dual nas
        # duas cores que estão sobrando não ajuda. Depois, entrar desvirado.
        # Menos linhas de regra vem antes porque, dentro de um ciclo, cada
        # linha a mais costuma ser uma condição — o Command Tower antes do
        # Spire of Industry. O preço só desempata.
        ordem = (tem, -len(produz & faltando), _ORDEM_ENTRADA[entrada],
                 -len(produz), linhas, math.inf if preco is None else preco)
        grupos.setdefault(ciclo, []).append((ordem, {
            **terreno,
            "produz": "".join(x for x in CORES if x in produz),
            "entrada": entrada,
            "no_deck": tem,
        }))

    resposta = []
    for id_, nome, grupo, descricao in CATEGORIAS:
        if id_ not in grupos and id_ not in acima:
            continue
        lista = [t for _, t in sorted(grupos.get(id_, []), key=lambda p: p[0])]
        resposta.append({
            "id": id_, "nome": nome, "grupo": grupo, "descricao": descricao,
            "total": sum(1 for t in lista if not t["no_deck"]),
            "no_deck": sum(1 for t in lista if t["no_deck"]),
            "acima_do_teto": acima.get(id_, 0),
            "terrenos": lista if id_ == categoria else lista[:POR_CICLO],
        })
    return resposta


def base_atual(terrenos_no_deck: list[tuple[dict, int]],
               identidade: str) -> dict:
    """Os terrenos que o deck já tem, contados por ciclo e por como entram.

    Usa a mesma régua dos fixadores (`categoria_de`), pra que "2 shock lands"
    aqui seja o mesmo "Shock lands" da lista de compra. Terreno não básico
    que produz menos de duas cores da identidade não fixa nada e vai pra
    "Utilitários" — Reliquary Tower, Castle Vantress; a MDFC é a exceção,
    como na lista de compra.
    """
    nomes = {c[0]: c[1] for c in CATEGORIAS}
    grupos: dict[str, dict] = {}
    entrada = {"desvirada": 0, "condicional": 0, "virada": 0}
    for carta, q in terrenos_no_deck:
        if carta.get("basico"):
            ciclo = "basicos"
            entrada["desvirada"] += q
        else:
            produz = (cores_que_produz(carta, identidade)
                      | cores_que_busca(carta, identidade))
            ciclo = categoria_de(carta, produz)
            if len(produz) < (1 if ciclo == "mdfc" else 2):
                ciclo = "utilitarios"
            entrada[entrada_de(carta)] += q
        grupo = grupos.setdefault(ciclo, {"quantidade": 0, "cartas": []})
        grupo["quantidade"] += q
        grupo["cartas"].append(carta["nome"])

    ordem = ["basicos"] + [c[0] for c in CATEGORIAS] + ["utilitarios"]
    nomes.update({"basicos": "Básicos", "utilitarios": "Utilitários"})
    return {
        "entrada": entrada,
        "grupos": [{"id": id_, "nome": nomes[id_], **grupos[id_]}
                   for id_ in ordem if id_ in grupos],
    }


def analisar(deck_completo: dict, identidade: str,
             teto_usd: float = TETO_USD, categoria: str | None = None) -> dict:
    """A análise inteira, no formato que a tela desenha.

    `deck_completo` é o que `decks.com_cartas` devolve: cada entrada com a
    carta resolvida. Entrada cuja carta a base não conhece é ignorada — sem
    custo e sem texto não há o que contar.
    """
    entradas = [(e["carta"], e["quantidade"])
                for e in deck_completo.get("cartas_completas") or []
                if e.get("carta")]
    identidade = "".join(c for c in CORES if c in (identidade or ""))

    # --- o que o deck tem ---
    terrenos_no_deck = [(c, q) for c, q in entradas if eh_terreno(c)]
    magias = [(c, q) for c, q in entradas if not eh_terreno(c)]
    n_terrenos = sum(q for _, q in terrenos_no_deck)
    n_magias = sum(q for _, q in magias)
    cmc_media = (sum((c.get("cmc") or 0) * q for c, q in magias) / n_magias
                 if n_magias else 0.0)
    rampas = sum(q for c, q in magias if eh_rampa_barata(c))

    pips = {c: 0.0 for c in CORES}
    for carta, q in magias:
        for cor, n in pips_de(carta.get("mana_cost") or "").items():
            pips[cor] += n * q
    # Símbolos do comandante entram também: ele é a magia que o deck mais
    # conjura.
    for cmd in deck_completo.get("comandantes_completos") or []:
        if cmd:
            for cor, n in pips_de(cmd.get("mana_cost") or "").items():
                pips[cor] += n

    fontes = {c: 0 for c in CORES}
    for carta, q in terrenos_no_deck:
        for cor in cores_que_produz(carta, identidade):
            fontes[cor] += q
    fontes_fora = {c: 0 for c in CORES}   # rocks e dorks, só pra informar
    for carta, q in magias:
        for cor in cores_que_produz(carta, identidade):
            fontes_fora[cor] += q

    # --- o que ele pede ---
    recomendado = terrenos_recomendados(cmc_media, rampas)
    pedidas = fontes_pedidas(pips, recomendado)

    cores = []
    for cor in identidade:
        pedida = pedidas.get(cor, 0)
        cores.append({
            "cor": cor, "nome": NOME_DA_COR[cor],
            "pips": round(pips[cor], 1),
            "parte": round(pips[cor] / sum(pips.values()), 2) if sum(pips.values()) else 0,
            "fontes": fontes[cor], "fora_do_terreno": fontes_fora[cor],
            "pedidas": pedida, "faltam": max(0, pedida - fontes[cor]),
        })

    # --- básicos: o jeito mais barato de fechar o que falta ---
    vaga = max(0, recomendado - n_terrenos)
    basicos = []
    for c in sorted(cores, key=lambda x: -x["faltam"]):
        if c["faltam"] <= 0 or vaga <= 0:
            continue
        n = min(c["faltam"], vaga)
        basicos.append({"nome": BASICO_DA_COR[c["cor"]], "cor": c["cor"],
                        "quantidade": n})
        vaga -= n
    conhecidos = base_cartas.por_nomes([b["nome"] for b in basicos])
    for b in basicos:
        b["carta"] = conhecidos.get(b["nome"])

    no_deck = {base_cartas.normalizar(c["nome"]) for c, _ in entradas}

    return {
        "terrenos": {"tem": n_terrenos, "recomendado": recomendado,
                     "diferenca": n_terrenos - recomendado},
        "magias": n_magias, "cmc_media": round(cmc_media, 2),
        "rampas_baratas": rampas,
        "identidade": identidade,
        "cores": cores,
        "basicos": basicos,
        "base_atual": base_atual(terrenos_no_deck, identidade),
        "fixadores": fixadores(identidade, cores, no_deck, teto_usd, categoria),
        "categoria": categoria,
        "teto_usd": teto_usd,
        "monocolor": len(identidade) < 2,
    }
