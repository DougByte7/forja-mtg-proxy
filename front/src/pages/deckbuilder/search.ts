/* ------------------------------------------------------------------- buscar

   Duas caixas de busca: a do comandante (na abertura, antes de existir deck)
   e a do painel de adicionar. As duas falam com a base local (`cartas.py`),
   e o que voltou mora no estado — `state.resultados.main` e `.cmd` —, de onde
   `ui/Search.tsx` desenha. */
import { $ } from "../../shared/dom.js";
import { deckIdentity } from "./deck";
import { addCard, chooseCommander } from "./editing";
import { maxPriceInUsd } from "./price";
import { api } from "./salvar.js";
import { anyFilterOn, SIDEBOARD, state, touch } from "./state";
import { deckLinkSource } from "./text";
import type { Card } from "./types";
import { toast } from "./ui/toast";

export type SearchBox = "main" | "cmd";
export type SearchResult = {
  cards: Card[];
  term: string;
  paged: boolean;
  error: string | null;
  /** No lugar da lista: um link de deck colado na caixa do comandante. */
  pastedLink: { source: string | null } | null;
  /** A carta destacada pelo teclado, ou -1. */
  highlight: number;
  /** Já houve busca: lista vazia aí é "nada com esse nome", e não o vazio
      de quem ainda não perguntou nada. */
  done: boolean;
};

const emptyResult = (): SearchResult => ({
  cards: [], term: "", paged: false, error: null, pastedLink: null, highlight: -1, done: false,
});
state.resultados = { main: emptyResult(), cmd: emptyResult() };

const result = (box: SearchBox): SearchResult => state.resultados[box];
function setResult(box: SearchBox, next: Partial<SearchResult>) {
  // A lista trocou: o índice destacado apontava pra outra carta.
  state.resultados[box] = { ...emptyResult(), done: true, ...next };
  touch();
}

/** O que acontece com a carta escolhida em cada caixa. */
export const pickHandler = (box: SearchBox) => box === "cmd" ? chooseCommander : addByDestination;

let searchTimer = 0;

export function scheduleSearch() {
  clearTimeout(searchTimer);
  // Quem digitou uma letra ou mexeu num filtro está fazendo outra pergunta:
  // continuar na página 4 da pergunta anterior seria cair no meio de uma
  // lista que ninguém viu começar.
  state.buscaPagina = 0;
  searchTimer = window.setTimeout(search, 220);
}

/* A busca de novo, do começo. É o que os filtros chamam quando mudam sem
   passar pelo atraso do teclado — tirar um chip, limpar tudo. */
export function searchFromStart() {
  state.buscaPagina = 0;
  return search();
}

export function scheduleCommanderSearch() {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(searchCommander, 220);
}

/* A lista é uma página, ou é a vitrine curta com a frase no fim?

   Página, quando a pessoa fez uma pergunta: escreveu um nome na caixa ou
   ligou um filtro na gaveta. "Bolt" casa com dezenas de cartas e "criatura
   verde de até 3" com dezenas de outras — nos dois casos o recorte é o ponto,
   e ver só os cinco primeiros é ficar sem a resposta.

   Vitrine, com a caixa vazia e nenhum filtro: aí não há pergunta, e paginar
   seria folhear a base inteira de cinco em cinco. */
export function isPaged(term: string) {
  return term !== "" || anyFilterOn();
}

export async function search(): Promise<void> {
  const term = ($("busca") as HTMLInputElement).value.trim();
  const identity = state.comandantes.length ? deckIdentity() : null;
  const paged = isPaged(term);
  const params = new URLSearchParams({ q: term, limite: paged ? String(state.buscaPorPagina) : "24" });
  if (paged) {
    params.set("pular", String(state.buscaPagina * state.buscaPorPagina));
    params.set("com_total", "true");
  }
  if (identity !== null) params.set("identidade", identity);
  const f = state.filtros;
  if (f.tipo) params.set("tipo", f.tipo);
  if (f.texto) params.set("texto", f.texto);
  if (f.cores) params.set("cores", f.cores);
  if (f.cmcMin !== "") params.set("cmc_min", f.cmcMin);
  if (f.cmcMax !== "") params.set("cmc_max", f.cmcMax);
  if (f.precoMax !== "") params.set("preco_max", String(maxPriceInUsd(f.precoMax)));
  if (f.ordem && f.ordem !== "nome") params.set("ordem", f.ordem);
  if (f.ineditas) params.set("ineditas", "true");
  try {
    const r = await api("/cartas/busca?" + params);
    state.buscaTotal = paged ? (r.total ?? r.cartas.length) : 0;
    // A página em que se estava pode ter deixado de existir por baixo — um
    // comandante escolhido depois encurta a lista sem ninguém tocar no
    // filtro. Voltar pro começo é mais honesto do que mostrar nada.
    if (paged && !r.cartas.length && state.buscaPagina > 0) {
      state.buscaPagina = 0;
      return search();
    }
    setResult("main", { cards: r.cartas, term, paged });
  } catch (e) {
    setResult("main", { error: (e as Error).message });
  }
}

