/* Os menus da tela: o de uma carta (clique direito na linha, ou o ⋯ dela no
   celular), o de uma categoria própria e o "···" do cabeçalho. */
import { readLocalDecks } from "../../shared/localDecks";
import { accountLink } from "./account";
import { openArtPicker } from "./art";
import { openCard } from "./cardDetail";
import { autoCategory } from "./deck";
import { openDrawer } from "./drawers";
import {
  createCategory, deleteCategory, findEntry, moveCard, moveCategory, removeCard, renameCategory, setCategory,
} from "./editing";
import { exportList } from "./importExport";
import { openMenu, type MenuItem } from "./popupMenu";
import { SIDEBOARD, state } from "./state";
import type { Board } from "./types";

export const askNewCategory = () => prompt("Nome da nova categoria:\n\n" +
  "Ex.: Combo principal, Sac outlet, Proteção do comandante");

/* O menu de uma carta: categoria, tabuleiro e sair. Nesta ordem porque é a
   ordem da frequência — trocar de categoria é o que se faz o tempo todo,
   tirar do deck é o que se faz uma vez. */
export function openCardMenu(anchor: Element | DOMRect, name: string, board: Board) {
  const entry = findEntry(name, board);
  if (!entry) return;
  const current = entry.categoria || "";
  const check = (cat: string) => current === cat ? "check" : undefined;
  const items: MenuItem[] = [
    // Primeiro item, e o único que não muda nada no deck: é o caminho de
    // teclado pra mesma modal que o clique na linha abre.
    { label: "Ver a carta", icon: "cards", onClick: () => openCard(entry.carta) },
    // O botão de arte fica nos controles da linha do deck, que só aparecem no
    // hover, e o maybeboard nem tem. Este item é a porta de teclado, a do
    // maybeboard — e a de quem procura no menu em vez de caçar o ícone.
    { label: "Escolher a arte", icon: "image", onClick: () => openArtPicker(name) },
    "sep",
    { title: `Categoria de ${name}` },
    { label: `Automática (${autoCategory(entry.carta)})`, icon: check(""), onClick: () => setCategory(name, board, "") },
    ...state.categorias.map((cat): MenuItem => ({ label: cat, icon: check(cat), onClick: () => setCategory(name, board, cat) })),
    { label: `${SIDEBOARD} — fora das 100`, icon: check(SIDEBOARD), onClick: () => setCategory(name, board, SIDEBOARD) },
    { label: "Nova categoria…", icon: "plus", onClick: () => {
      const chosen = askNewCategory();
      if (chosen) createCategory(chosen, name, board);
    } },
    "sep",
    // A seta aponta pro lado em que a carta vai PARAR na tela: o maybeboard
    // é a coluna da direita, o deck é o meio.
    board === "talvez"
      ? { label: "Mover pro deck", icon: "arrow-left", onClick: () => moveCard(name, "talvez", "deck") }
      : { label: "Mover pro maybeboard", icon: "arrow-right", onClick: () => moveCard(name, "deck", "talvez") },
    { label: board === "talvez" ? "Tirar do maybeboard" : "Tirar do deck", icon: "x", cls: "perigo",
      onClick: () => removeCard(name, board) },
  ];
  openMenu(anchor, items);
}

/* O menu de uma categoria própria. Só as próprias têm: renomear "Criaturas"
   não faria sentido — ela não é um nome, é o tipo da carta. */
export function openGroupMenu(anchor: Element, cat: string) {
  const i = state.categorias.indexOf(cat);
  const items: MenuItem[] = [
    { title: cat },
    { label: "Renomear…", icon: "pencil-simple", onClick: () => {
      const renamed = prompt("Novo nome da categoria:", cat);
      if (renamed) renameCategory(cat, renamed);
    } },
  ];
  if (i > 0) items.push({ label: "Subir", icon: "arrow-up", onClick: () => moveCategory(cat, -1) });
  if (i >= 0 && i < state.categorias.length - 1) {
    items.push({ label: "Descer", icon: "arrow-down", onClick: () => moveCategory(cat, +1) });
  }
  items.push("sep", { label: "Apagar categoria", icon: "x", cls: "perigo", onClick: () => deleteCategory(cat) });
  openMenu(anchor, items);
}

/* O clique no "Novo deck", que é link pro deckbuilder sem `?deck=`. A
   pergunta vale só pro clique que troca ESTA aba: o Ctrl+clique abre o deck
   novo noutra aba e deixa este onde está. */
function startNew(e: MouseEvent) {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (state.cartas.length && !confirm("Começar um deck novo? O atual fica salvo e continua em Meus decks.")) {
    e.preventDefault();
  }
}

/* O menu do "···". Ele guarda o que se faz uma vez por deck; o cabeçalho
   guarda o que se faz sempre. O que leva a outra página é link (`href`); o
   que age aqui mesmo é botão. */
export function openHeaderMenu(anchor: Element) {
  const items: MenuItem[] = [];
  const mine = readLocalDecks();
  if (mine.length) items.push({ label: `Meus decks (${mine.length})`, href: "/meus-decks" });
  items.push({ label: "Importar lista", onClick: () => openDrawer("gaveta-importar") });
  items.push({ label: "Exportar lista (copiar)", onClick: exportList });
  items.push("sep");
  items.push({ label: "Novo deck", href: location.pathname, onClick: startNew });
  items.push({ label: "Imprimir proxies", href: "/" });
  if (!state.usuario) {
    items.push("sep");
    items.push({ label: "Entrar", href: accountLink("entrar") });
    items.push({ label: "Criar conta", href: accountLink("cadastro") });
  }
  openMenu(anchor, items);
}
