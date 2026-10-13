"""
Guarda os pedidos em SQLite. O valor da cobrança NÃO é mexido — fica
exatamente o preço calculado. Pra diferenciar pedidos com o mesmo valor
(o que é comum aqui, já que o preço só depende do número de páginas),
cada pedido carrega o nome de quem pediu e um hash curto do deck
(calc.compute_deck_hash), que aparecem no e-mail de aviso de pagamento.

Ciclo de vida do `status`:
  pending        -> cobrança gerada, ninguém avisou nada ainda
  notified       -> o cliente clicou em "Pagamento realizado, enviar notificação"
  a_imprimir     -> o operador conferiu o Pix e mandou imprimir. Daqui em diante
                    o pedido conta como PAGO. Quem tira ele daqui é o worker
                    da impressora (ver `worker/`), que lê esta fila de tempos
                    em tempos
  imprimindo     -> o worker reservou o pedido e está mandando pro CUPS
  impresso       -> o CUPS aceitou o trabalho
  erro_impressao -> o CUPS (ou a montagem do PDF) recusou; `impressao_msg` diz
                    o porquê. "Imprimir de novo" volta pra `a_imprimir`
  cancelado      -> o operador desistiu do pedido pela tela do admin (sai da lista
                    de abertos, mas continua no histórico)

O status É a fila de impressão: o site não fala com a impressora, só grava
`a_imprimir`. Isso é o que deixa o site rodar longe do homelab sem saber que
ele existe — o worker é quem pergunta, nunca o contrário.

`a_imprimir -> imprimindo` é uma troca atômica (`reservar`): duas rodadas do
worker que leiam a mesma fila não imprimem o mesmo pedido duas vezes, porque
só uma delas consegue mudar a linha. Pedido que fica parado em `imprimindo`
(worker caiu no meio) NÃO volta pra fila sozinho: o CUPS pode já ter aceitado,
e papel não volta. Quem decide é o operador, pela tela.
"""
import hashlib
import json
import os
import sqlite3
import time
import uuid

from . import estoque

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")


_COLUNAS_ORDERS = (
    ("notified_at", "REAL"), ("dono", "TEXT"),
    ("impressao_em", "REAL"), ("impresso_em", "REAL"),
    ("impressao_msg", "TEXT"), ("impressao_falhas", "INTEGER"),
    ("impressao_combo", "TEXT"),
)
_COLUNAS_COMBOS = (
    ("status", "TEXT"), ("impressao_em", "REAL"), ("impresso_em", "REAL"),
    ("impressao_msg", "TEXT"), ("impressao_falhas", "INTEGER"),
)


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
    # Migrações. Cada coluna com o TIPO junto, porque elas divergem — e a
    # forma tipada é a mesma do `cartas.py`, que já tinha esse problema.
    #
    # `dono` nasce NULL em todo pedido que já existe, e é isso mesmo: todos
    # são órfãos até alguém logado reclamá-los ao abrir a home.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(orders)")}
    #
    # As colunas `impressao_*` são do worker: quando ele pegou o pedido, quando
    # o CUPS aceitou, o que respondeu e quantas cartas saíram como quadro de
    # falha. `impressao_combo` marca o pedido que está na fila DENTRO de uma
    # folha combinada — esse o worker não pega sozinho, só junto do combo.
    for coluna, tipo in _COLUNAS_ORDERS:
        if coluna not in cols:
            conn.execute(f"ALTER TABLE orders ADD COLUMN {coluna} {tipo}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_orders_dono ON orders(dono)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)")
    # `paid` era "conferi o Pix E mandei pra impressora", num clique só. Com a
    # fila, as duas coisas se separam, e o que um `paid` antigo quer dizer é
    # exatamente o último passo: foi pro papel.
    conn.execute("UPDATE orders SET status='impresso' WHERE status='paid'")
    # Combinações de pedidos numa folha só (ver `save_combo`).
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS combos (
            id TEXT PRIMARY KEY,
            order_ids TEXT,
            created_at REAL
        )
        """
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(combos)")}
    for coluna, tipo in _COLUNAS_COMBOS:
        if coluna not in cols:
            conn.execute(f"ALTER TABLE combos ADD COLUMN {coluna} {tipo}")
    # O que o worker contou na última vez que passou por aqui: a hora (é o
    # que diz se a impressora está "online"), a tinta e as filas do CUPS. Uma
    # linha por chave, sobrescrita a cada batida.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS worker_estado (
            chave TEXT PRIMARY KEY,
            valor TEXT,
            em REAL
        )
        """
    )
    estoque.criar_tabelas(conn)
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


