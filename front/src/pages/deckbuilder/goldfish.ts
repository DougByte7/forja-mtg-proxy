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

   NADA DISSO É SALVO. `corpoDoDeck` não sabe que `state.mesa` existe: uma mão
   de goldfish gravada no deck é uma mão que volta três semanas depois, em outra
   máquina, no meio de uma edição.

   Os campos da mesa (`jogadores`, `baralho`, `mao`…) ainda têm os nomes que os
   módulos de desenho da mesa leem; mudam junto com eles.
   ========================================================================= */
import { countedCards } from "./deck";
import { COLORS, OUT_OF_COUNT, state } from "./state";
import type { Card, Entry } from "./types";

/* ---------------------------------------------------------------- tipos */

export type Zone = "baralho" | "mao" | "campo" | "cemiterio" | "exilio" | "comando";

/** Uma cópia na mesa. A carta em si (`carta`) volta do registro no desfazer. */
export interface TableCard {
  uid: number;
  dono: number;
  carta: Card | null;
  virada: boolean;
  deitada: boolean;
  verso: boolean;
  marcas: Record<string, number>;
  atacando: boolean;
  bloqueando: number | null;
  ficha: boolean;
  cmd: boolean;
}

export interface Player extends Record<Zone, TableCard[]> {
  nome: string;
  indice: number;
  deck: string | null;
  vida: number;
  marcas: Record<string, number>;
  danoCmd: number[];
  mulligans: number;
  aFundo: number;
  fase: "mulligan" | "fundo" | "jogo";
  terrenosBaixados: number;
  impostoPago: number;
  turnoDoComandante: number | null;
  jogadas: { nome: string; cmc: number; terreno: boolean; turno: number }[];
}

export interface Table {
  jogadores: Player[];
  ativo: number;
  turno: number;
  log: { turno: number; texto: string }[];
  logAberto: boolean;
}

/** Um deck pra mesa: o da tela, ou um que veio de `GET /decks/{id}`. */
export interface TableDeck {
  id?: string | null;
  escolhas?: Record<string, unknown>;
  nome: string;
  comandantes: Card[];
  entradas: { carta: Card | null; quantidade: number; categoria?: string }[];
}

/** Um combo como o Commander Spellbook o devolve (ver `combos.js`). */
export interface Combo {
  pecas?: { nome: string }[];
  produz?: string[];
  [field: string]: unknown;
}

const OPENING_HAND = 7;
const STARTING_LIFE = 40;
const UNDO_LIMIT = 20;
const LOG_LIMIT = 200;

/* As zonas de um jogador. A ordem é a da varredura, e ela não é arbitrária: a
   mão e o campo vêm antes porque são onde quase toda carta procurada está. */
const ZONES: Zone[] = ["mao", "campo", "baralho", "cemiterio", "exilio", "comando"];
export const ZONE_NAMES: Record<Zone, string> = {
  baralho: "Baralho", mao: "Mão", campo: "Campo",
  cemiterio: "Cemitério", exilio: "Exílio", comando: "Comando",
};

/* Os marcadores que a tela oferece de cara. O resto entra pelo campo "outro":
   marcador de Magic é lista aberta, e uma lista fechada aqui viraria uma
   corrida atrás de cada carta nova que inventa um. */
export const CARD_COUNTERS = ["+1/+1", "-1/-1", "lealdade"];
export const PLAYER_COUNTERS = ["veneno", "energia", "experiência"];

const table = () => state.mesa!;

/* Cada carta na mesa é uma CÓPIA com identidade própria (`uid`), e não a
   entrada do deck. Três Florestas são três objetos: uma pode estar deitada e as
   outras não, e uma pode estar no cemitério enquanto as outras jogam. Copiar a
   referência da entrada faria deitar uma deitar as trinta — é o bug clássico
   deste tipo de tela. */
let nextUid = 1;

/* A carta em si mora AQUI, fora da mesa, porque ela nunca muda: o que muda é o
   estado da cópia (deitada, virada, marcas, zona). Isso deixa a fotografia do
   desfazer pequena — uma mesa de dois decks tem 200 cartas completas, e
   guardar as vinte últimas jogadas com elas dentro é alguns megabytes de JSON
   reescritos a cada clique. */
const cardsByUid = new Map<number, Card>();

