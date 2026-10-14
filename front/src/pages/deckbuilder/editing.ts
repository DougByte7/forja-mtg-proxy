/* --------------------------------------------------------------- mexer no deck

   Toda mudança no deck passa por aqui: guarda o desfazer, muda o estado,
   apaga a validação velha (a do servidor volta com o autosave), redesenha e
   agenda o salvamento. */
import { search, searchCommander, searchText } from "./search";
import { allCategories, boardList, isCustomCategory } from "./deck";
import { redrawAll } from "./redraw";
import { scheduleSave } from "./save";
import { OUT_OF_COUNT, state } from "./state";
import type { Board, Card, Entry } from "./types";
import { toast } from "./ui/toast";

const UNDO_LIMIT = 40;

/** Depois de toda mudança: a validação local vale até a do servidor voltar. */
function changed({ invalidate = true } = {}) {
  if (invalidate) state.validation = null;
  redrawAll();
  scheduleSave();
}

export function findEntry(name: string, board?: Board | string): Entry | undefined {
  return boardList(board || "deck").find((e) => e.carta.nome === name);
}

/* Onde a carta está — deck, maybeboard ou lugar nenhum. É o que os cliques
   usam pra não precisarem carregar o tabuleiro em cada botão. */
export function whereIs(name: string): Board | null {
  if (state.cards.some((e) => e.carta.nome === name)) return "deck";
  if (state.maybe.some((e) => e.carta.nome === name)) return "talvez";
  return null;
}

export function pushUndo() {
  state.undoStack.push(JSON.stringify({
    commanders: state.commanders,
    cards: state.cards,
    maybe: state.maybe,
    categories: state.categories,
  }));
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
}

export function undo() {
  const previous = state.undoStack.pop();
  if (!previous) { toast("Nada pra desfazer."); return; }
  const data = JSON.parse(previous);
  state.commanders = data.commanders;
  state.cards = data.cards;
  state.maybe = data.maybe;
  state.categories = data.categories;
  changed();
  toast("Desfeito.");
}

/* Adicionar num tabuleiro. A categoria só é dita quando quem chama tem
   opinião (o menu, ao criar categoria com a carta junto); no caminho normal
   ela nasce vazia e o grupo sai do tipo da carta. */
export function addCard(card: Card, board: Board = "deck", category?: string) {
  pushUndo();
  const entry = findEntry(card.nome, board);
  if (entry) {
    entry.quantidade += 1;
    if (category !== undefined) entry.categoria = category;
  } else {
    boardList(board).push({ carta: card, quantidade: 1, categoria: category || "" });
  }
  changed();
}

function setBoard(board: Board, entries: Entry[]) {
  if (board === "talvez") state.maybe = entries;
  else state.cards = entries;
}

function changeQuantity(name: string, delta: number, board?: Board) {
  const where = board || whereIs(name) || "deck";
  const entry = findEntry(name, where);
  if (!entry) return;
  pushUndo();
  entry.quantidade += delta;
  if (entry.quantidade <= 0) setBoard(where, boardList(where).filter((e) => e !== entry));
  changed();
}

/* A quantidade digitada no número da linha. Zero é o mesmo que o ✕, com o
   mesmo toast — é ele que avisa que o Ctrl+Z devolve a carta. */
export function setQuantity(name: string, quantity: number, board: Board) {
  const entry = findEntry(name, board);
  if (!entry) return;
  if (quantity <= 0) return removeCard(name, board);
  if (quantity === entry.quantidade) return;
  changeQuantity(name, quantity - entry.quantidade, board);
}

export function removeCard(name: string, board?: Board) {
  const where = board || whereIs(name) || "deck";
  pushUndo();
  setBoard(where, boardList(where).filter((e) => e.carta.nome !== name));
  changed();
  toast(`${name} saiu do ${where === "talvez" ? "maybeboard" : "deck"}. Ctrl+Z desfaz.`);
}

/* -------------------------------------------------- mover entre tabuleiros

   A carta atravessa INTEIRA, com quantidade e categoria: o maybeboard herda
   as mesmas categorias do deck, então "sac outlet" continua sendo "sac
   outlet" do outro lado, e voltar não faz a pessoa reclassificar nada.

   Quando a carta já existe no destino (dá pra ter a mesma no deck e em
   dúvida), as quantidades somam em vez de uma sobrescrever a outra. */
export function moveCard(name: string, from: Board, to: Board) {
  if (from === to) return;
  const entry = findEntry(name, from);
  if (!entry) return;
  pushUndo();
  setBoard(from, boardList(from).filter((e) => e !== entry));

  const target = findEntry(name, to);
  if (target) {
    target.quantidade += entry.quantidade;
    if (!target.categoria) target.categoria = entry.categoria;
  } else {
    boardList(to).push(entry);
  }
  changed();
  toast(to === "talvez"
    ? `${name} foi pro maybeboard — fora da conta e da cotação.`
    : `${name} entrou no deck.`);
}

/* --------------------------------------------------------------- categorias

   Categoria é rótulo, não pasta: mudar a de uma carta não a move de lista
   nem mexe em quantidade. A única exceção é o Sideboard, que muda a conta
   das 100 — e por isso o toast diz isso em voz alta quando ela entra ou
   sai de lá. */
