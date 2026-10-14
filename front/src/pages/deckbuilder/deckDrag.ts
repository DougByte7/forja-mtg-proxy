/* -------------------------------------------------------------- arrastar

   Atalho de quem tem mouse, nunca o único caminho: no toque não existe
   `dragstart`, e a mesma carta se move pelo menu da linha. Solta em cima de um
   grupo (muda a categoria, e o tabuleiro se for o outro) ou em cima da
   coluna do maybeboard (que aceita a carta na categoria em que ela já
   estava).

   Ouvintes no documento, e as marcas direto nas classes: são de um gesto em
   curso, que nenhum redesenho precisa conhecer. A mesa do goldfish tem o
   arrastar dela (`table.ts`), e este não se mete: lá não há `.linha`. */
import { autoCategory, isCustomCategory } from "./deck";
import { findEntry, moveCard, setCategory } from "./editing";
import { OUT_OF_COUNT } from "./state";
import type { Board } from "./types";

let dragging: { name: string; board: Board } | null = null;

const targetOf = (e: DragEvent) => {
  const t = e.target as Element;
  return (t.closest?.("[data-categoria]") || t.closest?.(".painel-talvez")) as HTMLElement | null;
};

function clearMarks() {
  document.querySelectorAll(".alvo-solta").forEach((a) => a.classList.remove("alvo-solta"));
}

function onDragStart(e: DragEvent) {
  const row = (e.target as Element).closest?.(".linha") as HTMLElement | null;
  if (!row) return;
  dragging = { name: row.dataset.nome!, board: row.dataset.tabuleiro as Board };
  row.classList.add("arrastando");
  e.dataTransfer!.effectAllowed = "move";
  // Firefox só dispara `drop` quando alguma coisa foi escrita aqui.
  e.dataTransfer!.setData("text/plain", row.dataset.nome!);
}

function onDragEnd() {
  document.querySelectorAll(".linha.arrastando").forEach((l) => l.classList.remove("arrastando"));
  clearMarks();
  dragging = null;
}

function onDragOver(e: DragEvent) {
  if (!dragging) return;
  const target = targetOf(e);
  if (!target) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  if (!target.classList.contains("alvo-solta")) {
    clearMarks();
    target.classList.add("alvo-solta");
  }
}

function onDrop(e: DragEvent) {
  if (!dragging) return;
  const target = targetOf(e);
  if (!target) return;
  e.preventDefault();
  const { name, board } = dragging;
  const group = target.dataset.categoria !== undefined ? target : null;
  const destination = (group ? group.dataset.tabuleiro : "talvez") as Board;
  // Move primeiro, categoriza depois: as duas coisas guardam desfazer, e o
  // Ctrl+Z devolve o passo inteiro em dois toques em vez de um. Vale o
  // preço — a alternativa seria uma terceira função que faz as duas.
  if (destination !== board) moveCard(name, board, destination);
  if (group) {
    const cat = group.dataset.categoria!;
    // Grupo automático: a carta perde a categoria à mão e volta a ser
    // agrupada pelo tipo. Só faz sentido se for o tipo DELA — soltar uma
    // criatura em "Artefatos" não a transforma em artefato, então nesse
    // caso não há o que fazer e o silêncio é a resposta certa.
    const own = isCustomCategory(cat) || OUT_OF_COUNT.has(cat);
    const entry = findEntry(name, destination);
    if (own) setCategory(name, destination, cat);
    else if (entry && autoCategory(entry.carta) === cat) setCategory(name, destination, "");
  }
}

/* Liga os quatro ouvintes; devolve quem desliga. */
export function bindDeckDrag() {
  document.addEventListener("dragstart", onDragStart);
  document.addEventListener("dragend", onDragEnd);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);
  return () => {
    document.removeEventListener("dragstart", onDragStart);
    document.removeEventListener("dragend", onDragEnd);
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("drop", onDrop);
  };
}
