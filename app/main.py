import os
import re
import time

from fastapi import FastAPI, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (FileResponse, HTMLResponse, Response,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles

from . import (calc, cleanup, cotacao_job, fulfillment, log, notify, pix,
               printer, storage, tinta, visitas)

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
        pdf_local = fulfillment.pdf_url_local(order_id)
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
        notify.send_payment_claim_email(order, *links, pdf_local_url=pdf_local)
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


# Quanto o navegador pode reaproveitar o PDF já baixado. Aqui era `no-store`,
# e isso fazia cada reabertura pagar o arquivo inteiro de novo — num pedido
# grande, centenas de MB subindo pelo link de casa só pra mostrar a mesma
# folha. Com revalidação ele pergunta antes e recebe 304 (uns poucos bytes)
# enquanto nada mudou. Não dá pra guardar por tempo fixo porque o "Refazer
# PDF" troca o arquivo debaixo da mesma URL; o ETag sai do mtime + tamanho,
# então uma remontagem invalida o cache sozinha.
PDF_CACHE_CONTROL = "private, max-age=0, must-revalidate"

_FAIXA_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
# `_faixa_pedida` devolve isto quando a faixa existe mas não cabe no arquivo:
# é 416, e não o arquivo inteiro.
FAIXA_INVALIDA = "faixa-invalida"


def _faixa_pedida(header: str | None, tamanho: int):
    """Interpreta o cabeçalho `Range` do pedido.

    Devolve `(inicio, fim)` — inclusivos nos dois lados, como manda o HTTP —
    pra faixa que dá pra atender; `None` quando o arquivo inteiro é a resposta
    certa (não veio Range, ou veio numa forma que não vale a pena tratar, como
    várias faixas de uma vez — mandar tudo é resposta legítima); e
    `FAIXA_INVALIDA` quando pediram pedaço que não existe no arquivo.
    """
    if not header:
        return None
    casou = _FAIXA_RE.match(header.strip())
    if not casou:
        return None
    inicio_txt, fim_txt = casou.groups()
    if inicio_txt:
        inicio = int(inicio_txt)
        fim = int(fim_txt) if fim_txt else tamanho - 1
    elif fim_txt:
        # `bytes=-500` são os ÚLTIMOS 500 bytes. É por aí que o visualizador
        # de PDF começa: o índice do arquivo fica no fim.
        inicio = max(0, tamanho - int(fim_txt))
        fim = tamanho - 1
    else:
        return None  # "bytes=-" não quer dizer nada
    fim = min(fim, tamanho - 1)
    if inicio > fim or inicio >= tamanho:
        return FAIXA_INVALIDA
    return inicio, fim


def _ler_faixa(path: str, inicio: int, fim: int, bloco: int = 64 * 1024):
    """Lê só o pedaço pedido, em blocos, sem carregar o arquivo na memória."""
    with open(path, "rb") as f:
        f.seek(inicio)
        restante = fim - inicio + 1
        while restante > 0:
            pedaco = f.read(min(bloco, restante))
            if not pedaco:
                break  # arquivo encolheu embaixo da leitura; o que veio, veio
            restante -= len(pedaco)
            yield pedaco


def _servir_pdf(request: Request, path: str, order_id: str,
                falhas: int) -> Response:
    """Devolve a folha montada, com Range e revalidação.

    Duas coisas que o `FileResponse` do Starlette 0.38 não faz — e que aqui
    custam caro, porque o arquivo é grande e sobe por um link doméstico:

    * **Range.** Sem `Accept-Ranges`, o visualizador de PDF não consegue
      buscar o índice no fim do arquivo pra desenhar a primeira página antes
      do resto: ele baixa TUDO e só então mostra alguma coisa. E conexão que
      cai no meio recomeça do zero em vez de retomar de onde parou.
    * **304.** Ver o comentário do `PDF_CACHE_CONTROL`.

    Starlette novo já traz as duas, mas subir a dependência mexe em muito mais
    coisa do que estas poucas linhas.
    """
    st = os.stat(path)
    # Mesma ideia do ETag do Starlette: mtime + tamanho. Remontar a folha muda
    # os dois, então o cache do navegador cai sozinho.
    etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    cabecalhos = {
        "Content-Disposition": f'inline; filename="pedido-{order_id}.pdf"',
        "Cache-Control": PDF_CACHE_CONTROL,
        "ETag": etag,
        "Accept-Ranges": "bytes",
        "X-Imagens-Com-Falha": str(falhas),
    }

    faixa = _faixa_pedida(request.headers.get("range"), st.st_size)

    if faixa is FAIXA_INVALIDA:
        return Response(status_code=416, headers={
            **cabecalhos, "Content-Range": f"bytes */{st.st_size}"})

    # If-Range: o cliente só quer o pedaço se o arquivo ainda for o mesmo que
    # ele já tem pela metade. Se o "Refazer PDF" remontou a folha no meio do
    # download, emendar pedaços de dois arquivos diferentes daria um PDF
    # corrompido — nesse caso manda inteiro e ele começa de novo.
    if faixa and request.headers.get("if-range") not in (None, etag):
        faixa = None

    if faixa is None and request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cabecalhos)

    if faixa:
        inicio, fim = faixa
        return StreamingResponse(
            _ler_faixa(path, inicio, fim),
            status_code=206,
            media_type="application/pdf",
            headers={**cabecalhos,
                     "Content-Range": f"bytes {inicio}-{fim}/{st.st_size}",
                     "Content-Length": str(fim - inicio + 1)},
        )

    return FileResponse(path, media_type="application/pdf", stat_result=st,
                        headers=cabecalhos)


