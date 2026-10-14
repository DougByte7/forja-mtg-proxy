/* -------------------------------------------------------------------------
   O simulador de goldfish.

   MOTIVO DE EXISTIR. Este é o único lugar da tela que MOVE cartas entre
   zonas, e o jeito de ele quebrar é silencioso: uma carta some, ou aparece
   duas vezes, e a mesa continua desenhando normalmente. Um goldfish que
   duplica carta MENTE sobre o deck.

   O que este teste persegue:
   1. A conservação das cartas: depois de qualquer sequência de jogadas, a
      soma das zonas é o mesmo multiconjunto do começo.
   2. O baralho é o deck certo: sem comandante, sideboard nem maybeboard.
   3. As regras do formato que mudam a mão: o primeiro mulligan é grátis e
      quem começa jogando compra no turno 1.
   4. Cada cópia tem identidade própria (deitar uma não deita as trinta).
   5. A carta volta pra zona do DONO.
   6. A fotografia do desfazer não leva as cartas, e as religa na volta.
   7. A marca de combo diz onde a peça está, e só do deck da tela.
   ------------------------------------------------------------------------- */
import { carta, entrada } from "./fixtures";
import { cleanup, clone, freshPage, type Page } from "./harness";

const ATRAXA = carta("Atraxa", "Legendary Creature — Angel", "WUBG", "{3}{W}{U}{B}{G}", 7.0);
const KRENKO = carta("Krenko", "Legendary Creature — Goblin", "R", "{2}{R}", 3.0);
const basic = (nome: string, cor: string) => ({ ...carta(nome, `Basic Land — ${nome}`, cor, "", 0.0), basico: true });
const FOREST = basic("Forest", "G");
const MOUNTAIN = basic("Mountain", "R");
const SOL_RING = carta("Sol Ring", "Artifact", "", "{1}", 1.0);
const ELVES = carta("Llanowar Elves", "Creature — Elf Druid", "G", "{G}", 1.0);
const SWORDS = carta("Swords to Plowshares", "Instant", "W", "{W}", 1.0);
const BOLT = carta("Lightning Bolt", "Instant", "R", "{R}", 1.0);
const FINKS = carta("Kitchen Finks", "Creature — Ouphe", "GW", "{1}{G/W}", 3.0);
const DFC = { ...carta("Delver of Secrets // Insectile Aberration",
                       "Creature — Human Wizard // Creature — Human Insect", "U", "{U}", 1.0),
              imagem_verso: "http://arte/verso" };

// 1 Sol Ring + 10 Forest + 4 Elves = 15 no baralho. O sideboard e o
// maybeboard ficam de fora, e o comandante vai pra zona de comando.
const DECK = [entrada(SOL_RING, 1), entrada(FOREST, 10), entrada(ELVES, 4),
              entrada(SWORDS, 2, "Sideboard")];
const MAYBE = [entrada(BOLT, 3)];
const IN_LIBRARY = 15;
// O segundo deck, montado à mão como `addSecondDeck` o recebe.
const deck2 = () => clone({ name: "Deck do outro", commanders: [KRENKO],
                            entries: [{ carta: MOUNTAIN, quantidade: 6 }, { carta: BOLT, quantidade: 2 }] });
const IN_LIBRARY2 = 8;

type Card = { uid: number; owner: number; card: any; [k: string]: any };
const ZONES = ["baralho", "mao", "campo", "cemiterio", "exilio", "comando"];

let p: Page;
const j = (i = 0) => p.state.table.players[i];
const table = () => p.setUpTable([p.screenDeck()]);
/** Todas as cartas de todas as zonas, pra comparar multiconjuntos. */
const all = () => p.state.table.players.flatMap((pl: any) =>
  ZONES.flatMap((z) => pl[z].map((c: Card) => `${c.uid}:${c.card.nome}`))).sort();
/** A carta `nome` em qualquer zona — a mão de abertura já foi comprada, e
    procurar só no baralho acharia ou não conforme o embaralhamento. */
const find = (nome: string, i = 0): Card[] =>
  ZONES.flatMap((z) => j(i)[z].filter((c: Card) => c.card?.nome === nome));
