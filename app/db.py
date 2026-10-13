"""
Onde o banco mora: um arquivo SQLite ao lado do processo, ou o Turso (libSQL)
pela rede. Quem chama não precisa saber qual dos dois.

POR QUE ESTE MÓDULO EXISTE. Os módulos de dados (`storage`, `decks`,
`usuarios`, `artes`, `estoque`, `cartas`) foram escritos em cima do `sqlite3`:
iteram o cursor, leem a linha por nome (`linha["id"]`), pegam
`sqlite3.IntegrityError`. O cliente do libSQL fala SQLite, mas não fala
`sqlite3`:

* o cursor não é iterável (`for linha in conn.execute(...)` estoura);
* não existe `row_factory`, então linha é só tupla;
* todo erro chega como `ValueError`, com o código do SQLite dentro do texto;
* a conexão recusa ser usada fora da thread que a abriu, e o FastAPI roda
  cada rota síncrona numa thread do pool.

Em vez de espalhar essas diferenças pelos seis módulos, a conexão remota é
embrulhada aqui pra se comportar como a do `sqlite3`. O SQL não muda: o Turso
é SQLite, com `ON CONFLICT`, `RETURNING`, `PRAGMA table_info` e transação
explícita (`BEGIN IMMEDIATE`) funcionando igual.

O que NÃO existe no remoto, e quem chama precisa saber (`remoto()`):
`PRAGMA journal_mode` — o servidor é quem decide como guarda o arquivo.

Variáveis de ambiente. Sem URL, tudo continua no arquivo de sempre — é o que
os testes e o homelab usam:

  DB_URL / DB_AUTH_TOKEN                 pedidos, decks, contas, artes, estoque
                                         (o que no disco é o `orders.db`)
  CARTAS_DB_URL / CARTAS_DB_AUTH_TOKEN   a base de cartas (o `cartas.db`)

A URL é a que o Turso mostra (`libsql://<banco>-<org>.turso.io`).
"""
import os
import sqlite3

PEDIDOS_URL = os.environ.get("DB_URL", "").strip()
PEDIDOS_TOKEN = os.environ.get("DB_AUTH_TOKEN", "").strip()
CARTAS_URL = os.environ.get("CARTAS_DB_URL", "").strip()
CARTAS_TOKEN = os.environ.get("CARTAS_DB_AUTH_TOKEN", "").strip()

# Valor de "não mexa" pro `isolation_level`, que aceita None (desligado) como
# valor de verdade.
_PADRAO = object()


class Linha:
    """O que o `sqlite3.Row` faz e o código daqui usa: índice por posição,
    por nome (sem diferenciar maiúscula, como o original), `keys()` e `dict()`.
    """

    __slots__ = ("_nomes", "_valores", "_indice")

    def __init__(self, nomes: tuple, indice: dict, valores: tuple):
        self._nomes, self._indice, self._valores = nomes, indice, valores

    def __getitem__(self, chave):
        if isinstance(chave, str):
            try:
                return self._valores[self._indice[chave.lower()]]
            except KeyError:
                raise IndexError(f"No item with that key: {chave}") from None
        return self._valores[chave]

    def keys(self):
        return list(self._nomes)

    def __iter__(self):
        return iter(self._valores)

    def __len__(self):
        return len(self._valores)

    def __eq__(self, outra):
        if isinstance(outra, Linha):
            return self._nomes == outra._nomes and self._valores == outra._valores
        return NotImplemented

    def __hash__(self):
        return hash((self._nomes, self._valores))

    def __repr__(self):
        return f"Linha({dict(zip(self._nomes, self._valores))!r})"


def _traduzir(erro: Exception) -> sqlite3.Error:
    """O `ValueError` do libSQL virando a exceção que o `sqlite3` levantaria.

    Só duas importam pro código daqui: violação de restrição (o cadastro
    pega `IntegrityError` pra dizer "esse login já existe") e o resto, que os
    módulos tratam como `OperationalError`/`Error`.
    """
    texto = str(erro)
    if "SQLITE_CONSTRAINT" in texto or "constraint failed" in texto:
        return sqlite3.IntegrityError(texto)
    return sqlite3.OperationalError(texto)


