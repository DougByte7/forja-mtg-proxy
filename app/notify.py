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


LAM_LABELS = {"single": "Um lado", "double": "Dois lados"}


def send_payment_claim_email(order: dict, pdf_url: str, print_url: str,
                             pdf_fresh_url: str):
    """
    O cliente clicou em "Pagamento realizado, enviar notificação".

    Isso é só um AVISO — nada foi verificado com o banco. O e-mail traz o
    resumo do pedido, um link "Ver PDF" pra conferir a folha antes de gastar
    papel e um link "Imprimir" que só deve ser clicado depois de conferir no
    app do banco que o Pix caiu mesmo. É o clique em Imprimir que marca o
    pedido como pago e manda pra impressora.

    O PDF vai como link, não como anexo: pedido grande passa fácil do limite
    de 25 MB do Gmail.
    """
    lam = LAM_LABELS.get(order["lamination"], order["lamination"])

    msg = EmailMessage()
    msg["Subject"] = (
        f"Pix avisado — {order['customer_name']} "
        f"| R$ {order['amount']:.2f} | pedido {order['id']}"
    )
    msg["From"] = SMTP_USER or "forja@localhost"
    msg["To"] = NOTIFY_TO or ""

    msg.set_content(
        f"{order['customer_name']} avisou que pagou o Pix do pedido {order['id']}.\n"
        f"(é só o aviso do cliente — confere no app do banco antes de imprimir)\n\n"
        f"Nome: {order['customer_name']}\n"
        f"Código do deck: {order['deck_hash']}\n"
        f"Cartas: {order['qty']}\n"
        f"Páginas: {order['pages']}\n"
        f"Espaços em branco na última página: {order['blanks']}\n"
        f"Laminação: {lam}\n"
        f"Valor cobrado: R$ {order['amount']:.2f}\n\n"
        f"1) Confere a folha antes de gastar papel:\n{pdf_url}\n\n"
        f"2) Se o Pix caiu e o PDF está certo, imprime:\n{print_url}\n\n"
        f"Só abrir o PDF não marca nada como pago. Quem faz isso — e manda pra "
        f"fila da impressora — é o link 2.\n\n"
        f"Alguma carta saiu como \"FALHA NO DOWNLOAD\"? Gera o PDF de novo:\n"
        f"{pdf_fresh_url}"
    )

    msg.add_alternative(
        f"""\
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#1b1730;">
  <p><b>{order['customer_name']}</b> avisou que pagou o Pix do pedido
     <code>{order['id']}</code>.</p>
  <p style="color:#8a6d00;">É só o aviso do cliente — confere no app do banco
     antes de imprimir.</p>
  <table cellpadding="6" style="border-collapse:collapse;font-size:14px;">
    <tr><td>Nome</td><td><b>{order['customer_name']}</b></td></tr>
    <tr><td>Código do deck</td><td><code>{order['deck_hash']}</code></td></tr>
    <tr><td>Cartas</td><td><b>{order['qty']}</b></td></tr>
    <tr><td>Páginas</td><td><b>{order['pages']}</b></td></tr>
    <tr><td>Em branco na última pág.</td><td><b>{order['blanks']}</b></td></tr>
    <tr><td>Laminação</td><td><b>{lam}</b></td></tr>
    <tr><td>Valor cobrado</td><td><b>R$ {order['amount']:.2f}</b></td></tr>
  </table>
  <p style="margin:24px 0;">
    <a href="{pdf_url}"
       style="background:#ffffff;color:#1b1730;text-decoration:none;
              border:2px solid #1b1730;padding:12px 22px;border-radius:8px;
              font-weight:bold;display:inline-block;margin:0 8px 10px 0;">Ver PDF</a>
    <a href="{print_url}"
       style="background:#C9A227;color:#1A1408;text-decoration:none;
              padding:14px 24px;border:2px solid #C9A227;border-radius:8px;
              font-weight:bold;display:inline-block;margin:0 0 10px 0;">Imprimir</a>
  </p>
  <p style="font-size:12px;color:#666;line-height:1.6;">
    <b>Ver PDF</b> abre a folha pra você conferir antes de gastar papel — não
    marca nada como pago.<br>
    <b>Imprimir</b> marca o pedido como pago e manda pra fila da impressora.<br>
    Alguma carta saiu como "FALHA NO DOWNLOAD"?
    <a href="{pdf_fresh_url}" style="color:#666;">Gerar o PDF de novo.</a>
  </p>
</body></html>
""",
        subtype="html",
    )
    _send(msg)
