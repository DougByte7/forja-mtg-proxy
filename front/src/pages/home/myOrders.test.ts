import { forgetOrder, readOrders, refreshStatuses, saveOrder, setOrderStatus, stateInfo, type SavedOrder } from "./myOrders";

const order = (id: string): SavedOrder => ({
  id, deck_hash: "h", nome: "Ana", valor: 10, qty: 9, backs: 0, pages: 1, blanks: 0,
  lam: "single", lamLabel: "Um lado", xml: "<order/>", pix: "000201", qr: "", status: "pending",
  criado_em: 1,
});

describe("myOrders", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("guarda no topo, sem repetir, no máximo 12, na chave de sempre", () => {
    for (let i = 0; i < 14; i++) saveOrder(order(`o${i}`));
    saveOrder(order("o5"));
    const list = readOrders();
    expect(list).toHaveLength(12);
    expect(list[0].id).toBe("o5");
    expect(JSON.parse(localStorage.getItem("forja.pedidos.v1")!)[0].id).toBe("o5");
  });

  it("cota estourada larga os mais velhos até caber", () => {
    saveOrder(order("velho"));
    const real = Storage.prototype.setItem;
    let calls = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k, v) {
      // só cabe uma lista de um pedido
      if (++calls === 1 || JSON.parse(v).length > 1) throw new Error("QuotaExceeded");
      return real.call(this, k, v);
    });
    saveOrder(order("novo"));
    expect(readOrders().map((o) => o.id)).toEqual(["novo"]);
  });

  it("marca status e esquece", () => {
    saveOrder(order("a"));
    saveOrder(order("b"));
    setOrderStatus("a", "notified");
    expect(readOrders().find((o) => o.id === "a")!.status).toBe("notified");
    expect(forgetOrder("a").map((o) => o.id)).toEqual(["b"]);
  });

  it("atualiza o andamento: 404 vira 'sumiu', erro de rede mantém", async () => {
    saveOrder(order("ok"));
    saveOrder(order("velho"));
    saveOrder(order("caiu"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("caiu")) throw new Error("rede");
      return url.endsWith("velho") ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ status: "impresso" }));
    }));
    await refreshStatuses(["ok", "velho", "caiu"]);
    const by = Object.fromEntries(readOrders().map((o) => [o.id, o.status]));
    expect(by).toEqual({ ok: "impresso", velho: "sumiu", caiu: "pending" });
  });

  it("estado desconhecido mostra 'Sem contato'", () => {
    expect(stateInfo("xyz").label).toBe("Sem contato");
    expect(stateInfo("erro_impressao").label).toBe("Na fila de impressão");
  });
});
