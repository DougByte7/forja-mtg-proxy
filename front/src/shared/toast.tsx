/* O aviso que aparece embaixo e some sozinho. Um só por vez: um novo
   substitui o anterior, como era nas páginas antigas. */
import { signal } from "@preact/signals";

const message = signal("");
let timer = 0;

export function toast(msg: string, ms = 2600) {
  message.value = msg;
  clearTimeout(timer);
  timer = window.setTimeout(() => { message.value = ""; }, ms);
}

export function Toast() {
  return message.value ? <div class="toast" role="status">{message.value}</div> : null;
}
