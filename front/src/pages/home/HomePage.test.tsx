import { fireEvent, screen, waitFor, within } from "@testing-library/preact";
import { mockFetch, renderWithQuery, sentBody } from "../../shared/testing";
import { HomePage } from "./HomePage";
import { readOrders, saveOrder } from "./myOrders";
import { SAMPLE } from "./sample";
import { deckId, loadXml, resetHomeState } from "./store";

type Handler = (method: string, url: string, body: any) => [number, unknown] | undefined;

const CHARGE = { order_id: "ord1", deck_hash: "abc123", amount: 3.33,
                 pix_copia_cola: "000201PIX", pix_qr_base64: "QR" };

function backend(extra: Handler = () => undefined) {
  return mockFetch((method, url, body) => {
    const r = extra(method, url, body);
    if (r) return r;
    if (url === "/precos") return [200, { single: 2, double: 4, foil: 9 }];
    if (url === "/conta") return [200, { usuario: { login: "ana", nome: "Ana", perfil: "amigo" } }];
    if (url === "/impressora/tinta") return [200, { estado: "desconhecido" }];
    return [404, { detail: `rota de teste não prevista: ${method} ${url}` }];
  });
}

/** A caixa de erro do formulário (o aviso de "não é loja" também é alert). */
const formError = () => waitFor(() => {
  const el = document.querySelector(".error.show");
  expect(el).toBeTruthy();
  return el!.textContent!;
});

/** A home desenhada e com o formulário à vista — ele só aparece depois de
    `/conta` dizer que é amigo (`OrderGate`). */
async function renderHome() {
  renderWithQuery(<HomePage />);
  await screen.findByLabelText("Seu nome");
}

const typeName = (name: string) =>
  fireEvent.input(screen.getByLabelText("Seu nome"), { target: { value: name } });

