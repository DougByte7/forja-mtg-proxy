/* As gavetas (filtros e importar). Uma por vez, e o fundo escuro é o mesmo
   pras duas. Fechar por Esc e por clique no fundo existe porque uma gaveta
   modal que só fecha no ✕ é uma armadilha em tela de toque, onde o ✕ fica
   longe do polegar. */
import { signal } from "@preact/signals";

export type DrawerId = "gaveta-filtros" | "gaveta-importar";

/** A gaveta à vista (inclusive enquanto desliza pra fora), e se ela está
    aberta — a classe que a faz deslizar. */
export const drawer = signal<{ id: DrawerId; open: boolean } | null>(null);

/* Aberta desde o clique, e não só depois do quadro da animação. */
let active: DrawerId | null = null;

export function isDrawerOpen() {
  return active !== null;
}

export function openDrawer(id: DrawerId) {
  active = id;
  drawer.value = { id, open: false };
  // Um quadro de espera antes da classe: a transição de `transform` precisa
  // de um estado inicial pintado pra ter de onde sair — sem isso a gaveta
  // aparece pronta, sem deslizar.
  requestAnimationFrame(() => { if (active === id) drawer.value = { id, open: true }; });
}

export function closeDrawer() {
  const current = drawer.value;
  active = null;
  if (!current) return;
  drawer.value = { ...current, open: false };
  // Some só depois da animação: tirar na hora tiraria a gaveta da tela antes
  // de ela ter deslizado pra fora.
  setTimeout(() => { if (active === null && drawer.value?.id === current.id) drawer.value = null; }, 220);
}
