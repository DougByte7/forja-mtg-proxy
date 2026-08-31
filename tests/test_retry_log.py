"""
Confere que uma fonte instável não some com um bloco de cartas.

Motivo de existir: numa cotação real de 75 cartas, 53 voltaram sem preço em
BLOCOS contíguos — todas respondiam normalmente quando pedidas de novo,
devagar. A causa era a soma de duas coisas: cada worker descobria o 429
sozinho (e os quatro queimavam as tentativas nos mesmos segundos) e não havia
segunda passada. Este arquivo trava as duas correções: o `Freio` compartilhado
e a repescagem do `cotar`.

Sem rede: a "fonte" aqui é uma função que finge o comportamento ruim.

    python tests/test_retry_log.py
"""
import sys
import threading
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from app.cotacao import Oferta, cotar  # noqa: E402
from app.ritmo import Freio, backoff  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


# --------------------------------------------------------------------------
# repescagem
# --------------------------------------------------------------------------
cartas = [{"nome": f"carta {i}", "quantidade": 1} for i in range(20)]


def fonte_com_rajada_barrada():
    """Falha nas cartas 5..14 na PRIMEIRA vez que cada uma é pedida.

    É o formato da falha real: um intervalo contíguo cai junto e volta ao
    normal quando pedido de novo.
    """
    vistas = set()

    def buscar(nome):
        indice = int(nome.split()[-1])
        primeira = nome not in vistas
        vistas.add(nome)
        if 5 <= indice < 15 and primeira:
            raise RuntimeError("HTTP 429")
        return [Oferta(loja="Loja", preco=1.0, condicao="NM")]
    return buscar


r = cotar(cartas, fonte_com_rajada_barrada(), repescagem=1, rotulo="teste")
check("repescagem recupera o bloco inteiro",
      len(r["itens"]) == 20 and not r["nao_encontradas"],
      f"({len(r['itens'])} cotadas, {len(r['nao_encontradas'])} faltando)")

r = cotar(cartas, fonte_com_rajada_barrada(), repescagem=0, rotulo="teste")
check("sem repescagem o bloco se perde (o bug de antes)",
      len(r["nao_encontradas"]) == 10,
      f"({len(r['nao_encontradas'])} faltando)")


def fonte_sempre_quebrada(nome):
    raise RuntimeError("caiu")


r = cotar(cartas[:3], fonte_sempre_quebrada, repescagem=2, rotulo="teste")
check("falha permanente ainda cai em nao_encontradas",
      len(r["nao_encontradas"]) == 3 and not r["itens"])
check("e o motivo carrega o TIPO da exceção",
      all("RuntimeError" in c["motivo"] for c in r["nao_encontradas"]),
      r["nao_encontradas"][0]["motivo"])

# "não tenho essa carta" não é falha transitória: repescar seria bater à toa.
pedidos = []


def fonte_sem_a_carta(nome):
    pedidos.append(nome)
    return []


r = cotar(cartas[:4], fonte_sem_a_carta, repescagem=2, rotulo="teste")
check("carta inexistente NÃO é repescada",
      len(pedidos) == 4, f"({len(pedidos)} buscas para 4 cartas)")

# A barra de progresso não pode passar de 100% por causa da repescagem.
passos = []
cotar(cartas, fonte_com_rajada_barrada(), repescagem=1,
      on_progress=lambda f, t: passos.append((f, t)), rotulo="teste")
check("progresso não estoura o total mesmo com repescagem",
      len(passos) == 20 and max(f for f, _ in passos) == 20,
      f"({len(passos)} passos, máximo {max(f for f, _ in passos)})")

# --------------------------------------------------------------------------
# freio compartilhado
# --------------------------------------------------------------------------
freio = Freio("teste", 0.01)
freio.recuar(0.4, motivo="429 de teste")
inicio = time.monotonic()
threads = [threading.Thread(target=freio.esperar) for _ in range(4)]
[t.start() for t in threads]
[t.join() for t in threads]
decorrido = time.monotonic() - inicio
check("um 429 segura TODAS as threads da fonte, não só a que levou",
      0.35 <= decorrido <= 1.2, f"({decorrido:.2f}s)")

# Pausa nova: a de cima já venceu enquanto as threads a esperavam.
freio.recuar(5.0, motivo="429 de teste")
check("recuar não encurta uma pausa já em curso", freio.recuar(0.01) is False)
check("recuar estende quando o pedido é maior", freio.recuar(9.0) is True)

esperas = [backoff(3, 1.0) for _ in range(20)]
check("backoff tem jitter (senão os workers voltam a bater juntos)",
      len(set(round(e, 4) for e in esperas)) > 15)
check("backoff respeita o teto", all(backoff(20, 1.0, teto=10) <= 13 for _ in range(20)))

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
