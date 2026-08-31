"""
Fluxo de pagamento manual, sem depender do banco avisar nada.

O banco não notifica ninguém em tempo real e ler a caixa de entrada era
frágil demais, então quem avisa é o próprio cliente:

1. O cliente gera a cobrança, paga o Pix e clica em "Pagamento realizado,
   enviar notificação" -> `POST /orders/{id}/notify-payment`. Esse clique já
   dispara a montagem do PDF em segundo plano, pra folha estar pronta quando
   o operador for conferir.
2. O operador recebe um e-mail com o resumo do pedido e dois botões:
   **Ver PDF** (`GET /orders/{id}/pdf`) pra conferir a folha antes de gastar
   papel, e **Imprimir** (`GET /orders/{id}/print`) pra mandar pra fila.
3. O operador confere o Pix no app do banco, abre o PDF, e só então imprime.

O PDF não vai anexo no e-mail de propósito: pedido grande passa fácil do
limite de 25 MB do Gmail. O link serve o arquivo direto do backend e abre
inline no navegador (ou no visualizador do celular).

O clique do cliente NÃO imprime nada nem marca como pago — é só um aviso. A
decisão continua sendo humana, o que também resolve o problema de alguém
clicar no botão sem ter pago.

Os links do e-mail são assinados com HMAC da `ADMIN_TOKEN`, então eles são
auto contidos (não precisa guardar nada no banco) e não dá pra adivinhar o
link de um pedido só sabendo o id dele. Ver e imprimir usam tokens
diferentes: quem tem o link de conferir não consegue disparar a impressora.
"""
import hashlib
import hmac
import os
import threading
import time

from . import pdf_generator, printer, storage

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
# URL pública do backend, usada pra montar os links do e-mail.
# Ex: https://forja.exemplo.com  (sem barra no fim)
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
# Endereço do backend na rede local (ex.: http://192.168.3.47:8000). Vazio
# desliga o link extra de conferir a folha por dentro de casa.
LOCAL_BASE_URL = os.environ.get("LOCAL_BASE_URL", "").rstrip("/")


def _token(purpose: str, order_id: str) -> str:
    if not ADMIN_TOKEN:
        raise RuntimeError(
            "ADMIN_TOKEN não configurada no .env — sem ela não dá pra assinar "
            "os links do e-mail."
        )
    return hmac.new(
        ADMIN_TOKEN.encode(), f"{purpose}:{order_id}".encode(), hashlib.sha256
    ).hexdigest()[:32]


def check_token(purpose: str, order_id: str, token: str | None) -> bool:
    if not token:
        return False
    return hmac.compare_digest(_token(purpose, order_id), token)


def pdf_url(order_id: str, fresh: bool = False, base: str | None = None) -> str:
    """Link assinado de conferir a folha.

    `base=""` devolve o caminho relativo, que é o que a tela do admin usa: ela
    já está servida pelo próprio backend, enquanto o PUBLIC_BASE_URL aponta
    pro domínio de fora (que num acesso pela rede local pode nem resolver).
    """
    raiz = PUBLIC_BASE_URL if base is None else base
    url = f"{raiz}/orders/{order_id}/pdf?token={_token('view', order_id)}"
    return url + "&fresh=1" if fresh else url


def pdf_url_local(order_id: str) -> str | None:
    """O mesmo link de conferir a folha, mas pelo IP do homelab na rede local.

    Devolve None quando LOCAL_BASE_URL não está configurada.

    Existe por causa do tamanho do arquivo. Aberto de dentro de casa, o link
    público manda o PDF do homelab até a Cloudflare e de volta pra uma
    máquina que está na mesma rede — gasta a subida doméstica duas vezes, e
    num pedido grande são centenas de MB. Este vai direto na máquina.

    O token é o mesmo, então quem tem este link tem exatamente o mesmo poder
    de quem tem o outro: conferir a folha, e nada além disso (imprimir usa
    outro token). Ele trafega em claro na LAN, o que é o mesmo risco de já
    servir a tela do admin por HTTP na rede de casa.
    """
    if not LOCAL_BASE_URL:
        return None
    return pdf_url(order_id, base=LOCAL_BASE_URL)


def print_url(order_id: str) -> str:
    return f"{PUBLIC_BASE_URL}/orders/{order_id}/print?token={_token('print', order_id)}"