@app.get("/orders/{order_id}/pdf")
def view_pdf(request: Request, order_id: str, token: str | None = None,
             fresh: bool = False,
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

    return _servir_pdf(request, estado["path"], order_id, estado["falhas"])


@app.get("/combos/{combo_id}/pdf")
def view_combo_pdf(request: Request, combo_id: str, token: str | None = None,
                   fresh: bool = False,
                   x_admin_token: str | None = Header(default=None)):
    """A folha combinada (vários pedidos num papel só), pra conferir.

    Mesmo comportamento do `/orders/{id}/pdf`: monta em segundo plano se ainda
    não existir, devolve uma página que se atualiza sozinha enquanto monta, e
    serve o arquivo inline quando fica pronto.

    O token é assinado sobre `combo:<id>`, então o link de conferir um pedido
    não abre a folha combinada e vice-versa. Conferir não imprime nada nem
    marca pedido nenhum como pago.
    """
    autorizado = bool(x_admin_token and ADMIN_TOKEN and x_admin_token == ADMIN_TOKEN)
    if not autorizado:
        try:
            autorizado = fulfillment.check_combo_token("view", combo_id, token)
        except RuntimeError as e:
            raise HTTPException(500, str(e))
    if not autorizado:
        raise HTTPException(401, "Link inválido ou expirado.")
    if not storage.get_combo(combo_id):
        raise HTTPException(404, "Combinação não encontrada.")

    estado = fulfillment.request_combo_pdf(combo_id, fresh=fresh)

    if estado["estado"] == "erro":
        return HTMLResponse(_status_page(
            "Falhou", f"Não consegui montar a folha combinada {combo_id}: "
                      f"{estado['detalhe']}", ok=False
        ), status_code=500)

    if estado["estado"] == "montando":
        return HTMLResponse(_montando_page(
            combo_id, estado, token, caminho=f"/combos/{combo_id}/pdf",
            rotulo=f"Folha combinada {combo_id}"))

    return _servir_pdf(request, estado["path"], f"combinado-{combo_id}",
                       estado["falhas"])


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


def _montando_page(order_id: str, estado: dict, token: str | None,
                   caminho: str | None = None,
                   rotulo: str | None = None) -> str:
    """Página que se atualiza sozinha enquanto o PDF é montado.

    O refresh aponta pra URL SEM o `fresh=1`: senão cada atualização pediria
    uma remontagem nova e o pedido nunca chegaria ao fim.

    `caminho` troca a rota do refresh e `rotulo` troca o nome que aparece na
    tela — é o que a folha combinada usa, que mora em `/combos/{id}/pdf` e não
    é "o pedido tal".
    """
    feitas, total = estado.get("feitas", 0), estado.get("total", 0)
    decorrido = int(time.time() - estado.get("inicio", time.time()))
    onde = (f"{feitas} de {total} imagens baixadas" if total
            else "lendo a lista de cartas")
    destino = (caminho or f"/orders/{order_id}/pdf") + (f"?token={token}" if token else "")
    quem = rotulo or f"Pedido {order_id}"
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
      {quem}: {onde} ({decorrido}s). As artes vêm do Google Drive e
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


@app.get("/impressora/tinta")
def ink_level():
    """Nível de tinta da impressora, pra tela avisar quando vai demorar.

    Público de propósito — é a mesma informação que o aviso na página já dá,
    e ela precisa carregar antes de qualquer pedido. Por isso a resposta não
    leva endereço de CUPS nem nome de fila (ver `tinta.estado`), e a consulta
    de verdade fica em cache: quem abre a página não vira uma pergunta nova
    pra impressora.
    """
    return tinta.estado()


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


@app.get("/admin/tinta")
def ink_diagnostics(x_admin_token: str | None = Header(default=None)):
    """O que a impressora respondeu sobre tinta, cru.

    Serve pra responder "esse modelo informa o nível?" sem abrir terminal:
    se não vier nenhum `marker-*`, ele não informa, e o aviso da página passa
    a depender do `TINTA_ESTADO` no .env.
    """
    _check_admin(x_admin_token)
    return tinta.diagnostico()


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


# --- Tela de pedidos (app/static/admin.html) -------------------------------
#
# A página em si é só a casca: HTML, CSS e JS, sem nenhum dado de pedido
# dentro. TUDO que ela mostra vem das rotas abaixo, e todas passam pelo
# `_check_admin` — quem abrir /admin sem o token não vê pedido nenhum, só o
# pedido de token. É por isso que servir o arquivo estático publicamente não
# é problema: o que se protege é o dado, não o layout.


@app.get("/admin", response_class=HTMLResponse)
def admin_page():
    """Serve a tela de pedidos. Fica antes do mount estático pra a URL ser
    /admin, sem o .html."""
    return FileResponse("app/static/admin.html", media_type="text/html")


@app.get("/admin/sessao")
def admin_session(x_admin_token: str | None = Header(default=None)):
    """Só diz se o token vale. A tela chama isto ao abrir (e ao colar um
    token novo) pra saber se mostra a lista ou o formulário de entrada, sem
    ter que pedir a lista inteira só pra descobrir isso."""
    _check_admin(x_admin_token)
    return {"ok": True, "impressora": printer.PRINTER_QUEUE or None,
            "email_configurado": notify.is_configured()}


@app.get("/admin/pedidos")
def admin_list_orders(status: str | None = None, busca: str | None = None,
                      limite: int = 200,
                      x_admin_token: str | None = Header(default=None)):
    """Todos os pedidos, do mais novo pro mais antigo, com os contadores por
    estado e o link assinado de conferir o PDF de cada um.

    O link vai relativo (`base=""`): a tela está no mesmo servidor, e o
    PUBLIC_BASE_URL é o domínio de fora, que num acesso pela rede local pode
    nem resolver.
    """
    _check_admin(x_admin_token)
    pedidos = storage.list_orders(status=status, busca=busca, limite=limite)
    for pedido in pedidos:
        try:
            pedido["pdf_url"] = fulfillment.pdf_url(pedido["id"], base="")
            pedido["pdf_url_local"] = fulfillment.pdf_url_local(pedido["id"])
        except RuntimeError:
            # Sem ADMIN_TOKEN não dá pra assinar link nenhum — mas aí nem se
            # chega aqui, porque o _check_admin já teria barrado. Fica pelo
            # caso de a configuração mudar com o processo no ar.
            pedido["pdf_url"] = pedido["pdf_url_local"] = None
    return {"contagem": storage.count_by_status(), "pedidos": pedidos}


@app.get("/admin/pedidos/{order_id}")
def admin_get_order(order_id: str,
                    x_admin_token: str | None = Header(default=None)):
    """Um pedido só, pra tela atualizar a linha depois de uma ação sem
    recarregar a lista inteira."""
    _check_admin(x_admin_token)
    pedido = storage.get_order(order_id)
    if not pedido:
        raise HTTPException(404, "Pedido não encontrado.")
    try:
        pedido["pdf_url"] = fulfillment.pdf_url(order_id, base="")
        pedido["pdf_url_local"] = fulfillment.pdf_url_local(order_id)
    except RuntimeError:
        pedido["pdf_url"] = pedido["pdf_url_local"] = None
    return pedido


@app.post("/admin/pedidos/{order_id}/status")
def admin_set_status(order_id: str, status: str = Form(...),
                     x_admin_token: str | None = Header(default=None)):
    """Muda o estado de um pedido na mão.

    Serve pros casos que o fluxo normal não cobre: marcar como pago um Pix
    que caiu sem o cliente avisar, cancelar um pedido abandonado, ou desfazer
    um clique errado voltando pra 'pending'.

    Marcar como 'paid' por aqui NÃO imprime nada — quem imprime é o botão de
    imprimir, que é uma ação separada de propósito (papel e tinta não voltam).
    """
    _check_admin(x_admin_token)
    try:
        mudou = storage.set_status(order_id, status)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not mudou:
        raise HTTPException(404, "Pedido não encontrado.")
    log.evento("admin", "mudou-status", pedido=order_id, status=status)
    return storage.get_order(order_id)


@app.post("/admin/pedidos/{order_id}/pdf")
def admin_build_pdf(order_id: str, fresh: bool = False,
                    x_admin_token: str | None = Header(default=None)):
    """Manda montar a folha (ou diz como está a montagem em andamento).

    Devolve o mesmo `{"estado": "pronto"|"montando"|"erro"}` do link do
    e-mail, e a tela fica chamando isto enquanto for "montando" pra mostrar o
    progresso — pedido grande leva minutos baixando as artes do Drive.
    """
    _check_admin(x_admin_token)
    if not storage.get_order(order_id):
        raise HTTPException(404, "Pedido não encontrado.")
    estado = fulfillment.request_pdf(order_id, fresh=fresh)
    # O caminho no disco não interessa pra tela e é caminho de dentro do
    # container — sai da resposta.
    return {k: v for k, v in estado.items() if k != "path"}


@app.post("/admin/pedidos/{order_id}/imprimir")
def admin_print(order_id: str,
                x_admin_token: str | None = Header(default=None)):
    """Mesmo efeito do link "Imprimir" do e-mail: marca pago e manda pra fila.

    É a única ação da tela que gasta papel, então o botão pede confirmação do
    outro lado. Aqui roda síncrono igual ao link, pra resposta já dizer se o
    CUPS aceitou.
    """
    _check_admin(x_admin_token)
    order = storage.get_order(order_id)
    if not order:
        raise HTTPException(404, "Pedido não encontrado.")
    ja_pago = order["status"] == "paid"
    try:
        pdf_path, falhas, print_status = fulfillment.run_print_job(order_id)
    except printer.PrintError as e:
        raise HTTPException(502, f"O pedido foi marcado como pago e o PDF "
                                 f"está pronto, mas o CUPS recusou: {e}")
    if not printer.PRINTER_QUEUE:
        mensagem = ("Pagamento confirmado e PDF pronto. A impressão automática "
                    "está desligada (PRINTER_QUEUE vazia), então nada foi pra "
                    "fila — use o botão Ver PDF e imprima de onde preferir.")
    else:
        mensagem = f"{print_status}."
    if ja_pago:
        mensagem += " Esse pedido já tinha sido confirmado antes."
    if falhas:
        mensagem += (f" ATENÇÃO: {falhas} carta(s) não baixaram do Drive e "
                     f"saíram como quadro de falha no papel.")
    log.evento("admin", "imprimiu", pedido=order_id, falhas=falhas,
               arquivo=os.path.basename(pdf_path))
    return {"ok": True, "mensagem": mensagem, "falhas": falhas,
            "pedido": storage.get_order(order_id)}


# --- Combinar pedidos numa folha só ----------------------------------------
#
# Pedido pequeno desperdiça papel: 4 cartas ocupam uma folha inteira e deixam
# 5 slots em branco. Marcando vários na tela, as filas de impressão deles
# viram uma fila corrida e só a última folha do conjunto sai incompleta.
#
# O que NÃO muda: o valor de cada pedido (foi o combinado com o cliente) e o
# estado de cada um (o combo não tem estado próprio — quem fica 'paid' são os
# pedidos, todos de uma vez, quando a folha vai pra impressora).


def _pedidos_do_combo(order_ids: list[str]) -> list[dict]:
    """Valida a seleção e devolve os pedidos NA ORDEM DE IMPRESSÃO.

    A ordem é a de criação (mais antigo primeiro), não a que a tela mandou:
    assim a mesma escolha sempre monta a mesma folha, e quem esperou mais sai
    primeiro no papel.
    """
    ids = [i for i in dict.fromkeys(x.strip() for x in order_ids) if i]
    if len(ids) < 2:
        raise HTTPException(400, "Escolha pelo menos dois pedidos pra combinar.")

    pedidos = []
    for order_id in ids:
        pedido = storage.get_order(order_id)
        if not pedido:
            raise HTTPException(404, f"Pedido {order_id} não encontrado.")
        pedidos.append(pedido)

    cancelados = [p["id"] for p in pedidos if p["status"] == "cancelado"]
    if cancelados:
        raise HTTPException(400, "Pedido cancelado não entra em folha "
                                 f"combinada: {', '.join(cancelados)}.")

    # A laminação é uma propriedade da FOLHA, não da carta: a folha inteira
    # passa (ou não) pela plastificadora dos dois lados. Misturar 'single' com
    # 'double' no mesmo papel entregaria acabamento errado pra metade da
    # gente, e não tem como desfazer depois de laminado.
    laminacoes = {p["lamination"] for p in pedidos}
    if len(laminacoes) > 1:
        raise HTTPException(
            400, "Só dá pra combinar pedidos com a mesma laminação — nesta "
                 "seleção tem " + " e ".join(sorted(laminacoes)) + ".")

    pedidos.sort(key=lambda p: (p["created_at"] or 0, p["id"]))
    return pedidos


def _resposta_combo(combo_id: str, pedidos: list[dict]) -> dict:
    """O que a tela precisa saber de uma combinação."""
    resumo = calc.resumo_combinado(pedidos)
    try:
        url = fulfillment.combo_pdf_url(combo_id, base="")
        url_local = fulfillment.combo_pdf_url_local(combo_id)
    except RuntimeError:
        url = url_local = None
    return {
        "id": combo_id,
        "lamination": pedidos[0]["lamination"] if pedidos else None,
        "pedidos": [{"id": p["id"], "customer_name": p["customer_name"],
                     "status": p["status"], "pages": p["pages"],
                     "amount": p["amount"]} for p in pedidos],
        "valor_total": round(sum(float(p["amount"] or 0) for p in pedidos), 2),
        "pdf_url": url,
        "pdf_url_local": url_local,
        **resumo,
    }


@app.post("/admin/combos")
def admin_criar_combo(ids: str = Form(...),
                      x_admin_token: str | None = Header(default=None)):
    """Cria (ou reaproveita) a combinação dos pedidos em `ids`, separados por
    vírgula, e devolve quanto papel ela economiza.

    Não monta PDF nenhum aqui: só a conta e o mapa de quem cai em qual folha,
    pra tela mostrar antes de o operador decidir. Montar é o passo seguinte.

    Escolher os mesmos pedidos de novo cai na mesma combinação e reaproveita
    a folha já montada — o id sai do conjunto, não do clique.
    """
    _check_admin(x_admin_token)
    pedidos = _pedidos_do_combo(ids.split(","))
    combo_id = storage.save_combo([p["id"] for p in pedidos])
    log.evento("admin", "combinou-pedidos", combo=combo_id,
               pedidos=len(pedidos))
    return _resposta_combo(combo_id, pedidos)


@app.get("/admin/combos/{combo_id}")
def admin_get_combo(combo_id: str,
                    x_admin_token: str | None = Header(default=None)):
    """Uma combinação já criada, com os pedidos dela no estado de agora."""
    _check_admin(x_admin_token)
    combo = storage.get_combo(combo_id)
    if not combo:
        raise HTTPException(404, "Combinação não encontrada.")
    pedidos = [p for p in (storage.get_order(i) for i in combo["order_ids"]) if p]
    resposta = _resposta_combo(combo_id, pedidos)
    # Pedido apagado depois de a folha ter sido combinada: a montagem vai
    # recusar, e é melhor a tela saber disso antes de gastar minutos baixando.
    resposta["faltando"] = [i for i in combo["order_ids"]
                            if i not in {p["id"] for p in pedidos}]
    return resposta


@app.post("/admin/combos/{combo_id}/pdf")
def admin_build_combo_pdf(combo_id: str, fresh: bool = False,
                          x_admin_token: str | None = Header(default=None)):
    """Manda montar a folha combinada (ou diz como vai a montagem).

    Mesmo `{"estado": "pronto"|"montando"|"erro"}` da folha de um pedido só,
    e a tela fica chamando isto enquanto for "montando".
    """
    _check_admin(x_admin_token)
    if not storage.get_combo(combo_id):
        raise HTTPException(404, "Combinação não encontrada.")
    estado = fulfillment.request_combo_pdf(combo_id, fresh=fresh)
    resposta = {k: v for k, v in estado.items() if k != "path"}
    if estado["estado"] == "pronto":
        mapa = fulfillment.mapa_combo(combo_id)
        if mapa:
            resposta["mapa"] = mapa
    return resposta


@app.post("/admin/combos/{combo_id}/imprimir")
def admin_print_combo(combo_id: str,
                      x_admin_token: str | None = Header(default=None)):
    """Manda a folha combinada pra fila e marca TODOS os pedidos dela como pagos.

    É um papel só com as cartas de várias pessoas, então não existe imprimir
    metade: ou o conjunto inteiro é confirmado, ou nenhum. Confira os Pix de
    todos antes — a tela pede confirmação do outro lado.
    """
    _check_admin(x_admin_token)
    combo = storage.get_combo(combo_id)
    if not combo:
        raise HTTPException(404, "Combinação não encontrada.")
    try:
        pdf_path, falhas, print_status, ids = fulfillment.run_combo_print_job(combo_id)
    except printer.PrintError as e:
        raise HTTPException(502, f"Os pedidos foram marcados como pagos e a "
                                 f"folha está pronta, mas o CUPS recusou: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))

    if not printer.PRINTER_QUEUE:
        mensagem = (f"{len(ids)} pedido(s) confirmados e folha combinada pronta. "
                    f"A impressão automática está desligada (PRINTER_QUEUE "
                    f"vazia), então nada foi pra fila — use Ver PDF combinado e "
                    f"imprima de onde preferir.")
    else:
        mensagem = f"{print_status}. {len(ids)} pedido(s) marcados como pagos."
    if falhas:
        mensagem += (f" ATENÇÃO: {falhas} carta(s) não baixaram do Drive e "
                     f"saíram como quadro de falha no papel.")
    log.evento("admin", "imprimiu-combinado", combo=combo_id, falhas=falhas,
               pedidos=len(ids), arquivo=os.path.basename(pdf_path))
    return {"ok": True, "mensagem": mensagem, "falhas": falhas, "pedidos": ids}


@app.delete("/admin/combos/{combo_id}")
def admin_delete_combo(combo_id: str,
                       x_admin_token: str | None = Header(default=None)):
    """Esquece a combinação e apaga a folha montada dela.

    Os pedidos NÃO são tocados: desfazer uma combinação é só jogar fora um
    arranjo de papel, e cada pedido continua com o estado que tinha.
    """
    _check_admin(x_admin_token)
    existia = storage.delete_combo(combo_id)
    tinha_pdf = fulfillment.descartar_combo_pdf(combo_id)
    if not existia and not tinha_pdf:
        raise HTTPException(404, "Combinação não encontrada.")
    log.evento("admin", "desfez-combinado", combo=combo_id, pdf=tinha_pdf)
    return {"ok": True, "pdf_apagado": tinha_pdf}


@app.delete("/admin/pedidos/{order_id}")
def admin_delete_order(order_id: str,
                       x_admin_token: str | None = Header(default=None)):
    """Apaga o pedido de vez, junto com o PDF montado.

    O XML do deck vive só aqui, então isso não tem volta — por isso a tela
    pede o id digitado antes de chamar. Pra tirar da frente sem perder o
    histórico, o caminho é cancelar.
    """
    _check_admin(x_admin_token)
    if not storage.delete_order(order_id):
        raise HTTPException(404, "Pedido não encontrado.")
    tinha_pdf = fulfillment.descartar_pdf(order_id)
    log.evento("admin", "apagou-pedido", pedido=order_id, pdf=tinha_pdf)
    return {"ok": True, "pdf_apagado": tinha_pdf}


@app.post("/admin/cleanup")
def run_cleanup(x_admin_token: str | None = Header(default=None)):
    """Roda a faxina dos PDFs antigos na hora, sem esperar o ciclo diário."""
    _check_admin(x_admin_token)
    return cleanup.run_once()


# Serve o front-end (app/static/index.html) na raiz. Fica depois das rotas
# da API de propósito — assim /orders, /admin/... continuam resolvendo
# certo, e qualquer outro caminho cai no arquivo estático.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
