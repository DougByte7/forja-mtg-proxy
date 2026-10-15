import hmac
import os
import threading
import time
from urllib.parse import quote

from fastapi import (Body, Cookie, Depends, FastAPI, Form, Header,
                     HTTPException, Request, UploadFile)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (FileResponse, HTMLResponse, PlainTextResponse,
                               RedirectResponse, StreamingResponse)
from fastapi.staticfiles import StaticFiles

from . import (artes, artes_enviadas, blob, calc, cambio, cartas, clerk,
               cleanup, cotacao_job, decks, detalhe_carta, diagnostico, edhrec,
               estoque, frontend, fulfillment, importar, log, manabase,
               mpcfill, notify, pix, plataforma, poder, spellbook, storage,
               tarefas, visitas)

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
# A chave do worker da impressora (ver `worker/`). É outra chave de propósito:
# ela abre só as rotas `/worker/*`, e vazar a do worker não dá acesso ao
# painel — nem vazar a do painel dá pra se passar pela impressora. Vazia
# desliga as rotas do worker.
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")
# Sem notícia do worker há mais que isto, a tela diz que a impressora está
# fora do ar. Ele pergunta pela fila a cada ~30s, então alguns minutos de
# silêncio já não são acaso.
WORKER_OFFLINE_SEGUNDOS = int(os.environ.get("WORKER_OFFLINE_SEGUNDOS", "180"))

# Janela pra não mandar 10 e-mails se o cliente ficar clicando no botão.
NOTIFY_COOLDOWN_SECONDS = 120


def quem_e(session: str | None = Cookie(default=None, alias="__session"),
           authorization: str | None = Header(default=None)) -> dict | None:
    """Quem está pedindo, ou `None` pra anônimo — que NÃO é erro.

    Não fecha rota nenhuma: quem fecha é o `exige_login`, o
    `exige_login_no_deck` e o `exige_amigo`. Ler deck e cotar seguem abertos
    pra quem não entrou.

    A conta é a do Clerk: o token vem no cabeçalho (o `api` do front manda)
    ou no cookie `__session` (ver `clerk.py`).
    """
    return clerk.usuario(clerk.token_do_pedido(authorization, session))


def exige_login(quem: dict | None = Depends(quem_e)) -> dict:
    """Pras poucas rotas que não fazem sentido sem conta ("os meus")."""
    if not quem:
        raise HTTPException(401, "Entre na sua conta pra ver isso.")
    return quem


def exige_login_no_deck(quem: dict | None = Depends(quem_e)) -> dict:
    """Pras rotas que criam ou alteram deck: criar, gravar, duplicar, apagar,
    escolher arte e concluir versão. Abrir o deck fica de fora, de propósito —
    o link compartilhado abre pra qualquer um.

    Separada do `exige_login` só pela mensagem: "pra ver isso" diante de um
    autosave recusado mandaria a pessoa procurar o que não está escondido.
    """
    if not quem:
        raise HTTPException(401, "Entre na sua conta pra criar ou alterar "
                                 "baralhos.")
    return quem


def exige_amigo(quem: dict | None = Depends(quem_e)) -> dict:
    """Pras rotas de pedido. Imprimir proxy é favor pro grupo de jogo, não
    loja: só `amigo` (e o admin) pedem. O perfil vem da conta — no Clerk, do
    `public_metadata.role`, que só o painel muda (ver `clerk.py`).

    401 pra quem não entrou (a tela manda entrar) e 403 pra quem entrou mas
    não é amigo (a tela diz pra falar com o dono): são conversas diferentes.
    """
    if not quem:
        raise HTTPException(401, "Entre na sua conta pra fazer pedido.")
    if quem.get("perfil") not in ("amigo", "admin"):
        raise HTTPException(403, "Pedido de impressão é só pra amigos do "
                                 "grupo. Fale com o dono da Forja.")
    return quem


def _pedido_de(order_id: str, quem: dict) -> dict:
    """O pedido, se `quem` pode vê-lo e mexer nele — a mesma regra do deck
    (`_pode_mexer`): pedido sem dono (os de antes da conta) qualquer amigo
    abre; com dono, só o dono e o admin. O de outra pessoa responde 404, como
    o que não existe: o id não pode servir pra descobrir pedido alheio."""
    order = storage.get_order(order_id)
    if not order or not _pode_mexer(order.get("dono"), quem):
        raise HTTPException(404, "Pedido não encontrado.")
    return order


