import { rememberLocalDeck } from "../../shared/localDecks";
import { mockFetch, sentBody } from "../../shared/testing";
import { deckIdFromText, fetchDeckList, relativeTime } from "./data";

const deck = (id: string, atualizado_em: number, extra = {}) =>
  ({ id, nome: id, atualizado_em, comandantes: [], ...extra });

describe("fetchDeckList", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("anônimo sem decks locais não vai à rede", async () => {
    const fetch = mockFetch(() => [500, {}]);
    expect(await fetchDeckList(null)).toEqual({ decks: [], missing: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("anônimo: pergunta os ids locais e ordena pelo servidor", async () => {
    rememberLocalDeck("aaa111");
    rememberLocalDeck("bbb222");
    const fetch = mockFetch(() =>
      [200, { decks: [deck("aaa111", 10), deck("bbb222", 30)], desconhecidos: ["ccc333"] }]);
    const r = await fetchDeckList(null);
    expect(r.decks.map((d) => d.id)).toEqual(["bbb222", "aaa111"]);
    expect(r.missing).toEqual(["ccc333"]);
    expect(sentBody(fetch, "POST", "/decks/resumo")).toEqual({ ids: ["bbb222", "aaa111"] });
  });

  it("com conta: os da conta mais os órfãos locais, sem os que têm dono", async () => {
    rememberLocalDeck("meu111");     // já está na conta: não é perguntado
    rememberLocalDeck("solto22");    // órfão: entra
    rememberLocalDeck("alheio3");    // tem outro dono: fica de fora
    const fetch = mockFetch((_, url) => url === "/decks/meus"
      ? [200, { decks: [deck("meu111", 20, { dono: 1 })] }]
      : [200, { decks: [deck("solto22", 50), deck("alheio3", 99, { dono: 2 })],
                desconhecidos: [] }]);
    const r = await fetchDeckList({ login: "ana", nome: "Ana" });
    expect(r.decks.map((d) => d.id)).toEqual(["solto22", "meu111"]);
    expect(sentBody(fetch, "POST", "/decks/resumo")).toEqual({ ids: ["alheio3", "solto22"] });
  });

  it("erro em texto puro vira a mensagem", async () => {
    rememberLocalDeck("aaa111");
    mockFetch(() => [502, "Bad Gateway", "text"]);
    await expect(fetchDeckList(null)).rejects.toThrow("Bad Gateway");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000 * 1000;
  const ago = (days: number) => now / 1000 - days * 86400;
  it.each([
    [0, "mexido hoje"], [1, "mexido ontem"], [5, "mexido há 5 dias"],
    [40, "mexido há um mês"], [95, "mexido há 3 meses"],
  ])("%i dias", (days, text) => expect(relativeTime(ago(days), now)).toBe(text));
  it("sem data, sem texto", () => expect(relativeTime(0, now)).toBe(""));
});

describe("deckIdFromText", () => {
  it.each([
    ["https://forja.x/deckbuilder?deck=ABCDEF123456", "abcdef123456"],
    ["/deckbuilder?x=1&deck=abcdef123456", "abcdef123456"],
    ["  abcdef123456 ", "abcdef123456"],
    ["não é id", ""],
    ["", ""],
    ["https://forja.x/deckbuilder", ""],
  ])("%s", (raw, id) => expect(deckIdFromText(raw)).toBe(id));
});
