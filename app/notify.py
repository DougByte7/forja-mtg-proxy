import os
import smtplib
from email.message import EmailMessage

SMTP_HOST = os.environ.get("SMTP_HOST")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASS = os.environ.get("SMTP_PASS")
NOTIFY_TO = os.environ.get("NOTIFY_TO")


def is_configured() -> bool:
    return bool(SMTP_HOST and SMTP_USER and SMTP_PASS and NOTIFY_TO)


def _send(msg: EmailMessage):
    if not is_configured():
        print("[notify] SMTP não configurado — pulando envio de e-mail.")
        return
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


LAM_LABELS = {"single": "Um lado", "double": "Dois lados", "foil": "Foil"}


def send_payment_claim_email(orders: list[dict], print_urls: list[str]):
    """
    O cliente clicou em "Pagamento realizado, enviar notificação".

    Isso é só um AVISO — nada foi verificado com o banco. O e-mail traz o
    resumo do pedido e um link "Imprimir" que só deve ser clicado depois de
    conferir no app do banco que o Pix caiu mesmo. É o clique em Imprimir que
    confirma o pagamento e põe o pedido na fila da impressora.

    `orders` é mais de um quando a cobrança juntou o pedido padrão e o foil
    (ver `storage.create_group`): um Pix só, com a soma, e um "Imprimir" por
    pedido — cada um vai pro seu papel. `print_urls` vem na mesma ordem.

    A folha não vai no e-mail nem tem link: ela é montada pelo worker da
    impressora e se confere no painel dele, na rede de casa. O site não sabe
    onde fica esse painel, e por isso o e-mail só diz que ele existe.
    """
    primeiro = orders[0]
    nome = primeiro["customer_name"]
    total = sum(o["amount"] for o in orders)
    varios = len(orders) > 1

    def lam(o):
        return LAM_LABELS.get(o["lamination"], o["lamination"])

    msg = EmailMessage()
    msg["Subject"] = (
        f"Pix avisado — {nome} | R$ {total:.2f} | pedido {primeiro['id']}"
        + (f" (+{len(orders) - 1} foil)" if varios else "")
    )
    msg["From"] = SMTP_USER or "forja@localhost"
    msg["To"] = NOTIFY_TO or ""

    def bloco_texto(o, url):
        return (
            f"Pedido {o['id']} — {lam(o)}\n"
            f"Código do deck: {o['deck_hash']}\n"
            f"Cartas: {o['qty']}\n"
            f"Páginas: {o['pages']}\n"
            f"Espaços em branco na última página: {o['blanks']}\n"
            f"Laminação: {lam(o)}\n"
            f"Valor: R$ {o['amount']:.2f}\n"
            f"Se o Pix caiu e a folha está certa, imprime:\n{url}\n"
        )

    msg.set_content(
        f"{nome} avisou que pagou o Pix do pedido {primeiro['id']}"
        + (f", que junta {len(orders)} pedidos (padrão e foil)" if varios else "") + ".\n"
        f"(é só o aviso do cliente — confere no app do banco antes de imprimir)\n\n"
        f"Nome: {nome}\n"
        f"Valor cobrado: R$ {total:.2f}\n\n"
        + "\n".join(bloco_texto(o, u) for o, u in zip(orders, print_urls))
        + "\nA folha já está sendo montada no worker: confira no painel dele, na "
          "rede de casa, antes de gastar papel.\n"
    )

    def bloco_html(o, url):
        return f"""\
  <h3 style="margin:20px 0 6px;font-size:15px;">Pedido <code>{o['id']}</code> — {lam(o)}</h3>
  <table cellpadding="6" style="border-collapse:collapse;font-size:14px;">
    <tr><td>Código do deck</td><td><code>{o['deck_hash']}</code></td></tr>
    <tr><td>Cartas</td><td><b>{o['qty']}</b></td></tr>
    <tr><td>Páginas</td><td><b>{o['pages']}</b></td></tr>
    <tr><td>Em branco na última pág.</td><td><b>{o['blanks']}</b></td></tr>
    <tr><td>Laminação</td><td><b>{lam(o)}</b></td></tr>
    <tr><td>Valor</td><td><b>R$ {o['amount']:.2f}</b></td></tr>
  </table>
  <p style="margin:14px 0;">
    <a href="{url}"
       style="background:#C9A227;color:#1A1408;text-decoration:none;
              padding:14px 24px;border:2px solid #C9A227;border-radius:8px;
              font-weight:bold;display:inline-block;margin:0 0 10px 0;">Imprimir{
                  ' ' + lam(o).lower() if varios else ''}</a>
  </p>
"""

    msg.add_alternative(
        f"""\
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#1b1730;">
  <p><b>{nome}</b> avisou que pagou o Pix do pedido
     <code>{primeiro['id']}</code>{
         f", que junta {len(orders)} pedidos (padrão e foil)" if varios else ""}.</p>
  <p style="color:#8a6d00;">É só o aviso do cliente — confere no app do banco
     antes de imprimir.</p>
  <p style="font-size:14px;">Nome: <b>{nome}</b> · Valor cobrado: <b>R$ {total:.2f}</b></p>
{"".join(bloco_html(o, u) for o, u in zip(orders, print_urls))}
  <p style="font-size:12px;color:#666;line-height:1.6;">
    A folha já está sendo montada no worker: confira no painel dele, na rede
    de casa, antes de gastar papel.<br>
    <b>Imprimir</b> confirma o pagamento e põe o pedido na fila da impressora.
  </p>
</body></html>
""",
        subtype="html",
    )
    _send(msg)