export function setCategory(name: string, board: Board, category: string) {
  const entry = findEntry(name, board);
  if (!entry) return;
  pushUndo();
  const before = entry.categoria || "";
  entry.categoria = category || "";
  changed();

  const wasOut = OUT_OF_COUNT.has(before);
  const isOut = OUT_OF_COUNT.has(entry.categoria);
  if (board === "deck" && isOut && !wasOut) {
    toast(`${name} foi pro sideboard: sai das 100 e das análises, mas continua na cotação.`);
  } else if (board === "deck" && wasOut && !isOut) {
    toast(`${name} voltou pras 100.`);
  } else {
    toast(entry.categoria
      ? `${name} agora está em "${entry.categoria}".`
      : `${name} voltou pro grupo do tipo dela.`);
  }
}

const MAX_CATEGORIES = 40;
const MAX_CATEGORY_NAME = 40;

/* Cria uma categoria. `cardName` opcional: criar a partir do menu de uma
   linha já põe aquela carta dentro, senão o caminho seria criar, fechar,
   reabrir o menu e escolher. */
export function createCategory(name: string, cardName?: string, board: Board = "deck") {
  name = (name || "").trim().slice(0, MAX_CATEGORY_NAME);
  if (!name) return null;
  const existing = allCategories().find((c) => c.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (!isCustomCategory(existing)) toast(`"${existing}" já é uma categoria da tela.`);
    if (cardName) setCategory(cardName, board, existing);
    return existing;
  }
  if (state.categories.length >= MAX_CATEGORIES) {
    toast(`Já são ${MAX_CATEGORIES} categorias — apague alguma antes de criar outra.`);
    return null;
  }
  pushUndo();
  state.categories.push(name);
  if (cardName) {
    const entry = findEntry(cardName, board);
    if (entry) entry.categoria = name;
  }
  changed({ invalidate: false });
  toast(`Categoria "${name}" criada.`);
  return name;
}

export function renameCategory(previous: string, next: string) {
  next = (next || "").trim().slice(0, MAX_CATEGORY_NAME);
  if (!next || next === previous) return;
  if (allCategories().some((c) => c.toLowerCase() === next.toLowerCase())) {
    toast(`Já existe uma categoria "${next}".`);
    return;
  }
  pushUndo();
  state.categories = state.categories.map((c) => c === previous ? next : c);
  if (state.destinationCategory === previous) state.destinationCategory = next;
  // As duas listas: o maybeboard herda as categorias do deck, então
  // renomear no deck e não renomear lá deixaria um grupo órfão do outro
  // lado, com o nome velho e sem dono.
  for (const e of state.cards.concat(state.maybe)) {
    if (e.categoria === previous) e.categoria = next;
  }
  changed({ invalidate: false });
}

/* Apagar a categoria NÃO apaga carta: elas voltam pro grupo do tipo delas.
   Uma categoria é uma forma de olhar a lista, e desfazer uma forma de olhar
   não pode custar 12 cartas. */
export function deleteCategory(category: string) {
  pushUndo();
  state.categories = state.categories.filter((c) => c !== category);
  // A busca que mandava cartas pra cá volta pro tipo da carta: senão as
  // próximas iriam pra uma categoria que não existe mais.
  if (state.destinationCategory === category) state.destinationCategory = "";
  let released = 0;
  for (const e of state.cards.concat(state.maybe)) {
    if (e.categoria === category) { e.categoria = ""; released++; }
  }
  changed({ invalidate: false });
  toast(released
    ? `Categoria "${category}" apagada — ${released} carta(s) voltaram pro grupo do tipo.`
    : `Categoria "${category}" apagada.`);
}

export function moveCategory(category: string, step: number) {
  const i = state.categories.indexOf(category);
  const target = i + step;
  if (i < 0 || target < 0 || target >= state.categories.length) return;
  pushUndo();
  state.categories.splice(i, 1);
  state.categories.splice(target, 0, category);
  changed({ invalidate: false });
}

/* O próximo comandante escolhido entra como PARCEIRO do que já está (em vez
   de trocá-lo) quando quem pediu foi o "+ parceiro". Liga e desliga a cada
   escolha. */
export const commanderPick = { partner: false };

export function chooseCommander(card: Card) {
  pushUndo();
  if (commanderPick.partner && state.commanders.length === 1) state.commanders.push(card);
  else state.commanders = [card];
  commanderPick.partner = false;
  if (!state.name || state.name === "Deck sem nome") {
    state.name = card.nome.split(",")[0];
  }
  state.validation = null;
  redrawAll();
  search();          // a lista da lateral agora tem identidade pra filtrar
  scheduleSave();
}

/* O "Adicionar parceiro": a pergunta do comandante volta à tela, e o
   próximo escolhido entra junto do primeiro em vez de no lugar dele. */
export function startPartnerPick() {
  commanderPick.partner = true;
  searchText.cmd.value = "";
  redrawAll();
  searchCommander();
}

export function removeCommander(index: number) {
  pushUndo();
  state.commanders.splice(index, 1);
  state.validation = null;
  redrawAll();
  search();
  scheduleSave();
}
