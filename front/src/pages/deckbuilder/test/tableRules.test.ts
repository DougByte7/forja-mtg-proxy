/* -------------------------------------------------------------------------
   As regras da mesa, fora da tela.

   MOTIVO DE EXISTIR. `tableRules.ts` é a parte do goldfish que precisa
   rodar longe desta página — no servidor de uma mesa compartilhada, que não
   tem `state`, DOM nem `Math.random` de confiança. O `goldfish.test.ts`
   confere as regras pela tela; este confere o que faz elas poderem sair dela:

   1. O módulo sobe sozinho, sem a página (é importado direto, sem harness).
   2. A ação é dado: a mesma ação, ida e volta por JSON, dá a mesma mesa.
   3. A sorte é argumento: a mesma semente dá a mesma mesa.
   4. Ação que não cabe (carta, jogador ou zona que não existe, tipo
      desconhecido) devolve `false` e não toca na mesa.
   5. O desfazer não faz o próximo `uid` voltar atrás.
   ------------------------------------------------------------------------- */
import { apply, newTable, type Action, type Table, type TableDeck } from "../tableRules";
import { carta, entrada } from "./fixtures";
import { cleanup, freshPage } from "./harness";

const FOREST = carta("Forest", "Basic Land — Forest", "G", "", 0.0);
const ELVES = carta("Llanowar Elves", "Creature — Elf Druid", "G", "{G}", 1.0);
const KRENKO = carta("Krenko", "Legendary Creature — Goblin", "R", "{2}{R}", 3.0);

const deck = (): TableDeck => ({
  name: "Deck", commanders: [KRENKO],
  entries: [entrada(FOREST, 10), entrada(ELVES, 10)],
});

/* Um gerador com semente: o mesmo começo dá a mesma sequência. */
function seeded(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const json = (t: Table) => JSON.stringify(t);

describe("as regras fora da tela", () => {
  it("a mesma semente dá a mesma mesa, e outra semente dá outra", () => {
    const a = newTable([deck()], seeded(1));
    const b = newTable([deck()], seeded(1));
    const c = newTable([deck()], seeded(2));
    expect([json(a) === json(b), json(a) === json(c)]).toEqual([true, false]);
  });

  it("a ação que passou por JSON dá a mesma mesa que a original", () => {
    const actions: Action[] = [
      { type: "keep", player: 0 },
      { type: "move", uid: 0, to: "campo" },
      { type: "token", player: 0, model: { nome: "Soldado" }, count: 2 },
      { type: "life", player: 0, n: -3 },
      { type: "pass" },
      { type: "mulligan", player: 0 },
    ];
    const here = newTable([deck()], seeded(7));
    const there = newTable([deck()], seeded(7));
    const hereRandom = seeded(9);
    const thereRandom = seeded(9);
    for (const action of actions) {
      // A carta movida é a primeira da mão, que só se conhece depois do keep.
      const real = action.type === "move" ? { ...action, uid: here.players[0].mao[0].uid } : action;
      apply(here, real, hereRandom);
      apply(there, JSON.parse(JSON.stringify(real)), thereRandom);
    }
    expect(json(there)).toBe(json(here));
  });

  it("ação que não cabe devolve false e não toca na mesa", () => {
    const t = newTable([deck()], seeded(3));
    const before = json(t);
    const bad = [
      { type: "move", uid: 9999, to: "campo" },
      { type: "move", uid: t.players[0].mao[0].uid, to: "bolso" },
      { type: "life", player: 5, n: -1 },
      { type: "tap", uid: 9999 },
      { type: "arrange", uid: t.players[0].mao[0].uid, target: 9999, after: true },
      { type: "explodir" },
    ] as unknown as Action[];
    expect(bad.map((a) => apply(t, a, seeded(4)))).toEqual(bad.map(() => false));
    expect(json(t)).toBe(before);
  });

  it("o uid não diz qual carta é: ele segue a ordem do baralho embaralhado", () => {
    const t = newTable([{ ...deck(), commanders: [] }], seeded(11));
    const all = [...t.players[0].mao, ...t.players[0].baralho];
    expect(all.map((c) => c.uid)).toEqual(all.map((_, i) => i + 1));
    // E a ordem do deck (dez Florestas e depois dez Elfos) não sobrevive.
    expect(all.slice(0, 10).every((c) => c.card?.nome === "Forest")).toBe(false);
  });

  it("a jogada que acontece devolve true", () => {
    const t = newTable([deck()], seeded(5));
    expect([apply(t, { type: "keep", player: 0 }), apply(t, { type: "pass" }),
            apply(t, { type: "life", player: 0, n: 1 })]).toEqual([true, true, true]);
  });
});

describe("o desfazer e o registro da mesa", () => {
  let p: Record<string, any>;
  beforeEach(async () => { p = await freshPage(); });
  afterEach(cleanup);

  it("a ficha criada depois da foto não faz o próximo uid se repetir", () => {
    p.setUpTable([deck()]);
    p.saveTableSnapshot();
    p.act({ type: "token", player: 0, model: { nome: "Soldado" }, count: 1 });
    const token = p.state.table.players[0].campo[0].uid;
    p.undoTableStep();
    p.act({ type: "token", player: 0, model: { nome: "Goblin" }, count: 1 });
    expect(p.state.table.players[0].campo[0].uid).not.toBe(token);
  });

  it("a foto não leva o registro, as artes nem o próximo uid", () => {
    p.setUpTable([deck()]);
    p.saveTableSnapshot();
    const photo = JSON.parse(p.state.tableUndo[0]);
    expect(["nextUid", "cards", "arts"].filter((k) => k in photo)).toEqual([]);
  });

  it("um marcador de carta com nome de campo da mesa fica na foto", () => {
    p.setUpTable([deck()]);
    p.act({ type: "keep", player: 0 });
    const uid = p.state.table.players[0].mao[0].uid;
    p.act({ type: "move", uid, to: "campo" });
    p.act({ type: "cardCounter", uid, name: "arts", n: 2 });
    p.saveTableSnapshot();
    p.act({ type: "cardCounter", uid, name: "arts", n: 1 });
    p.undoTableStep();
    expect(p.cardByUid(uid).counters.arts).toBe(2);
  });
});