function makeCopy(card: Card, owner: number, extra?: Partial<TableCard>): TableCard {
  const c: TableCard = {
    uid: nextUid++, dono: owner, carta: card, virada: false, deitada: false, verso: false,
    marcas: {}, atacando: false, bloqueando: null, ficha: false, cmd: false,
    ...extra,
  };
  cardsByUid.set(c.uid, card);
  return c;
}

/* As artes escolhidas dos decks que vieram de fora da tela, pelo id do deck.
   Moram fora da mesa pelo mesmo motivo das cartas: não mudam durante a
   partida, e a foto do desfazer não precisa carregá-las. A chave é o id e não
   a posição do jogador porque o desfazer pode trazer de volta um segundo deck
   que já saiu da mesa depois de outro ter entrado no lugar dele.

   O deck da tela não entra aqui: as escolhas dele são as da aba Artes, lidas
   na hora do desenho, e uma arte trocada no meio da partida aparece na mesa. */
const artsByDeck = new Map<string, Record<string, unknown>>();

/** `null` é "use as do deck da tela" (ver `faceImage`). */
export function playerArts(playerIndex: number) {
  const player = state.mesa?.jogadores[playerIndex];
  return player && player.deck ? (artsByDeck.get(player.deck) || {}) : null;
}

export function cardName(c: TableCard | null | undefined) {
  return c?.carta?.nome || "carta";
}

/* ------------------------------------------------------------- o baralho */

/* Um deck pra mesa: nome, comandantes e entradas `{carta, quantidade}`. O da
   tela sai de `countedCards()`, a mesma função do contador, da curva e da
   assinatura de cotação — sideboard e maybeboard ficam de fora aqui pelo mesmo
   motivo que ficam lá. Usar outra regra faria a mesa discordar do resto da
   tela sobre o que é o deck. */
export function screenDeck(): TableDeck {
  return {
    nome: state.nome || "Este deck",
    comandantes: state.comandantes.filter(Boolean),
    entradas: countedCards(),
  };
}

/* O mesmo formato, vindo de `GET /decks/{id}`: é como o segundo deck entra. A
   regra do que conta é a do servidor e a da tela ao mesmo tempo — as
   categorias fora da conta são as mesmas dos dois lados.

   `choices` são as artes escolhidas nele (`GET /decks/{id}/artes`): o deck
   da tela usa as da aba Artes, e este traz as suas. */
export function deckFromResponse(response: { deck?: any }, id?: string, choices?: Record<string, unknown>): TableDeck {
  const deck = response.deck || {};
  return {
    id: id || null,
    escolhas: choices || {},
    nome: deck.nome || "Segundo deck",
    comandantes: (deck.comandantes_completos || []).filter(Boolean),
    entradas: ((deck.cartas_completas || []) as Entry[]).filter(
      (e) => e.carta && !OUT_OF_COUNT.has(e.categoria || "")),
  };
}

function libraryOf(deck: TableDeck, owner: number) {
  const commanders = new Set(deck.comandantes.map((c) => (c.nome || "").toLowerCase()));
  const out: TableCard[] = [];
  for (const entry of deck.entradas) {
    const card = entry.carta;
    if (!card) continue;                       // carta que a base não conhece
    if (commanders.has((card.nome || "").toLowerCase())) continue;
    for (let i = 0; i < entry.quantidade; i++) out.push(makeCopy(card, owner));
  }
  return out;
}

/* Fisher-Yates, no lugar. Escrito à mão e não com `sort(() => Math.random()-.5)`
   de propósito: aquele não é embaralhamento — é uma comparação inconsistente,
   que a maioria das engines resolve com um resultado enviesado, e ninguém
   percebe olhando. */
function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function shuffleLibrary(playerIndex: number) {
  const player = table().jogadores[playerIndex];
  shuffle(player.baralho);
  log(`${player.nome}: baralho reembaralhado`);
}

/* --------------------------------------------------------------- a mesa */

function newPlayer(deck: TableDeck, index: number): Player {
  if (deck.id) artsByDeck.set(deck.id, deck.escolhas || {});
  return {
    nome: deck.nome, indice: index,
    deck: deck.id || null,     // de onde vêm as artes (ver `playerArts`)
    baralho: shuffle(libraryOf(deck, index)),
    mao: [], campo: [], cemiterio: [], exilio: [],
    comando: deck.comandantes.map((c) => makeCopy(c, index, { cmd: true })),
    vida: STARTING_LIFE,
    marcas: {},        // veneno, energia, experiência e o que mais for criado
    danoCmd: [0, 0],   // dano de comandante recebido, por jogador de origem
    mulligans: 0, aFundo: 0, fase: "mulligan",
    terrenosBaixados: 0, impostoPago: 0,
    turnoDoComandante: null,   // pro resumo do fim
    jogadas: [],               // o que desceu pro campo, pra curva realizada
  };
}

