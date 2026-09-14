"""
Estoque de material da impressão (papel e plástico), o custo de uma folha e o
preço cobrado por página.

Três coisas moram aqui:

1. **Quanto material há.** Cada item tem um saldo, e todo movimento dele fica
   gravado em `estoque_movimentos` com o saldo que resultou — é essa lista
   que responde "pra onde foi o papel" quando a contagem não bate.

2. **Quanto custa uma folha.** Papel e plástico têm o preço por unidade da
   última compra. Tinta não tem estoque: cada cor tem o preço e o volume da
   garrafa e quantos ml uma folha gasta, e o custo da folha é a soma das
   quatro. A conta é sempre de UMA folha, nos dois acabamentos.

3. **Quanto se cobra por página.** É o preço que `calc.compute_cost` usa pra
   cobrar pedido novo. Pedido que já existe guarda o valor com que foi criado.

A baixa é automática e segue o status do pedido: entrou em `notified` ou
`paid`, o material da folha sai do estoque; voltou pra `pending` ou foi
cancelado, volta. `estoque_baixas` guarda quanto cada pedido levou, e é ela
que torna isso idempotente — o mesmo pedido passando por `notified` e depois
por `paid` não baixa duas vezes, e o estorno devolve exatamente o que saiu,
mesmo que o consumo por folha tenha mudado no meio.

Quem chama `sincronizar` é o `storage`, com a própria conexão, dentro da
mesma transação que mudou o status: pedido pago sem baixa (ou baixa sem
pedido pago) seria justamente o descompasso que este módulo existe pra evitar.
"""
import math
import os
import sqlite3
import time

from . import calc

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")

ITENS = {
    "papel": {"nome": "Papel fotográfico A4", "unidade": "folhas"},
    "plastico": {"nome": "Plástico de plastificação", "unidade": "unidades"},
}

# As garrafas da EPSON L4260 (tinta 504), na ordem em que a tela mostra.
#
# `ml_por_folha` é uma estimativa pra uma folha de cartas — 9 × 63×88 mm,
# ~500 cm² de arte — em alta qualidade no papel fotográfico brilhante:
# ~0,0018 ml/cm², a ordem de grandeza do rendimento em foto das EcoTank, com
# folga pela moldura preta das cartas. Nesse papel o driver não usa o preto
# pigmentado da 504 (ele não fixa na superfície brilhante): o preto sai de
# ciano + magenta + amarelo, e a garrafa preta quase não desce. O operador
# corrige esses números na tela quando tiver o consumo real.
TINTAS = {
    "preto": {"nome": "Preto", "ml_garrafa": 127.0, "ml_por_folha": 0.02},
    "amarelo": {"nome": "Amarelo", "ml_garrafa": 70.0, "ml_por_folha": 0.26},
    "magenta": {"nome": "Magenta", "ml_garrafa": 70.0, "ml_por_folha": 0.30},
    "ciano": {"nome": "Ciano", "ml_garrafa": 70.0, "ml_por_folha": 0.32},
}

# Status em que o pedido já conta como material gasto.
STATUS_COM_BAIXA = ("notified", "paid")

# Motivos de movimento. `combinado` é o material que a impressão combinada
# deixou de gastar: cada pedido baixa o dele, e a fila corrida usa menos que
# a soma.
MOTIVOS = ("pedido", "estorno", "combinado", "entrada", "contagem")

_CONFIG_PADRAO = {
    "preco_um_lado": calc.PRICE_SINGLE_SIDE,
    "preco_dois_lados": calc.PRICE_DOUBLE_SIDE_PER_PAGE,
    # Quantas folhas um plástico cobre: no um lado, duas; no dois lados, uma.
    "folhas_por_plastico_um_lado": 2.0,
    "folhas_por_plastico_dois_lados": 1.0,
}


def _conn():
    pasta = os.path.dirname(DB_PATH)
    if pasta:
        os.makedirs(pasta, exist_ok=True)
    return sqlite3.connect(DB_PATH, timeout=30)