def _pode_mexer(dono: str | None, quem: dict | None) -> bool:
    """Quem pode gravar e apagar. UMA função, vale pra deck e pra pedido.

    * SEM dono -> qualquer um que tenha chegado até aqui. No pedido isso
      inclui o anônimo; nas rotas de deck, o `exige_login_no_deck` já barrou
      quem não tem conta.
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


# Contar visitas é coisa do processo que vive dias (o homelab). Na Vercel quem
# conta é o Vercel Analytics: cada requisição pode cair num processo novo, e
# a "visita" em memória viraria uma por requisição. Lá isto fica em 0 — e o
# que sobra aqui é só o log das ações e dos erros.
REGISTRAR_VISITAS = os.environ.get(
    "REGISTRAR_VISITAS", plataforma.padrao("1", "0")) == "1"


@app.middleware("http")
async def registrar_visita(request: Request, call_next):
    """Anota quem está no sistema e quanto cada requisição demorou.

    Fica em volta de TODAS as rotas, inclusive dos arquivos estáticos, porque
    é justamente o pedido da página inicial que revela que alguém abriu a
    página — as rotas da API só contam quem já resolveu usar.

    Nada aqui pode derrubar uma resposta: se o registro falhar, a requisição
    segue. Log é observação, não parte do serviço.
    """
    inicio = time.monotonic()
    try:
        ip = visitas.ip_do_pedido(request)
        ua = request.headers.get("user-agent", "")
        classe, sinal = visitas.classificar(ua, request.headers)
        if not REGISTRAR_VISITAS:
            # Sem registro: a linha de ação/erro lá embaixo leva o IP no
            # lugar do id da visita.
            visita = {"id": ip, "nova": False}
        else:
            visita = visitas.registro.registrar(
                ip, ua, request.url.path, classe, sinal,
                pais=request.headers.get(visitas.PAIS_CABECALHO, ""))
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
        if acao and visita and REGISTRAR_VISITAS:
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


# As duas coisas que só fazem sentido num processo que vive dias (o
# container do homelab). Na Vercel cada processo nasce e morre com poucas
# requisições: migrar em toda partida a frio são idas ao banco à toa, e thread
# de fundo não termina. Lá as duas ficam em 0 e viram comando — ver
# `app/tarefas.py`.
MIGRAR_NO_STARTUP = os.environ.get(
    "MIGRAR_NO_STARTUP", plataforma.padrao("1", "0")) == "1"
TAREFAS_EM_SEGUNDO_PLANO = os.environ.get(
    "TAREFAS_EM_SEGUNDO_PLANO", plataforma.padrao("1", "0")) == "1"


@app.on_event("startup")
def startup():
    if MIGRAR_NO_STARTUP:
        tarefas.migrar()
    if TAREFAS_EM_SEGUNDO_PLANO:
        cleanup.start_background()
        # Monta a base de cartas se ela estiver vazia ou velha, em segundo
        # plano. Sem isto o deckbuilder nasce sem carta nenhuma e dependeria de
        # alguém lembrar de rodar o sync na mão depois de cada container novo.
        cartas.start_background()
    log.evento("app", "subiu", log_dir=log.DIR, nivel=log.NIVEL,
               fontes=", ".join(f["id"] for f in cotacao_job.fontes_ativas())
                      or "nenhuma",
               # Na Vercel toda partida a frio passa aqui, e contar a base no
               # Turso é uma conexão e quatro consultas na frente da primeira
               # resposta — só pra uma linha de log. `/cartas/estado` diz isso.
               cartas=None if plataforma.NA_VERCEL
                      else cartas.estado().get("cartas", 0))


@app.post("/orders")
async def create_order(xml_file: UploadFile, lamination: str = Form(...),
                        customer_name: str = Form(default=""),
                        quem: dict = Depends(exige_amigo)):
    """Cria o pedido e a cobrança Pix. Só amigo (`exige_amigo`), e o pedido
    já nasce dele. O nome digitado continua valendo (pode ser pra outra
    pessoa); em branco, vai o da conta."""
    if not PIX_KEY:
        raise HTTPException(500, "PIX_KEY não configurada no backend (.env).")
    customer_name = customer_name.strip() or quem.get("nome", "").strip()
    if not customer_name:
        raise HTTPException(400, "Informe o nome de quem está pedindo.")

    xml_text = (await xml_file.read()).decode("utf-8")
    try:
        qty, backs_count = calc.parse_order(xml_text)
        result = calc.compute_cost(qty, backs_count, lamination,
                                   estoque.precos_por_pagina())
        deck_hash = calc.compute_deck_hash(xml_text)
    except ValueError as e:
        raise HTTPException(400, str(e))

    order_id, amount = storage.create_order(
        xml_text, lamination, customer_name, deck_hash, result,
        dono=quem["id"])
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


def _publico(pedido: dict) -> dict:
    """O pedido como o cliente pode ver: sem a resposta crua do CUPS, que
    pode trazer endereço e nome de fila, e sem o id interno do combo."""
    return {k: v for k, v in pedido.items()
            if k not in ("impressao_msg", "impressao_combo")}


@app.get("/pedidos/meus")
def meus_pedidos(quem: dict = Depends(exige_amigo)):
    """Os pedidos desta conta, de qualquer aparelho."""
    return {"pedidos": [_publico(p) for p in storage.list_by_dono(quem["id"])]}


@app.post("/pedidos/reclamar")
def reclamar_pedidos(corpo: dict = Body(default={}),
                     quem: dict = Depends(exige_amigo)):
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
def order_status(order_id: str, quem: dict = Depends(exige_amigo)):
    return _publico(_pedido_de(order_id, quem))


@app.post("/orders/{order_id}/notify-payment")
def notify_payment(order_id: str, quem: dict = Depends(exige_amigo)):
    """
    O cliente clicou em "Pagamento realizado, enviar notificação".

    Isso NÃO confirma pagamento nem imprime nada — só manda um e-mail com o
    resumo do pedido e o link "Imprimir", pro operador conferir o Pix no app
    do banco e decidir.

    A folha não é montada aqui: o pedido em `notified` aparece na fila do
    worker da impressora, que adianta o PDF dele do lado de lá.
    """
    order = _pedido_de(order_id, quem)
    if order["status"] in storage.STATUS_PAGOS:
        return {"status": "already_printed",
                "message": "Esse pedido já foi confirmado e enviado pra impressão."}

    last = order.get("notified_at")
    if last and (time.time() - last) < NOTIFY_COOLDOWN_SECONDS:
        return {"status": "already_sent",
                "message": "O aviso já foi enviado — aguarde a confirmação."}

    if not notify.is_configured():
        raise HTTPException(500, "SMTP não configurado no backend (.env).")
    try:
        link_imprimir = fulfillment.print_url(order_id)
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    try:
        notify.send_payment_claim_email(order, link_imprimir)
    except Exception as e:
        raise HTTPException(502, f"Não consegui enviar o e-mail de aviso: {e}")

    storage.mark_notified(order_id)
    return {"status": "sent",
            "message": "Aviso enviado. Assim que o pagamento for conferido, "
                       "seu pedido vai pra impressão."}


@app.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str, quem: dict = Depends(exige_amigo)):
    """
    O cliente desistiu, pela tela "Meus pedidos" dele.

    Só vale enquanto o pedido está em 'pending' — ou seja, enquanto ninguém
    do outro lado ficou sabendo dele. Depois que o aviso de pagamento saiu, o
    operador já está conferindo Pix, e desfazer isso sozinho pela tela viraria
    um jeito de sumir com um pedido que talvez já esteja pago: daí em diante o
    caminho é falar comigo.

    Cancelar não apaga nada: o pedido sai da lista de abertos e continua no
    histórico do admin (`storage.set_status`).

    Pede amigo, e pedido com dono só o dono (e o admin) cancela — a regra do
    `_pedido_de`, a mesma do notify-payment. Pedido sem dono (de antes da
    conta) qualquer amigo cancela: são poucos e ficam no histórico do admin.
    """
    order = _pedido_de(order_id, quem)
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


@app.get("/orders/{order_id}/print", response_class=HTMLResponse)
def print_order(order_id: str, token: str | None = None,
                x_admin_token: str | None = Header(default=None),
                quem: dict | None = Depends(quem_e)):
    """
    Link "Imprimir" do e-mail. Confirma o Pix e põe o pedido na fila da
    impressora (`a_imprimir`) — quem imprime é o worker, que pega a fila na
    próxima passada. Aceita o token assinado da querystring (o do e-mail) ou
    o header X-Admin-Token, pra disparar na mão quando precisar.

    Responde com um redirecionamento pra página que acompanha a fila, e não
    com ela direto: aquela página se atualiza sozinha, e se fosse ESTA URL se
    atualizando, cada recarga poria o pedido na fila de novo — uma cópia
    impressa a cada 5 segundos. Abrir o link do e-mail de novo, de propósito,
    continua sendo "imprimir de novo".
    """
    _authorize("print", order_id, token, x_admin_token, quem)
    try:
        storage.pedir_impressao(order_id)
    except storage.FilaError as e:
        return HTMLResponse(_status_page("Não foi pra fila", str(e), ok=False),
                            status_code=409)
    log.evento("pedido", "na-fila", pedido=order_id, por="link")
    destino = f"/orders/{order_id}/impressao" + (f"?token={token}" if token else "")
    return RedirectResponse(destino, status_code=303)


def _worker_visto() -> float | None:
    """Quando o worker deu sinal pela última vez (epoch), ou None."""
    visto = storage.ler_worker("visto")
    return visto["em"] if visto else None


def _aviso_worker() -> str:
    """Uma frase pra quando o worker sumiu, ou vazio se ele está por aí."""
    visto = _worker_visto()
    if visto is None:
        return (" ATENÇÃO: a impressora nunca deu sinal de vida — o worker "
                "não está rodando, e o pedido fica na fila até ele voltar.")
    parado = time.time() - visto
    if parado > WORKER_OFFLINE_SEGUNDOS:
        return (f" ATENÇÃO: a impressora não dá sinal há {int(parado // 60)} "
                f"min. O pedido fica na fila até ela voltar.")
    return ""


@app.get("/orders/{order_id}/impressao", response_class=HTMLResponse)
def print_progress(order_id: str, token: str | None = None,
                   x_admin_token: str | None = Header(default=None),
                   quem: dict | None = Depends(quem_e)):
    """Onde o pedido está na fila da impressora. Só lê — se atualiza sozinha
    enquanto o worker não termina, e pode ser recarregada à vontade.

    Usa o mesmo token do link "Imprimir": é a continuação dele."""
    order = _authorize("print", order_id, token, x_admin_token, quem)
    status = order["status"]
    aqui = f"/orders/{order_id}/impressao" + (f"?token={token}" if token else "")
    resumo = (f"Pedido {order_id} de {order['customer_name']} — "
              f"{order['pages']} página(s), R$ {order['amount']:.2f}.")
    msg = order.get("impressao_msg") or ""

    if status == "a_imprimir":
        return HTMLResponse(_status_page(
            "Na fila da impressora",
            f"{resumo} Pagamento confirmado. A impressora pega o pedido em "
            f"instantes — esta página se atualiza sozinha.{_aviso_worker()}",
            refresh=aqui))
    if status == "imprimindo":
        return HTMLResponse(_status_page(
            "Imprimindo",
            f"{resumo} A folha está sendo montada e enviada pro CUPS. Pedido "
            f"grande leva alguns minutos baixando as artes.", refresh=aqui))
    if status == "impresso":
        detalhe = f"{resumo} {msg}".strip()
        if order.get("impressao_falhas"):
            detalhe += (f" ATENÇÃO: {order['impressao_falhas']} carta(s) não "
                        f"baixaram e saíram como quadro de falha no papel.")
        return HTMLResponse(_status_page("Enviado pra impressora", detalhe))
    if status == "erro_impressao":
        return HTMLResponse(_status_page(
            "A impressora recusou o trabalho",
            f"{resumo} O pedido está pago, mas não foi impresso: {msg} "
            f"Depois de resolver, abra o link \"Imprimir\" do e-mail de novo.",
            ok=False), status_code=502)
    return HTMLResponse(_status_page(
        "Fora da fila",
        f"{resumo} Esse pedido não está na fila de impressão (estado: "
        f"{status}).", ok=False))


def _status_page(title: str, message: str, ok: bool = True,
                 refresh: str | None = None) -> str:
    """Página de recado. `refresh` é a URL pra onde ela se recarrega a cada
    5s — só pra URL que apenas LÊ, nunca pra uma que faz alguma coisa."""
    color = "#C9A227" if ok else "#D9634A"
    recarga = (f'<meta http-equiv="refresh" content="5;url={refresh}">'
               if refresh else "")
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{recarga}
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
    abaixo, que é quem cota de fato, um pedaço por chamada. Deck grande leva
    minutos, e esperar dentro de uma requisição só estoura qualquer teto.
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
    enquanto o estado for "cotando" — e é cada uma dessas chamadas que faz a
    cotação andar um pedaço (ver `cotacao_job`)."""
    atual = cotacao_job.estado(job_id)
    if not atual:
        raise HTTPException(404, "Cotação não encontrada (ou já foi "
                                 "apagada). Clique em cotar de novo.")
    return atual


