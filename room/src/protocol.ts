/* O que anda pelo socket da mesa, nos dois sentidos, e a conferência do que
   chega.

   TUDO QUE CHEGA É SUSPEITO. A ação vem de um navegador, e o navegador é de
   quem quiser abrir o devtools. `apply` já recusa carta, jogador e zona que
   não existem; o que sobra pra cá é a FORMA: `n` que é texto somaria "40abc"
   na vida, e um nome de marcador de um megabyte iria pro log de todo mundo. */
import type { Action, Table, TableCard, TokenModel } from "../../front/src/pages/deckbuilder/tableRules";
import type { Card } from "../../front/src/pages/deckbuilder/types";

/* ------------------------------------------------- do navegador pra sala */

export type ClientMessage =
  /** Sentar com um deck salvo no site (a sala o busca pelo id). */
  | { type: "sit"; deckId: string }
  | { type: "act"; action: Action }
  /** Olhar o próprio baralho inteiro. Termina num embaralhamento. */
  | { type: "look" }
  /** Desfazer a própria última jogada, se ninguém jogou depois. */
  | { type: "undo" }
  /** Partida nova com os mesmos decks. */
  | { type: "restart" };

/* ------------------------------------------------- da sala pro navegador */

/* A mesa como um assento a vê. As cartas escondidas chegam com `card: null`
   e um `uid` negativo, que só serve de chave pro desenho; as que ele pode
   ver chegam com `card: null` também, e a carta vem em `cards` — uma vez por
   conexão (ver `room.ts`). */
export type TableView = Omit<Table, "cards" | "nextUid">;

export interface SeatInfo {
  name: string;
  connected: boolean;
}

export type ServerMessage =
  | {
      type: "view";
      /** O assento de quem recebe; `null` é quem só assiste. */
      seat: number | null;
      seats: SeatInfo[];
      table: TableView | null;
      /** As cartas que esta conexão ainda não tinha, por `uid`. */
      cards: Record<number, Card>;
      looking: boolean;
      canUndo: boolean;
    }
  | { type: "error"; message: string };

export type { TableCard };

/* ------------------------------------------------------- a conferência */

const NAME_LIMIT = 40;
const TEXT_LIMIT = 200;
const ADJUST_LIMIT = 1000;
const DECK_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isIndex = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 10_000;
const isUid = (x: unknown) => Number.isInteger(x) && (x as number) > 0;
const isAdjust = (x: unknown) => Number.isInteger(x) && Math.abs(x as number) <= ADJUST_LIMIT;
const isName = (x: unknown) => typeof x === "string" && x.trim().length > 0 && x.length <= NAME_LIMIT;
const isFlag = (x: unknown) => x === undefined || typeof x === "boolean";

function isTokenModel(x: unknown): x is TokenModel {
  if (!isObject(x)) return false;
  for (const [key, value] of Object.entries(x)) {
    if (key === "cores") {
      if (!Array.isArray(value) || value.length > 5 || !value.every((c) => /^[WUBRG]$/.test(c))) return false;
    } else if (["nome", "tipo", "poder", "resistencia", "chaveArte"].includes(key)) {
      if (typeof value !== "string" || value.length > TEXT_LIMIT) return false;
    } else {
      // `imagem` fica de fora DE PROPÓSITO: uma URL escolhida por um jogador
      // seria carregada no navegador dos outros, e é assim que se descobre o
      // IP de alguém. Ficha de mesa compartilhada desenha sem arte.
      return false;
    }
  }
  return true;
}

/* Cada tipo com os campos que ele usa. `join` e `leave` não estão aqui:
   quem senta e quem sai é a sala que decide (ver `sit`), e não uma jogada. */
const ACTION_SHAPES: Record<string, (a: Record<string, unknown>) => boolean> = {
  shuffle: (a) => isIndex(a.player),
  draw: (a) => isIndex(a.player) && Number.isInteger(a.n) && (a.n as number) >= 1 && (a.n as number) <= 20,
  mulligan: (a) => isIndex(a.player),
  keep: (a) => isIndex(a.player),
  bottom: (a) => isUid(a.uid),
  pass: () => true,
  move: (a) => isUid(a.uid) && typeof a.to === "string" && isFlag(a.toTop) && isFlag(a.faceDown),
  arrange: (a) => isUid(a.uid) && isUid(a.target) && typeof a.after === "boolean",
  cast: (a) => isUid(a.uid),
  life: (a) => isIndex(a.player) && isAdjust(a.n),
  playerCounter: (a) => isIndex(a.player) && isName(a.name) && isAdjust(a.n),
  cardCounter: (a) => isUid(a.uid) && isName(a.name) && isAdjust(a.n),
  commanderDamage: (a) => isIndex(a.player) && isIndex(a.from) && isAdjust(a.n),
  tap: (a) => isUid(a.uid),
  faceDown: (a) => isUid(a.uid),
  flip: (a) => isUid(a.uid),
  attack: (a) => isUid(a.uid),
  block: (a) => isUid(a.uid) && isUid(a.target),
  endCombat: () => true,
  token: (a) => isIndex(a.player) && isTokenModel(a.model) &&
                Number.isInteger(a.count) && (a.count as number) >= 1 && (a.count as number) <= 20,
};

export function isAction(x: unknown): x is Action {
  if (!isObject(x) || typeof x.type !== "string") return false;
  const shape = ACTION_SHAPES[x.type];
  return !!shape && shape(x);
}

/** A mensagem, se ela tem a forma de uma; senão `null`. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!isObject(data)) return null;
  switch (data.type) {
    case "sit":
      return typeof data.deckId === "string" && DECK_ID.test(data.deckId)
        ? { type: "sit", deckId: data.deckId } : null;
    case "act":
      return isAction(data.action) ? { type: "act", action: data.action } : null;
    case "look": case "undo": case "restart":
      return { type: data.type };
    default:
      return null;
  }
}
