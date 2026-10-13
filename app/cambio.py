"""
Câmbio dólar→real. Dois usos, e a diferença entre eles importa.

1. COMPARAR as duas colunas da cotação: a tela marca com ▲ a carta que está
   bem mais cara aqui do que lá fora.
2. LER em real o `preco_usd` da base local, que é dólar porque a base é o
   bulk da Scryfall (ver `cartas.py`) e quem monta deck aqui pensa em real.

Os dois são de APRESENTAÇÃO, e é isso que permite a taxa errar um pouco sem
estragar nada. Nenhum valor cobrado passa por aqui: a impressão é em real
desde sempre (`calc.py`), e o total de comprar tem fonte brasileira própria
(`ligamagic.py`) que já devolve real de verdade. O que esta taxa muda é a
RÉGUA com que um preço de referência é lido, nunca o preço.

Por isso ele NUNCA levanta exceção: quando a rede falha, cai numa taxa fixa
e a tela segue, só um pouco menos precisa — e escreve na própria tela qual
das duas aplicou, que é o que separa aproximação honesta de número inventado.

Isso é diferente do `USD_BRL` do `scryfall.py`, que é opcional, fixo no .env
e converte os preços da COTAÇÃO ao vivo. Aqui a taxa é sempre necessária
(a tela precisa de alguma), então tem valor padrão e busca automática. Os
dois nunca se aplicam ao mesmo número: converter duas vezes é o erro que
esta separação existe pra impedir.

DE ONDE VEM. Duas fontes públicas, sem cadastro nem chave, uma depois da
outra: a AwesomeAPI (`CAMBIO_URL`) e, se ela falhar, a Frankfurter
(`CAMBIO_URL_RESERVA`, as taxas do Banco Central Europeu). A reserva existe
por causa da Vercel: a AwesomeAPI limita por IP, e o IP de saída da Vercel é
dividido com muita gente — chegou lá já com a cota estourada (429).

O VALOR É GUARDADO NO BANCO de cartas, além da memória. Na Vercel cada
processo nasce sem memória nenhuma; só em memória, cada processo novo
perguntaria de novo, e é assim que se estoura cota. No banco, é uma busca a
cada `CAMBIO_TTL` pra todo mundo. Quando as duas fontes falham, vale o
último valor de verdade guardado (melhor que a taxa fixa), e a próxima
tentativa só acontece depois de `CAMBIO_TTL_FALHA` — sem martelar quem já
disse não.
"""
import json
import os
import sqlite3
import threading
import time

import requests

from . import db, identidade, log

# Taxa usada quando a busca está desligada ou falha. Fixa de propósito: é
# melhor um indicador com dólar a R$ 5 do que indicador nenhum.
FIXA = float(os.environ.get("CAMBIO_USD_BRL", "5"))
BUSCAR = os.environ.get("CAMBIO_BUSCAR", "1") == "1"
URL = os.environ.get(
    "CAMBIO_URL", "https://economia.awesomeapi.com.br/json/last/USD-BRL")
URL_RESERVA = os.environ.get(
    "CAMBIO_URL_RESERVA", "https://api.frankfurter.dev/v1/latest?from=USD&to=BRL")
TTL = float(os.environ.get("CAMBIO_TTL", str(6 * 3600)))
# Quanto esperar pra tentar de novo depois de as duas fontes falharem.
TTL_FALHA = float(os.environ.get("CAMBIO_TTL_FALHA", str(30 * 60)))
DB_PATH = os.environ.get("CARTAS_DB_PATH", "/app/data/cartas.db")
# Curto de propósito: se o câmbio demorar, o certo é desistir e usar a taxa
# fixa, não segurar a cotação por causa de um enfeite.
TIMEOUT = float(os.environ.get("CAMBIO_TIMEOUT", "4"))
# Fora desta faixa a resposta não é câmbio de dólar — é campo trocado, HTML
# de erro que virou número, ou a API mudando de formato. Melhor a taxa fixa.
MIN, MAX = 1.0, 50.0

_trava = threading.Lock()
_cache: dict | None = None   # {"valor", "fonte", "quando"}


def _ler_awesomeapi(dados) -> float:
    # {"USDBRL": {"bid": "5.43", ...}} — pega o primeiro par que vier, em vez
    # de fixar a chave "USDBRL", porque quem troca a URL no .env pode estar
    # pedindo outro par.
    par = next(iter(dados.values())) if isinstance(dados, dict) else None
    return float((par or {}).get("bid"))


def _ler_frankfurter(dados) -> float:
    # {"amount": 1.0, "base": "USD", "rates": {"BRL": 5.43}}
    taxas = (dados or {}).get("rates") or {}
    return float(next(iter(taxas.values())))


