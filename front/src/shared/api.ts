/* Conversa com a API da Forja.

   O erro do FastAPI chega como `{"detail": "..."}`, e é essa frase — escrita
   pra quem usa a tela — que vira a mensagem do `Error`. Resposta sem JSON
   cai no "Erro <status>", a não ser que a tela peça `errorText`: aí o corpo
   em texto vira a mensagem (é o que a lista de decks fazia, pra mostrar a
   frase das rotas que respondem texto puro). */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ApiOptions = {
  method?: string;
  body?: unknown;
  /** Sem cache do navegador: pra o que muda a cada visita (sessão, decks). */
  noStore?: boolean;
  /** Erro sem `detail` mostra o corpo em texto em vez de "Erro <status>". */
  errorText?: boolean;
  headers?: Record<string, string>;
};

async function request(url: string, opts: ApiOptions): Promise<Response> {
  const init: RequestInit = {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
  };
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body instanceof FormData) {
    init.body = opts.body;   // o navegador põe o Content-Type com o boundary
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  init.headers = headers;
  if (opts.noStore) init.cache = "no-store";

  const r = await fetch(url, init);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let detail = "";
    try {
      const data = JSON.parse(text);
      if (typeof data?.detail === "string") detail = data.detail;
    } catch { /* não era JSON */ }
    throw new ApiError(
      detail || (opts.errorText && text) || `Erro ${r.status}`, r.status);
  }
  return r;
}

/** Resposta em JSON (`null` pra 204 ou corpo vazio). */
export async function api<T = unknown>(url: string, opts: ApiOptions = {}): Promise<T> {
  const r = await request(url, opts);
  const text = r.status === 204 ? "" : await r.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(`Resposta inesperada do servidor (${r.status})`, r.status);
  }
}

/** Resposta em texto puro (a decklist, por exemplo). */
export async function apiText(url: string, opts: ApiOptions = {}): Promise<string> {
  return (await request(url, opts)).text();
}
