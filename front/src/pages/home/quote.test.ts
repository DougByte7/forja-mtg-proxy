import { groupOf, money, quoteView, type QuoteResult } from "./quote";

const LIGA = { id: "liga", rotulo: "LigaMagic", moeda: "BRL", total: 100, observacao: "menor preço" };
const SCRY = { id: "scry", rotulo: "Scryfall", moeda: "USD", total: 15, observacao: "TCGplayer" };

const line = (nome: string, liga: number | null, scry: number | null, extra = {}) => ({
  nome, quantidade: 1, tipo: "Creature",
  precos: {
    liga: liga === null ? { preco_unitario: 0, erro: "x" } : { preco_unitario: liga, loja: "Loja", estoque_suficiente: true },
    scry: scry === null ? { preco_unitario: 0, erro: "x" } : { preco_unitario: scry, estoque_suficiente: true },
  },
  ...extra,
});

describe("quoteView", () => {
  const result: QuoteResult = {
    fontes: [LIGA, SCRY],
    cambio: { valor: 5, fonte: "awesomeapi" },
    linhas: [
      line("Cara", 62, 10),         // 62 vs 50: 24% acima → marca
      line("Justa", 54, 10),        // 54 vs 50: 8% → não marca
      line("Só lá", null, 2),       // sem preço aqui
      line("Nenhuma", null, null),  // sem preço em lugar nenhum
    ],
  };
  const v = quoteView(result);

  it("marca a carta mais de 20% acima do preço de fora, na coluna brasileira", () => {
    const [cara, justa] = v.top;
    expect(cara.cells[0]).toMatchObject({ pricey: { pct: 24 } });
    expect((cara.cells[0] as any).pricey.title)
      .toBe("24% acima da Scryfall (US$ 10,00 ≈ R$ 50,00 a R$ 5,00 por dólar)");
    expect((cara.cells[1] as any).pricey).toBeNull();
    expect((justa.cells[0] as any).pricey).toBeNull();
  });

  it("o menor custo teórico pega o menor de cada carta, convertido", () => {
    const theo = v.boxes.find((b) => b.theoretical)!;
    // 50 (Cara, de fora) + 50 (Justa, de fora) + 10 (Só lá) = 110; 1 sem preço
    expect(theo.total).toBe("R$ 110,00");
    expect(theo.note).toContain("1 carta(s) sem preço");
    expect(theo.list).toBe("Cara [R$ 50,00]\nJusta [R$ 50,00]\nSó lá [R$ 10,00]");
  });

  it("cada caixa copia a lista com o preço dela, sem as cartas sem preço", () => {
    expect(v.boxes[0].list).toBe("Cara [R$ 62,00]\nJusta [R$ 54,00]");
    expect(v.boxes[1].list).toBe("Cara [US$ 10,00]\nJusta [US$ 10,00]\nSó lá [US$ 2,00]");
  });

  it("linha sem preço em fonte nenhuma fica marcada", () => {
    expect(v.top.map((r) => r.found)).toEqual([true, true, true, false]);
  });

  it("a nota do ▲ diz contra o que foi comparado", () => {
    expect(v.priceyNote).toEqual({ refLabel: "Scryfall",
      conversion: ", convertido a R$ 5,00 por dólar (câmbio de hoje)" });
  });

  it("sem fonte brasileira na frente, nada de ▲ nem nota", () => {
    const w = quoteView({ ...result, fontes: [SCRY, LIGA] });
    expect(w.priceyNote).toBeNull();
    expect(w.top.every((r) => r.cells.every((c) => c.error || !c.pricey))).toBe(true);
  });

  it("câmbio ausente cai no dólar de reserva", () => {
    const w = quoteView({ ...result, cambio: undefined });
    expect(w.boxes.find((b) => b.theoretical)!.note).toContain("R$ 5,00 por dólar");
  });
});

describe("agrupamento", () => {
  it("agrupa por tipo na ordem fixa; dupla-face vale pela frente", () => {
    expect(groupOf("Land Creature — Forest Dryad")).toBe("Terrenos");
    expect(groupOf("Artifact Creature — Golem")).toBe("Criaturas");
    expect(groupOf("Instant // Sorcery")).toBe("Mágicas instantâneas");
    expect(groupOf(undefined)).toBe("Outras");

    const linhas = Array.from({ length: 12 }, (_, i) =>
      line(`c${i}`, 1, 1, { tipo: i % 2 ? "Sorcery" : "Basic Land", quantidade: 2 }));
    const v = quoteView({ fontes: [LIGA], linhas });
    expect(v.groups!.map((g) => [g.name, g.cards, g.copies])).toEqual([["Terrenos", 6, 12], ["Feitiços", 6, 12]]);
    expect(v.hidden).toBe(2);
    expect(v.top).toHaveLength(10);
  });

  it("sem tipo nenhum, lista corrida", () => {
    const v = quoteView({ fontes: [LIGA], linhas: [line("a", 1, 1, { tipo: undefined })] });
    expect(v.groups).toBeNull();
    expect(v.all).toHaveLength(1);
  });
});

it("o que ficou de fora, por motivo", () => {
  const v = quoteView({ fontes: [LIGA], linhas: [], excluidas: [
    { nome: "Atraxa", quantidade: 1, motivo: "comandante" },
    { nome: "Forest", quantidade: 10, motivo: "terreno básico" },
    { nome: "Treasure", quantidade: 1, motivo: "token" },
  ] });
  expect(v.excluded).toEqual({ parts: ["o comandante (Atraxa)", "10 terreno básicos", "1 token"], hasToken: true });
});

it("money", () => {
  expect(money(1234.5, "BRL")).toBe("R$ 1.234,50");
  expect(money(2, "USD")).toBe("US$ 2,00");
  expect(money(2, "EUR")).toBe("EUR 2,00");
});
