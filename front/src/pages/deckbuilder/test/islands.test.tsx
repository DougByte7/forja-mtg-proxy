/* As ilhas: o que o componente desenha a partir do estado. */
import { act } from "preact/test-utils";
import { render } from "preact";
import { entrada } from "./fixtures";
import { cleanup, clone } from "./harness";
import { ATRAXA, FOREST, page, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

describe("contador", () => {
  it("cinza montando, laranja passando, verde fechado, vermelho com erro de verdade", async () => {
    const p = await page({ deck: [entrada(SOL_RING)], maybe: [] });
    expect(p.counterView()).toMatchObject({ total: 2, status: "", title: "Faltam 98 carta(s) pras 100" });

    p.state.cartas = clone([entrada(FOREST, 101)]);
    expect(p.counterView()).toMatchObject({ total: 102, status: "passou" });

    p.state.cartas = clone([entrada(FOREST, 99)]);
    p.state.validacao = { ok: true, apontamentos: [] };
    expect(p.counterView().status).toBe("completo");

    p.state.validacao = { ok: false, apontamentos: [{ nivel: "erro", tipo: "identidade" }] };
    expect(p.counterView()).toMatchObject({ status: "erro", title: "1 problema(s) — veja a aba Análise" });
  });
});

describe("Meters", () => {
  it("redesenha quando a página redesenha", async () => {
    const p = await page({ deck: [], maybe: [] });
    p.state.comandantes = [];
    const host = document.createElement("div");
    act(() => render(<p.Meters />, host));
    expect(host.querySelector("#contador-n")!.textContent).toBe("0");
    expect((host.querySelector("#btn-total") as HTMLElement).hidden).toBe(true);

    p.state.comandantes = clone([ATRAXA]);
    act(() => p.desenharTudo());
    expect(host.querySelector("#contador-n")!.textContent).toBe("1");
    expect((host.querySelector("#btn-total") as HTMLElement).hidden).toBe(false);
  });
});

describe("toast", () => {
  it("aparece, e some sozinho mantendo o texto durante a saída", async () => {
    const p = await page();
    const host = document.createElement("div");
    act(() => render(<p.Toast />, host));
    act(() => p.toast("Deck salvo."));
    const el = host.querySelector("#toast")!;
    expect([el.textContent, el.className]).toEqual(["Deck salvo.", "toast mostra"]);
    act(() => { vi.advanceTimersByTime(2300); });
    expect([el.textContent, el.className]).toEqual(["Deck salvo.", "toast"]);
  });
});
