import os
import time

from fastapi import FastAPI, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import (calc, cleanup, cotacao_job, fulfillment, log, notify, pix,
               printer, storage, visitas)

app = FastAPI(title="Forja de Proxies — backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # em produção, restringir ao domínio do front-end
    allow_methods=["*"],
    allow_headers=["*"],
)

PIX_KEY = os.environ.get("PIX_KEY", "")
MERCHANT_NAME = os.environ.get("MERCHANT_NAME", "FORJA DE PROXIES")
MERCHANT_CITY = os.environ.get("MERCHANT_CITY", "ITAIOPOLIS")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

# Janela pra não mandar 10 e-mails se o cliente ficar clicando no botão.
NOTIFY_COOLDOWN_SECONDS = 120


def _check_admin(x_admin_token: str | None):
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Token de administrador inválido ou ausente.")


# Requisições que valem uma linha de log mesmo vindo de bot, porque mexem em
# alguma coisa. O resto (GET de página, arquivo estático, poll de status) só
# entra na contagem da visita — senão o log vira o access log do nginx, que
# já existe e não é o que se quer olhar aqui.
_ACOES_EXATAS = {
    ("POST", "/orders"): "pediu orçamento",
    ("POST", "/cotacao"): "cotou preços",
}
# Estas trazem o id do pedido no meio do caminho, então casam por sufixo.
_ACOES_SUFIXO = {
    ("POST", "/notify-payment"): "avisou que pagou",
    ("GET", "/print"): "abriu o link de imprimir",
    ("GET", "/pdf"): "abriu o PDF",
}


def _acao(metodo: str, caminho: str) -> str | None:
    exata = _ACOES_EXATAS.get((metodo, caminho))
    if exata:
        return exata
    for (m, sufixo), nome in _ACOES_SUFIXO.items():
        if m == metodo and caminho.endswith(sufixo):
            return nome
    return None


@app.middleware("http")
async def registrar_visita(request: Request, call_next):
    """Anota quem está no sistema e quanto cada requisição demorou.

    Fica em volta de TODAS as rotas, inclusive dos arquivos estáticos, porque
    é justamente o pedido do `index.html` que revela que alguém abriu a
    página — as rotas da API só contam quem já resolveu usar.

    Nada aqui pode derrubar uma resposta: se o registro falhar, a requisição
    segue. Log é observação, não parte do serviço.
    """
    inicio = time.monotonic()
    try:
        ip = visitas.ip_do_pedido(request)
        ua = request.headers.get("user-agent", "")
        classe, sinal = visitas.classificar(ua, request.headers)
        visita = visitas.registro.registrar(
            ip, ua, request.url.path, classe, sinal,
            pais=request.headers.get("cf-ipcountry", ""))
        if visita["nova"]:
            log.evento("visita", "chegou", id=visita["id"], ip=ip,
                       classe=classe, sinal=sinal,
                       pais=visita["pais"] or None, em=request.url.path,
                       ua=ua[:120] or None)
    except Exception as e:
        visita, classe = None, "?"
        log.aviso("visita", "nao-registrei", motivo=f"{type(e).__name__}: {e}")

    try:
        resposta = await call_next(request)
    except Exception as e:
        # Exceção que ninguém tratou. O middleware de erro do Starlette está
        # POR FORA deste, então sem isto o 500 sairia do backend sem deixar
        # rastro nenhum no nosso log — só no traceback do uvicorn.
        log.erro("acesso", "explodiu", id=visita["id"] if visita else None,
                 metodo=request.method, caminho=request.url.path,
                 motivo=f"{type(e).__name__}: {e}",
                 ms=int((time.monotonic() - inicio) * 1000))
        raise

    try:
        ms = int((time.monotonic() - inicio) * 1000)
        acao = _acao(request.method, request.url.path)
        if acao and visita:
            visitas.registro.anotar(visita["id"], acao)
        if acao or resposta.status_code >= 400:
            log.evento("acesso", acao or "erro",
                       id=visita["id"] if visita else None,
                       metodo=request.method, caminho=request.url.path,
                       status=resposta.status_code, ms=ms, classe=classe)
        else:
            log.debug("acesso", "pedido", id=visita["id"] if visita else None,
                      metodo=request.method, caminho=request.url.path,
                      status=resposta.status_code, ms=ms)
    except Exception:
        pass  # ver acima: log nunca derruba resposta

    return resposta


@app.on_event("startup")
def startup():
    storage.init_db()
    cleanup.start_background()
    log.evento("app", "subiu", log_dir=log.DIR, nivel=log.NIVEL,
               fontes=", ".join(f["id"] for f in cotacao_job.fontes_ativas())
                      or "nenhuma")


