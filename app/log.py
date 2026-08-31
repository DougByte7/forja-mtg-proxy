"""
Log central do backend.

Existe porque até agora o backend falava por `print()`, e `print` some: não
tem hora, não tem nível, não dá pra separar canal, e no container ele se
mistura ao ruído do uvicorn. Quando 53 de 75 cartas voltaram sem preço, não
havia como saber SE foi rede, 429, layout ou nome errado — o motivo existia
dentro da exceção e era jogado fora.

Duas saídas, de propósito:

  * `stdout` — é o que aparece no `docker logs`, útil pra acompanhar ao vivo.
  * arquivo rotativo em `LOG_DIR` — é o que sobrevive ao restart do container
    e permite responder "o que aconteceu ontem à noite?".

E dois arquivos: `forja.log` com tudo e `visitas.log` só com as visitas. As
visitas são muitas e repetitivas; misturadas ao resto, afogariam o log de
erro justo quando ele importa.

O formato é `chave=valor`, não JSON. É pra ser lido com `grep` e `awk` num
terminal por uma pessoa — que é como este projeto é operado — e ainda assim
dá pra recortar campo com `grep -o 'carta=[^ ]*'`.
"""
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

DIR = os.environ.get("LOG_DIR", "/app/data/logs")
NIVEL = os.environ.get("LOG_NIVEL", "INFO").upper()
MAX_BYTES = int(float(os.environ.get("LOG_MAX_MB", "20")) * 1024 * 1024)
BACKUPS = int(os.environ.get("LOG_BACKUPS", "5"))

_FORMATO = logging.Formatter(
    "%(asctime)s %(levelname)-7s %(name)-16s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)


def _arquivo(nome: str) -> logging.Handler | None:
    """Handler de arquivo rotativo, ou None se o disco não deixar.

    Log que não grava NÃO pode derrubar o backend — um diretório sem
    permissão viraria erro na importação do módulo e o serviço não subiria.
    Nesse caso fica só o stdout, que é melhor que nada.
    """
    try:
        os.makedirs(DIR, exist_ok=True)
        h = RotatingFileHandler(os.path.join(DIR, nome), maxBytes=MAX_BYTES,
                                backupCount=BACKUPS, encoding="utf-8")
        h.setFormatter(_FORMATO)
        return h
    except OSError as e:
        print(f"[log] não consegui abrir {DIR}/{nome} ({e}); "
              f"fica só o stdout.", file=sys.stderr)
        return None


_raiz = logging.getLogger("forja")
if not _raiz.handlers:
    _raiz.setLevel(NIVEL)
    # `propagate=False` pra não duplicar em quem já configurou o root logger
    # (o uvicorn configura).
    _raiz.propagate = False

    _stdout = logging.StreamHandler(sys.stdout)
    _stdout.setFormatter(_FORMATO)
    _raiz.addHandler(_stdout)

    _geral = _arquivo("forja.log")
    if _geral:
        _raiz.addHandler(_geral)

    # As visitas seguem pro forja.log junto com o resto (dá contexto: dá pra
    # ver a cotação que veio logo depois da visita), mas ganham um arquivo só
    # delas pra contagem e análise sem ruído.
    _visitas = _arquivo("visitas.log")
    if _visitas:
        logging.getLogger("forja.visita").addHandler(_visitas)


def logger(canal: str) -> logging.Logger:
    return logging.getLogger(f"forja.{canal}")


def _valor(v) -> str:
    """Valor pronto pro formato chave=valor: aspas só quando precisa.

    Sem isso, um nome de carta com espaço ("sol ring") quebraria o corte por
    espaço de quem estiver lendo o log com awk.
    """
    if isinstance(v, float):
        texto = f"{v:.2f}"
    else:
        texto = str(v)
    texto = texto.replace("\n", " ").strip()
    if texto == "":
        texto = '""'
    elif any(c in texto for c in ' "='):
        texto = '"' + texto.replace('"', "'") + '"'
    return texto


def evento(canal: str, acao: str, nivel: int = logging.INFO, /, **campos):
    """Uma linha de log estruturada: `acao chave=valor chave=valor`.

    Campos com valor None somem, pra não poluir a linha com `erro=None` em
    todo caso de sucesso.

    A barra deixa `nivel` como posicional-only de propósito: sem ela, uma
    chamada com um CAMPO chamado `nivel` (`log.evento("app", "subiu",
    nivel="INFO")`) casaria com o parâmetro e explodiria com "level must be
    an integer" em vez de virar campo. Aconteceu.
    """
    partes = [acao] + [f"{k}={_valor(v)}" for k, v in campos.items()
                       if v is not None]
    logger(canal).log(nivel, " ".join(partes))


def aviso(canal: str, acao: str, **campos):
    evento(canal, acao, logging.WARNING, **campos)


def erro(canal: str, acao: str, **campos):
    evento(canal, acao, logging.ERROR, **campos)


def debug(canal: str, acao: str, **campos):
    evento(canal, acao, logging.DEBUG, **campos)
