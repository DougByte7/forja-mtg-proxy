"""
Base local de cartas, montada a partir do *bulk data* da Scryfall.

POR QUE UMA CÓPIA LOCAL. O deckbuilder busca carta a cada tecla digitada, e
filtra por cor, tipo e custo o tempo todo. Fazer isso pela API da Scryfall
seria uma requisição por tecla num serviço que já nos corta por taxa na
cotação (ver `scryfall.py`: o 429 chega depois de ~20 requisições, com
`Retry-After: 60`). Uma tela de busca instantânea batendo lá fora não é
sustentável nem educado.

A Scryfall resolve isso oferecendo o banco inteiro num arquivo só — é o
caminho que ELES pedem pra quem precisa de busca própria. Baixamos uma vez
por dia e daí em diante toda busca é SQLite local, sem rede nenhuma.

O QUE ISTO NÃO É. Não é fonte de preço. O `preco_usd` guardado aqui é o do
dia da sincronização e serve só pra ordenar e dar ordem de grandeza na tela
("essa carta é cara?"). Quem responde "quanto custa comprar" continua sendo
a cotação (`cotacao.py`), que consulta LigaMagic e Scryfall na hora.

A tabela é DESCARTÁVEL: mora num banco separado do `orders.db` justamente
porque pode ser apagada e remontada a qualquer momento, e não deve engordar
o backup dos pedidos.

A sincronização escreve numa tabela nova e só troca a antiga por ela no fim,
numa transação. Sync que falhar no meio (rede caiu, disco encheu) deixa a
base anterior intacta — é melhor buscar em cartas de ontem do que em meia
base de hoje.
"""
import codecs
import itertools
import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
import zlib

import requests

from . import identidade as ident, log

DB_PATH = os.environ.get("CARTAS_DB_PATH", "/app/data/cartas.db")
BASE = "https://api.scryfall.com"
# Qual arquivo do bulk data. `oracle_cards` traz UMA entrada por carta
# distinta (~35 mil), que é exatamente o que um deckbuilder precisa —
# `default_cards` traz cada impressão de cada edição (~500 mil) e serviria só
# pra quem escolhe arte, que não é o caso aqui.
BULK = os.environ.get("CARTAS_BULK", "oracle_cards")
USER_AGENT = os.environ.get(
    "SCRYFALL_USER_AGENT", ident.user_agent("base de cartas"))
TIMEOUT = float(os.environ.get("CARTAS_TIMEOUT", "60"))
# De quanto em quanto tempo a base se atualiza sozinha. A Scryfall republica
# o bulk uma vez por dia, então não adianta pedir mais que isso.
SYNC_HORAS = float(os.environ.get("CARTAS_SYNC_HORAS", "24"))
# Quantas cartas por INSERT. Só afeta memória e velocidade da carga.
LOTE = int(os.environ.get("CARTAS_LOTE", "2000"))

# Layouts que não são carta de deck: ficha, emblema, carta de arte, etc.
# Entram no bulk e só fariam poluir a busca.
LAYOUTS_FORA = {
    "token", "double_faced_token", "emblem", "art_series", "vanguard",
    "scheme", "planar", "augment", "host",
}


class CartasError(Exception):
    """Falha ao baixar ou ler o bulk data da Scryfall."""


# ---------------------------------------------------------------------------
# Normalização de nome
#
# O mesmo problema que a cotação já enfrenta (ver o README, "O nome que o MPC
# Fill escreve não é o nome que a LigaMagic aceita"): ninguém digita
# "Nature's Lore" com apóstrofo na caixa de busca, e "Shang-Chi" com hífen.
# Guardamos uma versão achatada do nome ao lado do nome de verdade, e é ela
# que a busca compara — assim "natures lore" e "Nature's Lore" acham a mesma
# carta.
# ---------------------------------------------------------------------------

# Versão da normalização. O `busca` fica GRAVADO no banco, então mudar a
# `normalizar` sem mais nada deixa a coluna falando uma língua e a consulta
# outra — e o efeito não é erro, é carta que some da busca sem explicação até
# a próxima sincronização (foi assim que "Night's Whisper" sumiu uma vez).
#
# **Ao mexer na `normalizar`, suba este número.** A base se reconstrói sozinha
# na subida seguinte em vez de ficar meio dia inconsistente.
VERSAO_NORMALIZACAO = "2"

