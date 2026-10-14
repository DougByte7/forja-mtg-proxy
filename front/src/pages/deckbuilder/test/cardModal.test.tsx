/* A modal da carta inteira: abre na hora com o que a base local sabe, e o
   detalhe da Scryfall completa depois. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { page, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

async function modal() {
  const p = await page();
  const host = document.createElement("div");
  document.body.append(host);
  act(() => render(<p.CardModal />, host));
  return { p, host };
}

describe("a modal da carta", () => {
  it("abre com a carta local enquanto a Scryfall não responde, e fecha com desvanecer", async () => {
    const { p, host } = await modal();
    expect(host.querySelector<HTMLElement>("#carta-fundo")!.hidden).toBe(true);

    act(() => p.openCard(SOL_RING));
    act(() => { vi.advanceTimersByTime(20); });
    expect(host.querySelector("#carta-titulo")!.firstChild!.textContent).toBe("Sol Ring");
    expect(host.querySelector(".carta-nota")!.textContent).toContain("Buscando edição");
    expect([p.isCardOpen(), host.querySelector("#carta-fundo")!.classList.contains("aberta")]).toEqual([true, true]);
    expect(document.activeElement!.id).toBe("btn-fechar-carta");

    act(() => (host.querySelector("#btn-fechar-carta") as HTMLElement).click());
    expect([p.isCardOpen(), host.querySelector("#carta-titulo")?.firstChild?.textContent]).toEqual([false, "Sol Ring"]);
    act(() => { vi.advanceTimersByTime(250); });
    expect(host.querySelector<HTMLElement>("#carta-fundo")!.hidden).toBe(true);
  });

  it("com o detalhe: regras, ficha técnica e os preços crus de cada mercado", async () => {
    const { p, host } = await modal();
    act(() => {
      p.openCard(SOL_RING);
      p.cardModal.value = { card: SOL_RING, info: {
        edicao: "Commander Masters", edicao_sigla: "CMM", raridade: "uncommon", lancamento: "2023-08-04",
        regras: [{ data: "2020-01-01", texto: "Gera {C}{C}." }], precos: { usd: "1.50", eur: "1.20" },
      } };
    });
    const text = host.querySelector("#carta-corpo")!.textContent!;
    expect(text).toContain("Notas e regras (1)");
    expect(text).toContain("01/01/2020");
    expect(text).toContain("Incomum");
    expect(text).toContain("04/08/2023");
    expect([...host.querySelectorAll(".carta-chip")].map((c) => c.textContent)).toEqual(["US$ 1.50", "€ 1.20"]);
  });
});
