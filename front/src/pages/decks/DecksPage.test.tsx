import { fireEvent, screen, waitFor } from "@testing-library/preact";
import { readLocalDecks, rememberLocalDeck } from "../../shared/localDecks";
import { mockFetch, renderWithQuery, sentBody } from "../../shared/testing";
import { DecksPage } from "./DecksPage";

const deck = (id: string, extra = {}) => ({
  id, nome: `Deck ${id}`, versao: null, comandantes: ["Atraxa"], identidade: "WUBG",
  total: 100, faltam: 0, talvez: 0, atualizado_em: 0, ...extra,
});

describe("DecksPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("anônimo: lista os decks do navegador e oferece entrar", async () => {
    rememberLocalDeck("aaa111");
    mockFetch((_, url) => url === "/conta" ? [200, { usuario: null }]
      : [200, { decks: [deck("aaa111")], desconhecidos: [] }]);
    renderWithQuery(<DecksPage />);

    expect(await screen.findByText("Deck aaa111")).toBeTruthy();
    expect(screen.getByText("Entrar").getAttribute("href")).toBe("/entrar?voltar=/meus-decks");
    expect(screen.getByText("100/100")).toBeTruthy();
  });

  it("sem decks, convida a montar o primeiro", async () => {
    mockFetch(() => [200, { usuario: null }]);
    renderWithQuery(<DecksPage />);
    expect(await screen.findByText("Nenhum deck neste navegador ainda.")).toBeTruthy();
  });

  it("apagar pede dois cliques, e clicar fora desarma", async () => {
    rememberLocalDeck("aaa111");
    const fetch = mockFetch((method, url) =>
      url === "/conta" ? [200, { usuario: null }]
      : method === "DELETE" ? [204, null]
      : [200, { decks: [deck("aaa111")], desconhecidos: [] }]);
    renderWithQuery(<DecksPage />);
    await screen.findByText("Deck aaa111");

    fireEvent.click(screen.getByLabelText("Apagar deck"));
    expect(screen.getByText("Apagar mesmo?")).toBeTruthy();
    fireEvent.click(document.body);
    expect(screen.queryByText("Apagar mesmo?")).toBeNull();

    fireEvent.click(screen.getByLabelText("Apagar deck"));
    fireEvent.click(screen.getByLabelText("Apagar mesmo?"));
    await waitFor(() => expect(readLocalDecks()).toEqual([]));
    expect(fetch.mock.calls.some(([u, i]) => u === "/decks/aaa111" && i?.method === "DELETE")).toBe(true);
  });

  it("acrescenta um deck pelo link colado", async () => {
    const fetch = mockFetch((_, url, body) =>
      url === "/conta" ? [200, { usuario: null }]
      : [200, { decks: body?.ids?.includes("abcdef123456") ? [deck("abcdef123456")] : [],
                desconhecidos: [] }]);
    renderWithQuery(<DecksPage />);
    await screen.findByText("Nenhum deck neste navegador ainda.");

    fireEvent.input(screen.getByLabelText("Link ou id do deck"),
      { target: { value: "https://forja.x/deckbuilder?deck=abcdef123456" } });
    fireEvent.click(screen.getByText("Acrescentar"));

    expect(await screen.findByText("Deck abcdef123456")).toBeTruthy();
    expect(readLocalDecks().map((d) => d.id)).toEqual(["abcdef123456"]);
    expect(sentBody(fetch, "POST", "/decks/resumo")).toEqual({ ids: ["abcdef123456"] });
  });

  it("id que o servidor não conhece aparece com o botão de tirar", async () => {
    rememberLocalDeck("sumido1");
    mockFetch((_, url) => url === "/conta" ? [200, { usuario: null }]
      : [200, { decks: [], desconhecidos: ["sumido1"] }]);
    renderWithQuery(<DecksPage />);

    fireEvent.click(await screen.findByText(/tirar sumido1/));
    await waitFor(() => expect(screen.queryByText(/tirar sumido1/)).toBeNull());
    expect(readLocalDecks()).toEqual([]);
  });

  it("com conta, mostra o nome e marca o órfão", async () => {
    rememberLocalDeck("solto22");
    mockFetch((_, url) =>
      url === "/conta" ? [200, { usuario: { login: "ana", nome: "Ana" } }]
      : url === "/decks/meus" ? [200, { decks: [deck("meu111", { dono: 1 })] }]
      : [200, { decks: [deck("solto22")], desconhecidos: [] }]);
    renderWithQuery(<DecksPage />);

    expect(await screen.findByText("Deck solto22")).toBeTruthy();
    expect(screen.getByText("Deck meu111")).toBeTruthy();
    expect(screen.getByText("Ana")).toBeTruthy();
    expect(screen.getAllByText("sem dono")).toHaveLength(1);
  });
});
