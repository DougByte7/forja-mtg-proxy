"""
Confere a régua do câmbio: como a tela do deckbuilder escreve, em real, um
preço que a base local guarda em dólar.

MOTIVO DE EXISTIR. A conversão é de APRESENTAÇÃO, e a única coisa que separa
"aproximação honesta" de "número inventado" é a disciplina de onde ela
acontece. Quatro maneiras de errar isso, e são as quatro que este teste
persegue:

1. **Converter cedo.** Se a taxa entrar em `precoDaEntrada` ou em
   `orcamentoLocal`, ela para de ser régua e vira unidade: o mesmo deck passa
   a valer números diferentes conforme o dólar do dia, e o `data-teto` que
   viaja pro `manabase.py` deixa de casar com o que o servidor filtra.
2. **Taxa ausente virando zero.** `0 × preço` dá "R$ 0,00" em toda carta do
   deck — a mesma mentira que o `—` de `valorHTML` existe pra não contar.
   Sem taxa a tela tem que voltar pra dólar, que é o número que ela tem.
3. **O limiar de "caro" virando real.** Ele é um julgamento sobre a CARTA. Em
   real, a mesma carta entraria e sairia do vermelho conforme o câmbio, sem
   ninguém ter mexido no deck.
4. **O filtro de preço convertendo de um lado só.** O rótulo diz R$ e o valor
   viaja em dólar; se um dos dois esquecer a taxa, o teto passa a valer cinco
   vezes mais (ou menos) do que a pessoa pediu, e nada na tela denuncia.

COMO ELE RODA. Igual ao `test_deckbuilder.py`: o JavaScript da página (os
módulos da página, achatados na ordem em que o navegador os avalia) roda num
interpretador (Duktape, via `dukpy`) sobre um DOM de mentira. Não sobe
servidor, não abre navegador e não vai à rede.

    pip install dukpy
    python tests/test_precos_brl.py

Sai com código 1 se qualquer checagem falhar. Sem o `dukpy` instalado, avisa e
sai com 0, pela mesma razão do outro: ele não é dependência do serviço.
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


# ---------------------------------------------------------------------------
# O aparato: o mesmo do test_deckbuilder.py
# ---------------------------------------------------------------------------

# `abrir()` fica de fora — e é justamente de dentro dele que a página busca a
# taxa, pra este corte continuar valendo. Se `carregarCambio()` subir pro topo
# do script, o `fetch` abaixo levanta e todos os testes de JS param de rodar.
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
    return {"nome": nome, "tipo": tipo, "identidade": ident, "mana_cost": custo,
            "cmc": cmc, "preco_usd": preco, "imagem": "http://arte/" + nome,
            "legal": True, "basico": basico, "ilimitada": False,
            "comandante": False, "parceiro": False}


def entrada(c, quantidade=1, categoria=""):
    return {"carta": c, "quantidade": quantidade, "categoria": categoria}


ATRAXA = carta("Atraxa", "Legendary Creature — Angel", "WUBG",
               "{3}{W}{U}{B}{G}", 7.0, 20.0)
SOL_RING = carta("Sol Ring", "Artifact", "", "{1}", 1.0, 2.0)
RHYSTIC = carta("Rhystic Study", "Enchantment", "U", "{2}{U}", 3.0, 30.0)
SEM_PRECO = carta("Carta Nova", "Artifact", "", "{2}", 2.0, None)
FOREST = carta("Forest", "Basic Land — Forest", "", "", 0.0, 0.1, basico=True)

DECK = [entrada(SOL_RING, 3), entrada(RHYSTIC), entrada(SEM_PRECO),
        entrada(FOREST, 10)]

# 5.43 é uma taxa plausível e com casas que denunciam arredondamento torto.
TAXA = 5.43


def rodar(script, cambio=None):
    """Monta o estado com (ou sem) câmbio, roda `script` e devolve o resultado.

    `cambio=None` é o estado real da tela antes de `GET /cambio` responder —
    não um caso de laboratório."""
    prova = _DOM + _JS + """
    estado.comandantes = %s;
    estado.cartas = %s;
    estado.cambio = %s;
    agendarSalvar = function(){};
    %s
    """ % (json.dumps([ATRAXA]), json.dumps(DECK), json.dumps(cambio), script)
    return dukpy.evaljs(prova)


print("\n--- moeda(): o único ponto de conversão ---")

eq("sem taxa, escreve dólar",
   rodar("moeda(20);"), "US$ 20.00")
eq("com taxa, escreve real com vírgula",
   rodar("moeda(20);", {"valor": TAXA, "fonte": "awesomeapi"}), "R$ 108,60")
eq("taxa zero cai pra dólar, não vira R$ 0,00",
   rodar("moeda(20);", {"valor": 0, "fonte": "fixa"}), "US$ 20.00")
eq("valor zero de verdade continua zero",
   rodar("moeda(0);", {"valor": TAXA, "fonte": "awesomeapi"}), "R$ 0,00")
eq("milhar sai no formato brasileiro",
   rodar("moeda(1000);", {"valor": 5, "fonte": "fixa"}), "R$ 5.000,00")

eq("a nota diz a taxa e que ela é do dia",
   rodar("notaDoCambio();", {"valor": TAXA, "fonte": "awesomeapi"}),
   "Convertido a R$ 5,43 por dólar (câmbio do dia).")
eq("e diz quando é a taxa padrão, que é outra conversa",
   rodar("notaDoCambio();", {"valor": TAXA, "fonte": "fixa"}),
   "Convertido a R$ 5,43 por dólar (taxa padrão do servidor).")
check("sem câmbio, a nota avisa que o número é dólar",
      "dólar" in rodar("notaDoCambio();"))


print("\n--- o que NÃO pode converter ---")

# Se um destes virar real, a taxa deixou de ser régua e virou unidade.
eq("precoDaEntrada continua em dólar",
   rodar("precoDaEntrada(estado.cartas[0]);", {"valor": TAXA, "fonte": "fixa"}),
   6.0)
eq("orcamentoLocal().total continua em dólar",
   rodar("orcamentoLocal().total;", {"valor": TAXA, "fonte": "fixa"}),
   36.0)
eq("e é o MESMO número sem câmbio nenhum",
   rodar("orcamentoLocal().total;"), 36.0)

# O teto viaja pro `manabase.py`, que filtra `preco_usd`. Convertê-lo faria o
# servidor receber 16 onde a pessoa pediu 3.
eq("o data-teto dos chips da mana base sai em dólar",
   rodar("""
     var m = {monocolor:false, teto_usd:3, cores:[], basicos:[], terrenos:{},
              fixadores:{baratos:[], caros:[]}};
     var achou = /data-teto="(\\d+)"/.exec(
       [1,3,10,999].map(function(v){ return 'data-teto="' + v + '"'; })[1]);
     achou[1];
   """, {"valor": TAXA, "fonte": "fixa"}), "3")

eq("o filtro de preço viaja em dólar quando digitado em real",
   round(rodar("precoMaxEmUsd(16);", {"valor": TAXA, "fonte": "fixa"}), 4),
   round(16 / TAXA, 4))
eq("e sem taxa vai como foi digitado",
   rodar("precoMaxEmUsd(16);"), 16)
eq("o símbolo do rótulo acompanha a mesma taxa que a divisão",
   rodar("simboloDaTela();", {"valor": TAXA, "fonte": "fixa"}), "R$")
eq("e volta pra US$ quando não há taxa",
   rodar("simboloDaTela();"), "US$")


print("\n--- valorHTML: o travessão e o vermelho ---")

check("carta sem preço mostra o travessão, com câmbio",
      "—" in rodar("valorHTML(estado.cartas[2]);",
                   {"valor": TAXA, "fonte": "fixa"}))
check("e sem câmbio também",
      "—" in rodar("valorHTML(estado.cartas[2]);"))
check("carta sem preço nunca escreve R$ 0,00",
      "0,00" not in rodar("valorHTML(estado.cartas[2]);",
                          {"valor": TAXA, "fonte": "fixa"}))

# CARO_USD é 20 e o Rhystic custa 30: caro nos dois mundos. O ponto é que ele
# continua caro quando a taxa muda, porque o julgamento é sobre a carta.
for t in (1, 5.43, 50):
    check(f"'caro' não muda com a taxa em {t}",
          "caro" in rodar("valorHTML(estado.cartas[1]);",
                          {"valor": t, "fonte": "fixa"}))
check("e o Sol Ring, de US$ 2, não é caro em taxa nenhuma",
      all("caro" not in rodar("valorHTML(estado.cartas[0]);",
                              {"valor": t, "fonte": "fixa"})
          for t in (1, 5.43, 50)))
check("o valor convertido carrega a nota do câmbio no title",
      "5,43" in rodar("valorHTML(estado.cartas[0]);",
                      {"valor": TAXA, "fonte": "awesomeapi"}))


print("\n--- a prévia do orçamento no cabeçalho ---")

eq("sem cotação, o cabeçalho mostra a soma local convertida",
   rodar("""
     desenharPreviaOrcamento();
     document.getElementById("total-n").textContent;
   """, {"valor": TAXA, "fonte": "fixa"}), "R$ 195,48")
eq("sem taxa, o mesmo deck em dólar — e sem o 'US$ $' de antes",
   rodar("""
     desenharPreviaOrcamento();
     document.getElementById("total-n").textContent;
   """), "US$ 36.00")

# Cotado, o número já vem na moeda da fonte: passar pela régua converteria
# duas vezes o que a LigaMagic já entregou em real.
eq("cotado em BRL, o total da fonte passa intacto",
   rodar("""
     estado.cotacao = {fontes:[{rotulo:"LigaMagic", moeda:"BRL", total:250.5,
                                cartas_cotadas: 4}]};
     desenharPreviaOrcamento();
     document.getElementById("total-n").textContent;
   """, {"valor": TAXA, "fonte": "fixa"}), "R$ 250,50")
eq("cotado em USD, idem — sem multiplicar pela taxa",
   rodar("""
     estado.cotacao = {fontes:[{rotulo:"Scryfall", moeda:"USD", total:40.0,
                                cartas_cotadas: 4}]};
     desenharPreviaOrcamento();
     document.getElementById("total-n").textContent;
   """, {"valor": TAXA, "fonte": "fixa"}), "US$ 40,00")


print("\n--- o preço da loja ganha do preço convertido ---")

# A cotação é automática e fica em cache, então na prática ela já está ali
# quando a lista desenha. Preço medido em loja brasileira é melhor que preço
# velho de outro mercado multiplicado por uma taxa aproximada.
COTACAO = {
    "fontes": [{"id": "ligamagic", "rotulo": "LigaMagic", "moeda": "BRL",
                "total": 120.0, "cartas_cotadas": 2}],
    "linhas": [
        {"nome": "Sol Ring", "quantidade": 3,
         "precos": {"ligamagic": {"preco_unitario": 7.5, "loja": "Loja X"}}},
        # A loja não tem esta: volta com erro, e a linha cai na base.
        {"nome": "Rhystic Study", "quantidade": 1,
         "precos": {"ligamagic": {"erro": "sem resultado"}}},
    ],
}


def com_cotacao(script):
    return rodar("estado.cotacao = %s;\n%s" % (json.dumps(COTACAO), script),
                 {"valor": TAXA, "fonte": "fixa"})


eq("carta cotada usa o preço da loja, não a base convertida",
   com_cotacao("precoUnitario(estado.cartas[0].carta).valor;"), 7.5)
eq("e diz que veio da cotação",
   com_cotacao("precoUnitario(estado.cartas[0].carta).fonte;"), "cotacao")
eq("carta que a loja não achou cai na base",
   com_cotacao("precoUnitario(estado.cartas[1].carta).fonte;"), "base")
eq("comandante e básico, que nunca são cotados, também caem na base",
   com_cotacao("precoUnitario(estado.cartas[3].carta).fonte;"), "base")

# O preço da loja JÁ é real. Passá-lo pela régua converteria duas vezes — é o
# mesmo erro que o total do cabeçalho evita.
eq("o preço da loja não é multiplicado pela taxa",
   com_cotacao("precoTexto(precoUnitario(estado.cartas[0].carta));"), "R$ 7,50")
eq("e a quantidade multiplica só ele",
   com_cotacao("precoTexto(precoUnitario(estado.cartas[0].carta), 3);"), "R$ 22,50")
eq("o da base continua passando pela régua",
   com_cotacao("precoTexto(precoUnitario(estado.cartas[1].carta));"), "R$ 162,90")

check("a linha cotada não leva o tracejado de estimativa",
      "estimado" not in com_cotacao("valorHTML(estado.cartas[0]);"))
check("a linha da base leva",
      "estimado" in com_cotacao("valorHTML(estado.cartas[1]);"))
check("e a linha cotada nomeia a loja no title",
      "Loja X" in com_cotacao("valorHTML(estado.cartas[0]);"))

# "Caro" tem um limiar por mercado. R$ 7,50 na loja não é caro; US$ 30 na base
# é. Os dois convivem na mesma lista sem um contaminar o outro.
check("R$ 7,50 cotado não é caro",
      "caro" not in com_cotacao("valorHTML(estado.cartas[0]);"))
check("US$ 30 na base é caro",
      "caro" in com_cotacao("valorHTML(estado.cartas[1]);"))


print("\n--- o subtotal do grupo não soma moedas diferentes ---")

# Com câmbio: tudo em real. O cotado entra intacto, o da base é convertido.
eq("com câmbio, soma tudo em real",
   com_cotacao("""
     var s = subtotalDoGrupo([estado.cartas[0], estado.cartas[1]]);
     subtotalTexto(s);
   """), "R$ 185,40")
eq("e conta quantas são medidas e quantas são estimativa",
   com_cotacao("""
     var s = subtotalDoGrupo([estado.cartas[0], estado.cartas[1]]);
     [s.medidas, s.estimadas].join("/");
   """), "3/1")

# Sem câmbio não dá pra somar real com dólar, e converter de volta exigiria a
# mesma taxa que falta. O que está em real fica FORA da soma, e é contado.
eq("sem câmbio, o que está em real fica fora da soma",
   rodar("estado.cotacao = %s;\n%s" % (json.dumps(COTACAO), """
     var s = subtotalDoGrupo([estado.cartas[0], estado.cartas[1]]);
     [subtotalTexto(s), s.foraDaSoma].join(" | ");
   """)), "US$ 30.00 | 3")
check("e o title avisa que ficou de fora",
      "fora da soma" in rodar("estado.cotacao = %s;\n%s" % (json.dumps(COTACAO), """
        subtotalTitulo(subtotalDoGrupo([estado.cartas[0], estado.cartas[1]]));
      """)))

eq("carta sem preço nenhum é contada, não somada",
   com_cotacao("subtotalDoGrupo([estado.cartas[2]]).sem;"), 1)


print("\n--- os preços de referência da modal ---")

# Quatro moedas de quatro mercados. Uma taxa de dólar não fala por euro nem
# por tix, e o rótulo de cada chip já diz em que moeda o número está.
html = rodar("""
  precosHTML({precos:{usd:"2.50", eur:"1.80", tix:"0.03"}});
""", {"valor": TAXA, "fonte": "fixa"})
check("o preço em dólar da Scryfall não é convertido", "2.50" in html)
check("nem o em euro", "1.80" in html)
check("e nenhum chip vira R$", "R$" not in html)


print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
