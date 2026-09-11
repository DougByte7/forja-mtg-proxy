"""
Confere o simulador de goldfish do deckbuilder.

MOTIVO DE EXISTIR. Este é o único lugar da tela que MOVE cartas entre zonas, e
o jeito de ele quebrar é silencioso: uma carta some, ou aparece duas vezes, e
a mesa continua desenhando normalmente. Um goldfish que duplica carta MENTE
sobre o deck — a pessoa conclui que a mão anda quando ela não anda, que é
exatamente o oposto do que a ferramenta existe pra responder.

Quatro coisas que este teste persegue:

1. **A conservação das cartas.** Depois de qualquer sequência de jogadas, a
   soma das zonas tem que ser o mesmo multiconjunto do começo. É a única
   asserção que pega Fisher-Yates escrito errado, `splice` com índice torto e
   `mover` deixando o mesmo uid em duas zonas.
2. **O baralho é o deck certo.** Sem o comandante (ele vai pra zona de
   comando) e sem sideboard nem maybeboard — as mesmas 100 do contador, da
   curva e da cotação. Outra regra aqui faria a mesa discordar do resto da
   tela sobre o que é o deck.
3. **As duas regras do formato que mudam a mão**: o primeiro mulligan é grátis
   e quem começa jogando compra no turno 1. Um off-by-one em qualquer uma
   ninguém percebe olhando a tela: a mão simplesmente vem com uma carta a mais
   ou a menos, e parece que foi assim que o formato mandou.
4. **Cada cópia tem identidade própria.** Trinta Florestas são trinta objetos.
   Se forem a mesma referência, deitar uma deita as trinta — o bug clássico
   deste tipo de tela.

COMO ELE RODA. Igual ao `test_deckbuilder.py`: o JavaScript da página (os
módulos da página, achatados na ordem em que o navegador os avalia) roda num
interpretador (Duktape, via `dukpy`) sobre um DOM de mentira. Não sobe
servidor, não abre navegador e não vai à rede.

    pip install dukpy
    python tests/test_goldfish.py

Sai com código 1 se qualquer checagem falhar.
"""
import json
import sys

from js_do_deckbuilder import js_da_pagina

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


_JS = js_da_pagina()

_DOM = """
var __els = {};
function __el(id){
  if (!__els[id]) __els[id] = {
    id:id, innerHTML:"", textContent:"", hidden:false, className:"",
    dataset:{}, style:{}, value:"", children:[], offsetWidth:0, disabled:false,
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
                querySelector:function(){return null;},
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


def carta(nome, tipo, ident="", custo="{1}", cmc=1.0):
    return {"nome": nome, "tipo": tipo, "identidade": ident, "mana_cost": custo,
            "cmc": cmc, "preco_usd": 1.0, "imagem": "http://arte/" + nome,
            "legal": True, "basico": tipo.startswith("Basic"), "ilimitada": False,
            "comandante": False, "parceiro": False}


def entrada(c, quantidade=1, categoria=""):
    return {"carta": c, "quantidade": quantidade, "categoria": categoria}


ATRAXA = carta("Atraxa", "Legendary Creature — Angel", "WUBG", "{3}{W}{U}{B}{G}", 7.0)
FOREST = carta("Forest", "Basic Land — Forest", "G", "", 0.0)
SOL_RING = carta("Sol Ring", "Artifact", "", "{1}", 1.0)
ELVES = carta("Llanowar Elves", "Creature — Elf Druid", "G", "{G}", 1.0)
SWORDS = carta("Swords to Plowshares", "Instant", "W", "{W}", 1.0)
BOLT = carta("Lightning Bolt", "Instant", "R", "{R}", 1.0)
FINKS = carta("Kitchen Finks", "Creature — Ouphe", "GW", "{1}{G/W}", 3.0)

# 1 Sol Ring + 10 Forest + 4 Elves = 15 no baralho. O sideboard e o maybeboard
# ficam de fora, e o comandante vai pra zona de comando.
DECK = [
    entrada(SOL_RING, 1),
    entrada(FOREST, 10),
    entrada(ELVES, 4),
    entrada(SWORDS, 2, "Sideboard"),
]
MAYBE = [entrada(BOLT, 3)]
NO_BARALHO = 15


def rodar(script):
    prova = _DOM + _JS + """
    estado.comandantes = %s;
    estado.cartas = %s;
    estado.maybe = %s;
    agendarSalvar = function(){};
    desenharMesa = function(){};   /* o desenho não é o assunto deste teste */
    %s
    """ % (json.dumps([ATRAXA]), json.dumps(DECK), json.dumps(MAYBE), script)
    return dukpy.evaljs(prova)


# Devolve as cartas de todas as zonas, achatadas, pra comparar multiconjuntos.
TODAS = """
  function __todas(){
    var m = estado.mesa, saida = [];
    ["baralho","mao","campo","cemiterio","exilio","comando"].forEach(function(z){
      m[z].forEach(function(c){ saida.push(c.uid + ":" + c.carta.nome); });
    });
    return saida.sort();
  }
