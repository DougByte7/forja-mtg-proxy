"""
Confere o `User-Agent` com que este backend se apresenta a sites de fora.

Motivo de existir: o e-mail de contato NÃO pode voltar pro código. Quem
clonar o projeto não pode sair batendo na LigaMagic e na Scryfall com o
e-mail de outra pessoa no cabeçalho — e a promessa que o README faz ("o
User-Agent identifica o projeto e um contato de verdade") só vale se o
endereço realmente vier do .env de quem está rodando.

Também trava o caso do .env vazio: aí o UA sai sem e-mail, mas ainda
dizendo o que é — a Scryfall exige um UA identificável, e mandar string
vazia quebraria a regra deles.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_identidade.py

Sai com código 1 se qualquer checagem falhar.
"""
import importlib
import os
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

import app  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


MODULOS = ("app.notify", "app.identidade", "app.ligamagic", "app.scryfall")
LIMPAR = ("SMTP_USER", "NOTIFY_TO", "LIGAMAGIC_USER_AGENT",
          "SCRYFALL_USER_AGENT", "FORJA_PROJETO")


def recarregar(**env):
    """Reimporta os módulos com o ambiente pedido e devolve (liga_ua, scry_ua).

    Tirar do `sys.modules` não basta: `from . import identidade` acha o
    atributo velho no pacote `app` antes de tentar importar de novo, e o
    teste passaria lendo o módulo da rodada anterior.
    """
    for k in LIMPAR:
        os.environ.pop(k, None)
    os.environ.update(env)
    for m in MODULOS:
        sys.modules.pop(m, None)
        curto = m.split(".")[1]
        if hasattr(app, curto):
            delattr(app, curto)
    liga = importlib.import_module("app.ligamagic")
    scry = importlib.import_module("app.scryfall")
    return liga.USER_AGENT, scry.USER_AGENT


guardado = {k: os.environ.get(k) for k in LIMPAR}
try:
    liga, scry = recarregar(SMTP_USER="fulano@exemplo.com",
                            NOTIFY_TO="outro@exemplo.com")
    eq("SMTP_USER vira o contato do User-Agent",
       liga, "ForjaDeProxies/1.0 (cotador de deck; contato: fulano@exemplo.com)")
    eq("as duas fontes se apresentam igual", scry, liga)

    # Quem manda de uma conta de serviço e lê em outra cai aqui.
    liga, scry = recarregar(NOTIFY_TO="reserva@exemplo.com")
    check("sem SMTP_USER, o contato vem do NOTIFY_TO",
          "reserva@exemplo.com" in liga and "reserva@exemplo.com" in scry)

    # .env vazio: sem e-mail, mas ainda identificável — a Scryfall exige isso.
    liga, scry = recarregar()
    eq("sem e-mail nenhum, o UA ainda diz o que é",
       liga, "ForjaDeProxies/1.0 (cotador de deck)")
    check("e não sobra '@' solto no cabeçalho", "@" not in liga and "@" not in scry)
    check("nem a palavra 'None'", "None" not in liga and "None" not in scry)

    # O override completo continua ganhando de tudo.
    liga, scry = recarregar(SMTP_USER="fulano@exemplo.com",
                            LIGAMAGIC_USER_AGENT="MeuBot/9.9 (oi)")
    eq("LIGAMAGIC_USER_AGENT sobrescreve", liga, "MeuBot/9.9 (oi)")
    check("e não vaza pra Scryfall", "fulano@exemplo.com" in scry)

    liga, _ = recarregar(SMTP_USER="a@b.com", FORJA_PROJETO="Forja/2.0")
    eq("FORJA_PROJETO troca o nome do projeto",
       liga, "Forja/2.0 (cotador de deck; contato: a@b.com)")

    # O que motivou tudo isto: nenhum e-mail escrito no código.
    for arquivo in ("app/identidade.py", "app/ligamagic.py", "app/scryfall.py"):
        texto = (RAIZ / arquivo).read_text(encoding="utf-8")
        # Um e-mail hardcoded apareceria como algo@algo.tld em texto solto.
        import re
        achados = re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", texto)
        # `exemplo.com` só aparece em comentário/documentação, nunca em valor.
        reais = [a for a in achados if not a.endswith(("exemplo.com", "exemplo.com.br"))]
        check(f"{arquivo} não tem e-mail escrito no código", not reais,
              f"({reais})" if reais else "")
finally:
    for k, v in guardado.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
