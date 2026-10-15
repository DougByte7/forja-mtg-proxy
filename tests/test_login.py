"""
Confere o que a conta abre e o que ela protege.

MOTIVO DE EXISTIR, e a regra cabe numa frase: **deck se cria e se altera com
conta; abrir deck, não; pedido, só com conta de amigo.** Conta é o tipo de coisa que fecha
portas sem querer — ou deixa abertas —, e o sintoma não é erro de teste: é um
link compartilhado que parou de abrir, ou um anônimo reescrevendo o deck de
alguém.

Por isso a PRIMEIRA seção é a do anônimo: ele abre qualquer deck e não mexe
em nenhum, nem no órfão. As outras protegem o resto:

* deck com dono só é gravado pelo dono (e pelo admin) — mas continua ABRINDO
  pra qualquer um, porque compartilhar o link é a razão de o link existir;
* reclamar órfão nunca tira nada de ninguém: só pega o que não tem dono;
* `GET /decks/meus` é listagem, e não "o deck de id `meus`" — a armadilha de
  ordem de rota do FastAPI, que falha em silêncio e pra sempre;
* o `ADMIN_TOKEN` continua abrindo o painel, porque ele é a chave da casa:
  funciona de `curl`, sem conta e sem banco, e é o que resta quando o Clerk
  está fora do ar ou ninguém tem o perfil `admin`.

A conta é a do Clerk, com tokens de teste (`conta_clerk.py`); o que a tela do
Clerk faz (entrar, cadastrar, senha) é dele e não se testa aqui.

Não precisa de rede. Rode de dentro da raiz do projeto:

    python tests/test_login.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-login-")
TOKEN = "token-de-teste-789"
os.environ["ADMIN_TOKEN"] = TOKEN
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

import conta_clerk  # noqa: E402  (antes do app: põe a chave no ambiente)
from app import cartas, decks, storage  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def cliente_logado(sub, perfil):
    """Um TestClient com o token dessa conta em toda requisição."""
    return conta_clerk.cliente(app, sub, perfil)


try:
    cartas.init_db()
    decks.init_db()
    storage.init_db()

    # Ana é amiga (faz pedido); Beto é só cliente (monta deck). O id da conta
    # é o `sub` do token.
    ana, beto = {"id": "ana"}, {"id": "beto"}

    anonimo = TestClient(app)

    # =====================================================================
    print("\n--- o anônimo abre deck, mas não cria nem altera ---")
    # =====================================================================

    orfao = decks.criar("Deck de ninguém")["id"]
    eq("anônimo lê", anonimo.get(f"/decks/{orfao}").status_code, 200)

    r = anonimo.post("/decks", json={"nome": "Sem conta"})
    eq("anônimo não cria deck", r.status_code, 401)
    check("e a recusa diz que é por conta", "conta" in r.json()["detail"],
          r.json())
    # Nem o órfão: sem esta linha, "precisa de conta pra criar" seria
    # contornado abrindo qualquer link de deck sem dono e reescrevendo.
    eq("não grava nem deck sem dono",
       anonimo.put(f"/decks/{orfao}",
                   json={"nome": "Mudei o nome", "comandantes": [],
                         "cartas": []}).status_code, 401)
    eq("não duplica", anonimo.post(f"/decks/{orfao}/duplicar").status_code, 401)
    eq("não apaga", anonimo.delete(f"/decks/{orfao}").status_code, 401)
    eq("não escolhe arte",
       anonimo.put(f"/decks/{orfao}/artes", json={}).status_code, 401)
    eq("não conclui versão",
       anonimo.post(f"/decks/{orfao}/versoes").status_code, 401)
    eq("e o deck continua como estava", decks.obter(orfao)["nome"],
       "Deck de ninguém")

    eq("e a rota de conta não erra pra quem não tem conta",
       anonimo.get("/conta").status_code, 200)
    # 200 com null, e não 401: é a rota que toda página chama ao abrir, e um
    # 401 por carregamento ensina a ignorar o console.
    eq("ela responde `usuario: null`", anonimo.get("/conta").json()["usuario"], None)

    # =====================================================================
    print("\n--- quem é ---")
    # =====================================================================

    c_ana = cliente_logado("ana", "amigo")
    eq("com token, /conta diz quem é", c_ana.get("/conta").json()["usuario"]["id"], "ana")
    # 503 é a rota certa sem o build do front (ver `test_frontend.py`).
    check("as telas do Clerk têm rota",
          all(anonimo.get(p).status_code in (200, 503) for p in ("/entrar", "/cadastro")))
    for velha in ("/conta/entrar", "/conta/criar", "/conta/sair", "/conta/senha"):
        check(f"a rota antiga {velha} saiu",
              anonimo.post(velha, json={}).status_code in (404, 405))

    # =====================================================================
    print("\n--- deck com dono ---")
    # =====================================================================

    meu = c_ana.post("/decks", json={"nome": "Deck da Ana"}).json()["deck"]["id"]
    eq("o deck nasce de quem criou", decks.dono_de(meu)[1], ana["id"])
    eq("com conta, grava deck sem dono",
       c_ana.put(f"/decks/{orfao}",
                 json={"nome": "Agora sim", "comandantes": [],
                       "cartas": []}).status_code, 200)
    c_beto = cliente_logado("beto", "cliente")
    c_chefe = cliente_logado("chefe", "admin")

    corpo = {"nome": "Invadido", "comandantes": [], "cartas": []}
    # Ler continua aberto: compartilhar o link é a razão de o link existir.
    eq("anônimo ainda ABRE o deck de outra pessoa",
       anonimo.get(f"/decks/{meu}").status_code, 200)
    # 401 e não 403: pra quem não tem conta, a resposta útil é "entre", não
    # "é de outra pessoa".
    eq("mas não grava", anonimo.put(f"/decks/{meu}", json=corpo).status_code, 401)
    eq("e não apaga", anonimo.delete(f"/decks/{meu}").status_code, 401)
    eq("outro usuário também não",
       c_beto.put(f"/decks/{meu}", json=corpo).status_code, 403)
    eq("o dono grava", c_ana.put(f"/decks/{meu}", json=corpo).status_code, 200)
    eq("o admin também", c_chefe.put(f"/decks/{meu}", json=corpo).status_code, 200)

    # Duplicar é a válvula de escape de quem abriu o deck de outra pessoa.
    r = c_beto.post(f"/decks/{meu}/duplicar")
    eq("duplicar o deck de outro é permitido", r.status_code, 200)
    eq("e a cópia é de quem duplicou, não do dono do original",
       decks.dono_de(r.json()["deck"]["id"])[1], beto["id"])

    # =====================================================================
    print("\n--- reclamar órfão ---")
    # =====================================================================

    solto = decks.criar("Sem dono")["id"]
    eq("anônimo não pode reclamar",
       anonimo.post(f"/decks/{solto}/reclamar").status_code, 401)
    eq("logado reclama", c_ana.post(f"/decks/{solto}/reclamar").status_code, 200)
    eq("e vira dono", decks.dono_de(solto)[1], ana["id"])
    # 409 e não 403: não é "você não pode", é "essa ação não cabe mais aqui".
    eq("reclamar de novo é 409",
       c_beto.post(f"/decks/{solto}/reclamar").status_code, 409)
    eq("reclamar deck inexistente é 404",
       c_ana.post("/decks/naoexisteid/reclamar").status_code, 404)

    # =====================================================================
    print("\n--- os meus ---")
    # =====================================================================

    # A armadilha de ordem de rota: declarada depois de /decks/{deck_id},
    # esta rota viraria "o deck de id `meus`" e responderia 404 pra sempre.
    r = c_ana.get("/decks/meus")
    eq("/decks/meus é listagem, não um deck chamado 'meus'", r.status_code, 200)
    ids = [d["id"] for d in r.json()["decks"]]
    check("traz os decks da pessoa", meu in ids and solto in ids)
    check("e não os dos outros",
          all(d["dono"] == ana["id"] for d in r.json()["decks"]))
    eq("anônimo não tem 'os meus'", anonimo.get("/decks/meus").status_code, 401)

    # =====================================================================
    print("\n--- pedidos órfãos ---")
    # =====================================================================

    p1, _ = storage.create_order("<order/>", "single", "Ana", "AAAA",
                                 {"qty": 1, "backs_count": 0, "pages": 1,
                                  "blanks": 8, "total": 2.5})
    p2, _ = storage.create_order("<order/>", "single", "Beto", "BBBB",
                                 {"qty": 1, "backs_count": 0, "pages": 1,
                                  "blanks": 8, "total": 2.5})
    storage.reclamar([p2], beto["id"])

    r = c_ana.post("/pedidos/reclamar", json={"ids": [p1, p2, "naoexiste"]})
    eq("reclamar pedidos responde 200", r.status_code, 200)
    # Só o órfão. O do Beto não é tocado e não vira erro: dois irmãos num
    # computador só é um caso real, não uma hipótese.
    eq("só o órfão é reclamado", r.json()["reclamados"], [p1])
    eq("o pedido do outro continua dele", storage.get_order(p2)["dono"], beto["id"])

    eq("os meus pedidos aparecem",
       [p["id"] for p in c_ana.get("/pedidos/meus").json()["pedidos"]], [p1])
    eq("corpo sem lista é 400",
       c_ana.post("/pedidos/reclamar", json={}).status_code, 400)

    eq("cliente que não é amigo não reclama pedido",
       c_beto.post("/pedidos/reclamar", json={"ids": [p1]}).status_code, 403)
    eq("nem lista os pedidos", c_beto.get("/pedidos/meus").status_code, 403)

    # Depois de reclamado, o pedido é da Ana: o id sozinho não abre mais.
    eq("anônimo não consulta o pedido", anonimo.get(f"/orders/{p1}").status_code, 401)
    eq("nem cancela", anonimo.post(f"/orders/{p1}/cancel").status_code, 401)
    eq("a dona consulta", c_ana.get(f"/orders/{p1}").status_code, 200)
    eq("e cancela", c_ana.post(f"/orders/{p1}/cancel").status_code, 200)

    # =====================================================================
    print("\n--- a porta do admin ---")
    # =====================================================================

    # O canário: o token da casa continua valendo, sem cookie e sem banco.
    eq("X-Admin-Token ainda abre",
       anonimo.get("/admin/decks", headers={"X-Admin-Token": TOKEN}).status_code, 200)
    eq("sessão de admin também abre", c_chefe.get("/admin/decks").status_code, 200)
    eq("sessão de amigo NÃO abre", c_ana.get("/admin/decks").status_code, 401)
    eq("nem a de cliente", c_beto.get("/admin/decks").status_code, 401)
    eq("anônimo não abre", anonimo.get("/admin/decks").status_code, 401)

    r = c_chefe.get("/admin/decks").json()
    check("a listagem do admin agora mostra dono de verdade",
          any(d["dono"] == ana["id"] for d in r["decks"]))
    check("e a contagem de órfãos encolheu", r["contagem"]["sem_dono"] < r["contagem"]["total"])

    # ---------------------------------------------------------------
    # A varredura. Este é o teste que sobrevive ao próximo `/admin/...`
    # que alguém acrescentar: em vez de conferir uma lista escrita à mão,
    # ele pergunta ao próprio app quais rotas existem. Uma rota nova que
    # esqueça o `_check_admin` aparece aqui no dia em que nasce.
    # ---------------------------------------------------------------
    print("\n--- toda rota /admin exige admin (varredura) ---")

    abertas, sem_sessao = [], []
    for rota in app.routes:
        caminho = getattr(rota, "path", "")
        if not caminho.startswith("/admin"):
            continue
        # A casca HTML do painel é pública de propósito: o que se protege é o
        # dado, não o layout (ver o comentário em `admin_page`).
        if caminho == "/admin":
            continue
        for metodo in (getattr(rota, "methods", None) or set()) - {"HEAD", "OPTIONS"}:
            # Um id de mentira basta: a checagem de admin vem antes de
            # qualquer busca no banco, então 404 aqui já seria falha.
            url = caminho.replace("{order_id}", "xxxx").replace("{combo_id}", "xxxx")
            url = url.replace("{deck_id}", "xxxx")
            # Rota com `Form(...)` recusa o corpo vazio com 422 ANTES de
            # rodar o corpo da função — então um 422 aqui não prova nada
            # sobre a porta. Reenvia com dados plausíveis e exige o 401.
            resposta = anonimo.request(metodo, url)
            if resposta.status_code == 422:
                resposta = anonimo.request(
                    metodo, url,
                    data={"status": "pending", "ids": "xxxx", "nova": "x" * 12})
            if resposta.status_code != 401:
                abertas.append(f"{metodo} {caminho} ({resposta.status_code})")

            do_chefe = c_chefe.request(metodo, url)
            if do_chefe.status_code == 401:
                sem_sessao.append(f"{metodo} {caminho}")

    check("nenhuma rota /admin responde a anônimo", not abertas,
          f"(abertas: {abertas})")
    check("e todas aceitam sessão de admin", not sem_sessao,
          f"(só com token: {sem_sessao})")

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