_SO_ALFANUM = re.compile(r"[^a-z0-9 ]+")
_ESPACOS = re.compile(r"\s+")
# Apóstrofo SOME, não vira espaço: "Nature's Lore" é procurado como "natures
# lore", nunca "nature s lore" — e é assim que o `<query>` do MPC Fill também
# escreve (ver o README). Hífen e vírgula, ao contrário, viram espaço:
# "Shang-Chi, Master of Kung Fu" -> "shang chi master of kung fu".
_APOSTROFOS = re.compile(r"['’ʼ]")
# Letras que o NFKD NÃO decompõe, porque não são letra-com-acento e sim letra
# própria. Sem esta tabela elas caem no filtro de alfanumérico e SOMEM:
# "Ærathi Berserker" viraria "rathi berserker" e ninguém acharia a carta
# procurando por "aerathi".
_LIGATURAS = str.maketrans({"æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe",
                            "ø": "o", "Ø": "o", "ß": "ss", "đ": "d"})


def normalizar(nome: str) -> str:
    """Nome achatado pra busca: sem acento, sem pontuação, sem caixa."""
    sem_acento = unicodedata.normalize("NFKD", (nome or "").translate(_LIGATURAS))
    sem_acento = "".join(c for c in sem_acento if not unicodedata.combining(c))
    achatado = _SO_ALFANUM.sub(" ", _APOSTROFOS.sub("", sem_acento.lower()))
    return _ESPACOS.sub(" ", achatado).strip()


def face_da_frente(nome: str) -> str:
    """"A // B" vira "A". Carta de duas faces é procurada pela frente."""
    return (nome or "").split("//")[0].strip()


# ---------------------------------------------------------------------------
# Banco
# ---------------------------------------------------------------------------

_ESQUEMA = """
CREATE TABLE IF NOT EXISTS {tabela} (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    busca TEXT NOT NULL,
    busca_frente TEXT NOT NULL,
    mana_cost TEXT,
    cmc REAL,
    tipo TEXT,
    texto TEXT,
    cores TEXT,
    identidade TEXT,
    legal INTEGER,
    comandante INTEGER,
    parceiro INTEGER,
    basico INTEGER,
    ilimitada INTEGER,
    preco_usd REAL,
    imagem TEXT,
    layout TEXT,
    scryfall TEXT
)
"""

_INDICES = [
    "CREATE INDEX IF NOT EXISTS ix_{tabela}_busca ON {tabela}(busca)",
    "CREATE INDEX IF NOT EXISTS ix_{tabela}_frente ON {tabela}(busca_frente)",
    "CREATE INDEX IF NOT EXISTS ix_{tabela}_comandante "
    "ON {tabela}(comandante, busca)",
]


