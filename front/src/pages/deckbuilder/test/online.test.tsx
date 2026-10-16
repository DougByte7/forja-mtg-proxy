/* -------------------------------------------------------------------------
   A mesa online, do lado do navegador.

   MOTIVO DE EXISTIR. Online, a mesa da tela deixa de ser desta página: ela
   chega da sala, e a jogada vai pra lá. O jeito de isso quebrar é a página
   continuar jogando sozinha — aplicar a jogada aqui E mandar pra sala, ou
   desenhar a carta escondida como se fosse dela. O que este teste persegue:

   1. A mesa que chega vira a mesa da tela, com as cartas que vieram antes.
   2. A jogada vai pra sala e não muda nada aqui antes da resposta.
   3. O desfazer, a busca no baralho e a ficha seguem as regras da sala.
   4. A carta escondida é só o verso, e cada um fica embaixo na própria tela.
   5. Cair reconecta; sair volta pra mesa local.

   A sala de verdade é testada em `room/test`. Aqui o socket é de mentira.
   ------------------------------------------------------------------------- */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

type Sent = Record<string, any>;
interface FakeSocket {
  url: string;
  readyState: number;
  sent: Sent[];
  closed: boolean;
  send(m: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
}

let p: Record<string, any>;
let sockets: FakeSocket[];
const sock = () => sockets.at(-1)!;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

async function setUp() {
  p = await page();
  sockets = [];
  p.onlineDeps.token = async () => "tok-123";
  p.onlineDeps.WebSocket = (url: string) => {
    const s: FakeSocket = {
      url, readyState: 1, sent: [], closed: false,
      send(m) { this.sent.push(JSON.parse(m)); },
      close() { this.closed = true; },
      onopen: null, onmessage: null, onclose: null,
    };
    sockets.push(s);
    return s;
  };
}

/* A mesa como a sala a mandaria: Ana (0) e Bia (1), visto pela `seat`. A
   mão e o baralho dos outros vão sem `uid`, e nenhuma cópia leva a carta —
   as cartas vão em `cards`, uma vez. */
function viewFor(seat: number | null, { withCards = true, canUndo = false, looking = false } = {}) {
  const t = p.newTable([{ ...p.screenDeck(), name: "Elfos" }], () => 0.5);
  p.apply(t, { type: "join", deck: { ...p.screenDeck(), name: "Goblins" } }, () => 0.5);
  const cards: Record<number, unknown> = {};
  let masked = 0;
  for (const player of t.players) {
    for (const zone of ["baralho", "mao", "campo", "cemiterio", "exilio", "comando"]) {
      player[zone] = player[zone].map((c: any) => {
        const hidden = zone === "baralho" ? !(looking && c.owner === seat)
          : zone === "mao" ? c.owner !== seat : false;
        if (hidden) return { ...c, uid: -++masked, card: null, faceDown: true };
        if (withCards) cards[c.uid] = c.card;
        return { ...c, card: null };
      });
    }
  }
  const { cards: _, nextUid: __, ...view } = t;
  return {
    type: "view", seat, cards, looking, canUndo, table: view,
    seats: [{ name: "Ana", connected: true }, { name: "Bia", connected: false }],
  };
}

const receive = (msg: object) => act(() => { sock().onmessage!({ data: JSON.stringify(msg) }); });

async function joined(seat: number | null = 0) {
  await setUp();
  p.joinRoom("sala-teste-123");
  await flush();
  receive(viewFor(seat));
}

describe("entrar na sala", () => {
  it("abre o socket da sala com o token, e a mesa que chega vira a da tela", async () => {
    await joined();
    expect(sock().url).toMatch(/\/rooms\/sala-teste-123\?token=tok-123$/);
    const hand = p.state.table.players[0].mao;
    expect([hand.length, hand.every((c: any) => c.card?.nome), p.online.value.seat, p.online.value.status])
      .toEqual([7, true, 0, "aberta"]);
  });

  it("a carta que já chegou continua na mesa quando a mensagem nova não a traz", async () => {
    await joined();
    receive(viewFor(0, { withCards: false }));
    expect(p.state.table.players[0].mao.every((c: any) => c.card?.nome)).toBe(true);
  });

  it("sem conta, nem abre o socket", async () => {
    await setUp();
    p.onlineDeps.token = async () => null;
    p.joinRoom("sala-teste-123");
    await flush();
    expect([sockets.length, p.online.value.status]).toEqual([0, "sem-conta"]);
  });

  it("o erro da sala vira aviso, e a mesa fica como estava", async () => {
    await joined();
    const host = document.createElement("div");
    document.body.append(host);
    act(() => render(<p.Toast />, host));
    const before = p.state.table;
    receive({ type: "error", message: "Só quem está na vez passa o turno." });
    expect([host.textContent, p.state.table === before]).toEqual(["Só quem está na vez passa o turno.", true]);
  });
});

describe("jogar online", () => {
  it("a jogada vai pra sala, e a mesa daqui só muda com a resposta", async () => {
    await joined();
    p.keep(0);
    expect(sock().sent.at(-1)).toEqual({ type: "act", action: { type: "keep", player: 0 } });
    expect([p.state.table.players[0].phase, p.state.tableUndo.length]).toEqual(["mulligan", 0]);
  });

  it("o desfazer é o da sala, e só quando ela diz que há", async () => {
    await joined();
    p.undoTable();
    const without = sock().sent.length;
    receive(viewFor(0, { canUndo: true }));
    p.undoTable();
    expect([without, sock().sent.at(-1)]).toEqual([0, { type: "undo" }]);
  });

  it("o D compra do próprio baralho, mesmo fora da vez", async () => {
    await joined(1);
    p.tableShortcut(new KeyboardEvent("keydown", { key: "d" }));
    expect(sock().sent.at(-1)).toEqual({ type: "act", action: { type: "draw", player: 1, n: 1 } });
  });

  it("olhar o topo pede pra sala, e fechar avisa que parou de olhar", async () => {
    await joined();
    p.peekTop(0, 3);
    expect(sock().sent.at(-1)).toEqual({ type: "peek", n: 3 });
    p.closeTableModal();
    expect(sock().sent.at(-1)).toEqual({ type: "peek", n: 0 });
  });

  it("a carta dos outros no clique abre o menu, em vez de jogar por eles", async () => {
    await joined();
    const theirs = p.state.table.players[1].comando[0].uid;
    const sent = sock().sent.length;
    p.clickCard(theirs, document.body);
    expect([sock().sent.length, p.tableMenu.value?.kind]).toEqual([sent, "card"]);
  });

  it("buscar no próprio baralho pede pra sala abrir ele", async () => {
    await joined();
    p.openTableModal({ kind: "search", player: 0, zone: "baralho" });
    expect(sock().sent.at(-1)).toEqual({ type: "look" });
  });

  it("a ficha vai sem imagem, e a quantidade dentro do que a sala aceita", async () => {
    await joined();
    p.makeToken(0, { nome: "Soldado", imagem: "https://arte/soldado" }, "50");
    expect(sock().sent.at(-1)).toEqual({ type: "act", action: { type: "token", player: 0, model: { nome: "Soldado" }, count: 20 } });
  });

  it("embaralhar é recomeçar a partida, depois de confirmar", async () => {
    await joined();
    vi.stubGlobal("confirm", () => true);
    p.shuffleUp();
    expect(sock().sent.at(-1)).toEqual({ type: "restart" });
  });
});

describe("a mesa na tela", () => {
  async function panel(seat: number | null) {
    await joined(seat);
    const root = document.createElement("div");
    document.body.append(root);
    act(() => render(<p.GoldfishPanel />, root));
    const sections = [...root.querySelectorAll("section.gf-jogador")] as HTMLElement[];
    return { root, sections };
  }

  it("cada um fica embaixo na própria tela, com os outros espelhados em cima", async () => {
    const ana = await panel(0);
    const anaOrder = ana.sections.map((s) => [s.dataset.gfJ, s.classList.contains("espelhado")]);
    cleanup();
    const bia = await panel(1);
    const biaOrder = bia.sections.map((s) => [s.dataset.gfJ, s.classList.contains("espelhado")]);
    expect([anaOrder, biaOrder]).toEqual([[["1", true], ["0", false]], [["0", true], ["1", false]]]);
  });

  it("a mão dos outros é só o verso: não clica, não arrasta, não diz o uid", async () => {
    const { sections } = await panel(0);
    const theirs = [...sections[0].querySelectorAll(".gf-area-mao .gf-carta")] as HTMLButtonElement[];
    const mine = [...sections[1].querySelectorAll(".gf-area-mao .gf-carta")] as HTMLButtonElement[];
    expect([theirs.length, theirs.every((b) => b.disabled && !b.dataset.gfUid && b.draggable === false),
            mine.every((b) => !b.disabled && b.dataset.gfUid)]).toEqual([7, true, true]);
  });

  it("manter e mulligan só aparecem pra quem decide a mão", async () => {
    const { sections } = await panel(0);
    const buttons = (s: HTMLElement) => [...s.querySelectorAll(".gf-mulligan button")].map((b) => b.textContent);
    expect([buttons(sections[0]), buttons(sections[1])]).toEqual([[], ["Manter fica com 8", "Mulligan grátis, fica com 7"]]);
    expect(sections[0].querySelector(".gf-mulligan")!.textContent).toContain("Decidindo a mão");
  });

  it("a barra diz quem é a pessoa, o deck dela e se está conectada", async () => {
    const { sections } = await panel(0);
    const names = sections.map((s) => s.querySelector(".gf-nome-j")!.textContent);
    expect(names).toEqual(["Bia · Goblins", "Ana · Elfos"]);
    expect(sections[0].querySelector(".gf-conexao.on")).toBeNull();
  });

  it("quem só assiste vê a mesa sem os botões da mesa local, e volta ao lobby pela faixa", async () => {
    const { root } = await panel(null);
    act(() => { (root.querySelector("#lobby-assistir") as HTMLButtonElement).click(); });
    expect([!!root.querySelector("#gf-online-faixa"), !!root.querySelector("#gf-segundo"),
            !!root.querySelector("#gf-encerrar"), root.querySelector("#gf-embaralhar")!.textContent!.trim(),
            !!root.querySelector("#mesa-lobby")])
      .toEqual([true, false, false, "Recomeçar", false]);
    act(() => { (root.querySelector("#gf-online-sentar") as HTMLButtonElement).click(); });
    expect(root.querySelector("#mesa-lobby")).not.toBeNull();
  });
});

describe("o lobby de quem não sentou", () => {
  const summary = (id: string, nome: string, extra: object = {}) =>
    ({ id, nome, comandantes: ["Atraxa"], identidade: "WUBG", total: 100, atualizado_em: 1, arte: null, ...extra });

  /* A rede de mentira responde a lista de decks; o resto fica pendurado. */
  function decksOnTheServer(mine: object[], local: object[] = []) {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const body = url.endsWith("/decks/meus") ? { decks: mine }
        : url.endsWith("/decks/resumo") ? { decks: local, desconhecidos: [] } : null;
      if (!body) return new Promise(() => {});
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
  }

  async function lobby(seat: number | null, mine: object[] | null = null) {
    await setUp();
    if (mine) decksOnTheServer(mine);
    p.state.user = { login: "caio" };
    p.joinRoom("sala-teste-123");
    await flush();
    receive(viewFor(seat));
    const root = document.createElement("div");
    document.body.append(root);
    act(() => render(<p.GoldfishPanel />, root));
    await act(async () => { await flush(); await flush(); });
    return root;
  }

  it("mostra quem está na mesa e os decks em cartões, o mais mexido primeiro; o clique senta", async () => {
    const root = await lobby(null, [summary("aaa111", "Velho", { atualizado_em: 1 }),
                                    summary("bbb222", "Novo", { atualizado_em: 9, total: 92 })]);
    expect([root.querySelector("#gf-mesa"), root.querySelector(".lobby-sentados")!.textContent])
      .toEqual([null, expect.stringContaining("Ana· Elfos")]);
    const cards = [...root.querySelectorAll("[data-lobby-deck]")] as HTMLButtonElement[];
    expect(cards.map((c) => [c.dataset.lobbyDeck, c.querySelector(".lobby-info")!.textContent]))
      .toEqual([["bbb222", "92/100"], ["aaa111", "100/100"]]);
    act(() => { cards[1].click(); });
    expect([sock().sent.at(-1), cards.every((c) => c.disabled)]).toEqual([{ type: "sit", deckId: "aaa111" }, true]);
  });

  it("sem deck salvo, chama pra montar um numa aba nova", async () => {
    const root = await lobby(null, []);
    const make = root.querySelector('.lobby-vazio a[href="/deckbuilder"]') as HTMLAnchorElement;
    expect([make.target, root.querySelector(".lobby-vazio")!.textContent]).toEqual(["_blank", expect.stringContaining("esta mesa espera")]);
  });

  it("sem conta, o lobby é o convite pra entrar, e o login volta pra mesa", async () => {
    await setUp();
    p.onlineDeps.token = async () => null;
    history.replaceState(null, "", "/deckbuilder?mesa=sala-teste-123");
    p.joinRoom("sala-teste-123");
    await flush();
    const root = document.createElement("div");
    document.body.append(root);
    act(() => render(<p.GoldfishPanel />, root));
    expect(root.querySelector("#lobby-entrar")!.getAttribute("href"))
      .toBe("/entrar?voltar=" + encodeURIComponent("/deckbuilder?mesa=sala-teste-123"));
    history.replaceState(null, "", "/");
  });

  it("quem já sentou vê a mesa, não o lobby", async () => {
    const root = await lobby(0);
    expect([!!root.querySelector("#gf-mesa"), !!root.querySelector("#mesa-lobby")]).toEqual([true, false]);
  });
});

describe("o modo mesa (o link de convite)", () => {
  async function openPage(search: string) {
    history.replaceState(null, "", "/deckbuilder" + search);
    await setUp();
    const root = document.createElement("div");
    document.body.append(root);
    act(() => render(<p.App />, root));
    history.replaceState(null, "", "/");
    return root;
  }

  it("o link só com a mesa abre a página da mesa, sem nada de montar deck", async () => {
    const root = await openPage("?mesa=sala-teste-123");
    expect([p.tableMode.value, !!root.querySelector("#painel-goldfish"), !!root.querySelector("#area-deck"),
            !!root.querySelector("#lateral"), root.querySelector(".mesa-titulo b")!.textContent])
      .toEqual([true, true, false, false, "Mesa online"]);
  });

  it("com o deck junto (quem abriu a mesa do próprio deck), continua o deckbuilder", async () => {
    const root = await openPage("?deck=abc123&mesa=sala-teste-123");
    expect([p.tableMode.value, !!root.querySelector("#painel-goldfish .mesa-titulo"), !!root.querySelector("#lateral")])
      .toEqual([false, false, true]);
  });

  it("sair da mesa no modo mesa leva pros decks da pessoa", async () => {
    await joined();
    p.tableMode.value = true;
    const assign = vi.fn();
    vi.stubGlobal("location", { ...location, assign, search: "", pathname: "/deckbuilder", origin: location.origin });
    const root = document.createElement("div");
    document.body.append(root);
    act(() => render(<p.OnlineStrip />, root));
    act(() => { (root.querySelector("#gf-online-sair") as HTMLButtonElement).click(); });
    expect([assign.mock.calls, p.online.value]).toEqual([[["/"]], null]);
  });
});

describe("cair e sair", () => {
  it("cair reconecta sozinho, com um token novo", async () => {
    await joined();
    let tokens = 0;
    p.onlineDeps.token = async () => `tok-${++tokens}`;
    act(() => sock().onclose!());
    expect(p.online.value.status).toBe("conectando");
    vi.advanceTimersByTime(1000);
    await flush();
    expect([sockets.length, sock().url.endsWith("token=tok-1")]).toEqual([2, true]);
  });

  it("sair fecha o socket e volta pra mesa local, vazia", async () => {
    await joined();
    const s = sock();
    p.leaveRoom();
    expect([s.closed, p.online.value, p.state.table]).toEqual([true, null, null]);
    // O socket que fechou depois de sair não reconecta.
    s.onclose!();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(sockets.length).toBe(1);
  });
});
