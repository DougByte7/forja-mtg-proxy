"""
As telas feitas em Preact (`front/`), como o FastAPI as serve.

O `vite build` gera `app/static/dist/`: um HTML por tela em `pages/` e os
assets com hash no nome em `assets/`. O HTML sai daqui, pela rota da tela e
com `no-cache` — o navegador confere a página a cada visita, e ela aponta pro
nome exato de cada asset. Os assets vão pelo mount estático do `main.py` (o
CDN, na Vercel) e podem ficar no cache à vontade: conteúdo novo é nome novo.

Sem o build, a rota responde 503 com o comando que falta, em vez de um 500
com traceback: é o que acontece num clone novo antes do `pnpm build`.
"""
from pathlib import Path

from fastapi.responses import HTMLResponse, PlainTextResponse

DIST = Path(__file__).resolve().parent / "static" / "dist"


def page(name: str):
    """O HTML da tela `name` (o nome do entry no `front/vite.config.ts`)."""
    path = DIST / "pages" / f"{name}.html"
    try:
        html = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return PlainTextResponse(
            f"A tela '{name}' não foi gerada. Rode o build do front:\n\n"
            "    cd front && pnpm install && pnpm build\n", status_code=503)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
