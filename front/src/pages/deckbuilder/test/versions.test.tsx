/* As versões do deck. O clique de concluir só é oferecido quando o servidor
   o aceitaria: errar pra menos esconde o botão de quem pode concluir; errar
   pra mais vira um clique que sempre volta com "não". */
import { render } from "preact";
import { act } from "preact/test-utils";
import { cleanup } from "./harness";
import { ELVES, page, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

/** O texto e a classe da pílula, e se a aba de histórico existe. */
const pill = (p: any) => {
  const v = p.versionPillView();
  return [v.text, v.className, !v.hasHistory];
};

it("quem pode concluir, e o que a pílula e o histórico mostram", async () => {
  const p = await page();
  const e = p.state;
  e.user = null;
  expect(p.completionBlocker()).toContain("conta");

  e.user = { id: "eu", perfil: "cliente" };
  e.version = null;
  expect(p.completionBlocker()).toContain("Faltam");
  expect(pill(p)).toEqual(["WIP", "versao-pilula wip", true]);

  e.version = { atual: 0, concluida_em: 1, mudou: false, entraram: 0, sairam: 0 };
  expect(p.completionBlocker()).toContain("igual à v0");
  expect(pill(p)[2]).toBe(true);   // na v0 ainda não há aba de histórico

  e.version = { atual: 2, concluida_em: 1, mudou: true, entraram: 3, sairam: 1 };
  expect(p.completionBlocker()).toBe("");
  expect(pill(p)).toEqual(["v2", "versao-pilula mudou", false]);

  e.owner = "outra-pessoa";
  expect(p.completionBlocker()).toContain("dono");
  e.user = { id: "outra-pessoa", perfil: "comum" };
  expect(p.completionBlocker()).toBe("");

  e.history = {
    atual: 2,
    pendente: { entraram: [{ nome: "Sol Ring", zona: "side", quantidade: 1, carta: SOL_RING }],
                sairam: [], n_entraram: 1, n_sairam: 0 },
    versoes: [
      { numero: 2, criado_em: 1, total: 100, diferenca: {
        entraram: [{ nome: "Llanowar Elves", zona: "deck", quantidade: 1, carta: ELVES }],
        sairam: [{ nome: "Forest", zona: "deck", quantidade: 1, carta: null }],
        n_entraram: 1, n_sairam: 1 } },
      { numero: 0, criado_em: 1, total: 100, diferenca: null }],
  };
  const host = document.createElement("div");
  act(() => render(<p.History />, host));
  const hist = host.innerHTML;
  expect(hist).toContain("Concluir v3");
  expect(hist).toContain('<span class="zona">sideboard</span>');
  expect(hist).toContain('data-arte="http://arte/Sol Ring"');
  expect(hist).toContain("primeira versão · 100 cartas");
  expect([...hist.matchAll(/<span class="versao-pilula">(v\d+)<\/span>/g)].map((m) => m[1])).toEqual(["v2", "v0"]);
});

it("o pedido de cada versão: só pra quem pode pedir, e só onde entrou carta", async () => {
  const p = await page();
  const e = p.state;
  e.id = "abc123";
  e.history = {
    atual: 2, pendente: null,
    versoes: [
      { numero: 2, criado_em: 1, total: 99, diferenca: {
        entraram: [], sairam: [{ nome: "Forest", zona: "deck", quantidade: 1, carta: null }],
        n_entraram: 0, n_sairam: 1 } },
      { numero: 1, criado_em: 1, total: 100, diferenca: {
        entraram: [{ nome: "Llanowar Elves", zona: "deck", quantidade: 1, carta: ELVES }],
        sairam: [], n_entraram: 1, n_sairam: 0 } },
      { numero: 0, criado_em: 1, total: 100, diferenca: null }],
  };
  const links = () => {
    const host = document.createElement("div");
    act(() => render(<p.History />, host));
    return [...host.querySelectorAll("a.btn")].map((a) => a.getAttribute("href"));
  };
  e.user = { id: "eu", perfil: "comum" };
  expect(links()).toEqual([]);
  e.user = { id: "eu", perfil: "amigo" };
  expect(links()).toEqual(["/pedido?deck=abc123&versao=1", "/pedido?deck=abc123&versao=0"]);
});