export async function searchCommander() {
  const term = ($("busca-cmd") as HTMLInputElement).value.trim();
  // Quem já tem o deck pronto em outro lugar chega nesta tela e vê UMA
  // caixa: é nela que o link vai ser colado. Um link não se confunde com
  // nome de carta (ver `deckLinkSource`), então a caixa responde às duas
  // coisas sem adivinhar.
  const source = deckLinkSource(term);
  // Link de um site que não sabemos abrir também não é nome de carta:
  // responder "nada com esse nome" mandaria a pessoa procurar um erro de
  // digitação que não existe. (Sem carta na lista, o Enter não manda pro
  // deck a última carta que a busca achou antes de o link ser colado.)
  if (source || /^https?:\/\//i.test(term) || /\.(com|net|org)\//i.test(term)) {
    setResult("cmd", { pastedLink: { source } });
    return;
  }
  const params = new URLSearchParams({ q: term, comandante: "true", limite: "25" });
  // O mesmo interruptor da gaveta, ligado aqui pelo da abertura: quem monta o
  // deck da coleção nova começa pelo comandante dela.
  if (state.filtros.ineditas) params.set("ineditas", "true");
  try {
    const r = await api("/cartas/busca?" + params);
    setResult("cmd", { cards: r.cartas, term });
  } catch (e) {
    setResult("cmd", { error: (e as Error).message });
  }
}

export function clearCommanderResults() {
  setResult("cmd", { done: false });
}

/* ------------------------------------------------------ o paginador

   Ele existe quando a lista é um recorte que a pessoa pediu. Quantos por
   página é escolha de quem olha: cinco cabem sem rolagem na coluna, quinze
   pedem rolagem mas mostram o recorte quase inteiro de uma vez. */
export const PAGE_SIZES = [5, 10, 15];

export function pagerView() {
  const per = state.buscaPorPagina;
  const pages = Math.max(1, Math.ceil(state.buscaTotal / per));
  return { per, total: state.buscaTotal, pages, page: Math.min(state.buscaPagina, pages - 1) };
}

export function turnPage(step: number) {
  const { pages } = pagerView();
  const next = Math.min(Math.max(state.buscaPagina + step, 0), pages - 1);
  if (next === state.buscaPagina) return;
  state.buscaPagina = next;
  search();
}

/* Mudar o tamanho da página volta pro começo: a carta que estava na tela
   está em outra página agora. */
export function setPageSize(size: number) {
  state.buscaPorPagina = size;
  state.buscaPagina = 0;
  search();
}

/* ------------------------------------------- teclado sobre os resultados

   A busca é usada de mão no teclado: digita, olha os cinco resultados,
   escolhe. A seta pra baixo entra na lista, as setas andam por ela, Enter
   manda a destacada pro destino escolhido e devolve o foco à caixa — que é
   onde a próxima carta vai ser digitada. Enter sem nada destacado manda a
   primeira, que é o caminho de quem já sabe o nome inteiro. */
export const visibleCount = (r: SearchResult) => r.paged ? r.cards.length : Math.min(r.cards.length, RESULTS_SHOWN);

/* Cinco resultados, e o resto vira uma frase: quem não achou nos cinco
   primeiros não vai achar no vigésimo, vai escrever mais uma letra. */
export const RESULTS_SHOWN = 5;

function moveHighlight(box: SearchBox, step: number) {
  const r = result(box);
  const n = visibleCount(r);
  if (!n) return;
  // Da caixa de texto, a primeira seta pra baixo pega o primeiro item e a
  // primeira seta pra cima pega o último.
  r.highlight = r.highlight < 0 ? (step > 0 ? 0 : n - 1) : (r.highlight + step + n) % n;
  touch();
}

export function bindSearchKeys(input: HTMLInputElement, box: SearchBox) {
  input.addEventListener("keydown", (e) => {
    const r = result(box);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!visibleCount(r)) return;
      e.preventDefault();
      return moveHighlight(box, e.key === "ArrowDown" ? 1 : -1);
    }
    if (e.key === "Escape" && r.highlight >= 0) {
      e.preventDefault();
      r.highlight = -1;
      touch();
      return;
    }
    if (e.key === "Enter") {
      if (!r.cards.length) return;
      e.preventDefault();
      const card = r.cards[r.highlight >= 0 ? r.highlight : 0];
      r.highlight = -1;
      if (card) pickHandler(box)(card);
      // A caixa do comandante sai da tela assim que um é escolhido: só
      // devolve o foco quem continua visível.
      if (input.offsetParent) { input.focus(); input.select(); }
      touch();
    }
  });
}

/* ------------------------------------------------------- destino da carta

   Quem monta o sideboard põe dez cartas seguidas nele: a decisão é a mesma
   pras dez, e se diz uma vez aqui em vez de dez visitas ao menu de cada linha
   depois de adicionada.

   "Sideboard" é categoria e não tabuleiro (é o que o servidor entende em
   `decks.CATEGORIAS_FORA_DA_CONTA`), então escolhê-lo aqui ocupa a vaga da
   categoria — e o seletor ao lado se desliga em vez de oferecer uma escolha
   que seria ignorada. */
export function addByDestination(card: Card) {
  const d = state.destino;
  if (d === "side") {
    addCard(card, "deck", SIDEBOARD);
    toast(`${card.nome} entrou no sideboard.`);
  } else if (d === "talvez") {
    addCard(card, "talvez", state.destinoCategoria || undefined);
    toast(`${card.nome} foi pro maybeboard.`);
  } else {
    addCard(card, "deck", state.destinoCategoria || undefined);
  }
}

export function chooseDestination(destination: string) {
  state.destino = destination;
  touch();
}
