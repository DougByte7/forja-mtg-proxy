"""
Confere o módulo de contas: senha, sessão e o que nunca pode sair daqui.

MOTIVO DE EXISTIR. Este é o único código do projeto onde um erro silencioso
vira problema de segurança em vez de número errado na tela. Quatro coisas
precisam valer, e nenhuma delas dá erro visível quando quebra:

1. **A senha nunca é guardada em claro, e a conferência é em tempo constante.**
   Um `==` no lugar do `compare_digest` funciona perfeitamente e vaza o hash
   byte a byte pra quem medir o tempo de resposta.
2. **As iterações vão guardadas na string.** É isso que permite subir o teto
   amanhã sem invalidar as senhas de hoje. Se a conferência lesse a constante
   em vez do que está gravado, todo mundo ficaria trancado do lado de fora no
   dia do aumento — e o sintoma seria "a senha parou de funcionar".
3. **`_publico` é o único caminho de saída, e não copia o hash.** Devolver a
   linha crua funciona hoje e vaza a senha no dia em que alguém escrever um
   `return dict(linha)` numa rota nova.
4. **Sessão vencida não abre.** Sem isso, "sair" e "expirar" viram enfeite.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_usuarios.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-usuarios-")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"
# Baixo só aqui: o teste roda dezenas de cifragens, e 600 mil iterações vezes
# dezenas seriam meio minuto de espera pra provar a mesma coisa.
os.environ["SENHA_ITERACOES"] = "1000"

from app import usuarios  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


try:
    usuarios.init_db()

    print("\n--- senha ---")

    guardada = usuarios.cifrar("segredo-bom-123")
    check("não guarda a senha em claro", "segredo-bom-123" not in guardada)
    check("declara o algoritmo", guardada.startswith("pbkdf2_sha256$"))
    check("confere a certa", usuarios.confere("segredo-bom-123", guardada))
    check("recusa a errada", not usuarios.confere("segredo-bom-124", guardada))
    check("recusa vazia", not usuarios.confere("", guardada))
    # Nunca levanta: "não consigo conferir" tem que virar "não entrou", não
    # uma exceção que derruba a rota de login.
    check("formato estragado no banco vira False, não exceção",
          not usuarios.confere("x", "lixo-que-nao-e-hash"))
    check("None também", not usuarios.confere("x", None))

    # Sal por usuário: duas contas com a MESMA senha não podem ter o mesmo
    # hash, senão um vazamento entrega quem repetiu senha com quem.
    check("o sal é por senha, não fixo",
          usuarios.cifrar("igualzinha") != usuarios.cifrar("igualzinha"))

    # As iterações viajam na string. Este é o teste que permite subir o teto.
    antiga = usuarios.cifrar("nao-me-tranque")
    usuarios.ITERACOES = 2000
    try:
        check("senha cifrada com o teto antigo continua conferindo",
              usuarios.confere("nao-me-tranque", antiga))
        nova = usuarios.cifrar("nao-me-tranque")
        check("e a nova nasce com o teto novo", "$2000$" in nova)
    finally:
        usuarios.ITERACOES = 1000

    try:
        usuarios.cifrar("curta")
        check("senha curta é recusada", False, "(não levantou)")
    except usuarios.SenhaFraca:
        check("senha curta é recusada", True)

    print("\n--- contas ---")

    ana = usuarios.criar("Ana", "senha-da-ana-1", nome="Ana", perfil="admin")
    beto = usuarios.criar("beto", "senha-do-beto-1")

    eq("o login é achatado na entrada", ana["login"], "ana")
    eq("o perfil padrão é cliente", beto["perfil"], "cliente")

    # O UNIQUE da coluna é quem impede a conta duplicada, e ele só funciona
    # porque o login já entra achatado.
    try:
        usuarios.criar("ANA", "outra-senha-aqui")
        check("login repetido em outra caixa é recusado", False, "(criou)")
    except ValueError:
        check("login repetido em outra caixa é recusado", True)

    # O teste que protege contra o `return dict(linha)` de amanhã.
    for campo in ("senha", "password", "hash"):
        check(f"a conta que sai daqui não traz `{campo}`", campo not in ana)
    check("nem na listagem",
          all("senha" not in u for u in usuarios.listar()))

    print("\n--- sessão ---")

    check("senha errada não abre sessão",
          usuarios.entrar("ana", "chute-qualquer-1") is None)
    # Uma resposta só pros dois casos: diferenciar transformaria a tela de
    # login num conferidor de quais contas existem.
    check("login inexistente também é None (não é outro erro)",
          usuarios.entrar("ninguem", "chute-qualquer-1") is None)

    aberta = usuarios.entrar("ana", "senha-da-ana-1")
    check("senha certa abre", aberta is not None)
    usuario, token, duracao = aberta
    eq("a sessão é de quem entrou", usuario["id"], ana["id"])

    # O token cru só existe no cookie. O banco guarda o SHA-256 dele.
    conn = usuarios._conn()
    guardados = [r["token"] for r in conn.execute("SELECT token FROM sessoes")]
    conn.close()
    check("o token cru não está no banco", token not in guardados)
    check("o que está no banco é o achatado",
          usuarios._achatar_token(token) in guardados)

    eq("o token identifica a pessoa",
       usuarios.da_sessao(token)["id"], ana["id"])
    check("token inventado não abre", usuarios.da_sessao("token-de-mentira") is None)
    check("token vazio não abre", usuarios.da_sessao("") is None)

    # "Lembrar de mim" só muda a duração — é a escolha entre o computador
    # emprestado e o celular do dono.
    _, t_curto, d_curto = usuarios.entrar("beto", "senha-do-beto-1")
    _, t_longo, d_longo = usuarios.entrar("beto", "senha-do-beto-1", lembrar=True)
    check("lembrar dura mais", d_longo > d_curto)

    usuarios.sair(t_curto)
    check("depois de sair, o token não abre mais",
          usuarios.da_sessao(t_curto) is None)
    check("mas as outras sessões da pessoa continuam",
          usuarios.da_sessao(t_longo) is not None)

    # Vencida: `da_sessao` apaga na hora em vez de esperar a faxina.
    conn = usuarios._conn()
    conn.execute("UPDATE sessoes SET expira_em=? WHERE token=?",
                 (time.time() - 1, usuarios._achatar_token(t_longo)))
    conn.commit()
    conn.close()
    check("sessão vencida não abre", usuarios.da_sessao(t_longo) is None)

    print("\n--- trocar senha derruba as sessões ---")

    _, t1, _ = usuarios.entrar("beto", "senha-do-beto-1")
    _, t2, _ = usuarios.entrar("beto", "senha-do-beto-1")
    usuarios.trocar_senha(beto["id"], "senha-nova-do-beto")
    # É o que se espera de trocar senha, e a única forma de a troca servir pra
    # alguma coisa quando o motivo dela foi desconfiança.
    check("as sessões antigas caem", usuarios.da_sessao(t1) is None
          and usuarios.da_sessao(t2) is None)
    check("a senha velha não entra mais",
          usuarios.entrar("beto", "senha-do-beto-1") is None)
    check("a nova entra", usuarios.entrar("beto", "senha-nova-do-beto") is not None)

    print("\n--- freio de tentativa ---")

    usuarios._tentativas.clear()
    for _ in range(usuarios.MAX_TENTATIVAS):
        usuarios.entrar("ana", "errada-de-proposito")
    try:
        usuarios.entrar("ana", "senha-da-ana-1")
        check("depois de N erros, freia mesmo com a senha certa", False,
              "(deixou entrar)")
    except PermissionError:
        check("depois de N erros, freia mesmo com a senha certa", True)

    # O freio é por login: travar a Ana não pode travar o Beto.
    check("o freio de um login não trava outro",
          usuarios.entrar("beto", "senha-nova-do-beto") is not None)

    usuarios._tentativas.clear()
    check("e solta quando a espera passa",
          usuarios.entrar("ana", "senha-da-ana-1") is not None)

    print("\n--- o primeiro admin ---")

    # Já existe gente: a variável de ambiente não pode virar porta permanente.
    os.environ["ADMIN_LOGIN"] = "invasor"
    os.environ["ADMIN_SENHA"] = "senha-do-invasor"
    check("não semeia admin quando já existe conta",
          usuarios.semear_admin() is None)

    print("\n--- apagar conta ---")

    _, t_beto, _ = usuarios.entrar("beto", "senha-nova-do-beto")
    check("apagar a conta funciona", usuarios.apagar(beto["id"]))
    check("e derruba as sessões dela", usuarios.da_sessao(t_beto) is None)
    check("apagar de novo não é erro, é False", not usuarios.apagar(beto["id"]))

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
