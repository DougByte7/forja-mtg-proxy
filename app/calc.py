"""
Mesma lógica de cálculo do artifact (forja-de-proxies.html), em Python,
pra ser a fonte da verdade única usada tanto pra gerar a cobrança quanto
pra gerar o PDF de impressão.
"""
import hashlib
import math
import xml.etree.ElementTree as ET

CARDS_PER_PAGE = 9
PRICE_SINGLE_SIDE = 2.50
PRICE_DOUBLE_SIDE_PER_PAGE = 3.3333


def parse_order(xml_text: str):
    """Retorna (quantidade_de_cartas, quantidade_de_versos_especiais)."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise ValueError(f"XML inválido: {e}")

    qty = None
    qty_tag = root.find("details/quantity")
    if qty_tag is not None and qty_tag.text and qty_tag.text.strip().isdigit():
        n = int(qty_tag.text.strip())
        if n > 0:
            qty = n

    if qty is None:
        total = 0
        for slots in root.findall("fronts/card/slots"):
            total += len([s for s in (slots.text or "").split(",") if s.strip()])
        if total > 0:
            qty = total

    if qty is None:
        raise ValueError("Não encontrei a quantidade de cartas nesse XML.")

    backs_count = 0
    for slots in root.findall("backs/card/slots"):
        backs_count += len([s for s in (slots.text or "").split(",") if s.strip()])

    return qty, backs_count


def compute_deck_hash(xml_text: str) -> str:
    """
    Hash curto baseado nos nomes das cartas (tag <query>, com fallback pro
    nome do arquivo em <name>). Serve como código de referência pra
    diferenciar dois pedidos com o mesmo valor,
    é só um identificador que aparece no e-mail de aviso, pra conferência
    manual quando o valor bater e o nome não bastar pra desempatar.
    """
    root = ET.fromstring(xml_text)
    names = []
    for card in root.findall("fronts/card"):
        query = card.find("query")
        name = card.find("name")
        text = (query.text if query is not None and query.text else None) or \
               (name.text if name is not None and name.text else "")
        names.append(text.strip().lower())
    names.sort()
    digest = hashlib.sha256("|".join(names).encode("utf-8")).hexdigest()
    return digest[:8].upper()


def compute_cost(qty: int, backs_count: int, lamination: str) -> dict:
    if lamination not in ("single", "double"):
        raise ValueError("lamination precisa ser 'single' ou 'double'")

    slots_needed = qty + backs_count
    pages = math.ceil(slots_needed / CARDS_PER_PAGE)
    last_filled = slots_needed % CARDS_PER_PAGE or CARDS_PER_PAGE
    blanks = 0 if slots_needed % CARDS_PER_PAGE == 0 else CARDS_PER_PAGE - last_filled

    if lamination == "single":
        total = round(pages * PRICE_SINGLE_SIDE, 2)
    else:
        total = round(pages * PRICE_DOUBLE_SIDE_PER_PAGE, 2)

    return {
        "qty": qty,
        "backs_count": backs_count,
        "pages": pages,
        "blanks": blanks,
        "lamination": lamination,
        "total": total,
    }


def _card_name(card: ET.Element) -> str:
    """Nome da carta num <card> do MPC Fill: a tag <query> é a busca que o
    usuário digitou lá e é o que mais se parece com o nome real; <name> é o
    nome do ARQUIVO da arte ("Sol Ring (Commander 2017).png"), então só serve
    de reserva."""
    query = card.findtext("query")
    if query and query.strip():
        return " ".join(query.split())
    name = card.findtext("name") or ""
    return " ".join(name.split())


def parse_card_list(xml_text: str) -> list[dict]:
    """Lista de `{"nome", "quantidade"}` a partir do XML do MPC Fill.

    Serve de entrada pro cotador: o mesmo arquivo que o cliente já sobe pra
    orçar a impressão também diz quais cartas ele quer, então não faz sentido
    pedir a decklist de novo.

    A quantidade é o número de SLOTS, não o número de tags <card>: o MPC Fill
    junta cópias da mesma arte num <card> só com `slots` `0,1,2,3`. É o mesmo
    critério que o `parse_order` usa pra cobrar, então cotação e cobrança
    contam a mesma coisa.

    Cartas repetidas em <card> diferentes (mesma carta, artes diferentes) são
    somadas numa entrada só — pra cotar preço o que importa é o nome. A ordem
    de saída é a do primeiro slot de cada carta, que é a ordem da folha.

    Só olha `fronts`: `backs` são versos de dupla face, que não são cartas
    separadas pra comprar.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise ValueError(f"XML inválido: {e}")

    por_nome: dict[str, dict] = {}
    for card in root.findall("fronts/card"):
        nome = _card_name(card)
        if not nome:
            continue
        slots = [s.strip() for s in (card.findtext("slots") or "").split(",")]
        slots = [int(s) for s in slots if s.isdigit()]
        if not slots:
            continue
        chave = nome.lower()
        entrada = por_nome.get(chave)
        if entrada is None:
            por_nome[chave] = {"nome": nome, "quantidade": len(slots),
                               "_ordem": min(slots)}
        else:
            entrada["quantidade"] += len(slots)
            entrada["_ordem"] = min(entrada["_ordem"], min(slots))

    ordenadas = sorted(por_nome.values(), key=lambda c: c["_ordem"])
    return [{"nome": c["nome"], "quantidade": c["quantidade"]} for c in ordenadas]
