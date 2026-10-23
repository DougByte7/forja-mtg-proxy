"""
Worker da impressora — roda no homelab, do lado do CUPS.

O site não fala com a impressora. Ele só grava o status `a_imprimir` (ver o
topo do `app/storage.py`), e este processo é quem pergunta, de tempos em
tempos, o que tem pra fazer. A conversa é SEMPRE daqui pra lá: o site não
sabe onde o worker mora, e o homelab não precisa de porta aberta nem túnel
pra que a impressão funcione.

A cada volta do laço:

1. **Imprimir.** Pra cada pedido (ou folha combinada) em `a_imprimir`:
   reserva (`a_imprimir -> imprimindo`, atômico do lado do site), monta o PDF
   se ainda não estiver no disco, manda pro `lp` e conta o resultado. Se a
   reserva voltar 409, outro já pegou ou o operador mudou de ideia — nada é
   impresso.
2. **Adiantar.** UM pedido em `notified` por volta: monta o PDF enquanto o
   operador confere o Pix, pra impressão sair na hora do clique. Um só por
   volta pra que um pedido grande montando não segure uma impressão que
   chegou depois.
3. **Painel.** O que alguém pediu no painel da rede local (`worker/painel.py`):
   montar ou refazer a folha de um pedido pra conferir antes de imprimir.
4. **Batida.** De `BATIDA_SEGUNDOS` em `BATIDA_SEGUNDOS`: tinta e filas do
   CUPS, que o site mostra no aviso público e no admin.
5. **Faxina.** Os PDFs velhos (`app/cleanup.py`), uma vez por dia.

Quem MONTA é sempre este laço, de uma linha só, de propósito: duas montagens
do mesmo PDF ao mesmo tempo escreviam no mesmo arquivo e saíam corrompidas.
O painel roda numa thread ao lado, mas só lê o disco e deixa pedidos numa
fila (`pedir_montagem`) — e acorda o laço pra ele não esperar a próxima volta.

Rodar:

    FORJA_API_URL=https://forja.exemplo.com WORKER_TOKEN=... python -m worker
"""
import os
import queue
import sys
import threading
import time

import requests

API = os.environ.get("FORJA_API_URL", "").rstrip("/")
TOKEN = os.environ.get("WORKER_TOKEN", "")
# A arte que o cliente enviou mora no site, não aqui. Precisa estar no
# ambiente ANTES de importar o `pdf_generator`, que lê isto no import.
if API:
    os.environ.setdefault("ARTES_ENVIADAS_URL", API)

from app import cleanup, log, pdf_generator, printer, tinta  # noqa: E402

# De quanto em quanto tempo perguntar a fila. É a demora máxima entre o
# clique em Imprimir e a impressora começar.
INTERVALO = float(os.environ.get("WORKER_INTERVALO_SEGUNDOS", "30"))
BATIDA_SEGUNDOS = float(os.environ.get("WORKER_BATIDA_SEGUNDOS", "300"))
TIMEOUT = float(os.environ.get("WORKER_TIMEOUT_SEGUNDOS", "30"))
# Pedido adiantado que saiu com falha (ou deu erro) não é remontado a cada
# volta: só depois disto. Na hora de imprimir ele é remontado de qualquer
# jeito, porque PDF com falha não conta como pronto.
READIANTAR_SEGUNDOS = float(os.environ.get("WORKER_READIANTAR_SEGUNDOS", "3600"))

_ROTA = {"pedido": "pedidos", "combo": "combos"}
TIPOS = tuple(_ROTA)

# Acorda o laço antes do fim da espera: o painel pediu uma montagem.
_acordar = threading.Event()
# O que o painel pediu pra montar: `(tipo, id, refazer)`.
_pedidos_do_painel: "queue.Queue[tuple[str, str, bool]]" = queue.Queue()
# Como vai cada montagem, pro painel mostrar. Só o laço escreve.
_trava = threading.Lock()
_montagens: dict[str, dict] = {}   # "tipo:id" -> {estado, feitas, total, ...}