@app.post("/orders")
async def create_order(xml_file: UploadFile, lamination: str = Form(...),
                        customer_name: str = Form(...)):
    if not PIX_KEY:
        raise HTTPException(500, "PIX_KEY não configurada no backend (.env).")
    if not customer_name.strip():
        raise HTTPException(400, "Informe o nome de quem está pedindo.")

    xml_text = (await xml_file.read()).decode("utf-8")
    try:
        qty, backs_count = calc.parse_order(xml_text)
        result = calc.compute_cost(qty, backs_count, lamination)
        deck_hash = calc.compute_deck_hash(xml_text)
    except ValueError as e:
        raise HTTPException(400, str(e))

    order_id, amount = storage.create_order(
        xml_text, lamination, customer_name.strip(), deck_hash, result
    )
    payload = pix.build_payload(PIX_KEY, MERCHANT_NAME, MERCHANT_CITY, amount, txid=order_id)
    qr_b64 = pix.build_qr_base64(payload)

    return {
        "order_id": order_id,
        "deck_hash": deck_hash,
        **result,
        "amount": amount,
        "pix_copia_cola": payload,
        "pix_qr_base64": qr_b64,
    }


@app.get("/orders/{order_id}")
def order_status(order_id: str):
    order = storage.get_order(order_id)
    if not order:
        raise HTTPException(404, "Pedido não encontrado.")
    return order


@app.post("/orders/{order_id}/notify-payment")
def notify_payment(order_id: str):
    """
    O cliente clicou em "Pagamento realizado, enviar notificação".

    Isso NÃO confirma pagamento nem imprime nada — só manda um e-mail com o
    resumo do pedido e o link "Imprimir", pro operador conferir o Pix no app
    do banco e decidir.

    O que já acontece aqui é a montagem do PDF, disparada em segundo plano
    junto com o aviso — ver o comentário lá embaixo.
    """
    order = storage.get_order(order_id)
    if not order:
        raise HTTPException(404, "Pedido não encontrado.")
    if order["status"] == "paid":
        return {"status": "already_printed",
                "message": "Esse pedido já foi confirmado e enviado pra impressão."}

    last = order.get("notified_at")
    if last and (time.time() - last) < NOTIFY_COOLDOWN_SECONDS:
        return {"status": "already_sent",
                "message": "O aviso já foi enviado — aguarde a confirmação."}

    if not notify.is_configured():
        raise HTTPException(500, "SMTP não configurado no backend (.env).")
    try:
        links = (fulfillment.pdf_url(order_id),
                 fulfillment.print_url(order_id),
                 fulfillment.pdf_url(order_id, fresh=True))
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    # Começa a montar o PDF agora, em segundo plano. Baixar as artes do Drive
    # leva minutos num pedido grande, e esse é justamente o tempo que leva a
    # conferência do Pix no app do banco — quando o link "Ver PDF" for aberto,
    # na maioria das vezes o arquivo já está pronto, em vez de cair na página
    # de "montando" e esperar.
    #
    # `request_pdf` só dispara a thread e volta na hora, então o aviso não
    # atrasa; e se ele falhar aqui, o link do e-mail continua montando sob
    # demanda como antes, então isso não pode derrubar o e-mail.
    try:
        fulfillment.request_pdf(order_id)
    except Exception as e:
        log.aviso("pedido", "pdf-antecipado-falhou", pedido=order_id,
                  motivo=f"{type(e).__name__}: {e}",
                  nota="o link do e-mail monta sob demanda")

    try:
        notify.send_payment_claim_email(order, *links)
    except Exception as e:
        raise HTTPException(502, f"Não consegui enviar o e-mail de aviso: {e}")

    storage.mark_notified(order_id)
    return {"status": "sent",
            "message": "Aviso enviado. Assim que o pagamento for conferido, "
                       "seu pedido vai pra impressão."}


def _authorize(purpose: str, order_id: str, token: str | None,
               x_admin_token: str | None) -> dict:
    """Valida o link assinado (ou o header de admin) e devolve o pedido."""
    authorized = bool(x_admin_token and ADMIN_TOKEN and x_admin_token == ADMIN_TOKEN)
    if not authorized:
        try:
            authorized = fulfillment.check_token(purpose, order_id, token)
        except RuntimeError as e:
            raise HTTPException(500, str(e))
    if not authorized:
        raise HTTPException(401, "Link inválido ou expirado.")
    order = storage.get_order(order_id)
    if not order:
        raise HTTPException(404, "Pedido não encontrado.")
    return order