def criar_tabelas(conn) -> None:
    """Cria as tabelas e semeia itens, tintas e configuração. Chamado pelo
    `storage.init_db`, que é quem já roda antes de qualquer mudança de status."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS estoque_itens (
            id TEXT PRIMARY KEY,
            quantidade INTEGER NOT NULL DEFAULT 0,
            minimo INTEGER NOT NULL DEFAULT 0,
            custo_unitario REAL NOT NULL DEFAULT 0,
            atualizado_em REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS estoque_movimentos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item TEXT NOT NULL,
            delta INTEGER NOT NULL,
            saldo INTEGER NOT NULL,
            motivo TEXT NOT NULL,
            referencia TEXT,
            criado_em REAL NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_estoque_mov_ref "
                 "ON estoque_movimentos(motivo, referencia)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS estoque_baixas (
            pedido TEXT PRIMARY KEY,
            papel INTEGER NOT NULL,
            plastico INTEGER NOT NULL,
            criado_em REAL NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS estoque_config (
            chave TEXT PRIMARY KEY,
            valor REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS estoque_tintas (
            cor TEXT PRIMARY KEY,
            preco_garrafa REAL NOT NULL DEFAULT 0,
            ml_garrafa REAL NOT NULL,
            ml_por_folha REAL NOT NULL
        )
    """)
    for item in ITENS:
        conn.execute("INSERT OR IGNORE INTO estoque_itens (id, atualizado_em) "
                     "VALUES (?, ?)", (item, time.time()))
    for chave, valor in _CONFIG_PADRAO.items():
        conn.execute("INSERT OR IGNORE INTO estoque_config (chave, valor) "
                     "VALUES (?, ?)", (chave, valor))
    for cor, tinta in TINTAS.items():
        conn.execute("INSERT OR IGNORE INTO estoque_tintas "
                     "(cor, ml_garrafa, ml_por_folha) VALUES (?, ?, ?)",
                     (cor, tinta["ml_garrafa"], tinta["ml_por_folha"]))


def _mover(conn, item: str, delta: int, motivo: str,
           referencia: str | None = None) -> None:
    if not delta:
        return
    agora = time.time()
    conn.execute("UPDATE estoque_itens SET quantidade = quantidade + ?, "
                 "atualizado_em = ? WHERE id = ?", (delta, agora, item))
    saldo = conn.execute("SELECT quantidade FROM estoque_itens WHERE id = ?",
                         (item,)).fetchone()[0]
    conn.execute("INSERT INTO estoque_movimentos "
                 "(item, delta, saldo, motivo, referencia, criado_em) "
                 "VALUES (?, ?, ?, ?, ?, ?)",
                 (item, delta, saldo, motivo, referencia, agora))


def _config(conn) -> dict:
    valores = dict(_CONFIG_PADRAO)
    valores.update(dict(conn.execute("SELECT chave, valor FROM estoque_config")))
    return valores


def _folhas_por_plastico(config: dict, lamination: str) -> float:
    return (config["folhas_por_plastico_dois_lados"] if lamination == "double"
            else config["folhas_por_plastico_um_lado"])


def _consumo(config: dict, pages, lamination: str) -> tuple[int, int]:
    """`(papel, plastico)` que `pages` folhas nesse acabamento gastam.

    O plástico arredonda pra cima: no um lado, 3 folhas levam 2 plásticos.
    """
    folhas = max(0, int(pages or 0))
    plastico = math.ceil(folhas / _folhas_por_plastico(config, lamination))
    return folhas, plastico


# --- Baixa automática -------------------------------------------------------