class Api:
    """O site, visto daqui. Só sabe o endereço e o token."""

    def __init__(self, base: str, token: str):
        self.base = base
        self.sessao = requests.Session()
        self.sessao.headers["Authorization"] = f"Bearer {token}"
        self.sessao.headers["User-Agent"] = "forja-worker/1.0"

    def get(self, caminho: str) -> dict:
        r = self.sessao.get(self.base + caminho, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()

    def post(self, caminho: str, corpo: dict | None = None) -> requests.Response:
        return self.sessao.post(self.base + caminho, json=corpo or {},
                                timeout=TIMEOUT)


# --------------------------------------------------------------------------
# PDF no disco
# --------------------------------------------------------------------------


def _caminho(tipo: str, item_id: str) -> str:
    nome = f"pedido-{item_id}.pdf" if tipo == "pedido" else f"combo-{item_id}.pdf"
    return os.path.join(pdf_generator.OUTPUT_DIR, nome)


def _marcador(path: str) -> str:
    """Mesmo marcador do `fulfillment`: PDF que saiu com quadro de falha."""
    return path + ".incompleto"


def _pronto(tipo: str, item_id: str) -> bool:
    path = _caminho(tipo, item_id)
    return os.path.exists(path) and not os.path.exists(_marcador(path))


def falhas_no_disco(tipo: str, item_id: str) -> int:
    """Quantas cartas saíram como quadro de falha na folha que está no disco."""
    try:
        with open(_marcador(_caminho(tipo, item_id))) as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def _chave(tipo: str, item_id: str) -> str:
    return f"{tipo}:{item_id}"


def montagem(tipo: str, item_id: str) -> dict | None:
    """Como vai a montagem desta folha nesta rodada do worker, ou None."""
    with _trava:
        atual = _montagens.get(_chave(tipo, item_id))
        return dict(atual) if atual else None


def _anotar(tipo: str, item_id: str, **campos) -> None:
    with _trava:
        _montagens.setdefault(_chave(tipo, item_id), {}).update(campos)


def _dados(api: Api, tipo: str, item_id: str) -> dict:
    """O pedido (ou a combinação, com os pedidos dela), com XML."""
    return api.get(f"/worker/{_ROTA[tipo]}/{item_id}")


def _laminacao(tipo: str, dados: dict) -> str | None:
    """A laminação decide a grade da folha e o papel. Combinação só junta
    pedidos da mesma laminação, então o primeiro fala por todos."""
    if tipo == "pedido":
        return dados.get("lamination")
    pedidos = dados.get("pedidos") or []
    return pedidos[0].get("lamination") if pedidos else None


def montar(api: Api, tipo: str, item_id: str,
           dados: dict | None = None) -> tuple[str, int]:
    """Monta a folha a partir do que o site devolve. `(caminho, falhas)`."""
    _anotar(tipo, item_id, estado="montando", feitas=0, total=0,
            inicio=time.time(), detalhe=None)

    def andou(feitas: int, total: int):
        _anotar(tipo, item_id, feitas=feitas, total=total)

    try:
        dados = dados or _dados(api, tipo, item_id)
        if tipo == "pedido":
            path, falhas = pdf_generator.generate_pdf(
                dados["xml_text"], order_id=item_id, on_progress=andou,
                lamination=dados.get("lamination"))
        else:
            path, falhas, _mapa = pdf_generator.generate_combined_pdf(
                dados["pedidos"], combo_id=item_id, on_progress=andou)
    except Exception as e:
        _anotar(tipo, item_id, estado="erro", detalhe=f"{e}")
        raise
    marcador = _marcador(path)
    if falhas:
        with open(marcador, "w") as f:
            f.write(str(falhas))
    elif os.path.exists(marcador):
        os.remove(marcador)
    _anotar(tipo, item_id, estado="pronto", falhas=falhas, fim=time.time())
    return path, falhas


def pedir_montagem(tipo: str, item_id: str, refazer: bool = False) -> None:
    """O painel pediu esta folha. Quem monta é o laço — ver o topo."""
    if tipo not in TIPOS:
        raise ValueError(f"tipo desconhecido: {tipo!r}")
    _anotar(tipo, item_id, estado="na-fila", detalhe=None)
    _pedidos_do_painel.put((tipo, item_id, refazer))
    _acordar.set()


def atender_painel(api: Api) -> None:
    """Monta tudo o que o painel pediu até agora."""
    while True:
        try:
            tipo, item_id, refazer = _pedidos_do_painel.get_nowait()
        except queue.Empty:
            return
        if not refazer and _pronto(tipo, item_id):
            _anotar(tipo, item_id, estado="pronto",
                    falhas=0, fim=time.time())
            continue
        try:
            _path, falhas = montar(api, tipo, item_id)
            log.evento("worker", "montou-pelo-painel", tipo=tipo, id=item_id,
                       falhas=falhas, refez=refazer)
        except Exception as e:
            log.aviso("worker", "painel-nao-montou", tipo=tipo, id=item_id,
                      motivo=f"{type(e).__name__}: {e}")


def garantir(api: Api, tipo: str, item_id: str,
             dados: dict | None = None) -> tuple[str, int]:
    """O PDF pronto no disco, ou montado agora."""
    if _pronto(tipo, item_id):
        return _caminho(tipo, item_id), 0
    return montar(api, tipo, item_id, dados)


# --------------------------------------------------------------------------
# Impressão
# --------------------------------------------------------------------------

# Resultado que não chegou no site (rede caiu DEPOIS de o CUPS aceitar). Fica
# aqui e é reenviado a cada volta: perder isso deixaria o pedido parado em
# `imprimindo` pra sempre, e o operador sem saber que já saiu no papel.
_relatos_pendentes: list[tuple[str, dict]] = []


def _relatar(api: Api, caminho: str, corpo: dict) -> None:
    try:
        r = api.post(caminho, corpo)
        # 409 = o site já não está esperando isto (o operador mexeu no
        # pedido). Não adianta insistir.
        if r.status_code == 409 or r.status_code < 400:
            return
        r.raise_for_status()
    except requests.RequestException as e:
        log.aviso("worker", "relato-pendente", caminho=caminho,
                  motivo=f"{type(e).__name__}: {e}")
        _relatos_pendentes.append((caminho, corpo))


def _reenviar_relatos(api: Api) -> None:
    pendentes = _relatos_pendentes[:]
    _relatos_pendentes.clear()
    for caminho, corpo in pendentes:
        _relatar(api, caminho, corpo)


def imprimir(api: Api, tipo: str, item_id: str) -> None:
    rota = f"/worker/{_ROTA[tipo]}/{item_id}"
    r = api.post(rota + "/reservar")
    if r.status_code == 409:
        return  # outro pegou, ou saiu da fila — não imprime
    r.raise_for_status()
    log.evento("worker", "imprimindo", tipo=tipo, id=item_id)

    try:
        # Mesmo com o PDF já no disco, o pedido vem do site: é a laminação
        # dele que escolhe o papel na impressora.
        dados = _dados(api, tipo, item_id)
        path, falhas = garantir(api, tipo, item_id, dados)
        resposta = printer.print_pdf(path, _laminacao(tipo, dados))
    except Exception as e:
        # PrintError já traz a dica do `printer._hint`. Qualquer outra coisa
        # (Drive fora, pedido apagado no meio) também vira erro_impressao:
        # o operador precisa saber que o papel não vai sair.
        log.erro("worker", "nao-imprimiu", tipo=tipo, id=item_id,
                 motivo=f"{type(e).__name__}: {e}")
        _relatar(api, rota + "/falhar", {"mensagem": str(e)})
        return

    if not printer.PRINTER_QUEUE:
        resposta += (" Nada foi pra impressora: confira a folha e imprima "
                     "de onde preferir.")
    _relatar(api, rota + "/concluir", {"mensagem": resposta, "falhas": falhas})
    log.evento("worker", "impresso", tipo=tipo, id=item_id, falhas=falhas)


# --------------------------------------------------------------------------
# Adiantar
# --------------------------------------------------------------------------

_adiantados: dict[str, float] = {}   # chave -> quando tentou


def adiantar(api: Api, itens: list[dict]) -> None:
    """Monta UM PDF que ainda não está pronto. Ver o topo do módulo."""
    agora = time.time()
    for item in itens:
        chave = f"{item['tipo']}:{item['id']}"
        if _pronto(item["tipo"], item["id"]):
            continue
        if agora - _adiantados.get(chave, 0) < READIANTAR_SEGUNDOS:
            continue
        _adiantados[chave] = agora
        try:
            _path, falhas = montar(api, item["tipo"], item["id"])
            log.evento("worker", "adiantou", tipo=item["tipo"], id=item["id"],
                       falhas=falhas)
        except Exception as e:
            log.aviso("worker", "nao-adiantou", tipo=item["tipo"],
                      id=item["id"], motivo=f"{type(e).__name__}: {e}")
        return


# --------------------------------------------------------------------------
# Batida e faxina
# --------------------------------------------------------------------------


def batida(api: Api) -> None:
    """O estado da impressora, pro site mostrar. Nada aqui pode derrubar o
    laço: tinta é recado, não serviço (ver `tinta.py`)."""
    corpo = {}
    for chave, ler in (("tinta", tinta.estado),
                       ("tinta_diagnostico", tinta.diagnostico),
                       ("filas", printer.list_queues)):
        try:
            corpo[chave] = ler()
        except Exception as e:
            log.aviso("worker", "batida-incompleta", parte=chave,
                      motivo=f"{type(e).__name__}: {e}")
    r = api.post("/worker/batida", corpo)
    r.raise_for_status()


def faxina() -> None:
    try:
        r = cleanup.run_once()
        if r.get("removidos"):
            log.evento("worker", "faxina", removidos=r["removidos"],
                       liberado_mb=r["liberado_mb"])
    except Exception as e:
        log.aviso("worker", "faxina-falhou", motivo=f"{type(e).__name__}: {e}")


# --------------------------------------------------------------------------
# Laço
# --------------------------------------------------------------------------


def uma_volta(api: Api) -> None:
    _reenviar_relatos(api)
    fila = api.get("/worker/fila")
    for item in fila.get("imprimir", []):
        imprimir(api, item["tipo"], item["id"])
    atender_painel(api)
    adiantar(api, fila.get("adiantar", []))


# O painel da rede local (`worker/painel.py`). 0 desliga.
PAINEL_PORTA = int(os.environ.get("WORKER_PAINEL_PORTA", "8001"))


def _subir_painel() -> None:
    """O painel numa thread ao lado do laço. Ver `worker/painel.py`."""
    import uvicorn

    from .painel import criar_app

    # Uma `Api` própria: a `Session` do requests não é feita pra ser dividida
    # entre threads, e o painel pergunta a lista pro site enquanto o laço
    # trabalha.
    app = criar_app(Api(API, TOKEN))
    servidor = uvicorn.Server(uvicorn.Config(
        app, host="0.0.0.0", port=PAINEL_PORTA, log_level="warning"))
    threading.Thread(target=servidor.run, daemon=True).start()
    log.evento("worker", "painel", porta=PAINEL_PORTA)


def rodar() -> None:
    if not API or not TOKEN:
        print("ERRO: o worker precisa de FORJA_API_URL e WORKER_TOKEN no "
              "ambiente.", file=sys.stderr)
        sys.exit(1)
    api = Api(API, TOKEN)
    log.evento("worker", "subiu", api=API, fila=printer.PRINTER_QUEUE or None,
               intervalo=INTERVALO)
    if PAINEL_PORTA:
        _subir_painel()

    ultima_batida = 0.0
    ultima_faxina = 0.0
    while True:
        agora = time.monotonic()
        try:
            if agora - ultima_batida >= BATIDA_SEGUNDOS:
                ultima_batida = agora
                batida(api)
            uma_volta(api)
        except Exception as e:
            # Site fora do ar, rede caiu, resposta estranha: espera a próxima
            # volta. O worker nunca morre por causa do outro lado.
            log.aviso("worker", "volta-falhou", motivo=f"{type(e).__name__}: {e}")
        if cleanup.PDF_KEEP_DAYS > 0 and \
                agora - ultima_faxina >= cleanup.CLEANUP_INTERVAL_HOURS * 3600:
            ultima_faxina = agora
            faxina()
        # Espera a próxima volta, ou o painel pedir alguma coisa — o que vier
        # primeiro.
        _acordar.wait(INTERVALO)
        _acordar.clear()