def mark_notified(order_id: str):
    """O cliente avisou que pagou. Não mexe em pedido que já está pago (nem
    em cancelado: esse o operador já tirou da frente)."""
    conn = _conn()
    conn.execute(
        "UPDATE orders SET status='notified', notified_at=? "
        "WHERE id=? AND status IN ('pending','notified')",
        (time.time(), order_id),
    )
    estoque.sincronizar(conn, [order_id])
    conn.commit()
    conn.close()


def get_order(order_id: str):
    conn = _conn()
    cur = conn.execute(
        f"SELECT {','.join(_CAMPOS_LISTA)} FROM orders WHERE id=?",
        (order_id,),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return dict(zip(_CAMPOS_LISTA, row))


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
           FROM orders WHERE status NOT IN ('impresso','cancelado')
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
STATUS_VALIDOS = ("pending", "notified", "a_imprimir", "imprimindo",
                  "impresso", "erro_impressao", "cancelado")
# Os que querem dizer "o operador conferiu o Pix". Entrar na fila é o clique
# de confirmação, então a fila inteira conta como pago.
STATUS_PAGOS = ("a_imprimir", "imprimindo", "impresso", "erro_impressao")
# O que o admin pode escolher na mão (`set_status`). `a_imprimir` tem caminho
# próprio (`pedir_impressao`), e `imprimindo`/`erro_impressao` são do worker:
# escrever um deles na mão seria mentir sobre o que a impressora fez.
STATUS_MANUAIS = ("pending", "notified", "impresso", "cancelado")

# Esta lista monta o SELECT e o `zip` da resposta, então acrescentar aqui
# basta. `impressao_msg` pode trazer o erro cru do CUPS — quem devolve pedido
# pra fora do admin tira ela (ver `main._publico`).
_CAMPOS_LISTA = ["id", "status", "customer_name", "deck_hash", "amount", "qty",
                 "pages", "blanks", "lamination", "created_at", "notified_at",
                 "dono", "impressao_em", "impresso_em", "impressao_msg",
                 "impressao_falhas", "impressao_combo"]


def list_orders(status: str | None = None, busca: str | None = None,
                limite: int = 200):
    """Pedidos pra tela do admin, do mais novo pro mais antigo.

    Ao contrário do `list_open`, aqui entra tudo — inclusive o que já foi
    impresso e o que foi cancelado —, porque a tela também serve pra
    responder "o que rodou semana passada".

    `status` filtra por um estado (ou `fila`, que junta `a_imprimir` e
    `imprimindo`); `busca` casa com id, nome de quem pediu ou
    código do deck (é o que se tem na mão quando alguém chama perguntando do
    pedido dele).
    """
    where, params = [], []
    if status == "fila":
        # O filtro "na fila" da tela: o que está com o worker, esperando ou
        # já imprimindo.
        where.append("status IN ('a_imprimir','imprimindo')")
    elif status in STATUS_VALIDOS:
        where.append("status=?")
        params.append(status)
    if busca and busca.strip():
        alvo = f"%{busca.strip().lower()}%"
        where.append("(LOWER(id) LIKE ? OR LOWER(customer_name) LIKE ? "
                     "OR LOWER(deck_hash) LIKE ? OR LOWER(IFNULL(dono,'')) LIKE ?)")
        params += [alvo, alvo, alvo, alvo]
    sql = f"""SELECT {','.join(_CAMPOS_LISTA)} FROM orders
              {'WHERE ' + ' AND '.join(where) if where else ''}
              ORDER BY created_at DESC LIMIT ?"""
    params.append(max(1, min(int(limite), 500)))

    conn = _conn()
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(zip(_CAMPOS_LISTA, r)) for r in rows]


