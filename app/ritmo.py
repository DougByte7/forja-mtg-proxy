"""
Controle de ritmo compartilhado entre as threads que batem numa mesma fonte.

Antes cada fonte tinha seu `_respeitar_ritmo()` — uma trava e um "último
acesso" — que garantia o intervalo mínimo entre requisições. Isso resolve o
caso normal e NÃO resolve o caso que quebrou a cotação de 75 cartas: quando
a fonte começa a responder 429, cada worker descobre isso sozinho, espera
seu backoff sozinho e desiste sozinho. Com 4 workers e 3 tentativas curtas,
os quatro queimam todas as tentativas dentro de poucos segundos — e um bloco
inteiro de cartas volta sem preço enquanto a fonte só queria que a gente
desacelerasse.

`Freio` conserta isso guardando, além do intervalo, uma PAUSA GLOBAL: quando
uma thread leva 429, ela chama `recuar()` e todas as outras param junto. É a
diferença entre o site pedir "mais devagar" e a gente responder "mais
devagar" em vez de "mais quatro vezes agora".

O `sleep` acontece FORA da trava de propósito. Segurando a trava, uma pausa
de 30 s impediria as outras threads até de registrar que também levaram 429.
Como o laço reconfere a condição com a trava na mão antes de liberar, duas
threads acordando juntas não passam as duas.
"""
import random
import threading
import time

from . import log


class Freio:
    """Intervalo mínimo entre requisições + pausa global após 429."""

    def __init__(self, canal: str, delay_segundos: float):
        self.canal = canal
        self.delay = delay_segundos
        self._trava = threading.Lock()
        self._ultimo = 0.0
        self._pausa_ate = 0.0

    def esperar(self) -> float:
        """Segura a thread até poder fazer a próxima requisição.

        Devolve quantos segundos esperou — quem chama usa isso pra logar
        quando a espera saiu do normal.
        """
        inicio = time.monotonic()
        while True:
            with self._trava:
                agora = time.monotonic()
                falta = max(self._pausa_ate - agora,
                            self._ultimo + self.delay - agora)
                if falta <= 0:
                    self._ultimo = agora
                    return agora - inicio
            # Teto de 1 s por volta pra reconferir a pausa: ela pode ter sido
            # estendida por outra thread enquanto esta dormia.
            time.sleep(min(falta, 1.0))

    def recuar(self, segundos: float, motivo: str = "", carta: str = "") -> bool:
        """Faz TODAS as threads desta fonte pararem por `segundos`.

        Devolve True se esta chamada de fato esticou a pausa. Serve pra logar
        uma vez só: quatro workers levando 429 no mesmo instante são um
        evento, não quatro.
        """
        with self._trava:
            alvo = time.monotonic() + segundos
            if alvo <= self._pausa_ate:
                return False
            restante = max(0.0, self._pausa_ate - time.monotonic())
            self._pausa_ate = alvo
        log.aviso(self.canal, "freio", segundos=round(segundos, 1),
                  motivo=motivo or None, carta=carta or None,
                  ja_pausado=round(restante, 1) if restante else None)
        return True

    def pausado(self) -> float:
        """Quantos segundos ainda faltam da pausa global (0 se não há)."""
        with self._trava:
            return max(0.0, self._pausa_ate - time.monotonic())


def espera_pedida(resposta) -> float | None:
    """O `Retry-After` da resposta, em segundos, se veio e der pra ler.

    O cabeçalho pode vir como número de segundos ou como data HTTP. Obedecer
    o que a fonte pediu é sempre melhor que chutar um backoff: é o único
    número que vem de quem sabe quando vai liberar.
    """
    bruto = (resposta.headers.get("Retry-After") or "").strip()
    if not bruto:
        return None
    try:
        return max(0.0, float(bruto))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime
        quando = parsedate_to_datetime(bruto)
        if quando is None:
            return None
        import datetime as _dt
        agora = _dt.datetime.now(_dt.timezone.utc)
        if quando.tzinfo is None:
            quando = quando.replace(tzinfo=_dt.timezone.utc)
        return max(0.0, (quando - agora).total_seconds())
    except (TypeError, ValueError):
        return None


def backoff(tentativa: int, base: float, teto: float = 120.0) -> float:
    """Backoff exponencial com jitter.

    O jitter não é enfeite: sem ele, os workers que levaram 429 juntos
    esperam exatamente o mesmo tempo e voltam a bater juntos, reproduzindo a
    rajada que causou o 429.
    """
    bruto = min(base * (2 ** max(0, tentativa - 1)), teto)
    return bruto * random.uniform(0.7, 1.3)
