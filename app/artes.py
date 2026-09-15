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

UMA ARTE PRA TODAS AS CÓPIAS, E UMA POR CÓPIA QUANDO SE QUER. Uma cópia não
tem identidade num deck que guarda só nome e quantidade (ver `decks.py`),
então ela é o NÚMERO dela: `copia` 1 é a primeira das 30 Florestas, 2 a
segunda. `copia` 0 é a arte de todas, a que vale pra toda cópia sem escolha
própria. Aumentar a quantidade dá à cópia nova a arte de todas; diminuir
deixa guardada a escolha das cópias que saíram, e ela volta se elas voltarem.

TRÊS ORIGENS DE ARTE, E O ID DIZ QUAL (ver `arte_id`): arquivo do MPC Fill,
imagem oficial da Scryfall ou arquivo enviado pela pessoa. `arte_id` é o que
vai no `<id>` do XML.

O ID DO DRIVE ENVELHECE, e é por isso que `arquivo` e `nome` são guardados
junto. Arquivo removido da biblioteca do MPC Fill vira, no PDF, um retângulo
vermelho de "FALHA NO DOWNLOAD" — e descobrir isso depois de pagar é o pior
resultado possível. `revalidar` existe pra perguntar antes, e o nome guardado
é o que permite reconhecer a arte que a pessoa tinha escolhido mesmo depois de
o id morrer.
"""
import hashlib
import json
import os
import sqlite3
import time
import xml.etree.ElementTree as ET

from . import arte_id as ids
from . import calc
from . import cartas as base_cartas
from . import decks, log

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")

FACES = ("frente", "verso")

# O PNG da Scryfall tem 745 px de largura, e a carta 2,48 pol: 300 DPI.
DPI_SCRYFALL = 300
# O `image_status` da Scryfall que não tem imagem de verdade pra imprimir: a
# carta recém-anunciada ainda sem scan, e a que nunca teve.
STATUS_SEM_IMAGEM = ("missing", "placeholder")
STATUS_BAIXA_RESOLUCAO = "lowres"

_ESQUEMA = """
    CREATE TABLE IF NOT EXISTS artes_escolhidas (
        deck_id TEXT,
        nome TEXT,          -- achatado por `cartas.normalizar`
        face TEXT,          -- "frente" | "verso"
        copia INTEGER NOT NULL DEFAULT 0,   -- 0 = todas; n = a n-ésima
        arte_id TEXT,       -- o <id> do XML: o que vira papel (ver `arte_id`)
        arquivo TEXT,       -- o <name> do XML
        fonte TEXT,
        dpi INTEGER,
        baixa_resolucao INTEGER NOT NULL DEFAULT 0,
        escolhido_em REAL,
        PRIMARY KEY (deck_id, nome, face, copia)
    )
