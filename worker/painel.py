"""
O painel do worker: conferir a folha antes de imprimir, pela rede de casa.

A folha é montada aqui, do lado da impressora, e não sai daqui: o site não
guarda PDF nenhum (e nem sabe que este painel existe). Quem quer conferir
abre `http://<ip-do-homelab>:8001` no navegador ou no celular, na rede local.

O que tem na tela: os pedidos que interessam agora (avisou que pagou, na fila,
com erro, impressos nos últimos dias) e as folhas combinadas recentes — a
lista vem do site (`GET /worker/conferir`) — e, pra cada um, como está a
folha no disco: pronta, com carta faltando, montando, ou ainda não montada.

Este painel NÃO monta nada sozinho: "Montar" e "Refazer" deixam um pedido na
fila do laço do worker (`main.pedir_montagem`), que é o único que monta. Duas
montagens do mesmo arquivo ao mesmo tempo corrompiam a folha.

A tela de pedidos (`front/src/pages/admin`) também mora aqui, em `/admin`, e
só aqui: o site tem a API (`/admin/*`, atrás da `ADMIN_TOKEN`), mas não serve
a tela. O navegador fala com este painel, e o painel repassa as chamadas pro
site (`_repassar`) com o `X-Admin-Token` que o operador digitou — a conversa
continua sendo sempre daqui pra lá.

Senha: com `WORKER_PAINEL_SENHA` no ambiente, o navegador pede usuário e senha
(qualquer usuário, essa senha). Sem ela o painel fica aberto pra quem estiver
na rede — que é a rede de casa, mas a lista tem nome de cliente.
"""
import hmac
import html
import os
import re
import time

import requests
from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from app import frontend

from . import entrega
from . import main as worker

SENHA = os.environ.get("WORKER_PAINEL_SENHA", "")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

ESTADOS = {
    "pending": "Aguardando pagamento",
    "notified": "Avisou que pagou",
    "a_imprimir": "Na fila da impressora",
    "imprimindo": "Imprimindo",
    "impresso": "Impresso",
    "erro_impressao": "Erro na impressão",
    "cancelado": "Cancelado",
}
LAMINACAO = {"single": "Um lado", "double": "Dois lados", "foil": "Foil"}

_basic = HTTPBasic(auto_error=False)

# O que passa do navegador pro site, nas chamadas da tela de pedidos. O
# `Authorization` fica de fora: é a senha deste painel, não é do site.
_CABECALHOS = ("x-admin-token", "content-type", "accept")


def _porta(credenciais: HTTPBasicCredentials | None = Depends(_basic)) -> None:
    if not SENHA:
        return
    if credenciais and hmac.compare_digest(credenciais.password, SENHA):
        return
    raise HTTPException(401, "Senha do painel.",
                        headers={"WWW-Authenticate": 'Basic realm="Forja"'})


def _validar(tipo: str, item_id: str) -> None:
    if tipo not in worker.TIPOS or not _ID.match(item_id):
        raise HTTPException(404, "Não existe.")


def _folha(tipo: str, item_id: str) -> dict:
    """Como está a folha: o que o laço está fazendo com ela, ou o disco."""
    agora = worker.montagem(tipo, item_id)
    if agora and agora.get("estado") in ("montando", "na-fila", "erro"):
        return agora
    if os.path.exists(worker._caminho(tipo, item_id)):
        return {"estado": "pronto",
                "falhas": worker.falhas_no_disco(tipo, item_id),
                "mtime": os.path.getmtime(worker._caminho(tipo, item_id))}
    return {"estado": "ausente"}


def _quando(epoch) -> str:
    if not epoch:
        return ""
    return time.strftime("%d/%m %H:%M", time.localtime(float(epoch)))


def _e(texto) -> str:
    return html.escape(str(texto if texto is not None else ""))


