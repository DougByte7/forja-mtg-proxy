"""
Confere os comandos avulsos (`python -m app.tarefas ...`), que fazem na Vercel
o que o `startup` e as threads de fundo fazem no homelab.

1. **migrar** cria tudo e pode rodar de novo sem estragar nada.
2. **cartas** só remonta a base quando ela precisa — ou com `--forcar`.
3. **faxina** apaga as sessões vencidas e deixa as outras.
4. **O site sem as threads** não tenta sincronizar cartas por conta própria.

Roda contra o arquivo de sempre, ou contra o Turso se `DB_URL` estiver no
ambiente. Sem rede: a sincronização de verdade é trocada por um dublê.

    python tests/test_tarefas.py
"""
import os
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp()
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["ADMIN_TOKEN"] = "token-de-teste"
# O site como fica na Vercel: sem migrar no startup e sem thread de fundo.
os.environ["MIGRAR_NO_STARTUP"] = "0"
os.environ["TAREFAS_EM_SEGUNDO_PLANO"] = "0"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from app import cartas, storage, tarefas, usuarios  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


# --- 1. migrar ---------------------------------------------------------------
check("comando desconhecido sai com 2", tarefas.main(["nada"]) == 2)
check("migrar sai com 0", tarefas.main(["migrar"]) == 0)
check("e de novo também (é idempotente)", tarefas.main(["migrar"]) == 0)
check("as tabelas dos pedidos existem", storage.list_orders() == [])
check("e o banco de cartas responde", cartas.estado()["cartas"] == 0)

# --- 2. cartas ----------------------------------------------------------------
chamadas = []
cartas.sincronizar = lambda: chamadas.append(1) or {"ok": True}
check("base vazia: sincroniza", tarefas.main(["cartas"]) == 0 and len(chamadas) == 1)
cartas._precisa_sincronizar = lambda: False
check("base em dia: não sincroniza",
      tarefas.main(["cartas"]) == 0 and len(chamadas) == 1)
check("--forcar sincroniza mesmo em dia",
      tarefas.main(["cartas", "--forcar"]) == 0 and len(chamadas) == 2)


def explode():
    raise RuntimeError("Scryfall fora (dublê)")


cartas.sincronizar = explode
check("falha na sincronização sai com 1",
      tarefas.main(["cartas", "--forcar"]) == 1)

# --- 3. faxina ----------------------------------------------------------------
conta = usuarios.criar("alguem", "uma-senha-bem-longa", nome="Alguém")
conn = usuarios._conn()
agora = time.time()
conn.execute("INSERT INTO sessoes (token, usuario_id, criado_em, expira_em, "
             "visto_em, agente) VALUES (?,?,?,?,?,?)",
             ("vencida", conta["id"], agora - 10, agora - 5, agora - 10, ""))
conn.execute("INSERT INTO sessoes (token, usuario_id, criado_em, expira_em, "
             "visto_em, agente) VALUES (?,?,?,?,?,?)",
             ("valendo", conta["id"], agora, agora + 3600, agora, ""))
conn.commit()
conn.close()
check("faxina sai com 0", tarefas.main(["faxina"]) == 0)
conn = usuarios._conn()
restantes = {r[0] for r in conn.execute("SELECT token FROM sessoes")}
conn.close()
check("apaga a sessão vencida", "vencida" not in restantes, restantes)
check("e deixa a que vale", "valendo" in restantes, restantes)

# --- 4. o site sem thread de fundo --------------------------------------------
with TestClient(app) as cliente:
    r = cliente.post("/admin/cartas/sync",
                     headers={"X-Admin-Token": "token-de-teste"})
    check("o botão de sincronizar manda pro cron (409)", r.status_code == 409,
          r.status_code)
    check("e diz onde", "GitHub Actions" in r.text, r.text[:120])

if falhas:
    print(f"\n{len(falhas)} checagem(ns) falharam.")
    sys.exit(1)
print("\ntudo certo")
