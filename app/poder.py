"""
Nível de poder do deck, na escala oficial de brackets do Commander.

DE ONDE SAI O NÚMERO. Não é conta nossa. Quem classifica é o
`estimate-bracket` do Commander Spellbook (ver `spellbook.py`), que é
mantido por quem cataloga combo de Magic em tempo integral e conhece a lista
oficial de *game changers* da Wizards — uma lista que muda a cada anúncio
deles e que manter na mão aqui envelheceria em semanas.

O QUE ESTE MÓDULO FAZ é traduzir a resposta deles em duas coisas:

  1. **O bracket de 1 a 4**, pelo mesmo mapa que o backend deles usa
     (`Variant.bracket`): Impiedoso→4, Picante e Poderoso→3, Esquisito e
     Comum→2, Exibição→1. O mapa está copiado aqui de propósito — se um dia
     ele mudar lá, o teste que compara os dois é que vai avisar.

  2. **O porquê, carta por carta.** É a parte que importa. Uma nota sozinha
     não ajuda ninguém a decidir nada: "bracket 4" só vira informação útil
     quando vem com "por causa destes 5 game changers e deste combo de duas
     cartas". Foi por isso que a resposta deles traz cada carta classificada,
     e é isso que a tela mostra.

O BRACKET 5 NÃO É CALCULADO, e não é limitação nossa: cEDH é definido pelo
metagame e pela intenção de quem monta, não pela lista de cartas. Um deck
bracket 4 e um cEDH podem ter a mesma decklist. Dizer "5" a partir do papel
seria inventar.

E A ESTIMATIVA VALE PELO DECK INTEIRO: num deck pela metade ela só descreve
a metade que existe. Quem avisa disso é a tela, que sabe quantas cartas
faltam.
"""

# O mapa do próprio backend deles (`Variant.bracket`, um GeneratedField).
# `B` (carta banida) não tem número: um deck com carta banida não está em
# bracket nenhum, está fora do formato.
BRACKET_DA_TAG = {
    "R": 4,   # Ruthless
    "S": 3,   # Spicy
    "P": 3,   # Powerful
    "O": 2,   # Oddball
    "C": 2,   # Core
    "E": 1,   # Exhibition
    "B": None,  # Banned
}

# Os nomes oficiais dos brackets, como a Wizards os publicou.
NOME_DO_BRACKET = {
    1: ("Exibição", "Deck de mesa leve: sem combo e sem game changer — o jogo "
                    "acaba pelo que acontece na mesa."),
    2: ("Núcleo", "Nível de precon de fábrica: a régua da maioria das mesas."),
    3: ("Turbinado", "Precon melhorado: até três game changers, e combos que "
                     "não fecham cedo."),
    4: ("Otimizado", "Sem freio: o deck joga pra ganhar o mais rápido que "
                     "conseguir."),
    5: ("cEDH", "Torneio: definido pelo metagame, não pela lista de cartas."),
}


def _nome(carta: dict) -> str:
    return ((carta.get("card") or {}).get("name")
            or (carta.get("template") or {}).get("name") or "").strip()


def _nomes(itens: list[dict], campo: str) -> list[str]:
    """Os nomes dos itens marcados com `campo`, sem repetir e em ordem."""
    achados = {_nome(i) for i in itens if i.get(campo)}
    return sorted(n for n in achados if n)