def pdf_path(order_id: str) -> str:
    return os.path.join(pdf_generator.OUTPUT_DIR, f"pedido-{order_id}.pdf")


def _incomplete_marker(order_id: str) -> str:
    return pdf_path(order_id) + ".incompleto"


# Uma trava por pedido + o resultado da última montagem.
#
# `view_pdf` é uma rota síncrona, então o FastAPI roda cada requisição numa
# thread do pool: abrir o mesmo link duas vezes (ou o navegador tentando de
# novo porque demorou) dispara DUAS montagens simultâneas do mesmo pedido.
# Cada uma abre DRIVE_WORKERS conexões com o Drive e as duas escrevem no
# MESMO arquivo .pdf ao mesmo tempo — o que satura o link (o cloudflared da
# mesma máquina cai junto, com "no recent network activity") e ainda deixa um
# PDF corrompido, escrito por dois `canvas.save()` intercalados.
#
# Com a trava, cliques repetidos entram na fila e o segundo reaproveita o
# arquivo que o primeiro acabou de montar. Os dicionários crescem uma entrada
# por pedido já visto, o que é irrisório e some no restart.
_locks_guard = threading.Lock()
_order_locks: dict[str, threading.Lock] = {}
_last_run: dict[str, tuple[float, str, int]] = {}  # id -> (quando, path, falhas)


def _order_lock(order_id: str) -> threading.Lock:
    with _locks_guard:
        return _order_locks.setdefault(order_id, threading.Lock())


def _cached_pdf(order_id: str) -> tuple[str, int] | None:
    """O PDF pronto no disco, se existir e estiver completo."""
    path = pdf_path(order_id)
    if os.path.exists(path) and not os.path.exists(_incomplete_marker(order_id)):
        return path, 0
    return None


def ensure_pdf(order_id: str, fresh: bool = False,
               on_progress=None) -> tuple[str, int]:
    """
    Devolve `(caminho_do_pdf, imagens_que_falharam)`, gerando só se precisar.

    O PDF fica em cache no disco: assim, depois de conferir pelo link "Ver
    PDF", clicar em "Imprimir" imprime exatamente o arquivo já conferido —
    e sem baixar tudo do Drive de novo.

    Duas requisições pro mesmo pedido não montam o PDF em paralelo: a
    segunda espera a primeira e reaproveita o arquivo dela (ver `_order_lock`).

    Se alguma imagem falhou no download, fica um arquivo-marcador do lado e o
    PDF não conta como cache válido no disco: depois de reiniciar, a próxima
    abertura monta de novo. Dentro do mesmo processo quem manda tentar outra
    vez é o link "montar de novo" (`fresh=1`) — ver `request_pdf`, que
    precisa dessa guarda pra página de auto-refresh não remontar em loop.
    """
    started = time.monotonic()
    if not fresh:
        cached = _cached_pdf(order_id)
        if cached:
            return cached

    with _order_lock(order_id):
        # Enquanto esta chamada esperava a trava, outra requisição pode ter
        # montado o mesmo pedido. Se ela terminou DEPOIS desta chegar, o
        # arquivo dela é tão novo quanto o que seria montado aqui — vale até
        # pro `fresh=1`, senão dois cliques no "montar de novo" baixariam
        # tudo duas vezes seguidas.
        run = _last_run.get(order_id)
        if run and run[0] > started:
            return run[1], run[2]
        if not fresh:
            cached = _cached_pdf(order_id)
            if cached:
                return cached

        marker = _incomplete_marker(order_id)
        order = storage.get_order_with_xml(order_id)
        if not order:
            raise ValueError("Pedido não encontrado.")
        path, failures = pdf_generator.generate_pdf(
            order["xml_text"], order_id=order_id, on_progress=on_progress)

        if failures:
            with open(marker, "w") as f:
                f.write(str(failures))
            print(f"[fulfillment] pedido {order_id}: {failures} imagem(ns) falharam no "
                  f"download — o PDF saiu com quadro de falha no lugar delas. "
                  f"Use o link \"montar de novo\" (fresh=1) pra tentar outra vez.")
        elif os.path.exists(marker):
            os.remove(marker)

        _last_run[order_id] = (time.monotonic(), path, failures)
        return path, failures


# Estado da montagem em segundo plano, por pedido.
_progress: dict[str, dict] = {}