export function setUpTable(decks: TableDeck[]) {
  nextUid = 1;
  cardsByUid.clear();
  artsByDeck.clear();
  state.mesa = {
    jogadores: decks.map((d, i) => newPlayer(d, i)),
    ativo: 0, turno: 1, log: [], logAberto: false,
  };
  state.mesaDesfazer = [];
  lastGesture = null;
  for (const player of table().jogadores) drawFor(player, OPENING_HAND);
  log(decks.length > 1
    ? `Mesa embaralhada: ${decks.map((d) => d.nome).join(" × ")}`
    : "Deck embaralhado");
}

/* O segundo deck entra na mesa que já está rolando, e não recomeça a partida:
   quem pede um oponente no meio de um goldfish quer ver a mão que está na tela
   contra alguma coisa, não jogar a mão fora. */
export function addSecondDeck(deck: TableDeck) {
  const t = state.mesa;
  if (!t || t.jogadores.length > 1) return;
  const player = newPlayer(deck, t.jogadores.length);
  t.jogadores.push(player);
  drawFor(player, OPENING_HAND);
  log(`${player.nome} entrou na mesa`);
}

export function removeSecondDeck() {
  const t = state.mesa;
  if (!t || t.jogadores.length < 2) return;
  const gone = t.jogadores.pop()!;
  t.ativo = 0;
  log(`${gone.nome} saiu da mesa`);
}

function activePlayer() {
  return table().jogadores[table().ativo];
}

function drawFor(player: Player, n: number) {
  for (let i = 0; i < n && player.baralho.length; i++) player.mao.push(player.baralho.shift()!);
}

