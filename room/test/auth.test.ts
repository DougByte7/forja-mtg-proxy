/* -------------------------------------------------------------------------
   A conferência do token do Clerk na porta da sala.

   As regras são as de `app/clerk.py`, e este teste confere que a porta da
   sala não é mais frouxa do que a do site: assinatura, validade, origem e
   sessão pendente. As chaves são geradas aqui — o Clerk não entra.
   ------------------------------------------------------------------------- */
import { importKey, parseOrigins, verifyToken } from "../src/auth";

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const NOW = 1_800_000_000;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (x: object) => b64url(new TextEncoder().encode(JSON.stringify(x)));

let pair: CryptoKeyPair;
let pem: string;

beforeAll(async () => {
  pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey) as ArrayBuffer);
  const body = btoa(String.fromCharCode(...spki)).match(/.{1,64}/g)!.join("\n");
  pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
});

async function token(claims: object, signer = pair.privateKey, alg = "RS256") {
  const head = `${b64json({ alg, typ: "JWT" })}.${b64json(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(head)));
  return `${head}.${b64url(sig)}`;
}

const base = { sub: "user_1", exp: NOW + 60, nbf: NOW - 1, azp: "https://forja.example", name: "Ana" };
const origins = parseOrigins("https://forja.example/, http://localhost:5173");

async function check(claims: object, opts: { signer?: CryptoKey; alg?: string } = {}) {
  const key = await importKey(pem);
  return verifyToken(await token(claims, opts.signer, opts.alg), key, origins, NOW);
}

describe("a chave", () => {
  it("aceita o PEM do jeito que ele chega colado", async () => {
    const oneLine = pem.replace(/\n/g, "\\n");
    const spaces = pem.replace(/\n/g, " ");
    const bare = pem.replace(/-----[A-Z ]+-----/g, "");
    const quoted = `"${pem}"`;
    const keys = await Promise.all([oneLine, spaces, bare, quoted].map(importKey));
    expect(keys.every((k) => k.type === "public")).toBe(true);
  });

  it("aceita o JWKS em JSON", async () => {
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const key = await importKey(JSON.stringify({ keys: [jwk] }));
    expect(await verifyToken(await token(base), key, origins, NOW)).toEqual({ user: { id: "user_1", name: "Ana" } });
  });

  it("diz qual foi o engano quando colaram a API key", async () => {
    await expect(importKey("sk_live_abc")).rejects.toThrow(/API key/);
    await expect(importKey("")).rejects.toThrow(/CLERK_JWT_KEY/);
  });
});

describe("o token", () => {
  it("o token bom entra, com o id antigo quando a conta é de antes do Clerk", async () => {
    expect(await check(base)).toEqual({ user: { id: "user_1", name: "Ana" } });
    expect(await check({ ...base, forja_id: "u42" })).toEqual({ user: { id: "u42", name: "Ana" } });
  });

  it("sem nome, vai o começo do e-mail — e nunca o e-mail inteiro", async () => {
    expect(await check({ ...base, name: "", email: "Ana.Souza@Gmail.com" }))
      .toEqual({ user: { id: "user_1", name: "ana.souza" } });
  });

  it("recusa vencido, adiantado, de outra origem, pendente e sem sub", async () => {
    const results = await Promise.all([
      check({ ...base, exp: NOW - 10 }),
      check({ ...base, nbf: NOW + 10 }),
      check({ ...base, azp: "https://outro.example" }),
      check({ ...base, sts: "pending" }),
      check({ ...base, sub: "" }),
    ]);
    expect(results.map((r) => "error" in r)).toEqual([true, true, true, true, true]);
  });

  it("a folga de cinco segundos vale pros dois lados", async () => {
    const results = await Promise.all([check({ ...base, exp: NOW - 4 }), check({ ...base, nbf: NOW + 4 })]);
    expect(results.map((r) => "user" in r)).toEqual([true, true]);
  });

  it("recusa assinatura de outra chave, algoritmo trocado e lixo", async () => {
    const other = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]) as CryptoKeyPair;
    const key = await importKey(pem);
    const forged = await check(base, { signer: other.privateKey });
    const noneAlg = await check(base, { alg: "none" });
    const garbage = await verifyToken("a.b.c", key, origins, NOW);
    expect(["error" in forged, "error" in noneAlg, "error" in garbage]).toEqual([true, true, true]);
  });

  it("sem origens configuradas, a origem não é conferida", async () => {
    const key = await importKey(pem);
    const r = await verifyToken(await token({ ...base, azp: "https://qualquer.example" }), key, new Set(), NOW);
    expect("user" in r).toBe(true);
  });
});