def _linha(tipo: str, item: dict, titulo: str, detalhes: str) -> str:
    folha = _folha(tipo, item["id"])
    estado = folha["estado"]
    acoes = []
    if estado == "montando":
        onde = (f"{folha.get('feitas', 0)} de {folha['total']} imagens"
                if folha.get("total") else "lendo a lista de cartas")
        situacao = f'<span class="andando">Montando — {onde}</span>'
    elif estado == "na-fila":
        situacao = '<span class="andando">Na fila do worker…</span>'
    elif estado == "erro":
        situacao = f'<span class="erro">Não montou: {_e(folha.get("detalhe"))}</span>'
        acoes.append(("Tentar de novo", True))
    elif estado == "pronto":
        if folha.get("falhas"):
            situacao = (f'<span class="erro">Pronta, mas {folha["falhas"]} '
                        f'carta(s) não baixaram (quadro de falha)</span>')
        else:
            situacao = f'<span class="ok">Pronta ({_quando(folha.get("mtime"))})</span>'
        acoes.append(("Refazer", True))
    else:
        situacao = '<span class="nada">Ainda não montada</span>'
        acoes.append(("Montar", False))

    botoes = ""
    if estado == "pronto":
        botoes += (f'<a class="btn ouro" href="/pdf/{tipo}/{_e(item["id"])}" '
                   f'target="_blank">Ver PDF</a>')
    for rotulo, refazer in acoes:
        botoes += (f'<form method="post" action="/montar/{tipo}/{_e(item["id"])}">'
                   f'<input type="hidden" name="refazer" value="{int(refazer)}">'
                   f'<button class="btn">{rotulo}</button></form>')
    return (f'<div class="item"><div class="topo"><b>{titulo}</b>'
            f'<span class="pill">{_e(ESTADOS.get(item.get("status"), item.get("status") or "combinada"))}</span>'
            f'</div><div class="meta">{detalhes}</div>'
            f'<div class="situacao">{situacao}</div>'
            f'<div class="acoes">{botoes}</div></div>')


