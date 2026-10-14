/* O paginador da busca. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

const EMPTY = { tipo: "", texto: "", cores: "", cmcMin: "", cmcMax: "", precoMax: "", ordem: "nome", ineditas: false };

it("existe quando a pessoa fez uma pergunta, e não com a caixa vazia", async () => {
  // Paginar a caixa vazia seria folhear a base de cinco em cinco. `cmcMin:
  // "0"` conta como filtro (ele vira chip na fita); as inéditas não, porque
  // ALARGAM a lista.
  const p = await page();
  const withFilters = (change: object, term = "") => {
    p.state.filtros = { ...EMPTY, ...change };
    return p.isPaged(term);
  };
  expect(withFilters({})).toBe(false);
  expect(withFilters({}, "bolt")).toBe(true);
  expect([withFilters({ tipo: "creature" }), withFilters({ cores: "G" }),
          withFilters({ cmcMin: "0" }), withFilters({ ordem: "preco_desc" })]).toEqual([true, true, true, true]);
  expect(withFilters({ ineditas: true })).toBe(false);
});

function mount(node: any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => render(node, host));
  return host;
}

it("sem paginador, a frase do fim diz o que fazer", async () => {
  const p = await page();
  const list = Array.from({ length: 24 }, (_, i) => ({ nome: "Carta " + i, tipo: "Instant",
    mana_cost: "{1}", preco_usd: 1, imagem: "", identidade: "", legal: true }));
  const host = mount(<p.SearchResults box="main" />);
  act(() => { p.state.resultados.main = { ...p.state.resultados.main, cards: list, term: "bolt", done: true }; p.touch(); });
  expect(host.querySelectorAll(".achado")).toHaveLength(5);
  expect(host.innerHTML).toContain("Escreva mais uma letra");
  act(() => { p.state.resultados.main = { ...p.state.resultados.main, term: "" }; p.touch(); });
  expect(host.innerHTML).toContain("Escreva um nome ou use os filtros");
});

it("antes de buscar não há nada; depois, a lista vazia diz que não achou", async () => {
  const p = await page();
  const host = mount(<p.SearchResults box="cmd" />);
  expect(host.innerHTML).toBe("");
  act(() => { p.state.resultados.cmd = { ...p.state.resultados.cmd, cards: [], done: true }; p.touch(); });
  expect(host.textContent).toBe("Nada com esse nome. Lembre: comandante é criatura lendária.");
});

it("o denominador vem do total do servidor, e o número não passa do fim", async () => {
  // 37 cartas de 5 em 5 são 8 páginas, e a oitava tem duas.
  const p = await page();
  Object.assign(p.state, { buscaTotal: 37, buscaPorPagina: 5, buscaPagina: 0 });
  const host = mount(<p.Pager />);
  const prev = () => host.querySelector('[aria-label="Página anterior"]') as HTMLButtonElement;
  const next = () => host.querySelector('[aria-label="Próxima página"]') as HTMLButtonElement;
  expect(host.textContent).toContain("1 / 8");
  expect([prev().disabled, next().disabled]).toEqual([true, false]);
  act(() => { p.state.buscaPagina = 7; p.touch(); });
  expect([prev().disabled, next().disabled]).toEqual([false, true]);
  act(() => { p.state.buscaPorPagina = 15; p.touch(); });
  expect((host.querySelector("#res-por-pagina") as HTMLSelectElement).value).toBe("15");
  // 37 de 15 em 15 são 3: a página 7 não existe mais.
  expect(host.textContent).toContain("3 / 3");
});

it("o teclado anda pela lista e o Enter manda a destacada pro destino", async () => {
  const p = await page({ deck: [], maybe: [] });
  const cards = ["Alfa", "Beta", "Gama"].map((nome) => ({ nome, tipo: "Instant", identidade: "", legal: true }));
  const input = document.createElement("input");
  document.body.appendChild(input);
  p.bindSearchKeys(input, "main");
  const host = mount(<p.SearchResults box="main" />);
  act(() => { p.state.resultados.main = { ...p.state.resultados.main, cards, term: "a", done: true }; p.touch(); });

  const key = (k: string) => act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  key("ArrowDown"); key("ArrowDown");
  expect(host.querySelector(".achado.destacado")!.textContent).toContain("Beta");
  key("ArrowUp"); key("ArrowUp");
  expect(host.querySelector(".achado.destacado")!.textContent).toContain("Gama");   // dá a volta
  key("Enter");
  expect(p.state.cartas.map((e: any) => e.carta.nome)).toEqual(["Gama"]);
  expect(host.querySelector(".achado.destacado")).toBeNull();

  p.chooseDestination("side");
  act(() => (host.querySelector(".achado") as HTMLButtonElement).click());
  expect(p.state.cartas.find((e: any) => e.carta.nome === "Alfa").categoria).toBe("Sideboard");
});

it("as setas param nas pontas, e trocar o tamanho volta pro começo", async () => {
  // "Página 4" de 5 em 5 não é a mesma coisa que "página 4" de 15 em 15.
  const p = await page();
  p.state.filtros.tipo = "creature";
  Object.assign(p.state, { buscaTotal: 37, buscaPorPagina: 5, buscaPagina: 0 });
  p.turnPage(-1);
  expect(p.state.buscaPagina).toBe(0);
  p.turnPage(1);
  expect(p.state.buscaPagina).toBe(1);
  p.state.buscaPagina = 7;
  p.turnPage(1);
  expect(p.state.buscaPagina).toBe(7);
  p.setPageSize(15);
  expect([p.state.buscaPorPagina, p.state.buscaPagina]).toEqual([15, 0]);
});
