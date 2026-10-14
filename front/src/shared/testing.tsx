/* Utilidades dos testes: renderizar dentro de um QueryClient novo (sem
   tentar de novo, pra erro aparecer na hora) e fingir o `fetch`. */
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { render } from "@testing-library/preact";
import type { ComponentChildren } from "preact";

export function renderWithQuery(ui: ComponentChildren) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Reply = [number, unknown] | [number, unknown, "text"];

/** `handler` recebe método e URL e devolve `[status, corpo]`. */
export function mockFetch(handler: (method: string, url: string, body: any) => Reply) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = parseBody(init?.body);
    const [status, data, kind] = handler(method, url, body);
    const text = kind === "text" ? String(data) : JSON.stringify(data);
    return new Response(status === 204 ? null : text, { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/* JSON vira objeto; formulário vira objeto também, campo a campo. */
function parseBody(body: BodyInit | null | undefined) {
  if (!body) return undefined;
  if (body instanceof FormData) return Object.fromEntries(body as unknown as Iterable<[string, string]>);
  return JSON.parse(body as string);
}

/** O corpo da primeira chamada a `method url`. */
export function sentBody(fetch: ReturnType<typeof mockFetch>, method: string, url: string) {
  const call = fetch.mock.calls.find(
    ([u, init]) => u === url && (init?.method ?? "GET") === method);
  return parseBody(call?.[1]?.body);
}

/** Os cabeçalhos da primeira chamada a `url`. */
export function sentHeaders(fetch: ReturnType<typeof mockFetch>, url: string) {
  const call = fetch.mock.calls.find(([u]) => u === url);
  return (call?.[1]?.headers ?? {}) as Record<string, string>;
}
