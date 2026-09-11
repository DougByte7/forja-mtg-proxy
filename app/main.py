import hashlib
import hmac
import json
import os
import re
import threading
import time

from fastapi import (Body, Cookie, Depends, FastAPI, Form, Header,
                     HTTPException, Request, Response, UploadFile)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (FileResponse, HTMLResponse, PlainTextResponse,
                               Response, StreamingResponse)
from fastapi.staticfiles import StaticFiles

from . import (artes, calc, cambio, cartas, cleanup, cotacao_job, decks,
               detalhe_carta, edhrec, fulfillment, importar, log, manabase,
               mpcfill, notify, pix, poder, printer, spellbook, storage, tinta,
               usuarios, visitas)

app = FastAPI(title="Forja de Proxies — backend")

# Origens permitidas. Deixou de ser "*" quando o login entrou: com cookie de
# sessão, "*" seria o convite pra qualquer página da internet fazer pedido em
# nome de quem está logado aqui. O navegador recusa `*` junto de credenciais,
# então isto também é o que faz o cookie funcionar de verdade.
#
# Vazio = só mesma origem, que é o caso normal: as telas são servidas por este
# mesmo servidor. As duas bases já existem no `.env` pros links do e-mail.
# `or` e não o default do `.get`: a variável existe no .env como `CORS_ORIGENS=`,
# e aí o `.get` devolve string vazia — não o default. Sem isto, "vazio" viraria
# lista vazia (nenhuma origem permitida) em vez do que o .env promete.
_ORIGENS = [o.strip() for o in (
    os.environ.get("CORS_ORIGENS", "").strip()
    or ",".join(filter(None, [os.environ.get("PUBLIC_BASE_URL", ""),
                              os.environ.get("LOCAL_BASE_URL", "")]))
).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGENS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PIX_KEY = os.environ.get("PIX_KEY", "")
MERCHANT_NAME = os.environ.get("MERCHANT_NAME", "FORJA DE PROXIES")
MERCHANT_CITY = os.environ.get("MERCHANT_CITY", "ITAIOPOLIS")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

# Janela pra não mandar 10 e-mails se o cliente ficar clicando no botão.
NOTIFY_COOLDOWN_SECONDS = 120


COOKIE_SESSAO = "forja_sessao"
# `secure` desligável porque a mesma página roda em http:// na rede local (é
# pra isso que o LOCAL_BASE_URL existe). Com secure=True em http o navegador
# simplesmente NÃO GRAVA o cookie, sem erro nenhum — e o login "não funciona"
# sem nada na tela explicando por quê.
SESSAO_SEGURA = os.environ.get("SESSAO_SEGURA", "1") == "1"


def quem_e(forja_sessao: str | None = Cookie(default=None)) -> dict | None:
    """Quem está pedindo, ou `None` pra anônimo — que NÃO é erro.

    É a peça que faz o login ser ADITIVO: nenhuma rota fica fechada por causa
    dela. Sem cookie, o sistema se comporta exatamente como antes de existir
    conta neste projeto.
    """
    return usuarios.da_sessao(forja_sessao) if forja_sessao else None


def exige_login(quem: dict | None = Depends(quem_e)) -> dict:
    """Pras poucas rotas que não fazem sentido sem conta ("os meus")."""
    if not quem:
        raise HTTPException(401, "Entre na sua conta pra ver isso.")
    return quem


def _pode_mexer(dono: str | None, quem: dict | None) -> bool:
    """Quem pode gravar e apagar. UMA função, vale pra deck e pra pedido.

    * SEM dono -> qualquer um, inclusive anônimo. É o sistema de sempre:
      quem tem o id, mexe.
    * COM dono -> só o dono e o admin. O link continua ABRINDO pra qualquer
      um, porque compartilhar deck é a razão de o link existir; o que fecha é
      gravar e apagar.

    Ler nunca passa por aqui, de propósito.
    """
    if not dono:
        return True
    if not quem:
        return False
    return quem["id"] == dono or quem.get("perfil") == "admin"


def _proibido():
    return HTTPException(403, "Este deck é de outra pessoa. Você pode abrir e "
                              "duplicar, mas não alterar.")


def _check_admin(x_admin_token: str | None, quem: dict | None = None):
    """A porta do operador. Duas chaves abrem, e as duas continuam existindo.

    O `ADMIN_TOKEN` do `.env` é a chave da CASA: funciona de `curl`, sem
    cookie e sem banco, e é o que ainda abre o painel quando a tabela de
    usuários está vazia (como todo deploy novo começa) ou quando alguém
    esquece a senha. A sessão de um usuário `admin` é a chave do dia a dia.

    `quem` tem valor padrão pra as dezoito chamadas que já existiam seguirem
    valendo sem serem tocadas: mexer nas dezoito no mesmo commit que introduz
    sessão é como se deixa uma delas aberta por engano.

    `compare_digest` e não `!=`: comparação que sai no primeiro byte diferente
    conta quanto tempo levou, e isso basta pra adivinhar o token byte a byte.
    """
    if quem and quem.get("perfil") == "admin":
        return
    if ADMIN_TOKEN and x_admin_token and \
            hmac.compare_digest(str(x_admin_token), ADMIN_TOKEN):
        return
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
    ("POST", "/cancel"): "cancelou o pedido",
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
    decks.init_db()
    cartas.init_db()
    usuarios.init_db()
    artes.init_db()
    # Só faz alguma coisa se não existir conta nenhuma — ver `semear_admin`.
    usuarios.semear_admin()
    cleanup.start_background()
    # Monta a base de cartas se ela estiver vazia ou velha, em segundo plano.
    # Sem isto o deckbuilder nasce sem carta nenhuma e dependeria de alguém
    # lembrar de rodar o sync na mão depois de cada container novo.
    cartas.start_background()
    log.evento("app", "subiu", log_dir=log.DIR, nivel=log.NIVEL,
               fontes=", ".join(f["id"] for f in cotacao_job.fontes_ativas())
                      or "nenhuma",
               cartas=cartas.estado().get("cartas", 0))


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


@app.get("/pedidos/meus")
def meus_pedidos(quem: dict = Depends(exige_login)):
    """Os pedidos desta conta, de qualquer aparelho."""
    return {"pedidos": storage.list_by_dono(quem["id"])}


@app.post("/pedidos/reclamar")
def reclamar_pedidos(corpo: dict = Body(default={}),
                     quem: dict = Depends(exige_login)):
    """Vira dono dos pedidos que a pessoa já tinha no navegador.

    A home chama isto sozinha ao abrir, com a lista do `localStorage`, e em
    silêncio: é recado, não serviço. Se falhar, a tela segue exatamente como
    antes — os pedidos continuam abrindo pelo id, como sempre.

    Só pega o que está ÓRFÃO (ver `storage.reclamar`): pedido que já é de
    outra pessoa não é tocado nem vira erro. Dois irmãos num computador só é
    um caso real, não uma hipótese.

    A prova de posse é ter o id, que é o nível em que este sistema já opera —
    `POST /orders/{id}/cancel` é aberta pelo mesmo motivo. E aqui a
    reclamação é rotulagem ADITIVA: ela não fecha nenhuma rota que estava
    aberta.
    """
    ids = corpo.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(400, "Manda a lista de ids em `ids`.")
    reclamados = storage.reclamar(ids, quem["id"])
    if reclamados:
        log.evento("pedido", "reclamou", quantos=len(reclamados), por=quem["id"])
    return {"reclamados": reclamados}


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


@app.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str):
    """
    O cliente desistiu, pela tela "Meus pedidos" dele.

    Só vale enquanto o pedido está em 'pending' — ou seja, enquanto ninguém
    do outro lado ficou sabendo dele. Depois que o aviso de pagamento saiu, o
    operador já está conferindo Pix, e desfazer isso sozinho pela tela viraria
    um jeito de sumir com um pedido que talvez já esteja pago: daí em diante o
    caminho é falar comigo.

    Cancelar não apaga nada: o pedido sai da lista de abertos e continua no
    histórico do admin (`storage.set_status`).

    Sem token: quem tem o id do pedido é quem pode mexer nele, a mesma regra
    do notify-payment. O id são 8 dígitos hex (`storage.create_order`), então
    dá pra chutar — o estrago possível é anular a cobrança de um pedido que
    ninguém ainda avisou como pago, e ele continua no histórico do admin
    marcado como cancelado. Se um dia isso incomodar, o caminho é o mesmo do
    PDF: link assinado (`_authorize`), não token de admin.
    """
    order = storage.get_order(order_id)
    if not order:
        raise HTTPException(404, "Pedido não encontrado.")
    if order["status"] == "cancelado":
        return {"status": "cancelado",
                "message": "Esse pedido já estava cancelado."}
    if order["status"] != "pending":
        raise HTTPException(
            409,
            "Esse pedido já saiu do aguardando pagamento, então não dá mais "
            "pra cancelar por aqui — me chama pelo contato de sempre.")

    storage.set_status(order_id, "cancelado")
    log.evento("pedido", "cancelado-pelo-cliente", pedido=order_id,
               cliente=order["customer_name"], deck=order["deck_hash"])
    return {"status": "cancelado",
            "message": "Pedido cancelado. Nada foi enviado pra impressão."}


