"""
Confere o simulador de goldfish do deckbuilder.

MOTIVO DE EXISTIR. Este é o único lugar da tela que MOVE cartas entre zonas, e
o jeito de ele quebrar é silencioso: uma carta some, ou aparece duas vezes, e
a mesa continua desenhando normalmente. Um goldfish que duplica carta MENTE
sobre o deck — a pessoa conclui que a mão anda quando ela não anda, que é
exatamente o oposto do que a ferramenta existe pra responder.

Seis coisas que este teste persegue:

1. **A conservação das cartas.** Depois de qualquer sequência de jogadas, a
   soma das zonas de todos os jogadores tem que ser o mesmo multiconjunto do
   começo. É a única asserção que pega Fisher-Yates escrito errado, `splice`
   com índice torto e `gfMover` deixando o mesmo uid em duas zonas.
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
5. **A carta volta pra zona do DONO.** Com dois decks na mesa, matar a criatura
   do outro manda ela pro cemitério dele. Sem isso as listas deixam de fechar
   por jogador e a conservação vira uma soma que esconde a troca.
6. **A fotografia do desfazer não leva as cartas.** Ela guarda o estado e
   religa as cartas pelo registro na volta — se a religação falhar, a mesa
   volta cheia de buracos, e é o tipo de erro que só aparece três jogadas
   depois.

COMO ELE RODA. Igual ao `test_deckbuilder.py`: o JavaScript da página (os
módulos da página, achatados na ordem em que o navegador os avalia) roda num
interpretador (Duktape, via `dukpy`) sobre um DOM de mentira. As regras da mesa
(`goldfish.js`) não tocam em DOM nenhum — é por isso que dá pra testá-las
assim. Não sobe servidor, não abre navegador e não vai à rede.

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
KRENKO = carta("Krenko", "Legendary Creature — Goblin", "R", "{2}{R}", 3.0)
FOREST = carta("Forest", "Basic Land — Forest", "G", "", 0.0)
MOUNTAIN = carta("Mountain", "Basic Land — Mountain", "R", "", 0.0)
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

# O segundo deck, montado à mão como `porSegundoDeck` o recebe.
DECK2 = """{nome: "Deck do outro", comandantes: [%s],
            entradas: [{carta: %s, quantidade: 6},
                       {carta: %s, quantidade: 2}]}""" % (
    json.dumps(KRENKO), json.dumps(MOUNTAIN), json.dumps(BOLT))
NO_BARALHO2 = 8


def rodar(script):
    prova = _DOM + _JS + """
    estado.comandantes = %s;
    estado.cartas = %s;
    estado.maybe = %s;
    estado.nome = "Meu deck";
    agendarSalvar = function(){};
    function __mesa(){ return montarMesa([deckDaTela()]); }
    function __j(i){ return estado.mesa.jogadores[i || 0]; }
    %s
    """ % (json.dumps([ATRAXA]), json.dumps(DECK), json.dumps(MAYBE), script)
    return dukpy.evaljs(prova)


# Devolve as cartas de todas as zonas de todos os jogadores, achatadas, pra
# comparar multiconjuntos.
TODAS = """
  function __todas(){
    var saida = [];
    estado.mesa.jogadores.forEach(function(j){
      ["baralho","mao","campo","cemiterio","exilio","comando"].forEach(function(z){
        j[z].forEach(function(c){ saida.push(c.uid + ":" + c.carta.nome); });
      });
    });
    return saida.sort();
  }
