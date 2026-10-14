import { SAMPLE } from "./sample";
import {
  addBack, addCopy, catalogFrom, pagesOf, printQueue, removeAllBacks, removeBack, removeCopy,
  removeGroup, sheetGroups, signatureOf,
} from "./sheet";
import { parseSlots, type Slot } from "./xml";

const ids = (slots: Slot[]) => slots.map((s) => s.front.id + (s.back ? "+" + s.back.id : ""));

describe("edições da folha", () => {
  const { slots } = parseSlots(SAMPLE);
  const catalog = catalogFrom(slots);

  it("cópia nova entra junto das outras e herda o verso quando todas têm o mesmo", () => {
    expect(ids(addCopy(slots, catalog, "solring").slots!))
      .toEqual(["solring", "solring", "solring", "delver+insectile", "bolt"]);
    expect(ids(addCopy(slots, catalog, "delver").slots!))
      .toEqual(["solring", "solring", "delver+insectile", "delver+insectile", "bolt"]);
  });

  it("cópia nova não herda verso quando o cliente já separou", () => {
    const two = addCopy(slots, catalog, "delver").slots!;
    const split = removeBack(two, catalog, "delver", "insectile").slots!;
    expect(ids(split)).toEqual(["solring", "solring", "delver+insectile", "delver", "bolt"]);
    expect(ids(addCopy(split, catalog, "delver").slots!))
      .toEqual(["solring", "solring", "delver+insectile", "delver", "delver", "bolt"]);
  });

  it("tirar cópia prefere a sem verso, e avisa quando o verso vai junto", () => {
    const two = addCopy(slots, catalog, "delver").slots!;
    const split = removeBack(two, catalog, "delver", "insectile").slots!;
    const r1 = removeCopy(split, catalog, "delver");
    expect(ids(r1.slots!)).toEqual(["solring", "solring", "delver+insectile", "bolt"]);
    expect(r1.message).toBeUndefined();
    const r2 = removeCopy(r1.slots!, catalog, "delver");
    expect(ids(r2.slots!)).toEqual(["solring", "solring", "bolt"]);
    expect(r2.message).toMatch(/verso saiu junto/);
  });

  it("o verso zerado continua listado com contador 0, e volta", () => {
    const none = removeAllBacks(slots, catalog, "delver", "insectile").slots!;
    const delver = sheetGroups(none, catalog).find((g) => g.key === "delver")!;
    expect(delver.backs.get("insectile")!.idx).toEqual([]);
    expect(ids(addBack(none, catalog, "delver", "insectile").slots!)).toEqual(ids(slots));
  });

  it("verso a mais sem cópia livre não entra", () => {
    const r = addBack(slots, catalog, "delver", "insectile");
    expect(r.slots).toBeUndefined();
    expect(r.message).toMatch(/Adicione mais uma cópia/);
  });

  it("nunca deixa a folha vazia", () => {
    const one = [slots[3]];
    expect(removeCopy(one, catalog, "bolt")).toEqual({ message: "O pedido precisa ter pelo menos uma carta." });
    expect(removeGroup(one, catalog, "bolt").slots).toBeUndefined();
    expect(ids(removeGroup(slots, catalog, "solring").slots!)).toEqual(["delver+insectile", "bolt"]);
  });

  it("a assinatura enxerga o verso", () => {
    const none = removeAllBacks(slots, catalog, "delver", "insectile").slots!;
    expect(signatureOf(none)).not.toBe(signatureOf(slots));
  });

  it("as edições não mexem no array original", () => {
    const before = ids(slots);
    addCopy(slots, catalog, "bolt");
    removeAllBacks(slots, catalog, "delver", "insectile");
    expect(ids(slots)).toEqual(before);
  });
});

describe("fila de impressão", () => {
  const { slots } = parseSlots(SAMPLE);
  it("frentes primeiro, versos depois, como o backend", () => {
    expect(printQueue(slots).map((q) => q.kind + ":" + q.meta.id))
      .toEqual(["front:solring", "front:solring", "front:delver", "front:bolt", "back:insectile"]);
  });
  it("páginas de 9", () => {
    const many = Array.from({ length: 10 }, () => slots[0]);
    expect(pagesOf(many).map((p) => p.length)).toEqual([9, 1]);
    expect(pagesOf([]).length).toBe(1);
  });
});