def sincronizar(conn, order_ids: list[str]) -> None:
    """Deixa a baixa de cada pedido de acordo com o status dele agora.

    Não faz commit: roda dentro da transação de quem mudou o status.
    """
    config = _config(conn)
    for order_id in dict.fromkeys(order_ids):
        pedido = conn.execute(
            "SELECT status, pages, lamination FROM orders WHERE id = ?",
            (order_id,)).fetchone()
        baixa = conn.execute(
            "SELECT papel, plastico FROM estoque_baixas WHERE pedido = ?",
            (order_id,)).fetchone()
        consome = bool(pedido) and pedido[0] in STATUS_COM_BAIXA

        if consome and not baixa:
            papel, plastico = _consumo(config, pedido[1], pedido[2])
            conn.execute("INSERT INTO estoque_baixas "
                         "(pedido, papel, plastico, criado_em) VALUES (?,?,?,?)",
                         (order_id, papel, plastico, time.time()))
            _mover(conn, "papel", -papel, "pedido", order_id)
            _mover(conn, "plastico", -plastico, "pedido", order_id)
        elif not consome and baixa:
            conn.execute("DELETE FROM estoque_baixas WHERE pedido = ?",
                         (order_id,))
            _mover(conn, "papel", baixa[0], "estorno", order_id)
            _mover(conn, "plastico", baixa[1], "estorno", order_id)


def ao_apagar(conn, order_id: str) -> None:
    """Pedido apagado: se ele não chegou a ser impresso, o material volta.

    Pedido `paid` foi pro papel, então a baixa fica — o material foi gasto
    mesmo que o registro do pedido suma.
    """
    pedido = conn.execute("SELECT status FROM orders WHERE id = ?",
                          (order_id,)).fetchone()
    if pedido and pedido[0] != "paid":
        conn.execute("UPDATE orders SET status = 'cancelado' WHERE id = ?",
                     (order_id,))
        sincronizar(conn, [order_id])


def devolver_combinacao(combo_id: str, pedidos: list[dict]) -> tuple[int, int]:
    """Devolve o material que a impressão combinada deixou de gastar.

    Cada pedido do combo já baixou o próprio consumo; a fila corrida gasta o
    consumo de `paginas_combinadas`, que é menor ou igual. A diferença volta,
    uma vez por combinação — imprimir a mesma folha de novo não devolve outra
    vez. Devolve `(papel, plastico)` que voltaram.
    """
    if not pedidos:
        return 0, 0
    resumo = calc.resumo_combinado(pedidos)
    ids = [p["id"] for p in pedidos]
    conn = _conn()
    try:
        ja = conn.execute("SELECT 1 FROM estoque_movimentos WHERE "
                          "motivo = 'combinado' AND referencia = ?",
                          (combo_id,)).fetchone()
        if ja:
            return 0, 0
        baixado = conn.execute(
            "SELECT COALESCE(SUM(papel), 0), COALESCE(SUM(plastico), 0) "
            f"FROM estoque_baixas WHERE pedido IN ({','.join('?' * len(ids))})",
            ids).fetchone()
        gasto = _consumo(_config(conn), resumo["paginas_combinadas"],
                         pedidos[0].get("lamination"))
        papel = max(0, baixado[0] - gasto[0])
        plastico = max(0, baixado[1] - gasto[1])
        _mover(conn, "papel", papel, "combinado", combo_id)
        _mover(conn, "plastico", plastico, "combinado", combo_id)
        conn.commit()
        return papel, plastico
    finally:
        conn.close()


# --- Preço cobrado ------------------------------------------------------------


def precos_por_pagina() -> dict:
    """`{"single", "double"}`: reais por página em cada acabamento.

    Banco sem as tabelas ainda (antes do `init_db`) cai no preço padrão do
    `calc`, em vez de impedir a cobrança.
    """
    try:
        conn = _conn()
        try:
            config = _config(conn)
        finally:
            conn.close()
    except sqlite3.OperationalError:
        config = dict(_CONFIG_PADRAO)
    return {"single": config["preco_um_lado"],
            "double": config["preco_dois_lados"]}


# --- Operações da tela --------------------------------------------------------


def _item_valido(item: str) -> None:
    if item not in ITENS:
        raise KeyError(item)