export function draw(playerIndex: number, n: number) {
  const player = table().jogadores[playerIndex];
  const before = player.mao.length;
  drawFor(player, n);
  const drawn = player.mao.length - before;
  if (drawn) log(`${player.nome}: comprou ${drawn}`);
  else log(`${player.nome}: baralho vazio, nada a comprar`);
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
function bottomCount(player: Player) {
  return Math.max(0, player.mulligans - 1);
}

export function bottomCountOnKeep(playerIndex: number) {
  return bottomCount(table().jogadores[playerIndex]);
}

export function londonMulligan(playerIndex: number) {
  const player = table().jogadores[playerIndex];
  player.mulligans++;
  player.baralho = shuffle(player.baralho.concat(player.mao));
  player.mao = [];
  player.aFundo = 0;
  drawFor(player, OPENING_HAND);
  log(`${player.nome}: mulligan ${player.mulligans}`);
}

export function keepHand(playerIndex: number) {
  const player = table().jogadores[playerIndex];
  // Nunca mais do que a mão tem: pedir pra devolver 3 de uma mão de 2 deixaria
  // a fase de fundo sem como terminar, e a mesa travada numa escolha
  // impossível. Só acontece em deck pequeno, que é justamente onde se testa.
  player.aFundo = Math.min(bottomCount(player), player.mao.length);
  // Com zero a devolver a tela pula direto pro jogo: pedir "escolha 0 cartas"
  // é uma etapa que só existe pra ser fechada.
  if (player.aFundo) player.fase = "fundo";
  else confirmHand(player);
}

export function putOnBottom(uid: number) {
  const found = findCard(uid);
  if (!found) return;
  const player = found.player;
  if (found.zone !== "mao" || !player.aFundo) return;
  player.mao.splice(found.index, 1);
  player.baralho.push(found.card);              // fundo, na ordem escolhida
  player.aFundo--;
  if (!player.aFundo) confirmHand(player);
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
function confirmHand(player: Player) {
  player.fase = "jogo";
  const onTurn = activePlayer() === player;
  if (onTurn) drawFor(player, 1);
  log(`${player.nome}: manteve com ${player.mao.length}${onTurn ? " (a do turno incluída)" : ""}`);
}

/* --------------------------------------------------------------- turnos */

export function passTurn() {
  const t = table();
  t.ativo = (t.ativo + 1) % t.jogadores.length;
  // O número do turno anda quando a vez volta pro primeiro: com um jogador é
  // todo "passar turno", com dois é a rodada inteira.
  if (t.ativo === 0) t.turno++;
  clearCombat();
  const player = activePlayer();
  player.terrenosBaixados = 0;
  // Endireita tudo de quem está jogando, como o desendireitar de verdade.
  for (const c of player.campo) c.deitada = false;
  log(`— turno ${t.turno}, vez de ${player.nome}`);
  // Quem ainda está no mulligan não compra aqui: a compra deste turno vem
  // junto com a mão confirmada (ver `confirmHand`).
  if (player.fase === "jogo") drawFor(player, 1);
}

/* ---------------------------------------------------------------- zonas */

function findCard(uid: number) {
  for (const player of table().jogadores) {
    for (const zone of ZONES) {
      const index = player[zone].findIndex((c) => c.uid === uid);
      if (index >= 0) return { player, zone, index, card: player[zone][index] };
    }
  }
  return null;
}

export function cardByUid(uid: number) {
  return state.mesa ? findCard(uid)?.card ?? null : null;
}

export function zoneOf(uid: number) {
  return state.mesa ? findCard(uid)?.zone ?? null : null;
}

/* A ÚNICA mutação de zona. Tudo passa por aqui pra o invariante "cada uid
   existe em exatamente uma zona de um jogador" ter um lugar só onde pode
   quebrar.

   Chama-se `moveToZone`, e não só "mover", porque JÁ EXISTE o `moveCard`
   desta página — o que troca carta entre deck e maybeboard. Quando os dois
   eram funções soltas de mesmo nome num script só, a segunda apagava a
   primeira no hoisting, e a mesa parava de mover carta sem nada na tela
   dizendo por quê. Foi o teste da mesa (hoje `test/goldfish.test.ts`) que pegou. */
export function moveToZone(uid: number, to: string, toTop?: boolean) {
  const t = state.mesa;
  if (!t || !ZONES.includes(to as Zone)) return;
  const dest = to as Zone;
  const found = findCard(uid);
  if (!found) return;
  const { player, zone, index, card } = found;
  if (zone === dest && dest !== "baralho") return;
  player[zone].splice(index, 1);

  // Ficha que sai do campo SOME. Ela não existe fora dele, e um cemitério com
  // três Soldados mentiria sobre o que dá pra devolver de lá.
  if (card.ficha && dest !== "campo") {
    log(`${player.nome}: ${cardName(card)} (ficha) deixou de existir`);
    return;
  }

  // A carta vai pra zona do DONO dela, não de quem a moveu: matar a criatura
  // do outro manda ela pro cemitério dele.
  const owner = t.jogadores[card.dono] || player;
  if (dest === "campo" && zone !== "campo") {
    card.deitada = false;   // entra em pé
    if (isLand(card.carta)) owner.terrenosBaixados++;
    owner.jogadas.push({ nome: cardName(card), cmc: card.carta?.cmc || 0,
                         terreno: isLand(card.carta), turno: t.turno });
    if (card.cmd && owner.turnoDoComandante === null) owner.turnoDoComandante = t.turno;
  }
  if (dest !== "campo") {
    // Carta de duas faces que sai do campo volta a ser a frente, como na mesa.
    card.deitada = false; card.marcas = {}; card.verso = false;
    card.atacando = false; card.bloqueando = null;
  }
  // No campo a carta entra no FIM da fila: lá a ordem é a que a pessoa
  // arrumou (ver `reposition`), e entrar no começo empurraria todas.
  if ((dest === "baralho" && !toTop) || dest === "campo") owner[dest].push(card);
  else owner[dest].unshift(card);
  log(`${owner.nome}: ${cardName(card)} — ${ZONE_NAMES[zone]} → ${ZONE_NAMES[dest]}`);
}

/* Arrumar o campo: uma carta vai pra antes ou depois de outra da MESMA fila —
   mesmo dono e mesmo grupo (Terrenos, Criaturas, Outros). A fila de uma carta
   é o tipo dela, e não onde ela foi solta: soltar um artefato entre as
   criaturas não o torna criatura, e aceitar isso faria a fila mentir sobre o
   que ela contém.

   `fitsInRow` aceita a arrastada de qualquer zona (a carta da mão pode
   descer já no lugar); `reposition` só mexe no que já está no campo. A
   ordem mora na própria lista `campo` do jogador — o desenho filtra por
   grupo mantendo a ordem dela. Não vai pro log: arrumar a mesa não é jogada. */
export function fitsInRow(uid: number, target: number) {
  if (uid === target) return false;
  const a = findCard(uid);
  const b = findCard(target);
  return !!(a && b && b.zone === "campo" && a.card.dono === b.card.dono &&
            fieldRow(a.card) === fieldRow(b.card));
}

export function reposition(uid: number, target: number, after: boolean) {
  const a = findCard(uid);
  if (!a || a.zone !== "campo" || !fitsInRow(uid, target)) return false;
  const row = a.player.campo;
  row.splice(a.index, 1);
  const i = row.findIndex((c) => c.uid === target);
  row.splice(after ? i + 1 : i, 0, a.card);
  return true;
}

/* O comandante indo pro campo pela zona de comando: o imposto é INFORMAÇÃO. A
   tela conta quantas vezes ele saiu de lá e diz quanto custaria a próxima.
   Não cobra nada. */
export function castCommander(uid: number) {
  const found = findCard(uid);
  if (!found) return;
  table().jogadores[found.card.dono].impostoPago++;
  moveToZone(uid, "campo");
}

export function isLand(card: Card | null | undefined) {
  return hasType(card, "land");
}

function hasType(card: Card | null | undefined, type: string) {
  return (card?.tipo || "").toLowerCase().includes(type);
}

/* ------------------------------------------------- vida, marcas, combate */

export function adjustLife(playerIndex: number, n: number) {
  const player = table().jogadores[playerIndex];
  player.vida += n;
  log(`${player.nome}: vida ${n > 0 ? "+" : ""}${n} (${player.vida})`);
}

/* Marcador de jogador (veneno, energia, experiência) mora no JOGADOR, e não
   numa carta: quem tem dez de veneno é a pessoa, não a criatura que a
   envenenou. Zero apaga a linha — uma lista de marcadores em zero é uma lista
   de coisas que não estão acontecendo. */
export function adjustPlayerCounter(playerIndex: number, name: string, n: number) {
  const player = table().jogadores[playerIndex];
  const value = Math.max(0, (player.marcas[name] || 0) + n);
  if (value) player.marcas[name] = value; else delete player.marcas[name];
  log(`${player.nome}: ${name} ${value}`);
}

export function adjustCardCounter(uid: number, name: string, n: number) {
  const c = cardByUid(uid);
  if (!c) return;
  const value = Math.max(0, (c.marcas[name] || 0) + n);
  if (value) c.marcas[name] = value; else delete c.marcas[name];
  log(`${cardName(c)}: ${name} ${value}`);
}

/* Dano de comandante é por ORIGEM: 21 do comandante de um não se soma aos 21
   do outro, e é essa separação que faz o número valer alguma coisa. */
export function adjustCommanderDamage(playerIndex: number, from: number, n: number) {
  const player = table().jogadores[playerIndex];
  player.danoCmd[from] = Math.max(0, (player.danoCmd[from] || 0) + n);
  log(`${player.nome}: dano de comandante ${player.danoCmd[from]}`);
}

export function toggleTapped(uid: number) {
  const c = cardByUid(uid);
  if (!c) return;
  c.deitada = !c.deitada;
  log(`${cardName(c)}: ${c.deitada ? "deitada" : "endireitada"}`);
}

export function toggleFaceDown(uid: number) {
  const c = cardByUid(uid);
  if (!c) return;
  c.virada = !c.virada;
  log(`${cardName(c)}: ${c.virada ? "virada pra baixo" : "desvirada"}`);
}

/* A face que está pra cima numa carta de duas faces (transformar, MDFC). Só
   existe pra carta com verso de PAPEL: carta partida e aventura têm as duas
   metades numa imagem só, e a base as devolve sem `imagem_verso`. */
export function toggleFace(uid: number) {
  const c = cardByUid(uid);
  if (!c || !c.carta?.imagem_verso) return;
  c.verso = !c.verso;
  log(`${cardName(c)}: ${c.verso ? "virada pro verso" : "virada pra frente"}`);
}

export function toggleAttack(uid: number) {
  const c = cardByUid(uid);
  if (!c) return;
  c.atacando = !c.atacando;
  c.bloqueando = null;
  log(`${cardName(c)}: ${c.atacando ? "ataca" : "não ataca mais"}`);
}

export function setBlock(uid: number, target: number) {
  const c = cardByUid(uid);
  if (!c) return;
  c.bloqueando = c.bloqueando === target ? null : target;
  c.atacando = false;
  const whom = c.bloqueando ? cardName(cardByUid(target)) : "";
  log(`${cardName(c)}: ${whom ? "bloqueia " + whom : "não bloqueia mais"}`);
}

export function clearCombat() {
  for (const player of table().jogadores) {
    for (const c of player.campo) { c.atacando = false; c.bloqueando = null; }
  }
}

export function attackers() {
  return table().jogadores.flatMap((player) => player.campo.filter((c) => c.atacando));
}

/* ---------------------------------------------------------------- fichas */

/* A ficha é uma carta inventada na hora, com a mesma forma das outras pra o
   desenho, a prévia e a modal não precisarem saber que ela é diferente. O que
   a separa é `ficha`, e o efeito dele está no `moveToZone`: fora do campo, ela
   deixa de existir. */
export type TokenModel = {
  nome?: string; tipo?: string; cores?: string[]; poder?: string; resistencia?: string;
  imagem?: string; chaveArte?: string;
};

export function createToken(playerIndex: number, model: TokenModel, howMany: number | string) {
  const player = table().jogadores[playerIndex];
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
  for (let i = 0; i < n; i++) player.campo.push(makeCopy(card, playerIndex, { ficha: true }));
  log(`${player.nome}: criou ${n} × ${card.nome}`);
}

/* ------------------------------------------------------------------- log */

function log(text: string) {
  const t = state.mesa;
  if (!t) return;
  t.log.push({ turno: t.turno, texto: text });
  if (t.log.length > LOG_LIMIT) t.log.shift();
}

/* --------------------------------------------------------------- resumo */

function curveOf(cmcs: number[]) {
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const cmc of cmcs) buckets[Math.min(7, Math.floor(cmc || 0))]++;
  return buckets;
}

/* O resumo do fim: em que turno o comandante desceu, o que a curva prometia
   contra o que a partida entregou, e o que ficou no baralho sem ser visto.

   A curva TEÓRICA sai das cartas do próprio jogador, achatadas de todas as
   zonas: a mesa conserva as cartas, então a soma das zonas é o deck inteiro,
   sem precisar guardar uma segunda cópia da lista. Terreno e comandante ficam
   de fora dos dois lados, como na curva da análise. */
export function gameSummary() {
  return table().jogadores.map((player) => {
    const all = ZONES.flatMap((z) => player[z]).filter((c) => !c.ficha && !c.cmd);
    const spells = all.filter((c) => !isLand(c.carta));
    const played = player.jogadas.filter((x) => !x.terreno);
    return {
      nome: player.nome,
      vida: player.vida,
      turnoDoComandante: player.turnoDoComandante,
      terrenosJogados: player.jogadas.filter((x) => x.terreno).length,
      teorica: curveOf(spells.map((c) => c.carta?.cmc || 0)),
      realizada: curveOf(played.map((x) => x.cmc)),
      feiticosJogados: played.length,
      feiticosNoDeck: spells.length,
      naoPuxadas: player.baralho.length,
      restante: player.baralho.map((c) => cardName(c)).sort(),
    };
  });
}

/* ------------------------------------------------------- resumo da mão */

/* O resumo da mão, do lado das cartas: quantos terrenos, quanto custa em
   média o que não é terreno, e que cores ela pede. É a conta que se faz de
   cabeça a cada mulligan — sete cartas, três perguntas, toda vez — e é com
   ela que se decide manter.

   Duas escolhas acompanham o resto da tela. O custo médio IGNORA terreno,
   como a curva da análise: terreno custa zero e puxaria a média pra um número
   que não diz o que dá pra lançar. E as cores são o que a mão PEDE, lidas dos
   símbolos do custo, como a distribuição da análise — não o que ela produz. */
export function handSummary(hand: { carta: Card | null }[]) {
  const spells = hand.filter((c) => !isLand(c.carta));
  const total = spells.reduce((n, c) => n + (c.carta?.cmc || 0), 0);
  const colors: Record<string, number> = {};
  for (const c of hand) {
    for (const symbol of (c.carta?.mana_cost || "").match(/\{[^}]+\}/g) || []) {
      // Híbrido conta pras duas cores: "{G/W}" é uma carta que cabe nas duas.
      for (const part of symbol.slice(1, -1).split("/")) {
        if ((COLORS as string[]).includes(part)) colors[part] = (colors[part] || 0) + 1;
      }
    }
  }
  return { terrenos: hand.length - spells.length, feiticos: spells.length,
           custoMedio: spells.length ? total / spells.length : 0, cores: colors };
}