FONTES = (("awesomeapi", lambda: URL, _ler_awesomeapi),
          ("frankfurter", lambda: URL_RESERVA, _ler_frankfurter))


def _buscar_em(nome: str, url: str, ler) -> float | None:
    """A cotação do dólar numa fonte, ou None se não deu. Nunca levanta."""
    if not url:
        return None
    try:
        r = requests.get(
            url, timeout=TIMEOUT,
            headers={"User-Agent": identidade.user_agent("câmbio"),
                     "Accept": "application/json"})
        r.raise_for_status()
        valor = ler(r.json())
    except Exception as e:
        log.aviso("cambio", "busca-falhou", fonte=nome,
                  motivo=f"{type(e).__name__}: {e}"[:200])
        return None
    if not (MIN <= valor <= MAX):
        log.aviso("cambio", "valor-estranho", fonte=nome, valor=valor,
                  nota=f"fora de {MIN}–{MAX}")
        return None
    return valor


def _buscar() -> tuple[float, str] | None:
    """`(valor, fonte)` da primeira fonte que responder, ou None."""
    for nome, url, ler in FONTES:
        valor = _buscar_em(nome, url(), ler)
        if valor:
            return valor, nome
    return None


# ---------------------------------------------------------------------------
# O valor guardado no banco de cartas (o descartável): uma linha só.
# ---------------------------------------------------------------------------

def _conn():
    return db.cartas(DB_PATH)


def _ler_banco() -> dict | None:
    """`{"atual": {...}, "ultimo_real": {...}}` como ficou no banco, ou None."""
    try:
        conn = _conn()
        try:
            linha = conn.execute(
                "SELECT valor FROM cambio_guardado WHERE id=1").fetchone()
        finally:
            conn.close()
        return json.loads(linha[0]) if linha else None
    except (sqlite3.Error, OSError, ValueError, TypeError):
        return None


def _gravar_banco(estado: dict) -> None:
    try:
        conn = _conn()
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS cambio_guardado "
                         "(id INTEGER PRIMARY KEY, valor TEXT)")
            conn.execute("INSERT INTO cambio_guardado (id, valor) VALUES (1, ?) "
                         "ON CONFLICT(id) DO UPDATE SET valor=excluded.valor",
                         (json.dumps(estado),))
            conn.commit()
        finally:
            conn.close()
    except (sqlite3.Error, OSError) as e:
        log.aviso("cambio", "nao-guardou", motivo=str(e))


def taxa() -> dict:
    """Quantos reais vale um dólar, com de onde veio.

    Devolve `{"valor", "fonte", "quando"}` — `fonte` é "awesomeapi",
    "frankfurter" ou "fixa", e a tela usa isso pra escrever qual câmbio ela
    aplicou. Sempre devolve alguma coisa utilizável, e `valor` é sempre maior
    que zero: quem converte pode multiplicar sem checar, mas não pode omitir
    de onde veio.

    Ordem: memória do processo, banco, rede. Ver o topo do módulo.
    """
    global _cache
    with _trava:
        agora = time.time()
        if _cache and agora < _cache["vale_ate"]:
            return _publico(_cache)
        if not BUSCAR:
            _cache = {"valor": FIXA, "fonte": "fixa", "quando": agora,
                      "vale_ate": agora + TTL}
            return _publico(_cache)

        guardado = _ler_banco() or {}
        atual = guardado.get("atual")
        if atual and agora < atual.get("vale_ate", 0):
            _cache = atual
            return _publico(_cache)

        achado = _buscar()
        if achado:
            valor, fonte = achado
            _cache = {"valor": valor, "fonte": fonte, "quando": agora,
                      "vale_ate": agora + TTL}
            ultimo_real = _cache
            log.evento("cambio", "cotado", valor=round(valor, 4), fonte=fonte)
        else:
            # As duas falharam: o último valor de verdade vale mais que a
            # taxa fixa. Tenta de novo só depois de TTL_FALHA.
            ultimo_real = guardado.get("ultimo_real")
            base = ultimo_real or {"valor": FIXA, "fonte": "fixa",
                                   "quando": agora}
            _cache = {**base, "vale_ate": agora + TTL_FALHA}
            log.aviso("cambio", "sem-fonte", usando=base["fonte"],
                      valor=round(base["valor"], 4))
        _gravar_banco({"atual": _cache, "ultimo_real": ultimo_real})
        return _publico(_cache)


def _publico(estado: dict) -> dict:
    return {"valor": estado["valor"], "fonte": estado["fonte"],
            "quando": estado["quando"]}