# --- Deckbuilder de Commander (front/src/pages/deckbuilder) -----------------
#
# Uma tela pra MONTAR o deck, separada da que orça a impressão. As duas se
# encontram no fim: o deck montado aqui vira uma decklist de texto que se cola
# no MPC Fill, e o XML que sai de lá é o que sobe no orçamento de sempre.
#
# A busca não fala com a Scryfall: ela lê a cópia local do bulk data (ver
# `cartas.py`), porque busca-a-cada-tecla contra a API de fora seria o jeito
# mais rápido de levar 429 em cima de quem só está digitando.


@app.get("/deckbuilder", response_class=HTMLResponse)
def deckbuilder_page():
    """A página do deckbuilder. Igual ao /admin: fica antes do mount estático
    pra a URL ser /deckbuilder, sem o .html."""
    return frontend.page("deckbuilder")


# ---------------------------------------------------------------------------
# Conta
# ---------------------------------------------------------------------------

@app.get("/entrar")
def pagina_de_entrar():
    """A tela de login (`front/src/pages/login`). Rota própria pra a URL não
    ter .html, como as outras."""
    return frontend.page("login")


@app.get("/conta")
def conta_atual(quem: dict | None = Depends(quem_e),
                session: str | None = Cookie(default=None, alias="__session"),
                authorization: str | None = Header(default=None)):
    """Quem está logado, ou `{"usuario": null}`.

    200 com `null` pra anônimo, e NÃO 401, de propósito: é a rota que toda
    página chama ao abrir, e um 401 por carregamento ensina o operador a
    ignorar o console — junto com os erros que importam.

    Veio token do Clerk e ele não valeu: `clerk` diz por quê. É o caso "entrei
    e o site não me reconhece", e o motivo (chave, origem, validade) aparece
    na aba Rede do navegador sem precisar abrir o log da Vercel. Não conta
    nada que quem mandou o token já não tenha.
    """
    if quem:
        return {"usuario": quem}
    _, motivo = clerk.conferir(clerk.token_do_pedido(authorization, session))
    return {"usuario": None, **({"clerk": motivo} if motivo else {})}


@app.get("/cadastro")
def pagina_de_cadastro():
    """A tela de criar conta (`front/src/pages/signup`). Rota própria pra a
    URL não ter .html."""
    return frontend.page("signup")


