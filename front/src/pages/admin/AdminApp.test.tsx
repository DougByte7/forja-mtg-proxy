import { fireEvent, screen, waitFor, within } from "@testing-library/preact";
import { mockFetch, renderWithQuery, sentBody, sentHeaders } from "../../shared/testing";
import { AdminApp } from "./AdminApp";
import { resetAdminState, token } from "./store";
import type { Order } from "./types";

const order = (id: string, extra: Partial<Order> = {}): Order => ({
  id, status: "notified", customer_name: `Cliente ${id}`, amount: 10, deck_hash: "abc",
  qty: 4, pages: 1, blanks: 5, lamination: "single", created_at: 1, ...extra,
});

const SESSION = { impressora: "fila", worker: { visto_em: Date.now() / 1000, offline_segundos: 600 } };
const STOCK = {
  itens: [{ id: "papel", nome: "Papel", unidade: "folhas", quantidade: 50, minimo: 10,
            custo_unitario: 0.5, baixo: false }],
  custo_folha: Object.fromEntries(["single", "double", "foil"].map((l) =>
    [l, { papel: 1, plastico: 1, tinta: 1, total: 3, cobrado: 5, margem: 2 }])),
  config: { folhas_por_plastico_um_lado: 1, folhas_por_plastico_dois_lados: 1,
            folhas_por_plastico_foil: 1, preco_um_lado: 5, preco_dois_lados: 8, preco_foil: 10 },
  tintas: [], movimentos: [],
};

type Handler = (method: string, url: string, body: any) => [number, unknown] | undefined;

/** Um backend de mentira: as rotas de sempre, e `extra` pra cada teste. */
function backend(orders: Order[], extra: Handler = () => undefined) {
  return mockFetch((method, url, body) => {
    const r = extra(method, url, body);
    if (r) return r;
    if (url === "/admin/sessao") return [200, SESSION];
    if (url === "/admin/estoque") return [200, STOCK];
    if (url.startsWith("/admin/pedidos?"))
      return [200, { pedidos: orders, contagem: { total: orders.length, notified: orders.length } }];
    return [404, { detail: `rota de teste não prevista: ${method} ${url}` }];
  });
}

