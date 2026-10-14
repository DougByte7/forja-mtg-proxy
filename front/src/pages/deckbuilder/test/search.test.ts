/* O paginador da busca. */
import { cleanup } from "./harness";
import { page } from "./sampleDeck";

afterEach(cleanup);

const EMPTY = { tipo: "", texto: "", cores: "", cmcMin: "", cmcMax: "", precoMax: "", ordem: "nome", ineditas: false };

it("existe quando a pessoa fez uma pergunta, e não com a caixa vazia", async () => {
  // Paginar a caixa vazia seria folhear a base de cinco em cinco. `cmcMin:
  // "0"` conta como filtro (ele vira chip na fita); as inéditas não, porque
  // ALARGAM a lista.
  const p = await page();
  const withFilters = (change: object, term = "") => {
    p.estado.filtros = { ...EMPTY, ...change };
    return p.listaPaginada(term);
  };
  expect(withFilters({})).toBe(false);
  expect(withFilters({}, "bolt")).toBe(true);
  expect([withFilters({ tipo: "creature" }), withFilters({ cores: "G" }),
          withFilters({ cmcMin: "0" }), withFilters({ ordem: "preco_desc" })]).toEqual([true, true, true, true]);
  expect(withFilters({ ineditas: true })).toBe(false);
});

it("sem paginador, a frase do fim diz o que fazer", async () => {
  const p = await page();
  const list = Array.from({ length: 24 }, (_, i) => ({ nome: "Carta " + i, tipo: "Instant",
    mana_cost: "{1}", preco_usd: 1, imagem: "", identidade: "", legal: true }));
  const withName = document.createElement("div"), withoutName = document.createElement("div");
  p.mostrarResultados(withName, list, () => {}, { termo: "bolt" });
  p.mostrarResultados(withoutName, list, () => {}, { termo: "" });
  expect(withName.innerHTML).toContain("Escreva mais uma letra");
  expect(withoutName.innerHTML).toContain("Escreva um nome ou use os filtros");
});

it("o denominador vem do total do servidor, e o número não passa do fim", async () => {
  // 37 cartas de 5 em 5 são 8 páginas, e a oitava tem duas.
  const p = await page();
  Object.assign(p.estado, { buscaTotal: 37, buscaPorPagina: 5, buscaPagina: 0 });
  const first = p.paginadorDaBusca();
  p.estado.buscaPagina = 7;
  const last = p.paginadorDaBusca();
  p.estado.buscaPorPagina = 15;
  const fifteen = p.paginadorDaBusca();
  expect(first).toContain("1 / 8");
  expect(first).toContain('data-res-pag="-1" title="Página anterior"');
  expect(first.split('data-res-pag="1"')[0]).toContain("disabled");
  expect(last.split('data-res-pag="1"')[1]).toContain("disabled");
  expect(fifteen).toContain('<option value="15" selected>');
  // 37 de 15 em 15 são 3: a página 7 não existe mais.
  expect(fifteen).toContain("3 / 3");
});

it("as setas param nas pontas, e trocar o tamanho volta pro começo", async () => {
  // "Página 4" de 5 em 5 não é a mesma coisa que "página 4" de 15 em 15.
  const p = await page();
  p.estado.filtros.tipo = "creature";
  Object.assign(p.estado, { buscaTotal: 37, buscaPorPagina: 5, buscaPagina: 0 });
  p.virarPagina(-1);
  expect(p.estado.buscaPagina).toBe(0);
  p.virarPagina(1);
  expect(p.estado.buscaPagina).toBe(1);
  p.estado.buscaPagina = 7;
  p.virarPagina(1);
  expect(p.estado.buscaPagina).toBe(7);
  p.escolherPorPagina(15);
  expect([p.estado.buscaPorPagina, p.estado.buscaPagina]).toEqual([15, 0]);
});