@app.get("/meus-decks")
def pagina_de_decks_antiga():
    """Onde a lista de decks morava antes de virar a página inicial."""
    return RedirectResponse("/", status_code=301)


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
                 ordem: str = "", pular: int = 0, com_total: bool = False,
                 ineditas: bool = False):
    """Busca na base local. Sem token: é catálogo público de carta de Magic.

    `identidade` é a do comandante já escolhido — quando vem, some da lista
    toda carta que aquele deck não poderia jogar. Vir vazio (`?identidade=`)
    não é o mesmo que não vir: vazio é deck incolor, e aí só carta sem cor
    aparece.

    `texto` é a busca por efeito: cada palavra tem que aparecer no oracle da
    carta (em inglês, que é como o bulk data vem). O resto — `cmc_min`,
    `cmc_max`, `cores`, `preco_max`, `ordem` — são os filtros avançados da
    gaveta da tela; todos opcionais, e todos combinam entre si e com o nome.

    `ineditas` traz também as cartas das coleções já anunciadas e ainda não
    lançadas, que a Scryfall marca como não-legais e que por isso não aparecem
    na busca normal — é o interruptor da tela, e ele não abre a porta pras
    banidas (ver `cartas._sai_em`).

    `pular` e `com_total` são a paginação do painel de adicionar, que aparece
    quando há filtro ligado: `pular` é o começo da página e `com_total` pede o
    tamanho do bolo inteiro, que vira o "1 / 8" do paginador. O total custa
    uma varredura a mais, então só vem quando pedido.
    """
    filtros = dict(termo=q, identidade=identidade, tipo=tipo,
                   comandante=comandante, texto=texto, cmc_min=cmc_min,
                   cmc_max=cmc_max, cores=cores, preco_max=preco_max,
                   ineditas=ineditas)
    resposta = {"cartas": cartas.buscar(limite=limite, ordem=ordem,
                                        pular=pular, **filtros)}
    if com_total:
        resposta["total"] = cartas.contar(**filtros)
    return resposta


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
    """As impressões oficiais de uma carta, pra escolha de arte: a vitrine do
    MPC Fill e o segmento Scryfall (ver `detalhe_carta.impressoes`).

    Pública pelo mesmo motivo do `/cartas/detalhe`: é catálogo de carta de
    Magic, não dado de ninguém.
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
    except ValueError as e:
        raise HTTPException(400, str(e))
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
    if not TAREFAS_EM_SEGUNDO_PLANO:
        # Sem thread de fundo (Vercel) a carga morreria junto com o processo
        # no meio do caminho. Quem remonta a base aí é o cron.
        raise HTTPException(409, "Aqui a base de cartas é atualizada pelo "
                                 "cron diário (GitHub Actions, workflow "
                                 "\"Tarefas\"). Pra remontar agora, rode ele "
                                 "à mão com a opção forçar.")
    if cartas.andamento()["rodando"]:
        return {"ok": True, "ja_rodando": True, **cartas.estado()}
    threading.Thread(target=cartas.sincronizar, daemon=True).start()
    return {"ok": True, "comecou": True, **cartas.estado()}


def _deck_completo(deck: dict) -> dict:
    """O deck do jeito que a tela consome: cartas resolvidas, validação e onde
    ele está no histórico de versões.

    As cartas são buscadas uma vez só e servem às duas coisas: o deck gravado
    já passou pelo `limpar_*`, então os nomes que a validação procura estão
    entre os do `nomes_do_deck`. No Turso é uma ida ao banco a menos."""
    conhecidas = cartas.por_nomes(decks.nomes_do_deck(deck))
    return {
        "deck": decks.com_cartas(deck, conhecidas),
        "validacao": decks.validar(deck.get("comandantes"),
                                   deck.get("cartas"), conhecidas),
        "versao": decks.situacao_da_versao(deck),
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
               quem: dict = Depends(exige_login_no_deck)):
    """Cria um deck e devolve o id. Pede conta, e o deck nasce de quem criou.

    O id tem 12 dígitos hex — mais que os 8 do pedido, porque aqui o estrago
    de acertar um por sorte é reescrever o deck de alguém (ver `decks.py`).
    """
    try:
        deck = decks.criar(corpo.get("nome", ""), corpo.get("comandantes"),
                           corpo.get("cartas"), corpo.get("maybeboard"),
                           corpo.get("categorias"), dono=quem["id"])
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
    REDUZ o conjunto de quem edita — ver o cabeçalho do `clerk.py`.

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


@app.get("/decks/{deck_id}/pedido", dependencies=[Depends(exige_amigo)])
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


def _deck_das_artes(deck_id: str, quem: dict) -> dict:
    """O deck, se quem chama pode mexer nas artes dele. É a mesma regra do
    autosave — pede conta, e deck com dono só o dono e o admin mexem —,
    porque escolher arte é editar o deck."""
    deck = _deck_ou_404(deck_id)
    existe, dono = decks.dono_de(deck_id)
    if not _pode_mexer(dono, quem):
        raise _proibido()
    return deck


@app.put("/decks/{deck_id}/artes")
def escolher_arte(deck_id: str, corpo: dict = Body(default={}),
                  quem: dict = Depends(exige_login_no_deck)):
    """Grava a arte de um lado de uma carta deste deck: a de todas as cópias,
    ou, com `copia`, a de uma só (ver `artes.py`). `arte_id` diz de onde a
    arte vem (ver `arte_id`)."""
    _deck_das_artes(deck_id, quem)
    try:
        escolha = artes.escolher(
            deck_id, corpo.get("nome", ""), corpo.get("arte_id", ""),
            face=corpo.get("face", "frente"), copia=corpo.get("copia", 0),
            arquivo=corpo.get("arquivo", ""), fonte=corpo.get("fonte", ""),
            dpi=corpo.get("dpi", 0),
            baixa_resolucao=corpo.get("baixa_resolucao", False))
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("artes", "escolheu", deck=deck_id, carta=escolha["nome"])
    return {"escolha": escolha}


@app.delete("/decks/{deck_id}/artes")
def limpar_arte(deck_id: str, nome: str, face: str = "frente", copia: int = 0,
                quem: dict = Depends(exige_login_no_deck)):
    """Volta um lado pra arte padrão — ou, com `copia`, uma cópia pra arte de
    todas."""
    _deck_das_artes(deck_id, quem)
    return {"ok": artes.limpar(deck_id, nome, face, copia)}


@app.delete("/decks/{deck_id}/artes/copias")
def limpar_copias_da_arte(deck_id: str, nome: str,
                          quem: dict = Depends(exige_login_no_deck)):
    """Desliga o "uma arte por cópia" de uma carta: fica a arte de todas."""
    _deck_das_artes(deck_id, quem)
    return {"apagadas": artes.limpar_copias(deck_id, nome)}


@app.post("/decks/{deck_id}/artes/padrao")
def aplicar_arte_padrao(deck_id: str, quem: dict = Depends(exige_login_no_deck)):
    """A imagem oficial da Scryfall em tudo o que ainda não tem arte (ver
    `artes.aplicar_padrao`). As escolhas do deck voltam junto: a tela
    redesenha tudo com elas, sem uma segunda ida ao servidor."""
    deck = _deck_das_artes(deck_id, quem)
    feito = artes.aplicar_padrao(deck)
    log.evento("artes", "padrao-aplicado", deck=deck_id, aplicadas=feito["aplicadas"])
    return {**feito, "escolhas": artes.do_deck(deck_id)}


@app.post("/decks/{deck_id}/artes/enviar")
def enviar_arte(deck_id: str, arquivo: UploadFile, nome: str = Form(...),
                face: str = Form("frente"), copia: int = Form(0),
                quem: dict = Depends(exige_login_no_deck)):
    """Sobe um arquivo de imagem e já o escolhe como arte de um lado da carta.

    Numa rota só, e não "sobe e depois escolhe": arquivo enviado sem escolha
    ficaria no disco sem ninguém que o use (ver `artes_enviadas`). Rota
    síncrona de propósito: conferir a imagem decodifica ela inteira, e numa
    rota `async` isso seguraria o servidor todo enquanto dura.
    """
    _deck_das_artes(deck_id, quem)
    dados = arquivo.file.read(artes_enviadas.TAMANHO_MAXIMO + 1)
    try:
        guardada = artes_enviadas.guardar(dados)
        escolha = artes.escolher(
            deck_id, nome, guardada["arte_id"], face=face, copia=copia,
            arquivo=arquivo.filename or "", fonte="Enviada",
            dpi=guardada["dpi"], baixa_resolucao=guardada["baixa_resolucao"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("artes", "enviou", deck=deck_id, carta=escolha["nome"],
               dpi=escolha["dpi"])
    return {"escolha": escolha}


@app.post("/decks/{deck_id}/artes/enviar/inicio")
def iniciar_envio_de_arte(deck_id: str,
                          quem: dict = Depends(exige_login_no_deck)):
    """Primeiro passo de subir uma arte: diz ao navegador COMO subir.

    `{"modo": "direto"}` é o POST de sempre (`/artes/enviar`, pro disco).
    Com o Vercel Blob ligado, devolve um token que só serve pra subir UM
    arquivo de imagem num caminho só, e o navegador manda o arquivo direto
    pra lá — uma função da Vercel não aceita corpo maior que 4,5 MB, e a arte
    do MPC passa disso. Ver `artes_enviadas.iniciar_envio`.
    """
    _deck_das_artes(deck_id, quem)
    return artes_enviadas.iniciar_envio()


@app.post("/decks/{deck_id}/artes/enviar/blob")
def concluir_envio_de_arte(deck_id: str, corpo: dict = Body(default={}),
                           quem: dict = Depends(exige_login_no_deck)):
    """Segundo passo, com o Blob: o arquivo já está lá. O site confere a
    imagem igual ao envio direto e já a escolhe como arte daquele lado da
    carta. `corpo`: `{url, nome, face, copia, arquivo}`."""
    _deck_das_artes(deck_id, quem)
    try:
        guardada = artes_enviadas.registrar_do_blob(str(corpo.get("url") or ""))
        escolha = artes.escolher(
            deck_id, str(corpo.get("nome") or ""), guardada["arte_id"],
            face=str(corpo.get("face") or "frente"),
            copia=int(corpo.get("copia") or 0),
            arquivo=str(corpo.get("arquivo") or "")[:200], fonte="Enviada",
            dpi=guardada["dpi"], baixa_resolucao=guardada["baixa_resolucao"])
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    except blob.BlobError as e:
        raise HTTPException(502, str(e))
    log.evento("artes", "enviou", deck=deck_id, carta=escolha["nome"],
               dpi=escolha["dpi"], via="blob")
    return {"escolha": escolha}


# O nome do arquivo enviado é o sha256 do conteúdo: o mesmo endereço nunca
# muda de imagem, e o navegador pode guardar pra sempre.
_ARTE_IMUTAVEL = {"Cache-Control": "public, max-age=31536000, immutable"}


@app.get("/artes/enviadas/{sha}")
def arte_enviada(sha: str):
    """O arquivo enviado, como veio. Pública como o link do deck: quem abre o
    deck vê as artes dele, e o endereço é o sha256 do conteúdo, que ninguém
    adivinha."""
    no_blob = artes_enviadas.url(sha)
    if no_blob:
        # O endereço do Blob nunca muda pra este sha, então o redirecionamento
        # também pode ficar no cache. O worker da impressora chega aqui e
        # segue o redirecionamento sozinho.
        return RedirectResponse(no_blob, status_code=307, headers=_ARTE_IMUTAVEL)
    if not artes_enviadas.existe(sha):
        raise HTTPException(404, "Arte não encontrada.")
    return FileResponse(artes_enviadas.caminho(sha),
                        media_type=artes_enviadas.tipo(sha), headers=_ARTE_IMUTAVEL)


@app.get("/artes/enviadas/{sha}/miniatura")
def miniatura_enviada(sha: str):
    """A miniatura da arte enviada, já sem sangria — a da grade e da prévia."""
    no_blob = artes_enviadas.url_miniatura(sha)
    if no_blob:
        return RedirectResponse(no_blob, status_code=307, headers=_ARTE_IMUTAVEL)
    caminho = artes_enviadas.caminho_miniatura(sha)
    if not caminho or not os.path.isfile(caminho):
        raise HTTPException(404, "Arte não encontrada.")
    return FileResponse(caminho, media_type="image/jpeg", headers=_ARTE_IMUTAVEL)


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
                quem: dict = Depends(exige_login_no_deck)):
    """Grava o deck por cima. É o autosave da tela.

    A validação vai na resposta, mas NÃO impede de gravar: deck pela metade é
    o estado normal de quem está montando (ver `decks.py`).

    Pede conta. Deck órfão qualquer conta grava; deck com dono, só ele e o
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
def duplicar_deck(deck_id: str, quem: dict = Depends(exige_login_no_deck)):
    """Cópia com id novo — o "salvar como" deste sistema.

    Pede conta, como criar deck. Fora isso fica LIVRE mesmo quando o original
    tem dono, de propósito: é a válvula de escape de quem abriu o deck de
    outra pessoa e quis mexer. Não altera nada do original, e a cópia nasce de
    quem duplicou — não do dono do original.
    """
    _deck_ou_404(deck_id)
    copia = decks.duplicar(deck_id)
    decks.definir_dono(copia["id"], quem["id"])
    copia = decks.obter(copia["id"])
    log.evento("deck", "duplicou", deck=deck_id, copia=copia["id"])
    return _deck_completo(copia)


