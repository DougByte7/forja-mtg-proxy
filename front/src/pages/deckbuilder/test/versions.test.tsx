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
  e.usuario = null;
  expect(p.completionBlocker()).toContain("conta");

  e.usuario = { id: "eu", perfil: "cliente" };
  e.versao = null;
  expect(p.completionBlocker()).toContain("Faltam");
  expect(pill(p)).toEqual(["WIP", "versao-pilula wip", true]);

  e.versao = { atual: 0, concluida_em: 1, mudou: false, entraram: 0, sairam: 0 };
  expect(p.completionBlocker()).toContain("igual à v0");
  expect(pill(p)[2]).toBe(true);   // na v0 ainda não há aba de histórico

  e.versao = { atual: 2, concluida_em: 1, mudou: true, entraram: 3, sairam: 1 };
  expect(p.completionBlocker()).toBe("");
  expect(pill(p)).toEqual(["v2", "versao-pilula mudou", false]);

  e.dono = "outra-pessoa";
  expect(p.completionBlocker()).toContain("dono");
  e.usuario = { id: "outra-pessoa", perfil: "comum" };
  expect(p.completionBlocker()).toBe("");

  e.historico = {
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