def _conn() -> sqlite3.Connection:
    """Conexão nova a cada chamada — objeto de sqlite3 não atravessa thread,
    e aqui tem thread de sync rodando ao lado das buscas da tela."""
    pasta = os.path.dirname(DB_PATH)
    if pasta:
        os.makedirs(pasta, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    # WAL pra leitura não travar durante a carga: a sincronização escreve
    # dezenas de milhares de linhas e a tela continua buscando enquanto isso.
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = _conn()
    try:
        conn.execute(_ESQUEMA.format(tabela="cartas"))
        for sql in _INDICES:
            conn.execute(sql.format(tabela="cartas"))
        conn.execute("CREATE TABLE IF NOT EXISTS meta "
                     "(chave TEXT PRIMARY KEY, valor TEXT)")
        conn.commit()
    finally:
        conn.close()


def _meta(conn, chave: str) -> str | None:
    linha = conn.execute("SELECT valor FROM meta WHERE chave=?",
                         (chave,)).fetchone()
    return linha["valor"] if linha else None


# ---------------------------------------------------------------------------
# Leitura do bulk em streaming
#
# O arquivo passa de 100 MB. `json.load` do arquivo inteiro custaria mais de
# 1 GB de memória num container de homelab que também monta PDF — então ele é
# consumido conforme chega, um objeto por vez, com o buffer nunca passando de
# alguns KB.
#
# É `raw_decode` em vez de uma dependência nova (ijson) de propósito: são 20
# linhas, o formato é um array de objetos e nada aqui justifica mais um
# pacote pra manter.
# ---------------------------------------------------------------------------


def objetos_do_array(pedacos) -> "list":
    """Gera cada objeto de um array JSON que chega em pedaços de texto.

    `pedacos` é qualquer iterável de string. Levanta `CartasError` se o que
    chegou não for um array JSON, ou se o fluxo acabar no meio de um objeto
    (conexão cortada) — o silêncio aqui viraria uma base pela metade.
    """
    decoder = json.JSONDecoder()
    buffer = ""
    abriu = fechou = False

    for pedaco in pedacos:
        buffer += pedaco
        while True:
            buffer = buffer.lstrip()
            if not buffer:
                break
            if not abriu:
                if buffer[0] != "[":
                    raise CartasError(
                        "o bulk data não veio como array JSON — a Scryfall "
                        "mudou o formato, ou isso é uma página de erro")
                buffer, abriu = buffer[1:], True
                continue
            if buffer[0] == ",":
                buffer = buffer[1:]
                continue
            if buffer[0] == "]":
                fechou = True
                buffer = buffer[1:]
                break
            try:
                obj, fim = decoder.raw_decode(buffer)
            except ValueError:
                # Objeto ainda incompleto: espera o próximo pedaço. Se o
                # fluxo acabar aqui, o teste lá embaixo acusa.
                break
            buffer = buffer[fim:]
            yield obj
        if fechou:
            break

    if not fechou:
        raise CartasError("o bulk data acabou no meio — download incompleto")


def objetos_do_jsonl(pedacos) -> "list":
    """Gera cada objeto de um fluxo JSONL — um objeto JSON por linha.

    `pedacos` é qualquer iterável de string. Levanta `CartasError` se alguma
    linha não for JSON, ou se a última chegar cortada (conexão caiu): base
    pela metade é pior que base de ontem.
    """
    buffer = ""
    for pedaco in pedacos:
        buffer += pedaco
        while True:
            quebra = buffer.find("\n")
            if quebra < 0:
                break
            linha, buffer = buffer[:quebra].strip(), buffer[quebra + 1:]
            if not linha:
                continue
            try:
                obj = json.loads(linha)
            except ValueError:
                raise CartasError(
                    "o bulk data tem linha que não é JSON — a Scryfall mudou "
                    "o formato") from None
            yield obj

    resto = buffer.strip()
    if resto:
        # Arquivo sem quebra de linha no fim: a última carta mora aqui. Se ela
        # não fechar, o download foi cortado no meio.
        try:
            obj = json.loads(resto)
        except ValueError:
            raise CartasError(
                "o bulk data acabou no meio — download incompleto") from None
        yield obj


def objetos_do_bulk(pedacos) -> "list":
    """Gera cada carta do bulk, seja ele array JSON ou JSONL.

    A Scryfall serve hoje `jsonl_download_uri`, um objeto por linha; antes
    servia `download_uri`, um array JSON único. Os dois se distinguem pelo
    primeiro caractere que chega — `[` ou `{` —, então quem decide é o
    conteúdo, não o nome do campo de onde veio a URL.
    """
    pedacos = iter(pedacos)
    inicio: list = []
    for pedaco in pedacos:
        inicio.append(pedaco)
        espiada = "".join(inicio).lstrip()
        if not espiada:
            continue
        fluxo = itertools.chain(inicio, pedacos)
        if espiada[0] == "[":
            yield from objetos_do_array(fluxo)
            return
        if espiada[0] == "{":
            yield from objetos_do_jsonl(fluxo)
            return
        raise CartasError(
            "o bulk data não veio como JSON — a Scryfall mudou o formato, "
            "ou isso é uma página de erro")

    raise CartasError("o bulk data veio vazio")


def _imagem(carta: dict) -> str:
    """URL da arte pequena. Em carta de duas faces ela mora dentro da face."""
    urls = carta.get("image_uris") or {}
    if not urls:
        faces = carta.get("card_faces") or []
        if faces:
            urls = faces[0].get("image_uris") or {}
    return urls.get("normal") or urls.get("small") or ""


def _das_faces(carta: dict, campo: str, junta: str) -> str:
    """Campo que, em carta de duas faces, existe por face e não no topo."""
    valor = carta.get(campo)
    if valor:
        return valor
    faces = carta.get("card_faces") or []
    partes = [f.get(campo) or "" for f in faces]
    return junta.join(p for p in partes if p)


def _pode_ser_comandante(tipo_frente: str, texto: str) -> bool:
    """Regra do formato: criatura lendária, ou carta que diz que pode.

    O tipo olhado é o da FRENTE ("Legendary Creature — Elf // Legendary
    Land"), porque é a frente que vai pra zona de comando.
    """
    if "legendary" in tipo_frente and "creature" in tipo_frente:
        return True
    return "can be your commander" in texto


# Parceiro, Background e afins — o que permite DOIS comandantes. É heurística
# de texto, não uma lista curada: a Scryfall não marca isso num campo, e
# manter lista de carta na mão envelhece a cada lançamento. O custo de errar
# é baixo e visível (a tela deixa escolher um segundo comandante que talvez
# não devesse), não é preço nem impressão errada.
_PARCEIRO_RE = re.compile(
    r"\bpartner\b|choose a background|doctor's companion|friends forever",
    re.I)


def _linha(carta: dict) -> tuple | None:
    """Uma carta do bulk virando linha da tabela. `None` = não é carta de deck."""
    if carta.get("layout") in LAYOUTS_FORA:
        return None
    nome = (carta.get("name") or "").strip()
    if not nome:
        return None

    tipo = _das_faces(carta, "type_line", " // ")
    texto = _das_faces(carta, "oracle_text", "\n//\n")
    tipo_frente = face_da_frente(tipo).lower()
    texto_baixo = texto.lower()
    legalidades = carta.get("legalities") or {}
    precos = carta.get("prices") or {}
    try:
        preco = float(precos.get("usd") or precos.get("usd_foil") or 0) or None
    except (TypeError, ValueError):
        preco = None

    return (
        carta.get("oracle_id") or carta.get("id"),
        nome,
        normalizar(nome),
        normalizar(face_da_frente(nome)),
        _das_faces(carta, "mana_cost", " // "),
        float(carta.get("cmc") or 0),
        tipo,
        texto,
        "".join(carta.get("colors") or []),
        "".join(sorted(carta.get("color_identity") or [])),
        1 if legalidades.get("commander") in ("legal", "restricted") else 0,
        1 if _pode_ser_comandante(tipo_frente, texto_baixo) else 0,
        1 if _PARCEIRO_RE.search(texto) else 0,
        1 if ("basic" in tipo_frente and "land" in tipo_frente) else 0,
        # "A deck can have any number of cards named ..." — Rat Colony,
        # Dragon's Approach, Persistent Petitioners. Sem isto a validação
        # acusaria singleton quebrado num deck perfeitamente legal.
        1 if "any number of cards named" in texto_baixo else 0,
        preco,
        _imagem(carta),
        carta.get("layout") or "",
        carta.get("scryfall_uri") or "",
    )


_COLUNAS = ("id, nome, busca, busca_frente, mana_cost, cmc, tipo, texto, "
            "cores, identidade, legal, comandante, parceiro, basico, "
            "ilimitada, preco_usd, imagem, layout, scryfall")
_INTERROGACOES = ",".join("?" * len(_COLUNAS.split(",")))


# ---------------------------------------------------------------------------
# Sincronização
# ---------------------------------------------------------------------------

_trava = threading.Lock()
_andamento: dict = {"rodando": False, "lidas": 0, "erro": None, "quando": 0.0}


def andamento() -> dict:
    with _trava:
        return dict(_andamento)


def _sessao() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    return s


def _pedacos(resposta) -> "list":
    """Bytes da resposta virando texto, sem quebrar caractere no meio.

    Um chunk pode terminar no meio de um UTF-8 de vários bytes (acento, o "û"
    de Nazgûl) — decodificar chunk a chunk com `.decode()` quebraria ali. O
    decodificador incremental segura o pedaço órfão até o resto chegar.
    """
    decodificador = codecs.getincrementaldecoder("utf-8")()
    for bruto in _descomprimido(resposta):
        if bruto:
            yield decodificador.decode(bruto)
    yield decodificador.decode(b"", True)


def _descomprimido(resposta) -> "list":
    """Bytes da resposta, gunzipados se vierem gzipados.

    O JSONL da Scryfall vem `.gz` com `Content-Type: application/gzip` e sem
    `Content-Encoding`, então o requests entrega comprimido e a conta é nossa.
    Quem decide é o número mágico do gzip nos dois primeiros bytes — assim
    funciona igual se um dia servirem o arquivo cru, ou se algum proxy
    descomprimir no caminho.
    """
    descompressor = None
    primeiro = True
    for bruto in resposta.iter_content(chunk_size=256 * 1024):
        if not bruto:
            continue
        if primeiro:
            primeiro = False
            if bruto[:2] == b"\x1f\x8b":
                descompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
        yield descompressor.decompress(bruto) if descompressor else bruto
    if descompressor is not None:
        yield descompressor.flush()


def sincronizar() -> dict:
    """Baixa o bulk data e reconstrói a tabela de cartas.

    Devolve um resumo `{"cartas", "segundos", "atualizado_em"}`. Levanta
    `CartasError` se não der pra baixar ou ler — e nesse caso a base
    anterior continua no lugar, intocada.

    Só uma sincronização roda por vez: duas cargas simultâneas escreveriam na
    mesma tabela temporária.
    """
    with _trava:
        if _andamento["rodando"]:
            return {"ja_rodando": True, **_andamento}
        _andamento.update(rodando=True, lidas=0, erro=None, quando=time.time())

    inicio = time.time()
    try:
        resumo = _carregar()
        log.evento("cartas", "sincronizou", cartas=resumo["cartas"],
                   segundos=int(time.time() - inicio), origem=BULK)
        return resumo
    except Exception as e:
        motivo = f"{type(e).__name__}: {e}"
        log.erro("cartas", "sync-falhou", motivo=motivo,
                 nota="a base anterior continua valendo")
        with _trava:
            _andamento["erro"] = motivo
        raise CartasError(motivo) from e
    finally:
        with _trava:
            _andamento["rodando"] = False


def _carregar() -> dict:
    sessao = _sessao()
    catalogo = sessao.get(f"{BASE}/bulk-data/{BULK}", timeout=TIMEOUT)
    catalogo.raise_for_status()
    info = catalogo.json()
    # `jsonl_download_uri` é o campo de hoje (JSONL gzipado); `download_uri`
    # era o de antes (array JSON). Aceitamos os dois — `objetos_do_bulk` olha
    # o conteúdo pra saber qual formato chegou.
    url = info.get("jsonl_download_uri") or info.get("download_uri")
    if not url:
        raise CartasError(f"a Scryfall não deu URI de download pro bulk "
                          f"{BULK} — campos vindos: "
                          f"{', '.join(sorted(info)) or '(nenhum)'}")

    init_db()
    conn = _conn()
    try:
        conn.execute("DROP TABLE IF EXISTS cartas_novas")
        conn.execute(_ESQUEMA.format(tabela="cartas_novas"))

        lidas = 0
        lote: list[tuple] = []
        with sessao.get(url, timeout=TIMEOUT, stream=True) as resposta:
            resposta.raise_for_status()
            for carta in objetos_do_bulk(_pedacos(resposta)):
                linha = _linha(carta)
                if linha is None:
                    continue
                lote.append(linha)
                if len(lote) >= LOTE:
                    conn.executemany(
                        f"INSERT OR REPLACE INTO cartas_novas ({_COLUNAS}) "
                        f"VALUES ({_INTERROGACOES})", lote)
                    lidas += len(lote)
                    lote.clear()
                    with _trava:
                        _andamento["lidas"] = lidas
        if lote:
            conn.executemany(
                f"INSERT OR REPLACE INTO cartas_novas ({_COLUNAS}) "
                f"VALUES ({_INTERROGACOES})", lote)
            lidas += len(lote)

        if lidas < 1000:
            # Bulk legítimo tem dezenas de milhares de cartas. Menos que isso
            # é resposta truncada ou formato mudado, e trocar a base boa por
            # ela seria pior que não sincronizar.
            raise CartasError(f"o bulk trouxe só {lidas} cartas — não troco a "
                              f"base por isso")

        # A troca. Em transação: ou a base nova entra inteira, ou nada muda.
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DROP TABLE IF EXISTS cartas")
        conn.execute("ALTER TABLE cartas_novas RENAME TO cartas")
        for sql in _INDICES:
            conn.execute(sql.format(tabela="cartas"))
        agora = str(time.time())
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('atualizado_em', ?)",
                     (agora,))
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('origem', ?)",
                     (str(info.get("updated_at") or ""),))
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('cartas', ?)",
                     (str(lidas),))
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('normalizacao', ?)",
                     (VERSAO_NORMALIZACAO,))
        conn.commit()
        with _trava:
            _andamento["lidas"] = lidas
        return {"cartas": lidas, "atualizado_em": float(agora),
                "segundos": 0}
    finally:
        try:
            conn.execute("DROP TABLE IF EXISTS cartas_novas")
            conn.commit()
        except sqlite3.Error:
            pass
        conn.close()


