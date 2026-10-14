/* ------------------------------------------------------- filtros da busca

   O estado dos filtros é `state.filters`; a gaveta, a fita de etiquetas e o
   botão com a contagem são `ui/Filters.tsx` e desenham dele. */
import { screenCurrency } from "./price";
import { scheduleSearch, searchCommander, searchFromStart, searchText } from "./search";
import { EMPTY_FILTERS, state, touch, TYPE_LABELS, type Filters } from "./state";

/* A cor no filtro é a cor DA CARTA, não a identidade dela: um Ancestral
   Vision é azul de cor e de identidade, enquanto um terreno que produz azul
   é INCOLOR de cor e azul de identidade. Quem procura "minhas cartas azuis"
   quer a primeira. */
export const FILTER_COLORS: [string, string][] = [
  ["W", "Branco"], ["U", "Azul"], ["B", "Preto"], ["R", "Vermelho"], ["G", "Verde"], ["C", "Incolor"],
];

export type ActiveFilter = { key: keyof Filters | "cmc"; label: string; icon?: string; direction?: string };

/* Quais filtros estão ligados, no formato que a fita desenha. Também é o que
   conta o número na bolinha do botão. */
export function activeFilters(): ActiveFilter[] {
  const f = state.filters;
  const on: ActiveFilter[] = [];
  if (f.type) on.push({ key: "type", label: TYPE_LABELS[f.type] || f.type });
  if (f.text) on.push({ key: "text", label: `“${f.text}”` });
  if (f.colors) on.push({ key: "colors", label: f.colors });
  if (f.cmcMin !== "" || f.cmcMax !== "") {
    on.push({ key: "cmc", label: `custo ${f.cmcMin === "" ? "0" : f.cmcMin}–${f.cmcMax === "" ? "∞" : f.cmcMax}` });
  }
  if (f.maxPrice !== "") on.push({ key: "maxPrice", label: `até ${screenCurrency()} ${f.maxPrice}` });
  // Este não estreita a lista, alarga (ver `anyFilterOn`) — mas está ligado,
  // e a fita é onde se vê o que está ligado. Sem ele aqui, a carta que ainda
  // não saiu apareceria na busca sem nada dizendo por quê.
  if (f.unreleased) on.push({ key: "unreleased", label: "inéditas" });
  if (f.order && f.order !== "nome") {
    // O chip da ordenação é a única coisa da barra em que a seta É o
    // conteúdo: "preço" sozinho não diz se a mais cara vem antes.
    const field = ({ cmc: "custo", cmc_desc: "custo", preco: "preço", preco_desc: "preço" } as Record<string, string>)[f.order];
    const desc = f.order.endsWith("_desc");
    on.push(field
      ? { key: "order", label: field, icon: desc ? "arrow-down" : "arrow-up", direction: desc ? "maior primeiro" : "menor primeiro" }
      : { key: "order", label: f.order });
  }
  return on;
}

/** Número do campo: vazio, ou um número de verdade e não negativo. */
export function cleanNumber(raw: string) {
  const v = raw.trim();
  if (v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? String(n) : "";
}

/* Os controles da gaveta buscam sozinhos ao mudar, com o atraso do teclado
   (o campo de efeito dispara a cada tecla). */
export function updateFilters(change: Partial<Filters>) {
  state.filters = { ...state.filters, ...change };
  touch();
  scheduleSearch();
}

export function toggleColor(color: string) {
  const colors = state.filters.colors;
  updateFilters({ colors: colors.includes(color) ? colors.replace(color, "") : colors + color });
}

/* O interruptor da tela de abertura. O que ele tem de diferente do da
   gaveta é a busca que refaz: a de comandante, que é a única acontecendo
   enquanto essa tela está no ar — e só se houver o que buscar: com a caixa
   vazia a lista está vazia de propósito. */
export function setUnreleasedFromHero(on: boolean) {
  state.filters = { ...state.filters, unreleased: on };
  touch();
  if (searchText.cmd.value.trim()) searchCommander();
}

export function removeFilter(key: ActiveFilter["key"]) {
  if (key === "cmc") {
    // A única etiqueta que fala por dois controles: "custo 2–4" é o par.
    state.filters = { ...state.filters, cmcMin: "", cmcMax: "" };
  } else {
    // Tirar um filtro é devolvê-lo ao estado neutro da gaveta, e quem sabe
    // qual é ele é o `EMPTY_FILTERS`.
    state.filters = { ...state.filters, [key]: EMPTY_FILTERS[key] };
  }
  touch();
  searchFromStart();
}

export function clearFilters() {
  state.filters = { ...EMPTY_FILTERS };
  touch();
  searchFromStart();
}
