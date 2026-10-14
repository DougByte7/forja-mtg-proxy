import { SAMPLE } from "./sample";
import { bracketFor, buildXml, parseOrder, parseSlots } from "./xml";


describe("parseOrder", () => {
  it("lê a quantidade e conta os versos próprios", () => {
    expect(parseOrder(SAMPLE)).toEqual({ qty: 4, backsCount: 1 });
  });

  it("sem <quantity>, soma os slots das frentes", () => {
    expect(parseOrder(SAMPLE.replace("<quantity>4</quantity>", "")).qty).toBe(4);
  });

  it("XML quebrado e XML sem cartas dão mensagens diferentes", () => {
    expect(() => parseOrder("<order><fronts>")).toThrow(/não é válido/);
    expect(() => parseOrder("<order/>")).toThrow(/Não encontrei a quantidade/);
  });
});

describe("parseSlots", () => {
  it("põe cada verso no slot da sua frente", () => {
    const { slots } = parseSlots(SAMPLE);
    expect(slots.map((s) => [s.front.id, s.back?.id ?? null])).toEqual([
      ["solring", null], ["solring", null], ["delver", "insectile"], ["bolt", null],
    ]);
  });
});

describe("buildXml", () => {
  it("renumera os slots, atualiza a quantidade e preserva o que não conhece", () => {
    const { doc, slots } = parseSlots(SAMPLE);
    // tira um Sol Ring e o verso do Delver
    const next = [slots[0], { ...slots[2], back: null }, slots[3]];
    const xml = buildXml(doc, next);

    expect(parseOrder(xml)).toEqual({ qty: 3, backsCount: 0 });
    expect(parseSlots(xml).slots.map((s) => s.front.id)).toEqual(["solring", "delver", "bolt"]);
    expect(xml).toContain("<stock>(S30) Standard Smooth</stock>");
    expect(xml).toContain("<cardback>verso-padrao</cardback>");
    expect(xml).not.toContain("<backs>");
    expect(xml).toContain("        <card>\n            <id>solring</id>");
  });

  it("acrescenta <backs> antes do <cardback> quando passa a ter verso", () => {
    const { doc, slots } = parseSlots(SAMPLE.replace(/<backs>[\s\S]*<\/backs>/, ""));
    const meta = { id: "verso-x", name: "X.png", query: "" };
    const xml = buildXml(doc, [{ ...slots[0], back: meta }]);
    expect(xml.indexOf("<backs>")).toBeLessThan(xml.indexOf("<cardback>"));
    expect(parseSlots(xml).slots[0].back?.id).toBe("verso-x");
  });

  it("escapa texto", () => {
    const { doc } = parseSlots(SAMPLE);
    const xml = buildXml(doc, [{ front: { id: "a&b", name: "<x>", query: "" }, back: null }]);
    expect(xml).toContain("<id>a&amp;b</id>");
    expect(xml).toContain("<name>&lt;x&gt;</name>");
  });
});

it("bracketFor", () => {
  expect(bracketFor(1)).toBe(18);
  expect(bracketFor(18)).toBe(18);
  expect(bracketFor(19)).toBe(36);
  expect(bracketFor(700)).toBe(700);
});
