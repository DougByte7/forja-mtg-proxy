"""
Como o PDF montado volta pro navegador: com Range e revalidação.

Veio do site quando a montagem da folha saiu de lá pro worker — quem serve o
arquivo agora é o painel da rede local (`painel.py`). O motivo de existir
continua o mesmo: o arquivo é grande (dezenas a centenas de MB), e um
visualizador de PDF sem Range baixa tudo antes de desenhar a primeira página.

`tests/test_pdf_range.py` trava este comportamento.
"""
import os
import re

from fastapi import Request
from fastapi.responses import FileResponse, Response, StreamingResponse

# Quanto o navegador pode reaproveitar o PDF já baixado. Aqui era `no-store`,
# e isso fazia cada reabertura pagar o arquivo inteiro de novo — num pedido
# grande, centenas de MB subindo pelo link de casa só pra mostrar a mesma
# folha. Com revalidação ele pergunta antes e recebe 304 (uns poucos bytes)
# enquanto nada mudou. Não dá pra guardar por tempo fixo porque o "Refazer
# PDF" troca o arquivo debaixo da mesma URL; o ETag sai do mtime + tamanho,
# então uma remontagem invalida o cache sozinha.
PDF_CACHE_CONTROL = "private, max-age=0, must-revalidate"

_FAIXA_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
# `faixa_pedida` devolve isto quando a faixa existe mas não cabe no arquivo:
# é 416, e não o arquivo inteiro.
FAIXA_INVALIDA = "faixa-invalida"


def faixa_pedida(header: str | None, tamanho: int):
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


class _ArquivoInteiro(FileResponse):
    """O `FileResponse` sem olhar o `Range` do pedido.

    Quem decide entre faixa e arquivo inteiro é o `servir_pdf`. Do Starlette
    0.39 em diante o `FileResponse` também lê o `Range`, e o que aqui ficou
    decidido como arquivo inteiro sairia como multipart (várias faixas) ou 400
    (unidade desconhecida, que o HTTP manda ignorar). Tirar o cabeçalho do
    escopo faz ele responder igual em qualquer versão, e o `sendfile` fica.
    """

    async def __call__(self, scope, receive, send):
        cabecalhos = [(k, v) for k, v in scope["headers"] if k.lower() != b"range"]
        await super().__call__({**scope, "headers": cabecalhos}, receive, send)


def servir_pdf(request: Request, path: str, nome: str,
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
        "Content-Disposition": f'inline; filename="{nome}.pdf"',
        "Cache-Control": PDF_CACHE_CONTROL,
        "ETag": etag,
        "Accept-Ranges": "bytes",
        "X-Imagens-Com-Falha": str(falhas),
    }

    faixa = faixa_pedida(request.headers.get("range"), st.st_size)

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

    return _ArquivoInteiro(path, media_type="application/pdf", stat_result=st,
                           headers=cabecalhos)
