/* =========================================================================
   GOLDFISH — a mesa da tela

   As regras moram em `tableRules.ts`, que não sabe que existe tela (e o
   cabeçalho de lá conta o que elas fazem e, de propósito, o que não fazem).
   Aqui fica o que é da tela: a mesa desta página (`state.table`), por onde a
   jogada chega nela (`act`), as perguntas que o desenho faz, o resumo do
   fim, os combos marcados nas cartas e o desfazer.
   ========================================================================= */
import { countedCards } from "./deck";
import { COLORS, OUT_OF_COUNT, state } from "./state";
import {
  apply, cardName, findCard, rowAccepts, isLand, newTable, bottomCount, tableDeckFrom, ZONES,
  type Action, type Player, type Table, type TableCard, type TableDeck, type Zone,
} from "./tableRules";
import type { Card } from "./types";

export {
  cardName, fieldRow, isLand, ZONE_NAMES,
} from "./tableRules";
export type {
  Action, Player, Table, TableCard, TableDeck, TokenModel, Zone,
} from "./tableRules";

/** Um combo como o Commander Spellbook o devolve (ver `combos.js`). */
export interface Combo {
  pecas?: { nome: string }[];
  produz?: string[];
  [field: string]: unknown;
}

const UNDO_LIMIT = 20;

/* Os marcadores que a tela oferece de cara. O resto entra pelo campo "outro":
   marcador de Magic é lista aberta, e uma lista fechada aqui viraria uma
   corrida atrás de cada carta nova que inventa um. */
export const CARD_COUNTERS = ["+1/+1", "-1/-1", "lealdade"];
export const PLAYER_COUNTERS = ["veneno", "energia", "experiência"];

const table = () => state.table!;

/** `null` é "use as do deck da tela" (ver `faceImage`). */
export function playerArts(playerIndex: number) {
  const player = state.table?.players[playerIndex];
  return player && player.deck ? (state.table!.arts[player.deck] || {}) : null;
}

/* ------------------------------------------------------------- o baralho */

/* Um deck pra mesa: nome, comandantes e entradas `{carta, quantidade}`. O da
   tela sai de `countedCards()`, a mesma função do contador, da curva e da
   assinatura de cotação — sideboard e maybeboard ficam de fora aqui pelo mesmo
   motivo que ficam lá. Usar outra regra faria a mesa discordar do resto da
   tela sobre o que é o deck. */
export function screenDeck(): TableDeck {
  return {
    name: state.name || "Este deck",
    commanders: state.commanders.filter(Boolean),
    entries: countedCards(),
  };
}

/* O mesmo formato, vindo de `GET /decks/{id}`: é como o segundo deck entra
   (ver `tableDeckFrom`). */
export function deckFromResponse(response: { deck?: any }, id?: string, choices?: Record<string, unknown>): TableDeck {
  return tableDeckFrom(response, OUT_OF_COUNT, id, choices);
}

/* ---------------------------------------------------------- a mesa da tela */

export function setUpTable(decks: TableDeck[]) {
  state.table = newTable(decks);
  state.tableUndo = [];
  lastGesture = null;
}

/* A jogada na mesa desta página. É o único caminho até `apply` fora dos
   testes das regras: numa mesa compartilhada, é aqui que a ação deixa de ser
   aplicada na hora e passa a ir pra quem guarda a partida. */
export function act(action: Action) {
  return state.table ? apply(state.table, action) : false;
}

/* ------------------------------------------------- perguntas do desenho */

export function cardByUid(uid: number) {
  return state.table ? findCard(state.table, uid)?.card ?? null : null;
}

export function zoneOf(uid: number) {
  return state.table ? findCard(state.table, uid)?.zone ?? null : null;
}

export function bottomCountOnKeep(playerIndex: number) {
  return bottomCount(table().players[playerIndex]);
}

export function fitsInRow(uid: number, target: number) {
  return !!state.table && rowAccepts(state.table, uid, target);
}

