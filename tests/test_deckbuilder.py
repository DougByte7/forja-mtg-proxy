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

COMO ELE RODA. O JavaScript da página — os módulos de
`app/static/deckbuilder/` e `app/static/comum/`, achatados na ordem em que o
navegador os avalia (ver `js_do_deckbuilder.py`) — é executado num
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

from js_do_deckbuilder import (ESTATICO, PAGINA, arquivos, js_da_pagina,
                               sem_abrir, sem_modulo)

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
    removeAttribute:function(k){ delete this[k]; },
    hasAttribute:function(k){ return k in this; },
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
function URLSearchParams(inicial){
  this._p = [];
  for (var k in inicial) if (Object.prototype.hasOwnProperty.call(inicial, k))
    this._p.push([k, String(inicial[k])]);
  this.set = function(k, v){
    for (var i = 0; i < this._p.length; i++)
      if (this._p[i][0] === k){ this._p[i][1] = String(v); return; }
    this._p.push([k, String(v)]);
  };
  this.toString = function(){
    return this._p.map(function(par){
      return par[0] + "=" + encodeURIComponent(par[1]); }).join("&");
  };
}
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


DELVER = dict(carta("Delver of Secrets // Insectile Aberration",
                    "Creature — Human Wizard // Creature — Human Insect", "U"),
              imagem_verso="http://arte/Insectile Aberration")
ROOM = dict(carta("Porta // Sala", "Enchantment — Room // Enchantment — Room"),
            deitada=1)


def avaliar(script):
    """Roda `script` sobre o deck de exemplo e devolve o JSON que ele deixar.
    As cartas de duas faces e partida ficam à mão como DELVER e ROOM."""
    prova = _DOM + _JS + """
    estado.comandantes = %s;
    estado.cartas = %s;
    estado.maybe = %s;
    estado.categorias = %s;
    var SOL_RING = %s, ELVES = %s, DELVER = %s, ROOM = %s;
    %s
    """ % (json.dumps([ATRAXA]), json.dumps(DECK), json.dumps(MAYBE),
           json.dumps(CATEGORIAS), json.dumps(SOL_RING), json.dumps(ELVES),
           json.dumps(DELVER), json.dumps(ROOM), script)
    return json.loads(dukpy.evaljs(prova))


def nomes_desenhados(html):
    return re.findall(r'data-nome="([^"]+)"', html)


def grupos_desenhados(html):
    return re.findall(r'data-categoria="([^"]+)"', html)


def carregar_um_por_um():
    """Avalia os módulos um de cada vez, na ordem em que o navegador os
    avalia, cada um enxergando só o que os anteriores já declararam. Devolve
    `(arquivo, erro)` do primeiro que quebrar, ou None. É o que pega o módulo
    que usa, na carga, um nome de outro que ainda não foi avaliado — com o
    grafo achatado num script só, esse erro não existe."""
    interpretador = dukpy.JSInterpreter()
    interpretador.evaljs(_DOM)
    lista = arquivos()
    for i, caminho in enumerate(lista):
        codigo = '"use strict";\n' + sem_modulo(caminho.read_text(encoding="utf-8"))
        if i == len(lista) - 1:
            codigo = sem_abrir(codigo)
        try:
            interpretador.evaljs(codigo)
        except Exception as e:      # noqa: BLE001 — o erro é o resultado
            return caminho.name, str(e).split("\n")[0]
    return None