def reclamar(order_ids: list[str], dono: str) -> list[str]:
    """Põe dono nos pedidos que AINDA NÃO TÊM. Devolve os que mudaram.

    O `WHERE dono IS NULL` é a peça inteira: reclamar nunca tira pedido de
    ninguém. Quem chama manda a lista que o navegador guardou, e a lista pode
    conter pedido que já é de outra pessoa (dois irmãos, um computador só) —
    esse simplesmente não é tocado, e não vira erro.

    A prova de posse é ter o id, que é exatamente o nível em que este sistema
    já opera: `POST /orders/{id}/cancel` é aberta pelo mesmo motivo. E aqui a
    reclamação é rotulagem ADITIVA — ela não fecha `notify-payment` nem
    `cancel`, que seguem abertas pra quem tem o id.
    """
    ids = [str(i) for i in order_ids if i][:200]
    if not ids or not dono:
        return []
    marcas = ",".join("?" * len(ids))
    conn = _conn()
    achados = [r[0] for r in conn.execute(
        f"SELECT id FROM orders WHERE id IN ({marcas}) "
        f"AND (dono IS NULL OR dono='')", ids)]
    if achados:
        conn.execute(
            f"UPDATE orders SET dono=? WHERE id IN ({','.join('?' * len(achados))})",
            [dono] + achados)
        conn.commit()
    conn.close()
    return achados


def soltar_de(dono: str) -> int:
    """Devolve à orfandade os pedidos de alguém, quando a conta é apagada.
    Mesma razão do `decks.soltar_de`: o histórico da pessoa não é lixo."""
    conn = _conn()
    cur = conn.execute("UPDATE orders SET dono=NULL WHERE dono=?", (dono,))
    conn.commit()
    conn.close()
    return cur.rowcount