@app.get("/orders/{order_id}/pdf")
def view_pdf(order_id: str, token: str | None = None, fresh: bool = False,
             x_admin_token: str | None = Header(default=None)):
    """
    Link "Ver PDF" do e-mail. Monta a folha (se ainda não existir) e devolve
    o arquivo inline, pra abrir direto no navegador ou no visualizador do
    celular — sem anexo, pra não esbarrar no limite do Gmail.

    Se o PDF ainda não existe, a montagem começa em segundo plano e a
    resposta é uma página que se atualiza sozinha até o arquivo ficar pronto.
    Esperar dentro da requisição estourava o teto do túnel da Cloudflare em
    pedido grande (ver `fulfillment.request_pdf`).

    Só conferir NÃO marca o pedido como pago nem imprime nada.
    """
    _authorize("view", order_id, token, x_admin_token)
    estado = fulfillment.request_pdf(order_id, fresh=fresh)

    if estado["estado"] == "erro":
        return HTMLResponse(_status_page(
            "Falhou", f"Não consegui montar o PDF do pedido {order_id}: "
                      f"{estado['detalhe']}", ok=False
        ), status_code=500)

    if estado["estado"] == "montando":
        return HTMLResponse(_montando_page(order_id, estado, token))

    path, failures = estado["path"], estado["falhas"]
    return FileResponse(
        path,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="pedido-{order_id}.pdf"',
            "Cache-Control": "no-store",
            "X-Imagens-Com-Falha": str(failures),
        },
    )


@app.get("/orders/{order_id}/print", response_class=HTMLResponse)
def print_order(order_id: str, token: str | None = None,
                x_admin_token: str | None = Header(default=None)):
    """
    Link "Imprimir" do e-mail. Reaproveita o PDF já conferido, marca o
    pedido como pago e manda pra fila da impressora. Aceita o token assinado
    da querystring (o do e-mail) ou o header X-Admin-Token, pra disparar na
    mão quando precisar.
    """
    order = _authorize("print", order_id, token, x_admin_token)
    was_paid = order["status"] == "paid"

    try:
        pdf_path, failures, print_status = fulfillment.run_print_job(order_id)
    except printer.PrintError as e:
        return HTMLResponse(_status_page(
            "A impressora recusou o trabalho",
            f"O pedido {order_id} está marcado como pago e o PDF está pronto, "
            f"mas o CUPS não aceitou: {e} "
            f"Depois de resolver, abra este mesmo link de novo — ou use o link "
            f"\"Ver PDF\" do e-mail e imprima pelo celular.", ok=False
        ), status_code=502)
    except Exception as e:
        return HTMLResponse(_status_page(
            "Falhou", f"Não consegui imprimir o pedido {order_id}: {e}", ok=False
        ), status_code=500)

    resumo = (f"Pedido {order_id} de {order['customer_name']} — "
              f"{order['pages']} página(s), R$ {order['amount']:.2f}. "
              f"PDF: {os.path.basename(pdf_path)}.")

    if not printer.PRINTER_QUEUE:
        # Modo sem impressora no servidor: o clique confirma o pagamento e
        # deixa o PDF pronto, mas a impressão em si fica manual, pelo link
        # "Ver PDF".
        titulo = "Pagamento confirmado"
        detalhe = (f"{resumo} A impressão automática está desligada "
                   f"(PRINTER_QUEUE vazia), então nada foi pra fila nenhuma — "
                   f"abra o link \"Ver PDF\" do e-mail e imprima de onde preferir.")
    else:
        titulo = "Enviado pra impressora"
        detalhe = f"{resumo} {print_status}."

    if was_paid:
        detalhe += " Esse pedido já tinha sido confirmado antes."
    if failures:
        detalhe += (f" ATENÇÃO: {failures} carta(s) não baixaram do Drive e saíram "
                    f"como quadro de falha no papel.")
    return HTMLResponse(_status_page(titulo, detalhe))


def _montando_page(order_id: str, estado: dict, token: str | None) -> str:
    """Página que se atualiza sozinha enquanto o PDF é montado.

    O refresh aponta pra URL SEM o `fresh=1`: senão cada atualização pediria
    uma remontagem nova e o pedido nunca chegaria ao fim.
    """
    feitas, total = estado.get("feitas", 0), estado.get("total", 0)
    decorrido = int(time.time() - estado.get("inicio", time.time()))
    onde = (f"{feitas} de {total} imagens baixadas" if total
            else "lendo a lista de cartas")
    destino = f"/orders/{order_id}/pdf" + (f"?token={token}" if token else "")
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5;url={destino}">
<title>Montando o PDF — Forja de Proxies</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;
             justify-content:center;background:#0F0D17;color:#EDE6D6;
             font-family:system-ui,sans-serif;padding:24px;">
  <div style="max-width:460px;background:#1B1730;border:1px solid #382F5C;
              border-radius:14px;padding:28px;">
    <h1 style="margin:0 0 12px;font-size:20px;color:#C9A227;">Montando o PDF</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#A79BC7;">
      Pedido {order_id}: {onde} ({decorrido}s). As artes vêm do Google Drive e
      têm ~10 MB cada, então pedido grande leva alguns minutos.
    </p>
    <p style="margin:0;font-size:13px;color:#6F6490;">
      Esta página se atualiza sozinha — pode deixar aberta. Não precisa
      recarregar na mão.
    </p>
  </div>
