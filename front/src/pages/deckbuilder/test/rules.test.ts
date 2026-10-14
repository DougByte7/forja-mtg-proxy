/* -------------------------------------------------------------------------
   As regras que só existem no navegador: categorias, sideboard e
   maybeboard, do jeito que a tela do deckbuilder as aplica.

   MOTIVO DE EXISTIR. Estas regras moram DUAS vezes — uma no `decks.py`, que
   grava e valida, e outra aqui, que responde ao clique sem esperar a rede.
   Duas implementações da mesma regra divergem calado, e a divergência não
   aparece como erro: aparece como um número diferente nos dois lugares.

   Três divergências custam caro, e são as três que este teste persegue:

   1. O maybeboard entrando em alguma conta. Ele existe pra NÃO participar.
   2. O sideboard contando pras 100. O contador viveria acusando "5 cartas
      além das 100" num deck perfeitamente legal.
   3. Carta que some da tela: uma carta numa categoria que a lista de grupos
      não desenha continua no deck, no contador e na cotação — invisível e
      paga.
   ------------------------------------------------------------------------- */
import { entrada } from "./fixtures";
import { cleanup, type Page } from "./harness";
import {
  BOLT, CATEGORIAS, DECK, ELVES, INEDITA, LOTUS, MAYBE, page, SOL_RING, type Setup,
} from "./sampleDeck";

/** O que a tela ficou pensando. */
function seen(p: Page) {
  const e = p.estado;
  type Row = [string, number, string];
  const row = (x: any): Row => [x.carta.nome, x.quantidade, x.categoria || ""];
  return {
    cartas: e.cartas.map(row) as Row[],
    maybe: e.maybe.map(row) as Row[],
    categorias: e.categorias,
    total: p.totalCartas(),
    contadas: p.cartasContadas().map((x: any) => x.carta.nome),
    orcamento: p.orcamentoLocal(),
    ordem: p.ordemDasCategorias(e.cartas),
    apontamentos: p.validarLocal().apontamentos.map((a: any) => a.tipo),
    corpo: p.corpoDoDeck(),
    htmlDeck: p.gruposHTML(e.cartas, p.identidadeDoDeck(), "deck") as string,
    htmlTalvez: p.gruposHTML(e.maybe, p.identidadeDoDeck(), "talvez") as string,
    lista: p.listaTexto() as string,
  };
}

async function run(script: (p: Page) => void = () => {}, setup?: Setup) {
  const p = await page(setup);
  script(p);
  return seen(p);
}

const names = (html: string) => [...html.matchAll(/data-nome="([^"]+)"/g)].map((m) => m[1]);
const groups = (html: string) => [...html.matchAll(/data-categoria="([^"]+)"/g)].map((m) => m[1]);
const sorted = (xs: string[]) => [...xs].sort();

afterEach(cleanup);

describe("a lista, agrupada", () => {
  it("categorias próprias primeiro, Sideboard por último, nada some", async () => {
    const r = await run();
    // Primeiro o que a pessoa decidiu, depois o que a carta é, e o que está
    // fora da conta por último.
    expect(r.ordem.slice(0, 3)).toEqual(["Combo principal", "Sac outlet", "Ainda vazia"]);
    expect(r.ordem.at(-1)).toBe("Sideboard");
    expect(groups(r.htmlDeck)).toContain("Ainda vazia");
    expect(r.htmlDeck).toContain("data-abrir-manabase");
    expect(r.htmlDeck).toContain("fora das 100");
    // Toda carta do estado tem que aparecer na tela.
    expect(sorted(names(r.htmlDeck))).toEqual(sorted(DECK.map((e) => e.carta!.nome)));
    expect(sorted(names(r.htmlTalvez))).toEqual(sorted(MAYBE.map((e) => e.carta!.nome)));
  });

  it("carta com categoria que a lista não conhece continua visível", async () => {
    // A rede de segurança do `ordemDasCategorias`: um deck salvo por uma
    // versão anterior pode trazer categoria que a lista não conhece.
    const r = await run(undefined, { deck: [entrada(SOL_RING, 1, "Categoria fantasma")], categorias: [] });
    expect(names(r.htmlDeck)).toEqual(["Sol Ring"]);
  });

  it("o maybeboard mostra preço por carta, mas não subtotal por grupo", async () => {
    // "Vale o que custa?" é metade da dúvida; mas ele não entra na cotação,
    // e uma soma ali diria o contrário.
    const r = await run();
    expect(r.htmlTalvez).toContain('class="valor');
    expect(r.htmlTalvez).not.toContain("valor-grupo");
    expect(r.htmlDeck).toContain('class="valor');
    expect(r.htmlDeck).toContain("valor-grupo");
  });
});