def _authorize(purpose: str, order_id: str, token: str | None,
               x_admin_token: str | None, quem: dict | None = None) -> dict:
    """Valida o link assinado (ou o admin) e devolve o pedido.

    Três chaves abrem, e nenhuma substitui as outras: o link assinado do
    e-mail (que é como o operador chega aqui do celular), o `ADMIN_TOKEN` e a
    sessão de um usuário `admin` — esta última pra quem já entrou no painel
    não precisar de mais nada pra abrir um PDF a partir dele.

    `compare_digest` e não `==`: mesmo motivo do `_check_admin`.
    """
    authorized = bool(quem and quem.get("perfil") == "admin")
    if not authorized and x_admin_token and ADMIN_TOKEN:
        authorized = hmac.compare_digest(str(x_admin_token), ADMIN_TOKEN)
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
             x_admin_token: str | None = Header(default=None),
             quem: dict | None = Depends(quem_e)):
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
    _authorize("view", order_id, token, x_admin_token, quem)
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
                   x_admin_token: str | None = Header(default=None),
                   quem: dict | None = Depends(quem_e)):
    """A folha combinada (vários pedidos num papel só), pra conferir.

    Mesmo comportamento do `/orders/{id}/pdf`: monta em segundo plano se ainda
    não existir, devolve uma página que se atualiza sozinha enquanto monta, e
    serve o arquivo inline quando fica pronto.

    O token é assinado sobre `combo:<id>`, então o link de conferir um pedido
    não abre a folha combinada e vice-versa. Conferir não imprime nada nem
    marca pedido nenhum como pago.
    """
    # As mesmas três chaves do `_authorize`: sessão de admin, token da casa e
    # o link assinado do e-mail.
    autorizado = bool(quem and quem.get("perfil") == "admin")
    if not autorizado and x_admin_token and ADMIN_TOKEN:
        autorizado = hmac.compare_digest(str(x_admin_token), ADMIN_TOKEN)
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
                x_admin_token: str | None = Header(default=None),
                quem: dict | None = Depends(quem_e)):
    """
    Link "Imprimir" do e-mail. Reaproveita o PDF já conferido, marca o
    pedido como pago e manda pra fila da impressora. Aceita o token assinado
    da querystring (o do e-mail) ou o header X-Admin-Token, pra disparar na
    mão quando precisar.
    """
    order = _authorize("print", order_id, token, x_admin_token, quem)
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


# --- Deckbuilder de Commander (app/static/deckbuilder.html) ----------------
#
# Uma tela pra MONTAR o deck, separada da que orça a impressão. As duas se
# encontram no fim: o deck montado aqui vira uma decklist de texto que se cola
# no MPC Fill, e o XML que sai de lá é o que sobe no orçamento de sempre.
#
# A busca não fala com a Scryfall: ela lê a cópia local do bulk data (ver
# `cartas.py`), porque busca-a-cada-tecla contra a API de fora seria o jeito
# mais rápido de levar 429 em cima de quem só está digitando.
#
# O CSS e os módulos JS moram em `app/static/deckbuilder/` e
# `app/static/comum/`, e a página sai daqui com a versão de cada arquivo
# (`?v=` + hash do conteúdo) e com `no-cache`. É esse par que impede um deploy
# de misturar HTML novo com JS velho: o navegador sempre confere a página, e
# ela aponta pra versão exata de cada arquivo — que, com o hash na URL, pode
# ficar no cache à vontade.
#
# O `src` e o `href` da página ganham a versão direto. Os `import` de dentro
# dos módulos não passam por aqui: quem os versiona é o importmap, que leva a
# URL de cada módulo pra URL com versão. O `modulepreload` vai junto pra o
# navegador pedir os módulos todos de uma vez, e não um nível do grafo por
# viagem de rede.

_PASTAS_DO_DECKBUILDER = ("deckbuilder", "comum")
_ARQUIVO_DO_DECKBUILDER = re.compile(
    r'(src|href)="(/(?:deckbuilder|comum)/[^"?]+)"')
_IMPORTMAP_VAZIO = '<script type="importmap">{"imports": {}}</script>'


def _versionada(url):
    """`/deckbuilder/x.js` → `/deckbuilder/x.js?v=<hash do conteúdo>`."""
    with open(os.path.join("app/static", url.lstrip("/")), "rb") as f:
        return f"{url}?v={hashlib.sha256(f.read()).hexdigest()[:12]}"


def _importmap_do_deckbuilder():
    versoes = {url: _versionada(url) for url in sorted(
        f"/{pasta}/{nome}" for pasta in _PASTAS_DO_DECKBUILDER
        for nome in os.listdir(os.path.join("app/static", pasta))
        if nome.endswith(".js"))}
    return "\n".join(
        [f'<script type="importmap">{json.dumps({"imports": versoes})}</script>']
        + [f'<link rel="modulepreload" href="{v}">' for v in versoes.values()])


@app.get("/deckbuilder", response_class=HTMLResponse)
def deckbuilder_page():
    """A página do deckbuilder. Igual ao /admin: fica antes do mount estático
    pra a URL ser /deckbuilder, sem o .html."""
    with open("app/static/deckbuilder.html", encoding="utf-8") as f:
        html = f.read()
    html = _ARQUIVO_DO_DECKBUILDER.sub(
        lambda m: f'{m[1]}="{_versionada(m[2])}"', html)
    html = html.replace(_IMPORTMAP_VAZIO, _importmap_do_deckbuilder())
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------------------
# Conta
# ---------------------------------------------------------------------------

@app.get("/entrar")
def pagina_de_entrar():
    """A tela de login. Rota própria pra a URL não ter .html, como as outras."""
    return FileResponse("app/static/entrar.html", media_type="text/html")


