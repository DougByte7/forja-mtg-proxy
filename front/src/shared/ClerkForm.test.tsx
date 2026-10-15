import { screen, waitFor } from "@testing-library/preact";
import { ClerkForm } from "./ClerkForm";
import { loadClerk } from "./clerk";
import { mockFetch, renderWithQuery } from "./testing";

vi.mock("./clerk", () => ({ loadClerk: vi.fn() }));

function fakeClerk() {
  return {
    mountSignIn: vi.fn(), unmountSignIn: vi.fn(),
    mountSignUp: vi.fn(), unmountSignUp: vi.fn(),
  };
}

describe("ClerkForm", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "?voltar=/deckbuilder?deck=abc", replace: vi.fn() });
    mockFetch(() => [200, { usuario: null }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("monta o entrar do Clerk com o destino validado e o link pro cadastro", async () => {
    const clerk = fakeClerk();
    vi.mocked(loadClerk).mockResolvedValue(clerk as never);
    renderWithQuery(<ClerkForm mode="signIn" />);

    await waitFor(() => expect(clerk.mountSignIn).toHaveBeenCalled());
    expect(clerk.mountSignIn.mock.calls[0][1]).toEqual({
      routing: "hash",
      forceRedirectUrl: "/deckbuilder?deck=abc",
      signUpUrl: "/cadastro?voltar=%2Fdeckbuilder%3Fdeck%3Dabc",
    });
  });

  it("monta o cadastro com o link de volta pro entrar", async () => {
    const clerk = fakeClerk();
    vi.mocked(loadClerk).mockResolvedValue(clerk as never);
    renderWithQuery(<ClerkForm mode="signUp" />);

    await waitFor(() => expect(clerk.mountSignUp).toHaveBeenCalled());
    expect(clerk.mountSignUp.mock.calls[0][1]).toMatchObject({
      routing: "hash", signInUrl: "/entrar?voltar=%2Fdeckbuilder%3Fdeck%3Dabc",
    });
  });

  it("destino de outro site vira a raiz", async () => {
    vi.stubGlobal("location", { search: "?voltar=//malvado.test", replace: vi.fn() });
    const clerk = fakeClerk();
    vi.mocked(loadClerk).mockResolvedValue(clerk as never);
    renderWithQuery(<ClerkForm mode="signIn" />);

    await waitFor(() => expect(clerk.mountSignIn).toHaveBeenCalled());
    expect(clerk.mountSignIn.mock.calls[0][1].forceRedirectUrl).toBe("/");
  });

  it("sem Clerk, diz que não abriu em vez de ficar carregando", async () => {
    vi.mocked(loadClerk).mockResolvedValue(null);
    renderWithQuery(<ClerkForm mode="signIn" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Não consegui abrir a tela de entrar");
  });
});
