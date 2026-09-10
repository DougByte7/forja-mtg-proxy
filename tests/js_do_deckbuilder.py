"""
O JavaScript do deckbuilder, lido do jeito que o navegador o carrega.

A página não carrega o JS embutido: ela lista, em tags `<script src>`, os
arquivos de `app/static/deckbuilder/`, e a ordem das tags é a ordem de carga.
Os testes que rodam esse JS no Duktape (`test_deckbuilder`, `test_goldfish`,
`test_precos_brl`) pegam a lista daqui, e daqui ela sai do HTML — assim ela
existe num lugar só, e um arquivo novo na página entra nos testes sozinho.
"""
import re
from pathlib import Path

ESTATICO = Path(__file__).resolve().parents[1] / "app" / "static"
PAGINA = ESTATICO / "deckbuilder.html"


def arquivos():
    """Os scripts da página, na ordem em que o navegador os carrega."""
    html = PAGINA.read_text(encoding="utf-8")
    return [ESTATICO / src for src in
            re.findall(r'<script src="/(deckbuilder/[^"?]+)"></script>', html)]


def sem_abrir(js):
    """O JS sem a chamada final a `abrir()`: é a única linha que vai à rede e
    mexe em elementos de verdade. Todo o resto é declaração."""
    return js.rsplit("abrir();", 1)[0]


def js_da_pagina():
    """Os scripts emendados na ordem de carga, sem o `abrir();` do fim.

    Emendados, eles rodam como um script só, e isso esconde um tipo de erro:
    a função que um arquivo chama na carga, mas que só um arquivo POSTERIOR
    declara. Quem pega esse erro é a checagem "a página, arquivo por arquivo"
    do `test_deckbuilder.py`, que carrega um de cada vez."""
    return sem_abrir("\n".join(p.read_text(encoding="utf-8")
                               for p in arquivos()))