/* As filas do campo: terrenos, criaturas e o resto. Quem olha um tabuleiro
   procura uma coisa de cada vez ("tenho mana? tenho bicho?"), e numa fila só
   de trinta cartas cada pergunta dessas vira busca visual. Na tela, os
   terrenos são uma área e as outras duas filas formam o campo de batalha.

   Terreno-criatura entra em Terrenos, e pela mesma razão de `AUTO_CATEGORIES`:
   a primeira regra que casa ganha, porque pra quem joga ele é o terreno que
   entrou no turno. */
const FIELD_ROWS: [string, (c: { carta: Card | null }) => boolean][] = [
  ["Terrenos", (c) => isLand(c.carta)],
  ["Criaturas", (c) => hasType(c.carta, "creature")],
  ["Outros", () => true],
];

export function fieldRow(c: { carta: Card | null }) {
  return FIELD_ROWS.find(([, matches]) => matches(c))![0];
}

/* -------------------------------------------------- os combos na mesa */

/* Onde estão as peças dos combos do deck — a pergunta que se faz no meio de
   um goldfish: "isto que acabei de comprar fecha alguma coisa?".

   A RESPOSTA JÁ ESTÁ NA TELA. `state.combos` é o que o Commander Spellbook
   devolveu quando alguém clicou em procurar (ver `combos.js`), e cruzar
   aquela lista com as zonas da mesa é conta local. Nenhuma requisição nova
   sai daqui: uma partida compra uma carta por turno, e perguntar a cada
   compra seria uma requisição por clique num serviço gratuito — a mesma
   regra que faz a busca de combos só acontecer no botão.

   TRÊS LIMITES, e os três aparecem na tela em vez de virarem silêncio:

   * A resposta é do DECK DA TELA. O segundo deck entrou pelo id e nunca foi
     perguntado, então não há combo dele pra marcar. `deck === null` é o
     deck da tela — o mesmo sentido que `playerArts` já dá ao campo.
   * Só os combos FECHADOS (`no_deck`). Os que faltam uma carta são lista de
     compras, e no meio de uma partida a carta que não está no baralho não vai
     aparecer de jeito nenhum.
   * A MESA NÃO JULGA se o combo dá pra fazer. Mana disponível, permanente
     desvirado, oponente com criatura em jogo — isso é motor de regras, que
     esta tela recusa de propósito (ver o cabeçalho). Daqui sai ONDE cada peça
     está; o requisito vai pra tela como o texto que o Spellbook escreveu, e
     quem decide é quem joga. */

