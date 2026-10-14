/* Os filtros: a gaveta, a fita e o botão desenham do mesmo estado. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

function mount(node: any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => render(node, host));
  return host;
}

it("a fita e a bolinha contam o que está ligado; o ✕ devolve ao neutro", async () => {
  const p = await page();
  const button = mount(<p.FiltersButton />);
  const tape = mount(<p.FilterTape />);
  expect((button.querySelector("#conta-filtros") as HTMLElement).hidden).toBe(true);

  act(() => p.updateFilters({ type: "creature", cmcMin: "2", cmcMax: "4", order: "preco_desc" }));
  expect([...tape.querySelectorAll(".ligado b")].map((b) => b.textContent)).toEqual(["Criatura", "custo 2–4", "preço"]);
  expect(button.querySelector("#conta-filtros")!.textContent).toBe("3");
  expect(button.querySelector("button")!.className).toContain("ouro");
  // a seta é conteúdo, com nome pro leitor de tela
  expect(tape.querySelector('svg[aria-label="maior primeiro"]')).not.toBeNull();

  act(() => (tape.querySelectorAll(".ligado button")[1] as HTMLButtonElement).click());
  expect([p.state.filters.cmcMin, p.state.filters.cmcMax]).toEqual(["", ""]);
  act(() => p.clearFilters());
  expect(tape.innerHTML).toBe("");
});

it("o campo de efeito guarda o texto aparado sem comer o espaço de quem digita", async () => {
  const p = await page();
  const fields = mount(<p.FilterFields />);
  const input = fields.querySelector("#f-texto") as HTMLInputElement;
  input.focus();
  input.value = "draw ";
  act(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(p.state.filters.text).toBe("draw");
  expect(input.value).toBe("draw ");          // o espaço continua no campo
  input.blur();
  act(() => p.clearFilters());
  expect(input.value).toBe("");               // fora do foco, acompanha o estado
});

it("os dois interruptores de inéditas mostram o mesmo filtro", async () => {
  const p = await page();
  const fields = mount(<p.FilterFields />);
  const hero = mount(<p.HeroUnreleasedSwitch />);
  const drawerBox = () => (fields.querySelector("#f-ineditas") as HTMLInputElement).checked;
  act(() => (hero.querySelector("#cmd-ineditas") as HTMLInputElement).click());
  expect([p.state.filters.unreleased, drawerBox()]).toEqual([true, true]);
  act(() => (fields.querySelector('[data-cor="G"]') as HTMLButtonElement).click());
  expect(p.state.filters.colors).toBe("G");
  expect(fields.querySelector('[data-cor="G"]')!.getAttribute("aria-pressed")).toBe("true");
});
