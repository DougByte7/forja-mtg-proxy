/* O aparato dos testes do deckbuilder: a página de verdade, sem rede.

   Cada `freshPage()` sobe um deckbuilder novo — marcação da página, módulos
   recarregados do zero (o `estado` é por módulo) e tempo de mentira, pra o
   autosave agendado nunca disparar. Só a entrada (`abertura.js`) fica de
   fora: ela é a única que vai à rede e liga a tela. O `fetch` devolve uma
   promessa que nunca resolve, e assim nada que um teste dispare por tabela
   chega a falar com servidor nenhum. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(import.meta.dirname, "../../../../pages/deckbuilder.html"), "utf-8");
const BODY = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"))
  .replace(/<script[\s\S]*?<\/script>/g, "");

const MODULES = import.meta.glob(["../*.js", "!../abertura.js"]);

export type Page = Record<string, any>;

export async function freshPage(): Promise<Page> {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = BODY;
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const loaded = await Promise.all(Object.values(MODULES).map((load) => load()));
  return Object.assign({}, ...loaded);
}

export function cleanup() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

/** Cópia funda: o estado da página muda as entradas no lugar. */
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
