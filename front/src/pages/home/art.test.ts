import { artSources, cardTitle, quoteName } from "./art";

describe("art", () => {
  it("título: arquivo sem extensão, depois busca, depois id", () => {
    expect(cardTitle({ id: "x", name: "Sol Ring.png", query: "sol ring" })).toBe("Sol Ring");
    expect(cardTitle({ id: "x", name: "", query: " sol ring " })).toBe("sol ring");
    expect(cardTitle({ id: "x", name: "", query: "" })).toBe("x");
  });

  it("nome da cotação: busca primeiro, espaços normalizados", () => {
    expect(quoteName({ id: "x", name: "Sol Ring (alt).png", query: "sol   ring" })).toBe("sol ring");
    expect(quoteName({ id: "x", name: " Sol  Ring.png ", query: "" })).toBe("Sol Ring.png");
  });

  it("fontes da miniatura por prefixo", () => {
    const imp = "0123abcd-0000-1111-2222-333344445555";
    expect(artSources(`scryfall:${imp}:back`, 400))
      .toEqual([`https://cards.scryfall.io/normal/back/0/1/${imp}.jpg`]);
    expect(artSources(`scryfall:${imp}:front`, 600)[0]).toContain("/large/front/");
    expect(artSources("enviada:" + "a".repeat(64), 120)).toEqual([`/artes/enviadas/${"a".repeat(64)}/miniatura`]);
    const drive = artSources("1AbC", 120);
    expect(drive).toHaveLength(2);
    expect(drive[0]).toBe("https://drive.google.com/thumbnail?id=1AbC&sz=w120");
  });
});