def _inteiro(valor, nome: str, minimo: int = 0) -> int:
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        raise ValueError(f"{nome} precisa ser um número.")
    if not math.isfinite(numero) or numero != int(numero) or numero < minimo:
        raise ValueError(f"{nome} precisa ser um número inteiro a partir de {minimo}.")
    return int(numero)


def _decimal(valor, nome: str, positivo: bool = False) -> float:
    """Número com vírgula ou ponto. `positivo` recusa o zero também."""
    try:
        numero = float(str(valor).replace(",", "."))
    except (TypeError, ValueError):
        raise ValueError(f"{nome} precisa ser um número.")
    if not math.isfinite(numero) or numero < 0 or (positivo and numero == 0):
        raise ValueError(f"{nome} precisa ser maior que zero." if positivo
                         else f"{nome} não pode ser negativo.")
    return numero


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == ""


def entrada(item: str, quantidade, valor_pago=None) -> None:
    """Compra de material. Com `valor_pago`, o preço por unidade do item passa
    a ser o dessa compra."""
    _item_valido(item)
    qtd = _inteiro(quantidade, "A quantidade", minimo=1)
    total = None if _vazio(valor_pago) else _decimal(valor_pago, "O valor pago")
    conn = _conn()
    try:
        _mover(conn, item, qtd, "entrada")
        if total is not None:
            conn.execute("UPDATE estoque_itens SET custo_unitario = ? "
                         "WHERE id = ?", (total / qtd, item))
        conn.commit()
    finally:
        conn.close()


def contagem(item: str, quantidade) -> None:
    """Define o saldo pelo que foi contado na prateleira."""
    _item_valido(item)
    qtd = _inteiro(quantidade, "A quantidade")
    conn = _conn()
    try:
        atual = conn.execute("SELECT quantidade FROM estoque_itens WHERE id = ?",
                             (item,)).fetchone()[0]
        _mover(conn, item, qtd - atual, "contagem")
        conn.commit()
    finally:
        conn.close()


def ajustar_item(item: str, minimo=None, custo_unitario=None) -> None:
    _item_valido(item)
    campos, valores = [], []
    if not _vazio(minimo):
        campos.append("minimo = ?")
        valores.append(_inteiro(minimo, "O mínimo"))
    if not _vazio(custo_unitario):
        campos.append("custo_unitario = ?")
        valores.append(_decimal(custo_unitario, "O preço por unidade"))
    if not campos:
        return
    conn = _conn()
    try:
        conn.execute(f"UPDATE estoque_itens SET {', '.join(campos)}, "
                     f"atualizado_em = ? WHERE id = ?",
                     valores + [time.time(), item])
        conn.commit()
    finally:
        conn.close()


def ajustar_custos(corpo: dict) -> None:
    """Preço cobrado por página e folhas por plástico, nos dois acabamentos.
    Chave ausente ou vazia fica como está."""
    novos = {}
    for chave, nome in (("preco_um_lado", "O preço de um lado"),
                        ("preco_dois_lados", "O preço de dois lados")):
        if not _vazio(corpo.get(chave)):
            novos[chave] = _decimal(corpo[chave], nome, positivo=True)
    for chave in ("folhas_por_plastico_um_lado", "folhas_por_plastico_dois_lados"):
        if not _vazio(corpo.get(chave)):
            novos[chave] = _inteiro(corpo[chave], "Folhas por plástico", minimo=1)
    if not novos:
        return
    conn = _conn()
    try:
        conn.executemany("INSERT OR REPLACE INTO estoque_config (chave, valor) "
                         "VALUES (?, ?)", list(novos.items()))
        conn.commit()
    finally:
        conn.close()


