"""
Guarda os pedidos em SQLite. O valor da cobrança NÃO é mexido — fica
exatamente o preço calculado. Pra diferenciar pedidos com o mesmo valor
(o que é comum aqui, já que o preço só depende do número de páginas),
cada pedido carrega o nome de quem pediu e um hash curto do deck
(calc.compute_deck_hash), que aparecem no e-mail de aviso de pagamento.

Ciclo de vida do `status`:
  pending  -> cobrança gerada, ninguém avisou nada ainda
  notified -> o cliente clicou em "Pagamento realizado, enviar notificação"
  paid     -> o Pix foi conferido e o link "Imprimir" do e-mail foi clicado
  cancelado-> o operador desistiu do pedido pela tela do admin (sai da lista
              de abertos, mas continua no histórico)
"""
import os
import sqlite3
import time
import uuid

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    return sqlite3.connect(DB_PATH)


def init_db():
    conn = _conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            xml_text TEXT,
            lamination TEXT,
            customer_name TEXT,
            deck_hash TEXT,
            qty INTEGER,
            backs_count INTEGER,
            pages INTEGER,
            blanks INTEGER,
            amount REAL,
            status TEXT,
            created_at REAL
        )
        """
    )
    # migração pra bancos criados antes do fluxo de aviso manual
    cols = {row[1] for row in conn.execute("PRAGMA table_info(orders)")}
    if "notified_at" not in cols:
        conn.execute("ALTER TABLE orders ADD COLUMN notified_at REAL")
    conn.commit()
    conn.close()


def create_order(xml_text: str, lamination: str, customer_name: str,
                  deck_hash: str, calc_result: dict):
    conn = _conn()
    order_id = uuid.uuid4().hex[:8]
    amount = calc_result["total"]
    conn.execute(
        """INSERT INTO orders
               (id, xml_text, lamination, customer_name, deck_hash, qty,
                backs_count, pages, blanks, amount, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            order_id,
            xml_text,
            lamination,
            customer_name,
            deck_hash,
            calc_result["qty"],
            calc_result["backs_count"],
            calc_result["pages"],
            calc_result["blanks"],
            amount,
            "pending",
            time.time(),
        ),
    )
    conn.commit()
    conn.close()
    return order_id, amount


def mark_paid(order_id: str):
    conn = _conn()
    conn.execute("UPDATE orders SET status='paid' WHERE id=?", (order_id,))
    conn.commit()
    conn.close()


def mark_notified(order_id: str):
    """O cliente avisou que pagou. Não mexe em pedido que já está pago."""
    conn = _conn()
    conn.execute(
        "UPDATE orders SET status='notified', notified_at=? WHERE id=? AND status!='paid'",
        (time.time(), order_id),
    )
    conn.commit()
    conn.close()