def _pagina(lista: dict | None, erro: str | None) -> str:
    andando = False
    blocos = []
    if erro:
        blocos.append(f'<div class="aviso">Não consegui falar com o site: '
                      f'{_e(erro)}. A lista volta quando ele responder.</div>')
    if lista is not None:
        pedidos = lista.get("pedidos", [])
        combos = lista.get("combos", [])
        linhas = []
        for p in pedidos:
            titulo = f"{_e(p.get('customer_name') or '(sem nome)')} · #{_e(p['id'])}"
            detalhes = (f"{_e(p.get('pages'))} pág. · "
                        f"{_e(LAMINACAO.get(p.get('lamination'), p.get('lamination')))}"
                        f" · deck {_e(p.get('deck_hash'))}"
                        + (" · <i>numa folha combinada</i>"
                           if p.get("impressao_combo") else ""))
            linhas.append(_linha("pedido", p, titulo, detalhes))
        blocos.append("<h2>Pedidos</h2>" + ("".join(linhas) or
                      '<div class="vazio">Nenhum pedido esperando conferência.</div>'))
        linhas = []
        for c in combos:
            nomes = ", ".join(f"{_e(n)}" for n in c.get("nomes", []))
            titulo = f"Folha combinada · {len(c.get('order_ids', []))} pedidos"
            detalhes = f"{nomes} · criada {_quando(c.get('created_at'))}"
            linhas.append(_linha("combo", c, titulo, detalhes))
        if linhas:
            blocos.append("<h2>Folhas combinadas</h2>" + "".join(linhas))
        andando = any(_folha("pedido", p["id"])["estado"] in ("montando", "na-fila")
                      for p in pedidos) or any(
            _folha("combo", c["id"])["estado"] in ("montando", "na-fila")
            for c in combos)
    recarga = '<meta http-equiv="refresh" content="4">' if andando else ""
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{recarga}
<title>Conferir folhas — Forja</title>
<style>
  :root{{--bg:#0F0D17;--surface:#1B1730;--border:#382F5C;--text:#EDE6D6;
        --muted:#A79BC7;--gold:#C9A227;--green:#4C9A6B;--red:#D9634A;}}
  body{{margin:0;background:var(--bg);color:var(--text);
       font-family:system-ui,sans-serif;padding:16px;}}
  main{{max-width:760px;margin:0 auto;}}
  h1{{font-size:20px;color:var(--gold);margin:0 0 4px;}}
  h2{{font-size:14px;color:var(--muted);text-transform:uppercase;
      letter-spacing:.06em;margin:22px 0 8px;}}
  p.sub{{color:var(--muted);font-size:13px;margin:0 0 8px;}}
  .item{{background:var(--surface);border:1px solid var(--border);
        border-radius:12px;padding:12px 14px;margin-bottom:10px;}}
  .topo{{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;}}
  .topo b{{flex:1;min-width:0;}}
  .pill{{font-size:10px;text-transform:uppercase;letter-spacing:.06em;
        border:1px solid var(--border);border-radius:999px;padding:3px 9px;
        color:var(--muted);white-space:nowrap;}}
  .meta{{color:var(--muted);font-size:12px;margin-top:6px;}}
  .situacao{{font-size:13px;margin-top:8px;}}
  .ok{{color:var(--green);}} .erro{{color:#F2AFA1;}}
  .andando{{color:var(--gold);}} .nada{{color:var(--muted);}}
  .acoes{{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}}
  .acoes form{{margin:0;}}
  .btn{{background:transparent;color:var(--text);border:1px solid var(--border);
       border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;
       text-decoration:none;display:inline-block;}}
  .btn.ouro{{background:var(--gold);color:#1A1408;border-color:var(--gold);
            font-weight:600;}}
  .aviso{{border:1px solid var(--red);color:#F2AFA1;border-radius:10px;
         padding:10px 12px;font-size:13px;}}
  .vazio{{color:var(--muted);font-size:13px;}}
  a{{color:var(--gold);}}
</style></head>
<body><main>
  <h1>Conferir folhas</h1>
  <p class="sub">A folha é montada aqui, ao lado da impressora. Confira antes
  de mandar imprimir pela <a href="/admin">tela de pedidos</a>.</p>
  {"".join(blocos)}
</main></body></html>"""


def criar_app(api) -> FastAPI:
    app = FastAPI(title="Forja — painel do worker", docs_url=None,
                  redoc_url=None, openapi_url=None,
                  dependencies=[Depends(_porta)])

    @app.get("/", response_class=HTMLResponse)
    def inicio():
        try:
            lista, erro = api.get("/worker/conferir"), None
        except Exception as e:
            lista, erro = None, f"{type(e).__name__}: {e}"
        return HTMLResponse(_pagina(lista, erro),
                            headers={"Cache-Control": "no-store"})

    @app.get("/pdf/{tipo}/{item_id}")
    def ver_pdf(request: Request, tipo: str, item_id: str):
        _validar(tipo, item_id)
        caminho = worker._caminho(tipo, item_id)
        if not os.path.exists(caminho):
            raise HTTPException(404, "Essa folha ainda não foi montada.")
        nome = f"{'pedido' if tipo == 'pedido' else 'combinado'}-{item_id}"
        return entrega.servir_pdf(request, caminho, nome,
                                  worker.falhas_no_disco(tipo, item_id))

    @app.post("/montar/{tipo}/{item_id}")
    def montar(tipo: str, item_id: str, refazer: int = Form(0)):
        _validar(tipo, item_id)
        worker.pedir_montagem(tipo, item_id, refazer=bool(refazer))
        return RedirectResponse("/", status_code=303)

    # --- A tela de pedidos -------------------------------------------------

    @app.get("/admin", response_class=HTMLResponse)
    def tela_de_pedidos():
        return frontend.page("admin")

    async def _repassar(request: Request) -> Response:
        """A chamada da tela, feita no site. Uma requisição por vez, sem a
        `Session` do laço: ela leva o `WORKER_TOKEN`, e quem fala aqui é o
        operador, com o token dele."""
        corpo = await request.body()
        cabecalhos = {k: v for k, v in request.headers.items()
                      if k.lower() in _CABECALHOS}
        cabecalhos["User-Agent"] = "forja-worker/1.0"
        try:
            r = await run_in_threadpool(
                requests.request, request.method,
                api.base + request.url.path, params=request.url.query or None,
                data=corpo or None, headers=cabecalhos, timeout=worker.TIMEOUT)
        except requests.RequestException as e:
            return Response(f"Não consegui falar com o site: {type(e).__name__}",
                            status_code=502, media_type="text/plain")
        return Response(r.content, status_code=r.status_code,
                        media_type=r.headers.get("content-type"))

    app.add_api_route("/admin/{resto:path}", _repassar,
                      methods=["GET", "POST", "DELETE"])
    # Apagar um deck, da aba Baralhos: a rota é a mesma do dono.
    app.add_api_route("/decks/{deck_id}", _repassar, methods=["DELETE"])

    @app.get("/deckbuilder")
    def deckbuilder(request: Request):
        """O Abrir da aba Baralhos: o deckbuilder é do site, não daqui."""
        destino = api.base + "/deckbuilder"
        if request.url.query:
            destino += "?" + request.url.query
        return RedirectResponse(destino, status_code=302)

    # Os assets do build, com hash no nome (ver `app/frontend.py`). Sem o
    # build, `check_dir=False` deixa o painel subir e o /admin responde 503.
    app.mount("/dist", StaticFiles(directory=frontend.DIST, check_dir=False),
              name="dist")

    return app
