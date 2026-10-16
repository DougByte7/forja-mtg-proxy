/* A mesa do goldfish na tela: o que os botões, o menu da carta e as modais
   fazem com a mesa. As regras em si (conservação das cartas, mulligan,
   desfazer) são de `goldfish.test.ts`; aqui é o caminho do clique até elas. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

/** O painel da mesa e as sobreposições (menu, modais), montados na página. */
async function table() {
  const p = await page();
  const panel = document.createElement("div");
  const overlays = document.createElement("div");
  document.body.append(panel, overlays);
  act(() => {
    render(<p.GoldfishPanel />, panel);
    render(<p.TableOverlays />, overlays);
  });
  const click = (el: Element | null, init: MouseEventInit = {}) =>
    act(() => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })); });
  const button = (root: Element, text: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent!.trim() === text) || null;
  return { p, panel, overlays, click, button };
}

const handCards = (panel: Element) => panel.querySelectorAll(".gf-area-mao .gf-carta");
const title = (panel: Element, zone: string) => panel.querySelector(`.gf-${zone} .gf-area-titulo`)!.textContent;
const rightClick = (el: Element) =>
  act(() => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });

/** A mesa embaralhada e a mão mantida (o primeiro mulligan, grátis, não entra). */
async function playing() {
  const t = await table();
  t.click(t.panel.querySelector("#gf-comecar"));
  t.click(t.panel.querySelector('[data-gf-acao="manter:0"]'));
  return t;
}

describe("começar e o mulligan", () => {
  it("a mesa vazia chama pra embaralhar; a mão de abertura decide com o resultado nos botões", async () => {
    const { p, panel, click } = await table();
    expect([!!panel.querySelector("#gf-comecar"), !!panel.querySelector("#gf-embaralhar"),
            (panel.querySelector("#gf-passar") as HTMLButtonElement).disabled]).toEqual([true, false, true]);

    click(panel.querySelector("#gf-comecar"));
    expect(handCards(panel)).toHaveLength(7);
    expect(panel.querySelector("#gf-turno")!.textContent).toBe("Mão de abertura");
    expect(panel.querySelector(".gf-comando .gf-carta")!.getAttribute("title")).toContain("Atraxa");
    // Decidindo a mão, o turno não passa — nem pelo botão, nem pelo Espaço.
    expect((panel.querySelector("#gf-passar") as HTMLButtonElement).disabled).toBe(true);
    act(() => { p.tableShortcut(new KeyboardEvent("keydown", { key: " " })); });
    expect(p.state.table.active).toBe(0);
    expect(p.state.table.log.some((l: any) => l.text.startsWith("— turno"))).toBe(false);
    expect(panel.querySelector('[data-gf-acao="manter:0"]')!.textContent).toBe("Manter fica com 8");
    expect(panel.querySelector('[data-gf-acao="mulligan:0"]')!.textContent).toContain("grátis");

    click(panel.querySelector('[data-gf-acao="mulligan:0"]'));
    expect(panel.querySelector("#gf-turno")!.textContent).toBe("Mulligan 1");
    click(panel.querySelector('[data-gf-acao="manter:0"]'));
    expect([panel.querySelector(".gf-mulligan"), p.state.table.players[0].phase]).toEqual([null, "jogo"]);
    expect((panel.querySelector("#gf-passar") as HTMLButtonElement).disabled).toBe(false);
  });

  it("na fase de fundo a mão acende e conta quantas já foram", async () => {
    const { p, panel, click } = await table();
    click(panel.querySelector("#gf-comecar"));
    click(panel.querySelector('[data-gf-acao="mulligan:0"]'));
    click(panel.querySelector('[data-gf-acao="mulligan:0"]'));
    click(panel.querySelector('[data-gf-acao="manter:0"]'));
    expect([panel.querySelector(".gf-area-mao.escolhendo") !== null, handCards(panel)[0].classList.contains("escolhe"),
            panel.querySelector(".gf-mulligan")!.textContent]).toEqual([true, true, expect.stringContaining("0 de 1")]);
    click(handCards(panel)[0]);
    expect(p.state.table.players[0].phase).toBe("jogo");
  });

  it("partida nova com a mesa rolando pede confirmação", async () => {
    const { p, panel, click } = await playing();
    const before = p.state.table;
    vi.stubGlobal("confirm", () => false);
    click(panel.querySelector("#gf-embaralhar"));
    expect(p.state.table).toBe(before);
    vi.stubGlobal("confirm", () => true);
    click(panel.querySelector("#gf-embaralhar"));
    expect(p.state.table).not.toBe(before);
  });
});

