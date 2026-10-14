import { forgetLocalDeck, readLocalDecks, rememberLocalDeck } from "./localDecks";

describe("localDecks", () => {
  beforeEach(() => localStorage.clear());

  it("lembra no topo, sem repetir, e guarda no formato do deckbuilder", () => {
    rememberLocalDeck("aaa111", "Atraxa", "Atraxa, Praetors' Voice");
    rememberLocalDeck("bbb222");
    rememberLocalDeck("aaa111", "Atraxa v2");
    const list = readLocalDecks();
    expect(list.map((d) => d.id)).toEqual(["aaa111", "bbb222"]);
    expect(list[0]).toMatchObject({ nome: "Atraxa v2", comandante: "" });
    expect(list[1].nome).toBe("Deck sem nome");
    expect(Object.keys(list[0]).sort()).toEqual(["comandante", "id", "nome", "quando"]);
  });

  it("guarda no máximo 20", () => {
    for (let i = 0; i < 25; i++) rememberLocalDeck(`id${i}`);
    expect(readLocalDecks()).toHaveLength(20);
    expect(readLocalDecks()[0].id).toBe("id24");
  });

  it("esquece um", () => {
    rememberLocalDeck("aaa111");
    rememberLocalDeck("bbb222");
    forgetLocalDeck("aaa111");
    expect(readLocalDecks().map((d) => d.id)).toEqual(["bbb222"]);
  });

  it("lixo na chave vira lista vazia, e entrada sem id é ignorada", () => {
    localStorage.setItem("forja.decks", "{quebrado");
    expect(readLocalDecks()).toEqual([]);
    localStorage.setItem("forja.decks", JSON.stringify([{ nome: "x" }, { id: "ok" }]));
    expect(readLocalDecks().map((d) => d.id)).toEqual(["ok"]);
  });
});
