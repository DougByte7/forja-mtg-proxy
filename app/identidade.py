"""
Como este backend se identifica quando fala com sites de fora.

Existe por um motivo prático: tanto a LigaMagic quanto a Scryfall precisam
saber quem está batendo. A Scryfall EXIGE um `User-Agent` identificável (é
regra deles), e na LigaMagic a gente já está lendo o que eles preferiam que
não fosse lido por robô — passar como navegador anônimo seria pior ainda.
Se eles quiserem falar com a gente, ou bloquear, que seja pelo caminho fácil.

O endereço de contato NÃO fica escrito no código: sai do `.env`, do mesmo
`SMTP_USER`/`NOTIFY_TO` que o `notify.py` já usa pra mandar o aviso de
pagamento. Assim quem clonar o projeto não sai batendo em site nenhum com o
e-mail de outra pessoa no cabeçalho.
"""
import os

from .notify import NOTIFY_TO, SMTP_USER

PROJETO = os.environ.get("FORJA_PROJETO", "ForjaDeProxies/1.0")

_ja_avisou = False


def contato() -> str:
    """E-mail de quem toca este sistema, ou string vazia se não configurado.

    `SMTP_USER` na frente porque é a caixa que comprovadamente existe (tem
    senha de app e faz login de verdade); `NOTIFY_TO` como reserva pra quem
    manda de uma conta de serviço e lê em outra.
    """
    return (SMTP_USER or NOTIFY_TO or "").strip()


def user_agent(componente: str) -> str:
    """`User-Agent` completo, com contato quando houver um configurado.

    Sem `.env` preenchido ainda sai um UA que diz o que é e o que está
    fazendo — o que já atende a exigência da Scryfall —, só sem o e-mail.
    Avisa uma vez no log, porque rodar o cotador sem endereço de contato é
    justamente o que a gente diz no README que não faz.
    """
    global _ja_avisou
    email = contato()
    if email:
        return f"{PROJETO} ({componente}; contato: {email})"
    if not _ja_avisou:
        _ja_avisou = True
        print("[identidade] SMTP_USER/NOTIFY_TO vazios no .env — as consultas "
              "de preço vão sair sem e-mail de contato no User-Agent.")
    return f"{PROJETO} ({componente})"
