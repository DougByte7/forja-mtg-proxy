/* A porta da sala: `wss://<worker>/rooms/<id>?token=<sessão do Clerk>`.

   O Worker confere quem é e de onde vem ANTES de acordar a sala: conexão
   recusada aqui não custa Durable Object nenhum. A sala nasce no primeiro
   que entra com aquele id — o id é a URL, e quem tem o link entra (como o
   link de um deck). */
import { importKey, parseOrigins, verifyToken } from "./auth";
import { TableRoom } from "./durable";

export { TableRoom };

export interface Env {
  ROOMS: DurableObjectNamespace<TableRoom>;
  /** A chave pública da instância do Clerk, a mesma do site. */
  CLERK_JWT_KEY: string;
  /** As telas que podem abrir a sala, separadas por vírgula. */
  CLERK_ORIGENS?: string;
  /** O site, de onde vêm os decks (`GET /decks/{id}`). */
  SITE_URL: string;
}

/* A chave importada uma vez por isolate: é a mesma pra toda conexão. */
let key: { raw: string; key: Promise<CryptoKey> } | null = null;

function clerkKey(raw: string) {
  if (!key || key.raw !== raw) key = { raw, key: importKey(raw) };
  return key.key;
}

const ROOM_PATH = /^\/rooms\/([A-Za-z0-9_-]{8,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH);
    if (!match) return new Response("Não encontrado.", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("A sala só fala WebSocket.", { status: 426 });
    }
    // Sem isto, qualquer página aberta no navegador de alguém logado poderia
    // abrir a sala em nome dele. O token também diz a origem (`azp`), mas a
    // conferência do cabeçalho é a que o navegador garante.
    const origins = parseOrigins(env.CLERK_ORIGENS);
    if (origins.size && !origins.has(request.headers.get("Origin") || "")) {
      return new Response("Origem recusada.", { status: 403 });
    }
    let checked;
    try {
      checked = await verifyToken(url.searchParams.get("token") || "", await clerkKey(env.CLERK_JWT_KEY), origins);
    } catch (e) {
      console.error("clerk", (e as Error).message);
      return new Response("Conta desligada na sala.", { status: 503 });
    }
    if ("error" in checked) {
      console.warn("token recusado:", checked.error);
      return new Response("Entre na sua conta pra abrir a mesa.", { status: 401 });
    }
    const headers = new Headers(request.headers);
    headers.set("X-Room-User", JSON.stringify(checked.user));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
