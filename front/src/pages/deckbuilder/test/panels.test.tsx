/* As abas que listam o que o servidor respondeu: tokens e histórico. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

function mount(Component: any) {
  const host = document.createElement("div");
  act(() => render(<Component />, host));
  return host;
}

describe("aba Tokens", () => {
  it("procurando, erro, nada a levar e os grupos com a contagem na aba", async () => {
    const p = await page();
    const panel = mount(p.TokensPanel);
    const count = mount(p.TokensTabCount);
    const note = () => (panel.querySelector("#tokens-nota") as HTMLElement).hidden;
    expect(panel.querySelector("#tokens-resultado")!.textContent).toBe("");
    expect(note()).toBe(false);

    act(() => { p.state.tokensLoading = true; p.touch(); });
    expect(panel.textContent).toContain("Procurando…");

    act(() => { p.state.tokensLoading = false; p.state.tokensError = "Fora do ar."; p.touch(); });
    expect(panel.querySelector(".aponta.erro")!.textContent).toBe("Fora do ar.");
    expect(note()).toBe(false);

    act(() => { p.state.tokensError = null; p.state.tokens = { total: 0, grupos: [] }; p.touch(); });
    expect(panel.textContent).toContain("não há nada a levar");
    expect(count.textContent).toBe("");

    act(() => {
      p.state.tokens = { total: 2, grupos: [{ carta: "Krenko", imagem: "http://arte/krenko",
        tokens: [{ nome: "Goblin", tipo: "Token Creature — Goblin", poder: "1", resistencia: "1",
                   imagem: "http://arte/goblin", imagem_verso: "http://arte/goblin-verso" }] }] };
      p.touch();
    });
    expect(note()).toBe(true);
    expect(panel.querySelector(".token-grupo .peca")!.getAttribute("data-arte")).toBe("http://arte/krenko");
    // uma imagem por face
    expect([...panel.querySelectorAll("img.token")].map((i) => i.getAttribute("title")))
      .toEqual(["Goblin — Token Creature — Goblin 1/1", "Goblin — Token Creature — Goblin 1/1"]);
    expect(count.textContent).toBe("2");
  });
});

describe("aba Histórico", () => {
  it("carregando, e o erro no lugar da lista", async () => {
    const p = await page();
    const host = mount(p.History);
    expect(host.textContent).toBe("Carregando…");
    act(() => { p.state.historyError = "Deck não encontrado."; p.touch(); });
    expect(host.textContent).toBe("Não consegui abrir o histórico: Deck não encontrado.");
  });
});