describe("o clique faz a jogada da zona", () => {
  it("na mão baixa, no campo deita e endireita, e o Desfazer volta", async () => {
    const { p, panel, overlays, click } = await playing();
    const uid = p.state.table.players[0].mao[0].uid;
    click(panel.querySelector(`[data-gf-uid="${uid}"]`));
    expect([p.zoneOf(uid), overlays.querySelector(".gf-menu")]).toEqual(["campo", null]);

    const card = () => panel.querySelector(`[data-gf-uid="${uid}"]`)!;
    expect(card().getAttribute("title")).toContain("clique: deitar");
    click(card());
    expect(card().classList.contains("deitada")).toBe(true);
    click(card());
    expect(card().classList.contains("deitada")).toBe(false);

    click(panel.querySelector("#gf-desfazer"));
    click(panel.querySelector("#gf-desfazer"));
    click(panel.querySelector("#gf-desfazer"));
    expect(p.zoneOf(uid)).toBe("mao");
  });

  it("no comando lança o comandante e conta o imposto", async () => {
    const { p, panel, click } = await playing();
    click(panel.querySelector(".gf-comando .gf-carta"));
    expect([p.state.table.players[0].comando.length, p.state.table.players[0].taxPaid]).toEqual([0, 1]);
  });

  it("no deck compra uma, e a que chegou fica marcada", async () => {
    const { panel, click } = await playing();
    const before = handCards(panel).length;
    click(panel.querySelector(".gf-baralho .gf-pilha"));
    expect([handCards(panel).length, panel.querySelectorAll(".gf-area-mao .gf-carta.nova").length]).toEqual([before + 1, 1]);
    // Baixar uma carta muda a mão: a marca some.
    click(panel.querySelector(".gf-area-mao .gf-carta:not(.nova)"));
    expect(panel.querySelectorAll(".gf-area-mao .gf-carta.nova")).toHaveLength(0);
  });
});