/** Florestas fora do campo. Da mão E do baralho: as dez estão sempre ali,
    seja qual for o embaralhamento (só do baralho, às vezes sobram três). */
const forests = (n: number): Card[] =>
  [...j().mao, ...j().baralho].filter((c: Card) => c.card.nome === "Forest").slice(0, n);
const fieldOrder = () => j().campo.map((c: Card) => c.uid).join(",");

beforeEach(async () => {
  p = await freshPage();
  p.state.commanders = clone([ATRAXA]);
  p.state.cards = clone(DECK);
  p.state.maybe = clone(MAYBE);
  p.state.name = "Meu deck";
});
afterEach(cleanup);

describe("o baralho é o deck certo", () => {
  it("as cartas contadas menos o comandante, sem sideboard nem maybeboard", () => {
    table();
    expect(j().baralho.length + j().mao.length).toBe(IN_LIBRARY);
    for (const nome of ["Atraxa", "Swords to Plowshares", "Lightning Bolt"]) {
      expect(j().baralho.filter((c: Card) => c.card.nome === nome)).toHaveLength(0);
    }
    expect(j().comando.map((c: Card) => c.card.nome)).toEqual(["Atraxa"]);
    expect(j().comando[0].commander).toBe(true);
  });

  it("cada cópia tem identidade própria", () => {
    table();
    const cards = [...j().baralho, ...j().mao];
    expect(new Set(cards.map((c: Card) => c.uid)).size).toBe(IN_LIBRARY);
    const fs = cards.filter((c: Card) => c.card.nome === "Forest");
    fs[0].tapped = true;
    expect(fs.filter((c: Card) => c.tapped)).toHaveLength(1);
  });

  it("embaralhar é permutação", () => {
    // Fisher-Yates escrito errado perde ou duplica elemento em silêncio.
    table();
    const before = all().join(",");
    p.shuffleLibrary(0);
    expect(all().join(",")).toBe(before);
  });
});

describe("mão de abertura e mulligan London (o primeiro é grátis)", () => {
  it("compra 7 e começa no mulligan, turno 1, primeiro jogador", () => {
    table();
    expect([j().mao.length, j().baralho.length, j().phase]).toEqual([7, IN_LIBRARY - 7, "mulligan"]);
    expect([p.state.table.turn, p.state.table.active]).toEqual([1, 0]);
  });

  it("manter sem mulligan: 8 na mão (a do turno 1), nada pro fundo, direto pro jogo", () => {
    table(); p.keepHand(0);
    expect([j().mao.length, j().toBottom, j().phase]).toEqual([8, 0, "jogo"]);
  });

  it("1 mulligan não custa; 2 devolvem 1; 3 devolvem 2", () => {
    table(); p.londonMulligan(0); p.keepHand(0);
    expect([j().mao.length, j().toBottom]).toEqual([8, 0]);
    table(); p.londonMulligan(0); p.londonMulligan(0); p.keepHand(0);
    expect([j().mao.length, j().toBottom, j().phase]).toEqual([7, 1, "fundo"]);
    table(); p.londonMulligan(0); p.londonMulligan(0); p.londonMulligan(0); p.keepHand(0);
    expect(j().toBottom).toBe(2);
  });

  it("as escolhidas vão pro FUNDO, e a mão fica com 6 — 5 mais a do turno 1", () => {
    table(); p.londonMulligan(0); p.londonMulligan(0); p.londonMulligan(0); p.keepHand(0);
    p.putOnBottom(j().mao[0].uid);
    const chosen = j().mao[0].uid;
    p.putOnBottom(chosen);
    expect([j().mao.length, j().phase]).toEqual([6, "jogo"]);
    expect(j().baralho.at(-1).uid).toBe(chosen);
  });

  it("cada mulligan reembaralha tudo, e nunca pede pro fundo mais do que a mão tem", () => {
    table(); p.londonMulligan(0);
    expect(j().baralho.length + j().mao.length).toBe(IN_LIBRARY);
    // Deck pequeno: pedir mais do que a mão tem deixaria a fase sem fim.
    for (let i = 0; i < 12; i++) p.londonMulligan(0);
    j().mao = j().mao.slice(0, 3);
    p.keepHand(0);
    expect([j().toBottom, j().mao.length]).toEqual([3, 3]);
  });
});

