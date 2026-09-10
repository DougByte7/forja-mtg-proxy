"""
Confere as regras que só existem no navegador: categorias, sideboard e
maybeboard, do jeito que a tela do deckbuilder as aplica.

MOTIVO DE EXISTIR. Estas regras moram DUAS vezes — uma no `decks.py`, que
grava e valida, e outra no JavaScript da tela, que responde ao clique sem
esperar a rede (é a regra da página: nada espera o servidor pra responder ao
clique). Duas implementações da mesma regra divergem calado, e a divergência
não aparece como erro: aparece como um número diferente nos dois lugares.

Três divergências custam caro, e são as três que este teste persegue:

1. **O maybeboard entrando em alguma conta.** Ele existe pra NÃO participar.
   Se o preço dele vazar pra prévia do orçamento, a pessoa vê o deck custando
   mais do que custa, e por causa de cartas que ela pôs ali justamente por
   não ter decidido.
2. **O sideboard contando pras 100.** O contador viveria acusando "5 cartas
   além das 100" num deck perfeitamente legal — e um alarme que está sempre
   ligado é um alarme que se aprende a ignorar, junto com os de verdade.
3. **Carta que some da tela.** Uma carta numa categoria que a lista de grupos
   não desenha continua no deck, no contador e na cotação — invisível e
   paga. É o pior estrago possível aqui, e o mais silencioso.

COMO ELE RODA. O JavaScript da página — os arquivos de
`app/static/deckbuilder/`, na ordem em que o HTML os carrega — é executado num
interpretador (Duktape, via `dukpy`) sobre um DOM de mentira: as funções de
desenho e de estado não tocam em nada além do que este arquivo lhes dá. Não
abre navegador e não vai à rede. Com o `fastapi` instalado, confere também a
rota `/deckbuilder`, direto no app, sem subir servidor.

    pip install dukpy
    python tests/test_deckbuilder.py

Sai com código 1 se qualquer checagem falhar. Sem o `dukpy` instalado, avisa
e sai com 0: ele não está no `requirements.txt` porque não é dependência do
serviço, só deste teste.
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from js_do_deckbuilder import ESTATICO, arquivos, js_da_pagina, sem_abrir

RAIZ = Path(__file__).resolve().parents[1]

try:
    import dukpy
except ImportError:
    print("dukpy não está instalado — este teste precisa dele pra rodar o "
          "JavaScript da página.\n\n    pip install dukpy\n")
    sys.exit(0)

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome}"
          f"{'' if condicao else f'  (obtido {detalhe!r})'}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"{obtido!r}, esperado {esperado!r}")


# ---------------------------------------------------------------------------
# O aparato: o JS da página e um DOM que não faz nada
# ---------------------------------------------------------------------------

# `abrir()` fica de fora: é a única linha da página que vai à rede e mexe em
# elementos de verdade. Todo o resto é função pura o bastante pra rodar aqui.
_JS = js_da_pagina()

_DOM = """
var __els = {};
function __el(id){
  if (!__els[id]) __els[id] = {
    id:id, innerHTML:"", textContent:"", hidden:false, className:"",
    dataset:{}, style:{}, value:"", children:[], offsetWidth:0,
    classList:{add:function(){},remove:function(){},toggle:function(){},
               contains:function(){return false;}},
    setAttribute:function(){}, getAttribute:function(){return null;},
    addEventListener:function(){}, insertAdjacentHTML:function(){},
    querySelector:function(){return null;}, querySelectorAll:function(){return [];},
    appendChild:function(){}, removeChild:function(){}, remove:function(){},
    getBoundingClientRect:function(){return {top:0,left:0,bottom:0,width:0,height:0};},
    scrollIntoView:function(){}, focus:function(){}, closest:function(){return null;}
  };
  return __els[id];
}
var document = {getElementById:__el, createElement:function(){return __el("x");},
                addEventListener:function(){}, querySelectorAll:function(){return [];},
                body:__el("body"), activeElement:null};
var window = {innerWidth:1600, innerHeight:900, addEventListener:function(){},
              scrollTo:function(){}};
