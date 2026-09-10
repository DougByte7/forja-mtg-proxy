"""
Contas e sessões. Login OPCIONAL e ADITIVO.

O QUE ISTO NÃO MUDA. O sistema inteiro é "quem tem o id, mexe" (ver
`decks.py` e `main.cancel_order`), e continua sendo. Ninguém precisa de conta
pra montar deck, abrir um link compartilhado ou fazer pedido — quem não entra
usa o site exatamente como antes desta tabela existir. Entrar acrescenta duas
coisas e só: o deck ou pedido passa a ter DONO, e a pessoa passa a poder
perguntar "quais são os meus" sem depender do `localStorage` daquele
navegador.

A REGRA DE AUTORIZAÇÃO, que mora no `main._pode_mexer`:

* deck/pedido SEM dono -> qualquer um mexe, inclusive anônimo. É o sistema
  de sempre.
* COM dono -> só o dono e o admin gravam ou apagam. O link continua ABRINDO
  pra qualquer um, porque compartilhar deck é a razão de o link existir.

Ou seja: reclamar um órfão não tira de ninguém nada que a pessoa tivesse.
Antes da reclamação qualquer um com o id já podia reescrever aquele deck;
depois, menos gente pode. A reclamação REDUZ o conjunto de quem edita, e é
por isso que ela pode ser primeiro-a-chegar sem virar um problema.

SEM DEPENDÊNCIA NOVA. Senha é `hashlib.pbkdf2_hmac` da biblioteca padrão —
o mesmo algoritmo que o Django usa —, comparação com `hmac.compare_digest`,
token de sessão com `secrets`. É a mesma regra do `pix.py`, que monta o BR
Code à mão, e do `tinta.py`, que monta IPP à mão: dependência nova só quando
não dá pra fazer direito sem ela, e aqui dá.

SESSÃO EM TABELA, NÃO EM COOKIE ASSINADO. Cookie assinado não se revoga, e
"sair de todos os aparelhos" é o que se pede justamente no dia em que se
desconfia de alguma coisa. Além disso a chave de assinatura teria que ser o
`ADMIN_TOKEN`, que também assina os links de impressão do e-mail
(`fulfillment._token`) — rotacioná-lo derrubaria os dois de uma vez. O banco
já está aberto e a tabela tem meia dúzia de linhas num sistema de grupo de
jogo.

O token vai pro banco em SHA-256, pelo mesmo motivo da senha: um dump do
arquivo não pode ser um maço de sessões vivas.
"""
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
import uuid

from . import log

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")

# Meio segundo por login numa máquina de hoje. É esse meio segundo que é o
# freio de força bruta: não é lentidão, é o produto.
ITERACOES = int(os.environ.get("SENHA_ITERACOES", "600000"))
TAMANHO_MINIMO_SENHA = int(os.environ.get("SENHA_MINIMA", "8"))

# Quanto tempo uma sessão vale. Duas durações: a normal, pra quem entra num
# computador emprestado, e a de quem marcou "lembrar de mim" — o celular do
# operador, onde digitar senha toda vez é o que faria a tela deixar de ser
# usada. É a mesma escolha que o `admin.html` já fazia com o token.
SESSAO_HORAS = float(os.environ.get("SESSAO_HORAS", "12"))
SESSAO_DIAS_LEMBRAR = float(os.environ.get("SESSAO_DIAS", "60"))

PERFIS = ("admin", "cliente")

# Freio de tentativa, em memória. Não vai pro banco de propósito: reiniciar o
# processo limpar o freio é aceitável (quem reinicia o container é o dono), e
# gravar cada senha errada num arquivo daria a quem lê o banco um mapa de
# quais logins existem.
MAX_TENTATIVAS = int(os.environ.get("LOGIN_TENTATIVAS", "5"))
ESPERA_SEGUNDOS = float(os.environ.get("LOGIN_ESPERA", "30"))
_tentativas: dict[str, list] = {}     # chave -> [quantas, quando_libera]
_trava = threading.Lock()


class SenhaFraca(ValueError):
    """Senha curta demais. Separada de `ValueError` cru pra a rota poder
    devolver 400 com a mensagem certa sem adivinhar pelo texto."""


