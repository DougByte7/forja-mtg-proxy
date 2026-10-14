import { fireEvent, screen, waitFor } from "@testing-library/preact";
import { mockFetch, renderWithQuery, sentBody } from "../../shared/testing";
import { Signup } from "./Signup";

function fill(values: Record<string, string>) {
  const labels: Record<string, string> = {
    nome: "Nome", email: "E-mail", senha: "Senha",
    confirmacao: "Confirmação de senha", token: "Token de acesso",
  };
  for (const [k, v] of Object.entries(values))
    fireEvent.input(screen.getByLabelText(labels[k]), { target: { value: v } });
}

const FORM = { nome: "Ana", email: "ana@x.com", senha: "12345678",
               confirmacao: "12345678", token: "convite" };

describe("Signup", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "?voltar=/meus-decks", href: "", replace: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("cria a conta com os cinco campos e volta pro destino", async () => {
    const fetch = mockFetch((_, url) =>
      url === "/conta" ? [200, { usuario: null }] : [200, { usuario: { login: "ana@x.com" } }]);
    renderWithQuery(<Signup />);
    fill(FORM);
    fireEvent.submit(screen.getByRole("button", { name: "Criar conta" }));

    await waitFor(() => expect(location.href).toBe("/meus-decks"));
    expect(sentBody(fetch, "POST", "/conta/criar")).toEqual(FORM);
  });

  it("confirmação diferente não vai pra rede", async () => {
    const fetch = mockFetch(() => [200, { usuario: null }]);
    renderWithQuery(<Signup />);
    fill({ ...FORM, confirmacao: "outra-senha" });
    fireEvent.submit(screen.getByRole("button", { name: "Criar conta" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent", "A confirmação não é igual à senha.");
    expect((screen.getByLabelText("Confirmação de senha") as HTMLInputElement).value).toBe("");
    expect(sentBody(fetch, "POST", "/conta/criar")).toBeUndefined();
  });

  it("mostra o erro do servidor e reabilita o botão", async () => {
    mockFetch((_, url) =>
      url === "/conta" ? [200, { usuario: null }] : [403, { detail: "Token de acesso inválido." }]);
    renderWithQuery(<Signup />);
    fill(FORM);
    fireEvent.submit(screen.getByRole("button", { name: "Criar conta" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Token de acesso inválido.");
    expect(screen.getByRole("button", { name: "Criar conta" })).toHaveProperty("disabled", false);
  });

  it("o link de entrar leva o destino junto", () => {
    mockFetch(() => [200, { usuario: null }]);
    renderWithQuery(<Signup />);
    expect(screen.getByText("Entrar").getAttribute("href")).toBe("/entrar?voltar=%2Fmeus-decks");
  });
});