describe("a compra do turno 1 (regra do Commander)", () => {
  it("vem ao confirmar a mão, sai do baralho e é uma só", () => {
    table(); p.keepHand(0);
    expect([j().mao.length, j().baralho.length]).toEqual([8, IN_LIBRARY - 8]);
    p.passTurn();
    expect(j().mao.length).toBe(9);
  });

  it("vem DEPOIS das que voltam pro fundo", () => {
    table(); p.londonMulligan(0); p.londonMulligan(0); p.keepHand(0);
    const returned = j().mao[0].uid;
    p.putOnBottom(returned);
    expect([j().mao.length, j().mao.filter((c: Card) => c.uid === returned).length]).toEqual([7, 0]);
  });
});

describe("turnos", () => {
  it("passar turno compra 1, anda o turno, endireita e zera os terrenos", () => {
    table(); p.keepHand(0);
    const before = j().mao.length;
    p.moveToZone(j().mao[0].uid, "campo");
    j().campo[0].tapped = true;
    j().landsThisTurn = 3;
    p.passTurn();
    expect([p.state.table.turn, j().mao.length - (before - 1)]).toEqual([2, 1]);
    expect(j().campo[0].tapped).toBe(false);
    expect(j().landsThisTurn).toBe(0);
  });

  it("dois terrenos no mesmo turno: conta, não impede", () => {
    table(); p.keepHand(0);
    const two = forests(2);
    two.forEach((c) => p.moveToZone(c.uid, "mao"));
    two.forEach((c) => p.moveToZone(c.uid, "campo"));
    expect([j().landsThisTurn, j().campo.length]).toEqual([2, 2]);
  });
});

describe("dois decks na mesa", () => {
  it("o segundo entra com a mão dele, sem mexer no primeiro", () => {
    table(); p.keepHand(0);
    const before = j(0).mao.length;
    p.addSecondDeck(deck2());
    expect([p.state.table.players.length, j(1).mao.length, j(1).phase, j(0).mao.length === before])
      .toEqual([2, 7, "mulligan", true]);
  });

  it("quem mantém fora da vez fica com 7 e compra quando a vez chega", () => {
    // Comprar fora da vez adiantaria a compra de um turno que não chegou.
    table(); p.keepHand(0); p.addSecondDeck(deck2()); p.keepHand(1);
    expect([j(1).mao.length, j(1).baralho.length, j(1).phase]).toEqual([7, IN_LIBRARY2 - 7, "jogo"]);
    p.passTurn();
    expect(j(1).mao.length).toBe(8);
  });

  it("a vez que chega no meio do mulligan não compra; a compra vem ao manter", () => {
    table(); p.keepHand(0); p.addSecondDeck(deck2());
    p.passTurn();
    const atMulligan = j(1).mao.length;
    p.keepHand(1);
    expect([atMulligan, j(1).mao.length]).toEqual([7, 8]);

    table(); p.addSecondDeck(deck2());
    p.passTurn(); p.londonMulligan(1); p.keepHand(1);
    expect(j(1).mao.length).toBe(8);
  });

  it("cada deck com as artes dele, e elas voltam com o desfazer, fora da foto", () => {
    table();
    const d = { ...deck2(), id: "d2", choices: { krenko: { frente: { arte_id: "abc" } } } };
    p.addSecondDeck(d);
    expect([p.playerArts(0) === null, p.playerArts(1).krenko.frente.arte_id]).toEqual([true, "abc"]);
    p.saveTableSnapshot();
    p.removeSecondDeck();
    const inPhoto = p.state.tableUndo[0].indexOf("abc") >= 0;
    p.undoTableStep();
    expect([inPhoto, p.playerArts(1).krenko.frente.arte_id]).toEqual([false, "abc"]);
  });

  it("cada um com o seu contador de mulligan", () => {
    table(); p.addSecondDeck(deck2());
    p.londonMulligan(1); p.londonMulligan(1);
    expect([j(0).mulligans, j(1).mulligans, p.bottomCountOnKeep(0), p.bottomCountOnKeep(1)]).toEqual([0, 2, 0, 1]);
  });

  it("a vez alterna, e o turno só anda quando volta pro primeiro", () => {
    table(); p.addSecondDeck(deck2());
    const steps = [];
    for (let i = 0; i < 4; i++) {
      p.passTurn();
      steps.push(`${p.state.table.turn}:${p.state.table.active}`);
    }
    expect(steps.join(" ")).toBe("1:1 2:0 2:1 3:0");
  });

  it("passar turno endireita só quem está jogando", () => {
    table(); p.keepHand(0); p.addSecondDeck(deck2()); p.keepHand(1);
    p.moveToZone(j(0).mao[0].uid, "campo"); j(0).campo[0].tapped = true;
    p.moveToZone(j(1).mao[0].uid, "campo"); j(1).campo[0].tapped = true;
    p.passTurn();   // vez do segundo
    expect([j(0).campo[0].tapped, j(1).campo[0].tapped]).toEqual([true, false]);
  });

  it("a carta volta pra zona do dono, não de quem a moveu", () => {
    table(); p.keepHand(0); p.addSecondDeck(deck2()); p.keepHand(1);
    const theirs = j(1).mao[0].uid;
    p.moveToZone(theirs, "campo");
    p.moveToZone(theirs, "cemiterio");
    expect([j(0).cemiterio.length, j(1).cemiterio.length]).toEqual([0, 1]);
  });

  it("tirar o segundo deck devolve a mesa pra um jogador", () => {
    table(); p.addSecondDeck(deck2()); p.passTurn();
    p.removeSecondDeck();
    expect([p.state.table.players.length, p.state.table.active]).toEqual([1, 0]);
  });

  it("a resposta do servidor vira deck sem o sideboard", () => {
    const d = p.deckFromResponse({ deck: { nome: "Do servidor", comandantes_completos: [KRENKO],
      cartas_completas: [{ carta: MOUNTAIN, quantidade: 3, categoria: "" },
                         { carta: BOLT, quantidade: 2, categoria: "Sideboard" },
                         { carta: null, quantidade: 9, categoria: "" }] } });
    expect([d.name, d.commanders.length, d.entries.length, d.entries[0].quantidade])
      .toEqual(["Do servidor", 1, 1, 3]);
  });
});

