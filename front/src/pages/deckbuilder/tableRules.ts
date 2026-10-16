/* =========================================================================
   GOLDFISH — as regras da mesa

   Embaralhar o deck e jogar sozinho, pra ver se a mão anda. É o que "goldfish"
   quer dizer na mesa: jogar contra um peixinho dourado, que não faz nada. Com
   um segundo deck posto na mesa, o peixinho ganha cartas — e continua sendo
   você dos dois lados.

   NÃO É MOTOR DE REGRAS, E ISSO É O RECURSO. Nada aqui impede nada: dá pra
   baixar dois terrenos no mesmo turno, jogar uma carta de 8 manas no turno 1 e
   mandar qualquer coisa pra qualquer zona. Quem julga é quem está jogando.
   A alternativa — validar custo, tipo e timing — é escrever um motor de Magic,
   que é um projeto inteiro, e que erraria em casos que a pessoa conhece melhor
   do que ele.

   Cinco consequências desenhadas de propósito:

   * A MANA NÃO É SOMADA. A tela mostra quantos terrenos estão em pé e quantos
     deitados, que é um fato do tabuleiro. No instante em que aparecesse "3 de
     mana disponível", a pessoa passaria a esperar que o número a impedisse de
     fazer coisa errada — e aí é motor de regras pela porta dos fundos.
   * O "terreno baixado neste turno" CONTA, não impede. Vira informação, não
     trava.
   * A VIDA E OS MARCADORES SÃO NÚMEROS QUE SE AJUSTAM, não contas. Ninguém
     aqui sabe quanto uma criatura bate.
   * O COMBATE É UMA MARCAÇÃO. Atacante e bloqueador ficam desenhados na carta;
     o dano quem aplica é quem joga, nos botões de vida.
   * O COMANDANTE VAI PRA ZONA DE COMANDO, não pro baralho. Sem isso o goldfish
     estaria testando um deck de 99 cartas que ninguém joga. O imposto aparece
     como número; pagar ou não é decisão de quem joga.

   O que ele SABE são as regras do formato que mudam a mão: o primeiro mulligan
   é grátis e quem começa jogando compra no turno 1. E sabe ONDE estão as peças
   dos combos que a aba de combos já buscou — onde, não se dá pra fazer, que é
   outra vez a mesma fronteira (ver "os combos na mesa", mais abaixo).

   OS JOGADORES SÃO UMA LISTA, de um ou de dois. Mesmo com um só: um jogador
   solto mais um "segundo" opcional faria toda ação existir em duas versões, e
   é justamente aí que uma delas deixa de acompanhar a outra.

   CADA CARTA TEM DONO, e toda zona é do dono. Matar a criatura do outro manda
   ela pro cemitério DELE, que é o que acontece na mesa — e é o que faz a lista
   de zonas continuar fechando por jogador.

   NADA DISSO É SALVO. `deckBody` não sabe que `state.table` existe: uma mão
   de goldfish gravada no deck é uma mão que volta três semanas depois, em outra
   máquina, no meio de uma edição.

   ESTE MÓDULO NÃO CONHECE A TELA. Nada aqui importa `state`: a mesa entra
   como argumento e toda jogada é uma AÇÃO — um objeto simples, que vira JSON
   sem perder nada (`apply(mesa, ação)`). É o que deixa a mesma regra rodar no
   navegador, num teste sem DOM e, numa mesa com mais de uma pessoa, no
   servidor que guarda a partida: quem joga manda a ação, e não o resultado
   dela. O que é da tela (o desfazer, os combos, o resumo) mora em
   `goldfish.ts`.

   A SORTE TAMBÉM ENTRA COMO ARGUMENTO (`random`). Na mesa de uma pessoa é o
   `Math.random`; numa mesa compartilhada, só quem guarda a partida embaralha,
   senão cada navegador teria um baralho diferente.

   As zonas (`baralho`, `mao`, `campo`…) continuam com os nomes em português:
   elas são também as classes do CSS (`gf-baralho`, `z-campo`) e os valores
   de `data-gf-solta`, e o vocabulário da tela é um só.
   ========================================================================= */
import type { Card } from "./types";

/* ---------------------------------------------------------------- tipos */

export type Zone = "baralho" | "mao" | "campo" | "cemiterio" | "exilio" | "comando";

/** Uma cópia na mesa. A carta em si (`card`) volta do registro no desfazer. */
export interface TableCard {
  uid: number;
  owner: number;
  card: Card | null;
  faceDown: boolean;
  tapped: boolean;
  backUp: boolean;
  counters: Record<string, number>;
  attacking: boolean;
  blocking: number | null;
  token: boolean;
  commander: boolean;
}

