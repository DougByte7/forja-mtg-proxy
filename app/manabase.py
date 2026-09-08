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
os terrenos de fixação cobrem. E o preço usado pra separar "barato" de "se o
orçamento deixar" é o da Scryfall no dia da sincronização, em dólar, só pra
ordem de grandeza (ver `cartas.py`).
"""
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

# Abaixo disso um terreno é "barato" na lista de fixação. Dólar da Scryfall,
# ordem de grandeza — ver o cabeçalho.
TETO_USD = float(os.environ.get("MANABASE_TETO_USD", "3"))
# Quantos fixadores mostrar em cada lista. Uma identidade de três cores tem
# dezenas de terrenos que servem; a tela quer os melhores, não todos.
POR_LISTA = int(os.environ.get("MANABASE_POR_LISTA", "8"))

_SIMBOLO = re.compile(r"\{([^}]+)\}")
_QUALQUER_COR = re.compile(r"mana of any (?:one )?color", re.I)


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


def analisar(deck_completo: dict, identidade: str,
             teto_usd: float = TETO_USD) -> dict:
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

    # --- fixadores: terrenos da base que produzem 2+ cores que o deck pede ---
    baratos, caros = [], []
    if len(identidade) >= 2:
        no_deck = {base_cartas.normalizar(c["nome"]) for c, _ in entradas}
        pedidas_cores = {c["cor"] for c in cores if c["pips"] > 0}
        candidatos = []
        for terreno in base_cartas.terrenos(identidade):
            if base_cartas.normalizar(terreno["nome"]) in no_deck:
                continue
            produz = cores_que_produz(terreno, identidade) & pedidas_cores
            if len(produz) < 2:
                continue
            # Quantas fontes que FALTAM ele cobre pesa mais que quantas cores
            # produz: uma dual nas duas cores que estão sobrando não ajuda.
            cobre = sum(1 for c in cores if c["cor"] in produz and c["faltam"] > 0)
            candidatos.append((cobre, len(produz), terreno["preco_usd"] or 0,
                               {**terreno, "produz": "".join(
                                   x for x in CORES if x in produz)}))
        candidatos.sort(key=lambda t: (-t[0], -t[1], t[2]))
        for _, _, preco, terreno in candidatos:
            alvo = baratos if preco <= teto_usd else caros
            if len(alvo) < POR_LISTA:
                alvo.append(terreno)

    return {
        "terrenos": {"tem": n_terrenos, "recomendado": recomendado,
                     "diferenca": n_terrenos - recomendado},
        "magias": n_magias, "cmc_media": round(cmc_media, 2),
        "rampas_baratas": rampas,
        "identidade": identidade,
        "cores": cores,
        "basicos": basicos,
        "fixadores": {"baratos": baratos, "caros": caros},
        "teto_usd": teto_usd,
        "monocolor": len(identidade) < 2,
    }
