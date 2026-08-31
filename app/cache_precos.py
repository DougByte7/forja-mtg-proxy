"""
Cache em disco das ofertas de UMA carta, compartilhado pelas fontes de preço.

Por carta, e não por deck, de propósito. O cache por deck que existia antes
só servia se a lista fosse idêntica: trocar UMA carta jogava fora o trabalho
das outras 98, e dois decks parecidos não aproveitavam nada um do outro.
Guardando por carta, quem cota um Commander e depois troca duas cartas paga
só as duas — e a segunda pessoa que cotar um deck com Sol Ring já acha o
Sol Ring pronto.

Isso importa mais aqui do que em cache normal: cada carta nova custa uma
requisição à LigaMagic, num site que pede pra gente não fazer isso (veja
`ligamagic.py`). Cada acerto de cache é um acesso a menos.
"""
import json
import os
import re
import time

from .cotacao import Oferta

DIR = os.environ.get("COTACAO_CACHE_DIR", "/tmp/forja-cotacao-cache")
TTL = float(os.environ.get("COTACAO_CACHE_TTL", str(12 * 3600)))


def _caminho(fonte: str, nome: str) -> str:
    limpo = re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-") or "sem-nome"
    # Nome de carta pode ser longo (Secret Lair costuma passar de 100 letras)
    # e o sistema de arquivos corta em 255 bytes — daí o corte com folga.
    return os.path.join(DIR, fonte, limpo[:120] + ".json")


def ler(fonte: str, nome: str) -> list[Oferta] | None:
    """As ofertas guardadas, ou None se não tem ou já venceu."""
    caminho = _caminho(fonte, nome)
    try:
        if time.time() - os.path.getmtime(caminho) > TTL:
            return None
        with open(caminho, encoding="utf-8") as f:
            return [Oferta(**o) for o in json.load(f)]
    except (OSError, ValueError, TypeError):
        # Arquivo corrompido, ou gravado por uma versão antiga do formato:
        # trata como se não existisse. Cache nunca pode derrubar a cotação.
        return None


def gravar(fonte: str, nome: str, ofertas: list[Oferta]):
    caminho = _caminho(fonte, nome)
    try:
        os.makedirs(os.path.dirname(caminho), exist_ok=True)
        with open(caminho, "w", encoding="utf-8") as f:
            json.dump([o.__dict__ for o in ofertas], f, ensure_ascii=False)
    except OSError as e:
        print(f"[cache_precos] não gravei {fonte}/{nome!r}: {e}")
