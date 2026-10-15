/* A casca da sala: o Durable Object que segura os sockets e guarda a sala.

   Uma mesa é UM objeto (pelo id da sala na URL), e o Cloudflare garante que
   só existe uma cópia dele no mundo — é isso que faz dele o lugar onde a
   jogada acontece. As regras são as de `tableRules.ts`, as mesmas da tela;
   o que é de sala mora em `room.ts`. Aqui fica só o encanamento.

   HIBERNAÇÃO. Os sockets são aceitos pela API de hibernação
   (`ctx.acceptWebSocket`): mesa parada, com todo mundo pensando na jogada,
   não segura o objeto acordado — e não é cobrada por isso. O preço é que a
   memória pode sumir entre duas mensagens, e por isso a sala é relida do
   armazenamento quando falta e gravada a cada jogada. O que se perde ao
   hibernar é só a lista de cartas que cada conexão já recebeu; a próxima
   mensagem manda todas de novo, e o navegador junta.

   A MESA SOME SOZINHA um dia depois da última jogada (`alarm`): sala é
   partida, não arquivo, e o link de uma partida de semana passada não
   precisa abrir nada. */
import { DurableObject } from "cloudflare:workers";
import { tableDeckFrom, type TableDeck } from "../../front/src/pages/deckbuilder/tableRules";
import type { User } from "./auth";
import type { Env } from "./index";
import { parseClientMessage, type ServerMessage } from "./protocol";
import { loadRoom, Room, saveRoom } from "./room";

const IDLE_MS = 24 * 60 * 60 * 1000;
const MESSAGE_LIMIT = 4096;

/* As categorias fora da conta do deck. É a mesma lista de `OUT_OF_COUNT`
   (`front/src/pages/deckbuilder/state.ts`), que não dá pra importar daqui:
   o `state` traz a tela inteira junto. */
const OUT_OF_COUNT: ReadonlySet<string> = new Set(["Sideboard"]);

/* A sorte da mesa. `crypto` e não `Math.random`: embaralhar é a única coisa
   desta sala que alguém teria motivo pra querer prever. */
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

export class TableRoom extends DurableObject<Env> {
  private room: Room | null = null;
  private known = new Map<WebSocket, Set<number>>();

  private async load() {
    if (!this.room) {
      this.room = new Room(loadRoom(await this.ctx.storage.get<string>("room")), random);
    }
    return this.room;
  }

  private async save() {
    await this.ctx.storage.put("room", saveRoom(this.room!.state));
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  /* A entrada, já conferida pelo Worker (ver `index.ts`): quem é chega no
     cabeçalho, que só o Worker consegue pôr — o objeto não tem endereço
     público. */
  async fetch(request: Request) {
    const user = JSON.parse(request.headers.get("X-Room-User") || "null") as User | null;
    if (!user) return new Response("Sem usuário", { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(user);
    await this.load();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const msg = typeof raw === "string" && raw.length <= MESSAGE_LIMIT ? parseClientMessage(raw) : null;
    if (!msg) return send(ws, { type: "error", message: "Mensagem que a mesa não entende." });
    const user = ws.deserializeAttachment() as User;
    const room = await this.load();

    let error: string | null;
    if (msg.type === "sit") {
      // A conferência antes da busca poupa a ida ao site; `sit` confere de
      // novo depois, porque outra pessoa pode ter sentado enquanto o deck
      // chegava.
      if (room.seatOf(user.id) !== null) error = "Você já está sentado nesta mesa.";
      else if (room.isFull()) error = "A mesa está cheia.";
      else {
        const deck = await this.fetchDeck(msg.deckId);
        error = deck ? room.sit(user.id, user.name, msg.deckId, deck) : "Não achei esse deck no site.";
      }
    } else if (msg.type === "restart") {
      const decks = await Promise.all(room.state.seats.map((s) => this.fetchDeck(s.deckId)));
      error = decks.every(Boolean)
        ? room.restart(user.id, decks as TableDeck[]) : "Não deu pra buscar todos os decks.";
    } else {
      error = room.handle(user.id, msg);
    }
    if (error) return send(ws, { type: "error", message: error });
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws: WebSocket) {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.leave(ws);
  }

  /* Quem fecha a última aba sai da mesa — mas não do assento. */
  private async leave(ws: WebSocket) {
    this.known.delete(ws);
    const user = ws.deserializeAttachment() as User;
    const room = await this.load();
    const stillHere = this.sockets().some((w) => w !== ws && (w.deserializeAttachment() as User).id === user.id);
    if (!stillHere && room.release(user.id)) await this.save();
    this.broadcast(ws);
  }

  async alarm() {
    if (this.sockets().length) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  private sockets() {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }

  /* Cada conexão recebe a visão do assento dela. `closing` é o socket que
     está saindo, que ainda pode aparecer na lista. */
  private broadcast(closing?: WebSocket) {
    const room = this.room!;
    const open = this.sockets().filter((w) => w !== closing);
    const connected = new Set(open.map((w) => (w.deserializeAttachment() as User).id));
    for (const ws of open) {
      let known = this.known.get(ws);
      if (!known) this.known.set(ws, known = new Set());
      send(ws, room.messageFor({ userId: (ws.deserializeAttachment() as User).id, known }, connected));
    }
  }

  /* O deck vem do SITE, pelo id, e não do navegador de quem senta: as
     cartas de uma mesa compartilhada são desenhadas no navegador dos outros,
     e uma URL de imagem escolhida por um jogador seria um jeito de descobrir
     o IP de quem está na mesa. As do site são as da base de cartas. */
  private async fetchDeck(id: string): Promise<TableDeck | null> {
    const base = this.env.SITE_URL.replace(/\/+$/, "");
    try {
      const [deck, arts] = await Promise.all([
        fetch(`${base}/decks/${id}`),
        fetch(`${base}/decks/${id}/artes`),
      ]);
      if (!deck.ok) return null;
      // Sem as escolhas o deck entra com as artes padrão, como na tela.
      const choices = arts.ok ? ((await arts.json()) as { escolhas?: Record<string, unknown> }).escolhas : undefined;
      return tableDeckFrom(await deck.json(), OUT_OF_COUNT, id, choices);
    } catch {
      return null;
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  try { ws.send(JSON.stringify(msg)); } catch { /* socket fechando: a próxima conexão recebe tudo */ }
}