"""

_COLUNAS = ("deck_id, nome, face, copia, arte_id, arquivo, fonte, dpi, "
            "baixa_resolucao, escolhido_em")


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
        colunas = {l["name"] for l in
                   conn.execute("PRAGMA table_info(artes_escolhidas)")}
        if colunas and "copia" not in colunas:
            _migrar_pra_copias(conn)
        conn.execute(_ESQUEMA)
        # A consulta que roda toda vez que um deck abre.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_artes_deck "
                     "ON artes_escolhidas(deck_id)")
        conn.commit()
    finally:
        conn.close()


def _migrar_pra_copias(conn) -> None:
    """A tabela da época de uma arte por nome, refeita com `copia` na chave.

    Refeita, e não alterada: o SQLite não muda chave primária com `ALTER`. As
    escolhas que já existiam viram a arte de todas as cópias (`copia` 0), que
    é o que elas eram; `drive_id` vira `arte_id`, que é o mesmo id sem
    prefixo. Numa transação só: ou a tabela nova entra inteira, ou nada muda.
    """
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("ALTER TABLE artes_escolhidas RENAME TO artes_escolhidas_antiga")
    conn.execute("DROP INDEX IF EXISTS idx_artes_deck")
    conn.execute(_ESQUEMA)
    conn.execute(
        f"INSERT INTO artes_escolhidas ({_COLUNAS}) "
        "SELECT deck_id, nome, face, 0, drive_id, arquivo, fonte, dpi, 0, "
        "escolhido_em FROM artes_escolhidas_antiga")
    conn.execute("DROP TABLE artes_escolhidas_antiga")
    conn.commit()
    log.evento("artes", "tabela-migrada", nota="uma arte por cópia")


def _chave(nome: str) -> str:
    """O nome achatado, pela MESMA função que casa nomes no resto do projeto.

    Sem isto, "Lim-Dûl's Vault" e "Lim-Dul's Vault" viram duas linhas — e a
    escolha feita numa não aparece na outra.
    """
    return base_cartas.normalizar(nome)


def _linha(l) -> dict:
    return {"nome": l["nome"], "face": l["face"], "copia": l["copia"],
            "arte_id": l["arte_id"], "arquivo": l["arquivo"],
            "fonte": l["fonte"], "dpi": l["dpi"],
            "baixa_resolucao": bool(l["baixa_resolucao"]),
            "escolhido_em": l["escolhido_em"]}


def _validar(deck_id: str, nome: str, arte_id: str, face: str, copia,
             arquivo: str, fonte: str, dpi, baixa_resolucao) -> dict:
    """A escolha pronta pra gravar. Levanta `ValueError` com a razão em
    português."""
    chave = _chave(nome)
    if not deck_id or not chave:
        raise ValueError("Falta o deck ou o nome da carta.")
    if face not in FACES:
        raise ValueError(f"Face tem que ser uma de: {', '.join(FACES)}.")
    arte_id = str(arte_id or "").strip()
    if not arte_id:
        raise ValueError("Falta o id da arte.")
    origem = ids.origem(arte_id)
    if origem is None:
        raise ValueError("Esse id de arte não é de nenhuma origem conhecida.")
    if origem == ids.ENVIADA:
        # Import local: o `artes_enviadas` abre imagem com o Pillow, e guardar
        # escolha não precisa disso — só saber se o arquivo existe.
        from . import artes_enviadas
        if not artes_enviadas.existe(ids.sha_da_enviada(arte_id)):
            raise ValueError("Esse arquivo não foi enviado a este servidor.")
    try:
        copia = int(copia or 0)
    except (TypeError, ValueError):
        raise ValueError("Cópia inválida.")
    if not 0 <= copia <= decks.MAX_COPIAS:
        raise ValueError(f"Cópia tem que estar entre 0 e {decks.MAX_COPIAS}.")
    return {"nome": chave, "face": face, "copia": copia, "arte_id": arte_id,
            "arquivo": arquivo or "", "fonte": fonte or "",
            "dpi": int(dpi or 0), "baixa_resolucao": bool(baixa_resolucao)}


def _gravar(conn, deck_id: str, escolha: dict) -> None:
    conn.execute(
        f"INSERT OR REPLACE INTO artes_escolhidas ({_COLUNAS}) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (deck_id, escolha["nome"], escolha["face"], escolha["copia"],
         escolha["arte_id"], escolha["arquivo"], escolha["fonte"],
         escolha["dpi"], int(escolha["baixa_resolucao"]), time.time()))


def escolher(deck_id: str, nome: str, arte_id: str, face: str = "frente",
             copia: int = 0, arquivo: str = "", fonte: str = "", dpi: int = 0,
             baixa_resolucao: bool = False) -> dict:
    """Grava a escolha. Levanta `ValueError` com a razão em português."""
    escolha = _validar(deck_id, nome, arte_id, face, copia, arquivo, fonte,
                       dpi, baixa_resolucao)
    conn = _conn()
    try:
        _gravar(conn, deck_id, escolha)
        conn.commit()
    finally:
        conn.close()
    return escolha


def limpar(deck_id: str, nome: str, face: str = "frente", copia: int = 0) -> bool:
    """Volta um lado pro padrão — ou, com `copia`, pra arte de todas as
    cópias. Devolve False se não havia escolha."""
    conn = _conn()
    try:
        cur = conn.execute(
            "DELETE FROM artes_escolhidas "
            "WHERE deck_id=? AND nome=? AND face=? AND copia=?",
            (deck_id, _chave(nome), face, int(copia or 0)))
        conn.commit()
    finally:
        conn.close()
    return bool(cur.rowcount)


def limpar_copias(deck_id: str, nome: str) -> int:
    """Desfaz o "uma arte por cópia" de uma carta: sai a escolha de cada cópia,
    dos dois lados, e fica a arte de todas."""
    conn = _conn()
    try:
        cur = conn.execute(
            "DELETE FROM artes_escolhidas WHERE deck_id=? AND nome=? AND copia>0",
            (deck_id, _chave(nome)))
        conn.commit()
    finally:
        conn.close()
    return cur.rowcount


def do_deck(deck_id: str) -> dict[str, dict]:
    """As escolhas de um deck:
    `{nome_achatado: {frente: {...}, verso: {...}, copias: {"2": {frente: {...}}}}}`.

    Aninhado por face porque a tela pergunta "o que está escolhido pra esta
    carta" e quer as duas de uma vez — carta de duas faces tem escolha
    separada pra cada lado. `copias` só aparece em carta que tem escolha por
    cópia, com o número da cópia em texto, que é como ele chega no JSON.
    """
    conn = _conn()
    try:
        linhas = conn.execute(
            "SELECT * FROM artes_escolhidas WHERE deck_id=?", (deck_id,)).fetchall()
    finally:
        conn.close()
    saida: dict[str, dict] = {}
    for l in linhas:
        carta = saida.setdefault(l["nome"], {})
        if l["copia"]:
            carta.setdefault("copias", {}).setdefault(
                str(l["copia"]), {})[l["face"]] = _linha(l)
        else:
            carta[l["face"]] = _linha(l)
    return saida


def _da_copia(escolhidas: dict, face: str, copia: int) -> dict | None:
    """A arte de um lado de uma cópia: a dela, ou a de todas."""
    propria = ((escolhidas.get("copias") or {}).get(str(copia)) or {}).get(face)
    return propria or escolhidas.get(face)


def para_deck(deck: dict) -> dict:
    """As escolhas + quais cartas do deck ainda estão no padrão.

    `faltando` é a lista que a tela usa pra dizer "87 com a arte padrão, 12
    escolhidas por você". Conta por NOME: quem precisa saber lado a lado e
    cópia a cópia o que falta pra imprimir é o `pedido`.
    """
    escolhas = do_deck(deck["id"])
    nomes = list(deck.get("comandantes") or []) + \
        [c["nome"] for c in deck.get("cartas") or []]
    faltando = [n for n in nomes if _chave(n) not in escolhas]
    return {"escolhas": escolhas, "faltando": faltando,
            "escolhidas": len(escolhas), "total": len(nomes)}


def chave_da_ficha(ficha: dict) -> str:
    """O nome sob o qual a arte de uma ficha é guardada: "t:Wurm 1a2b3c4d".

    NOME NÃO IDENTIFICA FICHA. O Wurmcoil Engine cria duas "Wurm" 3/3
    incolores, uma com deathtouch e outra com lifelink, e no MPC Fill são
    arquivos diferentes — "Wurm (Deathtouch)" e "Wurm (Lifelink)". O id da
    Scryfall também não serve: é o da IMPRESSÃO, e duas cartas que criam
    Treasure citam impressões diferentes de uma ficha que no papel é uma só.

    O que identifica é o que está escrito nela — nome, tipo, texto, corpo e
    cores —, resumido num sufixo curto. O prefixo e o nome ficam legíveis
    de propósito: são o que se reconhece numa linha da tabela.
    """
    escrito = [ficha.get(k) or "" for k in
               ("nome", "tipo", "texto", "poder", "resistencia", "cores")]
    resumo = hashlib.sha256(json.dumps(escrito, ensure_ascii=False)
                            .encode("utf-8")).hexdigest()[:8]
    return f"{calc.PREFIXO_FICHA}{ficha.get('nome') or ''} {resumo}"


def fichas_do_deck(deck: dict) -> list[dict]:
    """As fichas que o deck cria, agrupadas por quem as cria, cada uma com a
    `chave_arte` dela.

    Quem cria é quem joga: os comandantes e as cartas das 100. O sideboard
    fica de fora (`decks.cartas_contadas`) porque ficha é o que se leva pra
    mesa junto com as 100, e o maybeboard porque carta que ainda não entrou
    no deck não gera ficha pra levar.
    """
    nomes = list(deck.get("comandantes") or []) + \
        [c["nome"] for c in decks.cartas_contadas(deck)]
    grupos = base_cartas.tokens_de(nomes)
    for grupo in grupos:
        for ficha in grupo["tokens"]:
            ficha["chave_arte"] = chave_da_ficha(ficha)
    return grupos


def _fichas_distintas(grupos: list[dict]) -> list[dict]:
    """Uma de cada, na ordem em que aparecem: a mesma ficha criada por duas
    cartas é uma ficha só no papel."""
    vistas: dict[str, dict] = {}
    for grupo in grupos:
        for ficha in grupo["tokens"]:
            vistas.setdefault(ficha["chave_arte"], ficha)
    return list(vistas.values())


def pedido(deck: dict) -> dict:
    """O deck como pedido de impressão: o XML no formato do MPC Fill, montado
    com as artes escolhidas.

    É a ponte entre o deckbuilder e a tela de orçamento. O pedido nasce de um
    XML do MPC Fill — é ele que o `calc` cobra e o `pdf_generator` imprime —,
    e montar aqui o MESMO formato deixa revisão da folha, cobrança, PDF e
    cotação funcionando sem saber de onde o pedido veio.

    SÓ SAI XML COM TODAS AS ARTES ESCOLHIDAS, cópia a cópia. A arte padrão da
    tela é a miniatura da base local, que não é um id que se imprime: carta
    sem escolha sairia como o retângulo de "FALHA NO DOWNLOAD". Faltando uma,
    `xml` volta `None` e `faltando` diz quais — `{nome, face}`, porque carta
    de duas faces pode ter a frente escolhida e o verso não.

    Entra o que vai pro papel, pelo critério da aba Artes: comandantes e as
    cartas do deck, sideboard incluído; o maybeboard não. Depois delas, as
    fichas que o deck cria (`fichas_do_deck`), UMA DE CADA: ficha é o que se
    leva pra mesa, e a mesma Treasure pedida por cinco cartas continua sendo
    uma ficha na caixa. Ficha sem arte escolhida também segura o XML — no
    `faltando` ela vem com `ficha: True`.

    O verso vai em `<backs>` com os MESMOS slots da frente, que é como o MPC
    Fill amarra o verso a cada cópia. Arquivos iguais da mesma carta dividem
    um `<card>` só, com todos os slots — as 30 Florestas são um arquivo em 30
    lugares da folha, ou três arquivos em dez lugares cada.
    """
    escolhas = do_deck(deck["id"])
    linhas = [(nome, 1) for nome in deck.get("comandantes") or []] + \
        [(c["nome"], c["quantidade"]) for c in deck.get("cartas") or []]
    conhecidas = base_cartas.por_nomes([nome for nome, _ in linhas])

    # O que vai pra folha: (chave da escolha, nome pro `faltando`, o <query>
    # de cada face, cópias, se é ficha). O <query> é o nome, que o `calc` usa
    # pro código do pedido e a cotação usa pra saber o que cotar; o verso leva
    # só o nome dele, como o MPC Fill escreve, e a ficha vai com o `t:`.
    impressos = []
    for nome, quantidade in linhas:
        carta = conhecidas.get(nome) or {}
        consultas = [nome]
        if carta.get("imagem_verso"):
            consultas.append((carta.get("nome") or nome).split(" // ")[-1].strip())
        impressos.append((nome, nome, consultas, quantidade, False))
    for ficha in _fichas_distintas(fichas_do_deck(deck)):
        lados = [ficha["nome"].split(" // ")[0].strip()]
        if ficha.get("imagem_verso"):
            lados.append(ficha["nome"].split(" // ")[-1].strip())
        impressos.append((ficha["chave_arte"], ficha["nome"],
                          [calc.PREFIXO_FICHA + lado for lado in lados], 1, True))

    # Agrupado por (arte, <query>), e não só pela arte: o mesmo arquivo
    # enviado pra duas cartas diferentes são dois <card>, cada um com o nome
    # da sua carta — é pelo <query> que a cotação sabe o que cotar.
    frentes: dict[tuple, dict] = {}
    versos: dict[tuple, dict] = {}
    faltando = []
    artes_total = 0
    proximo = 0
    for chave, rotulo, consultas, quantidade, e_ficha in impressos:
        faces = FACES[:len(consultas)]
        artes_total += len(faces)
        escolhidas = escolhas.get(_chave(chave), {})
        for face, consulta, destino in zip(faces, consultas, (frentes, versos)):
            faltou = False
            for n in range(quantidade):
                escolha = _da_copia(escolhidas, face, n + 1)
                if not escolha:
                    faltou = True
                    continue
                grupo = destino.setdefault((escolha["arte_id"], consulta), {
                    "arquivo": escolha["arquivo"], "slots": []})
                grupo["slots"].append(proximo + n)
            if faltou:
                faltando.append({"nome": rotulo, "face": face,
                                 **({"ficha": True} if e_ficha else {})})
        proximo += quantidade

    xml = None
    if proximo and not faltando:
        raiz = ET.Element("order")
        ET.SubElement(ET.SubElement(raiz, "details"), "quantity").text = str(proximo)
        for secao, grupos in (("fronts", frentes), ("backs", versos)):
            if not grupos:
                continue
            el = ET.SubElement(raiz, secao)
            for (arte_id, consulta), grupo in grupos.items():
                card = ET.SubElement(el, "card")
                ET.SubElement(card, "id").text = arte_id
                ET.SubElement(card, "slots").text = ",".join(map(str, grupo["slots"]))
                if grupo["arquivo"]:
                    ET.SubElement(card, "name").text = grupo["arquivo"]
                ET.SubElement(card, "query").text = consulta
        ET.indent(raiz, space="    ")
        xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               + ET.tostring(raiz, encoding="unicode") + "\n")
    return {"xml": xml, "faltando": faltando, "artes": artes_total,
            "cartas": proximo}


def aplicar_padrao(deck: dict) -> dict:
    """A imagem oficial da Scryfall em todo lado de carta que ainda não tem
    arte de todas as cópias escolhida — o "usar a arte padrão nas que faltam".

    A imagem é a MESMA que a tela já mostra como padrão: a da base local
    (`cartas.imagem`), cuja URL carrega o id da impressão. Sem ida à Scryfall
    aqui, então vale pro deck inteiro de uma vez, fichas incluídas.

    Devolve `{aplicadas, baixa_resolucao: [nomes], sem_imagem: [nomes]}`. Sem
    imagem é a carta que a base não conhece, ou cuja Scryfall ainda não tem
    scan (`STATUS_SEM_IMAGEM`): continua faltando, e a tela diz quais.
    """
    escolhas = do_deck(deck["id"])
    nomes = list(deck.get("comandantes") or []) + \
        [c["nome"] for c in deck.get("cartas") or []]
    conhecidas = base_cartas.por_nomes(nomes)

    # (chave da escolha, nome pra mostrar, {face: url}, image_status)
    alvos = []
    sem_imagem: list[str] = []
    for nome in nomes:
        carta = conhecidas.get(nome)
        if not carta:
            sem_imagem.append(nome)
            continue
        alvos.append((nome, carta.get("nome") or nome,
                      {"frente": carta.get("imagem"), "verso": carta.get("imagem_verso")},
                      carta.get("imagem_status") or ""))
    for ficha in _fichas_distintas(fichas_do_deck(deck)):
        alvos.append((ficha["chave_arte"], ficha["nome"],
                      {"frente": ficha.get("imagem"), "verso": ficha.get("imagem_verso")},
                      ficha.get("imagem_status") or ""))

    novas = []
    baixa: list[str] = []
    for chave, rotulo, urls, status in alvos:
        escolhidas = escolhas.get(_chave(chave), {})
        lados = ["frente"] + (["verso"] if urls["verso"] else [])
        for face in lados:
            if escolhidas.get(face):
                continue
            arte_id = ids.da_imagem_da_scryfall(urls[face])
            if not arte_id or status in STATUS_SEM_IMAGEM:
                if rotulo not in sem_imagem:
                    sem_imagem.append(rotulo)
                continue
            e_baixa = status == STATUS_BAIXA_RESOLUCAO
            nome_do_lado = rotulo.split(" // ")[FACES.index(face)].strip() \
                if " // " in rotulo else rotulo
            novas.append(_validar(
                deck["id"], chave, arte_id, face, 0, nome_do_lado, "Scryfall",
                0 if e_baixa else DPI_SCRYFALL, e_baixa))
            if e_baixa and rotulo not in baixa:
                baixa.append(rotulo)

    if novas:
        conn = _conn()
        try:
            for escolha in novas:
                _gravar(conn, deck["id"], escolha)
            conn.commit()
        finally:
            conn.close()
    return {"aplicadas": len(novas), "baixa_resolucao": baixa,
            "sem_imagem": sem_imagem}


def apagar_do_deck(deck_id: str) -> int:
    """Todas as escolhas de um deck. Chamado quando o deck é apagado — senão a
    tabela cresce pra sempre com linhas órfãs que ninguém consegue mais ver.

    Tolera a tabela não existir, pelo mesmo motivo do `usuarios.da_sessao`:
    isto é um efeito colateral de apagar deck, e um banco no meio da migração
    não pode fazer APAGAR UM DECK falhar. Sem tabela não há o que apagar.

    O arquivo enviado não sai do disco junto (ver `artes_enviadas`).
    """
    return _mexer("DELETE FROM artes_escolhidas WHERE deck_id=?", (deck_id,),
                  acao="apagar")


def copiar(de_deck: str, para_deck_id: str) -> int:
    """Leva as escolhas na duplicação de um deck.

    É claramente o que se quer: quem duplica um deck com arte escolhida quer a
    cópia igual — inclusive as artes, que foram o trabalho mais chato.
    """
    return _mexer(
        f"INSERT OR REPLACE INTO artes_escolhidas ({_COLUNAS}) "
        "SELECT ?, nome, face, copia, arte_id, arquivo, fonte, dpi, "
        "baixa_resolucao, escolhido_em "
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
    """Confere se as artes guardadas ainda existem onde o PDF vai buscá-las.

    O CAMINHO DE VOLTA de um id que envelheceu. Arquivo removido de lá vira,
    no PDF, o retângulo vermelho de "FALHA NO DOWNLOAD" — e descobrir isso
    depois de a pessoa ter pago é o pior resultado que este sistema sabe
    produzir. Aqui se pergunta antes.

    Cada origem se confere do seu jeito: o id do MPC Fill se pergunta à
    biblioteca deles, o arquivo enviado se procura no disco. A imagem da
    Scryfall não se confere — o id da impressão não some.

    Devolve `{"vivas": [...], "mortas": [{nome, arquivo, arte_id}]}`. As
    mortas trazem o nome do arquivo junto, que é o que permite dizer QUAL arte
    sumiu em vez de só um id de 33 caracteres.

    Import local de propósito: `artes` é sobre guardar escolha e funciona sem
    rede nenhuma; só esta função precisa do cliente HTTP, e um import no topo
    faria a tabela depender do MPC Fill estar de pé pra ser lida.
    """
    from . import artes_enviadas, mpcfill

    escolhas = do_deck(deck_id)
    porta = {}
    for nome, carta in escolhas.items():
        lados = [v for k, v in carta.items() if k in FACES]
        for copia in (carta.get("copias") or {}).values():
            lados += list(copia.values())
        for lado in lados:
            porta[lado["arte_id"]] = {"nome": nome, "arquivo": lado["arquivo"],
                                      "arte_id": lado["arte_id"]}
    if not porta:
        return {"vivas": [], "mortas": []}

    do_mpcfill = [i for i in porta if ids.origem(i) == ids.MPCFILL]
    conhecidos = set()
    # Em blocos, porque `metadados` tem teto por consulta.
    for i in range(0, len(do_mpcfill), mpcfill.MAX_IDS):
        conhecidos.update(mpcfill.metadados(do_mpcfill[i:i + mpcfill.MAX_IDS]))

    def viva(arte_id):
        origem = ids.origem(arte_id)
        if origem == ids.MPCFILL:
            return arte_id in conhecidos
        if origem == ids.ENVIADA:
            return artes_enviadas.existe(ids.sha_da_enviada(arte_id))
        return origem == ids.SCRYFALL

    vivas = [i for i in porta if viva(i)]
    mortas = [porta[i] for i in porta if not viva(i)]
    if mortas:
        log.aviso("artes", "ids-mortos", deck=deck_id, quantos=len(mortas))
    return {"vivas": vivas, "mortas": mortas}
