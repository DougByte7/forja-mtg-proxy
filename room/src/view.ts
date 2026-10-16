/* O que cada assento vê da mesa.

   A sala guarda a mesa INTEIRA, e o que sai dela é sempre uma visão: quem
   recebe a mesa inteira vê a mão dos outros no devtools, e aí a mesa vira
   "mesa de confiança" — que é exatamente o que um servidor existe pra não
   ser.

   AS TRÊS REGRAS, as mesmas de uma mesa de papel:

   * A MÃO é só do dono.
   * O BARALHO não é de ninguém — nem o dono sabe a ordem dele. As exceções
     são do dono: procurando no próprio baralho (`looking`), que termina num
     embaralhamento, e olhando as de cima (`peeked`, as cartas que ele viu),
     que não embaralha (ver `room.ts`).
   * A carta VIRADA PRA BAIXO fora dessas zonas é do dono: o metamorfo no
     campo, o exílio virado. Os outros veem que ela existe, se está deitada
     e o que a marca diz — o que a mesa de papel mostra.

   A carta escondida na mão ou no baralho chega SEM o `uid` de verdade: no
   lugar dele vai um número negativo, que só serve de chave pro desenho. Com
   o `uid` real dava pra seguir a carta — a que saiu do campo pra mão
   continuaria sendo "aquela" Ashaya. A virada no campo mantém o `uid`,
   porque os outros precisam apontar pra ela (bloquear, matar). */
import { HIDDEN_ZONES, ZONES, type Table, type TableCard, type Zone } from "../../front/src/pages/deckbuilder/tableRules";
import type { Card } from "../../front/src/pages/deckbuilder/types";
import type { TableView } from "./protocol";

const NONE: ReadonlySet<number> = new Set();

export function canSee(seat: number | null, zone: Zone, c: TableCard, looking: boolean,
                       peeked: ReadonlySet<number> = NONE) {
  const mine = seat !== null && c.owner === seat;
  if (zone === "baralho") return mine && (looking || peeked.has(c.uid));
  if (zone === "mao") return mine;
  return !c.faceDown || mine;
}

const hiddenCard = (uid: number, owner: number): TableCard => ({
  uid, owner, card: null, faceDown: true, tapped: false, backUp: false, counters: {},
  attacking: false, blocking: null, token: false, commander: false,
});

/* A visão, e as cartas que ela deixa ver (por `uid`). As cartas vão à parte
   porque não mudam: quem guarda a conexão manda cada uma uma vez só. */
export function viewFor(t: Table, seat: number | null, looking: boolean, peeked: ReadonlySet<number> = NONE) {
  const visible = new Map<number, Card>();
  let masked = 0;
  const players = t.players.map((player) => {
    const out = { ...player, plays: player.index === seat ? player.plays : [] };
    for (const zone of ZONES) {
      out[zone] = player[zone].map((c) => {
        if (!canSee(seat, zone, c, looking, peeked)) {
          // Escondida em mão ou baralho: nem o `uid`. Virada no campo: o
          // `uid` e o estado ficam, só a carta sai.
          return HIDDEN_ZONES.includes(zone) ? hiddenCard(-++masked, c.owner) : { ...c, card: null };
        }
        if (c.card) visible.set(c.uid, c.card);
        return { ...c, card: null };
      });
    }
    return out;
  });
  const view: TableView = {
    players, active: t.active, turn: t.turn, log: t.log, logOpen: false, arts: t.arts,
  };
  return { view, visible };
}