@app.get("/conta")
def conta_atual(quem: dict | None = Depends(quem_e)):
    """Quem está logado, ou `{"usuario": null}`.

    200 com `null` pra anônimo, e NÃO 401, de propósito: é a rota que toda
    página chama ao abrir, e um 401 por carregamento ensina o operador a
    ignorar o console — junto com os erros que importam.
    """
    return {"usuario": quem}


@app.post("/conta/entrar")
def conta_entrar(resposta: Response, request: Request,
                 corpo: dict = Body(default={})):
    """Confere a senha e abre a sessão, devolvendo o cookie.

    Não existe cadastro aberto neste sistema: conta é criada pelo admin. O
    README abre dizendo que isto não é uma loja — é ferramenta privada, de um
    grupo de jogo —, e um `/conta/criar` público é a primeira coisa que um bot
    encontra.
    """
    try:
        aberta = usuarios.entrar(
            corpo.get("login", ""), corpo.get("senha", ""),
            lembrar=bool(corpo.get("lembrar")),
            agente=request.headers.get("user-agent", ""))
    except PermissionError as e:
        raise HTTPException(429, str(e))
    if aberta is None:
        # Uma mensagem só pros dois casos (login inexistente e senha errada):
        # respostas diferentes transformam esta tela num conferidor de quais
        # contas existem.
        raise HTTPException(401, "Login ou senha não conferem.")

    usuario, token, duracao = aberta
    resposta.set_cookie(
        COOKIE_SESSAO, token, max_age=duracao, httponly=True,
        samesite="lax", path="/", secure=SESSAO_SEGURA)
    return {"usuario": usuario}


@app.post("/conta/sair")
def conta_sair(resposta: Response,
               forja_sessao: str | None = Cookie(default=None)):
    """Encerra a sessão deste aparelho. Sem token, não é erro: sair de onde já
    se está fora é o resultado que a pessoa queria."""
    usuarios.sair(forja_sessao)
    resposta.delete_cookie(COOKIE_SESSAO, path="/")
    return {"ok": True}


