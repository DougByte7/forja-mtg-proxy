"""
Contas de mentira pros testes: tokens do Clerk assinados com uma chave gerada
aqui, sem rede e sem conta no Clerk.

IMPORTE ANTES DO APP. A chave pública vai pro `CLERK_JWT_KEY` no import deste
módulo, e o `app.clerk` a lê uma vez só, no import dele:

    import conta_clerk            # antes de `from app.main import app`
    from app.main import app
    ana = conta_clerk.cliente(app, "ana", perfil="amigo")

O `id` da conta é o `sub` (ou o `forja_id`, se vier — o das contas
importadas). Sem `azp` no token, a conferência de origem não entra.
"""
import os
import time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

CHAVE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLICA = CHAVE.public_key().public_bytes(
    serialization.Encoding.PEM,
    serialization.PublicFormat.SubjectPublicKeyInfo).decode()

os.environ["CLERK_JWT_KEY"] = PUBLICA


def token(sub: str, perfil: str | None = None, nome: str | None = None,
          chave=CHAVE, **extra) -> str:
    """Um token de sessão como o Clerk emite, com as claims do template do
    painel (`role`, `email`, `name`; `forja_id` vai em `extra`). Claim com
    valor None fica de fora."""
    agora = int(time.time())
    claims = {"sub": sub, "iat": agora, "nbf": agora - 1, "exp": agora + 3600,
              "email": f"{sub}@exemplo.com", "name": nome or sub.title(),
              "role": perfil, **extra}
    return jwt.encode({k: v for k, v in claims.items() if v is not None},
                      chave, algorithm="RS256")


def cliente(app, sub: str, perfil: str | None = None, **extra):
    """Um TestClient que manda o token desta conta em toda requisição."""
    from fastapi.testclient import TestClient
    c = TestClient(app)
    c.headers["Authorization"] = f"Bearer {token(sub, perfil, **extra)}"
    return c
