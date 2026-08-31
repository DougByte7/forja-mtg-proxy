"""
Confere o cache de ofertas por carta.

Motivo de existir: cada carta nova custa uma requisição à LigaMagic, num
site que pede pra gente não fazer isso (veja `ligamagic.py`). Um cache que
erra o alvo — que não acha o que guardou, ou que devolve o que já venceu —
vira acesso a mais lá. E um cache que EXPLODE (arquivo corrompido, disco
cheio) não pode derrubar a cotação junto.

O cache é por CARTA, não por deck: trocar uma carta da lista não pode jogar
fora o trabalho das outras.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_cache_precos.py

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

# O diretório é lido na importação do módulo, então tem que vir antes dele.
TMP = tempfile.mkdtemp(prefix="teste-cache-precos-")
os.environ["COTACAO_CACHE_DIR"] = TMP

from app import cache_precos  # noqa: E402
from app.cotacao import Oferta  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


try:
    OFERTAS = [
        Oferta(loja="Loja A", preco=7.81, condicao="NM", idioma="EN",
               edicao="Commander 2017", quantidade=4, link="http://x", extras=""),
        Oferta(loja="Loja B", preco=8.60, condicao="SP"),
    ]

    eq("carta nunca vista devolve None", cache_precos.ler("liga", "Sol Ring"), None)

    cache_precos.gravar("liga", "Sol Ring", OFERTAS)
    eq("o que entrou é o que sai", cache_precos.ler("liga", "Sol Ring"), OFERTAS)

    # Fonte é namespace: a Liga e a Scryfall guardam preços diferentes da
    # MESMA carta, e um não pode aparecer no lugar do outro.
    eq("fontes não se misturam", cache_precos.ler("scryfall", "Sol Ring"), None)
    cache_precos.gravar("scryfall", "Sol Ring", [Oferta(loja="TCG", preco=1.41)])
    eq("cada fonte guarda a sua",
       [o.loja for o in cache_precos.ler("liga", "Sol Ring")], ["Loja A", "Loja B"])
    eq("e a outra continua a dela",
       [o.loja for o in cache_precos.ler("scryfall", "Sol Ring")], ["TCG"])

    # Guardar por carta é o ponto: mexer numa não pode afetar as outras.
    cache_precos.gravar("liga", "Cultivate", [Oferta(loja="C", preco=2.97)])
    eq("guardar uma carta não mexe na outra",
       len(cache_precos.ler("liga", "Sol Ring")), 2)

    # "Não existe" também é resposta, e cacheá-la evita rebater no site a
    # cada cotação por causa de uma carta que ninguém tem.
    cache_precos.gravar("liga", "Carta Fantasma", [])
    eq("lista vazia é cache válido, não ausência",
       cache_precos.ler("liga", "Carta Fantasma"), [])

    # Nomes que dariam o mesmo arquivo se o saneamento fosse frouxo.
    cache_precos.gravar("liga", "Sensei's Divining Top", [Oferta(loja="X", preco=140.25)])
    eq("nome com apóstrofo vai e volta",
       cache_precos.ler("liga", "Sensei's Divining Top")[0].preco, 140.25)
    longo = "Secret Lair " + "x" * 300
    cache_precos.gravar("liga", longo, [Oferta(loja="Y", preco=1.0)])
    eq("nome absurdamente longo não estoura o sistema de arquivos",
       cache_precos.ler("liga", longo)[0].loja, "Y")

    # Vencido conta como ausente.
    caminho = cache_precos._caminho("liga", "Sol Ring")
    velho = time.time() - cache_precos.TTL - 60
    os.utime(caminho, (velho, velho))
    eq("cache vencido devolve None", cache_precos.ler("liga", "Sol Ring"), None)

    # Cache quebrado nunca derruba a cotação — devolve None e a busca refaz.
    with open(cache_precos._caminho("liga", "Cultivate"), "w") as f:
        f.write("{isso nao e json")
    eq("arquivo corrompido devolve None", cache_precos.ler("liga", "Cultivate"), None)

    with open(cache_precos._caminho("liga", "Formato Velho"), "w") as f:
        f.write('[{"campo_que_nao_existe_mais": 1}]')
    eq("formato antigo devolve None",
       cache_precos.ler("liga", "Formato Velho"), None)

    # Gravar num lugar impossível avisa no log e segue a vida.
    salvo = cache_precos.DIR
    try:
        cache_precos.DIR = "/proc/nao-da-pra-escrever-aqui"
        cache_precos.gravar("liga", "Qualquer", OFERTAS)
        check("falha ao gravar não levanta exceção", True)
    except Exception as e:
        check("falha ao gravar não levanta exceção", False, f"({e})")
    finally:
        cache_precos.DIR = salvo
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