</body></html>"""


def _status_page(title: str, message: str, ok: bool = True) -> str:
    color = "#C9A227" if ok else "#D9634A"
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Forja de Proxies</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;
             justify-content:center;background:#0F0D17;color:#EDE6D6;
             font-family:system-ui,sans-serif;padding:24px;">
  <div style="max-width:460px;background:#1B1730;border:1px solid #382F5C;
              border-radius:14px;padding:28px;">
    <h1 style="margin:0 0 12px;font-size:20px;color:{color};">{title}</h1>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#A79BC7;">{message}</p>
  </div>
</body></html>"""


@app.post("/cotacao")
async def start_cotacao(xml_file: UploadFile, commander: str = Form(default="")):
    """
    Começa a cotar os preços das cartas do XML. NÃO cria pedido nem cobra
    nada — é só consulta de preço.

    Só roda quando alguém clica no botão da tela, nunca junto do upload: a
    cotação faz uma requisição por carta na LigaMagic, com intervalo mínimo
    entre elas, e quem só queria orçar a impressão não deve pagar esse custo.

    `commander` é opcional e sai da conta quando vem — junto com os terrenos
    básicos, que saem sempre. É o critério do Commander 500, cujo teto de
    preço vale para o deck sem eles. As duas coisas voltam listadas em
    `excluidas`, pra tela poder dizer o que ficou de fora do total.

    Responde na hora com o `job_id` e o andamento; o resultado sai no GET
    abaixo. Deck grande leva minutos, e esperar dentro da requisição estoura
    o teto do túnel (mesma história do PDF).
    """
    try:
        xml_text = (await xml_file.read()).decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(400, "Esse arquivo não é um XML em UTF-8.")
    try:
        return cotacao_job.iniciar(xml_text, commander.strip() or None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/cotacao/{job_id}")
def get_cotacao(job_id: str):
    """Andamento ou resultado de uma cotação. A tela chama isso em laço
    enquanto o estado for "cotando"."""
    atual = cotacao_job.estado(job_id)
    if not atual:
        raise HTTPException(404, "Cotação não encontrada (ou o backend "
                                 "reiniciou). Clique em cotar de novo.")
    return atual


@app.get("/admin/orders")
def list_open_orders(x_admin_token: str | None = Header(default=None)):
    """Pedidos ainda não impressos, com o status de cada um ('pending' =
    ninguém avisou nada; 'notified' = o cliente disse que pagou)."""
    _check_admin(x_admin_token)
    return storage.list_open()


@app.get("/admin/printers")
def list_printers(x_admin_token: str | None = Header(default=None)):
    """Lista as filas que o CUPS conhece, vistas de dentro do container —
    é assim que se descobre o nome certo pra PRINTER_QUEUE."""
    _check_admin(x_admin_token)
    return printer.list_queues()


@app.get("/admin/visitas")
def list_visitas(x_admin_token: str | None = Header(default=None)):
    """Quem está no sistema agora, separado por classe.

    Complementa o `visitas.log`: o arquivo responde "o que aconteceu ontem",
    isto responde "tem alguém aí neste momento" sem precisar abrir terminal.
    A janela é `VISITA_JANELA_MINUTOS`.
    """
    _check_admin(x_admin_token)
    ativas = visitas.registro.ativas()
    return {
        "janela_minutos": visitas.JANELA_MINUTOS,
        "pessoas": sum(1 for v in ativas if v["classe"] == "pessoa"),
        "bots": sum(1 for v in ativas if v["classe"].startswith("bot")),
        "suspeitos": sum(1 for v in ativas if v["classe"] == "suspeito"),
        "visitas": ativas,
    }


@app.post("/admin/cleanup")
def run_cleanup(x_admin_token: str | None = Header(default=None)):
    """Roda a faxina dos PDFs antigos na hora, sem esperar o ciclo diário."""
    _check_admin(x_admin_token)
    return cleanup.run_once()


# Serve o front-end (app/static/index.html) na raiz. Fica depois das rotas
# da API de propósito — assim /orders, /admin/... continuam resolvendo
# certo, e qualquer outro caminho cai no arquivo estático.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