def _conn():
    pasta = os.path.dirname(DB_PATH)
    if pasta:
        os.makedirs(pasta, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Cria as duas tabelas. Mesmo arquivo dos pedidos e dos decks: um
    arquivo, um backup."""
    conn = _conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                id TEXT PRIMARY KEY,
                login TEXT UNIQUE,
                nome TEXT,
                senha TEXT,
                perfil TEXT,
                criado_em REAL,
                ultimo_acesso REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessoes (
                token TEXT PRIMARY KEY,
                usuario_id TEXT,
                criado_em REAL,
                expira_em REAL,
                visto_em REAL,
                agente TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessoes_usuario "
                     "ON sessoes(usuario_id)")
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Senha
# ---------------------------------------------------------------------------

def cifrar(senha: str) -> str:
    """A senha do jeito que vai pro banco: pbkdf2-sha256, sal por usuário.

    O número de iterações vai GUARDADO na string, e não lido da constante na
    hora de conferir. É isso que permite subir o teto amanhã sem invalidar
    senha nenhuma: a antiga continua conferindo com o número dela, e só é
    recifrada quando a pessoa troca a senha.
    """
    senha = str(senha or "")
    if len(senha) < TAMANHO_MINIMO_SENHA:
        raise SenhaFraca(
            f"A senha precisa de pelo menos {TAMANHO_MINIMO_SENHA} caracteres.")
    sal = secrets.token_bytes(16)
    bruto = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), sal, ITERACOES)
    return f"pbkdf2_sha256${ITERACOES}${sal.hex()}${bruto.hex()}"


def confere(senha: str, guardado: str) -> bool:
    """Se a senha bate com o que está no banco.

    `hmac.compare_digest` e não `==`: uma comparação que sai no primeiro byte
    diferente conta quanto tempo levou, e isso basta pra adivinhar o hash byte
    a byte. Nunca levanta — formato estragado no banco é `False`, porque a
    resposta certa pra "não consigo conferir" é "não entrou".
    """
    try:
        algoritmo, iteracoes, sal, esperado = str(guardado or "").split("$")
        if algoritmo != "pbkdf2_sha256":
            return False
        bruto = hashlib.pbkdf2_hmac("sha256", str(senha or "").encode("utf-8"),
                                    bytes.fromhex(sal), int(iteracoes))
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(bruto.hex(), esperado)


def achatar_login(bruto) -> str:
    """O login normalizado: minúsculo e sem espaço nas pontas.

    Achatado na ENTRADA e guardado achatado, e não achatado na hora de
    comparar: assim o `UNIQUE` da coluna faz o trabalho de impedir "Fulano" e
    "fulano" como duas contas, em vez de a gente lembrar de comparar direito
    em cada consulta.
    """
    return str(bruto or "").strip().lower()


# ---------------------------------------------------------------------------
# Contas
# ---------------------------------------------------------------------------

def _publico(linha) -> dict:
    """A conta do jeito que pode sair daqui.

    É o ÚNICO caminho de saída do módulo, e ele não copia a coluna `senha`.
    Devolver a linha crua funcionaria hoje e vazaria o hash no dia em que
    alguém acrescentasse um `return dict(linha)` numa rota nova.
    """
    return {
        "id": linha["id"],
        "login": linha["login"],
        "nome": linha["nome"] or linha["login"],
        "perfil": linha["perfil"],
        "criado_em": linha["criado_em"],
        "ultimo_acesso": linha["ultimo_acesso"],
    }


def criar(login: str, senha: str, nome: str = "", perfil: str = "cliente") -> dict:
    """Cria uma conta. Levanta `ValueError` com a razão em português."""
    login = achatar_login(login)
    if not login:
        raise ValueError("Falta o login.")
    if perfil not in PERFIS:
        raise ValueError(f"Perfil tem que ser um de: {', '.join(PERFIS)}.")
    cifrada = cifrar(senha)          # levanta SenhaFraca antes de tocar no banco

    agora = time.time()
    conn = _conn()
    try:
        try:
            conn.execute(
                "INSERT INTO usuarios (id, login, nome, senha, perfil, "
                "criado_em, ultimo_acesso) VALUES (?,?,?,?,?,?,NULL)",
                (uuid.uuid4().hex[:12], login, (nome or "").strip() or login,
                 cifrada, perfil, agora))
        except sqlite3.IntegrityError:
            raise ValueError(f"Já existe uma conta com o login “{login}”.")
        conn.commit()
        linha = conn.execute("SELECT * FROM usuarios WHERE login=?",
                             (login,)).fetchone()
    finally:
        conn.close()
    log.evento("usuarios", "criou", login=login, perfil=perfil)
    return _publico(linha)


def por_id(usuario_id: str) -> dict | None:
    conn = _conn()
    try:
        linha = conn.execute("SELECT * FROM usuarios WHERE id=?",
                             (usuario_id,)).fetchone()
    finally:
        conn.close()
    return _publico(linha) if linha else None


def listar() -> list[dict]:
    conn = _conn()
    try:
        linhas = conn.execute(
            "SELECT * FROM usuarios ORDER BY criado_em ASC").fetchall()
    finally:
        conn.close()
    return [_publico(l) for l in linhas]


def contar() -> int:
    conn = _conn()
    try:
        return conn.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0]
    finally:
        conn.close()


def trocar_senha(usuario_id: str, nova: str) -> bool:
    cifrada = cifrar(nova)
    conn = _conn()
    try:
        cur = conn.execute("UPDATE usuarios SET senha=? WHERE id=?",
                           (cifrada, usuario_id))
        conn.commit()
    finally:
        conn.close()
    if cur.rowcount:
        # Trocar senha derruba as outras sessões. É o que se espera de trocar
        # senha, e é a única forma de a troca servir pra alguma coisa quando o
        # motivo dela foi desconfiança.
        encerrar_todas(usuario_id)
        log.evento("usuarios", "trocou-senha", usuario=usuario_id)
    return bool(cur.rowcount)


def apagar(usuario_id: str) -> bool:
    conn = _conn()
    try:
        cur = conn.execute("DELETE FROM usuarios WHERE id=?", (usuario_id,))
        conn.execute("DELETE FROM sessoes WHERE usuario_id=?", (usuario_id,))
        conn.commit()
    finally:
        conn.close()
    return bool(cur.rowcount)


# ---------------------------------------------------------------------------
# Freio de tentativa
# ---------------------------------------------------------------------------

def _freado(chave: str) -> float:
    """Quantos segundos faltam pra esta chave poder tentar de novo. 0 = pode."""
    with _trava:
        registro = _tentativas.get(chave)
        if not registro:
            return 0.0
        return max(0.0, registro[1] - time.time())


def _errou(chave: str) -> None:
    with _trava:
        registro = _tentativas.setdefault(chave, [0, 0.0])
        registro[0] += 1
        if registro[0] >= MAX_TENTATIVAS:
            registro[0] = 0
            registro[1] = time.time() + ESPERA_SEGUNDOS


def _acertou(chave: str) -> None:
    with _trava:
        _tentativas.pop(chave, None)


# ---------------------------------------------------------------------------
# Sessões
# ---------------------------------------------------------------------------

def _achatar_token(token: str) -> str:
    """O que vai pro banco. SHA-256 simples e não pbkdf2 de propósito: o token
    são 32 bytes de `secrets`, não uma senha escolhida por gente — não há o
    que adivinhar, então não há por que pagar 600 mil iterações a cada
    requisição autenticada do site."""
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def entrar(login: str, senha: str, lembrar: bool = False,
           agente: str = "") -> tuple[dict, str, int] | None:
    """Confere a senha e abre uma sessão.

    Devolve `(usuario, token_cru, duracao_em_segundos)` ou `None` quando não
    entra. UM `None` pra os dois casos — login que não existe e senha errada —
    de propósito: respostas diferentes transformam a tela de login num
    conferidor de quais contas existem.

    Levanta `PermissionError` quando o freio está ligado, que é o único caso
    em que a tela tem algo de útil a dizer além de "não deu".
    """
    login = achatar_login(login)
    espera = _freado(login)
    if espera:
        raise PermissionError(
            f"Muitas tentativas. Tente de novo em {int(espera) + 1} segundos.")

    conn = _conn()
    try:
        linha = conn.execute("SELECT * FROM usuarios WHERE login=?",
                             (login,)).fetchone()
    finally:
        conn.close()

    if linha is None or not confere(senha, linha["senha"]):
        _errou(login)
        log.aviso("usuarios", "login-recusado", login=login or "(vazio)")
        return None
    _acertou(login)

    duracao = int((SESSAO_DIAS_LEMBRAR * 86400) if lembrar
                  else (SESSAO_HORAS * 3600))
    token = secrets.token_urlsafe(32)
    agora = time.time()
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO sessoes (token, usuario_id, criado_em, expira_em, "
            "visto_em, agente) VALUES (?,?,?,?,?,?)",
            (_achatar_token(token), linha["id"], agora, agora + duracao, agora,
             (agente or "")[:200]))
        conn.execute("UPDATE usuarios SET ultimo_acesso=? WHERE id=?",
                     (agora, linha["id"]))
        conn.commit()
    finally:
        conn.close()
    log.evento("usuarios", "entrou", login=login, lembrar=bool(lembrar))
    return _publico(linha), token, duracao


def da_sessao(token: str) -> dict | None:
    """Quem é o dono deste token, ou None. Nunca levanta.

    `None` NÃO é erro aqui: é o anônimo, que é um estado de primeira classe
    neste sistema. Quem chama decide se isso importa.
    """
    if not token:
        return None
    conn = _conn()
    try:
        linha = conn.execute(
            "SELECT u.*, s.expira_em AS _expira FROM sessoes s "
            "JOIN usuarios u ON u.id = s.usuario_id WHERE s.token=?",
            (_achatar_token(token),)).fetchone()
        if linha is None:
            return None
        if linha["_expira"] and linha["_expira"] < time.time():
            # Vencida: apaga na hora em vez de esperar a faxina. A linha já
            # está na mão, e deixá-la é dar sobrevida a um token que alguém
            # pode ter copiado.
            conn.execute("DELETE FROM sessoes WHERE token=?",
                         (_achatar_token(token),))
            conn.commit()
            return None
        conn.execute("UPDATE sessoes SET visto_em=? WHERE token=?",
                     (time.time(), _achatar_token(token)))
        conn.commit()
    except sqlite3.Error as e:
        # Banco sem as tabelas (deploy no meio da migração) não pode derrubar
        # o site inteiro: sem sessão legível, todo mundo é anônimo — que é
        # exatamente como o sistema funcionava antes deste módulo.
        log.aviso("usuarios", "sessao-ilegivel", motivo=f"{type(e).__name__}: {e}")
        return None
    finally:
        conn.close()
    return _publico(linha)


def sair(token: str) -> bool:
    if not token:
        return False
    conn = _conn()
    try:
        cur = conn.execute("DELETE FROM sessoes WHERE token=?",
                           (_achatar_token(token),))
        conn.commit()
    finally:
        conn.close()
    return bool(cur.rowcount)


def encerrar_todas(usuario_id: str) -> int:
    conn = _conn()
    try:
        cur = conn.execute("DELETE FROM sessoes WHERE usuario_id=?",
                           (usuario_id,))
        conn.commit()
    finally:
        conn.close()
    return cur.rowcount


def podar_sessoes() -> int:
    """Apaga as sessões vencidas. Chamada pela faxina diária."""
    conn = _conn()
    try:
        cur = conn.execute("DELETE FROM sessoes WHERE expira_em < ?",
                           (time.time(),))
        conn.commit()
    finally:
        conn.close()
    if cur.rowcount:
        log.evento("usuarios", "podou-sessoes", quantas=cur.rowcount)
    return cur.rowcount


# ---------------------------------------------------------------------------
# O primeiro admin
# ---------------------------------------------------------------------------

def semear_admin() -> dict | None:
    """Cria o admin do `.env`, e SÓ se não existir conta nenhuma.

    Um deploy novo começa com a tabela vazia, e sem isso não haveria como
    entrar pra criar a primeira conta. A condição "tabela vazia" é o que
    impede a variável de ambiente de virar uma porta permanente: depois que
    existe gente, mudar `ADMIN_LOGIN` no `.env` não cria nada.

    Não é obrigatório. Sem `ADMIN_LOGIN`/`ADMIN_SENHA` o sistema sobe sem
    conta nenhuma, e o `ADMIN_TOKEN` continua abrindo o painel — que é como
    ele já funcionava antes deste módulo.
    """
    login = achatar_login(os.environ.get("ADMIN_LOGIN", ""))
    senha = os.environ.get("ADMIN_SENHA", "")
    if not login or not senha or contar():
        return None
    try:
        return criar(login, senha, nome=os.environ.get("ADMIN_NOME", ""),
                     perfil="admin")
    except ValueError as e:
        log.aviso("usuarios", "admin-nao-semeado", motivo=str(e))
        return None
