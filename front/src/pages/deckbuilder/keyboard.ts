/* O teclado da página inteira. Esc fecha UMA coisa por toque, a de cima: o
   menu, a carta aberta, a gaveta, a modal da mesa, a cotação, a folha do
   celular, a modal de arte e, por último, a tela cheia do goldfish. */
import { artState, closeArtPicker } from "./art";
import { closeQuote, quoteBox } from "./budget";
import { closeCard, isCardOpen } from "./cardDetail";
import { closeDrawer, isDrawerOpen } from "./drawers";
import { undo } from "./editing";
import { closeSheet, focusSearch, sheetOpen } from "./layout";
import { closeMenu, isMenuOpen } from "./popupMenu";
import { state } from "./state";
import { closeTableModal, fullscreen, isTableModalOpen, setFullscreen, tableShortcut, undoTable } from "./table";

function closeTopmost(): boolean {
  // O menu fecha antes da gaveta: quando os dois estão abertos, o de cima é
  // o menu, e Esc fechar a gaveta por baixo dele seria fechar o que a pessoa
  // não está olhando. A carta vem antes da gaveta pelo mesmo motivo.
  if (isMenuOpen()) { closeMenu(); return true; }
  if (isCardOpen()) { closeCard(); return true; }
  if (isDrawerOpen()) { closeDrawer(); return true; }
  if (isTableModalOpen()) { closeTableModal(); return true; }
  if (quoteBox.value) { closeQuote(); return true; }
  if (sheetOpen.value) { closeSheet(); return true; }
  if (artState.carta) { closeArtPicker(); return true; }
  // Sair da tela cheia pelo Esc, que é onde a mão vai primeiro.
  if (fullscreen.value) { setFullscreen(false); return true; }
  return false;
}

export function onPageKey(e: KeyboardEvent) {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "");
  if (e.key === "Escape") {
    if (closeTopmost()) e.preventDefault();
    return;
  }
  if (isDrawerOpen() || isCardOpen()) return;   // dentro da gaveta ou da modal, o teclado é dela
  // D e Espaço só valem com a mesa à vista e nada por cima dela.
  if (state.aba === "goldfish" && !typing && !isTableModalOpen() && !artState.carta && tableShortcut(e)) return;
  if (e.key === "/" && !typing) {
    e.preventDefault();
    if (state.comandantes.length) focusSearch();
    else document.getElementById("busca-cmd")?.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !typing) {
    e.preventDefault();
    // Na aba do goldfish, Ctrl+Z desfaz a JOGADA, não a edição do deck. São
    // duas pilhas separadas de propósito: desfazer uma jogada não pode tirar
    // uma carta do deck, e vice-versa.
    if (state.aba === "goldfish" && state.mesa) undoTable();
    else undo();
  }
}