def get_order(order_id: str):
    conn = _conn()
    cur = conn.execute(
        """SELECT id,status,amount,qty,pages,blanks,lamination,customer_name,
                  deck_hash,notified_at
           FROM orders WHERE id=?""",
        (order_id,),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    keys = ["id", "status", "amount", "qty", "pages", "blanks", "lamination",
            "customer_name", "deck_hash", "notified_at"]
    return dict(zip(keys, row))


def get_order_with_xml(order_id: str):
    """Como get_order, mas inclui o xml_text (usado só na hora de gerar o PDF)."""
    conn = _conn()
    cur = conn.execute(
        """SELECT id,status,amount,qty,pages,blanks,lamination,customer_name,deck_hash,xml_text
           FROM orders WHERE id=?""",
        (order_id,),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    keys = ["id", "status", "amount", "qty", "pages", "blanks", "lamination",
            "customer_name", "deck_hash", "xml_text"]
    return dict(zip(keys, row))


def list_open():
    """Pedidos que ainda não foram impressos — inclui os que o cliente já
    avisou que pagou (status 'notified') e os que nem isso (status 'pending').

    Cancelado fica de fora: o operador já disse que aquele não vai acontecer,
    e ele continua visível no histórico da tela do admin."""
    conn = _conn()
    cur = conn.execute(
        """SELECT id, status, customer_name, deck_hash, amount, qty, pages,
                  lamination, created_at, notified_at
           FROM orders WHERE status NOT IN ('paid','cancelado')
           ORDER BY created_at ASC"""
    )
    rows = cur.fetchall()
    conn.close()
    keys = ["id", "status", "customer_name", "deck_hash", "amount", "qty",
            "pages", "lamination", "created_at", "notified_at"]
    return [dict(zip(keys, r)) for r in rows]


# Estados que um pedido pode ter. 'cancelado' entrou com a tela do admin: é o
# pedido que o cliente abandonou (ou que avisou pagamento e o Pix nunca caiu),
# e que não deve mais aparecer na lista de "abertos" nem sumir do histórico —
# apagar de vez é outra ação, explícita.
STATUS_VALIDOS = ("pending", "notified", "paid", "cancelado")

_CAMPOS_LISTA = ["id", "status", "customer_name", "deck_hash", "amount", "qty",
                 "pages", "blanks", "lamination", "created_at", "notified_at"]


def list_orders(status: str | None = None, busca: str | None = None,
                limite: int = 200):
    """Pedidos pra tela do admin, do mais novo pro mais antigo.

    Ao contrário do `list_open`, aqui entra tudo — inclusive o que já foi
    impresso e o que foi cancelado —, porque a tela também serve pra
    responder "o que rodou semana passada".

    `status` filtra por um estado; `busca` casa com id, nome de quem pediu ou
    código do deck (é o que se tem na mão quando alguém chama perguntando do
    pedido dele).
    """
    where, params = [], []
    if status in STATUS_VALIDOS:
        where.append("status=?")
        params.append(status)
    if busca and busca.strip():
        alvo = f"%{busca.strip().lower()}%"
        where.append("(LOWER(id) LIKE ? OR LOWER(customer_name) LIKE ? "
                     "OR LOWER(deck_hash) LIKE ?)")
        params += [alvo, alvo, alvo]
    sql = f"""SELECT {','.join(_CAMPOS_LISTA)} FROM orders
              {'WHERE ' + ' AND '.join(where) if where else ''}
              ORDER BY created_at DESC LIMIT ?"""
    params.append(max(1, min(int(limite), 500)))

    conn = _conn()
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(zip(_CAMPOS_LISTA, r)) for r in rows]


def count_by_status() -> dict:
    """Quantos pedidos em cada estado — os números do topo da tela do admin."""
    conn = _conn()
    rows = conn.execute("SELECT status, COUNT(*) FROM orders GROUP BY status")
    contagem = {s: 0 for s in STATUS_VALIDOS}
    for status, n in rows:
        contagem[status] = contagem.get(status, 0) + n
    conn.close()
    contagem["total"] = sum(contagem[s] for s in contagem if s != "total")
    return contagem


def set_status(order_id: str, status: str) -> bool:
    """Muda o estado de um pedido na mão. Devolve False se o id não existe.

    Voltar pra 'pending' limpa o `notified_at` de propósito: é o que se faz
    quando o aviso do cliente foi engano, e sem limpar isso o botão de avisar
    ficaria travado no cooldown do lado dele.
    """
    if status not in STATUS_VALIDOS:
        raise ValueError(f"status inválido: {status!r}")
    conn = _conn()
    if status == "pending":
        cur = conn.execute(
            "UPDATE orders SET status=?, notified_at=NULL WHERE id=?",
            (status, order_id))
    else:
        cur = conn.execute("UPDATE orders SET status=? WHERE id=?",
                           (status, order_id))
    conn.commit()
    mudou = cur.rowcount > 0
    conn.close()
    return mudou


def delete_order(order_id: str) -> bool:
    """Apaga o pedido do banco. Devolve False se o id não existe.

    O XML do deck vai junto — é o único lugar onde ele fica guardado. Por
    isso a tela pede confirmação e o caminho normal pra tirar um pedido da
    frente é cancelar, não apagar.
    """
    conn = _conn()
    cur = conn.execute("DELETE FROM orders WHERE id=?", (order_id,))
    conn.commit()
    apagou = cur.rowcount > 0
    conn.close()
    return apagou