describe("resumo da mão", () => {
  it("terrenos, média do que não é terreno e as cores pedidas", () => {
    // Terreno fica fora da média: custa zero e puxaria o número pra baixo.
    const r = p.handSummary([{ card: FOREST }, { card: FOREST }, { card: SOL_RING }, { card: ELVES }]);
    expect([r.lands, r.spells, r.averageCost, r.colors.G || 0, r.colors.W || 0]).toEqual([2, 2, 1, 1, 0]);
    const lands = p.handSummary([{ card: FOREST }]);
    expect([lands.lands, lands.spells, lands.averageCost]).toEqual([1, 0, 0]);
    const hybrid = p.handSummary([{ card: FINKS }]);
    expect([hybrid.colors.G || 0, hybrid.colors.W || 0]).toEqual([1, 1]);
  });
});

describe("o campo em três filas", () => {
  it("terreno-criatura é terreno; o resto cai em Outros", () => {
    expect(p.fieldRow({ card: { tipo: "Land Creature — Dryad Arbor" } })).toBe("Terrenos");
    expect(p.fieldRow({ card: ELVES })).toBe("Criaturas");
    expect(p.fieldRow({ card: SOL_RING })).toBe("Outros");
    expect(p.fieldRow({ card: null })).toBe("Outros");
  });
});

