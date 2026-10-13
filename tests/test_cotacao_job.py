"""
Confere a cotação que anda nas consultas (`cotacao_job.py`).

Não há thread nem memória entre uma pergunta e outra: o job mora no banco, e
cada `estado(job_id)` cota um pedaço e responde. É o que deixa a cotação
funcionar num servidor que pode ser outro processo a cada requisição. O que
se trava aqui:

1. **Anda aos pedaços e termina.** Cada pergunta faz no máximo uma fatia; a
   soma das fatias cota o deck inteiro, e o resultado sai igual ao de antes.
2. **Nada se repete.** Carta já cotada não volta pra rede — nem na próxima
   fatia, nem num job novo do mesmo deck.
3. **Falha tem fim.** Carta cuja busca falha é tentada `TENTATIVAS` vezes e
   depois sai como faltando, com o motivo; o job não fica girando pra sempre.
4. **Uma pergunta por vez.** Com a fatia reservada por outra, a pergunta só
   responde o andamento.

As fontes são dublês (sem rede), mas gravam no cache de verdade, como as
reais. Roda contra o arquivo, ou contra o Turso com `CARTAS_DB_URL`.

    python tests/test_cotacao_job.py
"""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp()
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["COTACAO_FATIA_SEGUNDOS"] = "0.3"
os.environ["COTACAO_RESOLVER_NOMES"] = "0"

from app import cache_precos, cambio, cotacao_job  # noqa: E402
from app.cotacao import Oferta  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


# --- dublês ------------------------------------------------------------------
pedidas = {"lenta": [], "rapida": []}
trava = threading.Lock()
quebradas = {"Carta Ruim"}


def fonte(id_, pausa, preco):
    def buscar(nome):
        with trava:
            pedidas[id_].append(nome)
        time.sleep(pausa)
        if nome in quebradas:
            raise ConnectionError("429 (dublê)")
        ofertas = [Oferta(loja=f"Loja {id_}", preco=preco, condicao="NM")]
        cache_precos.gravar(id_, nome, ofertas)
        return ofertas
    return {"id": id_, "rotulo": id_, "moeda": "BRL", "workers": 1,
            "buscar": buscar}


FONTES = [fonte("lenta", 0.1, 5.0), fonte("rapida", 0.0, 1.0)]
cotacao_job.fontes_ativas = lambda: FONTES
cambio.taxa = lambda: {"usd_brl": 5.0}

deck = [{"nome": f"Carta {i}", "quantidade": 1} for i in range(8)] + \
       [{"nome": "Carta Ruim", "quantidade": 2}]

# --- 1. começar não cota nada ------------------------------------------------
r = cotacao_job.iniciar_lista(deck)
job = r["job_id"]
check("começa cotando", r["estado"] == "cotando", r)
check("e não tocou em fonte nenhuma",
      not pedidas["lenta"] and not pedidas["rapida"])
check("o total conta cartas x fontes", r["total"] == 9 * 2, r)
check("clicar de novo cai no mesmo job",
      cotacao_job.iniciar_lista(deck)["job_id"] == job)

# --- 2. anda aos pedaços ------------------------------------------------------
r = cotacao_job.estado(job)
check("uma pergunta é só um pedaço", r["estado"] == "cotando", r["estado"])
check("mas anda", 0 < r["feitas"] < r["total"], (r.get("feitas"), r.get("total")))
check("a fonte lenta fez só o que coube na fatia",
      0 < len(pedidas["lenta"]) < 9, len(pedidas["lenta"]))
andou = r["feitas"]

perguntas = 1
while r["estado"] == "cotando" and perguntas < 60:
    r = cotacao_job.estado(job)
    perguntas += 1
    check_monotono = r.get("feitas", andou) >= andou if r["estado"] == "cotando" else True
    if not check_monotono:
        check("o andamento nunca volta", False, (andou, r.get("feitas")))
    andou = r.get("feitas", andou)
check("várias perguntas terminam o job", r["estado"] == "pronto",
      (r["estado"], perguntas))

# --- 3. o resultado ----------------------------------------------------------
res = r["resultado"]
lenta = next(f for f in res["fontes"] if f["id"] == "lenta")
check("8 cartas cotadas na fonte lenta", lenta["cartas_cotadas"] == 8, lenta)
check("e o total delas", lenta["total"] == 40.0, lenta["total"])
check("a carta que falhou sai como faltando, com o motivo",
      [c["nome"] for c in lenta["nao_encontradas"]] == ["Carta Ruim"]
      and "429" in lenta["nao_encontradas"][0]["motivo"],
      lenta["nao_encontradas"])
check("tentada exatamente TENTATIVAS vezes",
      pedidas["lenta"].count("Carta Ruim") == cotacao_job.TENTATIVAS,
      pedidas["lenta"].count("Carta Ruim"))
check("nenhuma carta boa foi pedida duas vezes",
      all(pedidas["lenta"].count(f"Carta {i}") == 1 for i in range(8)))
check("o câmbio vai junto", res["cambio"] == {"usd_brl": 5.0})
check("uma linha por carta, com as duas fontes",
      len(res["linhas"]) == 9
      and all(set(l["precos"]) == {"lenta", "rapida"} for l in res["linhas"]))

check("perguntar de novo devolve o mesmo resultado, sem trabalhar",
      cotacao_job.estado(job)["resultado"] == res)

# --- 4. o mesmo deck de novo vem do cache ------------------------------------
antes = {k: len(v) for k, v in pedidas.items()}
quebradas.clear()
r = cotacao_job.iniciar_lista(deck)
check("depois de pronto, cotar de novo começa outro job",
      r["estado"] == "cotando" and r["job_id"] == job)
r = cotacao_job.estado(job)
check("e termina numa pergunta só", r["estado"] == "pronto", r["estado"])
check("pedindo à rede só a carta que faltava",
      pedidas["lenta"][antes["lenta"]:] == ["Carta Ruim"]
      and pedidas["rapida"][antes["rapida"]:] == ["Carta Ruim"],
      (pedidas["lenta"][antes["lenta"]:], pedidas["rapida"][antes["rapida"]:]))

# --- 5. uma pergunta por vez -------------------------------------------------
outro = [{"nome": f"Outra {i}", "quantidade": 1} for i in range(4)]
j2 = cotacao_job.iniciar_lista(outro)["job_id"]
check("a primeira pergunta reserva a fatia", cotacao_job._reservar(j2))
antes = len(pedidas["lenta"])
r = cotacao_job.estado(j2)
check("com a fatia reservada por outra, só responde",
      r["estado"] == "cotando" and len(pedidas["lenta"]) == antes,
      len(pedidas["lenta"]) - antes)
cotacao_job._gravar(j2, ocupado_ate=time.time() - 1)
r = cotacao_job.estado(j2)
check("reserva vencida volta a andar", len(pedidas["lenta"]) > antes)

# --- 6. faxina e o que não existe --------------------------------------------
check("job desconhecido é None", cotacao_job.estado("nao-existe") is None)
cotacao_job._gravar(job, inicio=time.time() - 2 * 86400)
check("a faxina apaga job velho", cotacao_job.podar() == 1)
check("e ele some", cotacao_job.estado(job) is None)

if falhas:
    print(f"\n{len(falhas)} checagem(ns) falharam.")
    sys.exit(1)
print("\ntudo certo")