@app.post("/conta/senha")
def conta_senha(corpo: dict = Body(default={}),
                quem: dict = Depends(exige_login)):
    """Troca a própria senha. Pede a atual: um cookie roubado não pode virar
    troca de senha, que é o que transformaria um acesso temporário em
    permanente."""
    if not usuarios.entrar(quem["login"], corpo.get("atual", "")):
        raise HTTPException(403, "A senha atual não confere.")
    try:
        usuarios.trocar_senha(quem["id"], corpo.get("nova", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    # `trocar_senha` derruba TODAS as sessões, inclusive esta: é o que se
    # espera de trocar senha, e é o que faz a troca servir pra alguma coisa
    # quando o motivo dela foi desconfiança.
    return {"ok": True, "saiu_de_todos": True}


@app.get("/meus-decks")
def pagina_de_decks():
    """A tela que lista os decks. Serve o HTML por rota própria, e não pelo
    mount de estáticos, pra a URL ser /meus-decks, sem o .html — igual ao
    /deckbuilder.

    Página e recurso separados, como no admin (`/admin` é a casca, os dados
    vêm de `/admin/pedidos`): o HTML aqui não tem deck nenhum dentro. Quais
    decks aparecem, quem decide é o navegador, com a lista que ele guarda —
    e é por isso que servir este arquivo publicamente não é problema.
    """
    return FileResponse("app/static/decks.html", media_type="text/html")


@app.get("/cartas/estado")
def cartas_estado():
    """Quantas cartas a base local tem e quando foi montada.

    Público, e a tela chama isso ao abrir: enquanto a primeira sincronização
    não termina, a busca não acha nada, e sem esta rota a tela não teria como
    dizer a diferença entre "carta não existe" e "a base ainda está vindo".
    """
    return cartas.estado()


@app.get("/cambio")
def cambio_atual():
    """Quantos reais vale um dólar, e de onde veio esse número.

    Público, e o deckbuilder chama ao abrir: o `preco_usd` da base local é
    dólar (é o bulk da Scryfall) e quem monta deck aqui pensa em real.

    A conversão que esta rota alimenta é de APRESENTAÇÃO. O número guardado
    continua em dólar, nada cobrado passa por aqui e o total de comprar tem
    fonte brasileira própria (`ligamagic.py`), que devolve real de verdade.
    O que a taxa muda é a RÉGUA com que o preço da base é lido, não o preço.

    Rota separada, e não mais um campo em `/cartas/estado`, de propósito:
    aquela é consultada em laço enquanto a base sincroniza, e os dois assuntos
    têm prazos diferentes (base: 24 h; câmbio: 6 h). Juntos, a taxa oscilaria
    no meio de uma sincronização por nenhuma razão.

    Nunca falha: sem rede, volta a taxa fixa do `.env` com `fonte: "fixa"`, e
    é a tela que escreve qual das duas aplicou.
    """
    return cambio.taxa()


@app.get("/cartas/busca")
def cartas_busca(q: str = "", identidade: str | None = None, tipo: str = "",
                 comandante: bool = False, limite: int = 40, texto: str = "",
                 cmc_min: float | None = None, cmc_max: float | None = None,
                 cores: str | None = None, preco_max: float | None = None,
                 ordem: str = ""):
    """Busca na base local. Sem token: é catálogo público de carta de Magic.

    `identidade` é a do comandante já escolhido — quando vem, some da lista
    toda carta que aquele deck não poderia jogar. Vir vazio (`?identidade=`)
    não é o mesmo que não vir: vazio é deck incolor, e aí só carta sem cor
    aparece.

    `texto` é a busca por efeito: cada palavra tem que aparecer no oracle da
    carta (em inglês, que é como o bulk data vem). O resto — `cmc_min`,
    `cmc_max`, `cores`, `preco_max`, `ordem` — são os filtros avançados da
    gaveta da tela; todos opcionais, e todos combinam entre si e com o nome.
    """
    return {"cartas": cartas.buscar(termo=q, identidade=identidade, tipo=tipo,
                                    comandante=comandante, limite=limite,
                                    texto=texto, cmc_min=cmc_min,
                                    cmc_max=cmc_max, cores=cores,
                                    preco_max=preco_max, ordem=ordem)}


@app.get("/cartas/detalhe")
def cartas_detalhe(nome: str):
    """A carta inteira pra modal do deckbuilder: o que a base local não guarda.

    Raridade, edição, artista, ambientação e as notas de regras (os rulings).
    Vem da API da Scryfall e fica em cache por um dia — ver
    `detalhe_carta.py`.

    Público como a busca, e pelo mesmo motivo: é catálogo de carta de Magic.
    Bater aqui em rajada não vira rajada na Scryfall — o `Freio` do
    `scryfall.py` serializa as chamadas, então o excesso fica lento aqui em
    vez de virar 429 lá.

    404 quer dizer que a Scryfall não conhece o nome OU que ela não respondeu.
    A tela trata os dois igual: a modal já está aberta com o que a base local
    sabe, e só deixa de ganhar as seções extras.
    """
    dados = detalhe_carta.detalhe(nome)
    if dados is None:
        raise HTTPException(404, "Não consegui os detalhes desta carta agora.")
    return dados


@app.get("/cartas/impressoes")
def cartas_impressoes(nome: str):
    """As impressões oficiais de uma carta, pra vitrine da escolha de arte.

    Pública pelo mesmo motivo do `/cartas/detalhe`: é catálogo de carta de
    Magic, não dado de ninguém.

    ISTO NÃO É O QUE VAI PRO PAPEL. Quem imprime é o arquivo do MPC Fill; a
    Scryfall aqui responde "que artes existem", pra a pessoa saber qual quer
    antes de procurar o arquivo dela.
    """
    lista = detalhe_carta.impressoes(nome)
    if lista is None:
        raise HTTPException(502, "Não consegui falar com a Scryfall agora. "
                                 "Tente de novo em alguns segundos.")
    return {"impressoes": lista}


@app.post("/artes/metadados")
def artes_metadados(corpo: dict = Body(default={})):
    """Os metadados de um punhado de ids de arte do MPC Fill.

    Fora de `/decks/{id}` de propósito: é consulta pura sobre ids, sem deck
    nenhum envolvido — a grade de miniaturas a chama enquanto a pessoa
    pagina, e a modal de carta também pode abrir sem deck salvo.
    """
    ids = corpo.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(400, "Manda a lista de ids em `ids`.")
    try:
        return {"artes": mpcfill.metadados(ids)}
    except mpcfill.MPCFillError as e:
        raise HTTPException(502, str(e))


@app.post("/admin/cartas/sync")
def cartas_sync(x_admin_token: str | None = Header(default=None),
                quem: dict | None = Depends(quem_e)):
    """Refaz a base de cartas na hora, sem esperar o ciclo diário.

    Com token porque baixa mais de 100 MB da Scryfall: é a única rota daqui
    que custa banda de verdade, e não é pra estar ao alcance de quem abrir a
    página. Roda em segundo plano — a resposta volta na hora com o andamento,
    que a tela do admin pode acompanhar por `GET /cartas/estado`.
    """
    _check_admin(x_admin_token, quem)
    if cartas.andamento()["rodando"]:
        return {"ok": True, "ja_rodando": True, **cartas.estado()}
    threading.Thread(target=cartas.sincronizar, daemon=True).start()
    return {"ok": True, "comecou": True, **cartas.estado()}


def _deck_completo(deck: dict) -> dict:
    """O deck do jeito que a tela consome: cartas resolvidas + validação."""
    return {
        "deck": decks.com_cartas(deck),
        "validacao": decks.validar(deck.get("comandantes"),
                                   deck.get("cartas")),
    }


def _deck_ou_404(deck_id: str) -> dict:
    deck = decks.obter(deck_id)
    if not deck:
        raise HTTPException(404, "Deck não encontrado.")
    return deck


@app.post("/decks/importar")
def importar_deck(corpo: dict = Body(default={})):
    """Traz um deck de fora: um link do Archidekt/Moxfield, ou a lista colada.

    NÃO cria deck nenhum. Devolve as cartas já resolvidas na base local e a
    tela decide o que fazer com elas — quem grava é o autosave de sempre,
    depois que a pessoa viu o que veio. Importar direto pra um id novo
    encheria o banco de deck que alguém importou pra olhar e fechar.

    O que a base local não conhece volta em `nao_encontradas` em vez de
    sumir: carta nova com a base atrasada é o caso comum, e a pessoa precisa
    saber quantas ficaram de fora antes de mandar imprimir.

    Falha vira 502 com a mensagem inteira, e a mensagem diz o que FAZER, não
    só o que deu errado: deck privado ou site recusando a consulta viram um
    recado que manda exportar a lista e colar no campo de texto, que é a
    saída que esta mesma janela oferece (ver `importar.py`).
    """
    url = (corpo.get("url") or "").strip()
    texto = (corpo.get("texto") or "").strip()
    if not url and not texto:
        raise HTTPException(400, "Mande o link do deck ou a lista em texto.")
    try:
        trazido = importar.de_url(url) if url else importar.de_texto(
            texto, corpo.get("nome") or "")
    except importar.ImportarError as e:
        raise HTTPException(502, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        pronto = decks.importado_para_deck(trazido)
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("deck", "importou", fonte=pronto["fonte"],
               cartas=len(pronto["cartas_completas"]),
               faltando=len(pronto["nao_encontradas"]))
    return pronto


@app.post("/decks/deck-medio")
def deck_medio(corpo: dict = Body(default={})):
    """O deck médio do EDHREC pro comandante, pronto pra virar o deck.

    `comandantes` são os nomes que a tela já tem; `bracket` (`exhibition` a
    `cedh`) e `orcamento` (`budget` ou `expensive`) são opcionais e
    estreitam os decks que entram na média.

    Mesmo contrato do `/decks/importar`, e de propósito: NÃO grava nada, e
    volta no formato que a tela já sabe aplicar, com o que a base local não
    conhece em `nao_encontradas`. `decks` diz de quantas listas saiu a média
    — uma média de doze decks se lê diferente de uma de quarenta mil.

    Endpoint NÃO OFICIAL do EDHREC, como o das sugestões: falha vira 502 com
    a mensagem (ver `edhrec.py`).
    """
    comandantes = corpo.get("comandantes") or []
    if not isinstance(comandantes, list):
        raise HTTPException(400, "`comandantes` precisa ser uma lista de nomes.")
    comandantes = [str(n).strip() for n in comandantes if str(n).strip()]
    if not comandantes:
        raise HTTPException(400, "Escolha o comandante primeiro: o deck médio "
                                 "é dele.")
    try:
        trazido = edhrec.deck_medio(
            comandantes,
            str(corpo.get("bracket") or "").strip() or None,
            str(corpo.get("orcamento") or "").strip() or None)
    except edhrec.EDHRECError as e:
        raise HTTPException(502, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    pronto = decks.importado_para_deck(trazido)
    return {**pronto, "decks": trazido["decks"], "cache": trazido["cache"]}


@app.post("/decks")
def criar_deck(corpo: dict = Body(default={}),
               quem: dict | None = Depends(quem_e)):
    """Cria um deck e devolve o id.

    Aberta pra qualquer um, com ou sem conta: quem tem o id, mexe. O id tem 12
    dígitos hex — mais que os 8 do pedido, porque aqui o estrago de acertar um
    por sorte é reescrever o deck de alguém (ver `decks.py`).

    Quem está logado nasce dono; anônimo cria deck órfão, que é como todo deck
    deste sistema existiu até o login aparecer.
    """
    try:
        deck = decks.criar(corpo.get("nome", ""), corpo.get("comandantes"),
                           corpo.get("cartas"), corpo.get("maybeboard"),
                           corpo.get("categorias"),
                           dono=quem["id"] if quem else None)
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("deck", "criou", deck=deck["id"])
    return _deck_completo(deck)


@app.post("/decks/resumo")
def resumo_de_decks(corpo: dict = Body(default={})):
    """Os metadados de vários decks de uma vez, pra tela `/meus-decks`.

    POST pra uma LEITURA, de propósito, e por dois motivos. O primeiro é que
    uma lista de dezenas de ids não cabe numa URL que vai parar em log de
    acesso, histórico do navegador e cabeçalho `Referer` — e neste sistema
    essa lista É a credencial: quem tem o id, mexe. O segundo é que `GET` com
    corpo é o que o Commander Spellbook faz, e a gente já achou estranho lá
    (ver `spellbook.py`); não vale repetir de dentro de casa.

    A rota é sobre ids que o cliente JÁ TEM. Ela nunca lista o banco: sem
    dono, "todos os decks" seria os decks de todo mundo. Lista vazia devolve
    lista vazia, e id que não existe não volta — cabe a quem chamou comparar
    o que pediu com o que recebeu pra saber o que sumiu.

    Declarada antes do `GET /decks/{deck_id}` porque o FastAPI casa por ordem:
    se ela viesse depois, um dia alguém acrescentaria um `GET` aqui e ele
    viraria, em silêncio, "o deck de id `resumo`".
    """
    ids = corpo.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(400, "Manda a lista de ids em `ids`.")
    if len(ids) > decks.MAX_RESUMO:
        # Não trunca: truncar esconderia decks sem dizer, e a tela mostraria
        # uma lista incompleta que parece completa.
        raise HTTPException(
            400, f"São até {decks.MAX_RESUMO} decks por consulta; "
                 f"vieram {len(ids)}.")

    achados = decks.resumo(ids)
    conhecidos = {d["id"] for d in achados}
    return {"decks": achados,
            "desconhecidos": [str(i) for i in ids if str(i) not in conhecidos]}


@app.get("/decks/meus")
def meus_decks(quem: dict = Depends(exige_login)):
    """Os decks desta conta, de qualquer aparelho.

    É o que o `POST /decks/resumo` não consegue dar: aquele responde sobre os
    ids que o navegador guardou, então um deck montado no celular não aparece
    no computador. Com dono, aparece.

    Declarada ANTES do `GET /decks/{deck_id}` porque o FastAPI casa por ordem
    de declaração: depois dele, esta rota viraria, em silêncio, "o deck de id
    `meus`" — e responderia 404 pra sempre.
    """
    return {"decks": decks.de(quem["id"])}


@app.post("/decks/{deck_id}/reclamar")
def reclamar_deck(deck_id: str, quem: dict = Depends(exige_login)):
    """Vira dono de um deck que não tem dono.

    Primeiro-a-chegar, e sem problema: reclamar um órfão não tira de ninguém
    nada que a pessoa tivesse. Antes da reclamação, qualquer um com o id já
    podia reescrever aquele deck; depois, só o dono e o admin. A reclamação
    REDUZ o conjunto de quem edita — ver o cabeçalho do `usuarios.py`.

    409 e não 403 quando o deck já é de alguém: não é "você não pode", é "essa
    ação não cabe mais neste deck", e a tela diz coisas diferentes pros dois.
    """
    try:
        deck = decks.reclamar(deck_id, quem["id"])
    except PermissionError as e:
        raise HTTPException(409, str(e))
    if deck is None:
        raise HTTPException(404, "Deck não encontrado.")
    return _deck_completo(deck)


@app.get("/decks/{deck_id}/artes")
def artes_do_deck(deck_id: str):
    """O que já foi escolhido neste deck, e o que continua no padrão."""
    return artes.para_deck(_deck_ou_404(deck_id))


@app.get("/decks/{deck_id}/pedido")
def pedido_do_deck(deck_id: str):
    """O deck pronto pra virar pedido: o XML que a tela de orçamento sobe no
    `POST /orders`, e o cartão do deck pra ela mostrar no lugar do upload.

    Deck com arte faltando volta 200, com `xml` nulo e a lista do que falta
    em `faltando`: não é erro de quem chamou, é um deck que ainda não está
    pronto, e a tela precisa dos nomes pra dizer o que escolher. O deckbuilder
    já não oferece o link nesse estado; esta é a conferência do lado de cá.
    """
    deck = _deck_ou_404(deck_id)
    montado = artes.pedido(deck)
    if not montado["cartas"]:
        raise HTTPException(400, "Este deck não tem carta nenhuma pra imprimir.")
    return {"deck": decks.resumo([deck["id"]])[0], **montado}


@app.put("/decks/{deck_id}/artes")
def escolher_arte(deck_id: str, corpo: dict = Body(default={}),
                  quem: dict | None = Depends(quem_e)):
    """Grava a arte de uma carta deste deck.

    Passa pela mesma regra de dono do autosave: deck órfão qualquer um mexe,
    deck com dono só o dono e o admin. Escolher arte é editar o deck.
    """
    _deck_ou_404(deck_id)
    existe, dono = decks.dono_de(deck_id)
    if not _pode_mexer(dono, quem):
        raise _proibido()
    try:
        escolha = artes.escolher(
            deck_id, corpo.get("nome", ""), corpo.get("drive_id", ""),
            face=corpo.get("face", "frente"), arquivo=corpo.get("arquivo", ""),
            fonte=corpo.get("fonte", ""), dpi=corpo.get("dpi", 0))
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("artes", "escolheu", deck=deck_id, carta=escolha["nome"])
    return {"escolha": escolha}


@app.delete("/decks/{deck_id}/artes")
def limpar_arte(deck_id: str, nome: str, face: str = "frente",
                quem: dict | None = Depends(quem_e)):
    """Volta uma carta pra arte padrão."""
    _deck_ou_404(deck_id)
    existe, dono = decks.dono_de(deck_id)
    if not _pode_mexer(dono, quem):
        raise _proibido()
    return {"ok": artes.limpar(deck_id, nome, face)}


@app.post("/decks/{deck_id}/artes/buscar")
def buscar_artes(deck_id: str, corpo: dict = Body(default={})):
    """Os ids de arte de cada carta — a consulta CARA, e só no clique.

    Uma requisição cobre o deck inteiro (ver `mpcfill.buscar`), e é por isso
    que ela existe como rota própria em vez de rodar junto do autosave: o deck
    muda a cada carta adicionada, e buscar automático viraria uma requisição
    por clique do usuário em cima de um serviço gratuito de outra pessoa.

    Sem `nomes` no corpo, busca o deck inteiro — que é o caso comum, o botão
    "escolher artes" do painel.
    """
    deck = _deck_ou_404(deck_id)
    nomes = corpo.get("nomes")
    if not isinstance(nomes, list) or not nomes:
        nomes = list(deck.get("comandantes") or []) + \
            [c["nome"] for c in deck.get("cartas") or []]
    try:
        por_nome = mpcfill.buscar(nomes)
        fontes = mpcfill.fontes()
    except mpcfill.MPCFillError as e:
        # 502 e nunca dicionário vazio: "não consegui perguntar" e "essa carta
        # não tem arte" são respostas opostas, e a segunda faria a pessoa
        # desistir de uma carta que tem quinhentas.
        raise HTTPException(502, str(e))
    return {"por_nome": por_nome, "fontes": fontes}


@app.post("/decks/{deck_id}/artes/revalidar")
def revalidar_artes(deck_id: str):
    """Confere se os ids guardados ainda existem na biblioteca do MPC Fill.

    O caminho de volta de um id que envelheceu: arquivo removido de lá vira,
    no PDF, o retângulo vermelho de "FALHA NO DOWNLOAD", e descobrir isso
    depois de a pessoa ter pago é o pior resultado que este sistema sabe
    produzir.
    """
    _deck_ou_404(deck_id)
    try:
        return artes.revalidar(deck_id)
    except mpcfill.MPCFillError as e:
        raise HTTPException(502, str(e))


@app.get("/decks/{deck_id}")
def obter_deck(deck_id: str):
    """O deck, com os dados completos de cada carta e a validação junto.

    Tudo numa resposta só de propósito: a tela precisa das três coisas pra
    desenhar a primeira vez, e três requisições em sequência atrasariam a
    abertura de um link compartilhado.
    """
    return _deck_completo(_deck_ou_404(deck_id))


@app.put("/decks/{deck_id}")
def salvar_deck(deck_id: str, corpo: dict = Body(...),
                quem: dict | None = Depends(quem_e)):
    """Grava o deck por cima. É o autosave da tela.

    A validação vai na resposta, mas NÃO impede de gravar: deck pela metade é
    o estado normal de quem está montando (ver `decks.py`).

    Deck órfão qualquer um grava, como sempre foi. Deck com dono, só ele e o
    admin — e o `GET` acima continua aberto, porque compartilhar o link é a
    razão de o link existir.
    """
    _deck_ou_404(deck_id)
    existe, dono = decks.dono_de(deck_id)
    if not _pode_mexer(dono, quem):
        raise _proibido()
    try:
        deck = decks.salvar(deck_id, corpo.get("nome", ""),
                            corpo.get("comandantes"), corpo.get("cartas"),
                            corpo.get("maybeboard"), corpo.get("categorias"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not deck:
        raise HTTPException(404, "Deck não encontrado.")
    return _deck_completo(deck)


@app.post("/decks/{deck_id}/duplicar")
def duplicar_deck(deck_id: str, quem: dict | None = Depends(quem_e)):
    """Cópia com id novo — o "salvar como" deste sistema.

    Fica LIVRE mesmo quando o original tem dono, de propósito: é a válvula de
    escape de quem abriu o deck de outra pessoa e quis mexer. Não altera nada
    do original, e a cópia nasce de quem duplicou — não do dono do original.
    """
    _deck_ou_404(deck_id)
    copia = decks.duplicar(deck_id)
    if quem:
        decks.definir_dono(copia["id"], quem["id"])
        copia = decks.obter(copia["id"])
    log.evento("deck", "duplicou", deck=deck_id, copia=copia["id"])
    return _deck_completo(copia)


@app.delete("/decks/{deck_id}")
def apagar_deck(deck_id: str, quem: dict | None = Depends(quem_e)):
    """Apaga o deck. Não tem volta: o deck vive só aqui."""
    existe, dono = decks.dono_de(deck_id)
    if existe and not _pode_mexer(dono, quem):
        raise _proibido()
    if not decks.apagar(deck_id):
        raise HTTPException(404, "Deck não encontrado.")
    log.evento("deck", "apagou", deck=deck_id)
    return {"ok": True}


@app.get("/decks/{deck_id}/lista", response_class=PlainTextResponse)
def lista_do_deck(deck_id: str):
    """A decklist em texto, uma carta por linha, comandante primeiro.

    É o formato que se cola no MPC Fill pra escolher as artes por lá. Quem
    escolheu as artes aqui mesmo não precisa dela pra imprimir: o XML sai
    pronto do `GET /decks/{id}/pedido`.
    """
    return decks.lista_texto(_deck_ou_404(deck_id))


@app.post("/decks/{deck_id}/cotacao")
def cotar_deck(deck_id: str):
    """Começa a cotação de preço do deck e devolve o `job_id`.

    Mesmo trabalho e mesmo acompanhamento do botão de cotar da tela de
    pedidos: o andamento sai no `GET /cotacao/{job_id}` de sempre. O
    comandante sai da conta, junto com os terrenos básicos — é o critério do
    Commander 500 (ver `cotacao.filtrar_cotaveis`).
    """
    deck = _deck_ou_404(deck_id)
    try:
        return cotacao_job.iniciar_lista(decks.para_cotacao(deck),
                                         deck.get("comandantes") or None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/decks/{deck_id}/combos")
def combos_do_deck(deck_id: str):
    """Procura os combos do deck no Commander Spellbook.

    Só no clique, nunca automático: o deck muda a cada carta adicionada, e
    buscar sozinho viraria uma requisição por clique num serviço gratuito.
    É a mesma regra da cotação (ver `cotacao_job.py`).

    Roda dentro da requisição, e não em segundo plano como a cotação, porque
    aqui é UMA requisição só — não há minutos de varredura pra esperar.

    Falha do Spellbook volta 502, não lista vazia: "não sei" e "não tem
    combo" parecem iguais na tela e são opostos.
    """
    deck = _deck_ou_404(deck_id)
    try:
        # `cartas_contadas` e não `cartas`: combo fechado por uma peça que
        # está no sideboard não é combo que o deck tem — ela não está nas 100.
        achado = spellbook.buscar(deck.get("comandantes") or [],
                                  decks.cartas_contadas(deck))
    except spellbook.SpellbookError as e:
        raise HTTPException(502, str(e))
    # O Spellbook manda só o nome de cada peça. A arte, o preço e o "existe
    # na base local" saem daqui mesmo, numa consulta só — ver
    # `decks.combos_com_cartas`.
    return decks.combos_com_cartas(achado)


@app.post("/decks/{deck_id}/poder")
def poder_do_deck(deck_id: str):
    """Classifica o deck na escala de brackets do Commander (1 a 4).

    Quem classifica é o `estimate-bracket` do Spellbook, não a gente: a lista
    oficial de *game changers* muda a cada anúncio da Wizards, e mantê-la na
    mão aqui envelheceria em semanas (ver `poder.py`).

    A resposta traz o número E o que o justifica, carta por carta — uma nota
    sozinha não ajuda ninguém a decidir o que trocar.

    Mesma regra dos combos: só no clique, e falha vira 502 em vez de uma
    classificação inventada.
    """
    deck = _deck_ou_404(deck_id)
    try:
        estimativa = spellbook.estimar_bracket(deck.get("comandantes") or [],
                                               decks.cartas_contadas(deck))
    except spellbook.SpellbookError as e:
        raise HTTPException(502, str(e))
    return poder.ler(estimativa)


@app.post("/decks/{deck_id}/sugestoes")
def sugestoes_do_deck(deck_id: str, corpo: dict = Body(default={})):
    """Cartas que combinam com o comandante — ou com uma carta — pelo EDHREC.

    O corpo escolhe de quem é a pergunta, e são duas perguntas diferentes:

    * **sem nada** (o padrão): o que combina com o COMANDANTE. `tema` é
      opcional e restringe a página consultada ("aristocrats",
      "superfriends"); os temas disponíveis voltam na resposta pra tela
      montar o seletor.
    * **`carta`**: o que o EDHREC vê aparecendo junto DAQUELA carta. É o que
      responde "já que este deck tem Ashnod's Altar, o que mais entra?", que
      a página do comandante não sabe responder. Aqui `tema` não existe — a
      página de carta não tem temas.

    Os dois caminhos voltam com a mesma forma, `alvo` dizendo qual foi, e as
    sugestões já filtradas: sem o que o deck tem, sem o que a base local não
    conhece e sem o que não cabe na identidade de cor (ver
    `decks.sugestoes_uteis`). O filtro de identidade importa bem mais no
    caminho da carta: a página de Sol Ring sugere as cinco cores.

    Isto lê um endpoint NÃO OFICIAL do EDHREC e pode quebrar sem aviso — daí
    o 502 com a mensagem em vez de uma lista vazia, que a tela leria como
    "esse comandante não tem sinergia com nada".
    """
    deck = _deck_ou_404(deck_id)
    carta = (corpo.get("carta") or "").strip() or None
    tema = (corpo.get("tema") or "").strip() or None
    try:
        achado = (edhrec.sugerir_por_carta(carta) if carta
                  else edhrec.sugerir(deck.get("comandantes") or [], tema))
    except edhrec.EDHRECError as e:
        raise HTTPException(502, str(e))
    return {**achado,
            "listas": decks.sugestoes_uteis(deck, achado["listas"])}


@app.get("/decks/{deck_id}/manabase")
def manabase_do_deck(deck_id: str, teto: float | None = None):
    """Quantos terrenos o deck pede, de que cores, e o que falta.

    É a única análise que não sai daqui: conta sobre o próprio deck e a base
    local, sem rede. Por isso é GET e por isso a tela pode chamar a cada
    autosave em vez de esperar um botão. `teto` (em dólar da Scryfall) separa
    os terrenos de fixação em "baratos" e "se o orçamento deixar".
    """
    deck = _deck_ou_404(deck_id)
    completo = decks.com_cartas(deck)
    identidade = decks.identidade_de(
        [c for c in completo["comandantes_completos"] if c])
    # A conta de terrenos é sobre as 100 que vão pra mesa: sideboard e
    # maybeboard fora. Um sideboard com quatro terrenos não muda quantos
    # terrenos o deck precisa jogar.
    fora = decks.CATEGORIAS_FORA_DA_CONTA
    completo = {**completo, "cartas_completas": [
        e for e in completo["cartas_completas"]
        if (e.get("categoria") or "") not in fora]}
    return manabase.analisar(completo, identidade,
                             teto_usd=teto if teto is not None
                             else manabase.TETO_USD)


@app.get("/decks/{deck_id}/tokens")
def tokens_do_deck(deck_id: str):
    """As fichas que o deck cria, agrupadas pela carta que as cria.

    Como a mana base, é conta que não sai daqui: o bulk da Scryfall já diz,
    carta por carta, quais fichas ela cria, e a base local guarda isso. Sem
    rede, então é GET e a tela pode chamar sempre que a aba abrir.

    Sideboard e maybeboard ficam de fora (ver `artes.fichas_do_deck`).
    Comandante entra, e entra primeiro — é a carta que mais define o que o
    deck vai criar.

    Cada ficha leva a `chave_arte`, que é por onde a aba Artes acha a arte
    escolhida pra ela: as fichas vão pro pedido de impressão junto com as
    cartas.
    """
    deck = _deck_ou_404(deck_id)
    grupos = artes.fichas_do_deck(deck)
    return {"grupos": grupos,
            "total": sum(len(g["tokens"]) for g in grupos)}


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
def list_open_orders(x_admin_token: str | None = Header(default=None),
                     quem: dict | None = Depends(quem_e)):
    """Pedidos ainda não impressos, com o status de cada um ('pending' =
    ninguém avisou nada; 'notified' = o cliente disse que pagou)."""
    _check_admin(x_admin_token, quem)
    return storage.list_open()


@app.get("/admin/printers")
def list_printers(x_admin_token: str | None = Header(default=None),
                  quem: dict | None = Depends(quem_e)):
    """Lista as filas que o CUPS conhece, vistas de dentro do container —
    é assim que se descobre o nome certo pra PRINTER_QUEUE."""
    _check_admin(x_admin_token, quem)
    return printer.list_queues()


@app.get("/admin/tinta")
def ink_diagnostics(x_admin_token: str | None = Header(default=None),
                    quem: dict | None = Depends(quem_e)):
    """O que a impressora respondeu sobre tinta, cru.

    Serve pra responder "esse modelo informa o nível?" sem abrir terminal:
    se não vier nenhum `marker-*`, ele não informa, e o aviso da página passa
    a depender do `TINTA_ESTADO` no .env.
    """
    _check_admin(x_admin_token, quem)
    return tinta.diagnostico()


@app.get("/admin/visitas")
def list_visitas(x_admin_token: str | None = Header(default=None),
                 quem: dict | None = Depends(quem_e)):
    """Quem está no sistema agora, separado por classe.

    Complementa o `visitas.log`: o arquivo responde "o que aconteceu ontem",
    isto responde "tem alguém aí neste momento" sem precisar abrir terminal.
    A janela é `VISITA_JANELA_MINUTOS`.
    """
    _check_admin(x_admin_token, quem)
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
def admin_session(x_admin_token: str | None = Header(default=None),
                  quem: dict | None = Depends(quem_e)):
    """Só diz se o token vale. A tela chama isto ao abrir (e ao colar um
    token novo) pra saber se mostra a lista ou o formulário de entrada, sem
    ter que pedir a lista inteira só pra descobrir isso."""
    _check_admin(x_admin_token, quem)
    return {"ok": True, "impressora": printer.PRINTER_QUEUE or None,
            "email_configurado": notify.is_configured()}


@app.get("/admin/pedidos")
def admin_list_orders(status: str | None = None, busca: str | None = None,
                      limite: int = 200,
                      x_admin_token: str | None = Header(default=None),
                      quem: dict | None = Depends(quem_e)):
    """Todos os pedidos, do mais novo pro mais antigo, com os contadores por
    estado e o link assinado de conferir o PDF de cada um.

    O link vai relativo (`base=""`): a tela está no mesmo servidor, e o
    PUBLIC_BASE_URL é o domínio de fora, que num acesso pela rede local pode
    nem resolver.
    """
    _check_admin(x_admin_token, quem)
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


@app.get("/admin/usuarios")
def admin_list_usuarios(x_admin_token: str | None = Header(default=None),
                        quem: dict | None = Depends(quem_e)):
    """As contas do sistema. Nenhuma delas traz hash de senha: `usuarios`
    tem um caminho de saída só (`_publico`), e ele não copia essa coluna."""
    _check_admin(x_admin_token, quem)
    return {"usuarios": usuarios.listar()}


@app.post("/admin/usuarios")
def admin_criar_usuario(corpo: dict = Body(default={}),
                        x_admin_token: str | None = Header(default=None),
                        quem: dict | None = Depends(quem_e)):
    """Cria uma conta. É o único caminho: não existe cadastro aberto.

    O README abre dizendo que isto não é uma loja — é ferramenta privada, de
    um grupo de jogo. Um `POST /conta/criar` público seria a primeira coisa
    que um bot encontraria, e a primeira que encheria o banco.
    """
    _check_admin(x_admin_token, quem)
    try:
        return {"usuario": usuarios.criar(
            corpo.get("login", ""), corpo.get("senha", ""),
            nome=corpo.get("nome", ""), perfil=corpo.get("perfil", "cliente"))}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/admin/usuarios/{usuario_id}/senha")
def admin_trocar_senha(usuario_id: str, corpo: dict = Body(default={}),
                       x_admin_token: str | None = Header(default=None),
                       quem: dict | None = Depends(quem_e)):
    """Redefine a senha de alguém — é a saída pra quem esqueceu a dela.

    Derruba todas as sessões daquela conta junto (ver `usuarios.trocar_senha`),
    o que também a torna a ferramenta certa quando o motivo foi desconfiança.
    """
    _check_admin(x_admin_token, quem)
    try:
        if not usuarios.trocar_senha(usuario_id, corpo.get("nova", "")):
            raise HTTPException(404, "Conta não encontrada.")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.delete("/admin/usuarios/{usuario_id}")
def admin_apagar_usuario(usuario_id: str,
                         x_admin_token: str | None = Header(default=None),
                         quem: dict | None = Depends(quem_e)):
    """Apaga a conta e as sessões dela.

    Os decks e pedidos daquela pessoa NÃO são apagados: eles voltam a ser
    órfãos, e órfão é um estado que este sistema sabe tratar desde sempre.
    Apagar o acervo junto seria transformar "tirar o acesso de alguém" em
    "destruir o trabalho de alguém", que são coisas bem diferentes.
    """
    _check_admin(x_admin_token, quem)
    if not usuarios.apagar(usuario_id):
        raise HTTPException(404, "Conta não encontrada.")
    soltos = decks.soltar_de(usuario_id) + storage.soltar_de(usuario_id)
    log.evento("usuarios", "apagou", usuario=usuario_id, orfanados=soltos)
    return {"ok": True, "orfanados": soltos}


@app.get("/admin/decks")
def admin_list_decks(busca: str | None = None, limite: int = 200,
                     x_admin_token: str | None = Header(default=None),
                     quem: dict | None = Depends(quem_e)):
    """Todos os decks do banco, com o dono de cada um, pro operador.

    Esta é a ÚNICA leitura do projeto que enumera decks, e é por isso que ela
    está aqui atrás do `_check_admin` em vez de junto do `POST /decks/resumo`.
    Aquele é público de propósito e responde só sobre ids que quem chamou já
    tinha — sem dono no banco, "liste os decks" significaria "liste os decks
    de todo mundo", e é exatamente o que esta rota faz, deliberadamente, pra
    quem é dono do sistema.

    `contagem.sem_dono` é o número que responde "quanto do acervo ainda não é
    de ninguém". Hoje é todo ele: a coluna `dono` só passa a ser preenchida
    quando o login existir, e até lá cada deck sai daqui com `dono: null`, que
    é a verdade sobre eles — não um campo esquecido.
    """
    _check_admin(x_admin_token, quem)
    return {"contagem": decks.contar(),
            "decks": decks.listar(busca=busca, limite=limite)}


@app.get("/admin/pedidos/{order_id}")
def admin_get_order(order_id: str,
                    x_admin_token: str | None = Header(default=None),
                    quem: dict | None = Depends(quem_e)):
    """Um pedido só, pra tela atualizar a linha depois de uma ação sem
    recarregar a lista inteira."""
    _check_admin(x_admin_token, quem)
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
                     x_admin_token: str | None = Header(default=None),
                     quem: dict | None = Depends(quem_e)):
    """Muda o estado de um pedido na mão.

    Serve pros casos que o fluxo normal não cobre: marcar como pago um Pix
    que caiu sem o cliente avisar, cancelar um pedido abandonado, ou desfazer
    um clique errado voltando pra 'pending'.

    Marcar como 'paid' por aqui NÃO imprime nada — quem imprime é o botão de
    imprimir, que é uma ação separada de propósito (papel e tinta não voltam).
    """
    _check_admin(x_admin_token, quem)
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
                    x_admin_token: str | None = Header(default=None),
                    quem: dict | None = Depends(quem_e)):
    """Manda montar a folha (ou diz como está a montagem em andamento).

    Devolve o mesmo `{"estado": "pronto"|"montando"|"erro"}` do link do
    e-mail, e a tela fica chamando isto enquanto for "montando" pra mostrar o
    progresso — pedido grande leva minutos baixando as artes do Drive.
    """
    _check_admin(x_admin_token, quem)
    if not storage.get_order(order_id):
        raise HTTPException(404, "Pedido não encontrado.")
    estado = fulfillment.request_pdf(order_id, fresh=fresh)
    # O caminho no disco não interessa pra tela e é caminho de dentro do
    # container — sai da resposta.
    return {k: v for k, v in estado.items() if k != "path"}


@app.post("/admin/pedidos/{order_id}/imprimir")
def admin_print(order_id: str,
                x_admin_token: str | None = Header(default=None),
                quem: dict | None = Depends(quem_e)):
    """Mesmo efeito do link "Imprimir" do e-mail: marca pago e manda pra fila.

    É a única ação da tela que gasta papel, então o botão pede confirmação do
    outro lado. Aqui roda síncrono igual ao link, pra resposta já dizer se o
    CUPS aceitou.
    """
    _check_admin(x_admin_token, quem)
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
                      x_admin_token: str | None = Header(default=None),
                      quem: dict | None = Depends(quem_e)):
    """Cria (ou reaproveita) a combinação dos pedidos em `ids`, separados por
    vírgula, e devolve quanto papel ela economiza.

    Não monta PDF nenhum aqui: só a conta e o mapa de quem cai em qual folha,
    pra tela mostrar antes de o operador decidir. Montar é o passo seguinte.

    Escolher os mesmos pedidos de novo cai na mesma combinação e reaproveita
    a folha já montada — o id sai do conjunto, não do clique.
    """
    _check_admin(x_admin_token, quem)
    pedidos = _pedidos_do_combo(ids.split(","))
    combo_id = storage.save_combo([p["id"] for p in pedidos])
    log.evento("admin", "combinou-pedidos", combo=combo_id,
               pedidos=len(pedidos))
    return _resposta_combo(combo_id, pedidos)


@app.get("/admin/combos/{combo_id}")
def admin_get_combo(combo_id: str,
                    x_admin_token: str | None = Header(default=None),
                    quem: dict | None = Depends(quem_e)):
    """Uma combinação já criada, com os pedidos dela no estado de agora."""
    _check_admin(x_admin_token, quem)
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
                          x_admin_token: str | None = Header(default=None),
                          quem: dict | None = Depends(quem_e)):
    """Manda montar a folha combinada (ou diz como vai a montagem).

    Mesmo `{"estado": "pronto"|"montando"|"erro"}` da folha de um pedido só,
    e a tela fica chamando isto enquanto for "montando".
    """
    _check_admin(x_admin_token, quem)
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
                      x_admin_token: str | None = Header(default=None),
                      quem: dict | None = Depends(quem_e)):
    """Manda a folha combinada pra fila e marca TODOS os pedidos dela como pagos.

    É um papel só com as cartas de várias pessoas, então não existe imprimir
    metade: ou o conjunto inteiro é confirmado, ou nenhum. Confira os Pix de
    todos antes — a tela pede confirmação do outro lado.
    """
    _check_admin(x_admin_token, quem)
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
                       x_admin_token: str | None = Header(default=None),
                       quem: dict | None = Depends(quem_e)):
    """Esquece a combinação e apaga a folha montada dela.

    Os pedidos NÃO são tocados: desfazer uma combinação é só jogar fora um
    arranjo de papel, e cada pedido continua com o estado que tinha.
    """
    _check_admin(x_admin_token, quem)
    existia = storage.delete_combo(combo_id)
    tinha_pdf = fulfillment.descartar_combo_pdf(combo_id)
    if not existia and not tinha_pdf:
        raise HTTPException(404, "Combinação não encontrada.")
    log.evento("admin", "desfez-combinado", combo=combo_id, pdf=tinha_pdf)
    return {"ok": True, "pdf_apagado": tinha_pdf}


@app.delete("/admin/pedidos/{order_id}")
def admin_delete_order(order_id: str,
                       x_admin_token: str | None = Header(default=None),
                       quem: dict | None = Depends(quem_e)):
    """Apaga o pedido de vez, junto com o PDF montado.

    O XML do deck vive só aqui, então isso não tem volta — por isso a tela
    pede o id digitado antes de chamar. Pra tirar da frente sem perder o
    histórico, o caminho é cancelar.
    """
    _check_admin(x_admin_token, quem)
    if not storage.delete_order(order_id):
        raise HTTPException(404, "Pedido não encontrado.")
    tinha_pdf = fulfillment.descartar_pdf(order_id)
    log.evento("admin", "apagou-pedido", pedido=order_id, pdf=tinha_pdf)
    return {"ok": True, "pdf_apagado": tinha_pdf}


@app.post("/admin/cleanup")
def run_cleanup(x_admin_token: str | None = Header(default=None),
                quem: dict | None = Depends(quem_e)):
    """Roda a faxina dos PDFs antigos na hora, sem esperar o ciclo diário."""
    _check_admin(x_admin_token, quem)
    return cleanup.run_once()


# Serve o front-end (app/static/index.html) na raiz. Fica depois das rotas
# da API de propósito — assim /orders, /admin/... continuam resolvendo
# certo, e qualquer outro caminho cai no arquivo estático.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