describe("o que conta e o que não conta", () => {
  it("sideboard e maybeboard fora das 100", async () => {
    // 1 comandante + Sol Ring + Altar + 10 Forest + Elves = 14.
    const r = await run();
    expect(r.total).toBe(14);
    expect(r.contadas).not.toContain("Swords to Plowshares");
    expect(r.contadas).not.toContain("Rhystic Study");
  });

  it("a prévia soma deck e sideboard, sem maybeboard, comandante nem básicos", async () => {
    // Sol Ring 2 + Altar 8 + Elves 0,5 + Swords 3 = 13,50.
    const r = await run();
    expect(r.orcamento.total).toBeCloseTo(13.5, 2);
    expect(r.orcamento.fora).toBe(11);
  });

  it("a lista de impressão leva o sideboard e não leva o maybeboard", async () => {
    const r = await run();
    expect(sorted(r.lista.split("\n"))).toEqual(sorted([
      "1 Atraxa", "1 Sol Ring", "1 Ashnod's Altar", "10 Forest", "1 Llanowar Elves",
      "1 Swords to Plowshares"]));
  });
});

describe("o que a validação acusa", () => {
  it("fora da identidade: acusa no deck, não no maybeboard", async () => {
    const deck = await run(undefined, { deck: [entrada(BOLT)], maybe: [] });
    expect(deck.apontamentos).toContain("identidade");
    expect(deck.htmlDeck).toContain('class="linha problema"');
    // O maybeboard é rascunho: acusar identidade numa carta que a pessoa
    // ainda está pensando se usa é alarme sobre decisão que ela não tomou.
    const talvez = await run(undefined, { deck: [], maybe: [entrada(BOLT)] });
    expect(talvez.apontamentos).not.toContain("identidade");
    expect(talvez.htmlTalvez).not.toContain('class="linha problema"');
  });

  it("carta que ainda não saiu é aviso, não banida", async () => {
    // As duas chegam `legal: false`; tratá-las igual encheria de vermelho um
    // deck que só está adiantado. A mesma divisão mora no `decks.validar`.
    const r = await run(undefined, { deck: [entrada(INEDITA)], maybe: [] });
    expect(r.apontamentos).toContain("inedita");
    expect(r.apontamentos).not.toContain("banida");
    expect(r.htmlDeck).not.toContain('class="linha problema"');
    expect(r.htmlDeck).toContain("selo-inedita");
    expect(r.htmlDeck).toContain("13/11/2026");
  });

  it("a banida continua sendo erro", async () => {
    const r = await run(undefined, { deck: [entrada(LOTUS)], maybe: [] });
    expect(r.apontamentos).toContain("banida");
    expect(r.htmlDeck).toContain('class="linha problema"');
    expect(r.htmlDeck).not.toContain("selo-inedita");
  });
});

describe("mover entre o deck e o maybeboard", () => {
  it("a carta muda de lado com a categoria intacta, e sai das contas", async () => {
    const r = await run((p) => p.mover("Sol Ring", "deck", "talvez"));
    expect(r.cartas.map((c) => c[0])).not.toContain("Sol Ring");
    expect(r.maybe).toContainEqual(["Sol Ring", 1, "Combo principal"]);
    expect(r.total).toBe(13);
    expect(r.orcamento.total).toBeCloseTo(11.5, 2);
  });

  it("voltar pro deck traz a categoria de volta", async () => {
    const r = await run((p) => p.mover("Rhystic Study", "talvez", "deck"));
    expect(r.cartas).toContainEqual(["Rhystic Study", 1, "Combo principal"]);
  });

  it("a mesma carta nos dois lados soma ao voltar, sem duplicar", async () => {
    const r = await run((p) => p.mover("Llanowar Elves", "talvez", "deck"),
                        { maybe: [...MAYBE, entrada(ELVES, 2)] });
    expect(r.cartas).toContainEqual(["Llanowar Elves", 3, ""]);
    expect(r.maybe.map((c) => c[0])).not.toContain("Llanowar Elves");
  });
});

