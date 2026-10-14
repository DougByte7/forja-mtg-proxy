/* ---------------------------------------------------------------- utilidades

   O que ainda sai em HTML: o aviso que some sozinho, os símbolos de mana, os
   ícones e a etiqueta de inédita. As regras do deck moram em `deck.ts`, o
   texto em `text.ts` e o preço em `price.ts`; isto aqui vira componente
   quando a tela virar Preact. */

import {$, escapar} from "../../shared/dom.js";
import {COLOR_NAMES, COLORS} from "./state";
import {brDate} from "./text";

export function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("mostra");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("mostra"), 2200);
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
    const partes = bruto.split("/").filter(p => COLORS.includes(p));
    if (partes.length === 2){
      return `<span class="pip" title="${COLOR_NAMES[partes[0]]} ou ${COLOR_NAMES[partes[1]]}"
        style="background:linear-gradient(135deg,var(--mana-${partes[0]}) 50%,var(--mana-${partes[1]}) 50%)"></span>`;
    }
    if (partes.length === 1){
      return `<span class="pip ${partes[0]}" title="${COLOR_NAMES[partes[0]]}"></span>`;
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

/* A marca da carta que ainda não saiu.

   Ela é a única carta da lista que não se pode comprar nem jogar hoje, e nada
   no nome, no tipo ou no custo diz isso — o preço, que seria a pista, vem
   vazio como o de qualquer carta sem oferta. Então é uma etiqueta com
   palavra, e não um ícone: quem ligou o interruptor há uma hora não vai
   lembrar o que um símbolo novo significa, e a data de lançamento fica no
   `title` pra quem quiser saber QUANDO.

   Devolve vazio pra carta comum, pra poder ser interpolada em qualquer
   linha sem um `if` em volta. */
export function seloInedita(carta){
  if (!carta || !carta.inedita) return "";
  return `<span class="selo-inedita" title="Ainda não lançada${
    carta.sai_em ? " — sai em " + escapar(brDate(carta.sai_em)) : ""
  }">inédita</span>`;
}
