"""
Cliente mínimo do Vercel Blob: o que a arte enviada precisa, e nada além.

Não existe SDK oficial em Python. O que está aqui é o protocolo que o
`@vercel/blob` (2.8, `packages/blob` do repositório `vercel/storage`) usa, lido
do código dele — se o upload parar de funcionar depois de uma mudança na
Vercel, é lá que se confere:

* **Upload**: `PUT {API}/?pathname=<caminho>` com `authorization: Bearer
  <token>`, `x-api-version` e os `x-*` de opção. Responde JSON com `url`.
* **Token do navegador** (`token_cliente`): o arquivo da pessoa vai DIRETO do
  navegador pro Blob, porque uma função da Vercel aceita no máximo 4,5 MB de
  corpo e a arte do MPC passa disso. O site não entrega o token de leitura e
  escrita: assina um token curto, preso a UM caminho, a um tamanho máximo e
  aos tipos de imagem. Formato: `vercel_blob_client_<loja>_` + base64 de
  `<hmac-sha256 hex>.<payload base64>`, com o token de escrita como chave.
* **Apagar**: `POST {API}/delete` com `{"urls": [...]}`.

O token de leitura e escrita é o `BLOB_READ_WRITE_TOKEN` que a Vercel põe no
ambiente quando a loja é ligada ao projeto (`vercel_blob_rw_<loja>_<segredo>`).
"""
import base64
import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlencode, urlsplit

import requests

API = os.environ.get("VERCEL_BLOB_API_URL", "https://vercel.com/api/blob").rstrip("/")
API_VERSION = "12"
TIMEOUT = float(os.environ.get("BLOB_TIMEOUT", "60"))


class BlobError(RuntimeError):
    """O Blob recusou ou não respondeu."""


def token() -> str:
    return os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()


def ligado() -> bool:
    return bool(token())


def loja(tok: str | None = None) -> str:
    """O id da loja, que vem dentro do token (`vercel_blob_rw_<loja>_...`)."""
    partes = (tok or token()).split("_")
    if len(partes) < 5 or not partes[3]:
        raise BlobError("BLOB_READ_WRITE_TOKEN em formato inesperado.")
    return partes[3]


def host_publico(tok: str | None = None) -> str:
    return f"{loja(tok)}.public.blob.vercel-storage.com".lower()


def da_loja(url: str, prefixo: str = "") -> bool:
    """Se `url` é um arquivo PÚBLICO desta loja (e, com `prefixo`, debaixo
    dele). É a porta contra quem mandar o endereço de outra coisa pro site
    baixar."""
    try:
        partes = urlsplit(url)
    except ValueError:
        return False
    return (partes.scheme == "https"
            and (partes.hostname or "").lower() == host_publico()
            and partes.path.lstrip("/").startswith(prefixo))


def token_cliente(pathname: str, *, maximo_bytes: int, tipos: list[str],
                  validade_segundos: int = 300) -> str:
    """Um token que só serve pra subir UM arquivo em `pathname`, até
    `maximo_bytes`, de um dos `tipos`, por `validade_segundos`."""
    tok = token()
    payload = base64.b64encode(json.dumps({
        "pathname": pathname,
        "maximumSizeInBytes": maximo_bytes,
        "allowedContentTypes": tipos,
        "addRandomSuffix": False,
        "allowOverwrite": False,
        "validUntil": int((time.time() + validade_segundos) * 1000),
    }, separators=(",", ":")).encode()).decode()
    assinatura = hmac.new(tok.encode(), payload.encode(), hashlib.sha256).hexdigest()
    corpo = base64.b64encode(f"{assinatura}.{payload}".encode()).decode()
    return f"vercel_blob_client_{loja(tok)}_{corpo}"


def _cabecalhos(tok: str) -> dict:
    return {"authorization": f"Bearer {tok}", "x-api-version": API_VERSION,
            "x-vercel-blob-store-id": loja(tok)}


def enviar(pathname: str, dados: bytes, content_type: str, *,
           sobrescrever: bool = False) -> dict:
    """Sobe `dados` em `pathname` com o token do servidor. Devolve o JSON do
    Blob (`url`, `pathname`, ...)."""
    tok = token()
    cab = {**_cabecalhos(tok), "x-vercel-blob-access": "public",
           "x-content-type": content_type, "x-add-random-suffix": "0",
           "x-allow-overwrite": "1" if sobrescrever else "0",
           "x-content-length": str(len(dados))}
    try:
        r = requests.put(f"{API}/?{urlencode({'pathname': pathname})}",
                         data=dados, headers=cab, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise BlobError(f"o Blob não respondeu: {e}") from e
    if r.status_code >= 400:
        raise BlobError(f"o Blob recusou ({r.status_code}): {r.text[:200]}")
    return r.json()


def baixar(url: str, maximo_bytes: int) -> bytes:
    """Os bytes de um arquivo da loja, parando em `maximo_bytes` + 1 (quem
    chama decide o que fazer com o que passou do teto)."""
    try:
        with requests.get(url, stream=True, timeout=TIMEOUT) as r:
            r.raise_for_status()
            dados = bytearray()
            for pedaco in r.iter_content(256 * 1024):
                dados += pedaco
                if len(dados) > maximo_bytes:
                    break
            return bytes(dados)
    except requests.RequestException as e:
        raise BlobError(f"não consegui baixar do Blob: {e}") from e


def apagar(urls: list[str]) -> None:
    """Apaga, sem levantar: é faxina, e faxina que falha não pode derrubar o
    que vinha antes dela."""
    if not urls:
        return
    tok = token()
    try:
        requests.post(f"{API}/delete", json={"urls": urls},
                      headers=_cabecalhos(tok), timeout=TIMEOUT)
    except requests.RequestException:
        pass
