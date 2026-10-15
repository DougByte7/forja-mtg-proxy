/* -------------------------------------------------------------------------
   A sala.

   MOTIVO DE EXISTIR. A sala é o lugar onde a mesa compartilhada pode MENTIR
   pra um jogador sem nada na tela dizer: uma visão que deixa passar a mão
   do outro desenha normalmente, e a carta a mais no navegador de alguém só
   aparece no devtools. O que este teste persegue:

   1. A visão esconde o que a mesa de papel esconde, inclusive o `uid` da
      carta escondida, e o log não conta o que a visão esconde.
   2. A carta vai uma vez por conexão.
   3. O que cada assento pode fazer: o baralho dos outros não, a vez dos
      outros não, carta que não está vendo não.
   4. O desfazer é da própria última jogada, e não devolve informação.
   5. A sala guardada volta igual.
   ------------------------------------------------------------------------- */
import type { Table, TableCard, TableDeck } from "../../front/src/pages/deckbuilder/tableRules";
import { parseClientMessage, type ServerMessage } from "../src/protocol";
import { emptyRoom, loadRoom, Room, saveRoom, type Connection } from "../src/room";

const card = (nome: string, tipo: string) => ({ nome, tipo, imagem: "https://cards.example/" + nome, cmc: 1 });
const FOREST = card("Forest", "Basic Land — Forest");
const ELVES = card("Llanowar Elves", "Creature — Elf Druid");
const KRENKO = card("Krenko", "Legendary Creature — Goblin");

const deck = (name: string): TableDeck => ({
  name, commanders: [KRENKO],
  entries: [{ carta: FOREST, quantidade: 10 }, { carta: ELVES, quantidade: 10 }],
});