@app.delete("/decks/{deck_id}")
def apagar_deck(deck_id: str, quem: dict = Depends(exige_login_no_deck)):
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


@app.get("/decks/{deck_id}/versoes")
def versoes_do_deck(deck_id: str):
    """O histórico: cada versão com o que entrou e saiu em relação à anterior,
    e o que a lista gravada mudou desde a última (ver `decks.historico`)."""
    return decks.historico(_deck_ou_404(deck_id))


@app.post("/decks/{deck_id}/versoes")
def concluir_versao_do_deck(deck_id: str,
                            quem: dict = Depends(exige_login_no_deck)):
    """Conclui a próxima versão com a lista que o servidor tem gravada.

    Quem chama grava antes o que estiver esperando o autosave: a fotografia é
    do banco, não da tela. Passa pela regra de dono do autosave — concluir
    versão é editar o deck.

    409 quando o deck como está não aceita versão nova (WIP com lista
    inválida, ou lista igual à última): não é "você não pode", é "ainda não
    há o que concluir", com a mensagem dizendo o porquê.
    """
    _deck_ou_404(deck_id)
    existe, dono = decks.dono_de(deck_id)
    if not _pode_mexer(dono, quem):
        raise _proibido()
    try:
        numero = decks.concluir_versao(deck_id)
    except decks.VersaoRecusada as e:
        raise HTTPException(409, str(e))
    if numero is None:
        raise HTTPException(404, "Deck não encontrado.")
    log.evento("deck", "versao", deck=deck_id, numero=numero)
    deck = decks.obter(deck_id)
    return {**_deck_completo(deck), "historico": decks.historico(deck)}


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
def manabase_do_deck(deck_id: str, teto: float | None = None,
                     categoria: str | None = None):
    """Quantos terrenos o deck pede, de que cores, e o que falta.

    É a única análise que não sai daqui: conta sobre o próprio deck e a base
    local, sem rede. Por isso é GET e por isso a tela pode chamar a cada
    autosave em vez de esperar um botão. `teto` (em dólar da Scryfall) tira
    da lista de fixação os terrenos mais caros; `categoria` é o ciclo aberto
    na tela, que vem com todos os terrenos em vez de só os primeiros.
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
                             else manabase.TETO_USD,
                             categoria=categoria or None)


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


@app.get("/precos")
def precos():
    """Reais por página em cada acabamento, pra tela do cliente mostrar e
    somar o mesmo valor que `POST /orders` vai cobrar."""
    return estoque.precos_por_pagina()


# A tinta que o worker contou vale por este tempo. Passou disso, a impressora
# está fora do ar há um bom tempo e o número velho não diz mais nada.
TINTA_VALIDADE_SEGUNDOS = int(os.environ.get("TINTA_VALIDADE_SEGUNDOS",
                                             str(2 * 86400)))


@app.get("/impressora/tinta")
def ink_level():
    """Nível de tinta da impressora, pra tela avisar quando vai demorar.

    Público de propósito — é a mesma informação que o aviso na página já dá,
    e ela precisa carregar antes de qualquer pedido. Quem pergunta pra
    impressora é o worker (ver `tinta.estado`, que já tira endereço e nome de
    fila); aqui só se devolve o que ele contou na última batida.
    """
    batida = storage.ler_worker("tinta")
    if (not batida or not isinstance(batida["valor"], dict)
            or time.time() - batida["em"] > TINTA_VALIDADE_SEGUNDOS):
        return {"estado": "desconhecido", "nivel": None, "marcadores": [],
                "fonte": "sem-worker"}
    return batida["valor"]


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
    """Lista as filas que o CUPS conhece, como o worker viu na última batida —
    é assim que se descobre o nome certo pra PRINTER_QUEUE do worker."""
    _check_admin(x_admin_token, quem)
    batida = storage.ler_worker("filas")
    if not batida:
        return {"erro": "o worker da impressora nunca deu sinal."}
    return {**(batida["valor"] or {}), "visto_em": batida["em"]}


@app.get("/admin/tinta")
def ink_diagnostics(x_admin_token: str | None = Header(default=None),
                    quem: dict | None = Depends(quem_e)):
    """O que a impressora respondeu sobre tinta, cru.

    Serve pra responder "esse modelo informa o nível?" sem abrir terminal:
    se não vier nenhum `marker-*`, ele não informa, e o aviso da página passa
    a depender do `TINTA_ESTADO` no .env do worker.
    """
    _check_admin(x_admin_token, quem)
    batida = storage.ler_worker("tinta_diagnostico")
    if not batida:
        return {"erro": "o worker da impressora nunca deu sinal."}
    return {**(batida["valor"] or {}), "visto_em": batida["em"]}


@app.get("/admin/visitas")
def list_visitas(x_admin_token: str | None = Header(default=None),
                 quem: dict | None = Depends(quem_e)):
    """Quem está no sistema agora, separado por classe.

    Complementa o `visitas.log`: o arquivo responde "o que aconteceu ontem",
    isto responde "tem alguém aí neste momento" sem precisar abrir terminal.
    A janela é `VISITA_JANELA_MINUTOS`.
    """
    _check_admin(x_admin_token, quem)
    if not REGISTRAR_VISITAS:
        return {"desligado": True,
                "nota": "Contagem de visitas desligada (REGISTRAR_VISITAS=0): "
                        "veja o Vercel Analytics."}
    ativas = visitas.registro.ativas()
    return {
        "janela_minutos": visitas.JANELA_MINUTOS,
        "pessoas": sum(1 for v in ativas if v["classe"] == "pessoa"),
        "bots": sum(1 for v in ativas if v["classe"].startswith("bot")),
        "suspeitos": sum(1 for v in ativas if v["classe"] == "suspeito"),
        "visitas": ativas,
    }


# --- Tela de pedidos (front/src/pages/admin) -------------------------------
#
# A página em si é só a casca: HTML, CSS e JS, sem nenhum dado de pedido
# dentro. TUDO que ela mostra vem das rotas abaixo, e todas passam pelo
# `_check_admin` — quem abrir /admin sem o token não vê pedido nenhum, só o
# pedido de token. É por isso que servir o arquivo estático publicamente não
# é problema: o que se protege é o dado, não o layout.


@app.get("/admin", response_class=HTMLResponse)
def admin_page():
    """Serve a tela de pedidos (`front/src/pages/admin`). Fica antes do mount
    estático pra a URL ser /admin, sem o .html."""
    return frontend.page("admin")


@app.get("/admin/sessao")
def admin_session(x_admin_token: str | None = Header(default=None),
                  quem: dict | None = Depends(quem_e)):
    """Só diz se o token vale. A tela chama isto ao abrir (e ao colar um
    token novo) pra saber se mostra a lista ou o formulário de entrada, sem
    ter que pedir a lista inteira só pra descobrir isso."""
    _check_admin(x_admin_token, quem)
    filas = storage.ler_worker("filas")
    return {"ok": True,
            "impressora": ((filas or {}).get("valor") or {}).get(
                "printer_queue_configurada"),
            "worker": {"visto_em": _worker_visto(),
                       "offline_segundos": WORKER_OFFLINE_SEGUNDOS},
            "email_configurado": notify.is_configured()}


@app.get("/admin/pedidos")
def admin_list_orders(status: str | None = None, busca: str | None = None,
                      limite: int = 200,
                      x_admin_token: str | None = Header(default=None),
                      quem: dict | None = Depends(quem_e)):
    """Todos os pedidos, do mais novo pro mais antigo, com os contadores por
    estado. A folha de cada um se confere no painel do worker, na rede de
    casa — o site não monta nem guarda PDF."""
    _check_admin(x_admin_token, quem)
    pedidos = storage.list_orders(status=status, busca=busca, limite=limite)
    return {"contagem": storage.count_by_status(), "pedidos": pedidos}


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
    return pedido


@app.post("/admin/pedidos/{order_id}/status")
def admin_set_status(order_id: str, status: str = Form(...),
                     x_admin_token: str | None = Header(default=None),
                     quem: dict | None = Depends(quem_e)):
    """Muda o estado de um pedido na mão.

    Serve pros casos que o fluxo normal não cobre: marcar como impresso um
    pedido que saiu por fora da fila, cancelar um pedido abandonado, ou desfazer
    um clique errado voltando pra 'pending'.

    Marcar como 'impresso' por aqui NÃO imprime nada — é o "imprimi por
    fora". Quem manda pra impressora é o botão de imprimir, que é uma ação
    separada de propósito (papel e tinta não voltam).
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


