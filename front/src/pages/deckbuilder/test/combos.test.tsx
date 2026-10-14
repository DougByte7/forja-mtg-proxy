/* Os combos: as duas listas, o botão que fecha um combo e a conta local
   que move o combo fechado de lista sem perguntar de novo ao Spellbook. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { carta } from "./fixtures";
import { cleanup, clone } from "./harness";
import { page, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

const FINKS = carta("Kitchen Finks", "Creature — Ouphe", "GW", "{1}{G/W}", 3, 0.5);
const combo = (pieces: any[], extra = {}) => ({
  pecas: pieces, requer: [], produz: ["Vida infinita"], faltam: pieces.filter((p) => !p.no_deck).map((p) => p.nome),
  link: "https://commanderspellbook.com/combo/1", mana: "{1}", prerequisitos: "", ...extra,
});
const RESPONSE = () => clone({
  no_deck: [combo([{ ...SOL_RING, no_deck: true }, { nome: "Ashnod's Altar", no_deck: true }], { produz: ["Mana infinita"], custo_usd: 10 })],
  faltando_uma: [combo([{ ...SOL_RING, no_deck: true }, { ...FINKS, no_deck: false, preco_usd: 0.5 }], { custo_faltando_usd: 0.5 })],
});

function mount(Component: any) {
  const host = document.createElement("div");
  act(() => render(<Component />, host));
  return host;
}

it("as duas listas, com o preço que cada uma pergunta", async () => {
  const p = await page();
  p.state.combos = RESPONSE();
  p.state.combosAssinatura = p.deckSignature();
  const deck = mount(p.DeckCombos);
  const near = mount(p.NearCombos);
  expect(deck.querySelector(".produz")!.textContent).toBe("Resulta em: Mana infinita");
  expect(deck.querySelector(".custo")!.textContent).toBe("US$ 10.00");
  expect(deck.querySelector(".add-peca")).toBeNull();
  expect(near.querySelector(".custo.fechar")!.textContent).toBe("fechar por US$ 0.50");
  expect(near.querySelector(".add-peca")!.textContent).toBe(" Kitchen Finks · US$ 0.50");
  expect(near.querySelector(".precisa .pip")).not.toBeNull();
  expect(deck.textContent).not.toContain("O deck mudou");
});

it("adicionar a peça que falta fecha o combo aqui mesmo", async () => {
  const p = await page();
  p.state.combos = RESPONSE();
  p.state.combosAssinatura = p.deckSignature();
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.startsWith("/cartas/busca") ? new Response(JSON.stringify({ cartas: [FINKS] }))
      : new Promise(() => {})));
  const deck = mount(p.DeckCombos);
  const near = mount(p.NearCombos);

  await act(async () => { (near.querySelector(".add-peca") as HTMLButtonElement).click(); });
  await act(async () => { await vi.waitFor(() => expect(p.state.combos.faltando_uma).toHaveLength(0)); });

  expect(p.state.cartas.map((e: any) => e.carta.nome)).toContain("Kitchen Finks");
  expect(p.state.combos.no_deck.map((c: any) => c.produz[0])).toEqual(["Vida infinita", "Mana infinita"]);
  expect(near.textContent).toContain("Nenhum combo a uma carta de fechar");
  // A lista está em dia com o deck: no lugar do "procure de novo", o recado.
  expect(deck.textContent).not.toContain("O deck mudou");
  expect(deck.querySelector(".combo-mexido")!.textContent).toContain("1 combo(s) fecharam aqui na tela");
});

it("o deck que muda depois da busca ganha o aviso, e esperando/erro valem pras duas", async () => {
  const p = await page();
  p.state.combos = RESPONSE();
  p.state.combosAssinatura = "outro deck";
  const deck = mount(p.DeckCombos);
  const near = mount(p.NearCombos);
  expect(deck.textContent).toContain("O deck mudou desde esta busca");
  act(() => { p.state.combosRodando = true; p.touch(); });
  expect([deck.textContent, near.textContent]).toEqual(["Perguntando ao Spellbook…", "Perguntando ao Spellbook…"]);
  act(() => { p.state.combosRodando = false; p.state.combosErro = "Spellbook fora do ar."; p.touch(); });
  expect(near.querySelector(".aponta.erro")!.textContent).toBe("Spellbook fora do ar.");
});