function seeded(seed: number) {
  let x = seed;
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

type View = Extract<ServerMessage, { type: "view" }>;

let room: Room;
const conn = (userId: string): Connection => ({ userId, known: new Set() });
const everyone = new Set(["ana", "bia", "caio"]);
const viewOf = (userId: string, c = conn(userId)) => room.messageFor(c, everyone) as View;
const table = () => room.state.table as Table;
const player = (i: number) => table().players[i];
const act = (userId: string, action: object) => room.handle(userId, { type: "act", action } as never);

/** Ana e Bia sentadas, as duas com a mão mantida. */
function twoSeated() {
  room = new Room(emptyRoom(), seeded(1));
  room.sit("ana", "Ana", "d1", deck("Elfos"));
  room.sit("bia", "Bia", "d2", deck("Goblins"));
  act("ana", { type: "keep", player: 0 });
  act("bia", { type: "keep", player: 1 });
}

const ids = (cards: TableCard[]) => cards.map((c) => c.uid);

describe("o que cada um vê", () => {
  beforeEach(twoSeated);

  it("a mão é do dono: os outros veem quantas, sem carta e sem uid", () => {
    const ana = viewOf("ana").table!;
    const theirs = ana.players[1].mao;
    expect([theirs.length, theirs.every((c) => c.card === null && c.uid < 0)]).toEqual([7, true]);
    expect(ids(ana.players[0].mao)).toEqual(ids(player(0).mao));
  });

  it("o baralho não é de ninguém, nem do dono, até ele procurar", () => {
    const before = viewOf("ana").table!.players[0].baralho;
    room.handle("ana", { type: "look" });
    const looking = viewOf("ana");
    expect([before.every((c) => c.uid < 0), looking.looking,
            ids(looking.table!.players[0].baralho).join() === ids(player(0).baralho).join(),
            viewOf("bia").table!.players[0].baralho.every((c) => c.uid < 0)])
      .toEqual([true, true, true, true]);
  });

  it("a carta virada no campo: os outros veem o uid e o estado, não a carta", () => {
    const uid = player(0).mao[0].uid;
    act("ana", { type: "move", uid, to: "campo", faceDown: true });
    act("ana", { type: "tap", uid });
    const seen = viewOf("bia").table!.players[0].campo[0];
    expect([seen.uid, seen.card, seen.tapped, uid in viewOf("bia").cards]).toEqual([uid, null, true, false]);
    expect(uid in viewOf("ana").cards).toBe(true);
  });

  it("quem só assiste vê o campo e o comando, nunca mão nem baralho", () => {
    const v = viewOf("caio");
    const uids = Object.keys(v.cards).map(Number);
    const hidden = new Set([...ids(player(0).mao), ...ids(player(1).mao),
                            ...ids(player(0).baralho), ...ids(player(1).baralho)]);
    expect([v.seat, uids.length, uids.some((u) => hidden.has(u))]).toEqual([null, 2, false]);
  });

  it("o log não conta a carta que só passou por zona escondida", () => {
    const uid = player(0).mao[0].uid;
    const name = player(0).mao[0].card!.nome;
    act("ana", { type: "move", uid, to: "baralho", toTop: true });
    act("ana", { type: "move", uid: player(0).mao[0].uid, to: "campo", faceDown: true });
    const recent = table().log.slice(-2).map((l) => l.text).join(" | ");
    expect([recent.includes(name), recent.includes("uma carta")]).toEqual([false, true]);
  });

  it("os outros não veem o que a pessoa jogou (o resumo é do dono)", () => {
    act("ana", { type: "move", uid: player(0).mao[0].uid, to: "campo" });
    expect([viewOf("ana").table!.players[0].plays.length, viewOf("bia").table!.players[0].plays.length])
      .toEqual([1, 0]);
  });
});

describe("a carta vai uma vez por conexão", () => {
  beforeEach(twoSeated);

  it("a segunda mensagem só traz a carta nova; outra conexão recebe tudo", () => {
    const c = conn("ana");
    const first = Object.keys(viewOf("ana", c).cards).length;
    const handAndCommanders = player(0).mao.length + 2;
    act("ana", { type: "draw", player: 0, n: 1 });
    const second = Object.keys(viewOf("ana", c).cards).map(Number);
    expect([first, second]).toEqual([handAndCommanders, [player(0).mao.at(-1)!.uid]]);
    expect(Object.keys(viewOf("ana").cards).length).toBe(first + 1);
  });

  it("a visão não leva a carta dentro da cópia", () => {
    const v = viewOf("ana").table!;
    expect(v.players.flatMap((p) => p.mao).every((c) => c.card === null)).toBe(true);
  });
});

describe("o que cada um pode fazer", () => {
  beforeEach(twoSeated);

  it("o baralho e a mão dos outros são deles", () => {
    expect([act("bia", { type: "draw", player: 0, n: 1 }), act("bia", { type: "mulligan", player: 0 }),
            act("bia", { type: "shuffle", player: 0 })].every(Boolean)).toBe(true);
    expect(player(0).mao.length).toBe(8);
  });

  it("só quem está na vez passa o turno", () => {
    expect([act("bia", { type: "pass" }), table().active]).toEqual([expect.any(String), 0]);
    expect([act("ana", { type: "pass" }), table().active]).toEqual([null, 1]);
  });

  it("carta escondida não se toca, nem pelo uid de verdade", () => {
    const theirs = player(1).mao[0].uid;
    expect(act("ana", { type: "move", uid: theirs, to: "cemiterio" })).toEqual(expect.any(String));
    expect(player(1).cemiterio.length).toBe(0);
  });

  it("a criatura do outro, no campo, se mata — e vai pro cemitério dele", () => {
    const theirs = player(1).mao[0].uid;
    act("bia", { type: "move", uid: theirs, to: "campo" });
    expect(act("ana", { type: "move", uid: theirs, to: "cemiterio" })).toBeNull();
    expect([player(0).cemiterio.length, player(1).cemiterio.length]).toEqual([0, 1]);
  });

  it("vida e marcadores dos outros se ajustam, como na mesa", () => {
    expect(act("ana", { type: "life", player: 1, n: -5 })).toBeNull();
    expect(player(1).life).toBe(35);
  });

  it("quem não sentou só assiste", () => {
    expect(act("caio", { type: "life", player: 0, n: -1 })).toEqual(expect.any(String));
  });

  it("procurando no baralho, pega a carta; embaralhar encerra a busca", () => {
    room.handle("ana", { type: "look" });
    const uid = player(0).baralho[5].uid;
    expect(act("ana", { type: "move", uid, to: "mao" })).toBeNull();
    act("ana", { type: "shuffle", player: 0 });
    expect([room.state.looking, viewOf("ana").looking]).toEqual([[], false]);
  });

  it("cair procurando no baralho embaralha e encerra a busca", () => {
    room.handle("ana", { type: "look" });
    const order = ids(player(0).baralho).join();
    expect(room.release("ana")).toBe(true);
    expect([room.state.looking, ids(player(0).baralho).join() === order]).toEqual([[], false]);
  });
});

describe("desfazer", () => {
  beforeEach(twoSeated);

  it("desfaz a própria última jogada, mesa e log juntos", () => {
    const uid = player(0).mao[0].uid;
    const logLength = table().log.length;
    act("ana", { type: "move", uid, to: "campo" });
    expect(viewOf("ana").canUndo).toBe(true);
    expect(room.handle("ana", { type: "undo" })).toBeNull();
    expect([player(0).mao.some((c) => c.uid === uid), table().log.length,
            player(0).mao.every((c) => c.card)]).toEqual([true, logLength, true]);
  });

  it("não desfaz a jogada do outro, nem a sua depois que o outro jogou", () => {
    act("ana", { type: "life", player: 0, n: -1 });
    expect(room.handle("bia", { type: "undo" })).toEqual(expect.any(String));
    act("bia", { type: "life", player: 1, n: -1 });
    expect(room.handle("ana", { type: "undo" })).toEqual(expect.any(String));
  });

  it("comprar e embaralhar não se desfazem", () => {
    act("ana", { type: "draw", player: 0, n: 1 });
    const afterDraw = viewOf("ana").canUndo;
    act("ana", { type: "shuffle", player: 0 });
    expect([afterDraw, viewOf("ana").canUndo]).toEqual([false, false]);
  });

  it("pôr carta no baralho se desfaz: não mostra nada", () => {
    act("ana", { type: "move", uid: player(0).mao[0].uid, to: "baralho", toTop: true });
    expect(viewOf("ana").canUndo).toBe(true);
  });
});

describe("sentar", () => {
  it("quatro na mesa, e cada um senta uma vez", () => {
    room = new Room(emptyRoom(), seeded(2));
    const results = ["a", "b", "c", "d", "e"].map((u) => room.sit(u, u, "d" + u, deck(u)));
    expect(results.map((r) => r === null)).toEqual([true, true, true, true, false]);
    expect([room.sit("a", "a", "x", deck("a")), table().players.length]).toEqual([expect.any(String), 4]);
  });

  it("recomeçar refaz a mesa com os decks de agora", () => {
    twoSeated();
    act("ana", { type: "life", player: 0, n: -10 });
    expect(room.restart("ana", [deck("Elfos"), deck("Goblins")])).toBeNull();
    expect([player(0).life, room.state.undo]).toEqual([40, null]);
  });
});

describe("guardar a sala", () => {
  it("a sala guardada volta igual, sem a carta repetida no JSON", () => {
    twoSeated();
    act("ana", { type: "move", uid: player(0).mao[0].uid, to: "campo" });
    const json = saveRoom(room.state);
    const back = loadRoom(json);
    expect(back).toEqual(room.state);
    // Uma carta por cópia, no registro (20 do baralho + o comandante, de
    // cada uma), e não de novo dentro da cópia.
    expect(json.split('\\"imagem\\"').length - 1).toBe(42);
  });

  it("sala vazia é sala nova", () => {
    expect(loadRoom(undefined)).toEqual(emptyRoom());
  });
});

describe("a forma das mensagens", () => {
  const parse = (x: object) => parseClientMessage(JSON.stringify(x));

  it("aceita as jogadas com a forma certa", () => {
    expect([parse({ type: "act", action: { type: "life", player: 0, n: -3 } }),
            parse({ type: "sit", deckId: "a1b2c3d4e5f6" }), parse({ type: "undo" })].every(Boolean)).toBe(true);
  });

  it("recusa número que é texto, ficha com imagem, sentar por jogada e lixo", () => {
    const bad = [
      { type: "act", action: { type: "life", player: 0, n: "5" } },
      { type: "act", action: { type: "life", player: 0, n: 1e9 } },
      { type: "act", action: { type: "token", player: 0, model: { nome: "x", imagem: "https://espiao" }, count: 1 } },
      { type: "act", action: { type: "join", deck: deck("x") } },
      { type: "act", action: { type: "cardCounter", uid: 1, name: "x".repeat(41), n: 1 } },
      { type: "sit", deckId: "../admin" },
      { type: "explodir" },
    ];
    expect(bad.map(parse)).toEqual(bad.map(() => null));
    expect(parseClientMessage("{não é json")).toBeNull();
  });
});
