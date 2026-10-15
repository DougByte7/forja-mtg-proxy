"""
Conta pelo Clerk.

O Clerk cuida de tudo que é tela e e-mail: cadastro, confirmação do e-mail,
"esqueci a senha", login com Google, freio de bot. O que sobra pra cá é
responder "quem é este token?" — e o resto do sistema (dono de deck e de
pedido, `_pode_mexer`, `_check_admin`) continua lendo o mesmo dicionário que
o `usuarios.da_sessao` sempre devolveu.

CONFERÊNCIA SEM REDE. O token de sessão é um JWT RS256 que o `clerk-js` do
navegador renova a cada minuto. Conferir é matemática com a chave PÚBLICA da
instância (`CLERK_JWT_KEY`, o "JWKS Public Key" da página de API keys do
painel): nenhuma ida ao Clerk nem ao banco por requisição. Sem a chave, o
Clerk fica desligado e todo token é ignorado — o sistema segue com a sessão
própria, como antes.

O QUE O TOKEN TRAZ. Além do padrão (`sub`, `exp`, `nbf`, `azp`...), o token
é personalizado no painel (Sessions → Customize session token) pra trazer:

    {"role": "{{user.public_metadata.role}}",
     "forja_id": "{{user.public_metadata.forja_id}}",
     "email": "{{user.primary_email_address}}",
     "name": "{{user.first_name}}"}

`name` é só o primeiro nome, e não o `full_name`: na importação o nome de
usuário antigo foi pro First name, e o login pelo Google acrescenta o
sobrenome — com `full_name` a pessoa deixaria de ver o nome que escolheu.

`forja_id` é o id que a conta tinha antes do Clerk (ver `importar`): é ele
que continua sendo o `dono` nos decks e pedidos já gravados, e é por isso que
nenhuma coluna precisou mudar. Conta nascida no Clerk não tem, e o id dela é
o `sub` (`user_...`).

`role` vem do `public_metadata`, que só o painel e a API de backend escrevem —
a pessoa não consegue se promover pelo navegador. Valor fora dos perfis
conhecidos vale como `cliente`.
"""
import json
import os
import re
import time

import requests

from . import log
from .usuarios import PERFIS

try:
    import jwt
    from cryptography.hazmat.primitives import serialization
except ImportError:          # homelab sem a dependência: Clerk desligado
    jwt = None

API = "https://api.clerk.com/v1"

_PEM = re.compile(r"-----BEGIN ([A-Z ]+)-----(.*?)-----END \1-----", re.S)


def carregar_chave(bruto: str):
    """A `CLERK_JWT_KEY` lida: `(chave, None)` ou `(None, porquê)`.

    Aceita o PEM do jeito que ele costuma chegar depois de copiado e colado:
    com quebras de linha, com `\\n` escrito (.env de uma linha), com as
    quebras viradas espaço (campo de uma linha da Vercel), entre aspas, ou só
    o miolo base64 sem as linhas BEGIN/END. Aceita também o JWKS em JSON (o
    `/.well-known/jwks.json` da instância). Lida UMA vez, no import: chave
    estragada é configuração errada, e o porquê vai pro `conferir`.
    """
    texto = (bruto or "").strip().strip("'\"").replace("\\n", "\n").strip()
    if not texto:
        return None, "sem CLERK_JWT_KEY no servidor"
    if jwt is None:
        return None, "PyJWT não instalado"
    if re.match(r"^(pk|sk)_(test|live)_", texto):
        # O engano mais fácil: as API keys moram na mesma página do painel.
        return None, ("CLERK_JWT_KEY tem uma API key do Clerk (pk_/sk_...), não "
                      "a chave pública JWKS: copie o \"JWKS Public Key\" (PEM, "
                      "começa com -----BEGIN PUBLIC KEY-----) da página API keys")
    try:
        if texto.startswith("{"):
            dados = json.loads(texto)
            jwk = (jwt.PyJWKSet.from_dict(dados).keys[0] if "keys" in dados
                   else jwt.PyJWK.from_dict(dados))
            return jwk.key, None
        achado = _PEM.search(texto)
        rotulo, miolo = (achado.group(1), achado.group(2)) if achado \
            else ("PUBLIC KEY", texto)
        miolo = re.sub(r"\s+", "", miolo)
        pem = (f"-----BEGIN {rotulo}-----\n"
               + "\n".join(miolo[i:i + 64] for i in range(0, len(miolo), 64))
               + f"\n-----END {rotulo}-----\n")
        return serialization.load_pem_public_key(pem.encode()), None
    except Exception as e:
        # Sem mostrar a chave: só a forma dela, que é o que se precisa pra
        # achar o erro de cópia.
        forma = ("JSON" if texto.startswith("{") else
                 "PEM com BEGIN/END" if "-----BEGIN" in texto else
                 "sem as linhas BEGIN/END")
        return None, (f"CLERK_JWT_KEY não é uma chave pública válida "
                      f"({forma}, {len(texto)} caracteres): "
                      f"{type(e).__name__}: {e}")