/* A ordem é a da jogada, não a das zonas: da peça que já está em jogo até a
   que precisaria voltar do exílio. Com mais de uma cópia da mesma carta, é a
   mais adiantada que conta — três Florestas no baralho e uma no campo é "no
   campo", porque é o campo que responde a pergunta. */
const NEAREST_TO_PLAY: Zone[] = ["campo", "mao", "comando", "baralho", "cemiterio", "exilio"];

let comboSource: Combo[] | null = null;              // a lista de quem o índice foi feito
let comboIndex: Map<string, Combo[]> | null = null;  // nome em minúsculas -> combos que citam a carta

/* O índice é refeito quando a lista TROCA, e não a cada carta desenhada:
   `fecharCombosCom` monta um array novo ao mover um combo de lista, então
   comparar a referência pega toda mudança que importa. */
function combosIndex() {
  const list = state.combos?.no_deck || null;
  if (!list) { comboSource = null; comboIndex = null; return null; }
  if (comboSource === list) return comboIndex;
  const index = new Map<string, Combo[]>();
  for (const combo of list) {
    for (const piece of combo.pecas || []) {
      const key = piece.nome.toLowerCase();
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(combo);
    }
  }
  comboSource = list;
  comboIndex = index;
  return index;
}

/* Quantos combos do deck esta carta serve. É o que o selo da carta mostra, e
   por isso não varre zona nenhuma: o desenho chama isto uma vez por carta da
   mesa, a cada repintura.

   Ficha fica de fora mesmo com nome de carta: uma ficha de Ashaya não é a
   Ashaya, e marcá-la diria que a peça está no campo quando ela não está. */