class _Cursor:
    def __init__(self, cursor, linhas: bool):
        self._cursor = cursor
        self._linhas = linhas
        self._nomes = None

    def _linha(self, valores):
        if valores is None or not self._linhas:
            return valores
        if self._nomes is None:
            self._nomes = tuple(d[0] for d in self._cursor.description or ())
            self._indice = {n.lower(): i for i, n in enumerate(self._nomes)}
        return Linha(self._nomes, self._indice, tuple(valores))

    def fetchone(self):
        return self._linha(self._cursor.fetchone())

    def fetchmany(self, tamanho=None):
        lote = (self._cursor.fetchmany() if tamanho is None
                else self._cursor.fetchmany(tamanho))
        return [self._linha(v) for v in lote]

    def fetchall(self):
        return [self._linha(v) for v in self._cursor.fetchall()]

    def __iter__(self):
        while True:
            linha = self.fetchone()
            if linha is None:
                return
            yield linha

    @property
    def rowcount(self):
        return self._cursor.rowcount

    @property
    def lastrowid(self):
        return self._cursor.lastrowid

    @property
    def description(self):
        return self._cursor.description

    def close(self):
        self._cursor.close()


class _Conexao:
    """A conexão do libSQL com a cara da do `sqlite3`. Ver o topo."""

    def __init__(self, conexao, linhas: bool):
        self._conexao = conexao
        self._linhas = linhas

    # `conn.row_factory = sqlite3.Row` continua valendo: liga as linhas por
    # nome, que é o único uso que o código daqui faz disso.
    @property
    def row_factory(self):
        return Linha if self._linhas else None

    @row_factory.setter
    def row_factory(self, fabrica):
        self._linhas = fabrica is not None

    def _rodar(self, metodo: str, *args):
        try:
            return _Cursor(getattr(self._conexao, metodo)(*args), self._linhas)
        except ValueError as e:
            raise _traduzir(e) from e

    def execute(self, sql: str, params=()):
        return self._rodar("execute", sql, tuple(params))

    def executemany(self, sql: str, sequencia):
        return self._rodar("executemany", sql, [tuple(p) for p in sequencia])

    def executescript(self, script: str):
        return self._rodar("executescript", script)

    def commit(self):
        try:
            self._conexao.commit()
        except ValueError as e:
            raise _traduzir(e) from e

    def rollback(self):
        try:
            self._conexao.rollback()
        except ValueError as e:
            raise _traduzir(e) from e

    def close(self):
        self._conexao.close()

    @property
    def in_transaction(self):
        return self._conexao.in_transaction

    # Mesma regra do `sqlite3`: o `with` confirma ou desfaz, mas não fecha.
    def __enter__(self):
        return self

    def __exit__(self, tipo, valor, rastro):
        if tipo is None:
            self.commit()
        else:
            self.rollback()
        return False


def conectar(caminho: str, url: str = "", token: str = "", *,
             linhas: bool = False, timeout: float = 30,
             isolation_level=_PADRAO):
    """Uma conexão nova: remota se houver `url`, senão o arquivo `caminho`.

    `linhas=True` é o `row_factory = sqlite3.Row` de antes. `isolation_level`
    vai pros dois lados igual (None = sem transação implícita).
    """
    extra = {} if isolation_level is _PADRAO else {"isolation_level": isolation_level}
    if url:
        # Import aqui dentro: quem roda só com arquivo (o worker, os testes)
        # não precisa ter o pacote instalado.
        import libsql
        try:
            conexao = libsql.connect(url, auth_token=token,
                                     _check_same_thread=False, **extra)
        except ValueError as e:
            raise _traduzir(e) from e
        return _Conexao(conexao, linhas)

    pasta = os.path.dirname(caminho)
    if pasta:
        os.makedirs(pasta, exist_ok=True)
    conexao = sqlite3.connect(caminho, timeout=timeout, **extra)
    if linhas:
        conexao.row_factory = sqlite3.Row
    return conexao


def pedidos(caminho: str, **kwargs):
    """O banco dos pedidos, decks, contas, artes e estoque."""
    return conectar(caminho, PEDIDOS_URL, PEDIDOS_TOKEN, **kwargs)


def cartas(caminho: str, **kwargs):
    """A base de cartas."""
    return conectar(caminho, CARTAS_URL, CARTAS_TOKEN, **kwargs)


def remoto(qual: str = "pedidos") -> bool:
    """Se aquele banco está no Turso. `qual`: "pedidos" ou "cartas"."""
    return bool(PEDIDOS_URL if qual == "pedidos" else CARTAS_URL)
