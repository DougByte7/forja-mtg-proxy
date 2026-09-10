"""
Qual arte de cada carta vai virar papel, por deck.

TABELA PRÓPRIA, E NÃO UMA COLUNA NO DECK. Duas razões, e a primeira é a que
decide:

1. **A linha do deck é reescrita INTEIRA pelo autosave, a cada tecla.**
   `decks.salvar` faz `UPDATE decks SET cartas=?, maybeboard=?, ...` com o que
   a tela mandou. Uma escolha de arte gravada nessa mesma linha correria com
   um autosave em voo e sumiria — a pessoa escolhe a arte, o autosave que já
   estava a caminho pousa por cima, e não há erro nenhum pra ver. Tabela
   separada = as duas escritas nunca disputam a mesma linha.
2. **A chave é o NOME da carta, não a posição na lista.** Assim a escolha
   sobrevive a reordenar o deck, mudar a carta de categoria, mudar a
   quantidade, e tirar e recolocar a carta — que é exatamente o que as pessoas
   fazem enquanto montam.

UMA ARTE POR NOME, NÃO POR CÓPIA, e isso é uma limitação conhecida: as 30
Florestas de um deck recebem todas a mesma arte. O motivo é que uma cópia não
tem identidade estável num deck que guarda só nome e quantidade (ver
`decks.py`) — não há o que carimbar. O caminho de extensão, se um dia isso
incomodar, é acrescentar `copia` à chave primária com o mesmo `ALTER` +
`PRAGMA` do resto do projeto, sem migração de dados.

O ID DO DRIVE ENVELHECE, e é por isso que `arquivo` e `nome` são guardados
junto. Arquivo removido da biblioteca do MPC Fill vira, no PDF, um retângulo
vermelho de "FALHA NO DOWNLOAD" — e descobrir isso depois de pagar é o pior
resultado possível. `revalidar` existe pra perguntar antes, e o nome guardado
é o que permite reconhecer a arte que a pessoa tinha escolhido mesmo depois de
o id morrer.
"""
import os
import sqlite3
import time
import xml.etree.ElementTree as ET

from . import cartas as base_cartas
from . import log

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")

FACES = ("frente", "verso")