def estado() -> dict:
    """Quantas cartas tem a base e quando ela foi montada.

    É o que a tela consulta ao abrir pra saber se pode buscar ou se precisa
    avisar "a base ainda está sendo montada".
    """
    try:
        conn = _conn()
    except sqlite3.Error as e:
        return {"cartas": 0, "atualizado_em": None, "erro": str(e),
                **andamento()}
    try:
        try:
            total = conn.execute("SELECT COUNT(*) n FROM cartas").fetchone()["n"]
            quando = _meta(conn, "atualizado_em")
        except sqlite3.OperationalError:
            total, quando = 0, None
        return {
            "cartas": total,
            "atualizado_em": float(quando) if quando else None,
            "idade_horas": round((time.time() - float(quando)) / 3600, 1)
                           if quando else None,
            "normalizacao": _meta(conn, "normalizacao"),
            **andamento(),
        }
    finally:
        conn.close()


def _precisa_sincronizar() -> bool:
    atual = estado()
    if not atual["cartas"]:
        return True
    # Base montada com outra normalização: a coluna `busca` fala uma língua e
    # a consulta fala outra. Não dá erro — dá carta que some da busca —, então
    # reconstrói na hora em vez de esperar o ciclo diário.
    if atual.get("normalizacao") != VERSAO_NORMALIZACAO:
        log.evento("cartas", "normalizacao-mudou",
                   base=atual.get("normalizacao"), codigo=VERSAO_NORMALIZACAO,
                   nota="a base vai ser remontada")
        return True
    idade = atual.get("idade_horas")
    return idade is None or idade >= SYNC_HORAS