describe("categorias", () => {
  it("categorizar não move de lista nem muda quantidade", async () => {
    const r = await run((p) => p.definirCategoria("Llanowar Elves", "deck", "Sac outlet"));
    expect(r.cartas).toContainEqual(["Llanowar Elves", 1, "Sac outlet"]);
  });

  it("o Sideboard tira das 100 mas mantém na prévia; sair dele devolve", async () => {
    const r = await run((p) => p.definirCategoria("Llanowar Elves", "deck", "Sideboard"));
    expect(r.total).toBe(13);
    expect(r.orcamento.total).toBeCloseTo(13.5, 2);
    expect((await run((p) => p.definirCategoria("Swords to Plowshares", "deck", ""))).total).toBe(15);
  });

  it("renomear alcança a lista, as cartas do deck e o maybeboard", async () => {
    // O maybeboard herda as categorias do deck: renomear num lado e não no
    // outro deixaria um grupo órfão lá, com o nome velho e sem dono.
    const r = await run((p) => p.renomearCategoria("Combo principal", "Motor do deck"));
    expect(r.categorias).toContain("Motor do deck");
    expect(r.categorias).not.toContain("Combo principal");
    expect(r.cartas).toContainEqual(["Sol Ring", 1, "Motor do deck"]);
    expect(r.maybe).toContainEqual(["Rhystic Study", 1, "Motor do deck"]);
  });

  it("apagar a categoria não apaga carta nenhuma", async () => {
    const r = await run((p) => p.apagarCategoria("Combo principal"));
    expect([r.cartas.length, r.maybe.length]).toEqual([5, 2]);
    expect(r.cartas).toContainEqual(["Sol Ring", 1, ""]);
    expect(r.maybe).toContainEqual(["Rhystic Study", 1, ""]);
    expect(r.total).toBe(14);
  });

  it("criar a partir de uma carta já a põe dentro; nome repetido não duplica", async () => {
    const r = await run((p) => p.criarCategoria("Proteção", "Llanowar Elves", "deck"));
    expect(r.categorias).toContain("Proteção");
    expect(r.cartas).toContainEqual(["Llanowar Elves", 1, "Proteção"]);
    const dup = await run((p) => p.criarCategoria("SAC OUTLET", "Llanowar Elves", "deck"));
    expect(dup.categorias).toEqual(CATEGORIAS);
    expect(dup.cartas).toContainEqual(["Llanowar Elves", 1, "Sac outlet"]);
  });

  it("subir reordena as categorias", async () => {
    const r = await run((p) => p.moverCategoria("Sac outlet", -1));
    expect(r.categorias).toEqual(["Sac outlet", "Combo principal", "Ainda vazia"]);
  });
});

describe("desfazer", () => {
  it("Ctrl+Z devolve a carta pro deck", async () => {
    const r = await run((p) => { p.mover("Sol Ring", "deck", "talvez"); p.desfazer(); });
    expect(r.cartas).toContainEqual(["Sol Ring", 1, "Combo principal"]);
    expect(r.maybe.map((c) => c[0])).not.toContain("Sol Ring");
  });

  it("Ctrl+Z devolve a categoria apagada", async () => {
    const r = await run((p) => { p.apagarCategoria("Sac outlet"); p.desfazer(); });
    expect(r.categorias).toContain("Sac outlet");
    expect(r.cartas).toContainEqual(["Ashnod's Altar", 1, "Sac outlet"]);
  });
});

describe("o que a tela manda pro servidor", () => {
  it("categoria por carta, maybeboard à parte, e as categorias vazias também", async () => {
    const { corpo } = await run();
    expect(corpo.cartas.map((c: any) => c.categoria))
      .toEqual(["Combo principal", "Sac outlet", "", "", "Sideboard"]);
    expect(corpo.maybeboard.map((c: any) => c.nome)).toEqual(["Rhystic Study", "Lightning Bolt"]);
    // Uma categoria recém-criada sumiria antes de receber a primeira carta
    // se ela só existisse nas entradas.
    expect(corpo.categorias).toContain("Ainda vazia");
  });
});

