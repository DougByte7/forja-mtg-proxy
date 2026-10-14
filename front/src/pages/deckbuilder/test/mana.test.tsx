/* Os símbolos de mana em componente: cada símbolo vira uma bolinha com
   nome, e a carta partida sai em dois grupos. */
import { render } from "preact";
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

/** Os lados do custo, cada um como a lista de [classe, title, texto] das bolinhas. */
async function pips(cost: string) {
  const p = await page();
  const host = document.createElement("div");
  render(<p.ManaCost cost={cost} />, host);
  return [...host.querySelectorAll(".lado")].map((side) =>
    [...side.querySelectorAll(".pip")].map((pip) => [pip.className, pip.getAttribute("title"), pip.textContent]));
}

it("cada símbolo com o seu nome: genérico, cor e híbrido", async () => {
  expect(await pips("{2}{G}{W}")).toEqual([[["pip C", "2 genérico", "2"], ["pip G", "Verde", ""], ["pip W", "Branco", ""]]]);
  expect(await pips("{1}{G/W}")).toEqual([[["pip C", "1 genérico", "1"], ["pip hibrido", "Verde ou Branco", ""]]]);
  expect(await pips("{X}{R}")).toEqual([[["pip C", "X", "X"], ["pip R", "Vermelho", ""]]]);
});

it("a carta partida sai em dois grupos, e custo vazio não desenha nada", async () => {
  expect((await pips("{1}{R} // {1}{U}")).map((side) => side.length)).toEqual([2, 2]);
  expect(await pips("")).toEqual([]);
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
