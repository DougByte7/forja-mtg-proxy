import { computeTotals, DEFAULT_PRICES } from "./totals";

describe("computeTotals", () => {
  it.each([
    // qty, versos, páginas, preenchidas na última, brancos
    [9, 0, 1, 9, 0],
    [10, 0, 2, 1, 8],
    [7, 2, 1, 9, 0],
    [4, 1, 1, 5, 4],
    [100, 3, 12, 4, 5],
  ])("%i cartas + %i versos", (qty, backs, pages, lastPageFilled, blanks) => {
    expect(computeTotals(qty, backs, "single", DEFAULT_PRICES))
      .toMatchObject({ pages, lastPageFilled, blanks });
  });

  it("arredonda o total nos centavos", () => {
    expect(computeTotals(27, 0, "double", DEFAULT_PRICES).total).toBe(10);
    expect(computeTotals(9, 0, "double", DEFAULT_PRICES).total).toBe(3.33);
    expect(computeTotals(8, 0, "foil", { ...DEFAULT_PRICES, foil: 9.5 }).total).toBe(9.5);
  });

  it.each([
    // qty, versos, páginas, preenchidas na última, brancos
    [8, 0, 1, 8, 0],
    [9, 0, 2, 1, 7],
    [6, 2, 1, 8, 0],
    [4, 1, 1, 5, 3],
  ])("foil: %i cartas + %i versos em folhas de 8", (qty, backs, pages, lastPageFilled, blanks) => {
    expect(computeTotals(qty, backs, "foil", DEFAULT_PRICES))
      .toMatchObject({ pages, lastPageFilled, blanks });
  });
});