_CHAVE, _ERRO_CHAVE = carregar_chave(os.environ.get("CLERK_JWT_KEY", ""))

# As URLs que a própria Vercel diz que são deste deploy (variáveis de sistema,
# sem "https://"): a do deploy, a da branch e a de produção. Entram sozinhas
# porque o endereço `*.vercel.app` muda a cada prévia — e esquecer uma delas
# é o "entrei e o site não me reconhece".
_VERCEL_URLS = ("VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL")


def origens_permitidas(env=os.environ) -> set[str]:
    """`CLERK_ORIGENS`, se existir; senão `PUBLIC_BASE_URL` e
    `LOCAL_BASE_URL`. Nos dois casos, mais as URLs da Vercel. Vazio (fora da
    Vercel, sem nada configurado) pula a conferência — o cookie é
    SameSite=Lax e o cabeçalho não sai de outra origem sozinho."""
    base = (env.get("CLERK_ORIGENS", "").strip()
            or ",".join(filter(None, [env.get("PUBLIC_BASE_URL", ""),
                                      env.get("LOCAL_BASE_URL", "")])))
    origens = {o.strip().rstrip("/") for o in base.split(",") if o.strip()}
    origens |= {f"https://{env[v].strip().rstrip('/')}" for v in _VERCEL_URLS
                if env.get(v, "").strip()}
    return origens


# Quem pode ter pedido o token (`azp`): as origens das nossas telas. Sem isto,
# um token emitido pra outro site da mesma instância valeria aqui.
_ORIGENS = origens_permitidas()

# Folga pra relógio torto entre o Clerk e a função. O token vive um minuto;
# cinco segundos não estendem nada que importe.
FOLGA_SEGUNDOS = 5


def ligado() -> bool:
    return _CHAVE is not None


def token_do_pedido(authorization: str | None, cookie: str | None) -> str:
    """O token, de onde ele vier. O cabeçalho primeiro: é o que o front manda
    com o token recém-renovado; o cookie `__session` pode estar com alguns
    segundos de atraso quando a aba volta do segundo plano."""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return cookie or ""


def usuario(token: str) -> dict | None:
    """Quem é o dono deste token, no formato do `usuarios._publico`, ou None.

    Nunca levanta: token vencido, assinado por outra chave, de outra origem
    ou malformado é anônimo — a mesma resposta do `usuarios.da_sessao` pra
    sessão que não existe. O porquê sai no `conferir`.
    """
    return conferir(token)[0]