def _loop():
    while True:
        try:
            if _precisa_sincronizar():
                sincronizar()
        except Exception:
            pass  # `sincronizar` já logou; aqui só não pode matar a thread
        time.sleep(max(600, SYNC_HORAS * 3600 / 4))


def start_background():
    """Mantém a base atualizada sozinha, começando por montá-la se estiver
    vazia — sem isso o deckbuilder nasce sem carta nenhuma e alguém teria que
    lembrar de rodar um comando depois de cada deploy novo."""
    if SYNC_HORAS <= 0:
        log.evento("cartas", "sync-desligado", nota="CARTAS_SYNC_HORAS=0")
        return
    threading.Thread(target=_loop, daemon=True).start()


# ---------------------------------------------------------------------------
# Consultas
# ---------------------------------------------------------------------------

CORES = ("W", "U", "B", "R", "G")


def _filtro_identidade(identidade: str | None, onde: list, params: list):
    """Só cartas que cabem na identidade de cor do comandante.

    A regra do formato é de SUBCONJUNTO: a identidade da carta tem que caber
    dentro da do comandante. SQLite não tem operação de conjunto, mas dá na
    mesma virar do avesso — em vez de "contém só o que é permitido", proíbe
    cada cor que ficou de fora. São no máximo 5 comparações.
    """
    if identidade is None:
        return
    permitidas = {c for c in (identidade or "").upper() if c in CORES}
    for cor in CORES:
        if cor not in permitidas:
            onde.append("identidade NOT LIKE ?")
            params.append(f"%{cor}%")