describe("arrumar o campo", () => {
  it("a carta entra no fim da fila, e reposicionar põe antes ou depois", () => {
    table(); p.keepHand(0);
    const two = forests(2);
    p.moveToZone(two[0].uid, "campo"); p.moveToZone(two[1].uid, "campo");
    expect(fieldOrder()).toBe([two[0].uid, two[1].uid].join(","));

    table(); p.keepHand(0);
    let f = forests(3);
    f.forEach((c) => p.moveToZone(c.uid, "campo"));
    p.reposition(f[2].uid, f[0].uid, false);
    expect(fieldOrder()).toBe([f[2].uid, f[0].uid, f[1].uid].join(","));

    table(); p.keepHand(0);
    f = forests(3);
    f.forEach((c) => p.moveToZone(c.uid, "campo"));
    p.reposition(f[0].uid, f[2].uid, true);
    expect(fieldOrder()).toBe([f[1].uid, f[2].uid, f[0].uid].join(","));
  });

  it("não troca carta de fila nem de jogador", () => {
    table(); p.keepHand(0);
    const forest = forests(1)[0];
    const elf = find("Llanowar Elves").find((c) => !j().campo.includes(c))!;
    p.moveToZone(forest.uid, "campo"); p.moveToZone(elf.uid, "campo");
    const before = fieldOrder();
    expect([p.fitsInRow(forest.uid, elf.uid), p.reposition(forest.uid, elf.uid, false),
            fieldOrder() === before]).toEqual([false, false, true]);

    table(); p.keepHand(0); p.addSecondDeck(deck2()); p.keepHand(1);
    const mine = forests(1)[0];
    const theirs = find("Mountain", 1)[0];
    p.moveToZone(mine.uid, "campo"); p.moveToZone(theirs.uid, "campo");
    expect([p.fitsInRow(theirs.uid, mine.uid), p.reposition(theirs.uid, mine.uid, false)]).toEqual([false, false]);
  });

  it("a carta da mão pode encaixar, mas só se move pro lugar depois de descer", () => {
    table(); p.keepHand(0);
    const f = forests(2);
    p.moveToZone(f[0].uid, "campo");
    p.moveToZone(f[1].uid, "mao");
    const fits = p.fitsInRow(f[1].uid, f[0].uid);
    const beforeLanding = p.reposition(f[1].uid, f[0].uid, false);
    p.moveToZone(f[1].uid, "campo");
    p.reposition(f[1].uid, f[0].uid, false);
    expect([fits, beforeLanding, fieldOrder() === [f[1].uid, f[0].uid].join(",")]).toEqual([true, false, true]);
  });

  it("arrumar não perde nem duplica carta", () => {
    table(); p.keepHand(0);
    const before = all().join(",");
    const f = forests(4);
    expect(f).toHaveLength(4);
    f.forEach((c) => p.moveToZone(c.uid, "campo"));
    p.reposition(f[3].uid, f[0].uid, false);
    p.reposition(f[0].uid, f[3].uid, true);
    p.reposition(f[1].uid, f[1].uid, true);
    expect(all().join(",")).toBe(before);
  });
});

describe("vida, marcadores e dano de comandante", () => {
  it("a vida começa em 40, e os botões somam e subtraem", () => {
    table();
    expect(j().life).toBe(40);
    p.adjustLife(0, -5); p.adjustLife(0, 1);
    expect(j().life).toBe(36);
  });

  it("marcador de jogador sobe, desce, some no zero e nunca fica negativo", () => {
    table();
    p.adjustPlayerCounter(0, "veneno", 3);
    const three = j().counters.veneno;
    p.adjustPlayerCounter(0, "veneno", -3);
    expect([three, Object.keys(j().counters).length]).toEqual([3, 0]);
    p.adjustPlayerCounter(0, "energia", 1); p.adjustPlayerCounter(0, "energia", -5);
    expect(Object.keys(j().counters)).toHaveLength(0);
  });

  it("marcador de carta mora na carta e some quando ela sai do campo", () => {
    table(); p.keepHand(0);
    const uid = j().mao[0].uid;
    p.moveToZone(uid, "campo");
    p.adjustCardCounter(uid, "+1/+1", 2);
    expect(p.cardByUid(uid).counters["+1/+1"]).toBe(2);
    p.moveToZone(uid, "cemiterio");
    expect(Object.keys(p.cardByUid(uid).counters)).toHaveLength(0);
  });

  it("dano de comandante é contado por origem", () => {
    table(); p.addSecondDeck(deck2());
    p.adjustCommanderDamage(0, 1, 7); p.adjustCommanderDamage(0, 1, 7);
    expect([j(0).commanderDamage[1], j(0).commanderDamage[0]]).toEqual([14, 0]);
  });
});

