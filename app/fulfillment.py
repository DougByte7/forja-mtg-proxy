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


# --- Folha combinada -------------------------------------------------------
#
# Um combo é vários pedidos numa folha corrida (ver `storage.save_combo`).
# Daqui pra baixo ele anda pelos mesmos trilhos do pedido só: mesmo cache em
# disco, mesma trava por trabalho, mesmo link assinado. O que muda é o nome do
# arquivo e o que cada um assina.
#
# O assunto do token leva o prefixo `combo:` de propósito: assim o link de
# conferir o pedido X não vira, por acidente, link de conferir a folha que por
# acaso tenha o mesmo id.


def _combo_subject(combo_id: str) -> str:
    return f"combo:{combo_id}"


def combo_pdf_path(combo_id: str) -> str:
    return os.path.join(pdf_generator.OUTPUT_DIR, f"combo-{combo_id}.pdf")


def combo_pdf_url(combo_id: str, fresh: bool = False,
                  base: str | None = None) -> str:
    """Link assinado de conferir a folha combinada. Ver `pdf_url`."""
    raiz = PUBLIC_BASE_URL if base is None else base
    token = _token("view", _combo_subject(combo_id))
    url = f"{raiz}/combos/{combo_id}/pdf?token={token}"
    return url + "&fresh=1" if fresh else url


def combo_pdf_url_local(combo_id: str) -> str | None:
    """A mesma folha combinada pelo IP do homelab. Ver `pdf_url_local`."""
    if not LOCAL_BASE_URL:
        return None
    return combo_pdf_url(combo_id, base=LOCAL_BASE_URL)


def check_combo_token(purpose: str, combo_id: str, token: str | None) -> bool:
    return check_token(purpose, _combo_subject(combo_id), token)


def _incomplete_marker(path: str) -> str:
    """O marcador de "montou com falha" que anda do lado de cada PDF."""
    return path + ".incompleto"


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


def _trava(chave: str) -> threading.Lock:
    """A trava daquele trabalho. `chave` é o id do pedido, ou `combo:<id>`."""
    with _locks_guard:
        return _order_locks.setdefault(chave, threading.Lock())


def _cache_no_disco(path: str) -> tuple[str, int] | None:
    """O PDF pronto no disco, se existir e estiver completo."""
    if os.path.exists(path) and not os.path.exists(_incomplete_marker(path)):
        return path, 0
    return None


def _cached_pdf(order_id: str) -> tuple[str, int] | None:
    return _cache_no_disco(pdf_path(order_id))

def _garantir(chave: str, path: str, construir, fresh: bool = False,
              on_progress=None) -> tuple[str, int]:
    """
    Devolve `(caminho_do_pdf, imagens_que_falharam)`, montando só se precisar.

    `chave` identifica o trabalho (id do pedido, ou `combo:<id>`), `path` é
    onde o arquivo mora e `construir(on_progress) -> (caminho, falhas)` é quem
    sabe desenhar. Pedido só e folha combinada passam por aqui do mesmo jeito.

    O PDF fica em cache no disco: assim, depois de conferir pelo link "Ver
    PDF", clicar em "Imprimir" imprime exatamente o arquivo já conferido —
    e sem baixar tudo do Drive de novo.

    Duas requisições pro mesmo trabalho não montam o PDF em paralelo: a
    segunda espera a primeira e reaproveita o arquivo dela (ver `_trava`).

    Se alguma imagem falhou no download, fica um arquivo-marcador do lado e o
    PDF não conta como cache válido no disco: depois de reiniciar, a próxima
    abertura monta de novo. Dentro do mesmo processo quem manda tentar outra
    vez é o link "montar de novo" (`fresh=1`) — ver `request_pdf`, que
    precisa dessa guarda pra página de auto-refresh não remontar em loop.
    """
    started = time.monotonic()
    if not fresh:
        cached = _cache_no_disco(path)
        if cached:
            return cached

    with _trava(chave):
        # Enquanto esta chamada esperava a trava, outra requisição pode ter
        # montado o mesmo trabalho. Se ela terminou DEPOIS desta chegar, o
        # arquivo dela é tão novo quanto o que seria montado aqui — vale até
        # pro `fresh=1`, senão dois cliques no "montar de novo" baixariam
        # tudo duas vezes seguidas.
        run = _last_run.get(chave)
        if run and run[0] > started:
            return run[1], run[2]
        if not fresh:
            cached = _cache_no_disco(path)
            if cached:
                return cached

        marker = _incomplete_marker(path)
        caminho, failures = construir(on_progress)

        if failures:
            with open(marker, "w") as f:
                f.write(str(failures))
            print(f"[fulfillment] {chave}: {failures} imagem(ns) falharam no "
                  f"download — o PDF saiu com quadro de falha no lugar delas. "
                  f"Use o link \"montar de novo\" (fresh=1) pra tentar outra vez.")
        elif os.path.exists(marker):
            os.remove(marker)

        _last_run[chave] = (time.monotonic(), caminho, failures)
        return caminho, failures


