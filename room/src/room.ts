/* A sala: quem está sentado onde, a mesa, e o que cada um pode fazer nela.

   Não sabe que existe Durable Object, socket nem rede — quem a usa entrega
   mensagens já conferidas e manda adiante o que ela devolve (ver
   `durable.ts`). É o que deixa testá-la inteira sem subir nada.

   O ASSENTO É O JOGADOR. `seats[i]` é quem joga `table.players[i]`, e os dois
   só crescem juntos (ver `sit`): ninguém se levanta da mesa no meio da
   partida — quem cai e volta senta no mesmo lugar, pelo id da conta.

   NADA TRAVA A JOGADA, como na mesa local: a sala não sabe Magic. O que ela
   barra é o que a mesa de papel também barra sem precisar de regra — mexer
   no baralho dos outros, pegar carta que você não está vendo, passar a vez
   de quem está jogando. */
import {
  apply, findCard, MAX_PLAYERS, newTable, ZONES,
  type Action, type Random, type Table, type TableDeck,
} from "../../front/src/pages/deckbuilder/tableRules";
import type { Card } from "../../front/src/pages/deckbuilder/types";
import type { ClientMessage, ServerMessage, SeatInfo } from "./protocol";
import { canSee, viewFor } from "./view";

export interface Seat {
  userId: string;
  name: string;
  deckId: string;
}

export interface RoomState {
  seats: Seat[];
  table: Table | null;
  /** Os assentos que estão procurando no próprio baralho. */
  looking: number[];
  /** As cartas do topo que cada assento está olhando, pelo `uid` (ver `peek`). */
  peeking: Record<number, number[]>;
  /** A última jogada, de quem foi e a mesa de antes dela (ver `undoable`). */
  undo: { seat: number; photo: string } | null;
}

export const emptyRoom = (): RoomState => ({ seats: [], table: null, looking: [], peeking: {}, undo: null });

/** Uma conexão aberta: de quem é e quais cartas ela já recebeu. */
export interface Connection {
  userId: string;
  known: Set<number>;
}

/* Jogadas que mexem no baralho de ALGUÉM: só o dono. */
const OWN_LIBRARY = new Set<Action["type"]>(["shuffle", "draw", "mill", "mulligan", "keep"]);

export class Room {
  constructor(public state: RoomState, private random: Random) {}

  seatOf(userId: string): number | null {
    const i = this.state.seats.findIndex((s) => s.userId === userId);
    return i >= 0 ? i : null;
  }

  isFull() {
    return this.state.seats.length >= MAX_PLAYERS;
  }

  /* Senta com o deck que a sala já buscou. A primeira pessoa abre a mesa; as
     outras entram na mesa que está rolando, como o segundo deck da tela. */
  sit(userId: string, name: string, deckId: string, deck: TableDeck): string | null {
    if (this.seatOf(userId) !== null) return "Você já está sentado nesta mesa.";
    if (this.isFull()) return `A mesa já tem ${MAX_PLAYERS} jogadores.`;
    const s = this.state;
    if (!s.table) s.table = newTable([deck], this.random);
    else if (!apply(s.table, { type: "join", deck }, this.random)) return "Não deu pra sentar.";
    s.seats.push({ userId, name, deckId });
    s.undo = null;
    return null;
  }

  /* Partida nova com os decks de agora: a sala os busca de novo, então o
     deck que mudou no site entra mudado. */
  restart(userId: string, decks: TableDeck[]): string | null {
    if (this.seatOf(userId) === null) return "Só quem está sentado recomeça a partida.";
    if (decks.length !== this.state.seats.length) return "Não deu pra buscar todos os decks.";
    this.state.table = newTable(decks, this.random);
    this.state.looking = [];
    this.state.peeking = {};
    this.state.undo = null;
    return null;
  }

  /** As mensagens de mesa: jogar, olhar o baralho, desfazer. */
  handle(userId: string, msg: Extract<ClientMessage, { type: "act" | "look" | "peek" | "undo" }>): string | null {
    const seat = this.seatOf(userId);
    const t = this.state.table;
    if (seat === null || !t) return "Sente-se à mesa pra jogar.";
    if (msg.type === "look") {
      if (!this.state.looking.includes(seat)) this.state.looking.push(seat);
      return null;
    }
    if (msg.type === "peek") return this.peek(seat, msg.n);
    if (msg.type === "undo") return this.undo(seat);
    return this.act(seat, msg.action);
  }

  private act(seat: number, action: Action): string | null {
    const t = this.state.table!;
    if (OWN_LIBRARY.has(action.type) && "player" in action && action.player !== seat) {
      return "O baralho e a mão dos outros são deles.";
    }
    if (action.type === "pass" && t.active !== seat) return "Só quem está na vez passa o turno.";
    for (const uid of citedCards(action)) {
      const found = findCard(t, uid);
      if (!found || !canSee(seat, found.zone, found.card, this.state.looking.includes(seat), this.peeked(seat))) {
        return "Essa carta não está ao seu alcance.";
      }
    }
    const before = this.photo();
    const libraries = t.players.map((p) => p.baralho.map((c) => c.uid));
    if (!apply(t, action, this.random)) return null;   // jogada vazia: nada a dizer
    // Embaralhar encerra a busca no baralho: é o que a busca promete.
    if (action.type === "shuffle") this.state.looking = this.state.looking.filter((x) => x !== seat);
    this.state.undo = undoable(libraries, t) ? { seat, photo: before } : null;
    return null;
  }

