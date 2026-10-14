/* As versões do deck. O clique de concluir só é oferecido quando o servidor
   o aceitaria: errar pra menos esconde o botão de quem pode concluir; errar
   pra mais vira um clique que sempre volta com "não". */
import { cleanup } from "./harness";
import { ELVES, page, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

const pill = () => {
  const b = document.getElementById("btn-versao")!;
  return [b.textContent, b.className, (document.getElementById("aba-historico") as HTMLElement).hidden];
};

it("quem pode concluir, e o que a pílula e o histórico mostram", async () => {
  const p = await page();
  const e = p.estado;
  e.usuario = null;
  expect(p.bloqueioDeConcluir()).toContain("conta");

  e.usuario = { id: "eu", perfil: "cliente" };
  e.versao = null;
  expect(p.bloqueioDeConcluir()).toContain("Faltam");
  p.desenharVersao();
  expect(pill()).toEqual(["WIP", "versao-pilula wip", true]);

  e.versao = { atual: 0, concluida_em: 1, mudou: false, entraram: 0, sairam: 0 };
  expect(p.bloqueioDeConcluir()).toContain("igual à v0");
  p.desenharVersao();
  expect(pill()[2]).toBe(true);   // na v0 ainda não há aba de histórico

  e.versao = { atual: 2, concluida_em: 1, mudou: true, entraram: 3, sairam: 1 };
  expect(p.bloqueioDeConcluir()).toBe("");
  p.desenharVersao();
  expect(pill()).toEqual(["v2", "versao-pilula mudou", false]);

  e.dono = "outra-pessoa";
  expect(p.bloqueioDeConcluir()).toContain("dono");
  e.usuario = { id: "outra-pessoa", perfil: "comum" };
  expect(p.bloqueioDeConcluir()).toBe("");

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
  p.desenharHistorico();
  const hist = document.getElementById("historico-resultado")!.innerHTML;
  expect(hist).toContain("Concluir v3");
  expect(hist).toContain('<span class="zona">sideboard</span>');
  expect(hist).toContain('data-arte="http://arte/Sol Ring"');
  expect(hist).toContain("primeira versão · 100 cartas");
  expect([...hist.matchAll(/<span class="versao-pilula">(v\d+)<\/span>/g)].map((m) => m[1])).toEqual(["v2", "v0"]);
});
