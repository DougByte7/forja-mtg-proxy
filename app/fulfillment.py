"""
Fluxo de pagamento manual, sem depender do banco avisar nada.

O banco não notifica ninguém em tempo real e ler a caixa de entrada era
frágil demais, então quem avisa é o próprio cliente:

1. O cliente gera a cobrança, paga o Pix e clica em "Pagamento realizado,
   enviar notificação" -> `POST /orders/{id}/notify-payment`. O pedido vai
   pra `notified`, e o worker da impressora já adianta a folha dele do lado
   de lá.
2. O operador recebe um e-mail com o resumo do pedido e o botão **Imprimir**
   (`GET /orders/{id}/print`), que põe o pedido na fila da impressora — quem
   imprime é o worker (`worker/`), não este processo.
3. O operador confere o Pix no app do banco, confere a folha no painel do
   worker (rede de casa), e só então clica em Imprimir.

O site não monta nem guarda PDF: a folha mora no disco do worker, e o painel
dele é o único lugar onde ela é vista antes de ir pro papel.

O clique do cliente NÃO imprime nada nem marca como pago — é só um aviso. A
decisão continua sendo humana, o que também resolve o problema de alguém
clicar no botão sem ter pago.

O link Imprimir é assinado com HMAC da `ADMIN_TOKEN`, então ele é auto
contido (não precisa guardar nada no banco) e não dá pra adivinhar o link de
um pedido só sabendo o id dele. O propósito (`print`) entra na assinatura:
trocar o propósito de um token assinado não dá outro token válido.
"""
import hashlib
import hmac
import os

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
# URL pública do site, usada pra montar o link do e-mail.
# Ex: https://forja.exemplo.com  (sem barra no fim)
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")


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


def print_url(order_id: str) -> str:
    return f"{PUBLIC_BASE_URL}/orders/{order_id}/print?token={_token('print', order_id)}"