"""

print("\n--- o baralho é o deck certo ---")

eq("o baralho tem as cartas contadas menos o comandante",
   rodar("__mesa(); __j().baralho.length + __j().mao.length;"), NO_BARALHO)
check("e nunca contém o comandante",
      rodar("""
        __mesa();
        __j().baralho.filter(function(c){ return c.carta.nome === "Atraxa"; }).length;
      """) == 0)
check("nem o sideboard",
      rodar("""
        __mesa();
        __j().baralho.filter(function(c){
          return c.carta.nome === "Swords to Plowshares"; }).length;
      """) == 0)
check("nem o maybeboard",
      rodar("""
        __mesa();
        __j().baralho.filter(function(c){
          return c.carta.nome === "Lightning Bolt"; }).length;
      """) == 0)
eq("o comandante vai pra zona de comando",
   rodar("__mesa(); __j().comando.map(function(c){return c.carta.nome;});"),
   ["Atraxa"])
eq("e ele é marcado como comandante, que é o que o resumo lê",
   rodar("__mesa(); __j().comando[0].cmd;"), True)

# Trinta Florestas são trinta objetos. Referência compartilhada faz deitar uma
# deitar as trinta.
eq("cada cópia tem identidade própria",
   rodar("""
     __mesa();
     var uids = {};
     __j().baralho.concat(__j().mao).forEach(function(c){ uids[c.uid] = 1; });
     Object.keys(uids).length;
   """), NO_BARALHO)
eq("e deitar uma não deita as outras",
   rodar("""
     __mesa();
     var florestas = __j().baralho.filter(function(c){
       return c.carta.nome === "Forest"; });
     florestas[0].deitada = true;
     florestas.filter(function(c){ return c.deitada; }).length;
   """), 1)


print("\n--- embaralhar é permutação ---")

# Fisher-Yates escrito errado perde ou duplica elemento em silêncio.
eq("o mesmo multiconjunto entra e sai",
   rodar(TODAS + """
     __mesa();
     var antes = __todas().join(",");
     embaralharBaralho(0);
     antes === __todas().join(",");
   """), True)


print("\n--- mão de abertura ---")

eq("compra 7", rodar("__mesa(); __j().mao.length;"), 7)
eq("e o baralho encolhe na mesma medida",
   rodar("__mesa(); __j().baralho.length;"), NO_BARALHO - 7)
eq("começa na fase de mulligan", rodar("__mesa(); __j().fase;"), "mulligan")
eq("e a mesa começa no turno 1, com o primeiro jogador",
   rodar("__mesa(); [estado.mesa.turno, estado.mesa.ativo];"), [1, 0])


print("\n--- mulligan London, primeiro grátis (regra do Commander) ---")

# A mão fica com 8: as 7 mais a compra do turno 1, que é a outra regra do
# formato (ver a seção da compra do turno 1, mais abaixo).
eq("manter sem mulligan nenhum: mão de 8, nada pro fundo",
   rodar("__mesa(); manterMao(0); [__j().mao.length, __j().aFundo];"), [8, 0])
eq("e vai direto pro jogo, sem pedir escolha",
   rodar("__mesa(); manterMao(0); __j().fase;"), "jogo")

eq("1 mulligan: ainda 8 na mão e nada pro fundo — o primeiro é grátis",
   rodar("__mesa(); mulliganLondon(0); manterMao(0); [__j().mao.length, __j().aFundo];"),
   [8, 0])
eq("2 mulligans: devolve 1",
   rodar("""
     __mesa(); mulliganLondon(0); mulliganLondon(0); manterMao(0);
     [__j().mao.length, __j().aFundo, __j().fase];
   """), [7, 1, "fundo"])
eq("3 mulligans: devolve 2",
   rodar("""
     __mesa(); mulliganLondon(0); mulliganLondon(0); mulliganLondon(0);
     manterMao(0); __j().aFundo;
   """), 2)

eq("depois de mandar as escolhidas pro fundo, a mão fica com 6 — 5 mais a do turno 1",
   rodar("""
     __mesa();
     mulliganLondon(0); mulliganLondon(0); mulliganLondon(0);
     manterMao(0);
     mandarPraFundo(__j().mao[0].uid);
     mandarPraFundo(__j().mao[0].uid);
     [__j().mao.length, __j().fase];
   """), [6, "jogo"])

eq("e elas foram pro FUNDO, não pro topo",
   rodar("""
     __mesa(); mulliganLondon(0); mulliganLondon(0); manterMao(0);
     var escolhida = __j().mao[0].uid;
     mandarPraFundo(escolhida);
     __j().baralho[__j().baralho.length - 1].uid === escolhida;
   """), True)

eq("cada mulligan reembaralha tudo: o baralho volta a ter 15 menos a mão",
   rodar("__mesa(); mulliganLondon(0); __j().baralho.length + __j().mao.length;"),
   NO_BARALHO)

# Deck pequeno é o caso deste teste, mas também o de quem está montando: pedir
# pra devolver mais cartas do que a mão tem deixaria a fase de fundo sem fim.
eq("nunca pede pro fundo mais do que a mão tem",
   rodar("""
     __mesa();
     for (var i = 0; i < 12; i++) mulliganLondon(0);
     __j().mao = __j().mao.slice(0, 3);
     manterMao(0);
     [__j().aFundo, __j().mao.length];
   """), [3, 3])


print("\n--- a compra do turno 1 (regra do Commander) ---")

# No Commander quem começa jogando COMPRA — é o duelo de dois que tira essa
# compra do primeiro jogador. A mesa adianta essa compra pro fim do mulligan.
eq("a mão confirmada traz a carta do turno 1, e ela sai do baralho",
   rodar("__mesa(); manterMao(0); [__j().mao.length, __j().baralho.length];"),
   [8, NO_BARALHO - 8])

eq("a carta extra vem DEPOIS das que voltam pro fundo",
   rodar("""
     __mesa(); mulliganLondon(0); mulliganLondon(0); manterMao(0);
     var devolvida = __j().mao[0].uid;
     mandarPraFundo(devolvida);
     [__j().mao.length,
      __j().mao.filter(function(c){ return c.uid === devolvida; }).length];
   """), [7, 0])

eq("e ela é uma só: o turno 2 compra mais uma, não duas",
   rodar("__mesa(); manterMao(0); passarTurno(); __j().mao.length;"), 9)


print("\n--- turnos ---")

eq("passar turno compra 1 e anda o número do turno",
   rodar("""
     __mesa(); manterMao(0);
     var antes = __j().mao.length;
     passarTurno();
     [estado.mesa.turno, __j().mao.length - antes];
   """), [2, 1])
eq("e endireita o que estava deitado",
   rodar("""
     __mesa(); manterMao(0);
     gfMover(__j().mao[0].uid, "campo");
     __j().campo[0].deitada = true;
     passarTurno();
     __j().campo[0].deitada;
   """), False)
eq("o contador de terrenos do turno zera",
   rodar("__mesa(); manterMao(0); __j().terrenosBaixados = 3; passarTurno();"
         "__j().terrenosBaixados;"), 0)

# Conta, não impede: é a decisão central desta tela.
eq("baixar dois terrenos no mesmo turno é permitido, e contado",
   rodar("""
     __mesa(); manterMao(0);
     /* põe duas florestas na mão, na marra, pra o teste não depender do sorteio */
     var flor = __j().baralho.filter(function(c){
       return c.carta.nome === "Forest"; }).slice(0, 2);
     flor.forEach(function(c){ gfMover(c.uid, "mao"); });
     flor.forEach(function(c){ gfMover(c.uid, "campo"); });
     [__j().terrenosBaixados, __j().campo.length];
   """), [2, 2])


print("\n--- dois decks na mesa ---")

eq("o segundo deck entra com a mão dele, sem mexer no primeiro",
   rodar("""
     __mesa(); manterMao(0);
     var antes = __j(0).mao.length;
     porSegundoDeck(%s);
     [estado.mesa.jogadores.length, __j(1).mao.length, __j(1).fase,
      __j(0).mao.length === antes];
   """ % DECK2), [2, 7, "mulligan", True])

eq("cada um tem o seu contador de mulligan",
   rodar("""
     __mesa(); porSegundoDeck(%s);
     mulliganLondon(1); mulliganLondon(1);
     [__j(0).mulligans, __j(1).mulligans, devolveAoManterDe(0), devolveAoManterDe(1)];
   """ % DECK2), [0, 2, 0, 1])

eq("a vez alterna, e o turno só anda quando volta pro primeiro",
   rodar("""
     __mesa(); porSegundoDeck(%s);
     var passos = [];
     for (var i = 0; i < 4; i++){
       passarTurno();
       passos.push(estado.mesa.turno + ":" + estado.mesa.ativo);
     }
     passos.join(" ");
   """ % DECK2), "1:1 2:0 2:1 3:0")

eq("passar turno endireita só quem está jogando",
   rodar("""
     __mesa(); manterMao(0); porSegundoDeck(%s); manterMao(1);
     gfMover(__j(0).mao[0].uid, "campo"); __j(0).campo[0].deitada = true;
     gfMover(__j(1).mao[0].uid, "campo"); __j(1).campo[0].deitada = true;
     passarTurno();   /* vez do segundo */
     [__j(0).campo[0].deitada, __j(1).campo[0].deitada];
   """ % DECK2), [True, False])

# A criatura do outro que morre vai pro cemitério DELE.
eq("a carta volta pra zona do dono, não de quem a moveu",
   rodar("""
     __mesa(); manterMao(0); porSegundoDeck(%s); manterMao(1);
     var dele = __j(1).mao[0].uid;
     gfMover(dele, "campo");
     gfMover(dele, "cemiterio");
     [__j(0).cemiterio.length, __j(1).cemiterio.length];
   """ % DECK2), [0, 1])

eq("tirar o segundo deck devolve a mesa pra um jogador",
   rodar("""
     __mesa(); porSegundoDeck(%s); passarTurno();
     tirarSegundoDeck();
     [estado.mesa.jogadores.length, estado.mesa.ativo];
   """ % DECK2), [1, 0])

eq("a resposta do servidor vira deck sem o sideboard",
   rodar("""
     var d = deckDaResposta({deck: {nome: "Do servidor",
       comandantes_completos: [%s],
       cartas_completas: [{carta: %s, quantidade: 3, categoria: ""},
                          {carta: %s, quantidade: 2, categoria: "Sideboard"},
                          {carta: null, quantidade: 9, categoria: ""}]}});
     [d.nome, d.comandantes.length, d.entradas.length, d.entradas[0].quantidade];
   """ % (json.dumps(KRENKO), json.dumps(MOUNTAIN), json.dumps(BOLT))),
   ["Do servidor", 1, 1, 3])


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
   rodar("var r = resumoDaMao([{carta: %s}]); [r.terrenos, r.feiticos, r.custoMedio];"
         % json.dumps(FOREST)), [1, 0, 0])

eq("híbrido conta pras duas cores",
   rodar("var r = resumoDaMao([{carta: %s}]); [r.cores.G || 0, r.cores.W || 0];"
         % json.dumps(FINKS)), [1, 1])


print("\n--- o campo em três filas ---")

# A ordem das regras é a de `CATEGORIAS`: a primeira que casa ganha, e pra quem
# joga o terreno-criatura é o terreno que entrou no turno.
eq("terreno-criatura conta como terreno",
   rodar('grupoDoCampo({carta: {tipo: "Land Creature — Dryad Arbor"}});'), "Terrenos")
eq("criatura é criatura",
   rodar("grupoDoCampo({carta: %s});" % json.dumps(ELVES)), "Criaturas")
eq("o que não é nem um nem outro cai em Outros",
   rodar("grupoDoCampo({carta: %s});" % json.dumps(SOL_RING)), "Outros")
eq("carta que a base não conhece não fica sem fila",
   rodar("grupoDoCampo({carta: null});"), "Outros")


print("\n--- vida, marcadores e dano de comandante ---")

eq("a vida começa em 40, que é a do formato", rodar("__mesa(); __j().vida;"), 40)
eq("os botões somam e subtraem",
   rodar("__mesa(); ajustarVida(0, -5); ajustarVida(0, 1); __j().vida;"), 36)

eq("marcador de jogador sobe, desce e some no zero",
   rodar("""
     __mesa();
     ajustarMarca(0, "veneno", 3);
     var tres = __j().marcas["veneno"];
     ajustarMarca(0, "veneno", -3);
     [tres, Object.keys(__j().marcas).length];
   """), [3, 0])
eq("e nunca fica negativo",
   rodar("__mesa(); ajustarMarca(0, 'energia', 1); ajustarMarca(0, 'energia', -5);"
         "Object.keys(__j().marcas).length;"), 0)

eq("marcador de carta mora na carta",
   rodar("""
     __mesa(); manterMao(0);
     var uid = __j().mao[0].uid;
     gfMover(uid, "campo");
     ajustarMarcaCarta(uid, "+1/+1", 2);
     cartaPorUid(uid).marcas["+1/+1"];
   """), 2)
eq("e some quando a carta sai do campo",
   rodar("""
     __mesa(); manterMao(0);
     var uid = __j().mao[0].uid;
     gfMover(uid, "campo");
     ajustarMarcaCarta(uid, "+1/+1", 2);
     gfMover(uid, "cemiterio");
     Object.keys(cartaPorUid(uid).marcas).length;
   """), 0)

eq("dano de comandante é contado por origem",
   rodar("""
     __mesa(); porSegundoDeck(%s);
     ajustarDanoCmd(0, 1, 7); ajustarDanoCmd(0, 1, 7);
     [__j(0).danoCmd[1], __j(0).danoCmd[0]];
   """ % DECK2), [14, 0])


print("\n--- fichas ---")

eq("a ficha nasce no campo do jogador",
   rodar("""
     __mesa(); manterMao(0);
     criarFicha(0, {nome: "Soldado", poder: "1", resistencia: "1", cores: ["W"]}, 3);
     [__j().campo.length, __j().campo[0].carta.nome, __j().campo[0].ficha];
   """), [3, "Soldado", True])

# Ficha que vai pro cemitério não existe mais: um cemitério com três Soldados
# mentiria sobre o que dá pra devolver de lá.
eq("e deixa de existir ao sair do campo",
   rodar(TODAS + """
     __mesa(); manterMao(0);
     criarFicha(0, {nome: "Soldado"}, 1);
     var uid = __j().campo[0].uid;
     var antes = __todas().length;
     gfMover(uid, "cemiterio");
     [antes, __todas().length, __j().cemiterio.length];
   """), [NO_BARALHO + 2, NO_BARALHO + 1, 0])

eq("a ficha não entra na conta do resumo do fim",
   rodar("""
     __mesa(); manterMao(0);
     criarFicha(0, {nome: "Soldado"}, 2);
     resumoDaPartida()[0].feiticosNoDeck;
   """), NO_BARALHO - 10)   # 15 menos as 10 florestas


print("\n--- combate ---")

eq("atacar e bloquear são marcas na carta",
   rodar("""
     __mesa(); manterMao(0); porSegundoDeck(%s); manterMao(1);
     var meu = __j(0).mao[0].uid, dele = __j(1).mao[0].uid;
     gfMover(meu, "campo"); gfMover(dele, "campo");
     alternarAtaque(meu);
     definirBloqueio(dele, meu);
     [cartaPorUid(meu).atacando, cartaPorUid(dele).bloqueando === meu,
      atacantes().length];
   """ % DECK2), [True, True, 1])
eq("bloquear duas vezes o mesmo atacante desmarca",
   rodar("""
     __mesa(); manterMao(0); porSegundoDeck(%s); manterMao(1);
     var meu = __j(0).mao[0].uid, dele = __j(1).mao[0].uid;
     gfMover(meu, "campo"); gfMover(dele, "campo");
     alternarAtaque(meu);
     definirBloqueio(dele, meu); definirBloqueio(dele, meu);
     cartaPorUid(dele).bloqueando;
   """ % DECK2), None)
eq("passar o turno limpa o combate",
   rodar("""
     __mesa(); manterMao(0);
     var meu = __j(0).mao[0].uid;
     gfMover(meu, "campo");
     alternarAtaque(meu);
     passarTurno();
     [cartaPorUid(meu).atacando, atacantes().length];
   """), [False, 0])


print("\n--- conservação: nenhuma carta some nem duplica ---")

# A asserção central do arquivo. Sequência roteirizada, com dois decks na mesa,
# do mulligan ao cemitério, e no fim o multiconjunto tem que ser o mesmo.
resultado = rodar(TODAS + """
  __mesa();
  porSegundoDeck(%s);
  var inicial = __todas();
  mulliganLondon(0);
  mulliganLondon(0);
  mulliganLondon(0);
  manterMao(0);
  mandarPraFundo(__j(0).mao[0].uid);
  mandarPraFundo(__j(0).mao[0].uid);
  manterMao(1);
  ajustarVida(0, -7);
  passarTurno();
  gfMover(__j(1).mao[0].uid, "campo");
  passarTurno();
  gfMover(__j(0).mao[0].uid, "campo");
  gfMover(__j(0).campo[0].uid, "cemiterio");
  gfMover(__j(1).mao[0].uid, "exilio");
  passarTurno();
  lancarComandante(__j(0).comando[0].uid);
  JSON.stringify({inicial: inicial, final: __todas()});
