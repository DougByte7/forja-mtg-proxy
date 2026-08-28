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
    avisou que pagou (status 'notified') e os que nem isso (status 'pending')."""
    conn = _conn()
    cur = conn.execute(
        """SELECT id, status, customer_name, deck_hash, amount, qty, pages,
                  lamination, created_at, notified_at
           FROM orders WHERE status!='paid' ORDER BY created_at ASC"""
    )
    rows = cur.fetchall()
    conn.close()
    keys = ["id", "status", "customer_name", "deck_hash", "amount", "qty",
            "pages", "lamination", "created_at", "notified_at"]
    return [dict(zip(keys, r)) for r in rows]