"""

print("\n--- o baralho é o deck certo ---")

eq("o baralho tem as cartas contadas menos o comandante",
   rodar("baralhoDoDeck().length;"), NO_BARALHO)
check("e nunca contém o comandante",
      rodar("""
        baralhoDoDeck().filter(function(c){ return c.carta.nome === "Atraxa"; }).length;
      """) == 0)
check("nem o sideboard",
      rodar("""
        baralhoDoDeck().filter(function(c){
          return c.carta.nome === "Swords to Plowshares"; }).length;
      """) == 0)
check("nem o maybeboard",
      rodar("""
        baralhoDoDeck().filter(function(c){
          return c.carta.nome === "Lightning Bolt"; }).length;
      """) == 0)
eq("o comandante vai pra zona de comando",
   rodar("montarMesa(); estado.mesa.comando.map(function(c){return c.carta.nome;});"),
   ["Atraxa"])

# Trinta Florestas são trinta objetos. Referência compartilhada faz deitar uma
# deitar as trinta.
eq("cada cópia tem identidade própria",
   rodar("""
     var b = baralhoDoDeck();
     var uids = {};
     b.forEach(function(c){ uids[c.uid] = 1; });
     Object.keys(uids).length;
   """), NO_BARALHO)
eq("e deitar uma não deita as outras",
   rodar("""
     montarMesa();
     estado.mesa.fase = "jogo";
     var florestas = estado.mesa.baralho.filter(function(c){
       return c.carta.nome === "Forest"; });
     florestas[0].deitada = true;
     florestas.filter(function(c){ return c.deitada; }).length;
   """), 1)


print("\n--- embaralhar é permutação ---")

# Fisher-Yates escrito errado perde ou duplica elemento em silêncio.
eq("o mesmo multiconjunto entra e sai",
   rodar("""
     var b = baralhoDoDeck();
     var antes = b.map(function(c){ return c.uid; }).sort().join(",");
     var depois = embaralhar(b).map(function(c){ return c.uid; }).sort().join(",");
     antes === depois;
   """), True)
eq("e o tamanho não muda", rodar("embaralhar(baralhoDoDeck()).length;"), NO_BARALHO)


print("\n--- mão de abertura ---")

eq("compra 7", rodar("montarMesa(); estado.mesa.mao.length;"), 7)
eq("e o baralho encolhe na mesma medida",
   rodar("montarMesa(); estado.mesa.baralho.length;"), NO_BARALHO - 7)
eq("começa na fase de mulligan",
   rodar("montarMesa(); estado.mesa.fase;"), "mulligan")


print("\n--- mulligan London, primeiro grátis (regra do Commander) ---")

# É o off-by-one que ninguém percebe olhando a tela.
# A mão fica com 8: as 7 mais a compra do turno 1, que é a outra regra do
# formato (ver a seção da compra do turno 1, mais abaixo).
eq("manter sem mulligan nenhum: mão de 8, nada pro fundo",
   rodar("montarMesa(); manterMao(); [estado.mesa.mao.length, estado.mesa.aFundo];"),
   [8, 0])
eq("e vai direto pro jogo, sem pedir escolha",
   rodar("montarMesa(); manterMao(); estado.mesa.fase;"), "jogo")

eq("1 mulligan: ainda 8 na mão e nada pro fundo — o primeiro é grátis",
   rodar("""
     montarMesa(); mulliganLondon(); manterMao();
     [estado.mesa.mao.length, estado.mesa.aFundo];
   """), [8, 0])
eq("e também vai direto pro jogo",
   rodar("montarMesa(); mulliganLondon(); manterMao(); estado.mesa.fase;"), "jogo")

eq("2 mulligans: devolve 1",
   rodar("""
     montarMesa(); mulliganLondon(); mulliganLondon(); manterMao();
     [estado.mesa.mao.length, estado.mesa.aFundo, estado.mesa.fase];
   """), [7, 1, "fundo"])
eq("3 mulligans: devolve 2",
   rodar("""
     montarMesa(); mulliganLondon(); mulliganLondon(); mulliganLondon();
     manterMao(); estado.mesa.aFundo;
   """), 2)

eq("depois de mandar as escolhidas pro fundo, a mão fica com 6 — 5 mais a do turno 1",
   rodar("""
     montarMesa();
     mulliganLondon(); mulliganLondon(); mulliganLondon();
     manterMao();
     mandarPraFundo(estado.mesa.mao[0].uid);
     mandarPraFundo(estado.mesa.mao[0].uid);
     [estado.mesa.mao.length, estado.mesa.fase];
   """), [6, "jogo"])

# Deck pequeno é o caso deste teste, mas também o de quem está montando: pedir
# pra devolver mais cartas do que a mão tem deixaria a fase de fundo sem fim.
eq("nunca pede pro fundo mais do que a mão tem",
   rodar("""
     montarMesa();
     for (var i = 0; i < 12; i++) mulliganLondon();
     estado.mesa.mao = estado.mesa.mao.slice(0, 3);
     manterMao();
     [estado.mesa.aFundo, estado.mesa.mao.length];
   """), [3, 3])


print("\n--- a compra do turno 1 (regra do Commander) ---")

# No Commander quem começa jogando COMPRA — é o duelo de dois que tira essa
# compra do primeiro jogador. A mesa adianta essa compra pro fim do mulligan.
eq("a mão confirmada traz a carta do turno 1, e ela sai do baralho",
   rodar("""
     montarMesa(); manterMao();
     [estado.mesa.mao.length, estado.mesa.baralho.length];
   """), [8, NO_BARALHO - 8])

eq("a carta extra vem DEPOIS das que voltam pro fundo",
   rodar("""
     montarMesa(); mulliganLondon(); mulliganLondon();
     manterMao();
     var devolvida = estado.mesa.mao[0].uid;
     mandarPraFundo(devolvida);
     [estado.mesa.mao.length,
      estado.mesa.mao.filter(function(c){ return c.uid === devolvida; }).length];
   """), [7, 0])

eq("e ela é uma só: o turno 2 compra mais uma, não duas",
   rodar("""
     montarMesa(); manterMao(); passarTurno();
     estado.mesa.mao.length;
   """), 9)

eq("e elas foram pro FUNDO, não pro topo",
   rodar("""
     montarMesa();
     mulliganLondon(); mulliganLondon();
     manterMao();
     var escolhida = estado.mesa.mao[0].uid;
     mandarPraFundo(escolhida);
     estado.mesa.baralho[estado.mesa.baralho.length - 1].uid === escolhida;
   """), True)

eq("cada mulligan reembaralha tudo: o baralho volta a ter 15 menos a mão",
   rodar("""
     montarMesa(); mulliganLondon();
     estado.mesa.baralho.length + estado.mesa.mao.length;
   """), NO_BARALHO)


print("\n--- turnos ---")

eq("passar turno compra 1",
   rodar("""
     montarMesa(); manterMao();
     var antes = estado.mesa.mao.length;
     passarTurno();
     [estado.mesa.turno, estado.mesa.mao.length - antes];
   """), [2, 1])
eq("e endireita o que estava deitado",
   rodar("""
     montarMesa(); manterMao();
     gfMover(estado.mesa.mao[0].uid, "campo");
     estado.mesa.campo[0].deitada = true;
     passarTurno();
     estado.mesa.campo[0].deitada;
   """), False)
eq("o contador de terrenos do turno zera",
   rodar("""
     montarMesa(); manterMao();
     estado.mesa.terrenosBaixados = 3;
     passarTurno();
     estado.mesa.terrenosBaixados;
   """), 0)

# Conta, não impede: é a decisão central desta tela.
eq("baixar dois terrenos no mesmo turno é permitido, e contado",
   rodar("""
     montarMesa(); manterMao();
     /* põe duas florestas na mão, na marra, pra o teste não depender do sorteio */
     var flor = estado.mesa.baralho.filter(function(c){
       return c.carta.nome === "Forest"; }).slice(0, 2);
     flor.forEach(function(c){ gfMover(c.uid, "mao"); });
     flor.forEach(function(c){ gfMover(c.uid, "campo"); });
     [estado.mesa.terrenosBaixados, estado.mesa.campo.length];
   """), [2, 2])


print("\n--- resumo da mão ---")

# A conta que a pessoa faria de cabeça a cada mulligan. Terreno fica de fora da
# média pelo mesmo motivo que fica de fora da curva: custa zero e puxaria o
# número pra baixo sem dizer nada sobre o que dá pra lançar.
eq("terrenos, média do que não é terreno e as cores pedidas",
   rodar("""
     var r = resumoDaMao([{carta: %s}, {carta: %s}, {carta: %s}, {carta: %s}]);
     [r.terrenos, r.feiticos, r.custoMedio, r.cores.G || 0, r.cores.W || 0];
   """ % (json.dumps(FOREST), json.dumps(FOREST), json.dumps(SOL_RING),
          json.dumps(ELVES))),
   [2, 2, 1, 1, 0])

eq("mão só de terreno não divide por zero",
   rodar("""
     var r = resumoDaMao([{carta: %s}]);
     [r.terrenos, r.feiticos, r.custoMedio];
   """ % json.dumps(FOREST)), [1, 0, 0])

eq("híbrido conta pras duas cores",
   rodar("""
     var r = resumoDaMao([{carta: %s}]);
     [r.cores.G || 0, r.cores.W || 0];
   """ % json.dumps(FINKS)), [1, 1])


print("\n--- o campo em três filas ---")

# A ordem das regras é a de `CATEGORIAS`: a primeira que casa ganha, e pra quem
# joga o terreno-criatura é o terreno que entrou no turno.
eq("terreno-criatura conta como terreno",
   rodar('grupoDoCampo({carta: {tipo: "Land Creature — Dryad Arbor"}});'),
   "Terrenos")
eq("criatura é criatura",
   rodar("grupoDoCampo({carta: %s});" % json.dumps(ELVES)), "Criaturas")
eq("o que não é nem um nem outro cai em Outros",
   rodar("grupoDoCampo({carta: %s});" % json.dumps(SOL_RING)), "Outros")
eq("carta que a base não conhece não fica sem fila",
   rodar("grupoDoCampo({carta: null});"), "Outros")


print("\n--- vida ---")

eq("começa em 40, que é a do formato",
   rodar("montarMesa(); estado.mesa.vida;"), 40)
eq("os botões somam e subtraem",
   rodar("montarMesa(); ajustarVida(-5); ajustarVida(1); estado.mesa.vida;"), 36)

# Sete cliques pra ir de 40 a 33 não podem comer sete das vinte fotos: o Ctrl+Z
# seguinte devolveria 34, 35, 36… em vez da jogada que veio antes.
eq("cliques seguidos de vida são UM passo de desfazer",
   rodar("""
     montarMesa(); manterMao();
     estado.mesaDesfazer = [];
     for (var i = 0; i < 3; i++){ gfGuardar("vida"); ajustarVida(-1); }
     [estado.mesaDesfazer.length, estado.mesa.vida];
   """), [1, 37])
eq("e o desfazer volta pra antes da sequência inteira",
   rodar("""
     montarMesa(); manterMao();
     estado.mesaDesfazer = [];
     for (var i = 0; i < 3; i++){ gfGuardar("vida"); ajustarVida(-1); }
     desfazerMesa();
     estado.mesa.vida;
   """), 40)
eq("qualquer outra jogada fecha a sequência",
   rodar("""
     montarMesa(); manterMao();
     estado.mesaDesfazer = [];
     gfGuardar("vida"); ajustarVida(-1);
     gfGuardar(); comprar(1);
     gfGuardar("vida"); ajustarVida(-1);
     estado.mesaDesfazer.length;
   """), 3)


print("\n--- conservação: nenhuma carta some nem duplica ---")

# A asserção central do arquivo. Sequência roteirizada, do mulligan ao
# cemitério, e no fim o multiconjunto tem que ser o mesmo.
resultado = rodar(TODAS + """
  montarMesa();
  var inicial = __todas();
  mulliganLondon();
  mulliganLondon();
  mulliganLondon();
  manterMao();
  mandarPraFundo(estado.mesa.mao[0].uid);
  mandarPraFundo(estado.mesa.mao[0].uid);
  ajustarVida(-7);
  passarTurno();
  gfMover(estado.mesa.mao[0].uid, "campo");
  passarTurno();
  gfMover(estado.mesa.campo[0].uid, "cemiterio");
  gfMover(estado.mesa.mao[0].uid, "exilio");
  passarTurno();
  gfMover(estado.mesa.comando[0].uid, "campo");
  JSON.stringify({inicial: inicial, final: __todas()});