export interface Player extends Record<Zone, TableCard[]> {
  name: string;
  index: number;
  deck: string | null;
  life: number;
  counters: Record<string, number>;
  commanderDamage: number[];
  mulligans: number;
  toBottom: number;
  phase: "mulligan" | "fundo" | "jogo";
  landsThisTurn: number;
  taxPaid: number;
  commanderTurn: number | null;
  plays: { name: string; cmc: number; land: boolean; turn: number }[];
}

export interface Table {
  players: Player[];
  active: number;
  turn: number;
  log: { turn: number; text: string }[];
  logOpen: boolean;
  /* O que não muda durante a partida e por isso não entra na foto do
     desfazer (ver `saveTableSnapshot`): o próximo `uid`, a carta de cada
     `uid` e as artes escolhidas dos decks que vieram de fora da tela.

     A carta mora no registro além de na cópia porque ela nunca muda: o que
     muda é o estado da cópia (deitada, virada, marcas, zona). Uma mesa de
     dois decks tem 200 cartas completas, e guardar as vinte últimas jogadas
     com elas dentro é alguns megabytes de JSON reescritos a cada clique.

     As artes vão pelo id do deck, e não pela posição do jogador, porque o
     desfazer pode trazer de volta um segundo deck que já saiu da mesa depois
     de outro ter entrado no lugar dele. O deck da tela não entra: as escolhas
     dele são as da aba Artes, lidas na hora do desenho, e uma arte trocada no
     meio da partida aparece na mesa. */
  nextUid: number;
  cards: Record<number, Card>;
  arts: Record<string, Record<string, unknown>>;
}

/** Um deck pra mesa: o da tela, ou um que veio de `GET /decks/{id}`. */
export interface TableDeck {
  id?: string | null;
  choices?: Record<string, unknown>;
  name: string;
  commanders: Card[];
  entries: { carta: Card | null; quantidade: number; categoria?: string }[];
}

/* O deck como `GET /decks/{id}` o devolve, virado deck de mesa. A regra do
   que conta é a do servidor e a da tela ao mesmo tempo — as categorias fora
   da conta (`outOfCount`) são as mesmas dos dois lados, e quem chama diz
   quais são, porque a lista mora na tela (`OUT_OF_COUNT`).

   `choices` são as artes escolhidas nele (`GET /decks/{id}/artes`): o deck
   da tela usa as da aba Artes, e este traz as suas. */
export function tableDeckFrom(
  response: { deck?: any }, outOfCount: ReadonlySet<string>,
  id?: string, choices?: Record<string, unknown>,
): TableDeck {
  const deck = response.deck || {};
  return {
    id: id || null,
    choices: choices || {},
    name: deck.nome || "Deck sem nome",
    commanders: (deck.comandantes_completos || []).filter(Boolean),
    entries: ((deck.cartas_completas || []) as TableDeck["entries"]).filter(
      (e) => e.carta && !outOfCount.has(e.categoria || "")),
  };
}

export type TokenModel = {
  nome?: string; tipo?: string; cores?: string[]; poder?: string; resistencia?: string;
  imagem?: string; chaveArte?: string;
};

/* As jogadas. Cada uma é o PEDIDO, e não o resultado: "mover a carta 12 pro
   cemitério", e não a mesa depois disso. Quem decide o resultado é `apply`, e
   é isso que permite uma mesa compartilhada ter um lugar só onde a jogada
   acontece. */
export type Action =
  | { type: "join"; deck: TableDeck }
  | { type: "leave" }
  | { type: "shuffle"; player: number; keepTop?: number[] }
  | { type: "draw"; player: number; n: number }
  | { type: "mill"; player: number; n: number; to: "cemiterio" | "exilio" }
  | { type: "mulligan"; player: number }
  | { type: "keep"; player: number }
  | { type: "bottom"; uid: number }
  | { type: "pass" }
  | { type: "move"; uid: number; to: Zone; toTop?: boolean; faceDown?: boolean }
  | { type: "arrange"; uid: number; target: number; after: boolean }
  | { type: "cast"; uid: number }
  | { type: "life"; player: number; n: number }
  | { type: "playerCounter"; player: number; name: string; n: number }
  | { type: "cardCounter"; uid: number; name: string; n: number }
  | { type: "commanderDamage"; player: number; from: number; n: number }
  | { type: "tap"; uid: number }
  | { type: "faceDown"; uid: number }
  | { type: "flip"; uid: number }
  | { type: "attack"; uid: number }
  | { type: "block"; uid: number; target: number }
  | { type: "endCombat" }
  | { type: "untapAll"; player: number }
  | { type: "attackAll"; player: number }
  | { type: "token"; player: number; model: TokenModel; count: number | string };

