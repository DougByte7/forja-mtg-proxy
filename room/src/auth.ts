/* Quem está entrando na sala, pelo token de sessão do Clerk.

   A MESMA CONFERÊNCIA DO SITE (`app/clerk.py`), com a mesma configuração:
   `CLERK_JWT_KEY` é a chave pública da instância (PEM, só o miolo base64, ou
   o JWKS em JSON) e `CLERK_ORIGENS` são as telas que podem ter pedido o
   token (`azp`). Conferir é matemática com a chave pública — nenhuma ida ao
   Clerk por conexão.

   O token vive um minuto, e isso basta: ele é conferido UMA vez, na
   abertura do socket. Quem já entrou continua dentro enquanto a conexão
   durar, como numa mesa em que ninguém pede documento a cada jogada.

   O token chega na URL (`?token=`) porque o navegador não deixa pôr
   cabeçalho num WebSocket. É o motivo de ele viver só um minuto não ser
   detalhe: URL acaba em log. */

export interface User {
  id: string;
  name: string;
}

const LEEWAY_SECONDS = 5;

/* --------------------------------------------------------------- a chave */

/* Aceita o PEM do jeito que ele costuma chegar depois de copiado e colado —
   com quebras, com `\n` escrito, com as quebras viradas espaço, entre aspas,
   ou só o miolo — e o JWKS em JSON. Como no `carregar_chave` do site. */
export async function importKey(raw: string): Promise<CryptoKey> {
  const text = raw.trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").trim();
  if (!text) throw new Error("sem CLERK_JWT_KEY");
  if (/^(pk|sk)_(test|live)_/.test(text)) {
    throw new Error("CLERK_JWT_KEY tem uma API key do Clerk (pk_/sk_...), não a chave pública JWKS");
  }
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  if (text.startsWith("{")) {
    const data = JSON.parse(text);
    const jwk = Array.isArray(data.keys) ? data.keys[0] : data;
    return crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  }
  const body = text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  return crypto.subtle.importKey("spki", base64Bytes(body), algorithm, false, ["verify"]);
}

/* ------------------------------------------------------------- a origem */

/** `CLERK_ORIGENS` separadas por vírgula, sem a barra do fim. */
export function parseOrigins(raw: string | undefined) {
  return new Set((raw || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean));
}

/* ------------------------------------------------------------- o token */

/* O usuário do token, ou o motivo de recusá-lo. As regras são as do site:
   RS256, `exp`/`nbf`/`sub` obrigatórios, cinco segundos de folga pro relógio,
   `azp` dentro das origens (quando há origens configuradas e o token traz
   uma), e sessão `pending` não vale. O id é o `forja_id` quando a conta é de
   antes do Clerk — é o mesmo id que o site usa como dono dos decks. */
export async function verifyToken(
  token: string, key: CryptoKey, origins: ReadonlySet<string>, now = Date.now() / 1000,
): Promise<{ user: User } | { error: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) return { error: "token malformado" };
  let header: any, claims: any;
  try {
    header = JSON.parse(base64Text(parts[0]));
    claims = JSON.parse(base64Text(parts[1]));
  } catch {
    return { error: "token malformado" };
  }
  if (header.alg !== "RS256") return { error: `algoritmo ${header.alg} recusado` };
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64Bytes(parts[2]), signed);
  } catch {
    ok = false;
  }
  if (!ok) return { error: "assinatura inválida" };
  if (typeof claims.exp !== "number" || typeof claims.nbf !== "number" || !claims.sub) {
    return { error: "token sem exp, nbf ou sub" };
  }
  if (now > claims.exp + LEEWAY_SECONDS) return { error: "token vencido" };
  if (now < claims.nbf - LEEWAY_SECONDS) return { error: "token ainda não vale" };
  const azp = String(claims.azp || "").replace(/\/+$/, "");
  if (origins.size && azp && !origins.has(azp)) return { error: `origem ${azp} fora de CLERK_ORIGENS` };
  if (claims.sts === "pending") return { error: "sessão pendente no Clerk" };
  const email = String(claims.email || "").trim().toLowerCase();
  return {
    user: {
      id: String(claims.forja_id || claims.sub),
      name: String(claims.name || "").trim() || email.split("@")[0] || "Sem nome",
    },
  };
}

/* ------------------------------------------------------------- base64url */

function base64Bytes(text: string) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function base64Text(text: string) {
  return new TextDecoder().decode(base64Bytes(text));
}
