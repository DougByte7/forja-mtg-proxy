/* A aba Mana base: o que ela mostra e o que os cliques fazem com o deck. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { carta } from "./fixtures";
import { cleanup, clone } from "./harness";
import { FOREST, page } from "./sampleDeck";

afterEach(cleanup);

const LAND = (nome: string, extra = {}) => ({ ...carta(nome, "Land — Forest Plains", "GW", "", 0, 2), produz: "GW", ...extra });
const RESPONSE = () => clone({
  terrenos: { tem: 30, recomendado: 36, diferenca: -6 },
  cmc_media: 3.1, magias: 62, rampas_baratas: 1,
  cores: [{ cor: "G", nome: "Verde", pips: 40, parte: 0.6, fontes: 20, pedidas: 18, faltam: 0 },
          { cor: "W", nome: "Branco", pips: 20, parte: 0.4, fontes: 8, pedidas: 12, faltam: 4 }],
  base_atual: { entrada: { desvirada: 28, virada: 2 }, grupos: [{ id: "shocks", nome: "Shocks", quantidade: 2, cartas: ["Temple Garden"] }] },
  basicos: [{ nome: "Plains", cor: "W", quantidade: 4, carta: carta("Plains", "Basic Land — Plains", "", "", 0, 0.1, true) },
            { nome: "Forest", cor: "G", quantidade: 2, carta: FOREST }],
  fixadores: [{ id: "shocks", nome: "Shocks", descricao: "Pagam 2 de vida.", grupo: "desviradas", total: 3, no_deck: 1,
                terrenos: [LAND("Temple Garden", { no_deck: true }), LAND("Overgrown Tomb")] }],
  teto_usd: 3,
});

function mount(p: any) {
  const host = document.createElement("div");
  act(() => render(<p.ManabasePanel />, host));
  return host;
}

it("o retrato: veredito, fontes por cor e a nota escondida", async () => {
  const p = await page();
  p.state.manabase = RESPONSE();
  const host = mount(p);
  expect(host.querySelector(".mb-veredito")!.textContent).toBe("Faltam 6");
  expect([...host.querySelectorAll(".mb-cor .num")].map((n) => n.textContent)).toEqual(["20/18", "8/12"]);
  expect(host.querySelector(".dif.falta")!.textContent).toBe("faltam 4");
  expect((host.querySelector("#mb-nota") as HTMLElement).hidden).toBe(true);
  // a cor que falta ganha o anel na linha do terreno
  expect(host.querySelectorAll(".mb-terreno .pip.W.cobre").length).toBeGreaterThan(0);
});

it("básicos um a um ou todos, e o terreno de fixar com um clique", async () => {
  const p = await page({ deck: [], maybe: [] });
  p.state.manabase = RESPONSE();
  const host = mount(p);
  const count = (nome: string) => p.state.cartas.find((e: any) => e.carta.nome === nome)?.quantidade ?? 0;

  act(() => (host.querySelector(".mb-basico") as HTMLButtonElement).click());
  expect(count("Plains")).toBe(4);
  act(() => (host.querySelector(".mb-basicos .add-peca") as HTMLButtonElement).click());
  expect([count("Plains"), count("Forest")]).toEqual([8, 2]);

  const lands = host.querySelectorAll(".mb-terreno");
  act(() => (lands[0] as HTMLButtonElement).click());   // já no deck: nada
  expect(count("Temple Garden")).toBe(0);
  act(() => (lands[1] as HTMLButtonElement).click());
  expect(count("Overgrown Tomb")).toBe(1);
});

it("o teto de preço pede de novo ao servidor, em dólar", async () => {
  const p = await page();
  p.state.id = "abc";
  p.state.manabase = RESPONSE();
  const fetch = vi.fn((_url: string) => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  const host = mount(p);
  act(() => ([...host.querySelectorAll(".mb-teto .chip")].at(-1) as HTMLButtonElement).click());
  expect(p.state.manabaseTeto).toBe(999);
  expect(fetch.mock.calls[0][0]).toBe("/decks/abc/manabase?teto=999");
});

it("abrir um ciclo mostra só ele, com a volta pra visão geral", async () => {
  const p = await page();
  p.state.manabase = RESPONSE();
  const host = mount(p);
  act(() => (host.querySelector(".mb-base-grupo") as HTMLButtonElement).click());
  expect(p.state.mbCategoria).toBe("shocks");
  expect(host.querySelector(".mb-ciclo.aberto h3")!.textContent).toBe("Shocks");
  expect(host.querySelector(".mb-chegando")).not.toBeNull();   // 2 de 4 na tela
  act(() => (host.querySelector(".mb-ciclo.aberto .mb-ver") as HTMLButtonElement).click());
  expect(host.querySelector(".mb-ciclo.aberto")).toBeNull();
});
