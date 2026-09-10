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

A busca é na AwesomeAPI: endpoint público, sem cadastro nem chave, uma
requisição a cada `CAMBIO_TTL` (o valor fica em memória entre as cotações).
Uma cotação de deck já leva minutos batendo em duas fontes; uma requisição
de câmbio a cada seis horas não muda nada no ritmo.
"""
import os
import threading
import time

import requests

from . import identidade, log

# Taxa usada quando a busca está desligada ou falha. Fixa de propósito: é
# melhor um indicador com dólar a R$ 5 do que indicador nenhum.
FIXA = float(os.environ.get("CAMBIO_USD_BRL", "5"))
BUSCAR = os.environ.get("CAMBIO_BUSCAR", "1") == "1"
URL = os.environ.get(
    "CAMBIO_URL", "https://economia.awesomeapi.com.br/json/last/USD-BRL")
TTL = float(os.environ.get("CAMBIO_TTL", str(6 * 3600)))
# Curto de propósito: se o câmbio demorar, o certo é desistir e usar a taxa
# fixa, não segurar a cotação por causa de um enfeite.
TIMEOUT = float(os.environ.get("CAMBIO_TIMEOUT", "4"))
# Fora desta faixa a resposta não é câmbio de dólar — é campo trocado, HTML
# de erro que virou número, ou a API mudando de formato. Melhor a taxa fixa.
MIN, MAX = 1.0, 50.0

_trava = threading.Lock()
_cache: dict | None = None   # {"valor", "fonte", "quando"}


def _buscar() -> float | None:
    """A cotação de venda do dólar, ou None se não deu. Nunca levanta."""
    try:
        r = requests.get(
            URL, timeout=TIMEOUT,
            headers={"User-Agent": identidade.user_agent("câmbio"),
                     "Accept": "application/json"})
        r.raise_for_status()
        dados = r.json()
        # {"USDBRL": {"bid": "5.43", ...}} — pega o primeiro par que vier, em
        # vez de fixar a chave "USDBRL", porque quem troca a URL no .env pode
        # estar pedindo outro par.
        par = next(iter(dados.values())) if isinstance(dados, dict) else None
        valor = float((par or {}).get("bid"))
    except Exception as e:
        log.aviso("cambio", "busca-falhou", motivo=f"{type(e).__name__}: {e}",
                  nota=f"usando taxa fixa de R$ {FIXA:.2f}")
        return None
    if not (MIN <= valor <= MAX):
        log.aviso("cambio", "valor-estranho", valor=valor,
                  nota=f"fora de {MIN}–{MAX}; usando taxa fixa")
        return None
    return valor


def taxa() -> dict:
    """Quantos reais vale um dólar, com de onde veio.

    Devolve `{"valor", "fonte", "quando"}` — `fonte` é "awesomeapi" ou
    "fixa", e a tela usa isso pra escrever qual câmbio ela aplicou. Sempre
    devolve alguma coisa utilizável, e `valor` é sempre maior que zero: quem
    converte pode multiplicar sem checar, mas não pode omitir de onde veio.
    """
    global _cache
    with _trava:
        agora = time.time()
        if _cache and agora - _cache["quando"] < TTL:
            return dict(_cache)
        valor = _buscar() if BUSCAR else None
        _cache = {"valor": valor if valor else FIXA,
                  "fonte": "awesomeapi" if valor else "fixa",
                  "quando": agora}
        if valor:
            log.evento("cambio", "cotado", valor=round(valor, 4))
        return dict(_cache)