export type Random = () => number;

/* Uma mesa de Commander. O limite é da mesa, não da tela: a tela local
   oferece um segundo deck só, e uma mesa compartilhada senta até quatro. */
export const MAX_PLAYERS = 4;

const OPENING_HAND = 7;
const STARTING_LIFE = 40;
const LOG_LIMIT = 200;

/* As zonas de um jogador. A ordem é a da varredura, e ela não é arbitrária: a
   mão e o campo vêm antes porque são onde quase toda carta procurada está. */
export const ZONES: Zone[] = ["mao", "campo", "baralho", "cemiterio", "exilio", "comando"];
export const ZONE_NAMES: Record<Zone, string> = {
  baralho: "Baralho", mao: "Mão", campo: "Campo",
  cemiterio: "Cemitério", exilio: "Exílio", comando: "Comando",
};

/* As zonas que a mesa NÃO mostra: a mão é só do dono, e o baralho não é de
   ninguém — nem o dono sabe a ordem dele. Numa mesa compartilhada é o que a
   visão de cada um esconde (ver `room/src/view.ts`), e é também o que o log
   não pode contar, porque o log é um só pra mesa inteira. */
export const HIDDEN_ZONES: readonly Zone[] = ["mao", "baralho"];

export function cardName(c: TableCard | null | undefined) {
  return c?.card?.nome || "carta";
}

/* A carta que a mesa inteira está vendo nesta zona: fora das zonas
   escondidas e com a face pra cima. */
function shownIn(zone: Zone | undefined, c: TableCard) {
  return !!zone && !c.faceDown && !HIDDEN_ZONES.includes(zone);
}

/* O nome que vai pro LOG. O log é lido por todo mundo na mesa, então ele
   só nomeia a carta que a mesa está vendo: "deitou o Sol Ring" pode, "a mão
   devolveu um Sol Ring pro baralho" contaria o que a mão tem. */
function logName(t: Table, c: TableCard) {
  return shownIn(findCard(t, c.uid)?.zone, c) ? cardName(c) : "uma carta";
}

/* Cada carta na mesa é uma CÓPIA com identidade própria (`uid`), e não a
   entrada do deck. Três Florestas são três objetos: uma pode estar deitada e as
   outras não, e uma pode estar no cemitério enquanto as outras jogam. Copiar a
   referência da entrada faria deitar uma deitar as trinta — é o bug clássico
   deste tipo de tela. */
function makeCopy(t: Table, card: Card, owner: number, extra?: Partial<TableCard>): TableCard {
  const c: TableCard = {
    uid: t.nextUid++, owner: owner, card: card, faceDown: false, tapped: false, backUp: false,
    counters: {}, attacking: false, blocking: null, token: false, commander: false,
    ...extra,
  };
  t.cards[c.uid] = card;
  return c;
}

/* ------------------------------------------------------------- o baralho */

/* O `uid` nasce DEPOIS do embaralhamento. Numerar na ordem do deck e
   embaralhar depois faria o número dizer qual carta é — os dez primeiros são
   as Florestas —, e numa mesa compartilhada quem vê o `uid` de uma carta
   escondida saberia o que ela é. Numerada depois, o número só diz onde ela
   estava no baralho no começo, que ninguém viu. */
function libraryOf(t: Table, deck: TableDeck, owner: number, random: Random) {
  const commanders = new Set(deck.commanders.map((c) => (c.nome || "").toLowerCase()));
  const cards: Card[] = [];
  for (const entry of deck.entries) {
    const card = entry.carta;
    if (!card) continue;                       // carta que a base não conhece
    if (commanders.has((card.nome || "").toLowerCase())) continue;
    for (let i = 0; i < entry.quantidade; i++) cards.push(card);
  }
  return shuffle(cards, random).map((card) => makeCopy(t, card, owner));
}

/* Fisher-Yates, no lugar. Escrito à mão e não com `sort(() => Math.random()-.5)`
   de propósito: aquele não é embaralhamento — é uma comparação inconsistente,
   que a maioria das engines resolve com um resultado enviesado, e ninguém
   percebe olhando. */
