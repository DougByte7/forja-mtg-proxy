/* ------------------------------------------------ a mesa compartilhada

   O goldfish com mais gente, pela sala da Cloudflare (`room/`). Aqui fica o
   lado do navegador: abrir o socket, receber a mesa como este assento a vê
   e mandar as jogadas.

   A MESA DA TELA CONTINUA SENDO `state.table`. Online, quem a escreve é a
   sala: cada mensagem traz a visão inteira, e ela vira a mesa desta página.
   O desenho não sabe de onde a mesa veio. A jogada muda de caminho: em vez
   de aplicar a regra aqui, `table.ts` manda a ação pra sala, e a mesa nova
   chega de volta. Nada é aplicado antes da resposta, porque só a sala sabe
   o resultado (quem embaralha é ela, e ela pode recusar a jogada).

   A CARTA CHEGA UMA VEZ. A visão vem com `card: null` em toda cópia, e as
   cartas que esta conexão ainda não tinha vêm à parte (`cards`). Elas ficam
   guardadas aqui, pelo `uid`, enquanto a pessoa estiver na sala. A carta
   escondida chega com `uid` negativo e sem carta nenhuma: é só o verso.

   Os tipos das mensagens são os da própria sala, importados SÓ COMO TIPO:
   `room/` não sobe pra Vercel, e um import de valor quebraria o build lá. */
import { signal } from "@preact/signals";
import type { ClientMessage, SeatInfo, ServerMessage, TableView } from "../../../../room/src/protocol";
import { sessionToken } from "../../shared/clerk";
import { state } from "./state";
import { ZONES, type Table } from "./tableRules";
import type { Card } from "./types";
import { toast } from "./ui/toast";

const ROOM_URL = (import.meta.env.VITE_ROOM_URL as string | undefined) || "wss://forja-mesa.dougbyte7.workers.dev";

export interface Online {
  roomId: string;
  /* `conectando` também é a reconexão: a sala caiu e o navegador está
     tentando de novo. `sem-conta` é quem abriu o link sem estar logado. */
  status: "conectando" | "aberta" | "sem-conta";
  /** O assento desta pessoa; `null` é quem ainda não sentou. */
  seat: number | null;
  seats: SeatInfo[];
  looking: boolean;
  canUndo: boolean;
}

export const online = signal<Online | null>(null);

/* O MODO MESA: a página aberta pelo link de convite (`?mesa=` sem `?deck=`).
   Quem chega por ele vem JOGAR, não montar — e o deckbuilder em volta da mesa
   (busca de comandante, abas, cabeçalho de deck vazio) dizia o contrário: sem
   comandante na tela, a área das abas nem aparece. No modo mesa a página é só
   a mesa (ver `App`), e sair dela leva pros decks da pessoa.

   Quem abre a mesa pelo "Jogar online" do próprio deck continua no
   deckbuilder: a URL dele tem o deck junto. Lido uma vez, antes do primeiro
   desenho — a página não entra nem sai do modo sem recarregar. */
const params = new URLSearchParams(location.search);
export const tableMode = signal(params.has("mesa") && !params.has("deck"));

/* Quem não sentou e escolheu só olhar: a mesa aparece no lugar do lobby (ver
   `TableLobby`). Volta a ser falso ao trocar de sala. */
export const watching = signal(false);

/* O que os testes trocam: de onde vem o token e qual WebSocket abrir. */
export const onlineDeps = {
  token: sessionToken as () => Promise<string | null>,
  WebSocket: (url: string) => new WebSocket(url),
  /** Quem redesenha a mesa (ver `table.ts`). */
  changed: () => {},
};

let socket: WebSocket | null = null;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const cards = new Map<number, Card>();

export const isOnline = () => !!online.value;

/** O assento desta pessoa, ou `null` (fora da sala ou só assistindo). */
export const mySeat = () => online.value?.seat ?? null;

/* Uma sala nova: o id é a URL, e quem tem o link entra. Dezesseis
   caracteres aleatórios não se adivinham. */
export function newRoomId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** O link que se manda pros outros: só a sala, sem o deck de quem criou. */
export function roomLink(roomId: string) {
  return `${location.origin}${location.pathname}?mesa=${roomId}`;
}

/* A sala mora na URL (`?mesa=`), junto do que já estiver lá: recarregar a
   página volta pra mesma mesa, e sair dela tira o parâmetro. */
export function setRoomInUrl(roomId: string | null) {
  const params = new URLSearchParams(location.search);
  if (roomId) params.set("mesa", roomId); else params.delete("mesa");
  const query = params.toString();
  history.replaceState(null, "", location.pathname + (query ? "?" + query : ""));
}

export function joinRoom(roomId: string) {
  leaveRoom(false);
  online.value = { roomId, status: "conectando", seat: null, seats: [], looking: false, canUndo: false };
  watching.value = false;
  state.table = null;
  state.tableUndo = [];
  onlineDeps.changed();
  void connect();
}

async function connect() {
  const room = online.value;
  if (!room) return;
  const token = await onlineDeps.token();
  if (online.value !== room) return;   // saiu ou trocou de sala enquanto esperava
  if (!token) {
    online.value = { ...room, status: "sem-conta" };
    return;
  }
  const ws = onlineDeps.WebSocket(`${ROOM_URL}/rooms/${room.roomId}?token=${encodeURIComponent(token)}`);
  socket = ws;
  ws.onopen = () => { retries = 0; };
  ws.onmessage = (e) => receive(JSON.parse(e.data as string));
  ws.onclose = () => {
    if (socket !== ws || !online.value) return;
    socket = null;
    // Cair é normal (o celular trocou de rede, a aba dormiu): o navegador
    // tenta de novo com um token novo, cada vez esperando um pouco mais.
    online.value = { ...online.value, status: "conectando" };
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); },
                            Math.min(30_000, 1000 * 2 ** retries++));
  };
}

/** Sai da sala e volta pra mesa local, vazia. */
export function leaveRoom(redraw = true) {
  const ws = socket;
  socket = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retries = 0;
  ws?.close();
  cards.clear();
  if (!online.value) return;
  online.value = null;
  state.table = null;
  state.tableUndo = [];
  if (redraw) onlineDeps.changed();
}

export function send(msg: ClientMessage) {
  if (!socket || socket.readyState !== 1) {   // 1: aberto
    toast("A mesa está reconectando. Tente de novo em instantes.");
    return;
  }
  socket.send(JSON.stringify(msg));
}

function receive(msg: ServerMessage) {
  if (msg.type === "error") return toast(msg.message);
  const room = online.value;
  if (!room) return;
  for (const [uid, card] of Object.entries(msg.cards)) cards.set(Number(uid), card);
  state.table = msg.table ? tableFrom(msg.table, state.table) : null;
  online.value = {
    ...room, status: "aberta", seat: msg.seat, seats: msg.seats, looking: msg.looking, canUndo: msg.canUndo,
  };
  onlineDeps.changed();
}

/* A visão vira a mesa da tela: cada cópia com a sua carta, do que já
   chegou. O log aberto é desta tela, não da sala, e passa de uma mesa pra
   outra. */
function tableFrom(view: TableView, previous: Table | null): Table {
  for (const player of view.players) {
    for (const zone of ZONES) {
      for (const c of player[zone]) c.card = c.uid > 0 ? cards.get(c.uid) ?? null : null;
    }
  }
  return { ...view, logOpen: previous?.logOpen ?? false, nextUid: 0, cards: {} };
}