try:
    # ---------------------------------------------------- a página em partes
    print("\n--- a página, módulo por módulo ---")
    # A página carrega a entrada e só: o resto chega pelos `import`. Um
    # `<script src>` comum a mais rodaria fora do grafo, num escopo que os
    # módulos não enxergam.
    eq("a página carrega o JS só pela entrada, como módulo",
       re.findall(r'<script type="([^"]+)"',
                  PAGINA.read_text(encoding="utf-8")),
       ["importmap", "module"])
    lista = arquivos()
    check("a entrada leva ao grafo inteiro", len(lista) > 1, len(lista))
    # Um arquivo na pasta que nenhum `import` alcança é código que não roda —
    # e que nenhum teste roda, porque a lista dos testes sai do grafo.
    fora = sorted(p.name for p in (ESTATICO / "deckbuilder").glob("*.js")
                  if p.resolve() not in lista)
    eq("todo módulo da pasta é alcançado pela entrada", fora, [])
    eq("avaliados um de cada vez, na ordem do navegador, nenhum quebra",
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

    # ---------------------------------------------------------------- artes
    print("\n--- artes ---")
    # `1 … 3 4 5 6 7 … 10`: a primeira, a última e duas de cada lado da
    # atual. Cinco no meio sempre, inclusive nas pontas — senão os números
    # trocam de lugar debaixo do mouse a cada clique.
    pags = avaliar("JSON.stringify([paginasVisiveis(4, 10), paginasVisiveis(0, 10),"
                   " paginasVisiveis(9, 10), paginasVisiveis(2, 5)])")
    eq("no meio: a atual com duas de cada lado, e reticências nos vãos",
       pags[0], [0, "…", 2, 3, 4, 5, 6, "…", 9])
    eq("na primeira página a janela encosta no começo",
       pags[1], [0, 1, 2, 3, 4, 5, "…", 9])
    eq("na última, no fim", pags[2], [0, "…", 4, 5, 6, 7, 8, 9])
    eq("até sete páginas cabem todas, sem vão", pags[3], [0, 1, 2, 3, 4])
    eq("o paginador tem sempre o mesmo número de páginas à vista",
       avaliar("var n = []; for (var p = 0; p < 30; p++) n.push("
               "paginasVisiveis(p, 30).filter(function(x){ return x !== '…'; }).length);"
               " JSON.stringify(n.filter(function(x){ return x !== 7; }))"), [])

    # O MPC Fill indexa cada face pelo próprio nome: o verso se pergunta pelo
    # nome DELE, e a frente vai inteira (quem corta é o servidor).
    eq("o verso se busca pelo nome do verso",
       avaliar('JSON.stringify([nomeDaBusca(DELVER, "verso"),'
               ' nomeDaBusca(DELVER, "frente")])'),
       ["Insectile Aberration", "Delver of Secrets // Insectile Aberration"])

    # A chave da tela tem que ser a do servidor: é por ela que a escolha que
    # ele devolve é achada aqui ao reabrir o deck. Os esperados são o que o
    # `cartas.normalizar` responde pra esses mesmos nomes.
    nomes = ["Atraxa, Praetors' Voice", "Delver of Secrets // Insectile Aberration",
             "Lim-Dûl's Vault", "Ærathi Berserker", "  Jötun   Grunt ",
             "t:Wurm e76e0314"]
    eq("a chave da arte é o nome achatado do servidor",
       avaliar("JSON.stringify(%s.map(chaveDaArte))" % json.dumps(nomes)),
       ["atraxa praetors voice", "delver of secrets insectile aberration",
        "lim duls vault", "aerathi berserker", "jotun grunt", "t wurm e76e0314"])

    # A prévia do hover mostra o arquivo escolhido, e não a arte oficial.
    previa = avaliar(
        'arte.escolhas["sol ring"] = {frente: {drive_id: "id-sol"}};'
        'arte.escolhas["delver of secrets insectile aberration"] ='
        ' {verso: {drive_id: "id-inseto"}};'
        'JSON.stringify([ganchosDaPrevia(SOL_RING), ganchosDaPrevia(ELVES),'
        ' ganchosDaPrevia(DELVER)])')
    check("com arte escolhida, a prévia mostra o arquivo do MPC Fill",
          "thumbnail?id=id-sol" in previa[0], previa[0])
    check("sem arte escolhida, a arte oficial", 'data-arte="http://arte/Llanowar Elves"'
          in previa[1], previa[1])
    check("em carta de duas faces, cada lado sai pela sua escolha",
          'data-arte="http://arte/Delver' in previa[2]
          and "thumbnail?id=id-inseto" in previa[2], previa[2])

    galeria = avaliar(
        'estado.cartas.push({carta: DELVER, quantidade: 1, categoria: ""},'
        ' {carta: ROOM, quantidade: 1, categoria: ""});'
        'arte.escolhas["sol ring"] = {frente: {drive_id: "id-sol"}};'
        'desenharGaleria(); JSON.stringify($("galeria-resultado").innerHTML)')
    quadros = re.findall(r'data-arte-carta="([^"]+)" data-arte-face="(\w+)"', galeria)
    eq("a galeria tem um quadro por arte: frente e verso da carta de duas faces",
       [f for n, f in quadros if n.startswith("Delver")], ["frente", "verso"])
    check("o maybeboard não entra na galeria — não vai pro papel",
          not any(n in ("Rhystic Study", "Lightning Bolt") for n, _ in quadros))
    check("o sideboard entra", any(n == "Swords to Plowshares" for n, _ in quadros))
    eq("e o comandante vem primeiro", quadros[0][0], "Atraxa")
    check("a carta partida sai deitada",
          re.search(r'class="galeria-carta\s+deitada"\s+data-arte-carta="Porta', galeria)
          is not None)
    check("a escolhida se marca", re.search(
        r'class="galeria-carta tem-arte\s*"\s+data-arte-carta="Sol Ring"', galeria)
        is not None)
    # Atraxa, 5 cartas do deck, Delver (2 artes) e o Room: 9 artes, 1 escolhida.
    check("a conta é por arte, e diz quantas faltam", "<b>1/9</b>" in galeria)

    # O "Gerar pedido" só leva à tela de orçamento com TODAS as artes
    # escolhidas — o verso da carta de duas faces inclusive.
    pedido = avaliar(
        'estado.id = "abc123";'
        'estado.cartas = [{carta: SOL_RING, quantidade: 4, categoria: ""},'
        ' {carta: DELVER, quantidade: 1, categoria: ""}];'
        'var fotos = [];'
        'function foto(){ atualizarBotaoPedido(); var l = $("btn-pedido");'
        ' fotos.push([l.hidden, l.href || null, l.title]); }'
        'foto();'
        'arte.escolhas["atraxa"] = {frente: {drive_id: "a"}};'
        'arte.escolhas["sol ring"] = {frente: {drive_id: "s"}};'
        'arte.escolhas["delver of secrets insectile aberration"] ='
        ' {frente: {drive_id: "d"}};'
        'foto();'
        'arte.escolhas["delver of secrets insectile aberration"].verso ='
        ' {drive_id: "i"};'
        'foto();'
        'estado.id = null; foto();'
        'JSON.stringify(fotos)')
    eq("sem arte escolhida, o link não leva a lugar nenhum e diz quantas faltam",
       pedido[0], [False, None, "Faltam 4 arte(s) — escolha na aba Artes"])
    eq("com só o verso faltando, continua desligado",
       pedido[1][1:], [None, "Faltam 1 arte(s) — escolha na aba Artes"])
    eq("com tudo escolhido, leva o id do deck pra tela de orçamento",
       pedido[2][:2], [False, "/?deck=abc123"])
    eq("deck que ainda não foi salvo não mostra o link", pedido[3][:2], [True, None])

    # As fichas vão pro papel: quadro na aba Artes, conta no "Gerar pedido".
    # A resposta de `/decks/{id}/tokens` traz a mesma Wurm de deathtouch por
    # duas cartas, e a de lifelink, de mesmo nome, por uma.
    def wurm(texto, chave):
        return {"nome": "Wurm", "tipo": "Token Artifact Creature — Wurm",
                "texto": texto, "poder": "3", "resistencia": "3",
                "imagem": "http://arte/" + chave, "chave_arte": chave}
    tokens = {"total": 3, "grupos": [
        {"carta": "Motor de Wurm", "tokens": [wurm("Deathtouch", "t:Wurm aaaa1111"),
                                              wurm("Lifelink", "t:Wurm bbbb2222")]},
        {"carta": "Sol Ring", "tokens": [wurm("Deathtouch", "t:Wurm aaaa1111")]}]}
    fichas = avaliar(
        'estado.id = "abc123"; estado.tokens = %s;'
        'estado.cartas = [{carta: SOL_RING, quantidade: 1, categoria: ""}];'
        'arte.escolhas["atraxa"] = {frente: {drive_id: "a"}};'
        'arte.escolhas["sol ring"] = {frente: {drive_id: "s"}};'
        'arte.escolhas["t wurm aaaa1111"] = {frente: {drive_id: "w"}};'
        'var f = fichasDoDeck(); desenharGaleria(); atualizarBotaoPedido();'
        'var antes = $("btn-pedido").title;'
        'arte.escolhas["t wurm bbbb2222"] = {frente: {drive_id: "v"}};'
        'atualizarBotaoPedido();'
        'JSON.stringify({n: f.length, busca: nomeDaBusca(f[0], "frente"),'
        ' achada: acharCartaDaArte("t:Wurm bbbb2222").texto,'
        ' galeria: $("galeria-resultado").innerHTML, antes: antes,'
        ' depois: $("btn-pedido").href || null})' % json.dumps(tokens))
    eq("a mesma ficha criada por duas cartas é um quadro só", fichas["n"], 2)
    eq("a busca de ficha vai na sintaxe do MPC Fill", fichas["busca"], "t:Wurm")
    eq("o quadro acha a ficha pela chave, não pelo nome", fichas["achada"], "Lifelink")
    quadros = re.findall(r'data-arte-carta="([^"]+)"', fichas["galeria"])
    eq("as fichas vêm no fim da galeria, pela chave",
       quadros[-2:], ["t:Wurm aaaa1111", "t:Wurm bbbb2222"])
    check("num grupo próprio", "<h3>Tokens</h3>" in fichas["galeria"])
    check("a ficha escolhida se marca pela chave", re.search(
        r'class="galeria-carta tem-arte\s*"\s+data-arte-carta="t:Wurm aaaa1111"',
        fichas["galeria"]) is not None)
    check("e o texto no título separa as duas Wurm",
          "Wurm 3/3 (Lifelink)" in fichas["galeria"])
    eq("com uma ficha no padrão, o pedido não sai",
       fichas["antes"], "Faltam 1 arte(s) — escolha na aba Artes")
    eq("com as fichas escolhidas, sai", fichas["depois"], "/?deck=abc123")

    # --------------------------------------------- o paginador da busca
    print("\n--- o paginador da busca ---")

    # Ele só existe com filtro ligado, e essa é a decisão inteira: sem filtro
    # a lista é uma vitrine de cinco, e passar página nela seria folhear a
    # base de carta em carta. A pergunta "tem filtro?" mora no `estado.js`, e
    # tem que dar a mesma resposta que a bolinha do botão dá em número — daí
    # `cmcMin: "0"` contar como filtro: ele também vira chip na fita.
    pag = avaliar("""
    var vazio = {tipo:"", texto:"", cores:"", cmcMin:"", cmcMax:"",
                 precoMax:"", ordem:"nome"};
    function com(mudanca){
      estado.filtros = Object.assign({}, vazio, mudanca);
      return algumFiltro();
    }
    JSON.stringify({
      semNada: com({}),
      tipo: com({tipo:"creature"}),
      cor: com({cores:"G"}),
      cmcZero: com({cmcMin:"0"}),
      ordem: com({ordem:"preco_desc"})
    });
    """)
    eq("sem filtro, a lista não pagina", pag["semNada"], False)
    eq("cada filtro ligado liga o paginador",
       [pag["tipo"], pag["cor"], pag["cmcZero"], pag["ordem"]],
       [True, True, True, True])

    # O denominador vem do total que o servidor contou, e não do tamanho da
    # página: 37 cartas de 5 em 5 são 8 páginas, e a oitava tem duas.
    passos = avaliar("""
    estado.buscaTotal = 37; estado.buscaPorPagina = 5;
    estado.buscaPagina = 0; var primeira = paginadorDaBusca();
    estado.buscaPagina = 7; var ultima = paginadorDaBusca();
    estado.buscaPorPagina = 15; var quinze = paginadorDaBusca();
    JSON.stringify({primeira: primeira, ultima: ultima, quinze: quinze});
    """)
    check("o paginador conta as páginas pelo total",
          "1 / 8" in passos["primeira"], passos["primeira"])
    check("na primeira página, voltar está desligado",
          'data-res-pag="-1" title="Página anterior"' in passos["primeira"]
          and "disabled" in passos["primeira"].split('data-res-pag="1"')[0])
    check("na última, avançar está desligado",
          "disabled" in passos["ultima"].split('data-res-pag="1"')[1],
          passos["ultima"])
    check("o tamanho escolhido vem marcado no seletor",
          '<option value="15" selected>' in passos["quinze"], passos["quinze"])
    # A página vira com o total novo: 37 de 15 em 15 são 3, e a página 7 não
    # existe mais — o paginador mostra a última que existe em vez de um
    # número solto.
    check("o número da página não passa do fim",
          "3 / 3" in passos["quinze"], passos["quinze"])

    # Trocar o tamanho da página volta pro começo: a carta que estava na tela
    # está em outra página agora, e "página 4" de 5 em 5 não é a mesma coisa
    # que "página 4" de 15 em 15. As setas, essas, param nas pontas.
    andar = avaliar("""
    estado.filtros.tipo = "creature";
    estado.buscaTotal = 37; estado.buscaPorPagina = 5; estado.buscaPagina = 0;
    virarPagina(-1); var naPrimeira = estado.buscaPagina;
    virarPagina(1); var depoisDeUma = estado.buscaPagina;
    estado.buscaPagina = 7; virarPagina(1); var naUltima = estado.buscaPagina;
    escolherPorPagina(15);
    JSON.stringify({naPrimeira: naPrimeira, depoisDeUma: depoisDeUma,
                    naUltima: naUltima, porPagina: estado.buscaPorPagina,
                    depoisDeTrocar: estado.buscaPagina});
    """)
    eq("voltar da primeira página não vai pra página -1", andar["naPrimeira"], 0)
    eq("a seta anda uma página", andar["depoisDeUma"], 1)
    eq("avançar da última não passa do fim", andar["naUltima"], 7)
    eq("o tamanho escolhido vale", andar["porPagina"], 15)
    eq("e trocar de tamanho volta pra primeira página",
       andar["depoisDeTrocar"], 0)

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
        urls = re.findall(r'(?:src|href)="(/(?:deckbuilder|comum)/[^"]+)"',
                          r.text)
        eq("cada arquivo que a página pede sai com a versão na URL",
           [u for u in urls if not re.search(r"\?v=[0-9a-f]{12}$", u)], [])
        # Os `import` de dentro dos módulos não passam pela página: quem os
        # versiona é o importmap. Módulo fora dele é pedido sem versão, e o
        # navegador pode responder com um velho do cache.
        mapa = json.loads(re.search(r'<script type="importmap">(.*?)</script>',
                                    r.text, re.S)[1])["imports"]
        modulos = ["/" + p.relative_to(ESTATICO).as_posix() for p in lista]
        eq("todo módulo do grafo está no importmap, com a versão",
           [m for m in modulos if not re.fullmatch(
               re.escape(m) + r"\?v=[0-9a-f]{12}", mapa.get(m, ""))], [])
        eq("e cada um é pré-carregado, pra não descobrir o grafo aos poucos",
           sorted(re.findall(r'<link rel="modulepreload" href="([^"]+)">',
                             r.text)), sorted(mapa.values()))
        eq("e cada URL versionada responde",
           sorted(u for u in set(urls) | set(mapa.values())
                  if cliente.get(u).status_code != 200), [])

except Exception as e:      # noqa: BLE001 — o erro é o resultado do teste
    import traceback
    traceback.print_exc()
    falhas.append(f"exceção: {e}")

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: " + ", ".join(map(str, falhas)))
    sys.exit(1)
print("tudo certo")
