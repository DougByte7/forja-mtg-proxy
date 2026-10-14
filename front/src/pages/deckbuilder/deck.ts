/* As regras do deck que a tela aplica sem esperar o servidor: o que conta
   pras 100, a identidade de cor e em que grupo cada carta é desenhada. */
import { AUTO_CATEGORIES, COLORS, OUT_OF_COUNT, SIDEBOARD, state } from "./state";
import type { Board, Card, Entry } from "./types";

export function deckIdentity() {
  const colors = new Set<string>();
  state.commanders.forEach((c) => (c.identidade || "").split("").forEach((x) => colors.add(x)));
  return COLORS.filter((c) => colors.has(c)).join("");
}

const outOfCount = (entry: Entry) => OUT_OF_COUNT.has(entry.categoria || "");

/* As cartas que valem pras 100. Toda conta sobre "o deck" passa por aqui:
   contador, curva, distribuição, assinatura pros combos. O sideboard fica de
   fora, e o maybeboard nem está nesta lista. */
export function countedCards() {
  return state.cards.filter((e) => !outOfCount(e));
}

export function totalCards() {
  return state.commanders.length + countedCards().reduce((n, e) => n + e.quantidade, 0);
}

/* A categoria automática, a que sai do tipo da carta. */
export function autoCategory(card: Card | null | undefined) {
  const t = (card?.tipo || "").toLowerCase();
  for (const [name, matches] of AUTO_CATEGORIES) if (matches(t)) return name;
  return "Outros";
}

/* Onde a carta é desenhada. A escolhida à mão ganha da automática — é o
   único jeito de "combo principal" existir, já que nenhum type_line diz
   isso. */
export function categoryOf(entry: Entry | null | undefined) {
  return entry?.categoria || autoCategory(entry?.carta);
}

/* A ordem dos grupos na lista, e ela conta uma história: primeiro o que a
   pessoa decidiu (as categorias próprias, na ordem em que ela as pôs),
   depois o que a carta é (os tipos), e por último o que está fora da conta.
   O contrário — tipos primeiro — enterraria a organização que ela fez no
   meio de nove grupos automáticos. */
export function categoryOrder(entries: Entry[]) {
  const used = new Set(entries.map(categoryOf));
  const automatic = AUTO_CATEGORIES.map((c) => c[0]).concat(["Outros"]);
  const custom = state.categories.filter((c) => !automatic.includes(c));
  const order = [
    ...custom,
    ...automatic.filter((c) => used.has(c)),
    ...[...OUT_OF_COUNT].filter((c) => used.has(c)),
  ];
  // Rede de segurança, e ela não é teórica: uma carta pode carregar uma
  // categoria que a lista não tem (um deck salvo por uma versão anterior, um
  // Ctrl+Z pra antes da categoria existir). Sem isto o grupo dela não seria
  // desenhado e a carta SUMIRIA da tela — continuando no deck, no contador e
  // na cotação. Uma carta invisível que se paga é o pior estrago possível
  // aqui, e custa uma linha evitá-lo.
  for (const cat of used) if (!order.includes(cat)) order.push(cat);
  return order;
}

/* Toda categoria que a tela sabe oferecer no menu, própria ou não. */
export function allCategories() {
  return [...state.categories, ...AUTO_CATEGORIES.map((c) => c[0]), "Outros", SIDEBOARD];
}

export function isCustomCategory(cat: string) {
  return state.categories.includes(cat);
}

/* As duas listas pelo nome que o resto do código usa pra falar delas. */
export function boardList(board: Board | string) {
  return board === "talvez" ? state.maybe : state.cards;
}