export function comboCount(c: TableCard | null | undefined) {
  const index = combosIndex();
  if (!index || !c || c.ficha) return 0;
  const player = state.mesa?.jogadores[c.dono];
  if (!player || player.deck) return 0;   // só o deck da tela tem resposta do Spellbook
  return (index.get(cardName(c).toLowerCase()) || []).length;
}

/* Onde cada carta do jogador está, pelo nome. Um mapa só por consulta em vez
   de uma varredura por peça: um combo de quatro peças num deck de cem cartas
   varreria as seis zonas quatro vezes pra responder a mesma coisa. */
function zonesByName(player: Player) {
  const where = new Map<string, Zone>();
  for (const zone of ZONES) {
    for (const c of player[zone]) {
      if (c.ficha) continue;
      const key = cardName(c).toLowerCase();
      const current = where.get(key);
      if (current === undefined || NEAREST_TO_PLAY.indexOf(zone) < NEAREST_TO_PLAY.indexOf(current)) {
        where.set(key, zone);
      }
    }
  }
  return where;
}

/* Os combos desta carta, com a zona de cada peça e os mais adiantados na
   frente.

   A DISTÂNCIA é a soma das zonas das peças na escala da jogada: um combo com
   as duas peças no campo dá zero, e um com tudo no baralho dá o máximo. Não é
   número pra mostrar — é só o que decide a ordem, pra o combo que está a uma
   jogada não ficar embaixo do que está a três compras.

   Peça sem zona nenhuma acontece por dois motivos, e nenhum dos dois é erro:
   o deck mudou depois da busca de combos e a carta saiu (o mais comum), ou a
   base local não conhece a carta e `libraryOf` a pulou. A tela diz "fora
   da mesa" em vez de fingir um lugar pra ela. */
