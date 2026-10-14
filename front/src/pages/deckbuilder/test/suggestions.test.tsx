/* As sugestões do EDHREC: o cabeçalho diz de quem é a lista, adicionar tira
   a carta da lista, e o tema pede de novo. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { carta } from "./fixtures";
import { cleanup, clone } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

const RESPONSE = (alvo: any = { tipo: "comandante" }) => clone({
  alvo, link: "https://edhrec.com/commanders/atraxa", cache: false,
  temas: [{ slug: "superfriends", nome: "Superfriends", decks: 1200 }],
  listas: [{ titulo: "Mais jogadas", cartas: [
    { carta: carta("Doubling Season", "Enchantment", "G", "{4}{G}", 5, 50), sinergia: 30, porcento: 40 },
    { carta: carta("Deepglow Skate", "Creature — Fish", "U", "{4}{U}", 5, 2), sinergia: 5 }] }],
});

function mount(p: any) {
  const host = document.createElement("div");
  act(() => render(<p.SuggestionsPanel />, host));
  return host;
}

it("do comandante: alvo por extenso, sinergia alta acima de 25, e adicionar tira da lista", async () => {
  const p = await page({ deck: [], maybe: [] });
  p.state.suggestions = RESPONSE();
  const host = mount(p);
  expect(host.querySelector(".quem")!.textContent).toBe("Para o comandante Atraxa");
  expect(host.querySelector(".voltar")).toBeNull();
  expect([...host.querySelectorAll(".sinergia")].map((s) => s.className)).toEqual(["sinergia alta", "sinergia"]);
  act(() => (host.querySelector(".achado") as HTMLButtonElement).click());
  expect(p.state.cards.map((e: any) => e.carta.nome)).toEqual(["Doubling Season"]);
  expect([...host.querySelectorAll(".achado b")].map((b) => b.textContent)).toEqual(["Deepglow Skate"]);
});

it("de uma carta: o alvo é ela, a régua da sinergia é outra, e dá pra voltar", async () => {
  const p = await page();
  p.state.suggestions = RESPONSE({ tipo: "carta", nome: "Sol Ring" });
  const host = mount(p);
  expect(host.querySelector(".quem")!.textContent).toBe("A partir da carta Sol Ring");
  expect(host.querySelectorAll(".sinergia.alta")).toHaveLength(0);   // 30 < 100
  expect(host.querySelector(".voltar")).not.toBeNull();
});

it("o tema pede de novo, com o alvo dito enquanto espera; o erro toma o lugar", async () => {
  const p = await page();
  p.state.id = "abc";
  p.state.suggestions = RESPONSE();
  const fetch = vi.fn((_url: string, _init?: any) => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  const host = mount(p);
  act(() => ([...host.querySelectorAll(".temas .chip")][1] as HTMLButtonElement).click());
  expect(host.textContent).toBe("Perguntando ao EDHREC sobre Atraxa…");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ tema: "superfriends", carta: null });
  act(() => { p.state.suggestionsLoading = false; p.state.suggestionsError = "EDHREC fora do ar."; p.touch(); });
  expect(host.querySelector(".aponta.erro")!.textContent).toBe("EDHREC fora do ar.");
});
