/* O aviso que aparece embaixo e some sozinho. O texto fica enquanto ele
   desaparece (a transição é no `.mostra`), senão a caixa encolheria vazia. */
import { signal } from "@preact/signals";

const message = signal("");
const visible = signal(false);
let timer = 0;

export function toast(msg: string) {
  message.value = msg;
  visible.value = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => { visible.value = false; }, 2200);
}

export function Toast() {
  return <div class={"toast" + (visible.value ? " mostra" : "")} id="toast" role="status">{message.value}</div>;
}
