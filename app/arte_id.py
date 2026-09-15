"""
O id de uma arte, e de onde ela vem.

O `<id>` de cada carta no XML do pedido é tudo o que o PDF tem quando for
montado — no aviso de pagamento, de novo no "montar do zero", no PDF
combinado. Por isso o id se basta: diz a origem no prefixo e carrega o que é
preciso pra achar a imagem, sem consulta a tabela nenhuma.

* sem prefixo — arquivo do Google Drive, da biblioteca do MPC Fill. É a forma
  que o XML do MPC Fill sempre teve, e é por isso que ela fica sem prefixo:
  os pedidos já gravados continuam valendo.
* `scryfall:<id da impressão>:<front|back>` — a imagem oficial da Scryfall.
  A URL do PNG sai do id e do lado (`url_da_scryfall`).
* `enviada:<sha256>` — arquivo que a pessoa subiu (ver `artes_enviadas`).

Sem dependência nenhuma de propósito: quem lê isto é o `artes`, o
`pdf_generator` e o `artes_enviadas`, e nenhum deles pode puxar os outros só
pra saber de onde uma arte vem.
"""
import re

MPCFILL, SCRYFALL, ENVIADA = "mpcfill", "scryfall", "enviada"

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_SCRYFALL = re.compile(rf"^scryfall:({_UUID}):(front|back)$")
_ENVIADA = re.compile(r"^enviada:([0-9a-f]{64})$")
# O caminho das imagens da Scryfall: `/normal/front/6/9/<id>.jpg?123`. É a
# forma das URLs que a base local guarda, e dela sai o id da impressão.
_URL_SCRYFALL = re.compile(rf"/(front|back)/[0-9a-f]/[0-9a-f]/({_UUID})\.")

LADOS = {"frente": "front", "verso": "back"}


def origem(arte_id) -> str | None:
    """`mpcfill`, `scryfall` ou `enviada`. `None` = não é um id que se
    imprime: vazio, ou com prefixo que não é nenhum dos dois."""
    texto = str(arte_id or "").strip()
    if not texto:
        return None
    if texto.startswith("scryfall:"):
        return SCRYFALL if _SCRYFALL.match(texto) else None
    if texto.startswith("enviada:"):
        return ENVIADA if _ENVIADA.match(texto) else None
    # Id do Drive não tem dois-pontos; um prefixo desconhecido tem.
    return None if ":" in texto else MPCFILL


def da_scryfall(impressao: str, face: str) -> str:
    return f"scryfall:{impressao}:{LADOS.get(face, face)}"


def da_imagem_da_scryfall(url: str) -> str:
    """O id a partir de uma URL de imagem da Scryfall. Vazio se não for uma."""
    achado = _URL_SCRYFALL.search(url or "")
    return f"scryfall:{achado[2]}:{achado[1]}" if achado else ""


def url_da_scryfall(arte_id: str, formato: str = "png") -> str:
    """`png` é a de maior resolução (745 x 1040); `normal` e `large` são
    JPEG, do tamanho de olhar."""
    achado = _SCRYFALL.match(arte_id)
    if not achado:
        raise ValueError(f"não é um id da Scryfall: {arte_id!r}")
    impressao, lado = achado[1], achado[2]
    extensao = "png" if formato == "png" else "jpg"
    return (f"https://cards.scryfall.io/{formato}/{lado}/{impressao[0]}/"
            f"{impressao[1]}/{impressao}.{extensao}")


def enviada(sha: str) -> str:
    return f"enviada:{sha}"


def sha_da_enviada(arte_id: str) -> str:
    achado = _ENVIADA.match(arte_id or "")
    return achado[1] if achado else ""