describe("AdminApp", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    resetAdminState();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pede o token, e com ele mostra os pedidos mandando o X-Admin-Token", async () => {
    const fetch = backend([order("p1")]);
    renderWithQuery(<AdminApp />);

    fireEvent.input(screen.getByLabelText("Token de administrador"), { target: { value: " segredo " } });
    fireEvent.submit(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByText("Cliente p1")).toBeTruthy();
    expect(sentHeaders(fetch, "/admin/sessao")["X-Admin-Token"]).toBe("segredo");
    expect(sessionStorage.getItem("forja_admin_token")).toBe("segredo");
    expect(localStorage.getItem("forja_admin_token")).toBeNull();
  });

  it("token recusado volta pra entrada com o motivo e esquece o token", async () => {
    sessionStorage.setItem("forja_admin_token", "velho");
    resetAdminState();
    backend([], (_, url) => url === "/admin/sessao" ? [401, { detail: "não" }] : undefined);
    renderWithQuery(<AdminApp />);

    expect(await screen.findByRole("alert")).toHaveProperty("textContent",
      "O token foi recusado. Confira o ADMIN_TOKEN do .env.");
    expect(token.value).toBe("");
    expect(sessionStorage.getItem("forja_admin_token")).toBeNull();
  });

  it("imprimir pede confirmação, põe na fila e conta o que a impressora disse", async () => {
    sessionStorage.setItem("forja_admin_token", "t");
    resetAdminState();
    const fetch = backend([order("p1")], (method, url) =>
      url === "/admin/pedidos/p1/imprimir" ? [200, { mensagem: "Na fila." }]
      : url === "/admin/pedidos/p1" && method === "GET"
        ? [200, { status: "impresso", impressao_msg: "job 7 aceito" }]
      : undefined);
    renderWithQuery(<AdminApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Imprimir" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("#p1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Imprimir" }));

    expect(await screen.findByText("job 7 aceito")).toBeTruthy();
    expect(fetch.mock.calls.some(([u, i]) => u === "/admin/pedidos/p1/imprimir" && i?.method === "POST")).toBe(true);
  });

  it("apagar só destrava digitando o id", async () => {
    sessionStorage.setItem("forja_admin_token", "t");
    resetAdminState();
    const fetch = backend([order("p1")], (method, url) =>
      url === "/admin/pedidos/p1" && method === "DELETE" ? [204, null] : undefined);
    renderWithQuery(<AdminApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Apagar" }));
    const dialog = screen.getByRole("dialog");
    const ok = within(dialog).getByRole("button", { name: "Apagar" }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.input(within(dialog).getByLabelText("Confirmação"), { target: { value: "p2" } });
    expect(ok.disabled).toBe(true);
    fireEvent.input(within(dialog).getByLabelText("Confirmação"), { target: { value: "p1" } });
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);

    await waitFor(() => expect(fetch.mock.calls.some(
      ([u, i]) => u === "/admin/pedidos/p1" && i?.method === "DELETE")).toBe(true));
  });

  it("mudar status manda formulário e anota embaixo do pedido", async () => {
    sessionStorage.setItem("forja_admin_token", "t");
    resetAdminState();
    const fetch = backend([order("p1")], (_, url) =>
      url === "/admin/pedidos/p1/status" ? [200, {}] : undefined);
    renderWithQuery(<AdminApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("Pedido cancelado.")).toBeTruthy();
    expect(sentBody(fetch, "POST", "/admin/pedidos/p1/status")).toEqual({ status: "cancelado" });
  });

  it("marcar pedidos mostra a prévia da folha combinada", async () => {
    sessionStorage.setItem("forja_admin_token", "t");
    resetAdminState();
    backend([order("p1", { pages: 1, blanks: 5, created_at: 1 }),
             order("p2", { pages: 2, blanks: 0, created_at: 2 }),
             order("p3", { pages: 1, blanks: 7, created_at: 3, lamination: "foil" })]);
    renderWithQuery(<AdminApp />);

    fireEvent.click(await screen.findByLabelText("Combinar o pedido de Cliente p1"));
    expect(screen.getByText("Marque pelo menos dois pra combinar.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Combinar o pedido de Cliente p2"));
    const bar = document.querySelector(".combo-barra")!;
    // 4 + 18 = 22 cartas: o branco do p1 não fecha folha, sobram 5 na última.
    expect(bar.textContent).toContain("22 carta(s)");
    expect(bar.textContent).toContain("5 espaço(s) em branco separados → 5 combinados");
    expect(bar.textContent).toContain("nada aproveitado");
    expect(document.body.classList.contains("com-combo")).toBe(true);

    fireEvent.click(screen.getByLabelText("Combinar o pedido de Cliente p3"));
    expect(bar.textContent).toContain("Laminação misturada (Um lado e Foil)");
    expect((screen.getByRole("button", { name: "Combinar" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Limpar" }));
    expect(document.querySelector(".combo-barra")).toBeNull();
    expect(document.body.classList.contains("com-combo")).toBe(false);
  });

  it("combinar cria a combinação, mostra o mapa e libera o Imprimir", async () => {
    sessionStorage.setItem("forja_admin_token", "t");
    resetAdminState();
    const fetch = backend([order("p1", { created_at: 1 }), order("p2", { created_at: 2 })],
      (_, url) => url === "/admin/combos" ? [200, { id: "c1", brancos_evitados: 5, mapa: [
        { id: "p1", customer_name: "Cliente p1", cartas: 4, primeira_pagina: 1, ultima_pagina: 1, inicio: 1, fim: 4 },
      ] }] : undefined);
    renderWithQuery(<AdminApp />);

    fireEvent.click(await screen.findByLabelText("Combinar o pedido de Cliente p1"));
    fireEvent.click(screen.getByLabelText("Combinar o pedido de Cliente p2"));
    fireEvent.click(screen.getByRole("button", { name: "Combinar" }));

    expect(await screen.findByText(/posições 1–4 da fila/)).toBeTruthy();
    expect(screen.getByText(/O worker já está montando a folha/)).toBeTruthy();
    expect(sentBody(fetch, "POST", "/admin/combos")).toEqual({ ids: "p1,p2" });
    const bar = document.querySelector(".combo-barra") as HTMLElement;
    expect(within(bar).queryByRole("button", { name: "Combinar" })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Imprimir" })).toBeTruthy();

    // Mudou a seleção: a combinação era de outro conjunto e some.
    fireEvent.click(screen.getByLabelText("Combinar o pedido de Cliente p2"));
    expect(within(bar).queryByRole("button", { name: "Imprimir" })).toBeNull();
    expect(screen.queryByText(/posições 1–4 da fila/)).toBeNull();
  });

  it("entrada de estoque manda JSON e mostra o saldo novo", async () => {
    sessionStorage.setItem("forja_admin_token", "t");
    resetAdminState();
    const after = { ...STOCK, itens: [{ ...STOCK.itens[0], quantidade: 150 }] };
    const fetch = backend([], (_, url) =>
      url === "/admin/estoque/papel/entrada" ? [200, after] : undefined);
    renderWithQuery(<AdminApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Estoque" }));
    fireEvent.click(await screen.findByRole("button", { name: "Entrada" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Quantidade"), { target: { value: "100" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Somar ao estoque" }));

    expect(await screen.findByText("Entrada de 100 em Papel.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".saldo")!.textContent).toBe("150folhas"));
    expect(sentBody(fetch, "POST", "/admin/estoque/papel/entrada"))
      .toEqual({ quantidade: "100", valor_pago: "" });
  });
});
