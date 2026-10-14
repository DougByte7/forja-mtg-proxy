/* Os símbolos de mana como dados: "{2}{G}{W}" vira três símbolos, e carta
   partida ("{1}{R} // {1}{U}") vira dois LADOS. O desenho é `ui/Mana.tsx`.

   Carta partida guarda os dois custos numa string só. Varrer os símbolos
   direto colava as duas metades numa fileira contínua de bolinhas, que lê
   como um custo só de cinco manas — caro e errado. Cada lado vira um grupo,
   e o espaço entre eles é o que diz que são dois. */
import { COLOR_NAMES, COLORS } from "./state";

/* O que um símbolo que não é cor quer dizer. Custo de mana só tem número, X
   e híbrido; é o ORACLE que traz {T}, {Q}, {E} e {S}, e sem isto todos eles
   viravam a mesma bolinha com um ponto dentro — "{T}: Add {G}" lido como
   "•: Add ●" não diz que a habilidade custa virar a carta. */
const SYMBOL_NAMES: Record<string, string> = {
  T: "Virar", Q: "Desvirar", E: "Contador de energia", S: "Mana da neve",
  C: "Incolor", P: "Phyrexiano", X: "X", Y: "Y", Z: "Z",
};

export type ManaSymbol =
  | { kind: "hybrid"; colors: [string, string]; title: string }
  | { kind: "color"; color: string; title: string }
  | { kind: "generic"; label: string; title: string };

/* `title` em cada bolinha porque cor sozinha não é informação acessível — e
   num pip de 13px o daltônico não é o único que agradece. */
function symbolOf(raw: string): ManaSymbol {
  const parts = raw.split("/").filter((p) => (COLORS as string[]).includes(p));
  if (parts.length === 2) {
    return { kind: "hybrid", colors: [parts[0], parts[1]],
             title: `${COLOR_NAMES[parts[0]]} ou ${COLOR_NAMES[parts[1]]}` };
  }
  if (parts.length === 1) return { kind: "color", color: parts[0], title: COLOR_NAMES[parts[0]] };
  const label = raw.replace(/[^0-9A-Za-z+\-−]/g, "") || "•";
  return { kind: "generic", label, title: SYMBOL_NAMES[label] || label + " genérico" };
}

/** Os lados de um custo, cada um com os seus símbolos. Vazio sem custo. */
export function manaSides(cost: string | null | undefined): ManaSymbol[][] {
  if (!cost) return [];
  return String(cost).split("//")
    .map((side) => (side.match(/\{[^}]+\}/g) || []).map((s) => symbolOf(s.slice(1, -1))))
    .filter((side) => side.length);
}

/* O `manaNeeded` do Spellbook não é um custo de mana: é uma frase COM custo
   de mana dentro ("{2}{G} plus enough mana to animate the land"). Os
   símbolos viram pip e o resto do texto continua texto. */
export function manaTextParts(text: string | null | undefined) {
  return String(text == null ? "" : text).split(/((?:\{[^}]+\})+)/)
    .filter((part) => part !== "")
    .map((part) => part.startsWith("{") ? { mana: part } : { text: part });
}
