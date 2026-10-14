/* A página do deckbuilder sobe: a marcação de verdade, a API de mentira, e
   a entrada roda sem exceção nenhuma — síncrona ou na volta da rede. É o
   teste que pega módulo que o build não achou ou nome que um import
   esqueceu. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

    await import("./main");
    await new Promise((r) => setTimeout(r, 50));

    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
    expect((document.getElementById("nome-deck") as HTMLInputElement).value).toBe("Deck sem nome");
    expect(document.getElementById("contador-n")?.textContent).toBe("0");
    // Sem comandante, a tela é a pergunta do comandante.
    expect(document.getElementById("heroi")).not.toBeNull();
    expect(document.getElementById("area-deck")?.hidden).toBe(true);
    expect(document.getElementById("btn-total")?.hidden).toBe(true);
    expect(calls.some((u) => u.startsWith("/cartas/estado"))).toBe(true);
    vi.unstubAllGlobals();
  });
});

/* Um arquivo na pasta que nenhum `import` alcança é código que não roda — e
   que nenhum teste roda, porque o build e os testes partem da entrada. */
it("todo módulo da pasta é alcançado pela entrada", () => {
  const dir = resolve(import.meta.dirname);
  const seen = new Set<string>();
  const exists = (f: string) => { try { return statSync(f).isFile(); } catch { return false; } };
  /* "./state" é "./state.ts", "./ui/Meters" é ".tsx": o Vite resolve sem
     extensão, e este teste tem de resolver igual. */
  const resolveImport = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    return [base, base + ".ts", base + ".tsx", base + ".js"].find(exists);
  };
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(/^import\s*(?:type\s*)?\{[^}]*\}\s*from\s*"(\.\.?\/[^"]+)";/gm)) {
      const target = resolveImport(file, m[1]);
      if (target && target.startsWith(dir)) visit(target);
    }
  };
  visit(resolve(dir, "main.tsx"));
  const all = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /\.(js|ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith("test"))
    .map((f) => resolve(dir, f));
  expect(all.filter((f) => !seen.has(f)).map((f) => f.slice(dir.length + 1))).toEqual([]);
  expect(seen.size).toBeGreaterThan(20);
});
