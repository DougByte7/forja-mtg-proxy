/* O que os componentes do topo desenham a partir do estado. */
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

    p.state.cards = clone([entrada(FOREST, 101)]);
    expect(p.counterView()).toMatchObject({ total: 102, status: "passou" });

    p.state.cards = clone([entrada(FOREST, 99)]);
    p.state.validation = { ok: true, apontamentos: [] };
    expect(p.counterView().status).toBe("completo");

    p.state.validation = { ok: false, apontamentos: [{ nivel: "erro", tipo: "identidade" }] };
    expect(p.counterView()).toMatchObject({ status: "erro", title: "1 problema(s) — veja a aba Análise" });
  });
});

describe("Meters", () => {
  it("redesenha quando a página redesenha", async () => {
    const p = await page({ deck: [], maybe: [] });
    p.state.commanders = [];
    const host = document.createElement("div");
    act(() => render(<p.Meters />, host));
    expect(host.querySelector("#contador-n")!.textContent).toBe("0");
    expect((host.querySelector("#btn-total") as HTMLElement).hidden).toBe(true);

    p.state.commanders = clone([ATRAXA]);
    act(() => p.redrawAll());
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

describe("lista do deck", () => {
  it("o número de quantidade não é reescrito enquanto a pessoa digita", async () => {
    const p = await page();
    const host = document.createElement("div");
    document.body.appendChild(host);
    act(() => render(<p.BoardList board="deck" />, host));
    const input = host.querySelector('[data-qtd="Sol Ring"]') as HTMLInputElement;
    expect(input.value).toBe("1");

    input.focus();
    input.value = "3";                      // digitando, ainda sem o change
    act(() => p.touch());                   // a página redesenha por outro motivo
    expect(input.value).toBe("3");

    input.blur();
    act(() => { p.state.cards[0].quantidade = 2; p.touch(); });
    expect(input.value).toBe("2");
    host.remove();
  });
});
