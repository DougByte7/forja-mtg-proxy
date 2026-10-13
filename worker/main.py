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
3. **Batida.** De `BATIDA_SEGUNDOS` em `BATIDA_SEGUNDOS`: tinta e filas do
   CUPS, que o site mostra no aviso público e no admin.
4. **Faxina.** Os PDFs velhos (`app/cleanup.py`), uma vez por dia.

É um processo de uma linha só, de propósito: duas montagens do mesmo PDF ao
mesmo tempo escreviam no mesmo arquivo (ver o comentário da trava em
`app/fulfillment.py`), e aqui não há como isso acontecer.

Rodar:

    FORJA_API_URL=https://forja.exemplo.com WORKER_TOKEN=... python -m worker
"""
import os
import sys
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


def montar(api: Api, tipo: str, item_id: str) -> tuple[str, int]:
    """Monta a folha a partir do que o site devolve. `(caminho, falhas)`."""
    if tipo == "pedido":
        pedido = api.get(f"/worker/pedidos/{item_id}")
        path, falhas = pdf_generator.generate_pdf(pedido["xml_text"],
                                                  order_id=item_id)
    else:
        combo = api.get(f"/worker/combos/{item_id}")
        path, falhas, _mapa = pdf_generator.generate_combined_pdf(
            combo["pedidos"], combo_id=item_id)
    marcador = _marcador(path)
    if falhas:
        with open(marcador, "w") as f:
            f.write(str(falhas))
    elif os.path.exists(marcador):
        os.remove(marcador)
    return path, falhas


def garantir(api: Api, tipo: str, item_id: str) -> tuple[str, int]:
    """O PDF pronto no disco, ou montado agora."""
    if _pronto(tipo, item_id):
        return _caminho(tipo, item_id), 0
    return montar(api, tipo, item_id)


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
        path, falhas = garantir(api, tipo, item_id)
        resposta = printer.print_pdf(path)
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
        r = cleanup.run_once(podar_sessoes=False)
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
    adiantar(api, fila.get("adiantar", []))


def rodar() -> None:
    if not API or not TOKEN:
        print("ERRO: o worker precisa de FORJA_API_URL e WORKER_TOKEN no "
              "ambiente.", file=sys.stderr)
        sys.exit(1)
    api = Api(API, TOKEN)
    log.evento("worker", "subiu", api=API, fila=printer.PRINTER_QUEUE or None,
               intervalo=INTERVALO)

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
        time.sleep(INTERVALO)