def buscar(termo: str = "", identidade: str | None = None, tipo: str = "",
           comandante: bool = False, so_legais: bool = True,
           limite: int = 40) -> list[dict]:
    """Busca por nome, com os filtros da tela.

    `identidade` é a do comandante já escolhido: passando `"WG"`, some da
    lista toda carta que o deck não poderia jogar. Passar `None` não filtra —
    é o estado de antes de escolher comandante.

    A ordenação põe primeiro quem casa o nome inteiro, depois quem começa com
    o termo, depois o resto: quem digita "sol ring" quer o Sol Ring na
    primeira linha, não o "Solemn Simulacrum".
    """
    alvo = normalizar(termo)
    onde, params = [], []

    if so_legais:
        onde.append("legal = 1")
    if comandante:
        onde.append("comandante = 1")
    if tipo:
        onde.append("LOWER(tipo) LIKE ?")
        params.append(f"%{tipo.strip().lower()}%")
    if alvo:
        onde.append("busca LIKE ?")
        params.append(f"%{alvo}%")
    _filtro_identidade(identidade, onde, params)

    sql = f"SELECT {_COLUNAS} FROM cartas"
    if onde:
        sql += " WHERE " + " AND ".join(onde)
    if alvo:
        sql += " ORDER BY (busca = ?) DESC, (busca LIKE ?) DESC, cmc, nome"
        params += [alvo, f"{alvo}%"]
    else:
        # Sem termo digitado a lista é só uma vitrine (o estado inicial da
        # busca): as mais baratas primeiro seria arbitrário, então vai por
        # nome, que ao menos é estável entre chamadas.
        sql += " ORDER BY nome"
    sql += " LIMIT ?"
    params.append(max(1, min(int(limite), 200)))

    conn = _conn()
    try:
        return [_dict(linha) for linha in conn.execute(sql, params)]
    except sqlite3.OperationalError:
        return []  # base ainda não montada
    finally:
        conn.close()