def _conn():
    pasta = os.path.dirname(DB_PATH)
    if pasta:
        os.makedirs(pasta, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = _conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artes_escolhidas (
                deck_id TEXT,
                nome TEXT,          -- achatado por `cartas.normalizar`
                face TEXT,          -- "frente" | "verso"
                drive_id TEXT,      -- o arquivo no Drive: o que vira papel
                arquivo TEXT,       -- o <name> do MPC Fill
                fonte TEXT,
                dpi INTEGER,
                escolhido_em REAL,
                PRIMARY KEY (deck_id, nome, face)
            )
        """)
        # A consulta que roda toda vez que um deck abre.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_artes_deck "
                     "ON artes_escolhidas(deck_id)")
        conn.commit()
    finally:
        conn.close()


def _chave(nome: str) -> str:
    """O nome achatado, pela MESMA função que casa nomes no resto do projeto.

    Sem isto, "Lim-Dûl's Vault" e "Lim-Dul's Vault" viram duas linhas — e a
    escolha feita numa não aparece na outra.
    """
    return base_cartas.normalizar(nome)


def _linha(l) -> dict:
    return {"nome": l["nome"], "face": l["face"], "drive_id": l["drive_id"],
            "arquivo": l["arquivo"], "fonte": l["fonte"], "dpi": l["dpi"],
            "escolhido_em": l["escolhido_em"]}


def escolher(deck_id: str, nome: str, drive_id: str, face: str = "frente",
             arquivo: str = "", fonte: str = "", dpi: int = 0) -> dict:
    """Grava a escolha. Levanta `ValueError` com a razão em português."""
    chave = _chave(nome)
    if not deck_id or not chave:
        raise ValueError("Falta o deck ou o nome da carta.")
    if face not in FACES:
        raise ValueError(f"Face tem que ser uma de: {', '.join(FACES)}.")
    if not str(drive_id or "").strip():
        raise ValueError("Falta o id da arte.")

    conn = _conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO artes_escolhidas "
            "(deck_id, nome, face, drive_id, arquivo, fonte, dpi, escolhido_em) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (deck_id, chave, face, str(drive_id).strip(), arquivo or "",
             fonte or "", int(dpi or 0), time.time()))
        conn.commit()
    finally:
        conn.close()
    return {"nome": chave, "face": face, "drive_id": str(drive_id).strip(),
            "arquivo": arquivo or "", "fonte": fonte or "", "dpi": int(dpi or 0)}


def limpar(deck_id: str, nome: str, face: str = "frente") -> bool:
    """Volta a carta pro padrão. Devolve False se não havia escolha."""
    conn = _conn()
    try:
        cur = conn.execute(
            "DELETE FROM artes_escolhidas WHERE deck_id=? AND nome=? AND face=?",
            (deck_id, _chave(nome), face))
        conn.commit()
    finally:
        conn.close()
    return bool(cur.rowcount)


def do_deck(deck_id: str) -> dict[str, dict]:
    """As escolhas de um deck: `{nome_achatado: {frente: {...}, verso: {...}}}`.

    Aninhado por face porque a tela pergunta "o que está escolhido pra esta
    carta" e quer as duas de uma vez — carta de duas faces tem escolha
    separada pra cada lado.
    """
    conn = _conn()
    try:
        linhas = conn.execute(
            "SELECT * FROM artes_escolhidas WHERE deck_id=?", (deck_id,)).fetchall()
    finally:
        conn.close()
    saida: dict[str, dict] = {}
    for l in linhas:
        saida.setdefault(l["nome"], {})[l["face"]] = _linha(l)
    return saida


def para_deck(deck: dict) -> dict:
    """As escolhas + quais cartas do deck ainda estão no padrão.

    `faltando` é a lista que a tela usa pra dizer "87 com a arte padrão, 12
    escolhidas por você". Conta por NOME: quem precisa saber lado a lado o
    que falta pra imprimir é o `pedido`.
    """
    escolhas = do_deck(deck["id"])
    nomes = list(deck.get("comandantes") or []) + \
        [c["nome"] for c in deck.get("cartas") or []]
    faltando = [n for n in nomes if _chave(n) not in escolhas]
    return {"escolhas": escolhas, "faltando": faltando,
            "escolhidas": len(escolhas), "total": len(nomes)}


def pedido(deck: dict) -> dict:
    """O deck como pedido de impressão: o XML no formato do MPC Fill, montado
    com as artes escolhidas.

    É a ponte entre o deckbuilder e a tela de orçamento. O pedido nasce de um
    XML do MPC Fill — é ele que o `calc` cobra e o `pdf_generator` imprime —,
    e montar aqui o MESMO formato deixa revisão da folha, cobrança, PDF e
    cotação funcionando sem saber de onde o pedido veio.

    SÓ SAI XML COM TODAS AS ARTES ESCOLHIDAS. A arte padrão é a imagem da
    Scryfall, que não tem id no Drive, e o PDF só sabe baixar do Drive: carta
    sem escolha sairia como o retângulo de "FALHA NO DOWNLOAD". Faltando
    uma, `xml` volta `None` e `faltando` diz quais — `{nome, face}`, porque
    carta de duas faces pode ter a frente escolhida e o verso não.

    Entra o que vai pro papel, pelo critério da aba Artes: comandantes e as
    cartas do deck, sideboard incluído; o maybeboard não. O verso vai em
    `<backs>` com os MESMOS slots da frente, que é como o MPC Fill amarra o
    verso a cada cópia. Arquivos iguais dividem um `<card>` só, com todos os
    slots — as 30 Florestas são um arquivo em 30 lugares da folha.
    """
    escolhas = do_deck(deck["id"])
    linhas = [(nome, 1) for nome in deck.get("comandantes") or []] + \
        [(c["nome"], c["quantidade"]) for c in deck.get("cartas") or []]
    conhecidas = base_cartas.por_nomes([nome for nome, _ in linhas])

    frentes: dict[str, dict] = {}
    versos: dict[str, dict] = {}
    faltando = []
    artes_total = 0
    proximo = 0
    for nome, quantidade in linhas:
        carta = conhecidas.get(nome) or {}
        faces = FACES if carta.get("imagem_verso") else FACES[:1]
        artes_total += len(faces)
        escolhidas = escolhas.get(_chave(nome), {})
        faltando += [{"nome": nome, "face": f} for f in faces
                     if f not in escolhidas]
        slots = list(range(proximo, proximo + quantidade))
        proximo += quantidade
        for face, destino in zip(faces, (frentes, versos)):
            escolha = escolhidas.get(face)
            if not escolha:
                continue
            # O <query> é o nome da carta, que o `calc` usa pro código do
            # pedido e a cotação usa pra saber o que cotar. O verso leva só o
            # nome dele, como o MPC Fill escreve.
            consulta = nome
            if face == "verso":
                consulta = (carta.get("nome") or nome).split(" // ")[-1].strip()
            grupo = destino.setdefault(escolha["drive_id"], {
                "arquivo": escolha["arquivo"], "consulta": consulta, "slots": []})
            grupo["slots"] += slots

    xml = None
    if proximo and not faltando:
        raiz = ET.Element("order")
        ET.SubElement(ET.SubElement(raiz, "details"), "quantity").text = str(proximo)
        for secao, grupos in (("fronts", frentes), ("backs", versos)):
            if not grupos:
                continue
            el = ET.SubElement(raiz, secao)
            for drive_id, grupo in grupos.items():
                card = ET.SubElement(el, "card")
                ET.SubElement(card, "id").text = drive_id
                ET.SubElement(card, "slots").text = ",".join(map(str, grupo["slots"]))
                if grupo["arquivo"]:
                    ET.SubElement(card, "name").text = grupo["arquivo"]
                ET.SubElement(card, "query").text = grupo["consulta"]
        ET.indent(raiz, space="    ")
        xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               + ET.tostring(raiz, encoding="unicode") + "\n")
    return {"xml": xml, "faltando": faltando, "artes": artes_total,
            "cartas": proximo}


def apagar_do_deck(deck_id: str) -> int:
    """Todas as escolhas de um deck. Chamado quando o deck é apagado — senão a
    tabela cresce pra sempre com linhas órfãs que ninguém consegue mais ver.

    Tolera a tabela não existir, pelo mesmo motivo do `usuarios.da_sessao`:
    isto é um efeito colateral de apagar deck, e um banco no meio da migração
    não pode fazer APAGAR UM DECK falhar. Sem tabela não há o que apagar.
    """
    return _mexer("DELETE FROM artes_escolhidas WHERE deck_id=?", (deck_id,),
                  acao="apagar")


def copiar(de_deck: str, para_deck_id: str) -> int:
    """Leva as escolhas na duplicação de um deck.

    É claramente o que se quer: quem duplica um deck com arte escolhida quer a
    cópia igual — inclusive as artes, que foram o trabalho mais chato.
    """
    return _mexer(
        "INSERT OR REPLACE INTO artes_escolhidas "
        "(deck_id, nome, face, drive_id, arquivo, fonte, dpi, escolhido_em) "
        "SELECT ?, nome, face, drive_id, arquivo, fonte, dpi, escolhido_em "
        "FROM artes_escolhidas WHERE deck_id=?",
        (para_deck_id, de_deck), acao="copiar")


def _mexer(sql: str, params: tuple, acao: str) -> int:
    """Uma escrita que NÃO pode derrubar quem chamou.

    As duas funções acima são efeitos colaterais de apagar e duplicar deck. Um
    banco que ainda não passou pelo `init_db` (deploy no meio da migração, ou
    um teste que mexe em deck sem tocar em arte) não pode fazer aquelas duas
    operações falharem por causa de uma tabela auxiliar. O aviso fica no log,
    que é onde se procura quando algo não aconteceu.
    """
    conn = _conn()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.rowcount
    except sqlite3.Error as e:
        log.aviso("artes", f"{acao}-falhou", motivo=f"{type(e).__name__}: {e}")
        return 0
    finally:
        conn.close()


def revalidar(deck_id: str) -> dict:
    """Confere se os ids guardados ainda existem na biblioteca do MPC Fill.

    O CAMINHO DE VOLTA de um id que envelheceu. Arquivo removido de lá vira,
    no PDF, o retângulo vermelho de "FALHA NO DOWNLOAD" — e descobrir isso
    depois de a pessoa ter pago é o pior resultado que este sistema sabe
    produzir. Aqui se pergunta antes.

    Devolve `{"vivas": [...], "mortas": [{nome, arquivo, drive_id}]}`. As
    mortas trazem o nome do arquivo junto, que é o que permite dizer QUAL arte
    sumiu em vez de só um id de 33 caracteres.

    Import local de propósito: `artes` é sobre guardar escolha e funciona sem
    rede nenhuma; só esta função precisa do cliente HTTP, e um import no topo
    faria a tabela depender do MPC Fill estar de pé pra ser lida.
    """
    from . import mpcfill

    escolhas = do_deck(deck_id)
    porta = {}
    for nome, faces in escolhas.items():
        for face in faces.values():
            porta[face["drive_id"]] = {"nome": nome, "arquivo": face["arquivo"],
                                       "drive_id": face["drive_id"]}
    if not porta:
        return {"vivas": [], "mortas": []}

    ids = list(porta)
    conhecidos = {}
    # Em blocos, porque `metadados` tem teto por consulta.
    for i in range(0, len(ids), mpcfill.MAX_IDS):
        conhecidos.update(mpcfill.metadados(ids[i:i + mpcfill.MAX_IDS]))

    vivas = [i for i in ids if i in conhecidos]
    mortas = [porta[i] for i in ids if i not in conhecidos]
    if mortas:
        log.aviso("artes", "ids-mortos", deck=deck_id, quantos=len(mortas))
    return {"vivas": vivas, "mortas": mortas}
