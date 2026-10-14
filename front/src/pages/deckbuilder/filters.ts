/* ------------------------------------------------------- filtros da busca

   O estado dos filtros é `state.filtros`; a gaveta, a fita de etiquetas e o
   botão com a contagem são `ui/Filters.tsx` e desenham dele. */
import { $ } from "../../shared/dom.js";
import { screenCurrency } from "./price";
import { scheduleSearch, searchCommander, searchFromStart } from "./search";
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
  const f = state.filtros;
  const on: ActiveFilter[] = [];
  if (f.tipo) on.push({ key: "tipo", label: TYPE_LABELS[f.tipo] || f.tipo });
  if (f.texto) on.push({ key: "texto", label: `“${f.texto}”` });
  if (f.cores) on.push({ key: "cores", label: f.cores });
  if (f.cmcMin !== "" || f.cmcMax !== "") {
    on.push({ key: "cmc", label: `custo ${f.cmcMin === "" ? "0" : f.cmcMin}–${f.cmcMax === "" ? "∞" : f.cmcMax}` });
  }
  if (f.precoMax !== "") on.push({ key: "precoMax", label: `até ${screenCurrency()} ${f.precoMax}` });
  // Este não estreita a lista, alarga (ver `anyFilterOn`) — mas está ligado,
  // e a fita é onde se vê o que está ligado. Sem ele aqui, a carta que ainda
  // não saiu apareceria na busca sem nada dizendo por quê.
  if (f.ineditas) on.push({ key: "ineditas", label: "inéditas" });
  if (f.ordem && f.ordem !== "nome") {
    // O chip da ordenação é a única coisa da barra em que a seta É o
    // conteúdo: "preço" sozinho não diz se a mais cara vem antes.
    const field = ({ cmc: "custo", cmc_desc: "custo", preco: "preço", preco_desc: "preço" } as Record<string, string>)[f.ordem];
    const desc = f.ordem.endsWith("_desc");
    on.push(field
      ? { key: "ordem", label: field, icon: desc ? "arrow-down" : "arrow-up", direction: desc ? "maior primeiro" : "menor primeiro" }
      : { key: "ordem", label: f.ordem });
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
  state.filtros = { ...state.filtros, ...change };
  touch();
  scheduleSearch();
}

export function toggleColor(color: string) {
  const colors = state.filtros.cores;
  updateFilters({ cores: colors.includes(color) ? colors.replace(color, "") : colors + color });
}

/* O interruptor da tela de abertura. O que ele tem de diferente do da
   gaveta é a busca que refaz: a de comandante, que é a única acontecendo
   enquanto essa tela está no ar — e só se houver o que buscar: com a caixa
   vazia a lista está vazia de propósito. */
export function setUnreleasedFromHero(on: boolean) {
  state.filtros = { ...state.filtros, ineditas: on };
  touch();
  if (($("busca-cmd") as HTMLInputElement).value.trim()) searchCommander();
}

export function removeFilter(key: ActiveFilter["key"]) {
  if (key === "cmc") {
    // A única etiqueta que fala por dois controles: "custo 2–4" é o par.
    state.filtros = { ...state.filtros, cmcMin: "", cmcMax: "" };
  } else {
    // Tirar um filtro é devolvê-lo ao estado neutro da gaveta, e quem sabe
    // qual é ele é o `EMPTY_FILTERS`.
    state.filtros = { ...state.filtros, [key]: EMPTY_FILTERS[key] };
  }
  touch();
  searchFromStart();
}

export function clearFilters() {
  state.filtros = { ...EMPTY_FILTERS };
  touch();
  searchFromStart();
}