describe("fichas", () => {
  it("nasce no campo e deixa de existir ao sair dele", () => {
    // Um cemitério com três Soldados mentiria sobre o que dá pra devolver.
    table(); p.keepHand(0);
    p.createToken(0, { nome: "Soldado", poder: "1", resistencia: "1", cores: ["W"] }, 3);
    expect([j().campo.length, j().campo[0].card.nome, j().campo[0].token]).toEqual([3, "Soldado", true]);
    const before = all().length;
    p.moveToZone(j().campo[0].uid, "cemiterio");
    expect([before, all().length, j().cemiterio.length]).toEqual([IN_LIBRARY + 4, IN_LIBRARY + 3, 0]);
  });

  it("não entra na conta do resumo do fim", () => {
    table(); p.keepHand(0);
    p.createToken(0, { nome: "Soldado" }, 2);
    expect(p.gameSummary()[0].spellsInDeck).toBe(IN_LIBRARY - 10);   // menos as florestas
  });
});

describe("carta de duas faces", () => {
  it("vira, desvira, e volta pra frente ao sair do campo", () => {
    table(); p.keepHand(0);
    j().campo.push({ uid: 999, owner: 0, card: clone(DFC), backUp: false, counters: {} });
    p.toggleFace(999);
    const flipped = p.cardByUid(999).backUp;
    p.toggleFace(999);
    expect([flipped, p.cardByUid(999).backUp]).toEqual([true, false]);
    p.toggleFace(999);
    p.moveToZone(999, "mao");
    expect(p.cardByUid(999).backUp).toBe(false);
  });

  it("carta sem verso de papel não vira", () => {
    table(); p.keepHand(0);
    const uid = find("Forest")[0].uid;
    p.moveToZone(uid, "campo"); p.toggleFace(uid);
    expect(p.cardByUid(uid).backUp).toBe(false);
  });
});

describe("combate", () => {
  it("atacar e bloquear são marcas; bloquear de novo desmarca; o turno limpa", () => {
    table(); p.keepHand(0); p.addSecondDeck(deck2()); p.keepHand(1);
    const mine = j(0).mao[0].uid, theirs = j(1).mao[0].uid;
    p.moveToZone(mine, "campo"); p.moveToZone(theirs, "campo");
    p.toggleAttack(mine);
    p.setBlock(theirs, mine);
    expect([p.cardByUid(mine).attacking, p.cardByUid(theirs).blocking === mine, p.attackers().length])
      .toEqual([true, true, 1]);
    p.setBlock(theirs, mine);
    expect(p.cardByUid(theirs).blocking).toBeNull();
    p.passTurn();
    expect([p.cardByUid(mine).attacking, p.attackers().length]).toEqual([false, 0]);
  });
});

describe("conservação: nenhuma carta some nem duplica", () => {
  it("do mulligan ao cemitério, com dois decks, o multiconjunto não muda", () => {
    table();
    p.addSecondDeck(deck2());
    const initial = all();
    p.londonMulligan(0); p.londonMulligan(0); p.londonMulligan(0);
    p.keepHand(0);
    p.putOnBottom(j(0).mao[0].uid);
    p.putOnBottom(j(0).mao[0].uid);
    p.keepHand(1);
    p.adjustLife(0, -7);
    p.passTurn();
    p.moveToZone(j(1).mao[0].uid, "campo");
    p.passTurn();
    p.moveToZone(j(0).mao[0].uid, "campo");
    p.moveToZone(j(0).campo[0].uid, "cemiterio");
    p.moveToZone(j(1).mao[0].uid, "exilio");
    p.passTurn();
    p.castCommander(j(0).comando[0].uid);
    expect(all()).toEqual(initial);
    expect(all()).toHaveLength(IN_LIBRARY + IN_LIBRARY2 + 2);
  });

  it("mover nunca deixa um uid em duas zonas, nem perde carta pra zona inventada", () => {
    table(); p.keepHand(0);
    const uid = j().mao[0].uid;
    p.moveToZone(uid, "campo"); p.moveToZone(uid, "cemiterio"); p.moveToZone(uid, "mao");
    expect(all().filter((x: string) => x.startsWith(uid + ":"))).toHaveLength(1);
    p.moveToZone(j().mao[0].uid, "limbo");
    expect(all()).toHaveLength(IN_LIBRARY + 1);
  });

  it("o imposto do comandante conta, e não cobra", () => {
    table(); p.keepHand(0);
    p.castCommander(j().comando[0].uid);
    p.moveToZone(j().campo[0].uid, "comando");
    p.castCommander(j().comando[0].uid);
    expect([j().taxPaid, j().campo.length, j().commanderTurn]).toEqual([2, 1, 1]);
  });
});

