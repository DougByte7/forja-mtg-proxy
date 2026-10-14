/* Conversa com a API da Forja.

   O erro do FastAPI chega como `{"detail": "..."}`, e é essa frase — escrita
   pra quem usa a tela — que vira a mensagem do `Error`. Resposta sem JSON
   (um 502 da plataforma, por exemplo) cai no "Erro <status>". */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Options = {
  method?: string;
  body?: unknown;
  /** Sem cache do navegador: pra o que muda a cada visita (sessão, decks). */
  noStore?: boolean;
};

export async function api<T = unknown>(url: string, opts: Options = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body === undefined ? "GET" : "POST") };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  if (opts.noStore) init.cache = "no-store";

  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : "";
    throw new ApiError(detail || `Erro ${r.status}`, r.status);
  }
  return data as T;
}

/* Quem está logado. `null` pra anônimo — a rota responde 200 nos dois casos
   (ver `conta_atual` no `main.py`). */
export type User = { login: string; [k: string]: unknown };

export async function currentUser(): Promise<User | null> {
  const data = await api<{ usuario: User | null }>("/conta", { noStore: true });
  return data.usuario;
}