def list_by_dono(dono: str, limite: int = 200):
    """Os pedidos de uma pessoa, do mais novo pro mais antigo."""
    if not dono:
        return []
    conn = _conn()
    rows = conn.execute(
        f"SELECT {','.join(_CAMPOS_LISTA)} FROM orders WHERE dono=? "
        f"ORDER BY created_at DESC LIMIT ?",
        (dono, max(1, min(int(limite), 500)))).fetchall()
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

    `impresso` na mão é o "imprimi por fora" (pelo PDF, de outra impressora,
    ou com o worker desligado): confirma o Pix sem passar pela fila.

    Qualquer troca manual tira o pedido de uma folha combinada que estivesse
    na fila — o operador decidiu outra coisa pra ele.
    """
    if status not in STATUS_MANUAIS:
        raise ValueError(f"status inválido: {status!r}")
    conn = _conn()
    limpa_aviso = ", notified_at=NULL" if status == "pending" else ""
    marca_impresso = ", impresso_em=?" if status == "impresso" else ""
    params = [status] + ([time.time()] if marca_impresso else []) + [order_id]
    cur = conn.execute(
        f"UPDATE orders SET status=?, impressao_combo=NULL{limpa_aviso}"
        f"{marca_impresso} WHERE id=?", params)
    estoque.sincronizar(conn, [order_id])
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
    estoque.ao_apagar(conn, order_id)
    cur = conn.execute("DELETE FROM orders WHERE id=?", (order_id,))
    conn.commit()
    apagou = cur.rowcount > 0
    conn.close()
    return apagou


def get_orders_with_xml(order_ids: list[str]) -> list[dict]:
    """Vários pedidos de uma vez, com o XML, NA ORDEM em que foram pedidos.

    É o que a montagem do PDF combinado usa: a ordem da lista é a ordem em
    que as cartas entram na folha, então ela não pode ser a ordem que o
    SQLite achou melhor. Id que não existe mais some do resultado — quem
    chamou compara os tamanhos e decide o que fazer.
    """
    unicos = list(dict.fromkeys(order_ids))
    if not unicos:
        return []
    marcadores = ",".join("?" * len(unicos))
    conn = _conn()
    rows = conn.execute(
        f"""SELECT id,status,amount,qty,pages,blanks,lamination,customer_name,
                   deck_hash,xml_text
            FROM orders WHERE id IN ({marcadores})""",
        unicos,
    ).fetchall()
    conn.close()
    keys = ["id", "status", "amount", "qty", "pages", "blanks", "lamination",
            "customer_name", "deck_hash", "xml_text"]
    por_id = {r[0]: dict(zip(keys, r)) for r in rows}
    return [por_id[i] for i in unicos if i in por_id]


# --- Combinações de pedidos ------------------------------------------------
#
# Um "combo" é a lista ordenada de pedidos que vão numa folha só. O `status`
# dele só existe pra fila de impressão (é a folha que o worker imprime, não
# cada pedido); quem diz se cada cliente pagou continua sendo o pedido. O
# registro também serve pra dar um endereço fixo pro PDF
# combinado, pra que o link assinado de conferir a folha continue valendo
# depois de reiniciar o container — sem isso o operador perderia a folha que
# acabou de montar num deploy no meio do expediente.
#
# O id é derivado do CONJUNTO de pedidos (ver `combo_id`), então escolher os
# mesmos pedidos de novo cai no mesmo combo e reaproveita o PDF já montado.


def combo_id(order_ids: list[str]) -> str:
    """Id estável pra um conjunto de pedidos, sem depender da ordem da escolha.

    Ordenado antes do hash de propósito: marcar A e depois B tem que dar o
    mesmo combo que marcar B e depois A, senão a mesma folha seria montada
    duas vezes com dois nomes diferentes. A ordem de IMPRESSÃO é outra coisa,
    e fica guardada em `order_ids`.
    """
    bruto = "|".join(sorted(dict.fromkeys(order_ids)))
    return hashlib.sha256(bruto.encode()).hexdigest()[:12]


def save_combo(order_ids: list[str]) -> str:
    """Grava (ou reaproveita) a combinação e devolve o id dela.

    `order_ids` já vem na ordem de impressão. Regravar por cima é de
    propósito: o conjunto é o mesmo, e a ordem calculada também — o upsert
    só evita que duas abas do admin briguem pela linha.
    """
    cid = combo_id(order_ids)
    conn = _conn()
    # Upsert, e não `INSERT OR REPLACE`: o REPLACE apaga a linha e cria outra,
    # e com ela iria embora o estado da fila de uma folha que já foi pedida.
    conn.execute("INSERT INTO combos (id, order_ids, created_at) VALUES (?,?,?) "
                 "ON CONFLICT(id) DO UPDATE SET order_ids=excluded.order_ids",
                 (cid, ",".join(order_ids), time.time()))
    conn.commit()
    conn.close()
    return cid


_CAMPOS_COMBO = ["id", "order_ids", "created_at", "status", "impressao_em",
                 "impresso_em", "impressao_msg", "impressao_falhas"]


def _combo(row) -> dict:
    combo = dict(zip(_CAMPOS_COMBO, row))
    combo["order_ids"] = [i for i in (combo["order_ids"] or "").split(",") if i]
    return combo


def get_combo(cid: str):
    """O combo (`id`, `order_ids` na ordem de impressão, e o estado da fila)
    ou None."""
    conn = _conn()
    row = conn.execute(
        f"SELECT {','.join(_CAMPOS_COMBO)} FROM combos WHERE id=?",
        (cid,)).fetchone()
    conn.close()
    return _combo(row) if row else None


def delete_combo(cid: str) -> bool:
    """Esquece a combinação. Os pedidos dela não são tocados."""
    conn = _conn()
    cur = conn.execute("DELETE FROM combos WHERE id=?", (cid,))
    conn.commit()
    apagou = cur.rowcount > 0
    conn.close()
    return apagou


def list_combos(limite: int = 20) -> list[dict]:
    """As combinações mais recentes, da mais nova pra mais velha."""
    conn = _conn()
    rows = conn.execute(
        f"SELECT {','.join(_CAMPOS_COMBO)} FROM combos "
        "ORDER BY created_at DESC LIMIT ?",
        (max(1, min(int(limite), 200)),)).fetchall()
    conn.close()
    return [_combo(r) for r in rows]


# --- Fila de impressão -----------------------------------------------------
#
# Dois lados mexem aqui. O site só ENFILEIRA (`pedir_impressao*`). O worker
# da impressora, que roda no homelab e pergunta pela API, RESERVA o que vai
# imprimir e devolve o resultado (`reservar*`, `concluir*`, `falhar*`). Toda
# troca do worker é condicionada ao estado de antes (`WHERE status=...`): se a
# linha não estava onde ele achava, nada muda e ele fica sabendo pelo False.

_LIMPA_IMPRESSAO = ("impressao_em=NULL, impresso_em=NULL, impressao_msg=NULL, "
                    "impressao_falhas=NULL")


class FilaError(ValueError):
    """O pedido não pode entrar na fila no estado em que está."""


def pedir_impressao(order_id: str) -> bool:
    """Confirma o Pix e põe o pedido na fila. Devolve False se não existe.

    Vale também pra "imprimir de novo" (de `impresso` ou `erro_impressao`).
    Recusa o que está `imprimindo` — o worker está com ele agora, e outro
    clique no meio seria a segunda cópia — e o `cancelado`, que precisa ser
    reaberto antes.
    """
    conn = _conn()
    try:
        row = conn.execute("SELECT status FROM orders WHERE id=?",
                           (order_id,)).fetchone()
        if not row:
            return False
        if row[0] == "imprimindo":
            raise FilaError("Esse pedido está sendo impresso agora — espere o "
                            "resultado antes de pedir de novo.")
        if row[0] == "cancelado":
            raise FilaError("Pedido cancelado não vai pra impressora. Reabra "
                            "antes, se for o caso.")
        conn.execute(
            f"UPDATE orders SET status='a_imprimir', impressao_combo=NULL, "
            f"{_LIMPA_IMPRESSAO} WHERE id=?", (order_id,))
        estoque.sincronizar(conn, [order_id])
        conn.commit()
        return True
    finally:
        conn.close()


def pedir_impressao_combo(cid: str) -> list[str]:
    """Põe a folha combinada na fila: o combo e TODOS os pedidos dele, numa
    transação só. Devolve os ids dos pedidos.

    Ou o conjunto inteiro é confirmado, ou nenhum: as cartas de todos saem
    misturadas no mesmo papel. Os pedidos ganham `impressao_combo` pra o
    worker não pegar cada um sozinho — eles saem junto da folha.
    """
    conn = _conn()
    try:
        row = conn.execute(
            f"SELECT {','.join(_CAMPOS_COMBO)} FROM combos WHERE id=?",
            (cid,)).fetchone()
        if not row:
            raise FilaError("Combinação não encontrada.")
        combo = _combo(row)
        if combo["status"] == "imprimindo":
            raise FilaError("Essa folha está sendo impressa agora — espere o "
                            "resultado antes de pedir de novo.")
        ids = combo["order_ids"]
        marcas = ",".join("?" * len(ids))
        estados = dict(conn.execute(
            f"SELECT id, status FROM orders WHERE id IN ({marcas})", ids))
        faltando = [i for i in ids if i not in estados]
        if faltando:
            raise FilaError("Pedido apagado depois que a combinação foi "
                            f"montada: {', '.join(faltando)}.")
        if any(s == "cancelado" for s in estados.values()):
            raise FilaError("Pedido cancelado não entra em folha combinada.")
        if any(s == "imprimindo" for s in estados.values()):
            raise FilaError("Um dos pedidos está sendo impresso agora.")
        conn.execute(f"UPDATE combos SET status='a_imprimir', {_LIMPA_IMPRESSAO} "
                     "WHERE id=?", (cid,))
        conn.execute(
            f"UPDATE orders SET status='a_imprimir', impressao_combo=?, "
            f"{_LIMPA_IMPRESSAO} WHERE id IN ({marcas})", [cid] + ids)
        estoque.sincronizar(conn, ids)
        conn.commit()
        return ids
    finally:
        conn.close()


def fila_do_worker() -> dict:
    """O que o worker tem pra fazer, do mais antigo pro mais novo.

    `imprimir`: pedidos soltos e folhas combinadas em `a_imprimir`.
    `adiantar`: pedidos em `notified` — o cliente disse que pagou, e montar o
    PDF enquanto o operador confere o Pix é o que faz a impressão sair na hora
    do clique.
    """
    conn = _conn()
    try:
        soltos = conn.execute(
            "SELECT id FROM orders WHERE status='a_imprimir' "
            "AND impressao_combo IS NULL ORDER BY created_at").fetchall()
        combos = conn.execute(
            "SELECT id FROM combos WHERE status='a_imprimir' "
            "ORDER BY created_at").fetchall()
        avisados = conn.execute(
            "SELECT id FROM orders WHERE status='notified' "
            "ORDER BY notified_at").fetchall()
    finally:
        conn.close()
    return {
        "imprimir": [{"tipo": "pedido", "id": r[0]} for r in soltos]
                    + [{"tipo": "combo", "id": r[0]} for r in combos],
        "adiantar": [{"tipo": "pedido", "id": r[0]} for r in avisados],
    }


def _trocar(conn, tabela: str, chave: str, valor: str, de: str, para: str,
            extra: str = "", params: tuple = ()) -> int:
    cur = conn.execute(
        f"UPDATE {tabela} SET status=?{extra} WHERE {chave}=? AND status=?",
        (para, *params, valor, de))
    return cur.rowcount


def reservar(order_id: str) -> bool:
    """`a_imprimir -> imprimindo`, atômico. False = outro já pegou (ou o
    pedido saiu da fila, ou ele está dentro de um combo)."""
    conn = _conn()
    try:
        cur = conn.execute(
            "UPDATE orders SET status='imprimindo', impressao_em=? "
            "WHERE id=? AND status='a_imprimir' AND impressao_combo IS NULL",
            (time.time(), order_id))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def reservar_combo(cid: str) -> bool:
    """O mesmo, pra folha combinada: o combo e os pedidos dele."""
    conn = _conn()
    try:
        agora = time.time()
        if not _trocar(conn, "combos", "id", cid, "a_imprimir", "imprimindo",
                       ", impressao_em=?", (agora,)):
            return False
        _trocar(conn, "orders", "impressao_combo", cid, "a_imprimir",
                "imprimindo", ", impressao_em=?", (agora,))
        conn.commit()
        return True
    finally:
        conn.close()


def _resultado(tabela_chave: list[tuple[str, str, str]], para: str,
               mensagem: str, falhas: int | None) -> bool:
    """Grava o fim de uma impressão em cada `(tabela, coluna, valor)`. Só
    vale pra quem está em `imprimindo`. A primeira entrada é a que decide se
    houve mudança."""
    extra = ", impressao_msg=?, impressao_falhas=?"
    params: tuple = (mensagem, falhas)
    if para == "impresso":
        extra += ", impresso_em=?"
        params += (time.time(),)
    conn = _conn()
    try:
        mudou = 0
        for n, (tabela, chave, valor) in enumerate(tabela_chave):
            m = _trocar(conn, tabela, chave, valor, "imprimindo", para,
                        extra, params)
            if n == 0:
                mudou = m
                if not mudou:
                    return False
        conn.commit()
        return bool(mudou)
    finally:
        conn.close()


def concluir(order_id: str, mensagem: str, falhas: int = 0) -> bool:
    """O CUPS aceitou: `imprimindo -> impresso`."""
    return _resultado([("orders", "id", order_id)], "impresso", mensagem, falhas)


def falhar(order_id: str, mensagem: str) -> bool:
    """O CUPS (ou a montagem) recusou: `imprimindo -> erro_impressao`."""
    return _resultado([("orders", "id", order_id)], "erro_impressao",
                      mensagem, None)


def concluir_combo(cid: str, mensagem: str, falhas: int = 0) -> bool:
    return _resultado([("combos", "id", cid),
                       ("orders", "impressao_combo", cid)],
                      "impresso", mensagem, falhas)


def falhar_combo(cid: str, mensagem: str) -> bool:
    return _resultado([("combos", "id", cid),
                       ("orders", "impressao_combo", cid)],
                      "erro_impressao", mensagem, None)


# --- O que o worker contou -------------------------------------------------


def salvar_worker(chave: str, valor) -> None:
    conn = _conn()
    conn.execute("INSERT INTO worker_estado (chave, valor, em) VALUES (?,?,?) "
                 "ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, "
                 "em=excluded.em",
                 (chave, json.dumps(valor), time.time()))
    conn.commit()
    conn.close()


def ler_worker(chave: str) -> dict | None:
    """`{"valor": ..., "em": epoch}` ou None se o worker nunca contou."""
    conn = _conn()
    row = conn.execute("SELECT valor, em FROM worker_estado WHERE chave=?",
                       (chave,)).fetchone()
    conn.close()
    if not row:
        return None
    try:
        valor = json.loads(row[0])
    except (TypeError, ValueError):
        valor = None
    return {"valor": valor, "em": row[1]}
