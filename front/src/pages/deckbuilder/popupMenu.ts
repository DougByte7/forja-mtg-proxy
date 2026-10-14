/* ----------------------------------------------------------------- menus

   Um menu ancorado no botão que o abriu, ou no ponto do clique direito. O
   da carta abre no clique direito da linha, e no celular pelo ⋯ dela:
   arrastar é o gesto natural no mouse e não existe no celular, então o
   arrastar é atalho e este menu é o caminho.

   Ele é montado a cada abertura em vez de ficar guardado: a lista de
   categorias muda a cada carta, e um menu guardado teria que ser
   sincronizado — que é o mesmo trabalho, feito duas vezes. O desenho é
   `ui/PopupMenu.tsx`. */
import { signal } from "@preact/signals";

/* Um item: botão (`onClick`) ou link (`href`) — o que leva a outra página
   abre em aba nova no Ctrl+clique e mostra o destino no hover, como
   qualquer link, e o `onClick` dele recebe o evento pra desistir da ida com
   `preventDefault`. `"sep"` é uma linha divisória, `{title}` um cabeçalho e
   `{note}` uma frase solta — o motivo de um item desabilitado, por exemplo. */
export type MenuItem =
  | "sep"
  | { title: string }
  | { note: string }
  | { label: string; icon?: string; onClick?: (e: MouseEvent) => unknown; href?: string;
      cls?: string; disabled?: boolean };

export const popupMenu = signal<{ anchor: DOMRect; items: MenuItem[] } | null>(null);

/* `anchor` é um elemento ou um retângulo (o ponto do clique direito). */
export function openMenu(anchor: Element | DOMRect, items: MenuItem[]) {
  popupMenu.value = { anchor: anchor instanceof Element ? anchor.getBoundingClientRect() : anchor, items };
}

export function closeMenu() {
  popupMenu.value = null;
}

export function isMenuOpen() {
  return !!popupMenu.value;
}
