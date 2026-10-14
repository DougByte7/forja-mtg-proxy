/* A página inteira (`ui/App.tsx`) com um deck aberto: os caminhos de clique
   e de teclado que atravessam mais de um componente. */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

async function app() {
  const p = await page();
  p.state.id = "abc123";
  p.state.name = "Atraxa";
  act(() => render(<p.App />, document.getElementById("app")!));
  act(() => p.redrawAll());
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  const click = (el: Element | null, init: MouseEventInit = {}) =>
    act(() => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })); });
  const key = (k: string, init: KeyboardEventInit = {}) =>
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })); });
  const frame = () => act(() => { vi.advanceTimersByTime(300); });
  const button = (text: string, root: ParentNode = document) =>
    [...root.querySelectorAll("button, a")].find((b) => b.textContent!.trim() === text) as HTMLElement | undefined;
  return { p, $, click, key, frame, button };
}

const rowNames = (sel: string) => [...document.querySelectorAll(`${sel} .linha`)].map((l) => (l as HTMLElement).dataset.nome);

describe("a página", () => {
  it("abre no deck, com o nome no cabeçalho e o Compartilhar à mão", async () => {
    const { $ } = await app();
    expect(($("#nome-deck") as HTMLInputElement).value).toBe("Atraxa");
    expect($("#btn-compartilhar")!.hidden).toBe(false);
    expect($("#heroi")).toBeNull();
    expect($("#painel-deck")!.hidden).toBe(false);
    expect(rowNames("#lista-deck")).toContain("Sol Ring");
  });

  it("as abas trocam o painel", async () => {
    const { $, click } = await app();
    click(document.querySelector('[data-painel="analise"][role="tab"]'));
    expect([$("#painel-deck")!.hidden, $("#painel-analise")!.hidden]).toEqual([true, false]);
    expect(document.querySelector('[data-painel="analise"][role="tab"]')!.getAttribute("aria-selected")).toBe("true");
  });

  it("o menu da linha manda pro maybeboard, Esc fecha o menu e Ctrl+Z desfaz", async () => {
    const { p, click, key, button } = await app();
    const row = document.querySelector('#lista-deck .linha[data-nome="Sol Ring"]')!;
    act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); });
    const menu = document.querySelector(".menu")!;
    expect(menu.textContent).toContain("Categoria de Sol Ring");
    click(button("Mover pro maybeboard", menu)!);
    expect(document.querySelector(".menu")).toBeNull();
    expect(rowNames("#talvez-lista")).toContain("Sol Ring");
    expect(rowNames("#lista-deck")).not.toContain("Sol Ring");

    act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    key("Escape");
    expect(document.querySelector(".menu")).toBeNull();

    key("z", { ctrlKey: true });
    expect(rowNames("#lista-deck")).toContain("Sol Ring");
    expect(p.state.maybe.some((e: any) => e.carta.nome === "Sol Ring")).toBe(false);
  });

  it("a quantidade digitada vale no change; lixo volta pro número de antes", async () => {
    const { p } = await app();
    const input = document.querySelector('#lista-deck [data-qtd="Forest"]') as HTMLInputElement;
    act(() => { input.value = "7"; input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(p.findEntry("Forest").quantidade).toBe(7);
    act(() => { input.value = "abc"; input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect([input.value, p.findEntry("Forest").quantidade]).toEqual(["7", 7]);
  });

  it("clicar na linha abre a carta; o ✕ da linha tira sem abrir", async () => {
    const { p, click } = await app();
    click(document.querySelector('#lista-deck .linha[data-nome="Sol Ring"] .nome'));
    expect(p.cardModal.value?.card.nome).toBe("Sol Ring");
    act(() => p.closeCard());
    act(() => { vi.advanceTimersByTime(300); });
    click(document.querySelector('#lista-deck .linha[data-nome="Sol Ring"] .mini.sai'));
    expect([p.cardModal.value, rowNames("#lista-deck").includes("Sol Ring")]).toEqual([null, false]);
  });

  it("o ··· do cabeçalho abre a gaveta de importar, que fecha no Esc", async () => {
    const { $, click, key, frame, button } = await app();
    click($("#btn-mais"));
    click(button("Importar lista", document.querySelector(".menu")!)!);
    frame();
    expect($("#gaveta-importar")!.hidden).toBe(false);
    expect($("#gaveta-importar")!.classList.contains("aberta")).toBe(true);
    expect($("#gaveta-fundo")!.classList.contains("aberta")).toBe(true);
    key("Escape");
    frame();
    expect($("#gaveta-importar")!.hidden).toBe(true);
  });

  it("importar sem nada colado pede o link ou a lista", async () => {
    const { $, click, frame, button } = await app();
    click($("#btn-mais"));
    click(button("Importar lista", document.querySelector(".menu")!)!);
    frame();
    click($("#btn-fazer-importar"));
    expect($("#i-resultado")!.textContent).toBe("Cole o link do deck ou a lista em texto.");
  });

  it("recolher a coluna do maybeboard fica lembrado", async () => {
    const { $, click } = await app();
    click($("#btn-recolher-talvez"));
    expect($("#corpo")!.classList.contains("talvez-fechado")).toBe(true);
    expect(localStorage.getItem("forja.deck.talvez-aberto")).toBe("0");
  });
});
