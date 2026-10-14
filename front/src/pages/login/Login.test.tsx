import { fireEvent, screen, waitFor } from "@testing-library/preact";
import { mockFetch, renderWithQuery, sentBody } from "../../shared/testing";
import { Login } from "./Login";

describe("Login", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "?voltar=/deckbuilder", href: "", replace: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("manda login, senha e lembrar e volta pro destino", async () => {
    const fetch = mockFetch((_, url) =>
      url === "/conta" ? [200, { usuario: null }] : [200, { usuario: { login: "ana" } }]);
    renderWithQuery(<Login />);

    fireEvent.input(screen.getByLabelText("E-mail ou login"), { target: { value: "ana" } });
    fireEvent.input(screen.getByLabelText("Senha"), { target: { value: "segredo" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() => expect(location.href).toBe("/deckbuilder"));
    expect(sentBody(fetch, "POST", "/conta/entrar"))
      .toEqual({ login: "ana", senha: "segredo", lembrar: true });
  });

  it("mostra o erro do servidor e limpa a senha", async () => {
    mockFetch((_, url) =>
      url === "/conta" ? [200, { usuario: null }] : [401, { detail: "Login ou senha não conferem." }]);
    renderWithQuery(<Login />);

    const password = screen.getByLabelText("Senha") as HTMLInputElement;
    fireEvent.input(screen.getByLabelText("E-mail ou login"), { target: { value: "ana" } });
    fireEvent.input(password, { target: { value: "chute" } });
    fireEvent.submit(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Login ou senha não conferem.");
    expect(password.value).toBe("");
    expect(screen.getByRole("button", { name: "Entrar" })).toHaveProperty("disabled", false);
  });

  it("quem já está logado vai direto pro destino", async () => {
    mockFetch(() => [200, { usuario: { login: "ana" } }]);
    renderWithQuery(<Login />);
    await waitFor(() => expect(location.replace).toHaveBeenCalledWith("/deckbuilder"));
  });

  it("o link de cadastro leva o destino junto", () => {
    mockFetch(() => [200, { usuario: null }]);
    renderWithQuery(<Login />);
    expect(screen.getByText("Criar conta").getAttribute("href"))
      .toBe("/cadastro?voltar=%2Fdeckbuilder");
  });
});