""" % DECK2)
dados = json.loads(resultado)
eq("o multiconjunto é o mesmo do começo ao fim", dados["final"], dados["inicial"])
eq("e o total continua sendo os dois decks mais os comandantes",
   len(dados["final"]), NO_BARALHO + NO_BARALHO2 + 2)

eq("mover nunca deixa um uid em duas zonas",
   rodar(TODAS + """
     __mesa(); manterMao(0);
     var uid = __j().mao[0].uid;
     gfMover(uid, "campo"); gfMover(uid, "cemiterio"); gfMover(uid, "mao");
     __todas().filter(function(x){ return x.indexOf(uid + ":") === 0; }).length;
   """), 1)

eq("mover pra zona inventada não faz nada (e não perde a carta)",
   rodar(TODAS + """
     __mesa(); manterMao(0);
     gfMover(__j().mao[0].uid, "limbo");
     __todas().length;
   """), NO_BARALHO + 1)

eq("o imposto do comandante conta, e não cobra",
   rodar("""
     __mesa(); manterMao(0);
     lancarComandante(__j().comando[0].uid);
     gfMover(__j().campo[0].uid, "comando");
     lancarComandante(__j().comando[0].uid);
     [__j().impostoPago, __j().campo.length, __j().turnoDoComandante];
   """), [2, 1, 1])


print("\n--- desfazer ---")

eq("desfazer devolve a carta pra mão",
   rodar("""
     __mesa(); manterMao(0);
     var antes = __j().mao.length;
     guardarMesa();
     gfMover(__j().mao[0].uid, "cemiterio");
     desfazerUmPasso();
     [__j().mao.length, __j().cemiterio.length, antes];
   """), [8, 0, 8])

# A foto guarda o estado e religa as cartas pelo registro: sem a religação a
# mesa volta cheia de buracos, e o estrago só aparece três jogadas depois.
eq("e as cartas voltam inteiras, não como buraco",
   rodar("""
     __mesa(); manterMao(0);
     guardarMesa();
     gfMover(__j().mao[0].uid, "exilio");
     desfazerUmPasso();
     __j().mao.filter(function(c){ return c.carta && c.carta.nome; }).length;
   """), 8)
eq("e a foto não leva as cartas dentro",
   rodar("""
     __mesa(); guardarMesa();
     estado.mesaDesfazer[0].indexOf("Llanowar Elves") >= 0;
   """), False)

eq("desfazer com a pilha vazia não quebra",
   rodar("__mesa(); estado.mesaDesfazer = []; desfazerUmPasso(); estado.mesa !== null;"),
   True)
eq("a pilha tem teto",
   rodar("__mesa(); for (var i = 0; i < 40; i++) guardarMesa(); "
         "estado.mesaDesfazer.length;"), 20)

# Sete cliques pra ir de 40 a 33 não podem comer sete das vinte fotos: o Ctrl+Z
# seguinte devolveria 34, 35, 36… em vez da jogada que veio antes.
eq("cliques seguidos do mesmo gesto são UM passo de desfazer",
   rodar("""
     __mesa(); manterMao(0);
     estado.mesaDesfazer = [];
     for (var i = 0; i < 3; i++){ guardarMesa("vida0"); ajustarVida(0, -1); }
     [estado.mesaDesfazer.length, __j().vida];
   """), [1, 37])
eq("e o desfazer volta pra antes da sequência inteira",
   rodar("""
     __mesa(); manterMao(0);
     estado.mesaDesfazer = [];
     for (var i = 0; i < 3; i++){ guardarMesa("vida0"); ajustarVida(0, -1); }
     desfazerUmPasso();
     __j().vida;
   """), 40)
eq("qualquer outra jogada fecha a sequência",
   rodar("""
     __mesa(); manterMao(0);
     estado.mesaDesfazer = [];
     guardarMesa("vida0"); ajustarVida(0, -1);
     guardarMesa(); comprar(0, 1);
     guardarMesa("vida0"); ajustarVida(0, -1);
     estado.mesaDesfazer.length;
   """), 3)


print("\n--- log e resumo do fim ---")

eq("o log anota as jogadas com o turno em que aconteceram",
   rodar("""
     __mesa(); manterMao(0); passarTurno();
     var ultimo = estado.mesa.log[estado.mesa.log.length - 1];
     [estado.mesa.log.length > 2, ultimo.turno];
   """), [True, 2])

eq("o resumo diz em que turno o comandante desceu",
   rodar("""
     __mesa(); manterMao(0); passarTurno(); passarTurno();
     lancarComandante(__j().comando[0].uid);
     resumoDaPartida()[0].turnoDoComandante;
   """), 3)
eq("e diz 'nunca' quando ele não desceu",
   rodar("__mesa(); manterMao(0); resumoDaPartida()[0].turnoDoComandante;"), None)

eq("a curva teórica é o deck sem terreno nem comandante",
   rodar("""
     __mesa(); manterMao(0);
     var r = resumoDaPartida()[0];
     /* 1 Sol Ring + 4 Elves, todos de custo 1 */
     [r.teorica[1], r.feiticosNoDeck, r.teorica[0]];
   """), [5, 5, 0])
eq("a realizada conta o que de fato desceu pro campo",
   rodar("""
     __mesa(); manterMao(0);
     var elfo = __j().baralho.filter(function(c){
       return c.carta.nome === "Llanowar Elves"; })[0];
     gfMover(elfo.uid, "campo");
     var flor = __j().baralho.filter(function(c){
       return c.carta.nome === "Forest"; })[0];
     gfMover(flor.uid, "campo");
     var r = resumoDaPartida()[0];
     [r.realizada[1], r.feiticosJogados, r.terrenosJogados];
   """), [1, 1, 1])
eq("e as não puxadas são o que sobrou no baralho",
   rodar("""
     __mesa(); manterMao(0);
     var r = resumoDaPartida()[0];
     [r.naoPuxadas, r.restante.length];
   """), [NO_BARALHO - 8, NO_BARALHO - 8])


print("\n--- a mesa não vaza pro deck salvo ---")

# Uma mão de goldfish gravada no deck volta três semanas depois, em outra
# máquina, no meio de uma edição.
corpo = json.loads(rodar("""
  __mesa(); manterMao(0); passarTurno();
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
     __mesa();
     [__j().baralho.length, __j().mao.length];
   """), [0, 0])
# Entrada com `carta` nula existe: é carta que a base local não conhece.
eq("entrada sem carta na base é ignorada, não vira buraco",
   rodar("""
     estado.cartas = [{carta: null, quantidade: 3, categoria: ""},
                      {carta: %s, quantidade: 2, categoria: ""}];
     estado.comandantes = [];
     __mesa();
     __j().baralho.length + __j().mao.length;
   """ % json.dumps(SOL_RING)), 2)


print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
