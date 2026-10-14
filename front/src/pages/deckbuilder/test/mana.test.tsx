/* Os símbolos de mana em componente desenham o mesmo que o `manaHTML` em
   string, que ainda serve as partes da tela que não viraram componente. */
import { render } from "preact";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

const COSTS = ["{2}{G}{W}", "{1}{G/W}{G/W}", "{X}{R}", "{1}{R} // {1}{U}", "{T}: Add {G}", "", "{2/B}"];

it("ManaCost desenha o mesmo que manaHTML", async () => {
  const p = await page();
  for (const cost of COSTS) {
    const fromString = document.createElement("div");
    fromString.innerHTML = p.manaHTML(cost);
    const fromComponent = document.createElement("div");
    render(<p.ManaCost cost={cost} />, fromComponent);
    // Mesma árvore e mesmos atributos (o espaço em branco do template não conta).
    // O híbrido mudou de forma de propósito (o degradê foi pro CSS, com as
    // cores em variáveis): fora ele, a mesma árvore e os mesmos atributos.
    const norm = (el: Element) => el.innerHTML.replace(/ style="[^"]*"/g, "").replace(/ class="pip hibrido"/g, ' class="pip"')
      .replace(/>\s+</g, "><").replace(/\s+/g, " ");
    expect(norm(fromComponent), cost).toBe(norm(fromString));
  }
});

it("o híbrido leva as duas cores em variáveis", async () => {
  const p = await page();
  const host = document.createElement("div");
  render(<p.ManaCost cost="{G/W}" />, host);
  const pip = host.querySelector(".pip.hibrido") as HTMLElement;
  expect(pip.style.getPropertyValue("--pip-a")).toBe("var(--mana-G)");
  expect(pip.style.getPropertyValue("--pip-b")).toBe("var(--mana-W)");
});

it("ManaText mantém a frase e troca só os custos", async () => {
  const p = await page();
  const host = document.createElement("div");
  render(<p.ManaText text="{2}{G} plus enough mana to <animate>" />, host);
  expect(host.querySelectorAll(".pip")).toHaveLength(2);
  expect(host.textContent).toBe("2 plus enough mana to <animate>");
});