describe("HomePage", () => {
  beforeEach(() => {
    localStorage.clear();
    resetHomeState();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lê o XML e mostra o resumo com o preço do servidor", async () => {
    backend();
    await renderHome();
    expect(screen.getByText("Selecione o XML e escreva seu nome — o resumo aparece sozinho.")).toBeTruthy();

    const file = new File([SAMPLE], "deck.xml", { type: "text/xml" });
    fireEvent.change(document.getElementById("fileInput")!, { target: { files: [file] } });
    expect(await screen.findByText("deck.xml")).toBeTruthy();
    await screen.findByText("Falta escrever seu nome no passo 2.");

    typeName("Ana");
    const result = document.querySelector(".result.show") as HTMLElement;
    expect(within(result).getByText("Ana")).toBeTruthy();
    // 4 cartas + 1 verso = 5 slots, 1 página, 4 livres; dois lados a R$ 4
    expect(result.textContent).toContain("Versos próprios (dupla-face)1");
    await waitFor(() => expect(result.textContent).toContain("R$ 4,00"));
    expect(result.querySelectorAll(".grid-preview .filled")).toHaveLength(5);

    fireEvent.click(screen.getByText("Foil"));
    expect(result.textContent).toContain("R$ 9,00");
  });

  it("XML inválido mostra o erro", async () => {
    backend();
    await renderHome();
    loadXml("<order><fronts>");
    expect(await formError()).toMatch(/não é válido/);
  });

  it("a cobrança só sai com a declaração, guarda o pedido e vence quando o pedido muda", async () => {
    const fetch = backend((_, url) => url === "/orders" ? [200, CHARGE] : undefined);
    await renderHome();
    loadXml(SAMPLE);
    typeName("Ana");

    const pix = await screen.findByRole("button", { name: "Gerar cobrança Pix" }) as HTMLButtonElement;
    expect(pix.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Declaro que conheço o dono do sistema."));
    expect(pix.disabled).toBe(false);
    fireEvent.click(pix);

    expect(await screen.findByAltText("QR code Pix")).toBeTruthy();
    expect(screen.getByText("abc123")).toBeTruthy();
    const sent = sentBody(fetch, "POST", "/orders");
    expect(sent.lamination).toBe("double");
    expect(sent.customer_name).toBe("Ana");
    expect(readOrders()[0]).toMatchObject({ id: "ord1", nome: "Ana", qty: 4, backs: 1, status: "pending" });
    expect(screen.getByRole("button", { name: /Meus Pedidos/ }).textContent).toContain("1");

    typeName("Ana B");
    expect(screen.queryByAltText("QR code Pix")).toBeNull();
    expect(screen.getByText("O pedido mudou — gere a cobrança de novo.")).toBeTruthy();
  });

  it("falha da cobrança mostra o motivo do servidor", async () => {
    backend((_, url) => url === "/orders" ? [400, { detail: "Nome grande demais." }] : undefined);
    await renderHome();
    loadXml(SAMPLE);
    typeName("Ana");
    fireEvent.click(screen.getByLabelText("Declaro que conheço o dono do sistema."));
    fireEvent.click(screen.getByRole("button", { name: "Gerar cobrança Pix" }));
    expect(await screen.findByText("Nome grande demais. Ajuste e tente de novo.")).toBeTruthy();
  });

  it("revisão: mexe na folha, cancela sem mudar nada, confirma e reescreve o pedido", async () => {
    backend();
    await renderHome();
    loadXml(SAMPLE);
    typeName("Ana");

    fireEvent.click(screen.getByRole("button", { name: "Revisar o pedido antes de pagar" }));
    const dialog = screen.getByRole("dialog", { name: /Revisar o pedido/ });
    fireEvent.click(within(dialog).getAllByLabelText("Adicionar uma cópia de Bolt")[0]);
    expect(dialog.querySelector(".foot-sum")!.textContent).toContain("5 cartas");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(document.querySelector(".result")!.textContent).toContain("Cartas solicitadas4");

    fireEvent.click(screen.getByRole("button", { name: "Revisar o pedido antes de pagar" }));
    fireEvent.click(within(dialog).getAllByLabelText("Adicionar uma cópia de Bolt")[0]);
    fireEvent.click(within(dialog).getAllByLabelText("Adicionar uma cópia de Bolt")[0]);
    fireEvent.keyDown(document, { key: "z", ctrlKey: true });
    expect(dialog.querySelector(".foot-sum")!.textContent).toContain("5 cartas");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar revisão" }));

    expect(document.querySelector(".result")!.textContent).toContain("Cartas solicitadas5");
    expect(screen.getByText("Pedido revisado")).toBeTruthy();
  });

  it("cotação: começa, acompanha o job e desenha o resultado", async () => {
    const fetch = backend((_, url) =>
      url === "/cotacao" ? [200, { estado: "cotando", job_id: "j1" }]
      : url === "/cotacao/j1" ? [200, { estado: "pronto", resultado: {
          fontes: [{ id: "liga", rotulo: "LigaMagic", moeda: "BRL", total: 12, observacao: "menor preço" }],
          linhas: [{ nome: "Sol Ring", quantidade: 2, tipo: "Artifact",
                     precos: { liga: { preco_unitario: 6, loja: "Loja X", estoque_suficiente: true } } }],
        } }]
      : undefined);
    await renderHome();
    loadXml(SAMPLE);
    typeName("Ana");

    fireEvent.change(screen.getByLabelText(/Comandante/), { target: { value: "sol ring" } });
    fireEvent.click(screen.getByRole("button", { name: "Cotar preços das cartas" }));

    expect(await screen.findByText("Loja X")).toBeTruthy();
    expect(screen.getByText("R$ 12,00")).toBeTruthy();
    expect(sentBody(fetch, "POST", "/cotacao").commander).toBe("sol ring");

    // trocar o comandante tira a cotação da tela
    fireEvent.change(screen.getByLabelText(/Comandante/), { target: { value: "" } });
    expect(screen.queryByText("Loja X")).toBeNull();
  });

  it("pedido vindo do deckbuilder: XML do servidor, ou o que falta de arte", async () => {
    deckId.value = "d1";
    backend((_, url) => url === "/decks/d1/pedido" ? [200, {
      deck: { nome: "Atraxa", comandantes: ["Atraxa"], identidade: "WUBG", total: 99 },
      xml: null, faltando: [{ nome: "Sol Ring" }, { nome: "Delver", face: "verso" }],
    }] : undefined);
    await renderHome();

    expect(await screen.findByText("Atraxa", { selector: "h4" })).toBeTruthy();
    expect(await formError()).toContain("faltam 2 arte(s) — Sol Ring, Delver (verso)");
    expect(screen.getByText("Escolher as artes no deckbuilder").getAttribute("href")).toBe("/deckbuilder?deck=d1");
  });

  it("anônimo vê o convite pra entrar no lugar do formulário", async () => {
    backend((_, url) => url === "/conta" ? [200, { usuario: null }] : undefined);
    renderWithQuery(<HomePage />);
    expect(await screen.findByText("Entre pra fazer pedido")).toBeTruthy();
    expect(screen.queryByLabelText("Seu nome")).toBeNull();
  });

  it("conta que não é de amigo vê o porquê", async () => {
    backend((_, url) => url === "/conta"
      ? [200, { usuario: { login: "beto", nome: "Beto", perfil: "cliente" } }] : undefined);
    renderWithQuery(<HomePage />);
    expect(await screen.findByText("Pedido é só pra amigos do grupo")).toBeTruthy();
    expect(screen.queryByLabelText("Seu nome")).toBeNull();
  });

  it("Meus Pedidos: atualiza o andamento e cancela em dois cliques", async () => {
    saveOrder({ id: "o1", deck_hash: "h1", nome: "Ana", valor: 4, qty: 4, backs: 1, pages: 1, blanks: 4,
                lam: "double", lamLabel: "Dois lados", xml: SAMPLE, pix: "PIX", qr: "QR",
                status: "pending", criado_em: 1 });
    let status = "pending";
    const fetch = backend((method, url) =>
      url === "/orders/o1" ? [200, { status }]
      : url === "/orders/o1/cancel" && method === "POST" ? (status = "cancelado", [200, { message: "Pedido cancelado." }])
      : undefined);
    await renderHome();

    fireEvent.click(screen.getByRole("button", { name: /Meus Pedidos/ }));
    const dialog = screen.getByRole("dialog", { name: /Meus Pedidos/ });
    expect(within(dialog).getByText("Aguardando pagamento", { selector: ".od-topo .chip" })).toBeTruthy();
    expect(within(dialog).getByAltText("QR code Pix deste pedido")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar pedido" }));
    expect(within(dialog).getByText(/Isso não tem volta/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar cancelamento" }));

    expect(await within(dialog).findByText("Pedido cancelado.")).toBeTruthy();
    expect(within(dialog).getByText("Cancelado", { selector: ".od-topo .chip" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
    expect(readOrders()[0].status).toBe("cancelado");
    expect(fetch.mock.calls.some(([u, i]) => u === "/orders/o1/cancel" && i?.method === "POST")).toBe(true);
  });
});