def _note_progress(order_id: str):
    def cb(feitas: int, total: int):
        with _locks_guard:
            estado = _progress.get(order_id)
            if estado and estado["estado"] == "montando":
                estado["feitas"], estado["total"] = feitas, total
    return cb


def _run_generation(order_id: str, fresh: bool) -> None:
    try:
        path, failures = ensure_pdf(order_id, fresh=fresh,
                                    on_progress=_note_progress(order_id))
        final = {"estado": "pronto", "path": path, "falhas": failures}
    except Exception as e:
        print(f"[fulfillment] pedido {order_id}: montagem falhou: {e}")
        final = {"estado": "erro", "detalhe": str(e)}
    with _locks_guard:
        _progress[order_id] = final


def request_pdf(order_id: str, fresh: bool = False) -> dict:
    """
    Estado da montagem do PDF, começando uma em segundo plano se precisar.

    A montagem de um pedido grande leva minutos: são dezenas de imagens de
    ~10 MB pra baixar do Drive. Fazer isso DENTRO da requisição estourava o
    teto de ~100s do edge da Cloudflare, e o túnel derrubava a conexão com
    "context canceled" — do lado do backend o trabalho continuava e terminava,
    mas quem pediu já tinha recebido o erro e recarregava, empilhando
    montagens do mesmo pedido.

    Por isso a requisição não espera: ela dispara a montagem numa thread e
    responde na hora. Devolve `{"estado": "pronto"|"montando"|"erro", ...}`.
    """
    if not fresh:
        cached = _cached_pdf(order_id)
        if cached:
            return {"estado": "pronto", "path": cached[0], "falhas": cached[1]}

    with _locks_guard:
        atual = _progress.get(order_id)
        if atual and atual["estado"] == "montando":
            return dict(atual)
        # Já montado nesta rodada. Isso PRECISA vir antes de disparar outra
        # montagem: um PDF com falha deixa o marcador `.incompleto`, então o
        # `_cached_pdf` acima devolve None de propósito — e como a página se
        # atualiza sozinha, sem esta guarda o pedido remontaria em loop pra
        # sempre. O PDF sai com os quadros de falha à vista e quem quiser
        # tentar de novo usa o link "montar de novo" (fresh=1).
        if atual and atual["estado"] == "pronto" and not fresh:
            return dict(atual)
        # Erro é devolvido UMA vez e esquecido: a página de erro não tem
        # auto-refresh, então o loop para, e recarregar na mão tenta de novo.
        if atual and atual["estado"] == "erro" and not fresh:
            _progress.pop(order_id, None)
            return dict(atual)
        # Quem chega primeiro marca "montando" e só ele dispara a thread;
        # os outros caem nos `return` acima e só acompanham.
        _progress[order_id] = {"estado": "montando", "feitas": 0, "total": 0,
                               "inicio": time.time()}

    threading.Thread(target=_run_generation, args=(order_id, fresh),
                     daemon=True).start()
    with _locks_guard:
        return dict(_progress[order_id])



def descartar_pdf(order_id: str) -> bool:
    """Apaga a folha montada de um pedido. Devolve True se havia o que apagar.

    Vai junto com apagar o pedido: sem isso o PDF ficaria no disco servindo um
    pedido que não existe mais, esperando a faxina diária.
    """
    achou = False
    for caminho in (pdf_path(order_id), _incomplete_marker(order_id)):
        try:
            os.remove(caminho)
            achou = True
        except FileNotFoundError:
            pass
    with _locks_guard:
        _progress.pop(order_id, None)
        _last_run.pop(order_id, None)
    return achou

def run_print_job(order_id: str) -> tuple[str, int, str]:
    """
    Garante o PDF, marca o pedido como pago e manda pra fila CUPS. Roda de
    forma síncrona de propósito: assim quem clicou no link vê na tela se deu
    certo ou não.

    Marca como pago ANTES de imprimir, e de propósito: clicar em Imprimir
    quer dizer "conferi o Pix no banco", o que é verdade mesmo que a
    impressora esteja fora do ar. Se o `lp` falhar, a PrintError sobe e a
    tela avisa — é só resolver a impressora e abrir o mesmo link de novo.
    """
    path, failures = ensure_pdf(order_id)
    storage.mark_paid(order_id)
    status = printer.print_pdf(path)
    return path, failures, status