def ensure_pdf(order_id: str, fresh: bool = False,
               on_progress=None) -> tuple[str, int]:
    """A folha de UM pedido, montando só se precisar. Ver `_garantir`."""
    def construir(cb):
        order = storage.get_order_with_xml(order_id)
        if not order:
            raise ValueError("Pedido não encontrado.")
        return pdf_generator.generate_pdf(order["xml_text"], order_id=order_id,
                                          on_progress=cb)

    return _garantir(order_id, pdf_path(order_id), construir, fresh, on_progress)


# O mapa de quem ocupa quais posições da folha combinada, por combo. Só vale
# depois de a folha ter sido montada nesta rodada; a tela também sabe calcular
# o mesmo mapa a partir do que está no banco, então isto é conferência, não
# fonte da verdade.
_mapas_combo: dict[str, list[dict]] = {}


def ensure_combo_pdf(combo_id: str, fresh: bool = False,
                     on_progress=None) -> tuple[str, int]:
    """A folha combinada de um combo, montando só se precisar.

    A ordem de impressão é a que está guardada no combo — nunca a que o
    SQLite devolver —, porque é ela que decide quem cai em qual folha e é ela
    que a tela mostrou pro operador antes de montar.
    """
    def construir(cb):
        combo = storage.get_combo(combo_id)
        if not combo:
            raise ValueError("Combinação não encontrada.")
        pedidos = storage.get_orders_with_xml(combo["order_ids"])
        if len(pedidos) < len(combo["order_ids"]):
            faltando = set(combo["order_ids"]) - {p["id"] for p in pedidos}
            raise ValueError("Pedido apagado depois que a combinação foi "
                             f"montada: {', '.join(sorted(faltando))}.")
        caminho, falhas, mapa = pdf_generator.generate_combined_pdf(
            pedidos, combo_id=combo_id, on_progress=cb)
        _mapas_combo[combo_id] = mapa
        return caminho, falhas

    return _garantir(_combo_subject(combo_id), combo_pdf_path(combo_id),
                     construir, fresh, on_progress)


def mapa_combo(combo_id: str) -> list[dict] | None:
    """Onde cada pedido caiu na última montagem desta folha, se houve uma."""
    return _mapas_combo.get(combo_id)


# Estado da montagem em segundo plano, por trabalho.
_progress: dict[str, dict] = {}


def _note_progress(chave: str):
    def cb(feitas: int, total: int):
        with _locks_guard:
            estado = _progress.get(chave)
            if estado and estado["estado"] == "montando":
                estado["feitas"], estado["total"] = feitas, total
    return cb


def _run_generation(chave: str, montar, fresh: bool) -> None:
    try:
        path, failures = montar(fresh, _note_progress(chave))
        final = {"estado": "pronto", "path": path, "falhas": failures}
    except Exception as e:
        print(f"[fulfillment] {chave}: montagem falhou: {e}")
        final = {"estado": "erro", "detalhe": str(e)}
    with _locks_guard:
        _progress[chave] = final