def conferir(token: str) -> tuple[dict | None, str | None]:
    """`(usuario, None)` ou `(None, motivo)` — o motivo em texto curto, pra
    log e pro `GET /conta`. Sem token, `(None, None)`: anônimo de verdade não
    tem o que explicar.

    Token recusado vira AVISO no log, e não debug: quem manda token acha que
    entrou, e "o site não me reconhece" sem rastro nenhum é o pior defeito
    de investigar (aconteceu na virada).
    """
    if not token:
        return None, None
    if not ligado():
        log.aviso("clerk", "desligado", motivo=_ERRO_CHAVE)
        return None, _ERRO_CHAVE
    try:
        claims = jwt.decode(
            token, _CHAVE, algorithms=["RS256"], leeway=FOLGA_SEGUNDOS,
            options={"require": ["exp", "nbf", "sub"]})
    except jwt.PyJWTError as e:
        motivo = f"token recusado: {type(e).__name__}: {e}"
        log.aviso("clerk", "token-recusado", motivo=motivo)
        return None, motivo
    azp = str(claims.get("azp") or "").rstrip("/")
    if _ORIGENS and azp and azp not in _ORIGENS:
        motivo = (f"origem {azp} fora de CLERK_ORIGENS "
                  f"({', '.join(sorted(_ORIGENS))})")
        log.aviso("clerk", "origem-recusada", motivo=motivo)
        return None, motivo
    # `pending` é sessão que ainda deve um passo (ex.: escolher organização).
    # Não usamos organizações, mas a regra é do Clerk: não vale como entrada.
    if claims.get("sts") == "pending":
        return None, "sessão pendente no Clerk"
    return _do_token(claims), None


def _do_token(claims: dict) -> dict:
    email = str(claims.get("email") or "").strip().lower()
    perfil = claims.get("role")
    return {
        "id": str(claims.get("forja_id") or claims["sub"]),
        "login": email or claims["sub"],
        "nome": str(claims.get("name") or "").strip() or email or "Sem nome",
        "perfil": perfil if perfil in PERFIS else "cliente",
        "criado_em": None,
        "ultimo_acesso": None,
        "clerk_id": claims["sub"],
    }


# ---------------------------------------------------------------------------
# Importação das contas antigas
# ---------------------------------------------------------------------------

def _papel_importado(perfil: str) -> str:
    """Admin continua admin. Todo `cliente` de antes entrou com o convite do
    grupo — é exatamente quem o perfil `amigo` descreve."""
    return "admin" if perfil == "admin" else "amigo"


def importar(contas: list[dict], aplicar: bool = False,
             chave: str | None = None, sessao=None) -> dict:
    """Cria no Clerk as contas da tabela `usuarios`. Sem `aplicar`, só diz o
    que faria.

    Cada conta vai SEM senha (`skip_password_requirement`): o hash daqui não
    está num formato que o Clerk confira, e a pessoa entra pelo Google com o
    mesmo e-mail ou pelo "esqueci a senha". O e-mail vai como verificado — já
    era o login da pessoa aqui. `external_id` e `forja_id` levam o id de
    antes, que é o `dono` dos decks e pedidos dela.

    Pode rodar de novo: conta cujo `external_id` já existe no Clerk é pulada.
    Login que não é e-mail (conta criada pelo admin) não tem como ir e volta
    em `sem_email`, pra decidir na mão.
    """
    chave = chave or os.environ.get("CLERK_SECRET_KEY", "")
    if not chave:
        raise RuntimeError("Falta a CLERK_SECRET_KEY no ambiente.")
    http = sessao or requests.Session()
    http.headers.update({"Authorization": f"Bearer {chave}"})

    resultado = {"criadas": [], "ja_existiam": [], "sem_email": [],
                 "falharam": []}
    for conta in contas:
        login = conta["login"]
        if "@" not in login:
            resultado["sem_email"].append(login)
            continue
        r = http.get(f"{API}/users", params={"external_id": conta["id"]},
                     timeout=20)
        r.raise_for_status()
        if r.json():
            resultado["ja_existiam"].append(login)
            continue
        papel = _papel_importado(conta["perfil"])
        if not aplicar:
            resultado["criadas"].append(f"{login} ({papel})")
            continue
        corpo = {
            "external_id": conta["id"],
            "email_address": [login],
            "first_name": conta["nome"] or None,
            "public_metadata": {"role": papel, "forja_id": conta["id"]},
            "skip_password_requirement": True,
            "skip_legal_checks": True,
        }
        if conta.get("criado_em"):
            corpo["created_at"] = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(conta["criado_em"]))
        r = http.post(f"{API}/users", json=corpo, timeout=20)
        if r.ok:
            resultado["criadas"].append(f"{login} ({papel})")
        else:
            resultado["falharam"].append(f"{login}: {r.status_code} {r.text[:200]}")
    log.evento("clerk", "importou" if aplicar else "simulou-importacao",
               **{k: len(v) for k, v in resultado.items()})
    return resultado