def ajustar_tintas(corpo: dict) -> None:
    """`{cor: {preco_garrafa, ml_garrafa, ml_por_folha}}`, cada campo opcional.

    Valida tudo antes de gravar: um campo errado não deixa metade salva.
    """
    mudancas = []
    for cor, tinta in TINTAS.items():
        dados = corpo.get(cor) or {}
        if not isinstance(dados, dict):
            raise ValueError(f"Os dados de {tinta['nome']} vieram num formato inválido.")
        for campo, nome, positivo in (
                ("preco_garrafa", f"O preço da garrafa {tinta['nome'].lower()}", False),
                ("ml_garrafa", f"O volume da garrafa {tinta['nome'].lower()}", True),
                ("ml_por_folha", f"O consumo de {tinta['nome'].lower()}", False)):
            if not _vazio(dados.get(campo)):
                mudancas.append((campo, _decimal(dados[campo], nome, positivo), cor))
    if not mudancas:
        return
    conn = _conn()
    try:
        for campo, valor, cor in mudancas:
            conn.execute(f"UPDATE estoque_tintas SET {campo} = ? WHERE cor = ?",
                         (valor, cor))
        conn.commit()
    finally:
        conn.close()


def _tintas(conn) -> list[dict]:
    linhas = {r[0]: r[1:] for r in conn.execute(
        "SELECT cor, preco_garrafa, ml_garrafa, ml_por_folha FROM estoque_tintas")}
    tintas = []
    for cor, padrao in TINTAS.items():
        preco, ml_garrafa, ml_folha = linhas.get(
            cor, (0.0, padrao["ml_garrafa"], padrao["ml_por_folha"]))
        custo = preco / ml_garrafa * ml_folha if ml_garrafa else 0.0
        tintas.append({"cor": cor, "nome": padrao["nome"],
                       "preco_garrafa": preco, "ml_garrafa": ml_garrafa,
                       "ml_por_folha": ml_folha, "custo_folha": round(custo, 4)})
    return tintas


def _custo_folha(itens: dict, config: dict, tinta: float,
                 lamination: str) -> dict:
    papel = itens["papel"]["custo_unitario"]
    plastico = (itens["plastico"]["custo_unitario"]
                / _folhas_por_plastico(config, lamination))
    total = papel + plastico + tinta
    cobrado = config["preco_dois_lados" if lamination == "double"
                     else "preco_um_lado"]
    return {"papel": round(papel, 4), "plastico": round(plastico, 4),
            "tinta": round(tinta, 4), "total": round(total, 4),
            "cobrado": round(cobrado, 4), "margem": round(cobrado - total, 4)}


def resumo(movimentos: int = 30) -> dict:
    """Tudo que a aba Estoque mostra: saldo de cada item, tintas, o custo de
    uma folha nos dois acabamentos e os últimos movimentos."""
    conn = _conn()
    try:
        linhas = conn.execute("SELECT id, quantidade, minimo, custo_unitario, "
                              "atualizado_em FROM estoque_itens").fetchall()
        config = _config(conn)
        tintas = _tintas(conn)
        movs = conn.execute(
            "SELECT item, delta, saldo, motivo, referencia, criado_em "
            "FROM estoque_movimentos ORDER BY id DESC LIMIT ?",
            (max(1, min(int(movimentos), 200)),)).fetchall()
    finally:
        conn.close()

    itens = {}
    for id_, quantidade, minimo, custo, atualizado in linhas:
        if id_ not in ITENS:
            continue
        itens[id_] = {"id": id_, **ITENS[id_], "quantidade": quantidade,
                      "minimo": minimo, "custo_unitario": custo,
                      "baixo": bool(minimo) and quantidade <= minimo,
                      "atualizado_em": atualizado}
    tinta = sum(t["custo_folha"] for t in tintas)
    return {
        "itens": [itens[i] for i in ITENS if i in itens],
        "config": config,
        "tintas": tintas,
        "custo_folha": {
            "single": _custo_folha(itens, config, tinta, "single"),
            "double": _custo_folha(itens, config, tinta, "double"),
        },
        "movimentos": [dict(zip(("item", "delta", "saldo", "motivo",
                                 "referencia", "criado_em"), m)) for m in movs],
    }