export function combosOf(c: TableCard) {
  if (!comboCount(c)) return [];
  const self = cardName(c).toLowerCase();
  const where = zonesByName(table().jogadores[c.dono]);
  const far = NEAREST_TO_PLAY.length;
  return combosIndex()!.get(self)!.map((combo) => {
    const pecas = (combo.pecas || []).map((piece) => ({
      nome: piece.nome,
      zona: where.get(piece.nome.toLowerCase()) || null,
      esta: piece.nome.toLowerCase() === self,
    }));
    const distance = pecas.reduce((sum, piece) => sum + (piece.zona === null
      ? far : NEAREST_TO_PLAY.indexOf(piece.zona)), 0);
    return { combo, pecas, distancia: distance };
  }).sort((a, b) => a.distancia - b.distancia);
}

/* ------------------------------------------------------------- desfazer */

/* Desfazer por FOTOGRAFIA do estado, e não por operação inversa: num sistema
   sem regras, o inverso de uma jogada não é definido — mandar uma carta do
   cemitério pro campo não "desfaz" nada, é outra jogada.

   A foto sai sem as cartas (`carta` fica de fora do JSON e volta pelo
   registro, na revelação): sem isso cada clique reescreveria a base de cartas
   inteira da mesa. */
let lastGesture: string | null = null;

/* Gesto repetido é UM passo de desfazer: baixar a vida de 40 pra 33 são sete
   cliques, e sem isto eles comeriam sete das vinte fotos — o Ctrl+Z seguinte
   devolveria 34, 35, 36… em vez da jogada que veio antes. Qualquer outra ação
   fecha a sequência, porque ela guarda sem nome. */
export function saveTableSnapshot(gesture?: string) {
  if (!state.mesa) return;
  if (gesture && gesture === lastGesture) return;
  lastGesture = gesture || null;
  state.mesaDesfazer.push(JSON.stringify(state.mesa,
    (key, value) => key === "carta" ? undefined : value));
  if (state.mesaDesfazer.length > UNDO_LIMIT) state.mesaDesfazer.shift();
}

export function undoTableStep() {
  const photo = state.mesaDesfazer.pop();
  if (!photo) return false;
  const restored: Table = JSON.parse(photo);
  for (const player of restored.jogadores) {
    for (const zone of ZONES) {
      for (const c of player[zone]) c.carta = cardsByUid.get(c.uid) || null;
    }
  }
  state.mesa = restored;
  lastGesture = null;
  return true;
}
