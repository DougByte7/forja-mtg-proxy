/* A página do deckbuilder sobe: a marcação de verdade, a API de mentira, e
   a entrada roda sem exceção nenhuma — síncrona ou na volta da rede. É o
   teste que pega módulo que o build não achou, nome que um import esqueceu
   ou elemento que a marcação perdeu. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(import.meta.dirname, "../../../pages/deckbuilder.html"), "utf-8");

function respond(url: string) {
  if (url.startsWith("/cartas/estado")) return { cartas: 1000, rodando: false };
  if (url.startsWith("/conta")) return { usuario: null };
  if (url.startsWith("/cambio")) return { valor: 5, fonte: "teste" };
  if (url.startsWith("/cartas/busca") || url.startsWith("/cartas/comandantes")) return { cartas: [], total: 0 };
  return {};
}

describe("deckbuilder", () => {
  it("abre sem erro, com o deck vazio na tela", async () => {
    document.body.innerHTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"))
      .replace(/<script[\s\S]*?<\/script>/g, "");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(respond(url)), { status: 200 });
    }));
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    process.on("unhandledRejection", (e) => errors.push(e));

    await import("./abertura.js");
    await new Promise((r) => setTimeout(r, 50));

    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
    expect((document.getElementById("nome-deck") as HTMLInputElement).value).toBe("Deck sem nome");
    expect(calls.some((u) => u.startsWith("/cartas/estado"))).toBe(true);
    vi.unstubAllGlobals();
  });
});