var location = {search:"", pathname:"/deckbuilder", origin:"http://x", href:""};
var history = {replaceState:function(){}};
var localStorage = {getItem:function(){return null;}, setItem:function(){}};
var navigator = {clipboard:{writeText:function(){}}};
var fetch = function(){ throw new Error("este teste não vai à rede"); };
var requestAnimationFrame = function(){};
var setTimeout = function(){return 0;};    var clearTimeout = function(){};
var setInterval = function(){return 0;};   var clearInterval = function(){};
function alert(){} function confirm(){return true;} function prompt(){return null;}
"""


def carta(nome, tipo, ident="", custo="{1}", cmc=1.0, preco=1.0, basico=False):
    """Uma carta no formato que a busca devolve pra tela."""
    return {"nome": nome, "tipo": tipo, "identidade": ident, "mana_cost": custo,
            "cmc": cmc, "preco_usd": preco, "imagem": "http://arte/" + nome,
            "legal": True, "basico": basico, "ilimitada": False,
            "comandante": False, "parceiro": False}


def entrada(c, quantidade=1, categoria=""):
    return {"carta": c, "quantidade": quantidade, "categoria": categoria}


ATRAXA = carta("Atraxa", "Legendary Creature — Angel", "WUBG",
               "{3}{W}{U}{B}{G}", 7.0, 20.0)
SOL_RING = carta("Sol Ring", "Artifact", "", "{1}", 1.0, 2.0)
ALTAR = carta("Ashnod's Altar", "Artifact", "", "{3}", 3.0, 8.0)
FOREST = carta("Forest", "Basic Land — Forest", "", "", 0.0, 0.1, basico=True)
ELVES = carta("Llanowar Elves", "Creature — Elf Druid", "G", "{G}", 1.0, 0.5)
SWORDS = carta("Swords to Plowshares", "Instant", "W", "{W}", 1.0, 3.0)
BOLT = carta("Lightning Bolt", "Instant", "R", "{R}", 1.0, 2.0)
RHYSTIC = carta("Rhystic Study", "Enchantment", "U", "{2}{U}", 3.0, 30.0)

DECK = [
    entrada(SOL_RING, 1, "Combo principal"),
    entrada(ALTAR, 1, "Sac outlet"),
    entrada(FOREST, 10),
    entrada(ELVES),
    entrada(SWORDS, 1, "Sideboard"),
]
MAYBE = [entrada(RHYSTIC, 1, "Combo principal"), entrada(BOLT)]
CATEGORIAS = ["Combo principal", "Sac outlet", "Ainda vazia"]


def rodar(script, deck=None, maybe=None, categorias=None):
    """Monta o estado, roda `script` e devolve o que a tela ficou pensando."""
    prova = _DOM + _JS + """
    estado.comandantes = %s;
    estado.cartas = %s;
    estado.maybe = %s;
    estado.categorias = %s;
    agendarSalvar = function(){};
    %s
    JSON.stringify({
      cartas: estado.cartas.map(function(e){
        return [e.carta.nome, e.quantidade, e.categoria || ""]; }),
      maybe: estado.maybe.map(function(e){
        return [e.carta.nome, e.quantidade, e.categoria || ""]; }),
      categorias: estado.categorias,
      total: totalCartas(),
      contadas: cartasContadas().map(function(e){ return e.carta.nome; }),
      orcamento: orcamentoLocal(),
      ordem: ordemDasCategorias(estado.cartas),
      apontamentos: validarLocal().apontamentos.map(function(a){ return a.tipo; }),
      corpo: corpoDoDeck(),
      htmlDeck: gruposHTML(estado.cartas, identidadeDoDeck(), "deck"),
      htmlTalvez: gruposHTML(estado.maybe, identidadeDoDeck(), "talvez"),
      lista: listaTexto()
    });
    """ % (json.dumps([ATRAXA]),
           json.dumps(DECK if deck is None else deck),
           json.dumps(MAYBE if maybe is None else maybe),
           json.dumps(CATEGORIAS if categorias is None else categorias),
           script)
    return json.loads(dukpy.evaljs(prova))


def nomes_desenhados(html):
    return re.findall(r'data-nome="([^"]+)"', html)


def grupos_desenhados(html):
    return re.findall(r'data-categoria="([^"]+)"', html)


def carregar_um_por_um():
    """Carrega os scripts do jeito do navegador: um de cada vez, todos no
    mesmo escopo global. Devolve `(arquivo, erro)` do primeiro que quebrar, ou
    None. É o que pega a função chamada na carga por um arquivo que vem ANTES
    do que a declara — com tudo emendado num script só, esse erro não existe."""
    interpretador = dukpy.JSInterpreter()
    interpretador.evaljs(_DOM)
    lista = arquivos()
    for i, caminho in enumerate(lista):
        codigo = caminho.read_text(encoding="utf-8")
        if i == len(lista) - 1:
            codigo = sem_abrir(codigo)
        try:
            interpretador.evaljs(codigo)
        except Exception as e:      # noqa: BLE001 — o erro é o resultado
            return caminho.name, str(e).split("\n")[0]
    return None


try:
    # ---------------------------------------------------- a página em partes
    print("\n--- a página, arquivo por arquivo ---")
    lista = arquivos()
    check("a página carrega os scripts por arquivo", len(lista) > 1, len(lista))
    faltando = [p.name for p in lista if not p.exists()]
    eq("todo script que a página pede existe", faltando, [])
    # Um arquivo na pasta que a página não pede é código que não roda — e que
    # nenhum teste roda, porque a lista dos testes sai da página.
    fora = sorted({p.name for p in (ESTATICO / "deckbuilder").glob("*.js")}
                  - {p.name for p in lista})
    eq("todo script da pasta está na página", fora, [])
    if not faltando:
        # O "use strict" vale só pro arquivo em que está. Sem ele, atribuir a
        # um nome não declarado cria uma global calada em vez de dar erro.
        eq("todo script liga o modo estrito",
           [p.name for p in lista
            if not p.read_text(encoding="utf-8").startswith('"use strict";')],
           [])
        eq("carregados um de cada vez, como no navegador, nenhum quebra",
           carregar_um_por_um(), None)

    # ------------------------------------------------------- o que aparece
    print("\n--- a lista, agrupada ---")
    r = rodar("")

    # Primeiro o que a pessoa decidiu, depois o que a carta é, e o que está
    # fora da conta por último. O contrário enterraria a organização dela no
    # meio de nove grupos automáticos.
    eq("as categorias próprias vêm antes das automáticas",
       r["ordem"][:3], ["Combo principal", "Sac outlet", "Ainda vazia"])
    eq("e o Sideboard vem por último", r["ordem"][-1], "Sideboard")
    check("categoria própria vazia continua desenhada",
          "Ainda vazia" in grupos_desenhados(r["htmlDeck"]))
    check("o grupo de Terrenos leva o atalho da mana base",
          "data-abrir-manabase" in r["htmlDeck"])
    check("o Sideboard se anuncia como fora das 100",
          "fora das 100" in r["htmlDeck"])

    # Toda carta do estado tem que aparecer na tela — nenhuma pode ficar
    # invisível por causa de um grupo que não foi desenhado.
    eq("toda carta do deck é desenhada",
       sorted(nomes_desenhados(r["htmlDeck"])),
       sorted(e["carta"]["nome"] for e in DECK))
    eq("toda carta do maybeboard é desenhada",
       sorted(nomes_desenhados(r["htmlTalvez"])),
       sorted(e["carta"]["nome"] for e in MAYBE))
    # A rede de segurança do `ordemDasCategorias`: um deck salvo por uma
    # versão anterior pode trazer categoria que a lista não conhece.
    orfa = rodar("", deck=[entrada(SOL_RING, 1, "Categoria fantasma")],
                 categorias=[])
    eq("carta com categoria que a lista não conhece continua visível",
       nomes_desenhados(orfa["htmlDeck"]), ["Sol Ring"])

    # O maybeboard mostra o preço de cada carta — "vale o que custa?" é
    # metade da dúvida —, mas não o subtotal do grupo: ele não entra na
    # cotação, e uma soma ali diria o contrário.
    check("o maybeboard mostra preço por carta",
          'class="valor' in r["htmlTalvez"])
    check("mas não subtotal por grupo", "valor-grupo" not in r["htmlTalvez"])
    check("o deck mostra os dois", 'class="valor' in r["htmlDeck"]
          and "valor-grupo" in r["htmlDeck"])

    # ------------------------------------------------------------ as contas
    print("\n--- o que conta e o que não conta ---")
    # 1 comandante + Sol Ring + Altar + 10 Forest + Elves = 14. O Swords está
    # no sideboard e as duas do maybeboard não estão nesta conta.
    eq("o sideboard e o maybeboard ficam fora das 100", r["total"], 14)
    check("o sideboard não entra nas cartas contadas",
          "Swords to Plowshares" not in r["contadas"])
    check("nem as do maybeboard", "Rhystic Study" not in r["contadas"])

    # Sol Ring 2 + Altar 8 + Elves 0,5 + Swords 3 = 13,50. O básico sai do
    # total (critério do Commander 500) e o maybeboard nem é somado.
    eq("a prévia soma o deck e o sideboard, sem o maybeboard",
       round(r["orcamento"]["total"], 2), 13.50)
    eq("e conta o comandante e os básicos como fora", r["orcamento"]["fora"], 11)

    eq("a lista de impressão leva o sideboard e não leva o maybeboard",
       sorted(r["lista"].split("\n")),
       sorted(["1 Atraxa", "1 Sol Ring", "1 Ashnod's Altar", "10 Forest",
               "1 Llanowar Elves", "1 Swords to Plowshares"]))

    # ------------------------------------------------------- o que ela acusa
    print("\n--- o que a validação acusa ---")
    fora_no_deck = rodar("", deck=[entrada(BOLT)], maybe=[])
    check("carta fora da identidade NO DECK é acusada",
          "identidade" in fora_no_deck["apontamentos"])
    check("e a linha dela é marcada",
          'class="linha problema"' in fora_no_deck["htmlDeck"])
    # O maybeboard é rascunho: acusar identidade numa carta que a pessoa
    # ainda está pensando se usa é alarme sobre decisão que ela não tomou.
    fora_no_talvez = rodar("", deck=[], maybe=[entrada(BOLT)])
    check("a mesma carta NO MAYBEBOARD não é acusada",
          "identidade" not in fora_no_talvez["apontamentos"])
    check("nem marcada na linha",
          'class="linha problema"' not in fora_no_talvez["htmlTalvez"])

    # ---------------------------------------------------- mover e categorizar
    print("\n--- mover entre o deck e o maybeboard ---")
    r = rodar('mover("Sol Ring", "deck", "talvez");')
    check("a carta sai do deck", "Sol Ring" not in [c[0] for c in r["cartas"]])
    check("e chega no maybeboard com a categoria intacta",
          ["Sol Ring", 1, "Combo principal"] in r["maybe"], r["maybe"])
    eq("o total das 100 cai junto", r["total"], 13)
    eq("e o preço dela sai da prévia", round(r["orcamento"]["total"], 2), 11.50)

    r = rodar('mover("Rhystic Study", "talvez", "deck");')
    check("voltar pro deck traz a categoria de volta",
          ["Rhystic Study", 1, "Combo principal"] in r["cartas"], r["cartas"])

    r = rodar('mover("Llanowar Elves", "talvez", "deck");',
              maybe=MAYBE + [entrada(ELVES, 2)])
    check("a mesma carta nos dois lados soma ao voltar",
          ["Llanowar Elves", 3, ""] in r["cartas"], r["cartas"])
    check("e não fica duplicada no maybeboard",
          "Llanowar Elves" not in [c[0] for c in r["maybe"]])

    print("\n--- categorias ---")
    r = rodar('definirCategoria("Llanowar Elves", "deck", "Sac outlet");')
    check("categorizar não move de lista nem muda quantidade",
          ["Llanowar Elves", 1, "Sac outlet"] in r["cartas"], r["cartas"])

    r = rodar('definirCategoria("Llanowar Elves", "deck", "Sideboard");')
    eq("mandar pro sideboard tira das 100", r["total"], 13)
    eq("mas mantém na prévia do orçamento",
       round(r["orcamento"]["total"], 2), 13.50)

    r = rodar('definirCategoria("Swords to Plowshares", "deck", "");')
    eq("tirar do sideboard devolve pras 100", r["total"], 15)

    r = rodar('renomearCategoria("Combo principal", "Motor do deck");')
    check("renomear troca na lista de categorias",
          "Motor do deck" in r["categorias"]
          and "Combo principal" not in r["categorias"])
    check("renomear alcança as cartas do deck",
          ["Sol Ring", 1, "Motor do deck"] in r["cartas"], r["cartas"])
    # O maybeboard herda as categorias do deck: renomear num lado e não no
    # outro deixaria um grupo órfão lá, com o nome velho e sem dono.
    check("renomear alcança também o maybeboard",
          ["Rhystic Study", 1, "Motor do deck"] in r["maybe"], r["maybe"])

    r = rodar('apagarCategoria("Combo principal");')
    eq("apagar a categoria não apaga carta nenhuma",
       (len(r["cartas"]), len(r["maybe"])), (5, 2))
    check("as cartas dela voltam pro grupo do tipo",
          ["Sol Ring", 1, ""] in r["cartas"] and ["Rhystic Study", 1, ""] in r["maybe"])
    eq("e o total não muda", r["total"], 14)

    r = rodar('criarCategoria("Proteção", "Llanowar Elves", "deck");')
    check("criar categoria a partir de uma carta já a põe dentro",
          "Proteção" in r["categorias"]
          and ["Llanowar Elves", 1, "Proteção"] in r["cartas"])
    r = rodar('criarCategoria("SAC OUTLET", "Llanowar Elves", "deck");')
    eq("criar com nome que já existe não duplica a categoria",
       r["categorias"], CATEGORIAS)
    check("e a carta vai pra que já existia",
          ["Llanowar Elves", 1, "Sac outlet"] in r["cartas"], r["cartas"])

    r = rodar('moverCategoria("Sac outlet", -1);')
    eq("subir reordena as categorias", r["categorias"],
       ["Sac outlet", "Combo principal", "Ainda vazia"])

    # ------------------------------------------------------------- desfazer
    print("\n--- desfazer ---")
    r = rodar('mover("Sol Ring", "deck", "talvez"); desfazer();')
    check("Ctrl+Z devolve a carta pro deck",
          ["Sol Ring", 1, "Combo principal"] in r["cartas"], r["cartas"])
    check("e tira do maybeboard", "Sol Ring" not in [c[0] for c in r["maybe"]])
    r = rodar('apagarCategoria("Sac outlet"); desfazer();')
    check("Ctrl+Z devolve a categoria apagada",
          "Sac outlet" in r["categorias"]
          and ["Ashnod's Altar", 1, "Sac outlet"] in r["cartas"])

    # -------------------------------------------------- o que vai pro servidor
    print("\n--- o que a tela manda pro servidor ---")
    r = rodar("")
    corpo = r["corpo"]
    eq("a categoria vai junto de cada carta",
       [c["categoria"] for c in corpo["cartas"]],
       ["Combo principal", "Sac outlet", "", "", "Sideboard"])
    eq("o maybeboard vai em campo próprio",
       [c["nome"] for c in corpo["maybeboard"]],
       ["Rhystic Study", "Lightning Bolt"])
    # Inclusive as vazias: uma categoria recém-criada sumiria antes de
    # receber a primeira carta se ela só existisse nas entradas.
    check("as categorias vão inteiras, inclusive a vazia",
          "Ainda vazia" in corpo["categorias"])

    # ------------------------------------------------------------- a rota
    print("\n--- a rota /deckbuilder ---")
    try:
        from fastapi.testclient import TestClient
    except ImportError:
        print("PULADO: fastapi não está instalado "
              "(pip install -r requirements.txt)")
    else:
        # Antes de importar o app: os módulos leem o ambiente no import, e um
        # teste não pode encostar num banco de verdade.
        os.environ.setdefault("DB_PATH",
                              os.path.join(tempfile.mkdtemp(), "orders.db"))
        os.environ.setdefault("CARTAS_DB_PATH",
                              os.path.join(tempfile.mkdtemp(), "cartas.db"))
        os.environ.setdefault("LOG_DIR", tempfile.mkdtemp())
        os.environ.setdefault("LOG_NIVEL", "ERROR")
        sys.path.insert(0, str(RAIZ))
        os.chdir(RAIZ)
        from app.main import app  # noqa: E402

        cliente = TestClient(app)
        r = cliente.get("/deckbuilder")
        eq("a página responde", r.status_code, 200)
        # Sem isto o navegador pode servir a página do cache dele, e ela
        # apontaria pros arquivos de outro deploy.
        check("a página sai com no-cache",
              "no-cache" in r.headers.get("cache-control", ""),
              r.headers.get("cache-control"))
        urls = re.findall(r'(?:src|href)="(/deckbuilder/[^"]+)"', r.text)
        eq("pede o CSS e todos os scripts", len(urls), len(arquivos()) + 1)
        eq("cada arquivo sai com a versão na URL",
           [u for u in urls if not re.search(r"\?v=[0-9a-f]{12}$", u)], [])
        eq("e cada URL versionada responde",
           [u for u in urls if cliente.get(u).status_code != 200], [])

except Exception as e:      # noqa: BLE001 — o erro é o resultado do teste
    import traceback
    traceback.print_exc()
    falhas.append(f"exceção: {e}")

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: " + ", ".join(map(str, falhas)))
    sys.exit(1)
print("tudo certo")