def ler(estimativa: dict) -> dict:
    """A resposta do `estimate-bracket` virando o que a tela desenha.

    Devolve o bracket, o nome dele, e os `motivos` — cada um com o que é,
    quantos são e quais cartas. É o "por que essa nota", que é a única parte
    disso que ajuda alguém a decidir se troca uma carta.
    """
    tag = (estimativa.get("bracket_tag") or "").upper()
    bracket = BRACKET_DA_TAG.get(tag)
    cartas = estimativa.get("cartas") or []
    templates = estimativa.get("templates") or []
    combos = estimativa.get("combos") or []

    motivos = []

    banidas = _nomes(cartas, "banned")
    if banidas:
        motivos.append({
            "tipo": "banidas", "nivel": "erro",
            "titulo": "Cartas banidas em Commander",
            "detalhe": "Com carta banida o deck não está em bracket nenhum — "
                       "está fora do formato.",
            "cartas": banidas,
        })

    # A contagem de game changers é o que separa o bracket 3 do 4: três é o
    # teto do 3, o quarto empurra pro 4. Por isso ela vem com número, e não
    # só com a lista.
    game_changers = _nomes(cartas, "gameChanger")
    if game_changers:
        motivos.append({
            "tipo": "game_changers", "nivel": "peso",
            "titulo": f"{len(game_changers)} game changer(s)",
            "detalhe": ("Até três cabem no bracket 3; o quarto sozinho já "
                        "leva o deck pro 4."
                        if len(game_changers) <= 3 else
                        "Mais de três game changers colocam o deck no "
                        "bracket 4."),
            "cartas": game_changers,
        })

    negacao = _nomes(cartas, "massLandDenial") + _nomes(templates, "massLandDenial")
    if negacao:
        motivos.append({
            "tipo": "terra", "nivel": "peso",
            "titulo": "Negação de terreno em massa",
            "detalhe": "Fora do bracket 3 pra baixo: a mesa inteira para de "
                       "jogar quando isso resolve.",
            "cartas": sorted(set(negacao)),
        })

    turnos = _nomes(cartas, "extraTurn") + _nomes(templates, "extraTurn")
    if turnos:
        motivos.append({
            "tipo": "turnos", "nivel": "peso",
            "titulo": "Turnos extras",
            "detalhe": "Turno extra avulso cabe no bracket 2; encadeado, não.",
            "cartas": sorted(set(turnos)),
        })

    # Combos: o que pesa é ser de DUAS cartas e ser rápido. `speed` é a escala
    # deles e vem do custo de mana pra fechar — 5 é combo de graça, 1 é combo
    # que pede mais de oito de mana.
    duas_cartas = []
    for c in combos:
        if not (c.get("definitelyTwoCard") or c.get("arguablyTwoCard")):
            continue
        combo = c.get("combo") or {}
        pecas = [((u.get("card") or {}).get("name") or "").strip()
                 for u in combo.get("uses") or []]
        duas_cartas.append({
            "pecas": [p for p in pecas if p],
            "velocidade": c.get("speed"),
            "certeza": bool(c.get("definitelyTwoCard")),
            "id": combo.get("id"),
        })
    if duas_cartas:
        rapidos = [c for c in duas_cartas if (c["velocidade"] or 0) >= 4]
        # "1 deles fecham" é o tipo de erro que se lê como descuido e faz
        # duvidar do resto do painel.
        quantos = (f"{len(rapidos)} deles fecham" if len(rapidos) > 1
                   else "1 deles fecha")
        motivos.append({
            "tipo": "combos", "nivel": "peso",
            "titulo": f"{len(duas_cartas)} combo(s) de duas cartas",
            "detalhe": (f"{quantos} com pouca mana, que é o que empurra o "
                        f"deck pro bracket 4." if rapidos else
                        "Nenhum deles é barato de fechar."),
            "cartas": [" + ".join(c["pecas"]) for c in duas_cartas[:8]],
        })

    travas = [c for c in combos if c.get("lock") or c.get("skipTurns")
              or c.get("controlAllOpponents")]
    if travas:
        motivos.append({
            "tipo": "travas", "nivel": "peso",
            "titulo": f"{len(travas)} combo(s) que travam ou controlam a mesa",
            "detalhe": "Trava, pular turnos ou controlar oponentes não cabe "
                       "abaixo do bracket 3.",
            "cartas": [" + ".join(
                (u.get("card") or {}).get("name", "") for u in
                (c.get("combo") or {}).get("uses") or [])
                for c in travas[:6]],
        })

    nome, explicacao = NOME_DO_BRACKET.get(bracket, ("", ""))
    return {
        "bracket": bracket,
        "nome": nome,
        "explicacao": explicacao,
        "tag": tag,
        "motivos": motivos,
        # Sem nada que puxe pra cima, o deck é o que é por AUSÊNCIA — e dizer
        # isso é mais honesto do que uma lista vazia de motivos.
        "sem_motivos": not motivos,
        "cache": estimativa.get("cache", False),
    }