  /* Olhar as de cima (vidência, "olhe as três do topo"): o dono passa a ver
     ESTAS cartas, e não "as N de cima" — mandar uma pro fundo traria a
     seguinte pra dentro da janela, e ele veria uma carta que não comprou o
     direito de ver. Não embaralha ao fim, ao contrário da busca: olhar o
     topo e devolver na ordem é a jogada. */
  private peek(seat: number, n: number): string | null {
    const t = this.state.table!;
    if (n) this.state.peeking[seat] = t.players[seat].baralho.slice(0, n).map((c) => c.uid);
    else delete this.state.peeking[seat];
    return null;
  }

  private peeked(seat: number | null): ReadonlySet<number> {
    return new Set(seat === null ? [] : this.state.peeking[seat] || []);
  }

  /* Desfazer é da ÚLTIMA jogada da mesa, e só pra quem a fez: o Ctrl+Z de um
     não pode desmanchar a jogada do outro. A mesa volta inteira — inclusive
     o log, que de outro jeito contaria a jogada que não aconteceu. */
  private undo(seat: number): string | null {
    const u = this.state.undo;
    if (!u || u.seat !== seat) return "Não há jogada sua pra desfazer.";
    const t = this.state.table!;
    this.state.table = unpack(u.photo, t);
    this.state.undo = null;
    return null;
  }

  /* Quem se desconecta procurando no baralho tem o baralho embaralhado: a
     busca termina como terminaria fechando a janela. */
  release(userId: string) {
    const seat = this.seatOf(userId);
    if (seat !== null && this.state.peeking[seat]) delete this.state.peeking[seat];
    if (seat === null || !this.state.looking.includes(seat) || !this.state.table) return false;
    apply(this.state.table, { type: "shuffle", player: seat }, this.random);
    this.state.looking = this.state.looking.filter((x) => x !== seat);
    this.state.undo = null;
    return true;
  }

  /* O que uma conexão recebe: a visão do assento dela e as cartas que ela
     ainda não tinha. Marca as cartas como enviadas. */
  messageFor(conn: Connection, connected: ReadonlySet<string>): ServerMessage {
    const seat = this.seatOf(conn.userId);
    const s = this.state;
    const seats: SeatInfo[] = s.seats.map((x) => ({ name: x.name, connected: connected.has(x.userId) }));
    const looking = seat !== null && s.looking.includes(seat);
    if (!s.table) return { type: "view", seat, seats, table: null, cards: {}, looking, canUndo: false };
    const { view, visible } = viewFor(s.table, seat, looking, this.peeked(seat));
    const cards: Record<number, Card> = {};
    for (const [uid, card] of visible) {
      if (conn.known.has(uid)) continue;
      conn.known.add(uid);
      cards[uid] = card;
    }
    return { type: "view", seat, seats, table: view, cards, looking, canUndo: !!s.undo && s.undo.seat === seat };
  }

  private photo() {
    return pack(this.state.table!, false);
  }
}

/* Os `uid`s que a ação cita: a carta e, quando há, o alvo. */
function citedCards(action: Action): number[] {
  const out: number[] = [];
  if ("uid" in action) out.push(action.uid);
  if ("target" in action) out.push(action.target);
  if (action.type === "shuffle") out.push(...action.keepTop || []);
  return out;
}

/* A jogada que tirou carta do baralho, ou mexeu na ordem dele, não se
   desfaz. Comprar e desfazer devolveria a carta pro topo com o dono sabendo
   qual é; embaralhar e desfazer traria de volta a ordem que ele acabou de
   ver na busca. Pôr carta NO baralho se desfaz: não mostra nada. */
function undoable(before: number[][], t: Table) {
  return t.players.every((p, i) => {
    const old = before[i];
    if (!old) return true;                     // jogador novo na mesa
    const kept = new Set(old);
    const still = p.baralho.map((c) => c.uid).filter((uid) => kept.has(uid));
    return still.length === old.length && still.every((uid, k) => uid === old[k]);
  });
}

/* ------------------------------------------------------ guardar a sala */

/* A mesa vira JSON SEM a carta dentro de cada cópia — ela está no registro
   (`cards`), e repetir duzentas cartas completas dobraria o que se guarda a
   cada jogada. `withRegistry: false` é a foto do desfazer, que herda o
   registro da mesa atual (ele só cresce). */
export function pack(t: Table, withRegistry = true) {
  return JSON.stringify(t, function (this: unknown, key, value) {
    if (key === "card") return undefined;
    if (!withRegistry && this === t && (key === "cards" || key === "nextUid")) return undefined;
    return value;
  });
}

export function unpack(json: string, current?: Table): Table {
  const t: Table = JSON.parse(json);
  if (current) { t.cards = current.cards; t.nextUid = current.nextUid; }
  for (const player of t.players) {
    for (const zone of ZONES) {
      for (const c of player[zone]) c.card = t.cards[c.uid] || null;
    }
  }
  return t;
}

export function saveRoom(s: RoomState) {
  return JSON.stringify({ ...s, table: s.table ? pack(s.table) : null });
}

export function loadRoom(json: string | undefined): RoomState {
  if (!json) return emptyRoom();
  const raw = JSON.parse(json);
  return { ...emptyRoom(), ...raw, table: raw.table ? unpack(raw.table) : null };
}