def terrenos(identidade: str) -> list[dict]:
    """Todos os terrenos NÃO básicos legais que cabem na identidade.

    Sem o teto de 200 da `buscar`: quem chama é a análise de mana base, que
    precisa olhar cada terreno da identidade pra decidir quais produzem as
    cores que o deck pede — e um deck de cinco cores enxerga a lista inteira.
    São algumas centenas de linhas; cabe numa consulta só.
    """
    onde = ["legal = 1", "basico = 0", "LOWER(tipo) LIKE '%land%'"]
    params: list = []
    _filtro_identidade(identidade or "", onde, params)
    conn = _conn()
    try:
        return [_dict(l) for l in conn.execute(
            f"SELECT {_COLUNAS} FROM cartas WHERE {' AND '.join(onde)} "
            f"ORDER BY nome", params)]
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


def por_nomes(nomes: list[str]) -> dict[str, dict]:
    """Resolve uma lista de nomes de carta de uma vez.

    Devolve `{nome_pedido: carta}` — o nome pedido volta como chave pra quem
    chamou saber qual não resolveu. Casa pelo nome achatado e, se não achar,
    pela face da frente ("Fire // Ice" achando "Fire"), que é o mesmo
    problema que a cotação já resolve carta a carta.

    É o que transforma um deck salvo (que guarda só nomes) nas cartas
    completas que a tela desenha.
    """
    if not nomes:
        return {}
    conn = _conn()
    try:
        achadas: dict[str, dict] = {}
        for nome in nomes:
            alvo = normalizar(nome)
            if not alvo:
                continue
            linha = conn.execute(
                f"SELECT {_COLUNAS} FROM cartas WHERE busca = ? "
                f"OR busca_frente = ? ORDER BY (busca = ?) DESC LIMIT 1",
                (alvo, alvo, alvo)).fetchone()
            if linha is None:
                linha = conn.execute(
                    f"SELECT {_COLUNAS} FROM cartas WHERE busca_frente = ? "
                    f"LIMIT 1", (normalizar(face_da_frente(nome)),)).fetchone()
            if linha is not None:
                achadas[nome] = _dict(linha)
        return achadas
    except sqlite3.OperationalError:
        return {}
    finally:
        conn.close()


def _dict(linha: sqlite3.Row) -> dict:
    """Uma linha do banco no formato que a tela consome."""
    carta = dict(linha)
    for campo in ("legal", "comandante", "parceiro", "basico", "ilimitada"):
        carta[campo] = bool(carta.get(campo))
    return carta