@app.post("/admin/pedidos/{order_id}/imprimir")
def admin_print(order_id: str,
                x_admin_token: str | None = Header(default=None),
                quem: dict | None = Depends(quem_e)):
    """Mesmo efeito do link "Imprimir" do e-mail: confirma o Pix e põe o
    pedido na fila (`a_imprimir`). Também é o "imprimir de novo".

    Não espera a impressora: o worker pega na próxima passada, e a tela
    acompanha pelo `GET /admin/pedidos/{id}` até sair de `a_imprimir` /
    `imprimindo`.
    """
    _check_admin(x_admin_token, quem)
    try:
        if not storage.pedir_impressao(order_id):
            raise HTTPException(404, "Pedido não encontrado.")
    except storage.FilaError as e:
        raise HTTPException(409, str(e))
    log.evento("admin", "pediu-impressao", pedido=order_id)
    return {"ok": True,
            "mensagem": "Pagamento confirmado — o pedido está na fila da "
                        "impressora." + _aviso_worker(),
            "pedido": storage.get_order(order_id)}


# --- Combinar pedidos numa folha só ----------------------------------------
#
# Pedido pequeno desperdiça papel: 4 cartas ocupam uma folha inteira e deixam
# 5 slots em branco. Marcando vários na tela, as filas de impressão deles
# viram uma fila corrida e só a última folha do conjunto sai incompleta.
#
# O que NÃO muda: o valor de cada pedido (foi o combinado com o cliente). O
# estado anda junto: quando a folha vai pra fila, todos os pedidos dela vão
# junto, e saem dela juntos (ver `storage.pedir_impressao_combo`).


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
    return {
        "id": combo_id,
        "lamination": pedidos[0]["lamination"] if pedidos else None,
        "pedidos": [{"id": p["id"], "customer_name": p["customer_name"],
                     "status": p["status"], "pages": p["pages"],
                     "amount": p["amount"]} for p in pedidos],
        "valor_total": round(sum(float(p["amount"] or 0) for p in pedidos), 2),
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
    for campo in ("status", "impressao_msg", "impressao_falhas", "impresso_em"):
        resposta[campo] = combo.get(campo)
    # Pedido apagado depois de a folha ter sido combinada: a montagem vai
    # recusar, e é melhor a tela saber disso antes de gastar minutos baixando.
    resposta["faltando"] = [i for i in combo["order_ids"]
                            if i not in {p["id"] for p in pedidos}]
    return resposta


@app.post("/admin/combos/{combo_id}/imprimir")
def admin_print_combo(combo_id: str,
                      x_admin_token: str | None = Header(default=None),
                      quem: dict | None = Depends(quem_e)):
    """Põe a folha combinada na fila e confirma o Pix de TODOS os pedidos dela.

    É um papel só com as cartas de várias pessoas, então não existe imprimir
    metade: ou o conjunto inteiro é confirmado, ou nenhum. Confira os Pix de
    todos antes — a tela pede confirmação do outro lado. A tela acompanha pelo
    `GET /admin/combos/{id}` até a folha sair da fila.
    """
    _check_admin(x_admin_token, quem)
    try:
        ids = storage.pedir_impressao_combo(combo_id)
    except storage.FilaError as e:
        raise HTTPException(409, str(e))
    # O material que a fila corrida deixa de gastar volta já aqui, no mesmo
    # clique que confirmou: é uma vez por combinação, e imprimir a mesma
    # folha de novo não devolve outra vez.
    pedidos = [p for p in (storage.get_order(i) for i in ids) if p]
    estoque.devolver_combinacao(combo_id, pedidos)
    log.evento("admin", "pediu-impressao-combinada", combo=combo_id,
               pedidos=len(ids))
    return {"ok": True,
            "mensagem": f"{len(ids)} pedido(s) confirmados — a folha combinada "
                        f"está na fila da impressora." + _aviso_worker(),
            "pedidos": ids}


@app.delete("/admin/combos/{combo_id}")
def admin_delete_combo(combo_id: str,
                       x_admin_token: str | None = Header(default=None),
                       quem: dict | None = Depends(quem_e)):
    """Esquece a combinação.

    Os pedidos NÃO são tocados: desfazer uma combinação é só jogar fora um
    arranjo de papel, e cada pedido continua com o estado que tinha. A folha
    montada, se houver, fica no disco do worker até a faxina dele.
    """
    _check_admin(x_admin_token, quem)
    if not storage.delete_combo(combo_id):
        raise HTTPException(404, "Combinação não encontrada.")
    log.evento("admin", "desfez-combinado", combo=combo_id)
    return {"ok": True}


@app.delete("/admin/pedidos/{order_id}")
def admin_delete_order(order_id: str,
                       x_admin_token: str | None = Header(default=None),
                       quem: dict | None = Depends(quem_e)):
    """Apaga o pedido de vez. A folha montada, se houver, fica no disco do
    worker até a faxina dele.

    O XML do deck vive só aqui, então isso não tem volta — por isso a tela
    pede o id digitado antes de chamar. Pra tirar da frente sem perder o
    histórico, o caminho é cancelar.
    """
    _check_admin(x_admin_token, quem)
    if not storage.delete_order(order_id):
        raise HTTPException(404, "Pedido não encontrado.")
    log.evento("admin", "apagou-pedido", pedido=order_id)
    return {"ok": True}


# --- Estoque de material (aba Estoque da tela do admin) --------------------
#
# A baixa não passa por aqui: ela acompanha o status do pedido dentro do
# `storage` (ver `estoque.sincronizar`). Estas rotas são o lado manual —
# compra, contagem, tinta e os preços: o que custa uma folha e o que se cobra.


def _item_de_estoque(item: str) -> None:
    if item not in estoque.ITENS:
        raise HTTPException(404, "Item de estoque não encontrado.")


@app.get("/admin/estoque")
def admin_estoque(x_admin_token: str | None = Header(default=None),
                  quem: dict | None = Depends(quem_e)):
    """Saldo de cada item, custo de uma folha e os últimos movimentos."""
    _check_admin(x_admin_token, quem)
    return estoque.resumo()


@app.post("/admin/estoque/{item}/entrada")
def admin_estoque_entrada(item: str, corpo: dict = Body(default={}),
                          x_admin_token: str | None = Header(default=None),
                          quem: dict | None = Depends(quem_e)):
    """Soma uma compra ao saldo. `valor_pago`, se vier, vira o preço por
    unidade do item."""
    _check_admin(x_admin_token, quem)
    _item_de_estoque(item)
    try:
        estoque.entrada(item, corpo.get("quantidade"), corpo.get("valor_pago"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("estoque", "entrada", item=item,
               quantidade=corpo.get("quantidade"))
    return estoque.resumo()


@app.post("/admin/estoque/{item}/contagem")
def admin_estoque_contagem(item: str, corpo: dict = Body(default={}),
                           x_admin_token: str | None = Header(default=None),
                           quem: dict | None = Depends(quem_e)):
    """Troca o saldo pelo que foi contado. A diferença fica nos movimentos."""
    _check_admin(x_admin_token, quem)
    _item_de_estoque(item)
    try:
        estoque.contagem(item, corpo.get("quantidade"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("estoque", "contagem", item=item,
               quantidade=corpo.get("quantidade"))
    return estoque.resumo()


@app.post("/admin/estoque/{item}/ajustes")
def admin_estoque_ajustes(item: str, corpo: dict = Body(default={}),
                          x_admin_token: str | None = Header(default=None),
                          quem: dict | None = Depends(quem_e)):
    """Mínimo de alerta e preço por unidade de um item."""
    _check_admin(x_admin_token, quem)
    _item_de_estoque(item)
    try:
        estoque.ajustar_item(item, minimo=corpo.get("minimo"),
                             custo_unitario=corpo.get("custo_unitario"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return estoque.resumo()


@app.post("/admin/estoque/custos")
def admin_estoque_custos(corpo: dict = Body(default={}),
                         x_admin_token: str | None = Header(default=None),
                         quem: dict | None = Depends(quem_e)):
    """Preço cobrado por página e folhas por plástico, em cada acabamento.

    O preço vale pra pedido novo; pedido que já existe guarda o valor dele.
    """
    _check_admin(x_admin_token, quem)
    try:
        estoque.ajustar_custos(corpo)
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.evento("estoque", "custos", **{k: v for k, v in corpo.items()
                                       if k in estoque._CONFIG_PADRAO})
    return estoque.resumo()


@app.post("/admin/estoque/tinta")
def admin_estoque_tinta(corpo: dict = Body(default={}),
                        x_admin_token: str | None = Header(default=None),
                        quem: dict | None = Depends(quem_e)):
    """Preço e volume de cada garrafa e o consumo por folha, por cor."""
    _check_admin(x_admin_token, quem)
    try:
        estoque.ajustar_tintas(corpo)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return estoque.resumo()


@app.get("/admin/fontes")
def admin_fontes(x_admin_token: str | None = Header(default=None),
                 quem: dict | None = Depends(quem_e)):
    """As fontes de fora respondem a este servidor? Uma requisição a cada uma
    (LigaMagic, Scryfall, EDHREC, Spellbook, MPC Fill, Archidekt, Moxfield e
    o câmbio) e um veredito: responde, bloqueado ou fora. É o teste a fazer
    logo depois de mudar de servidor — ver `diagnostico.py`."""
    _check_admin(x_admin_token, quem)
    return diagnostico.testar_fontes()


@app.post("/admin/cleanup")
def run_cleanup(x_admin_token: str | None = Header(default=None),
                quem: dict | None = Depends(quem_e)):
    """Roda a faxina na hora (os PDFs velhos que este processo ainda
    tenha), sem esperar o ciclo diário."""
    _check_admin(x_admin_token, quem)
    return cleanup.run_once()


# --- Worker da impressora (`worker/`, roda no homelab) ----------------------
#
# A conversa é sempre de lá pra cá: o worker pergunta a fila, reserva o que
# vai imprimir e conta o resultado. Este lado não sabe onde o worker mora nem
# se ele existe — só que alguém com o WORKER_TOKEN passou por aqui (`visto`).
#
# Cada troca de estado é condicionada (ver `storage.reservar`): se a linha não
# estava onde o worker achava, a resposta é 409 e ele segue pra próxima. Isso
# é o que deixa duas rodadas do worker lerem a mesma fila sem imprimir nada em
# dobro.


def _check_worker(authorization: str | None = Header(default=None)) -> None:
    if not WORKER_TOKEN:
        raise HTTPException(503, "Worker desligado (WORKER_TOKEN vazia).")
    if not authorization or not hmac.compare_digest(
            str(authorization), f"Bearer {WORKER_TOKEN}"):
        raise HTTPException(401, "Token do worker inválido ou ausente.")


@app.get("/worker/fila", dependencies=[Depends(_check_worker)])
def worker_fila():
    """O que imprimir e o que adiantar. Cada pergunta conta como sinal de
    vida — é ela que o admin usa pra dizer se a impressora está no ar."""
    storage.salvar_worker("visto", True)
    return storage.fila_do_worker()


@app.get("/worker/pedidos/{order_id}", dependencies=[Depends(_check_worker)])
def worker_pedido(order_id: str):
    """O pedido com o XML — o que o worker precisa pra montar a folha."""
    pedido = storage.get_order_with_xml(order_id)
    if not pedido:
        raise HTTPException(404, "Pedido não encontrado.")
    return pedido


@app.get("/worker/combos/{combo_id}", dependencies=[Depends(_check_worker)])
def worker_combo(combo_id: str):
    """A folha combinada com os pedidos dela, com XML, NA ORDEM DE IMPRESSÃO."""
    combo = storage.get_combo(combo_id)
    if not combo:
        raise HTTPException(404, "Combinação não encontrada.")
    pedidos = storage.get_orders_with_xml(combo["order_ids"])
    if len(pedidos) < len(combo["order_ids"]):
        faltando = set(combo["order_ids"]) - {p["id"] for p in pedidos}
        raise HTTPException(409, "Pedido apagado depois que a combinação foi "
                                 f"montada: {', '.join(sorted(faltando))}.")
    return {**combo, "pedidos": pedidos}


@app.get("/worker/conferir", dependencies=[Depends(_check_worker)])
def worker_conferir():
    """O que o painel do worker lista pra conferir a folha antes de imprimir:
    pedidos e folhas combinadas que interessam agora, sem XML."""
    return storage.lista_para_conferir()


_RESERVAR = {"pedidos": storage.reservar, "combos": storage.reservar_combo}
_CONCLUIR = {"pedidos": storage.concluir, "combos": storage.concluir_combo}
_FALHAR = {"pedidos": storage.falhar, "combos": storage.falhar_combo}


def _tipo_do_worker(tipo: str) -> str:
    if tipo not in _RESERVAR:
        raise HTTPException(404, "Tipo desconhecido.")
    return tipo


@app.post("/worker/{tipo}/{item_id}/reservar",
          dependencies=[Depends(_check_worker)])
def worker_reservar(tipo: str, item_id: str):
    """`a_imprimir -> imprimindo`. 409 = não está mais na fila (outro pegou,
    ou o operador mudou de ideia) — o worker NÃO imprime."""
    if not _RESERVAR[_tipo_do_worker(tipo)](item_id):
        raise HTTPException(409, "Não está na fila de impressão.")
    log.evento("worker", "reservou", tipo=tipo, id=item_id)
    return {"ok": True}


@app.post("/worker/{tipo}/{item_id}/concluir",
          dependencies=[Depends(_check_worker)])
def worker_concluir(tipo: str, item_id: str, corpo: dict = Body(default={})):
    """O CUPS aceitou. `corpo`: `{"mensagem": str, "falhas": int}`."""
    mensagem = str(corpo.get("mensagem") or "")[:2000]
    try:
        falhas = max(0, int(corpo.get("falhas") or 0))
    except (TypeError, ValueError):
        falhas = 0
    if not _CONCLUIR[_tipo_do_worker(tipo)](item_id, mensagem, falhas):
        raise HTTPException(409, "Não estava imprimindo.")
    log.evento("worker", "imprimiu", tipo=tipo, id=item_id, falhas=falhas)
    return {"ok": True}


@app.post("/worker/{tipo}/{item_id}/falhar",
          dependencies=[Depends(_check_worker)])
def worker_falhar(tipo: str, item_id: str, corpo: dict = Body(default={})):
    """O CUPS (ou a montagem) recusou. `corpo`: `{"mensagem": str}`."""
    mensagem = str(corpo.get("mensagem") or "erro sem detalhe")[:2000]
    if not _FALHAR[_tipo_do_worker(tipo)](item_id, mensagem):
        raise HTTPException(409, "Não estava imprimindo.")
    log.aviso("worker", "falhou", tipo=tipo, id=item_id, motivo=mensagem[:200])
    return {"ok": True}


# O que a batida pode trazer, e com que nome fica guardado.
_BATIDA = ("tinta", "tinta_diagnostico", "filas")


@app.post("/worker/batida", dependencies=[Depends(_check_worker)])
def worker_batida(corpo: dict = Body(default={})):
    """O estado da impressora, de tempos em tempos: `tinta` (o que a página
    pública mostra), `tinta_diagnostico` e `filas` (só o admin vê)."""
    for chave in _BATIDA:
        if isinstance(corpo.get(chave), dict):
            storage.salvar_worker(chave, corpo[chave])
    storage.salvar_worker("visto", True)
    return {"ok": True}


@app.get("/")
def pagina_inicial(deck: str | None = None):
    """A página inicial é a lista de decks (`front/src/pages/decks`).

    O HTML não tem deck nenhum dentro: quais aparecem, quem decide é o
    navegador, com a lista que ele guarda e a conta — por isso servi-lo
    publicamente não é problema.

    `/?deck=ID` era o "Gerar pedido" do deckbuilder quando a raiz era a tela
    de pedido, e esse link anda por aí em conversa: vai pra onde a tela foi.
    """
    if deck:
        return RedirectResponse(f"/pedido?deck={quote(deck, safe='')}", status_code=301)
    return frontend.page("decks")


@app.get("/pedido")
def pagina_de_pedido():
    """Orçamento, revisão da folha e cobrança Pix (`front/src/pages/home`).
    A página abre pra qualquer um; quem fecha são as rotas de pedido
    (`exige_amigo`), e a tela diz a quem não é amigo por que não dá."""
    return frontend.page("home")


# O resto de `app/static/` (os assets do build, em `/dist/`) sai pelo mount.
# Fica depois de todas as rotas de propósito — assim /orders, /admin/...
# continuam resolvendo certo, e qualquer outro caminho cai no arquivo.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
