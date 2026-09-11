"""
O JavaScript do deckbuilder, lido do jeito que o navegador o carrega.

A página carrega um módulo só — a entrada, na tag `<script type="module">` —
e dali o navegador segue os `import` por `app/static/deckbuilder/` e
`app/static/comum/`. Os testes que rodam esse JS no Duktape
(`test_deckbuilder`, `test_goldfish`, `test_precos_brl`) partem da mesma
entrada e seguem o mesmo grafo, e assim ele existe num lugar só: nos próprios
`import`.

O Duktape não conhece módulo. O que ele roda é o grafo achatado: os arquivos
na ordem em que o navegador os avalia, sem as linhas de `import` e sem a
palavra `export`. Achatar só é seguro porque os módulos seguem uma forma
estreita, que o `test_modulos.py` confere:

* import é sempre `import {a, b} from "./x.js";` — sem `as`, `default` ou
  `* as`, então cada nome importado é o mesmo nome que o outro arquivo declara;
* export é sempre a palavra `export` na frente de uma declaração de topo;
* nenhum nome de topo se repete entre arquivos, então achatados eles não
  colidem.
"""
import re
from pathlib import Path

ESTATICO = Path(__file__).resolve().parents[1] / "app" / "static"
PAGINA = ESTATICO / "deckbuilder.html"

IMPORT = re.compile(r'^import\s*\{[^}]*\}\s*from\s*"([^"]+)";[ \t]*\n', re.M)
EXPORT = re.compile(r"^export (?=(?:async )?function |const |let |class )",
                    re.M)


def entrada():
    """O módulo que a página carrega."""
    html = PAGINA.read_text(encoding="utf-8")
    return (ESTATICO / re.search(
        r'<script type="module" src="/([^"?]+)"></script>', html)[1]).resolve()


def dependencias(caminho):
    """Os módulos que `caminho` importa, na ordem dos `import`."""
    texto = caminho.read_text(encoding="utf-8")
    deps = [(caminho.parent / d).resolve() for d in IMPORT.findall(texto)]
    for d in deps:
        if not d.exists():
            raise FileNotFoundError(f"{caminho.name} importa {d}, que não existe")
    return deps


def arquivos():
    """Os módulos do grafo, na ordem em que o navegador os avalia: cada um
    depois dos que ele importa — a ordem de saída de uma busca em
    profundidade a partir da entrada, que é a da especificação."""
    vistos, ordem = set(), []

    def visita(caminho):
        if caminho in vistos:
            return
        vistos.add(caminho)
        for d in dependencias(caminho):
            visita(d)
        ordem.append(caminho)

    visita(entrada())
    return ordem


def sem_modulo(texto):
    """Um módulo como script comum: sem os `import` e sem a palavra `export`."""
    return EXPORT.sub("", IMPORT.sub("", texto))


def sem_abrir(js):
    """O JS sem a chamada final a `abrir()`: é a única linha que vai à rede e
    mexe em elementos de verdade. Todo o resto é declaração."""
    return js.rsplit("abrir();", 1)[0]


def js_da_pagina():
    """O grafo achatado num script só, sem o `abrir();` do fim, e em modo
    estrito, que é o modo de todo módulo.

    Achatado, ele roda como um script só, e isso esconde um tipo de erro: o
    módulo que usa na carga um nome de outro que o navegador ainda não
    avaliou. Quem pega esse erro é a checagem "a página, módulo por módulo"
    do `test_deckbuilder.py`, que avalia um de cada vez."""
    return sem_abrir('"use strict";\n' + "\n".join(
        sem_modulo(p.read_text(encoding="utf-8")) for p in arquivos()))
