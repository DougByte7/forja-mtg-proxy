import cases from "./preview.cases.json";
import { localSummary, printOrder, selectionKey, slotsOf } from "./preview";

/* Os mesmos casos que o `tests/test_combos.py` confere contra
   `calc.resumo_combinado`: se as duas contas divergirem, um dos lados falha. */
describe("localSummary bate com o backend", () => {
  it.each(cases.map((c) => [c.caso, c] as const))("%s", (_, c) => {
    const r = localSummary(c.pedidos);
    expect({
      cartas: r.cards,
      paginas_separadas: r.separate,
      paginas_combinadas: r.combined,
      folhas_economizadas: r.sheetsSaved,
      brancos_separados: r.separateBlanks,
      brancos: r.blanks,
      brancos_evitados: r.blanksSaved,
    }).toEqual(c.esperado);
  });
});

describe("preview", () => {
  it("slots nunca negativos", () => {
    expect(slotsOf({ pages: 1, blanks: 12 })).toBe(0);
    expect(slotsOf({ pages: 2, blanks: 3 })).toBe(15);
  });

  it("ordem de impressão: mais antigo primeiro, desempate pelo id", () => {
    const list = [{ id: "b", created_at: 5 }, { id: "a", created_at: 5 }, { id: "c", created_at: 1 }];
    expect(printOrder(list).map((o) => o.id)).toEqual(["c", "a", "b"]);
  });

  it("chave da seleção não depende da ordem do clique", () => {
    expect(selectionKey(["z", "a", "m"])).toBe(selectionKey(new Set(["m", "z", "a"])));
  });
});
