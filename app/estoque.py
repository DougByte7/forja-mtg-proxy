"""
Estoque de material da impressão (papel e plástico) e o custo de uma folha.

Duas coisas moram aqui:

1. **Quanto material há.** Cada item tem um saldo, e todo movimento dele fica
   gravado em `estoque_movimentos` com o saldo que resultou — é essa lista
   que responde "pra onde foi o papel" quando a contagem não bate.

2. **Quanto custa uma folha.** Papel e plástico têm o preço por unidade da
   última compra; tinta não tem estoque, só um custo por página que o
   operador informa. A conta é sempre de UMA folha, nos dois acabamentos,
   pra ficar lado a lado com o preço que se cobra por página (`calc`).

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
import os
import sqlite3
import time

from . import calc

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")

ITENS = {
    "papel": {"nome": "Papel A4", "unidade": "folhas"},
    "plastico": {"nome": "Plástico de plastificação", "unidade": "folhas"},
}

# Status em que o pedido já conta como material gasto.
STATUS_COM_BAIXA = ("notified", "paid")

# Motivos de movimento. `combinado` é a folha que a impressão combinada
# deixou de gastar: cada pedido baixa as páginas dele, e a fila corrida usa
# menos que a soma.
MOTIVOS = ("pedido", "estorno", "combinado", "entrada", "contagem")

_CONFIG_PADRAO = {
    "tinta_por_pagina": 0.0,
    # Plástico gasto por folha em cada acabamento.
    "plastico_um_lado": 1.0,
    "plastico_dois_lados": 2.0,
}


def _conn():
    pasta = os.path.dirname(DB_PATH)
    if pasta:
        os.makedirs(pasta, exist_ok=True)
    return sqlite3.connect(DB_PATH, timeout=30)


def criar_tabelas(conn) -> None:
    """Cria as tabelas e semeia os itens. Chamado pelo `storage.init_db`, que
    é quem já roda antes de qualquer mudança de status."""
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
    for item in ITENS:
        conn.execute("INSERT OR IGNORE INTO estoque_itens (id, atualizado_em) "
                     "VALUES (?, ?)", (item, time.time()))
    for chave, valor in _CONFIG_PADRAO.items():
        conn.execute("INSERT OR IGNORE INTO estoque_config (chave, valor) "
                     "VALUES (?, ?)", (chave, valor))


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


def _plastico_por_folha(config: dict, lamination: str) -> float:
    return (config["plastico_dois_lados"] if lamination == "double"
            else config["plastico_um_lado"])


def _consumo(config: dict, pages, lamination: str) -> tuple[int, int]:
    """`(papel, plastico)` que `pages` folhas nesse acabamento gastam."""
    folhas = max(0, int(pages or 0))
    return folhas, round(folhas * _plastico_por_folha(config, lamination))


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


def devolver_combinacao(combo_id: str, pedidos: list[dict]) -> int:
    """Devolve as folhas que a impressão combinada deixou de gastar.

    Cada pedido do combo já baixou as próprias páginas; a fila corrida gasta
    `paginas_combinadas`, que é menos. Vale uma vez por combinação — imprimir
    a mesma folha de novo não devolve outra vez. Devolve quantas folhas
    voltaram.
    """
    resumo = calc.resumo_combinado(pedidos)
    folhas = resumo["folhas_economizadas"]
    if not folhas or not pedidos:
        return 0
    conn = _conn()
    try:
        ja = conn.execute("SELECT 1 FROM estoque_movimentos WHERE "
                          "motivo = 'combinado' AND referencia = ?",
                          (combo_id,)).fetchone()
        if ja:
            return 0
        papel, plastico = _consumo(_config(conn), folhas,
                                   pedidos[0].get("lamination"))
        _mover(conn, "papel", papel, "combinado", combo_id)
        _mover(conn, "plastico", plastico, "combinado", combo_id)
        conn.commit()
        return folhas
    finally:
        conn.close()


# --- Operações da tela --------------------------------------------------------


def _item_valido(item: str) -> None:
    if item not in ITENS:
        raise KeyError(item)


def _inteiro(valor, nome: str, minimo: int = 0) -> int:
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        raise ValueError(f"{nome} precisa ser um número.")
    if numero != int(numero) or numero < minimo:
        raise ValueError(f"{nome} precisa ser um número inteiro a partir de {minimo}.")
    return int(numero)


def _dinheiro(valor, nome: str) -> float:
    try:
        numero = float(str(valor).replace(",", "."))
    except (TypeError, ValueError):
        raise ValueError(f"{nome} precisa ser um valor em reais.")
    if numero < 0:
        raise ValueError(f"{nome} não pode ser negativo.")
    return numero


def entrada(item: str, quantidade, valor_pago=None) -> None:
    """Compra de material. Com `valor_pago`, o preço por unidade do item passa
    a ser o dessa compra."""
    _item_valido(item)
    qtd = _inteiro(quantidade, "A quantidade", minimo=1)
    conn = _conn()
    try:
        _mover(conn, item, qtd, "entrada")
        if valor_pago not in (None, ""):
            total = _dinheiro(valor_pago, "O valor pago")
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
    if minimo not in (None, ""):
        campos.append("minimo = ?")
        valores.append(_inteiro(minimo, "O mínimo"))
    if custo_unitario not in (None, ""):
        campos.append("custo_unitario = ?")
        valores.append(_dinheiro(custo_unitario, "O preço por unidade"))
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


def ajustar_custos(tinta_por_pagina=None, plastico_um_lado=None,
                   plastico_dois_lados=None) -> None:
    novos = {}
    if tinta_por_pagina not in (None, ""):
        novos["tinta_por_pagina"] = _dinheiro(tinta_por_pagina, "A tinta por página")
    for chave, valor in (("plastico_um_lado", plastico_um_lado),
                         ("plastico_dois_lados", plastico_dois_lados)):
        if valor not in (None, ""):
            novos[chave] = _inteiro(valor, "O plástico por folha")
    if not novos:
        return
    conn = _conn()
    try:
        conn.executemany("INSERT OR REPLACE INTO estoque_config (chave, valor) "
                         "VALUES (?, ?)", list(novos.items()))
        conn.commit()
    finally:
        conn.close()


def _custo_folha(itens: dict, config: dict, lamination: str,
                 cobrado: float) -> dict:
    papel = itens["papel"]["custo_unitario"]
    plastico = (itens["plastico"]["custo_unitario"]
                * _plastico_por_folha(config, lamination))
    tinta = config["tinta_por_pagina"]
    total = papel + plastico + tinta
    return {"papel": round(papel, 4), "plastico": round(plastico, 4),
            "tinta": round(tinta, 4), "total": round(total, 4),
            "cobrado": round(cobrado, 2), "margem": round(cobrado - total, 4)}


def resumo(movimentos: int = 30) -> dict:
    """Tudo que a aba Estoque mostra: saldo de cada item, o custo de uma
    folha nos dois acabamentos e os últimos movimentos."""
    conn = _conn()
    try:
        linhas = conn.execute("SELECT id, quantidade, minimo, custo_unitario, "
                              "atualizado_em FROM estoque_itens").fetchall()
        config = _config(conn)
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
    return {
        "itens": [itens[i] for i in ITENS if i in itens],
        "config": config,
        "custo_folha": {
            "single": _custo_folha(itens, config, "single", calc.PRICE_SINGLE_SIDE),
            "double": _custo_folha(itens, config, "double",
                                   calc.PRICE_DOUBLE_SIDE_PER_PAGE),
        },
        "movimentos": [dict(zip(("item", "delta", "saldo", "motivo",
                                 "referencia", "criado_em"), m)) for m in movs],
    }
