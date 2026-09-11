/* ---------------------------------------------------------------- utilidades */

import {$, escapar} from "../comum/dom.js";
import {CATEGORIA_SIDEBOARD, CATEGORIAS, CATEGORIAS_FORA_DA_CONTA, CORES,
        estado, NOME_COR} from "./estado.js";
import {moeda} from "./preco.js";

export function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("mostra");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("mostra"), 2200);
}

export function identidadeDoDeck(){
  const cores = new Set();
  estado.comandantes.forEach(c => (c.identidade||"").split("").forEach(x => cores.add(x)));
  return CORES.filter(c => cores.has(c)).join("");
}

/* As cartas que valem pras 100. Toda conta sobre "o deck" passa por aqui:
   contador, curva, distribuição, assinatura pros combos. O sideboard fica de
   fora, e o maybeboard nem está nesta lista. */
export function cartasContadas(){
  return estado.cartas.filter(e => !foraDaConta(e));
}

function foraDaConta(entrada){
  return CATEGORIAS_FORA_DA_CONTA.has(entrada.categoria || "");
}

export function totalCartas(){
  return estado.comandantes.length +
         cartasContadas().reduce((n, e) => n + e.quantidade, 0);
}

/* A categoria automática, a que sai do tipo da carta. */
export function categoriaAutomatica(carta){
  const t = ((carta && carta.tipo) || "").toLowerCase();
  for (const [nome, casa] of CATEGORIAS) if (casa(t)) return nome;
  return "Outros";
}

/* Onde a carta é desenhada. A escolhida à mão ganha da automática — é o
   único jeito de "combo principal" existir, já que nenhum type_line diz
   isso. */
export function categoriaDe(entrada){
  return (entrada && entrada.categoria) || categoriaAutomatica(entrada?.carta);
}

/* A ordem dos grupos na lista, e ela conta uma história: primeiro o que a
   pessoa decidiu (as categorias próprias, na ordem em que ela as pôs),
   depois o que a carta é (os tipos), e por último o que está fora da conta.
   O contrário — tipos primeiro — enterraria a organização que ela fez no
   meio de nove grupos automáticos. */
export function ordemDasCategorias(entradas){
  const usadas = new Set(entradas.map(categoriaDe));
  const automaticas = CATEGORIAS.map(c => c[0]).concat(["Outros"]);
  const proprias = estado.categorias.filter(c => !automaticas.includes(c));
  const ordem = [
    ...proprias,
    ...automaticas.filter(c => usadas.has(c)),
    ...[...CATEGORIAS_FORA_DA_CONTA].filter(c => usadas.has(c)),
  ];
  // Rede de segurança, e ela não é teórica: uma carta pode carregar uma
  // categoria que a lista não tem (um deck salvo por uma versão anterior, um
  // Ctrl+Z pra antes da categoria existir). Sem isto o grupo dela não seria
  // desenhado e a carta SUMIRIA da tela — continuando no deck, no contador e
  // na cotação. Uma carta invisível que se paga é o pior estrago possível
  // aqui, e custa uma linha evitá-lo.
  for (const cat of usadas) if (!ordem.includes(cat)) ordem.push(cat);
  return ordem;
}

/* Toda categoria que a tela sabe oferecer no menu, própria ou não. */
export function todasAsCategorias(){
  return [...estado.categorias,
          ...CATEGORIAS.map(c => c[0]), "Outros", CATEGORIA_SIDEBOARD];
}

export function ehPropria(cat){
  return estado.categorias.includes(cat);
}

/* As duas listas pelo nome que o resto do código usa pra falar delas. */
export function lista(tabuleiro){
  return tabuleiro === "talvez" ? estado.maybe : estado.cartas;
}

/* Símbolos de mana: "{2}{G}{W}" vira bolinhas. Híbrido ("{G/W}") sai com as
   duas cores em gradiente, que é como o jogo desenha. */
/* Carta partida guarda os dois custos numa string só ("{1}{R} // {1}{U}").
   Varrer os símbolos direto colava as duas metades numa fileira contínua de
   bolinhas, que lê como um custo só de cinco manas — caro e errado. Cada lado
   vira um grupo, e o espaço entre eles é o que diz que são dois. */
export function manaHTML(custo){
  if (!custo) return "";
  const lados = String(custo).split("//").map(pipsHTMLdoCusto).filter(Boolean);
  if (!lados.length) return "";
  return '<span class="mana">' +
    lados.map(l => `<span class="lado">${l}</span>`).join("") + "</span>";
}

/* O que um símbolo que não é cor quer dizer. Custo de mana só tem número, X
   e híbrido; é o ORACLE que traz {T}, {Q}, {E} e {S}, e sem isto todos eles
   viravam a mesma bolinha com um ponto dentro — "{T}: Add {G}" lido como
   "•: Add ●" não diz que a habilidade custa virar a carta. */
const NOME_SIMBOLO = {
  T: "Virar", Q: "Desvirar", E: "Contador de energia", S: "Mana da neve",
  C: "Incolor", P: "Phyrexiano", X: "X", Y: "Y", Z: "Z",
};

function pipsHTMLdoCusto(custo){
  const simbolos = custo.match(/\{[^}]+\}/g) || [];
  // `title` em cada bolinha porque cor sozinha não é informação acessível —
  // e num pip de 13px o daltônico não é o único que agradece.
  return simbolos.map(s => {
    const bruto = s.slice(1, -1);
    const partes = bruto.split("/").filter(p => CORES.includes(p));
    if (partes.length === 2){
      return `<span class="pip" title="${NOME_COR[partes[0]]} ou ${NOME_COR[partes[1]]}"
        style="background:linear-gradient(135deg,var(--mana-${partes[0]}) 50%,var(--mana-${partes[1]}) 50%)"></span>`;
    }
    if (partes.length === 1){
      return `<span class="pip ${partes[0]}" title="${NOME_COR[partes[0]]}"></span>`;
    }
    const rotulo = bruto.replace(/[^0-9A-Za-z+\-−]/g, "") || "•";
    return `<span class="pip C" title="${NOME_SIMBOLO[rotulo] ||
      rotulo + " genérico"}">${rotulo}</span>`;
  }).join("");
}

/* O `manaNeeded` do Spellbook não é um custo de mana: é uma frase COM custo
   de mana dentro ("{2}{G} plus enough mana to animate the land"). Passá-la
   direto pela `manaHTML` desenhava as bolinhas e jogava fora a frase — que
   é a metade que diz o que a mana é PRA quê. Aqui os símbolos viram pip e o
   resto do texto continua texto. */
export function manaEmTexto(txt){
  return String(txt == null ? "" : txt)
    .split(/((?:\{[^}]+\})+)/)
    .map(parte => parte.startsWith("{") ? manaHTML(parte) : escapar(parte))
    .join("");
}

/* Um ícone do sprite. Sai `aria-hidden` porque quase todo botão daqui já se
   nomeia pelo `title` ou pelo `aria-label` — e um desenho que se anuncia
   sozinho faria o leitor de tela dizer o nome do botão duas vezes. Quando o
   ícone é a ÚNICA informação (a seta que diz a direção da ordenação), passe
   `rotulo` e ele vira imagem com nome. */
export function ico(nome, rotulo){
  return `<svg class="ico" ${rotulo
    ? `role="img" aria-label="${escapar(rotulo)}"` : `aria-hidden="true"`
  }><use href="#i-${nome}"/></svg>`;
}

export function preco(carta){
  return carta.preco_usd ? moeda(carta.preco_usd) : "";
}
