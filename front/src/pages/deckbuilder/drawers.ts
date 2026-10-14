/* As gavetas (filtros e importar). Uma por vez, e o fundo escuro é o mesmo
   pras duas. Fechar por Esc e por clique no fundo existe porque uma gaveta
   modal que só fecha no ✕ é uma armadilha em tela de toque, onde o ✕ fica
   longe do polegar. */
import { $ } from "../../shared/dom.js";

/** O id da gaveta aberta, ou null. */
export let openDrawerId: string | null = null;

export function openDrawer(id: string) {
  closeDrawer();
  const drawer = $(id) as HTMLElement;
  drawer.hidden = false;
  // Um quadro de espera antes da classe: `hidden` some e a transição de
  // `transform` precisa de um estado inicial pintado pra ter de onde sair —
  // sem isso a gaveta aparece pronta, sem deslizar.
  requestAnimationFrame(() => {
    drawer.classList.add("aberta");
    $("gaveta-fundo")!.classList.add("aberta");
  });
  openDrawerId = id;
  const first = drawer.querySelector<HTMLElement>("input,textarea,select");
  if (first) setTimeout(() => first.focus(), 180);
}

export function closeDrawer() {
  $("gaveta-fundo")!.classList.remove("aberta");
  if (!openDrawerId) return;
  const drawer = $(openDrawerId) as HTMLElement;
  drawer.classList.remove("aberta");
  // `hidden` só depois da animação: pôr na hora tiraria a gaveta da tela
  // antes de ela ter deslizado pra fora.
  setTimeout(() => { if (!drawer.classList.contains("aberta")) drawer.hidden = true; }, 220);
  openDrawerId = null;
}