describe("o menu da carta", () => {
  it("abre pelo botão direito com o nome, manda pro cemitério e mostra a jogada no Desfazer", async () => {
    const { panel, overlays, click, button } = await playing();
    const before = handCards(panel).length;
    rightClick(handCards(panel)[0]);
    const menu = overlays.querySelector(".gf-menu")!;
    expect(menu.querySelector(".gf-menu-cabeca b")!.textContent).toBeTruthy();
    click(button(menu, "Cemitério"));
    expect(overlays.querySelector(".gf-menu")).toBeNull();
    expect([handCards(panel).length, title(panel, "cemiterio")]).toEqual([before - 1, "Cemitério 1"]);
    expect(panel.querySelector(".gf-ultima")!.textContent).toContain("Mão → Cemitério");

    click(panel.querySelector("#gf-desfazer"));
    expect([handCards(panel).length, title(panel, "cemiterio")]).toEqual([before, "Cemitério 0"]);
  });

  it("o ⋯ abre o mesmo menu; o marcador fica com o menu aberto, e clicar fora fecha", async () => {
    const { p, panel, overlays, click } = await playing();
    const uid = p.state.table.players[0].mao[0].uid;
    click(panel.querySelector(`[data-gf-uid="${uid}"]`));
    click(panel.querySelector(`[data-gf-uid="${uid}"] [data-gf-menu]`));
    const chip = [...overlays.querySelectorAll(".gf-menu .chip")].find((b) => b.textContent === "+ +1/+1")!;
    click(chip);
    click(overlays.querySelector('.gf-menu [aria-label="Mais 1 de +1/+1"]'));
    expect(overlays.querySelector(".gf-menu .gf-linha b")!.textContent).toBe("2");
    expect(panel.querySelector(`[data-gf-uid="${uid}"] .gf-marca-b`)!.textContent).toBe("2: +1/+1");

    click(document.body);
    expect(overlays.querySelector(".gf-menu")).toBeNull();
  });

  it("um marcador de nome novo entra pelo campo do menu, sem prompt", async () => {
    const { p, panel, overlays } = await playing();
    const uid = p.state.table.players[0].mao[0].uid;
    act(() => { p.act({ type: "move", uid, to: "campo" }); p.touchTable(); });
    rightClick(panel.querySelector(`[data-gf-uid="${uid}"]`)!);
    const input = overlays.querySelector(".gf-menu-novo input") as HTMLInputElement;
    act(() => { input.value = "tempo: 3"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => { input.form!.requestSubmit(); });
    expect(p.cardByUid(uid).counters).toEqual({ "tempo 3": 1 });
  });
});

describe("as ferramentas do campo e o combate", () => {
  it("atacar com todas acende a faixa do combate, que encerra ali mesmo", async () => {
    const { p, panel, click } = await playing();
    const elves = p.state.table.players[0].baralho.concat(p.state.table.players[0].mao)
      .filter((c: any) => c.card.nome === "Llanowar Elves")[0];
    act(() => { p.act({ type: "move", uid: elves.uid, to: "campo" }); p.touchTable(); });
    click(panel.querySelector('[data-gf-acao="atacarTodas:0"]'));
    expect(panel.querySelector(".gf-combate-faixa")!.textContent).toContain("1 atacando");
    click(panel.querySelector("#gf-fim-combate"));
    expect(panel.querySelector(".gf-combate-faixa")).toBeNull();
  });

  it("vida anda de 5 em 5 com Shift, e clicar no número deixa digitar", async () => {
    const { p, panel, click } = await playing();
    click(panel.querySelector('[aria-label="Mais 1 de vida"]'), { shiftKey: true });
    click(panel.querySelector('[aria-label="Menos 1 de vida"]'));
    expect([p.state.table.players[0].life, panel.querySelector(".gf-vida b")!.textContent]).toEqual([44, "44"]);

    click(panel.querySelector(".gf-vida-valor"));
    const input = panel.querySelector(".gf-vida-campo") as HTMLInputElement;
    act(() => { input.value = "31"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect([p.state.table.players[0].life, p.state.table.log.at(-1).text]).toEqual([31, expect.stringContaining("vida -13")]);
  });
});

describe("o deck", () => {
  it("buscar no deck manda a carta e reembaralha ao fechar", async () => {
    const { p, panel, overlays, click, button } = await playing();
    rightClick(panel.querySelector(".gf-baralho .gf-pilha")!);
    click(button(overlays, "Buscar no deck"));
    const modal = overlays.querySelector(".gf-modal")!;
    expect(modal.querySelector("h3")!.textContent).toBe("Baralho de " + p.state.table.players[0].name);
    const cards = modal.querySelectorAll(".gf-busca-carta").length;

    click(modal.querySelector('[data-gf-manda$=":campo"]'));
    expect(overlays.querySelectorAll(".gf-busca-carta")).toHaveLength(cards - 1);
    click(overlays.querySelector("[data-gf-fechar]"));
    expect(overlays.querySelector(".gf-modal")).toBeNull();
    expect(p.state.table.log.at(-1).text).toContain("baralho reembaralhado");
  });

  it("o topo escolhido na busca vai pro topo DEPOIS de embaralhar", async () => {
    const { p, panel, overlays, click } = await playing();
    act(() => p.openTableModal({ kind: "search", player: 0, zone: "baralho" }));
    const uid = p.state.table.players[0].baralho.at(-1).uid;
    click(overlays.querySelector(`[data-gf-manda="${uid}:topo"]`));
    expect(overlays.querySelector(".gf-busca-carta.marcada")).not.toBeNull();
    click(overlays.querySelector(".gf-modal-pe .btn"));
    expect([p.state.table.players[0].baralho[0].uid, p.state.table.log.at(-1).text])
      .toEqual([uid, expect.stringContaining("1 no topo")]);
    void panel;
  });

  it("olhar o topo mostra as de cima, numeradas, e fechar não embaralha", async () => {
    const { p, panel, overlays, click, button } = await playing();
    rightClick(panel.querySelector(".gf-baralho .gf-pilha")!);
    click(overlays.querySelector('.gf-menu [aria-label="Mais uma"]'));
    click(button(overlays, "Olhar o topo 2"));
    const order = p.state.table.players[0].baralho.map((c: any) => c.uid);
    const shown = [...overlays.querySelectorAll(".gf-busca-pos")].map((x) => x.textContent);
    expect(shown).toEqual(["1", "2"]);
    // A de cima vai pro fundo: a terceira não entra na janela.
    click(overlays.querySelector(`[data-gf-manda="${order[0]}:fundo"]`));
    expect([...overlays.querySelectorAll(".gf-busca-pos")].map((x) => x.textContent)).toEqual(["1", String(order.length)]);
    click(overlays.querySelector(".gf-modal-pe .btn"));
    expect(p.state.table.players[0].baralho.map((c: any) => c.uid)).toEqual([...order.slice(1), order[0]]);
  });

  it("moer leva as de cima pro cemitério", async () => {
    const { panel, overlays, click } = await playing();
    rightClick(panel.querySelector(".gf-baralho .gf-pilha")!);
    click([...overlays.querySelectorAll(".gf-menu button")].find((b) => b.textContent!.includes("Moer"))!);
    expect(title(panel, "cemiterio")).toBe("Cemitério 1");
  });
});