""")
dados = json.loads(resultado)
eq("o multiconjunto é o mesmo do começo ao fim", dados["final"], dados["inicial"])
eq("e o total continua sendo o deck + o comandante",
   len(dados["final"]), NO_BARALHO + 1)

eq("mover nunca deixa um uid em duas zonas",
   rodar(TODAS + """
     montarMesa(); manterMao();
     var uid = estado.mesa.mao[0].uid;
     gfMover(uid, "campo"); gfMover(uid, "cemiterio"); gfMover(uid, "mao");
     __todas().filter(function(x){
       return x.indexOf(uid + ":") === 0; }).length;
   """), 1)

eq("mover pra zona inventada não faz nada (e não perde a carta)",
   rodar(TODAS + """
     montarMesa(); manterMao();
     gfMover(estado.mesa.mao[0].uid, "limbo");
     __todas().length;
   """), NO_BARALHO + 1)


print("\n--- desfazer ---")

eq("desfazer devolve a carta pra mão",
   rodar("""
     montarMesa(); manterMao();
     var antes = estado.mesa.mao.length;
     gfGuardar();
     gfMover(estado.mesa.mao[0].uid, "cemiterio");
     desfazerMesa();
     [estado.mesa.mao.length, estado.mesa.cemiterio.length, antes];
   """), [8, 0, 8])
eq("desfazer com a pilha vazia não quebra",
   rodar("montarMesa(); estado.mesaDesfazer = []; desfazerMesa(); estado.mesa !== null;"),
   True)
eq("a pilha tem teto",
   rodar("""
     montarMesa();
     for (var i = 0; i < 40; i++) gfGuardar();
     estado.mesaDesfazer.length;
   """), 20)


print("\n--- a mesa não vaza pro deck salvo ---")

# Uma mão de goldfish gravada no deck volta três semanas depois, em outra
# máquina, no meio de uma edição.
corpo = json.loads(rodar("""
  montarMesa(); manterMao(); passarTurno();
  JSON.stringify(corpoDoDeck());
"""))
check("corpoDoDeck não conhece a mesa",
      "mesa" not in corpo and "mesaDesfazer" not in corpo)
eq("e continua mandando só o que era pra mandar",
   sorted(corpo.keys()), ["cartas", "categorias", "comandantes", "maybeboard", "nome"])


print("\n--- deck vazio não quebra ---")

eq("sem cartas, o baralho é vazio e a mesa monta mesmo assim",
   rodar("""
     estado.cartas = []; estado.comandantes = [];
     montarMesa();
     [estado.mesa.baralho.length, estado.mesa.mao.length];
   """), [0, 0])
# Entrada com `carta` nula existe: é carta que a base local não conhece.
eq("entrada sem carta na base é ignorada, não vira buraco",
   rodar("""
     estado.cartas = [{carta: null, quantidade: 3, categoria: ""},
                      {carta: %s, quantidade: 2, categoria: ""}];
     baralhoDoDeck().length;
   """ % json.dumps(SOL_RING)), 2)


print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
