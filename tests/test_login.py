"""
Confere que o login é OPCIONAL e ADITIVO.

MOTIVO DE EXISTIR, e ele cabe numa frase: **quem não tem conta tem que
continuar usando o site exatamente como antes desta tabela existir.** Este
projeto inteiro foi construído sobre "quem tem o id, mexe" — sem cadastro,
sem sessão, sem nada. Acrescentar login é o tipo de mudança que fecha portas
sem querer, e o sintoma não é erro de teste: é uma pessoa que não consegue
mais salvar o deck que estava montando.

Por isso a PRIMEIRA seção é a do anônimo, e ela é a mais importante do
arquivo. As outras protegem o que o login promete em troca:

* deck com dono só é gravado pelo dono (e pelo admin) — mas continua ABRINDO
  pra qualquer um, porque compartilhar o link é a razão de o link existir;
* reclamar órfão nunca tira nada de ninguém: só pega o que não tem dono;
* `GET /decks/meus` é listagem, e não "o deck de id `meus`" — a armadilha de
  ordem de rota do FastAPI, que falha em silêncio e pra sempre;
* o `ADMIN_TOKEN` continua abrindo o painel, porque ele é a chave da casa:
  funciona de `curl`, sem cookie e sem banco, e é o que resta quando a tabela
  de usuários está vazia ou alguém esqueceu a senha.

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
os.environ["SENHA_ITERACOES"] = "1000"
# O TestClient fala http://testserver: com secure=True o cookie não é gravado
# e nada aqui entraria. É a MESMA pegadinha que derruba o login na rede local,
# e é por isso que a variável existe.
os.environ["SESSAO_SEGURA"] = "0"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from app import cartas, decks, storage, usuarios  # noqa: E402
from app.main import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def cliente_logado(login, senha):
    """Um TestClient com sessão aberta — cada um com o seu jarro de cookies."""
    c = TestClient(app)
    r = c.post("/conta/entrar", json={"login": login, "senha": senha})
    assert r.status_code == 200, r.text
    return c


try:
    cartas.init_db()
    decks.init_db()
    storage.init_db()
    usuarios.init_db()

    ana = usuarios.criar("ana", "senha-da-ana-1", perfil="cliente")
    beto = usuarios.criar("beto", "senha-do-beto-1", perfil="cliente")
    chefe = usuarios.criar("chefe", "senha-do-chefe-1", perfil="admin")

    anonimo = TestClient(app)

    # =====================================================================
    print("\n--- o anônimo continua funcionando (a promessa da etapa) ---")
    # =====================================================================

    r = anonimo.post("/decks", json={"nome": "Deck de ninguém"})
    eq("anônimo cria deck", r.status_code, 200)
    orfao = r.json()["deck"]["id"]

    eq("anônimo lê", anonimo.get(f"/decks/{orfao}").status_code, 200)
    eq("anônimo grava",
       anonimo.put(f"/decks/{orfao}",
                   json={"nome": "Mudei o nome", "comandantes": [],
                         "cartas": []}).status_code, 200)
    eq("anônimo duplica",
       anonimo.post(f"/decks/{orfao}/duplicar").status_code, 200)
    eq("anônimo apaga", anonimo.delete(f"/decks/{orfao}").status_code, 200)

    eq("e a rota de conta não erra pra quem não tem conta",
       anonimo.get("/conta").status_code, 200)
    # 200 com null, e não 401: é a rota que toda página chama ao abrir, e um
    # 401 por carregamento ensina a ignorar o console.
    eq("ela responde `usuario: null`", anonimo.get("/conta").json()["usuario"], None)

    # =====================================================================
    print("\n--- entrar e sair ---")
    # =====================================================================

    eq("senha errada é 401",
       anonimo.post("/conta/entrar",
                    json={"login": "ana", "senha": "chute"}).status_code, 401)
    # A mensagem não pode dizer qual dos dois errou, senão a tela de login
    # vira um conferidor de quais contas existem.
    msg_inexistente = anonimo.post(
        "/conta/entrar", json={"login": "ninguem", "senha": "chute"}).json()["detail"]
    msg_senha = anonimo.post(
        "/conta/entrar", json={"login": "ana", "senha": "chute"}).json()["detail"]
    eq("a recusa não distingue login inexistente de senha errada",
       msg_inexistente, msg_senha)

    c_ana = cliente_logado("ana", "senha-da-ana-1")
    eq("depois de entrar, /conta diz quem é",
       c_ana.get("/conta").json()["usuario"]["login"], "ana")

    # O cookie não pode ser legível por script: um XSS não pode virar sessão.
    bruto = c_ana.post("/conta/entrar",
                       json={"login": "ana", "senha": "senha-da-ana-1"})
    cabecalho = bruto.headers.get("set-cookie", "")
    check("o cookie sai HttpOnly", "httponly" in cabecalho.lower())
    check("e com SameSite", "samesite" in cabecalho.lower())
    check("o corpo da resposta não traz o token de sessão",
          "forja_sessao" not in bruto.text)
    check("nem hash de senha", "pbkdf2" not in bruto.text)

    # =====================================================================
    print("\n--- deck com dono ---")
    # =====================================================================

    meu = c_ana.post("/decks", json={"nome": "Deck da Ana"}).json()["deck"]["id"]
    c_beto = cliente_logado("beto", "senha-do-beto-1")
    c_chefe = cliente_logado("chefe", "senha-do-chefe-1")

    corpo = {"nome": "Invadido", "comandantes": [], "cartas": []}
    # Ler continua aberto: compartilhar o link é a razão de o link existir.
    eq("anônimo ainda ABRE o deck de outra pessoa",
       anonimo.get(f"/decks/{meu}").status_code, 200)
    eq("mas não grava", anonimo.put(f"/decks/{meu}", json=corpo).status_code, 403)
    eq("e não apaga", anonimo.delete(f"/decks/{meu}").status_code, 403)
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

    solto = anonimo.post("/decks", json={"nome": "Sem dono"}).json()["deck"]["id"]
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

    # Reclamar é rotulagem ADITIVA: não fecha nada que estava aberto.
    eq("o pedido reclamado continua consultável por quem tem o id",
       anonimo.get(f"/orders/{p1}").status_code, 200)
    eq("e continua cancelável por quem tem o id",
       anonimo.post(f"/orders/{p1}/cancel").status_code, 200)

    # =====================================================================
    print("\n--- a porta do admin ---")
    # =====================================================================

    # O canário: o token da casa continua valendo, sem cookie e sem banco.
    eq("X-Admin-Token ainda abre",
       anonimo.get("/admin/decks", headers={"X-Admin-Token": TOKEN}).status_code, 200)
    eq("sessão de admin também abre", c_chefe.get("/admin/decks").status_code, 200)
    eq("sessão de cliente NÃO abre", c_ana.get("/admin/decks").status_code, 401)
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
            url = url.replace("{usuario_id}", "xxxx").replace("{deck_id}", "xxxx")
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

    print("\n--- contas, pelo admin ---")

    eq("admin cria conta",
       c_chefe.post("/admin/usuarios",
                    json={"login": "novato", "senha": "senha-do-novato"}).status_code, 200)
    eq("senha curta é 400, com a razão",
       c_chefe.post("/admin/usuarios",
                    json={"login": "outro", "senha": "curta"}).status_code, 400)
    eq("cliente não cria conta",
       c_ana.post("/admin/usuarios",
                  json={"login": "x", "senha": "senha-longa-aqui"}).status_code, 401)
    check("a listagem de contas não traz hash",
          all("senha" not in u for u in c_chefe.get("/admin/usuarios").json()["usuarios"]))

    # Apagar conta não apaga o acervo: tirar o acesso e destruir o trabalho
    # são coisas diferentes.
    novato = next(u for u in c_chefe.get("/admin/usuarios").json()["usuarios"]
                  if u["login"] == "novato")
    d_novato = decks.criar("Deck do novato", dono=novato["id"])["id"]
    c_chefe.delete(f"/admin/usuarios/{novato['id']}")
    check("apagar a conta não apaga os decks dela",
          decks.obter(d_novato) is not None)
    eq("eles voltam a ser órfãos", decks.dono_de(d_novato)[1], None)

    print("\n--- trocar a própria senha ---")

    eq("precisa da senha atual",
       c_ana.post("/conta/senha",
                  json={"atual": "chute", "nova": "nova-senha-ana"}).status_code, 403)
    eq("com a atual certa, troca",
       c_ana.post("/conta/senha",
                  json={"atual": "senha-da-ana-1",
                        "nova": "nova-senha-ana"}).status_code, 200)
    # Trocar senha derruba TODAS as sessões, inclusive esta.
    eq("e a sessão de quem trocou cai junto",
       c_ana.get("/decks/meus").status_code, 401)

    print("\n--- sair ---")

    eq("sair responde ok", c_beto.post("/conta/sair").status_code, 200)
    eq("e depois disso é anônimo de novo",
       c_beto.get("/conta").json()["usuario"], None)
    eq("sair sem estar logado não é erro",
       anonimo.post("/conta/sair").status_code, 200)

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
