"""
Gera o payload "Pix Copia e Cola" (BR Code / EMV QR) e o QR code em PNG a
partir da chave Pix configurada — sem passar por nenhum provedor de pagamento.

IMPORTANTE: como isso não usa API de nenhum banco/PSP, não existe forma
automática de saber "foi pago". Neste projeto quem avisa é o próprio cliente
(botão "Pagamento realizado, enviar notificação" -> e-mail com o link
"Imprimir", ver fulfillment.py) e a confirmação continua sendo manual, no app
do banco. O BR Code é montado à mão aqui (TLV + CRC16), sem nenhuma validação
de terceiro no caminho, então mudança nesta parte pede teste num leitor de
Pix Copia e Cola antes de ir pro ar.
"""
import base64
import io

import qrcode


def _crc16_ccitt(data: str) -> str:
    """CRC16-CCITT (poly 0x1021, init 0xFFFF) — exigido no fim do payload Pix."""
    crc = 0xFFFF
    for byte in data.encode("utf-8"):
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return format(crc, "04X")


def _tlv(id_: str, value: str) -> str:
    return f"{id_}{len(value):02d}{value}"


def build_payload(pix_key: str, merchant_name: str, merchant_city: str,
                   amount: float, txid: str) -> str:
    """
    Monta o BR Code (string que vira o QR / "copia e cola").
    - pix_key: chave Pix do recebedor (CPF, e-mail, telefone ou chave aleatória)
    - merchant_name: até 25 caracteres, sem acento é mais seguro
    - merchant_city: até 15 caracteres, maiúsculo, sem acento
    - amount: valor fixo da cobrança (com os centavos identificadores)
    - txid: identificador do pedido, até 25 caracteres alfanuméricos
    """
    merchant_account = _tlv("00", "br.gov.bcb.pix") + _tlv("01", pix_key)

    payload = ""
    payload += _tlv("00", "01")              # Payload Format Indicator
    payload += _tlv("01", "12")               # QR dinâmico de uso único
    payload += _tlv("26", merchant_account)   # Dados da conta Pix
    payload += _tlv("52", "0000")             # Merchant Category Code
    payload += _tlv("53", "986")              # Moeda: BRL
    payload += _tlv("54", f"{amount:.2f}")    # Valor
    payload += _tlv("58", "BR")               # País
    payload += _tlv("59", merchant_name[:25])
    payload += _tlv("60", merchant_city[:15])
    payload += _tlv("62", _tlv("05", (txid or "***")[:25]))  # txid/referência
    payload += "6304"                         # CRC id+tamanho fixos

    payload += _crc16_ccitt(payload)
    return payload


def build_qr_base64(payload: str) -> str:
    """Retorna o QR code como PNG em base64, pronto pra <img src='data:...'>."""
    img = qrcode.make(payload)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()