describe("desfazer", () => {
  it("devolve a carta pra mão, inteira, e a foto não leva as cartas", () => {
    table(); p.keepHand(0);
    p.saveTableSnapshot();
    p.moveToZone(j().mao[0].uid, "cemiterio");
    p.undoTableStep();
    expect([j().mao.length, j().cemiterio.length]).toEqual([8, 0]);

    p.saveTableSnapshot();
    p.moveToZone(j().mao[0].uid, "exilio");
    p.undoTableStep();
    expect(j().mao.filter((c: Card) => c.card?.nome)).toHaveLength(8);

    table(); p.saveTableSnapshot();
    expect(p.state.tableUndo.at(-1).indexOf("Llanowar Elves")).toBe(-1);
  });

  it("pilha vazia não quebra, e a pilha tem teto", () => {
    table(); p.state.tableUndo = []; p.undoTableStep();
    expect(p.state.table).not.toBeNull();
    for (let i = 0; i < 40; i++) p.saveTableSnapshot();
    expect(p.state.tableUndo).toHaveLength(20);
  });

  it("cliques seguidos do mesmo gesto são UM passo de desfazer", () => {
    // Sete cliques pra ir de 40 a 33 não podem comer sete das vinte fotos.
    table(); p.keepHand(0);
    p.state.tableUndo = [];
    for (let i = 0; i < 3; i++) { p.saveTableSnapshot("vida0"); p.adjustLife(0, -1); }
    expect([p.state.tableUndo.length, j().life]).toEqual([1, 37]);
    p.undoTableStep();
    expect(j().life).toBe(40);

    p.state.tableUndo = [];
    p.saveTableSnapshot("vida0"); p.adjustLife(0, -1);
    p.saveTableSnapshot(); p.draw(0, 1);
    p.saveTableSnapshot("vida0"); p.adjustLife(0, -1);
    expect(p.state.tableUndo).toHaveLength(3);
  });
});

describe("log e resumo do fim", () => {
  it("o log anota as jogadas com o turno em que aconteceram", () => {
    table(); p.keepHand(0); p.passTurn();
    expect([p.state.table.log.length > 2, p.state.table.log.at(-1).turn]).toEqual([true, 2]);
  });

  it("em que turno o comandante desceu, ou 'nunca'", () => {
    table(); p.keepHand(0);
    expect(p.gameSummary()[0].commanderTurn).toBeNull();
    p.passTurn(); p.passTurn();
    p.castCommander(j().comando[0].uid);
    expect(p.gameSummary()[0].commanderTurn).toBe(3);
  });

  it("curva teórica, realizada e o que ficou no baralho", () => {
    table(); p.keepHand(0);
    const r0 = p.gameSummary()[0];
    // 1 Sol Ring + 4 Elves, todos de custo 1.
    expect([r0.deckCurve[1], r0.spellsInDeck, r0.deckCurve[0]]).toEqual([5, 5, 0]);
    expect([r0.neverDrawn, r0.remaining.length]).toEqual([IN_LIBRARY - 8, IN_LIBRARY - 8]);
    p.moveToZone(find("Llanowar Elves")[0].uid, "campo");
    p.moveToZone(find("Forest")[0].uid, "campo");
    const r = p.gameSummary()[0];
    expect([r.playedCurve[1], r.spellsPlayed, r.landsPlayed]).toEqual([1, 1, 1]);
  });
});