export function attackers() {
  return table().players.flatMap((player) => player.campo.filter((c) => c.attacking));
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
  return table().players.map((player) => {
    const all = ZONES.flatMap((z) => player[z]).filter((c) => !c.token && !c.commander);
    const spells = all.filter((c) => !isLand(c.card));
    const played = player.plays.filter((x) => !x.land);
    return {
      name: player.name,
      life: player.life,
      commanderTurn: player.commanderTurn,
      landsPlayed: player.plays.filter((x) => x.land).length,
      deckCurve: curveOf(spells.map((c) => c.card?.cmc || 0)),
      playedCurve: curveOf(played.map((x) => x.cmc)),
      spellsPlayed: played.length,
      spellsInDeck: spells.length,
      neverDrawn: player.baralho.length,
      remaining: player.baralho.map((c) => cardName(c)).sort(),
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
export function handSummary(hand: { card: Card | null }[]) {
  const spells = hand.filter((c) => !isLand(c.card));
  const total = spells.reduce((n, c) => n + (c.card?.cmc || 0), 0);
  const colors: Record<string, number> = {};
  for (const c of hand) {
    for (const symbol of (c.card?.mana_cost || "").match(/\{[^}]+\}/g) || []) {
      // Híbrido conta pras duas cores: "{G/W}" é uma carta que cabe nas duas.
      for (const part of symbol.slice(1, -1).split("/")) {
        if ((COLORS as string[]).includes(part)) colors[part] = (colors[part] || 0) + 1;
      }
    }
  }
  return { lands: hand.length - spells.length, spells: spells.length,
           averageCost: spells.length ? total / spells.length : 0, colors };
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
     perguntado, então não há combo dele pra marcar. O deck da tela é o de
     `deck === null` (o mesmo sentido que `playerArts` dá ao campo) ou, na
     mesa online, onde todo mundo senta pelo id, o de id igual ao da tela.
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
  if (!index || !c || c.token) return 0;
  const player = state.table?.players[c.owner];
  // Só o deck da tela tem resposta do Spellbook. Ele é o sem id (a mesa
  // local) ou o de id igual ao da tela (a mesa online, que senta pelo id).
  if (!player || (player.deck && player.deck !== state.id)) return 0;
  return (index.get(cardName(c).toLowerCase()) || []).length;
}

/* Onde cada carta do jogador está, pelo nome. Um mapa só por consulta em vez
   de uma varredura por peça: um combo de quatro peças num deck de cem cartas
   varreria as seis zonas quatro vezes pra responder a mesma coisa. */
function zonesByName(player: Player) {
  const where = new Map<string, Zone>();
  for (const zone of ZONES) {
    for (const c of player[zone]) {
      if (c.token) continue;
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
  const where = zonesByName(table().players[c.owner]);
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

   A foto sai sem as cartas (`card` fica de fora do JSON e volta pelo
   registro, na revelação): sem isso cada clique reescreveria a base de cartas
   inteira da mesa. O registro, as artes e o próximo `uid` também ficam de
   fora, e a mesa restaurada herda os da atual: eles só crescem, e o da atual
   conhece toda carta que a foto conhece — inclusive a ficha criada depois
   dela, que o desfazer não pode fazer o próximo `uid` repetir. */
let lastGesture: string | null = null;

/* Só no nível da mesa: um marcador de carta chamado "arts" é do jogador, e
   sumiria da foto se a regra valesse em qualquer profundidade. */
const OUT_OF_PHOTO = new Set(["nextUid", "cards", "arts"]);

function photoReplacer(this: unknown, key: string, value: unknown) {
  if (key === "card" || (this === state.table && OUT_OF_PHOTO.has(key))) return undefined;
  return value;
}

/* Gesto repetido é UM passo de desfazer: baixar a vida de 40 pra 33 são sete
   cliques, e sem isto eles comeriam sete das vinte fotos — o Ctrl+Z seguinte
   devolveria 34, 35, 36… em vez da jogada que veio antes. Qualquer outra ação
   fecha a sequência, porque ela guarda sem nome. */
export function saveTableSnapshot(gesture?: string) {
  if (!state.table) return;
  if (gesture && gesture === lastGesture) return;
  lastGesture = gesture || null;
  state.tableUndo.push(JSON.stringify(state.table, photoReplacer));
  if (state.tableUndo.length > UNDO_LIMIT) state.tableUndo.shift();
}

export function undoTableStep() {
  const photo = state.tableUndo.pop();
  if (!photo || !state.table) return false;
  const current = table();
  const restored: Table = {
    ...JSON.parse(photo), nextUid: current.nextUid, cards: current.cards, arts: current.arts,
  };
  for (const player of restored.players) {
    for (const zone of ZONES) {
      for (const c of player[zone]) c.card = restored.cards[c.uid] || null;
    }
  }
  state.table = restored;
  lastGesture = null;
  return true;
}
