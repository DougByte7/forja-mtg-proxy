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

