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

describe("a mesa na tela", () => {
  it("embaralha, mostra a mão de abertura e mantém", async () => {
    const { p, panel, click, button } = await table();
    expect(panel.querySelector("#gf-mesa")!.textContent).toContain("Clique em Embaralhar");
    expect((panel.querySelector("#gf-passar") as HTMLButtonElement).disabled).toBe(true);

    click(panel.querySelector("#gf-embaralhar"));
    expect(handCards(panel)).toHaveLength(7);
    expect(panel.querySelector("#gf-turno")!.textContent).toBe("Mão de abertura");
    expect(panel.querySelector(".gf-comando .gf-carta")!.getAttribute("title")).toBe("Atraxa");

    click(button(panel, "Mulligan"));
    expect(panel.querySelector("#gf-turno")!.textContent).toBe("Mulligan 1");
    // O primeiro mulligan é grátis: mantém sem mandar nada pro fundo.
    click(button(panel, "Manter esta mão"));
    expect(panel.querySelector(".gf-mulligan")).toBeNull();
    expect(p.state.table.players[0].phase).toBe("jogo");
  });

  it("o menu da carta manda pro cemitério, e o Desfazer devolve", async () => {
    const { panel, overlays, click, button } = await table();
    click(panel.querySelector("#gf-embaralhar"));
    click(button(panel, "Manter esta mão"));
    const before = handCards(panel).length;

    click(handCards(panel)[0]);
    expect(overlays.querySelector(".gf-menu")!.textContent).toContain("Mandar pra");
    click(button(overlays.querySelector(".gf-menu")!, "Cemitério"));
    expect(overlays.querySelector(".gf-menu")).toBeNull();
    expect([handCards(panel).length, panel.querySelector(".gf-cemiterio .gf-area-titulo")!.textContent])
      .toEqual([before - 1, "Cemitério 1"]);

    click(panel.querySelector("#gf-desfazer"));
    expect([handCards(panel).length, panel.querySelector(".gf-cemiterio .gf-area-titulo")!.textContent])
      .toEqual([before, "Cemitério 0"]);
  });

  it("o marcador da carta fica com o menu aberto, e clicar fora fecha", async () => {
    const { p, panel, overlays, click } = await table();
    click(panel.querySelector("#gf-embaralhar"));
    const uid = p.state.table.players[0].mao[0].uid;
    act(() => { p.act({ type: "move", uid, to: "campo" }); p.touchTable(); });

    click(panel.querySelector(`[data-gf-uid="${uid}"]`));
    const plus = () => overlays.querySelector(".gf-menu .gf-linha button:last-of-type");
    click(plus());
    click(plus());
    expect(overlays.querySelector(".gf-menu .gf-linha b")!.textContent).toBe("2");
    expect(panel.querySelector(`[data-gf-uid="${uid}"] .gf-marca-b`)!.textContent).toBe("2: +1/+1");

    click(document.body);
    expect(overlays.querySelector(".gf-menu")).toBeNull();
    // Deitar pelo ícone, sem passar pelo menu.
    click(panel.querySelector(`[data-gf-tap="${uid}"]`));
    expect(panel.querySelector(`[data-gf-uid="${uid}"]`)!.classList.contains("deitada")).toBe(true);
  });

  it("vida anda de 5 em 5 com Shift", async () => {
    const { p, panel, click } = await table();
    click(panel.querySelector("#gf-embaralhar"));
    click(panel.querySelector('[aria-label="Mais 1 de vida"]'), { shiftKey: true });
    click(panel.querySelector('[aria-label="Menos 1 de vida"]'));
    expect([p.state.table.players[0].life, panel.querySelector(".gf-vida b")!.textContent]).toEqual([44, "44"]);
  });

  it("buscar no deck manda a carta e reembaralha ao fechar", async () => {
    const { p, panel, overlays, click, button } = await table();
    click(panel.querySelector("#gf-embaralhar"));
    click(panel.querySelector(".gf-baralho .gf-pilha"));
    click(button(overlays, "Buscar no deck"));
    const modal = overlays.querySelector(".gf-modal")!;
    expect(modal.querySelector("h3")!.textContent).toBe("Baralho de " + p.state.table.players[0].name);
    const rows = modal.querySelectorAll(".gf-lista-linha").length;

    click(modal.querySelector('[data-gf-manda$=":campo"]'));
    expect(overlays.querySelectorAll(".gf-lista-linha")).toHaveLength(rows - 1);
    click(overlays.querySelector("[data-gf-fechar]"));
    expect(overlays.querySelector(".gf-modal")).toBeNull();
    expect(p.state.table.log.at(-1).text).toContain("baralho reembaralhado");
  });
});
