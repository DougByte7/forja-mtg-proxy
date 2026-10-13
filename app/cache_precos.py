"""
Cache das ofertas de UMA carta, compartilhado pelas fontes de preço.

Por carta, e não por deck, de propósito. O cache por deck que existia antes
só servia se a lista fosse idêntica: trocar UMA carta jogava fora o trabalho
das outras 98, e dois decks parecidos não aproveitavam nada um do outro.
Guardando por carta, quem cota um Commander e depois troca duas cartas paga
só as duas — e a segunda pessoa que cotar um deck com Sol Ring já acha o
Sol Ring pronto.

Isso importa mais aqui do que em cache normal: cada carta nova custa uma
requisição à LigaMagic, num site que pede pra gente não fazer isso (veja
`ligamagic.py`). Cada acerto de cache é um acesso a menos.

ONDE MORA. No banco de cartas (`CARTAS_DB_PATH` / `CARTAS_DB_URL`), e não em
arquivo: na Vercel o disco de cada processo some com ele, e o cache é também
o que guarda o andamento de uma cotação entre uma consulta e outra (ver
`cotacao_job.py`). O banco de cartas é o lugar certo por ser o DESCARTÁVEL —
apagar o cache inteiro custa só refazer consultas.

Nada aqui derruba a cotação: banco fora, linha corrompida, formato antigo,
tudo vira "não tem no cache" e a busca refaz.
"""
import json
import os
import re
import sqlite3
import time

from . import db, log
from .cotacao import Oferta

DB_PATH = os.environ.get("CARTAS_DB_PATH", "/app/data/cartas.db")
TTL = float(os.environ.get("COTACAO_CACHE_TTL", str(12 * 3600)))


def _conn():
    return db.cartas(DB_PATH)


def criar_tabela(conn=None) -> None:
    proprio = conn is None
    conn = conn or _conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cache_precos (
                fonte TEXT NOT NULL,
                chave TEXT NOT NULL,
                ofertas TEXT NOT NULL,
                em REAL NOT NULL,
                PRIMARY KEY (fonte, chave)
            )""")
        conn.commit()
    finally:
        if proprio:
            conn.close()


def _com_tabela(fazer):
    """Roda `fazer(conn)`, criando a tabela na primeira vez que faltar.

    Assim o cache funciona num banco recém-criado sem depender de ninguém ter
    rodado a migração antes — é cache, não pode ser motivo de erro.
    """
    conn = _conn()
    try:
        try:
            return fazer(conn)
        except sqlite3.OperationalError as e:
            if "no such table" not in str(e):
                raise
            criar_tabela(conn)
            return fazer(conn)
    finally:
        conn.close()


def chave(nome: str) -> str:
    """O nome achatado: "Sol Ring" e "sol  ring" são a mesma carta. Nome de
    Secret Lair passa de 100 letras, daí o corte."""
    limpo = re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-") or "sem-nome"
    return limpo[:120]


def _ofertas(cru: str) -> list[Oferta]:
    return [Oferta(**o) for o in json.loads(cru)]


def ler(fonte: str, nome: str) -> list[Oferta] | None:
    """As ofertas guardadas, ou None se não tem ou já venceu."""
    try:
        linha = _com_tabela(lambda conn: conn.execute(
            "SELECT ofertas, em FROM cache_precos WHERE fonte=? AND chave=?",
            (fonte, chave(nome))).fetchone())
        if not linha or time.time() - float(linha[1]) > TTL:
            return None
        return _ofertas(linha[0])
    except (sqlite3.Error, OSError, ValueError, TypeError):
        # Linha corrompida, ou gravada por uma versão antiga do formato:
        # trata como se não existisse. Cache nunca pode derrubar a cotação.
        return None


def ler_varios(fonte: str, nomes: list[str]) -> dict[str, list[Oferta]]:
    """`{nome: ofertas}` só das cartas que estão no cache e valendo, numa
    consulta só — é o que a cotação usa pra saber quanto já andou."""
    por_chave: dict[str, list[str]] = {}
    for nome in nomes:
        por_chave.setdefault(chave(nome), []).append(nome)
    if not por_chave:
        return {}
    chaves = list(por_chave)
    limite = time.time() - TTL
    try:
        linhas = []
        # Em lotes: o SQLite tem teto de parâmetros por consulta.
        for i in range(0, len(chaves), 500):
            lote = chaves[i:i + 500]
            linhas += _com_tabela(lambda conn: conn.execute(
                f"SELECT chave, ofertas FROM cache_precos WHERE fonte=? "
                f"AND em >= ? AND chave IN ({','.join('?' * len(lote))})",
                (fonte, limite, *lote)).fetchall())
    except (sqlite3.Error, OSError):
        return {}
    saida = {}
    for k, cru in linhas:
        try:
            ofertas = _ofertas(cru)
        except (ValueError, TypeError):
            continue
        for nome in por_chave.get(k, []):
            saida[nome] = ofertas
    return saida


def gravar(fonte: str, nome: str, ofertas: list[Oferta]):
    try:
        cru = json.dumps([o.__dict__ for o in ofertas], ensure_ascii=False)

        def fazer(conn):
            conn.execute(
                "INSERT INTO cache_precos (fonte, chave, ofertas, em) "
                "VALUES (?,?,?,?) ON CONFLICT(fonte, chave) DO UPDATE SET "
                "ofertas=excluded.ofertas, em=excluded.em",
                (fonte, chave(nome), cru, time.time()))
            conn.commit()
        _com_tabela(fazer)
    except (sqlite3.Error, OSError) as e:
        log.aviso("cache", "nao-gravei", fonte=fonte, carta=nome, motivo=str(e))


def podar() -> int:
    """Apaga o que já venceu. Chamado pela faxina diária."""
    def fazer(conn):
        cur = conn.execute("DELETE FROM cache_precos WHERE em < ?",
                           (time.time() - TTL,))
        conn.commit()
        return cur.rowcount
    try:
        return _com_tabela(fazer)
    except (sqlite3.Error, OSError) as e:
        log.aviso("cache", "nao-podei", motivo=str(e))
        return 0
