"""
O que o site fazia sozinho ao subir e em thread de fundo, como comando avulso.

No homelab o processo do site vive dias: dá pra criar as tabelas no `startup`
e deixar uma thread acordando de tempos em tempos pra sincronizar as cartas
e podar sessões. Na Vercel cada requisição pode cair num processo novo, que
morre logo depois de responder — migração no `startup` viraria meia dúzia de
idas ao banco em toda partida a frio, e thread de fundo simplesmente não
termina. Então as duas coisas viram comando:

    python -m app.tarefas migrar               # tabelas, colunas novas, admin inicial
    python -m app.tarefas cartas [--forcar]    # base de cartas, se estiver velha
    python -m app.tarefas faxina               # sessões vencidas

Quem roda `cartas` e `faxina` todo dia é o GitHub Actions
(`.github/workflows/tarefas.yml`); `migrar` roda a cada deploy que muda o
esquema. Os comandos falam com o mesmo banco que o site — o Turso, se
`DB_URL`/`CARTAS_DB_URL` estiverem no ambiente (ver `db.py`).

No homelab nada disto é obrigatório: `MIGRAR_NO_STARTUP` e
`TAREFAS_EM_SEGUNDO_PLANO` continuam ligados por padrão (ver `main.py`).
"""
import sys

from . import artes, cartas, decks, log, storage, usuarios


def migrar() -> None:
    """Cria o que falta. Pode rodar quantas vezes quiser: cada `init_db` só
    acrescenta tabela e coluna que não existem."""
    storage.init_db()
    decks.init_db()
    cartas.init_db()
    usuarios.init_db()
    artes.init_db()
    # Só faz alguma coisa se não existir conta nenhuma — ver `semear_admin`.
    usuarios.semear_admin()
    log.evento("tarefas", "migrou")


def sincronizar_cartas(forcar: bool = False) -> dict | None:
    """Remonta a base de cartas se ela estiver vazia, velha ou com outra
    normalização — a mesma regra da thread do homelab. `forcar` remonta de
    qualquer jeito."""
    if not forcar and not cartas._precisa_sincronizar():
        log.evento("tarefas", "cartas-em-dia", **{
            k: v for k, v in cartas.estado().items()
            if k in ("cartas", "idade_horas")})
        return None
    return cartas.sincronizar()


def faxina() -> int:
    """Sessões vencidas. Os PDFs ficam de fora: na Vercel o site não guarda
    PDF nenhum, e os do worker ele mesmo apaga."""
    return usuarios.podar_sessoes()


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("migrar", "cartas", "faxina"):
        print(__doc__.strip().split("\n\n")[2], file=sys.stderr)
        return 2
    comando = argv[0]
    try:
        if comando == "migrar":
            migrar()
        elif comando == "cartas":
            sincronizar_cartas(forcar="--forcar" in argv[1:])
        else:
            faxina()
    except Exception as e:
        log.erro("tarefas", "falhou", comando=comando,
                 motivo=f"{type(e).__name__}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
