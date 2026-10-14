/* A aba de análise: as contas e o que os componentes mostram. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { carta, entrada } from "./fixtures";
import { cleanup, clone } from "./harness";
import { ELVES, FOREST, page, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

function mount(Component: any) {
  const host = document.createElement("div");
  act(() => render(<Component />, host));
  return host;
}

describe("odds", () => {
  it("a hipergeométrica bate com a conta feita à mão", async () => {
    const p = await page();
    // 10 cartas, 3 da categoria, 2 compras: exatamente 1 = C(3,1)·C(7,1)/C(10,2) = 21/45.
    expect(p.hypergeometric(10, 3, 2, 1)).toBeCloseTo(21 / 45, 10);
    let sum = 0;
    for (let k = 0; k <= 7; k++) sum += p.hypergeometric(99, 36, 7, k);
    expect(sum).toBeCloseTo(1, 10);
    expect(p.chanceAtLeast(99, 99, 7, 1)).toBeCloseTo(1, 10);
    expect(p.chanceAtLeast(99, 0, 7, 1)).toBe(0);
  });

  it("o mulligan grátis é uma segunda mão independente", async () => {
    const p = await page();
    const one = p.chanceAtLeast(99, 10, 7, 1);
    expect(p.chanceWithMulligan(99, 10, 1)).toBeCloseTo(1 - (1 - one) ** 2, 10);
  });

  it("com menos de 10 cartas não há tabela; com a lista cheia, os riscos da mana", async () => {
    const small = await page({ deck: [entrada(SOL_RING)], maybe: [] });
    expect(small.oddsView().rows).toBeNull();
    const p = await page({ deck: [entrada(FOREST, 36), entrada(ELVES, 63)], maybe: [], categorias: [] });
    const o = p.oddsView();
    expect(o.N).toBe(99);
    expect(o.rows.map((r: any) => [r.category, r.K])).toEqual([["Criaturas", 63], ["Terrenos", 36]]);
    expect(o.shortage.level).toBe("ok");
    expect(o.flood.level).toBe("ok");
  });

  it("as categorias próprias vêm em cima, na ordem da pessoa", async () => {
    const p = await page();
    p.state.cartas = clone([...Array(12)].map((_, i) => entrada(carta(`c${i}`, "Instant"), 1, i % 2 ? "Sac outlet" : "")));
    expect(p.oddsView().rows.map((r: any) => [r.category, r.isCustom])).toEqual([
      ["Sac outlet", true], ["Instantâneos", false]]);
  });
});

describe("analysis", () => {
  it("agrupa os apontamentos por tipo, com os nomes juntos", async () => {
    const p = await page();
    const issues = [...Array(8)].map((_, i) => ({ tipo: "identidade", nivel: "erro", mensagem: "x", carta: `C${i}` }));
    expect(p.groupIssues([...issues, { tipo: "banida", nivel: "erro", mensagem: "Black Lotus é banida." }])).toEqual([
      { level: "erro", title: "Fora da identidade de cor", text: "8 cartas: C0, C1, C2, C3, C4, C5 e mais 2" },
      { level: "erro", title: "", text: "Black Lotus é banida." },
    ]);
  });

  it("a curva deixa o terreno de fora e junta 7+", async () => {
    const p = await page({ deck: [entrada(FOREST, 10), entrada(ELVES, 2), entrada(carta("Big", "Creature", "", "{9}", 9), 1)], maybe: [] });
    expect(p.manaCurve()).toEqual([0, 2, 0, 0, 0, 0, 0, 1]);
  });

  it("cor é o que o custo PEDE, e híbrido conta pras duas; tipo é o automático", async () => {
    const p = await page({ deck: [entrada(ELVES, 3), entrada(carta("Finks", "Creature", "GW", "{1}{G/W}"), 1, "Combo")], maybe: [] });
    expect(p.colorDemand().map((c: any) => [c.color, c.count])).toEqual([["W", 1], ["G", 4]]);
    expect(p.typeCounts().map((t: any) => [t.category, t.count])).toEqual([["Criaturas", 4]]);
  });
});

describe("componentes", () => {
  it("a análise mostra a barra de montagem e os erros agrupados", async () => {
    const p = await page();
    p.state.validacao = { ok: false, total: 40, apontamentos: [
      { tipo: "faltam", nivel: "aviso", mensagem: "Faltam 60" },
      { tipo: "banida", nivel: "erro", mensagem: "Black Lotus é banida.", carta: "Black Lotus" }] };
    const host = mount(p.Issues);
    expect(host.querySelector(".progresso b")!.textContent).toBe("40/100");
    expect(host.querySelector(".aponta.erro")!.textContent).toContain("Black Lotus é banida.");
    const alerts = mount(p.DeckAlerts);
    expect(alerts.querySelectorAll(".aponta.erro")).toHaveLength(1);
  });

  it("o nível de poder: carregando, erro e o resultado", async () => {
    const p = await page();
    const host = mount(p.Power);
    expect(host.innerHTML).toBe("");
    act(() => { p.state.poderRodando = true; p.touch(); });
    expect(host.textContent).toBe("Classificando…");
    act(() => {
      p.state.poderRodando = false;
      p.state.poder = { bracket: 3, nome: "Turbinado", explicacao: "Até três game changers.",
                        motivos: [{ titulo: "Game changers", detalhe: "2 no deck", cartas: ["Rhystic Study"] }] };
      p.state.poderAssinatura = p.deckSignature();
      p.touch();
    });
    expect(host.querySelector(".degrau.aqui .n")!.textContent).toBe("3");
    expect(host.querySelector(".poder-nome")!.textContent).toBe("Bracket 3 — Turbinado");
    expect(host.textContent).not.toContain("O deck mudou");
    act(() => { p.state.cartas.push(clone(entrada(ELVES))); p.touch(); });
    expect(host.textContent).toContain("O deck mudou desde esta estimativa");
  });
});
