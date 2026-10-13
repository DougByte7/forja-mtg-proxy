"""
As fontes de fora respondem a ESTE servidor? (`GET /admin/fontes`)

A pergunta existe por causa da mudança pra Vercel. No homelab o site saía
pela internet de casa, um IP residencial; na Vercel ele sai de um IP de
datacenter da AWS, e site protegido pela Cloudflare (LigaMagic, Moxfield)
costuma desconfiar disso — ou barrar de vez. Se uma fonte barrar, a cotação
ou a importação daquela fonte para de funcionar sem erro nenhum na cara.

Então: uma requisição a cada fonte, do jeito que o módulo dela faz (mesmo
User-Agent), e um veredito por fonte:

* `responde` — 2xx, 3xx ou 404 (o 404 é a fonte respondendo "não tem isso",
  que prova que chegamos nela);
* `bloqueado` — 403, 429 ou 503, ou o desafio da Cloudflare ("Just a
  moment…", `cf-mitigated`);
* `fora` — nem respondeu (timeout, DNS, conexão recusada).

É uma requisição por fonte, só quando alguém do admin pede: não é monitor.
"""
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from . import (cambio, edhrec, identidade, importar, ligamagic, mpcfill,
               scryfall, spellbook)

TIMEOUT = 15


def _fontes() -> list[dict]:
    # O mesmo User-Agent honesto que a importação usa — ver o topo do
    # `importar.py` sobre por que não é um de navegador.
    importacao_ua = identidade.user_agent("importação de deck")
    return [
        {"id": "ligamagic", "uso": "cotação (preço no Brasil)",
         "url": ligamagic.url_da_carta("Sol Ring"), "ua": ligamagic.USER_AGENT},
        {"id": "scryfall", "uso": "cotação (preço lá fora) e nomes",
         "url": f"{scryfall.BASE}/cards/named?exact=Sol%20Ring",
         "ua": scryfall.USER_AGENT},
        {"id": "edhrec", "uso": "sugestões de carta",
         "url": f"{edhrec.BASE}/commanders/atraxa-praetors-voice.json",
         "ua": edhrec.USER_AGENT},
        {"id": "spellbook", "uso": "combos e nível de poder",
         "url": f"{spellbook.BASE}/variants/?limit=1", "ua": spellbook.USER_AGENT},
        {"id": "mpcfill", "uso": "escolher arte", "url": f"{mpcfill.BASE}/",
         "ua": mpcfill.USER_AGENT},
        {"id": "archidekt", "uso": "importar deck", "url": f"{importar.ARCHIDEKT_API}/",
         "ua": importacao_ua},
        {"id": "moxfield", "uso": "importar deck",
         "url": f"{importar.MOXFIELD_API}/decks/all/forja-diagnostico",
         "ua": importar.MOXFIELD_USER_AGENT or importacao_ua},
        {"id": "cambio", "uso": "dólar do dia na cotação", "url": cambio.URL, "ua": ""},
    ]


def _veredito(r: requests.Response) -> tuple[str, str]:
    corpo = r.text[:4000] if "text" in r.headers.get("content-type", "") else ""
    desafio = (r.headers.get("cf-mitigated") == "challenge"
               or "Just a moment" in corpo or "cf-chl" in corpo)
    if desafio:
        return "bloqueado", "desafio da Cloudflare"
    if r.status_code in (403, 429, 503):
        return "bloqueado", f"HTTP {r.status_code}"
    if r.status_code < 400 or r.status_code == 404:
        return "responde", f"HTTP {r.status_code}"
    return "erro", f"HTTP {r.status_code}"


def _testar(fonte: dict) -> dict:
    inicio = time.monotonic()
    cabecalhos = {"User-Agent": fonte["ua"]} if fonte["ua"] else {}
    try:
        r = requests.get(fonte["url"], headers=cabecalhos, timeout=TIMEOUT,
                         allow_redirects=True)
        situacao, detalhe = _veredito(r)
    except requests.RequestException as e:
        situacao, detalhe = "fora", f"{type(e).__name__}: {e}"[:200]
    return {"fonte": fonte["id"], "uso": fonte["uso"], "situacao": situacao,
            "detalhe": detalhe, "ms": int((time.monotonic() - inicio) * 1000),
            "url": fonte["url"]}


def testar_fontes() -> dict:
    fontes = _fontes()
    with ThreadPoolExecutor(max_workers=len(fontes)) as pool:
        resultados = list(pool.map(_testar, fontes))
    return {"todas_respondem": all(r["situacao"] == "responde" for r in resultados),
            "fontes": resultados}