function shuffle<T>(items: T[], random: Random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/* `keepTop` são as cartas que a busca escolheu pro topo: o tutor que diz
   "embaralhe e ponha a carta no topo" põe DEPOIS de embaralhar, e pôr antes
   seria embaralhar a escolha junto. Ficam na ordem em que vieram, a primeira
   em cima. Só vale carta deste baralho. */
function shuffleLibrary(t: Table, player: Player, random: Random, keepTop: number[] = []) {
  const kept = keepTop.map((uid) => player.baralho.find((c) => c.uid === uid))
    .filter((c, i, all): c is TableCard => !!c && all.indexOf(c) === i);
  shuffle(player.baralho, random);
  player.baralho = kept.concat(player.baralho.filter((c) => !kept.includes(c)));
  log(t, `${player.name}: baralho reembaralhado` + (kept.length ? `, ${kept.length} no topo` : ""));
}

/* --------------------------------------------------------------- a mesa */

function newPlayer(t: Table, deck: TableDeck, index: number, random: Random): Player {
  if (deck.id) t.arts[deck.id] = deck.choices || {};
  return {
    name: deck.name, index: index,
    deck: deck.id || null,     // de onde vêm as artes (ver `playerArts`)
    baralho: libraryOf(t, deck, index, random),
    mao: [], campo: [], cemiterio: [], exilio: [],
    comando: deck.commanders.map((c) => makeCopy(t, c, index, { commander: true })),
    life: STARTING_LIFE,
    counters: {},        // veneno, energia, experiência e o que mais for criado
    commanderDamage: Array(MAX_PLAYERS).fill(0),   // recebido, por jogador de origem
    mulligans: 0, toBottom: 0, phase: "mulligan",
    landsThisTurn: 0, taxPaid: 0,
    commanderTurn: null,   // pro resumo do fim
    plays: [],               // o que desceu pro campo, pra curva realizada
  };
}

/** Uma mesa nova, já embaralhada e com as mãos de abertura compradas. */
export function newTable(decks: TableDeck[], random: Random = Math.random): Table {
  const t: Table = {
    players: [], active: 0, turn: 1, log: [], logOpen: false,
    nextUid: 1, cards: {}, arts: {},
  };
  t.players = decks.map((d, i) => newPlayer(t, d, i, random));
  for (const player of t.players) drawFor(player, OPENING_HAND);
  log(t, decks.length > 1
    ? `Mesa embaralhada: ${decks.map((d) => d.name).join(" × ")}`
    : "Deck embaralhado");
  return t;
}

/* O deck novo entra na mesa que já está rolando, e não recomeça a partida:
   quem pede um oponente no meio de um goldfish quer ver a mão que está na tela
   contra alguma coisa, não jogar a mão fora. */
function addPlayer(t: Table, deck: TableDeck, random: Random) {
  if (t.players.length >= MAX_PLAYERS) return false;
  const player = newPlayer(t, deck, t.players.length, random);
  t.players.push(player);
  drawFor(player, OPENING_HAND);
  log(t, `${player.name} entrou na mesa`);
}

function removeSecondDeck(t: Table) {
  if (t.players.length < 2) return false;
  const gone = t.players.pop()!;
  t.active = 0;
  log(t, `${gone.name} saiu da mesa`);
}

function activePlayer(t: Table) {
  return t.players[t.active];
}

function drawFor(player: Player, n: number) {
  for (let i = 0; i < n && player.baralho.length; i++) player.mao.push(player.baralho.shift()!);
}

function draw(t: Table, player: Player, n: number) {
  const before = player.mao.length;
  drawFor(player, n);
  const drawn = player.mao.length - before;
  if (drawn) log(t, `${player.name}: comprou ${drawn}`);
  else log(t, `${player.name}: baralho vazio, nada a comprar`);
}

/* Moer: as N de cima do baralho, uma a uma, pro cemitério ou pro exílio. Uma
   a uma pelo mesmo `moveToZone` de todo o resto, pra o invariante das zonas
   ter um lugar só — e o log diz cada carta, que é o que a mesa viu cair. */
function mill(t: Table, player: Player, n: number, to: Zone) {
  if (to !== "cemiterio" && to !== "exilio") return false;
  const top = player.baralho.slice(0, n);
  if (!top.length) return false;
  for (const c of top) moveToZone(t, c.uid, to);
}

/* ------------------------------------------------------------- mulligan */

/* Mulligan London, com o PRIMEIRO GRÁTIS — que é a regra do Commander.

   Sempre se compram 7 cartas novas; o que muda é quantas voltam pro fundo ao
   manter: `mulligans - 1`. O primeiro mulligan sai de graça e a mão fica com 7;
   o segundo devolve 1, o terceiro 2. Cobrar já a primeira seria testar um deck
   de 60, não um de Commander — que é o formato deste deckbuilder inteiro.

   Cada jogador tem o seu contador: dois decks na mesa são duas decisões
   independentes, e um contador compartilhado cobraria de um o mulligan do
   outro. */
export function bottomCount(player: Player) {
  return Math.max(0, player.mulligans - 1);
}

function londonMulligan(t: Table, player: Player, random: Random) {
  player.mulligans++;
  player.baralho = shuffle(player.baralho.concat(player.mao), random);
  player.mao = [];
  player.toBottom = 0;
  drawFor(player, OPENING_HAND);
  log(t, `${player.name}: mulligan ${player.mulligans}`);
}

function keepHand(t: Table, player: Player) {
  // Nunca mais do que a mão tem: pedir pra devolver 3 de uma mão de 2 deixaria
  // a fase de fundo sem como terminar, e a mesa travada numa escolha
  // impossível. Só acontece em deck pequeno, que é justamente onde se testa.
  player.toBottom = Math.min(bottomCount(player), player.mao.length);
  // Com zero a devolver a tela pula direto pro jogo: pedir "escolha 0 cartas"
  // é uma etapa que só existe pra ser fechada.
  if (player.toBottom) player.phase = "fundo";
  else confirmHand(t, player);
}

function putOnBottom(t: Table, uid: number) {
  const found = findCard(t, uid);
  if (!found) return false;
  const player = found.player;
  if (found.zone !== "mao" || !player.toBottom) return false;
  player.mao.splice(found.index, 1);
  player.baralho.push(found.card);              // fundo, na ordem escolhida
  player.toBottom--;
  if (!player.toBottom) confirmHand(t, player);
}

/* A mão fechada — e com ela a COMPRA DO TURNO, se a vez for de quem manteve.
   No Commander quem começa jogando compra: é o duelo de dois que tira essa
   compra do primeiro jogador, e a mesa deste deckbuilder é multiplayer.

   Quem mantém FORA DA VEZ fica com a mão que escolheu. A carta a mais é a do
   turno dele, e ela chega em `passTurn` quando a vez chegar — comprá-la
   aqui adiantaria um turno que ele ainda não jogou.

   Ela vem depois das cartas que voltam pro fundo, e é uma só: o que se
   devolve é a mão de sete que se viu, e a carta a mais é a do turno, não
   parte da escolha. */
function confirmHand(t: Table, player: Player) {
  player.phase = "jogo";
  const onTurn = activePlayer(t) === player;
  if (onTurn) drawFor(player, 1);
  log(t, `${player.name}: manteve com ${player.mao.length}${onTurn ? " (a do turno incluída)" : ""}`);
}

/* --------------------------------------------------------------- turnos */

function passTurn(t: Table) {
  t.active = (t.active + 1) % t.players.length;
  // O número do turno anda quando a vez volta pro primeiro: com um jogador é
  // todo "passar turno", com dois é a rodada inteira.
  if (t.active === 0) t.turn++;
  clearCombat(t);
  const player = activePlayer(t);
  player.landsThisTurn = 0;
  // Endireita tudo de quem está jogando, como o desendireitar de verdade.
  for (const c of player.campo) c.tapped = false;
  log(t, `— turno ${t.turn}, vez de ${player.name}`);
  // Quem ainda está no mulligan não compra aqui: a compra deste turno vem
  // junto com a mão confirmada (ver `confirmHand`).
  if (player.phase === "jogo") drawFor(player, 1);
}

/* ---------------------------------------------------------------- zonas */

export function findCard(t: Table, uid: number) {
  for (const player of t.players) {
    for (const zone of ZONES) {
      const index = player[zone].findIndex((c) => c.uid === uid);
      if (index >= 0) return { player, zone, index, card: player[zone][index] };
    }
  }
  return null;
}

/* A ÚNICA mutação de zona. Tudo passa por aqui pra o invariante "cada uid
   existe em exatamente uma zona de um jogador" ter um lugar só onde pode
   quebrar.

   Chama-se `moveToZone`, e não só "mover", porque JÁ EXISTE o `moveCard`
   desta página — o que troca carta entre deck e maybeboard. Quando os dois
   eram funções soltas de mesmo nome num script só, a segunda apagava a
   primeira no hoisting, e a mesa parava de mover carta sem nada na tela
   dizendo por quê. Foi o teste da mesa (hoje `test/goldfish.test.ts`) que pegou.

   O destino é conferido mesmo sendo tipado: a ação pode chegar de fora, como
   JSON, e uma zona inventada criaria uma lista que nenhuma varredura vê. */
function moveToZone(t: Table, uid: number, to: string, toTop?: boolean, faceDown?: boolean) {
  if (!ZONES.includes(to as Zone)) return false;
  const dest = to as Zone;
  const found = findCard(t, uid);
  if (!found) return false;
  const { player, zone, index, card } = found;
  if (zone === dest && dest !== "baralho") return false;
  // O nome vai pro log se a mesa viu a carta de um lado ou do outro da
  // viagem. Da mão pro baralho, ou descendo já virada, ela não aparece.
  const wasShown = shownIn(zone, card);
  player[zone].splice(index, 1);

  // Ficha que sai do campo SOME. Ela não existe fora dele, e um cemitério com
  // três Soldados mentiria sobre o que dá pra devolver de lá.
  if (card.token && dest !== "campo") {
    log(t, `${player.name}: ${wasShown ? cardName(card) : "uma ficha"} deixou de existir`);
    return;
  }

  // A carta vai pra zona do DONO dela, não de quem a moveu: matar a criatura
  // do outro manda ela pro cemitério dele.
  const owner = t.players[card.owner] || player;
  if (dest === "campo" && zone !== "campo") {
    card.tapped = false;   // entra em pé
    if (isLand(card.card)) owner.landsThisTurn++;
    owner.plays.push({ name: cardName(card), cmc: card.card?.cmc || 0,
                         land: isLand(card.card), turn: t.turn });
    if (card.commander && owner.commanderTurn === null) owner.commanderTurn = t.turn;
  }
  if (dest !== "campo") {
    // Carta de duas faces que sai do campo volta a ser a frente, como na mesa.
    card.tapped = false; card.counters = {}; card.backUp = false;
    card.attacking = false; card.blocking = null;
  }
  // Descer virada (metamorfo, exílio virado) é um gesto só: virar DEPOIS de
  // descer mostraria a carta no caminho.
  if (faceDown) card.faceDown = true;
  const name = wasShown || shownIn(dest, card) ? cardName(card) : "uma carta";
  // No campo a carta entra no FIM da fila: lá a ordem é a que a pessoa
  // arrumou (ver `reposition`), e entrar no começo empurraria todas.
  if ((dest === "baralho" && !toTop) || dest === "campo") owner[dest].push(card);
  else owner[dest].unshift(card);
  log(t, `${owner.name}: ${name} — ${ZONE_NAMES[zone]} → ${ZONE_NAMES[dest]}`);
}

/* Arrumar o campo: uma carta vai pra antes ou depois de outra da MESMA fila —
   mesmo dono e mesmo grupo (Terrenos, Criaturas, Outros). A fila de uma carta
   é o tipo dela, e não onde ela foi solta: soltar um artefato entre as
   criaturas não o torna criatura, e aceitar isso faria a fila mentir sobre o
   que ela contém.

   `rowAccepts` aceita a arrastada de qualquer zona (a carta da mão pode
   descer já no lugar); `reposition` só mexe no que já está no campo. A
   ordem mora na própria lista `campo` do jogador — o desenho filtra por
   grupo mantendo a ordem dela. Não vai pro log: arrumar a mesa não é jogada. */
export function rowAccepts(t: Table, uid: number, target: number) {
  if (uid === target) return false;
  const a = findCard(t, uid);
  const b = findCard(t, target);
  return !!(a && b && b.zone === "campo" && a.card.owner === b.card.owner &&
            fieldRow(a.card) === fieldRow(b.card));
}

function reposition(t: Table, uid: number, target: number, after: boolean) {
  const a = findCard(t, uid);
  if (!a || a.zone !== "campo" || !rowAccepts(t, uid, target)) return false;
  const row = a.player.campo;
  row.splice(a.index, 1);
  const i = row.findIndex((c) => c.uid === target);
  row.splice(after ? i + 1 : i, 0, a.card);
}

/* O comandante indo pro campo pela zona de comando: o imposto é INFORMAÇÃO. A
   tela conta quantas vezes ele saiu de lá e diz quanto custaria a próxima.
   Não cobra nada. */
function castCommander(t: Table, uid: number) {
  const found = findCard(t, uid);
  if (!found) return false;
  t.players[found.card.owner].taxPaid++;
  return moveToZone(t, uid, "campo");
}

export function isLand(card: Card | null | undefined) {
  return hasType(card, "land");
}

function hasType(card: Card | null | undefined, type: string) {
  return (card?.tipo || "").toLowerCase().includes(type);
}

/* As filas do campo: terrenos, criaturas e o resto. Quem olha um tabuleiro
   procura uma coisa de cada vez ("tenho mana? tenho bicho?"), e numa fila só
   de trinta cartas cada pergunta dessas vira busca visual. Na tela, os
   terrenos são uma área e as outras duas filas formam o campo de batalha.

   Terreno-criatura entra em Terrenos, e pela mesma razão de `AUTO_CATEGORIES`:
   a primeira regra que casa ganha, porque pra quem joga ele é o terreno que
   entrou no turno. */
const FIELD_ROWS: [string, (c: { card: Card | null }) => boolean][] = [
  ["Terrenos", (c) => isLand(c.card)],
  ["Criaturas", (c) => hasType(c.card, "creature")],
  ["Outros", () => true],
];

export function fieldRow(c: { card: Card | null }) {
  return FIELD_ROWS.find(([, matches]) => matches(c))![0];
}

/* ------------------------------------------------- vida, marcas, combate */

function adjustLife(t: Table, player: Player, n: number) {
  player.life += n;
  log(t, `${player.name}: vida ${n > 0 ? "+" : ""}${n} (${player.life})`);
}

/* Marcador de jogador (veneno, energia, experiência) mora no JOGADOR, e não
   numa carta: quem tem dez de veneno é a pessoa, não a criatura que a
   envenenou. Zero apaga a linha — uma lista de marcadores em zero é uma lista
   de coisas que não estão acontecendo. */
function adjustPlayerCounter(t: Table, player: Player, name: string, n: number) {
  const value = Math.max(0, (player.counters[name] || 0) + n);
  if (value) player.counters[name] = value; else delete player.counters[name];
  log(t, `${player.name}: ${name} ${value}`);
}

function adjustCardCounter(t: Table, c: TableCard, name: string, n: number) {
  const value = Math.max(0, (c.counters[name] || 0) + n);
  if (value) c.counters[name] = value; else delete c.counters[name];
  log(t, `${logName(t, c)}: ${name} ${value}`);
}

/* Dano de comandante é por ORIGEM: 21 do comandante de um não se soma aos 21
   do outro, e é essa separação que faz o número valer alguma coisa. */
function adjustCommanderDamage(t: Table, player: Player, from: number, n: number) {
  player.commanderDamage[from] = Math.max(0, (player.commanderDamage[from] || 0) + n);
  log(t, `${player.name}: dano de comandante ${player.commanderDamage[from]}`);
}

function toggleTapped(t: Table, c: TableCard) {
  c.tapped = !c.tapped;
  log(t, `${logName(t, c)}: ${c.tapped ? "deitada" : "endireitada"}`);
}

/* O nome é o de quando a mesa via a carta: o de ANTES ao virar pra baixo, o de
   DEPOIS ao desvirar — que é justamente a revelação. */
function toggleFaceDown(t: Table, c: TableCard) {
  const before = logName(t, c);
  c.faceDown = !c.faceDown;
  log(t, c.faceDown ? `${before}: virada pra baixo` : `${logName(t, c)}: desvirada`);
}

/* A face que está pra cima numa carta de duas faces (transformar, MDFC). Só
   existe pra carta com verso de PAPEL: carta partida e aventura têm as duas
   metades numa imagem só, e a base as devolve sem `imagem_verso`. */
function toggleFace(t: Table, c: TableCard) {
  if (!c.card?.imagem_verso) return false;
  c.backUp = !c.backUp;
  log(t, `${logName(t, c)}: ${c.backUp ? "virada pro verso" : "virada pra frente"}`);
}

function toggleAttack(t: Table, c: TableCard) {
  c.attacking = !c.attacking;
  c.blocking = null;
  log(t, `${logName(t, c)}: ${c.attacking ? "ataca" : "não ataca mais"}`);
}

function setBlock(t: Table, c: TableCard, target: number) {
  c.blocking = c.blocking === target ? null : target;
  c.attacking = false;
  const blocked = c.blocking ? findCard(t, target)?.card : null;
  const whom = blocked ? logName(t, blocked) : "";
  log(t, `${logName(t, c)}: ${whom ? "bloqueia " + whom : "não bloqueia mais"}`);
}

/* Os dois gestos de mesa que se fazem com o tabuleiro inteiro: endireitar
   tudo (a carta que entrou deitada, o efeito que desvira) e atacar com todas
   as criaturas em pé. Atacar não deita — `toggleAttack` também não: quem tem
   vigilância é quem joga que sabe. */
function untapAll(t: Table, player: Player) {
  const tapped = player.campo.filter((c) => c.tapped);
  if (!tapped.length) return false;
  for (const c of tapped) c.tapped = false;
  log(t, `${player.name}: endireitou tudo`);
}

function attackAll(t: Table, player: Player) {
  const ready = player.campo.filter((c) => !c.tapped && !c.attacking && fieldRow(c) === "Criaturas");
  if (!ready.length) return false;
  for (const c of ready) { c.attacking = true; c.blocking = null; }
  log(t, `${player.name}: ataca com ${ready.length}`);
}

function clearCombat(t: Table) {
  for (const player of t.players) {
    for (const c of player.campo) { c.attacking = false; c.blocking = null; }
  }
}

/* ---------------------------------------------------------------- fichas */

/* A ficha é uma carta inventada na hora, com a mesma forma das outras pra o
   desenho, a prévia e a modal não precisarem saber que ela é diferente. O que
   a separa é `token`, e o efeito dele está no `moveToZone`: fora do campo, ela
   deixa de existir. */
function createToken(t: Table, player: Player, model: TokenModel, howMany: number | string) {
  const card: Card = {
    nome: model.nome || "Ficha",
    tipo: model.tipo || "Token Creature",
    identidade: (model.cores || []).join(""),
    mana_cost: "", cmc: 0,
    poder: model.poder || "", resistencia: model.resistencia || "",
    imagem: model.imagem || "", ficha: true,
    // A ficha do deck traz a chave dela, que é por onde a arte escolhida é
    // achada (ver `artName`).
    chaveArte: model.chaveArte || "",
  };
  const n = Math.max(1, Math.min(20, Number(howMany) || 1));
  for (let i = 0; i < n; i++) player.campo.push(makeCopy(t, card, player.index, { token: true }));
  log(t, `${player.name}: criou ${n} × ${card.nome}`);
}

/* ------------------------------------------------------------------- log */

function log(t: Table, text: string) {
  t.log.push({ turn: t.turn, text: text });
  if (t.log.length > LOG_LIMIT) t.log.shift();
}

/* --------------------------------------------------------------- a jogada */

/* Aplica a ação na mesa, NO LUGAR. Devolve `false` quando a ação não fez nada
   (carta que não existe, zona inventada, arrumação que não cabe): é o que
   deixa quem guarda a partida não espalhar pra mesa uma jogada vazia.

   O jogador e a carta que a ação cita são conferidos aqui, uma vez, e não em
   cada regra: a ação pode ter vindo de outra máquina, e um índice que não
   existe derrubaria a regra no meio, com a mesa pela metade. */
export function apply(t: Table, action: Action, random: Random = Math.random): boolean {
  const player = "player" in action ? t.players[action.player] : undefined;
  if ("player" in action && !player) return false;
  const card = "uid" in action ? findCard(t, action.uid)?.card : undefined;
  if ("uid" in action && !card) return false;

  let result: boolean | void;
  switch (action.type) {
    case "join": result = addPlayer(t, action.deck, random); break;
    case "leave": result = removeSecondDeck(t); break;
    case "shuffle": result = shuffleLibrary(t, player!, random, action.keepTop); break;
    case "draw": result = draw(t, player!, action.n); break;
    case "mill": result = mill(t, player!, action.n, action.to); break;
    case "mulligan": result = londonMulligan(t, player!, random); break;
    case "keep": result = keepHand(t, player!); break;
    case "bottom": result = putOnBottom(t, action.uid); break;
    case "pass": result = passTurn(t); break;
    case "move": result = moveToZone(t, action.uid, action.to, action.toTop, action.faceDown); break;
    case "arrange": result = reposition(t, action.uid, action.target, action.after); break;
    case "cast": result = castCommander(t, action.uid); break;
    case "life": result = adjustLife(t, player!, action.n); break;
    case "playerCounter": result = adjustPlayerCounter(t, player!, action.name, action.n); break;
    case "cardCounter": result = adjustCardCounter(t, card!, action.name, action.n); break;
    case "commanderDamage": result = adjustCommanderDamage(t, player!, action.from, action.n); break;
    case "tap": result = toggleTapped(t, card!); break;
    case "faceDown": result = toggleFaceDown(t, card!); break;
    case "flip": result = toggleFace(t, card!); break;
    case "attack": result = toggleAttack(t, card!); break;
    case "block": result = setBlock(t, card!, action.target); break;
    case "endCombat": result = clearCombat(t); break;
    case "untapAll": result = untapAll(t, player!); break;
    case "attackAll": result = attackAll(t, player!); break;
    case "token": result = createToken(t, player!, action.model, action.count); break;
    default: return false;   // tipo desconhecido, vindo de fora
  }
  return result !== false;
}