def _pedir(chave: str, path: str, montar, fresh: bool = False) -> dict:
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
        cached = _cache_no_disco(path)
        if cached:
            return {"estado": "pronto", "path": cached[0], "falhas": cached[1]}

    with _locks_guard:
        atual = _progress.get(chave)
        if atual and atual["estado"] == "montando":
            return dict(atual)
        # Já montado nesta rodada. Isso PRECISA vir antes de disparar outra
        # montagem: um PDF com falha deixa o marcador `.incompleto`, então o
        # `_cache_no_disco` acima devolve None de propósito — e como a página
        # se atualiza sozinha, sem esta guarda o pedido remontaria em loop pra
        # sempre. O PDF sai com os quadros de falha à vista e quem quiser
        # tentar de novo usa o link "montar de novo" (fresh=1).
        if atual and atual["estado"] == "pronto" and not fresh:
            return dict(atual)
        # Erro é devolvido UMA vez e esquecido: a página de erro não tem
        # auto-refresh, então o loop para, e recarregar na mão tenta de novo.
        if atual and atual["estado"] == "erro" and not fresh:
            _progress.pop(chave, None)
            return dict(atual)
        # Quem chega primeiro marca "montando" e só ele dispara a thread;
        # os outros caem nos `return` acima e só acompanham.
        _progress[chave] = {"estado": "montando", "feitas": 0, "total": 0,
                            "inicio": time.time()}

    threading.Thread(target=_run_generation, args=(chave, montar, fresh),
                     daemon=True).start()
    with _locks_guard:
        return dict(_progress[chave])


def request_pdf(order_id: str, fresh: bool = False) -> dict:
    """Estado da montagem da folha de um pedido. Ver `_pedir`."""
    def montar(fresh_, cb):
        return ensure_pdf(order_id, fresh=fresh_, on_progress=cb)

    return _pedir(order_id, pdf_path(order_id), montar, fresh)


def request_combo_pdf(combo_id: str, fresh: bool = False) -> dict:
    """Estado da montagem de uma folha combinada. Ver `_pedir`."""
    def montar(fresh_, cb):
        return ensure_combo_pdf(combo_id, fresh=fresh_, on_progress=cb)

    return _pedir(_combo_subject(combo_id), combo_pdf_path(combo_id),
                  montar, fresh)


def _descartar(chave: str, path: str) -> bool:
    achou = False
    for caminho in (path, _incomplete_marker(path)):
        try:
            os.remove(caminho)
            achou = True
        except FileNotFoundError:
            pass
    with _locks_guard:
        _progress.pop(chave, None)
        _last_run.pop(chave, None)
    return achou


def descartar_pdf(order_id: str) -> bool:
    """Apaga a folha montada de um pedido. Devolve True se havia o que apagar.

    Vai junto com apagar o pedido: sem isso o PDF ficaria no disco servindo um
    pedido que não existe mais, esperando a faxina diária.
    """
    return _descartar(order_id, pdf_path(order_id))


def descartar_combo_pdf(combo_id: str) -> bool:
    """Apaga a folha combinada montada. Os pedidos dela não são tocados."""
    _mapas_combo.pop(combo_id, None)
    return _descartar(_combo_subject(combo_id), combo_pdf_path(combo_id))


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


def run_combo_print_job(combo_id: str) -> tuple[str, int, str, list[str]]:
    """O mesmo, pra folha combinada: um arquivo, VÁRIOS pedidos pagos.

    Todos os pedidos daquele papel viram 'paid' de uma vez — as cartas deles
    saem misturadas na mesma folha, então não existe imprimir só metade. Como
    no pedido só, marcar vem ANTES de mandar pro CUPS: clicar em imprimir quer
    dizer "conferi os Pix", e isso continua verdade se a impressora estiver
    fora do ar.

    Devolve `(caminho, falhas, status_da_fila, ids_marcados)`.
    """
    combo = storage.get_combo(combo_id)
    if not combo:
        raise ValueError("Combinação não encontrada.")
    path, failures = ensure_combo_pdf(combo_id)
    storage.mark_paid_many(combo["order_ids"])
    status = printer.print_pdf(path)
    return path, failures, status, combo["order_ids"]