it("a mesa não vaza pro deck salvo", () => {
  // Uma mão de goldfish gravada no deck voltaria três semanas depois, em
  // outra máquina, no meio de uma edição.
  table(); p.keepHand(0); p.passTurn();
  expect(Object.keys(p.deckBody()).sort()).toEqual(["cartas", "categorias", "comandantes", "maybeboard", "nome"]);
});

describe("deck vazio não quebra", () => {
  it("sem cartas a mesa monta; entrada sem carta na base é ignorada", () => {
    p.state.cards = []; p.state.commanders = [];
    table();
    expect([j().baralho.length, j().mao.length]).toEqual([0, 0]);
    p.state.cards = [{ carta: null, quantidade: 3, categoria: "" },
                       { carta: clone(SOL_RING), quantidade: 2, categoria: "" }];
    table();
    expect(j().baralho.length + j().mao.length).toBe(2);
  });
});

describe("os combos na mesa", () => {
  // Dois combos que se cruzam no Sol Ring: um com uma peça que o baralho tem
  // (Llanowar Elves) e outro com uma que ele não tem (Kitchen Finks).
  const COMBOS = { no_deck: [
    { pecas: [{ nome: "Sol Ring", no_deck: true }, { nome: "Llanowar Elves", no_deck: true }],
      requer: [], produz: ["Mana infinita"], mana: "{1}", prerequisitos: "Sol Ring desvirado", faltam: [] },
    { pecas: [{ nome: "Sol Ring", no_deck: true }, { nome: "Kitchen Finks", no_deck: true }],
      requer: ["uma criatura com vigilância"], produz: ["Vida infinita"], mana: "", prerequisitos: "", faltam: [] },
  ] };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it("sem busca, nenhuma marca — 'não perguntei' não é 'não tem'", () => {
    table(); p.state.combos = null;
    expect(sum(j().baralho.map(p.comboCount))).toBe(0);
  });

  it("a peça sabe de quantos combos ela é; o resto não ganha selo", () => {
    table(); p.state.combos = clone(COMBOS);
    expect(p.comboCount(find("Sol Ring")[0])).toBe(2);
    expect(p.comboCount(find("Forest")[0])).toBe(0);
  });

  it("cada peça vem com a zona onde está, a mais adiantada vale", () => {
    table(); p.state.combos = clone(COMBOS);
    const sol = find("Sol Ring")[0];
    p.moveToZone(sol.uid, "campo");
    find("Llanowar Elves").forEach((c) => p.moveToZone(c.uid, "mao"));
    expect(p.combosOf(sol)[0].pecas.map((x: any) => `${x.nome}:${x.zona}`))
      .toEqual(["Sol Ring:campo", "Llanowar Elves:mao"]);
    // Um Elfo no campo e três no cemitério é "no campo".
    const elves = find("Llanowar Elves");
    elves.forEach((c) => p.moveToZone(c.uid, "cemiterio"));
    p.moveToZone(elves[0].uid, "campo");
    expect(p.combosOf(find("Sol Ring")[0])[0].pecas[1].zona).toBe("campo");
  });

  it("peça que não está na mesa não ganha zona inventada", () => {
    table(); p.state.combos = clone(COMBOS);
    const found = p.combosOf(find("Sol Ring")[0]).filter((a: any) => a.combo.produz[0] === "Vida infinita");
    expect(found[0].pecas[1].zona).toBeNull();
  });

  it("o combo mais adiantado vem primeiro", () => {
    table(); p.state.combos = clone(COMBOS);
    const sol = find("Sol Ring")[0];
    p.moveToZone(sol.uid, "campo");
    p.moveToZone(find("Llanowar Elves")[0].uid, "campo");
    expect(p.combosOf(sol).map((a: any) => a.combo.produz[0])).toEqual(["Mana infinita", "Vida infinita"]);
  });

  it("ficha não é peça, e o segundo deck nunca foi perguntado", () => {
    table(); p.state.combos = clone(COMBOS);
    p.createToken(0, { nome: "Sol Ring", tipo: "Token Artifact" }, 1);
    expect(p.comboCount(j().campo.find((c: Card) => c.token))).toBe(0);
    p.addSecondDeck(deck2());
    expect(sum(j(1).baralho.map(p.comboCount))).toBe(0);
  });
});
