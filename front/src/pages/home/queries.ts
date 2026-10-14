import { queryOptions } from "@tanstack/preact-query";
import { api } from "../../shared/api";
import type { QuoteResult } from "./quote";
import type { Prices } from "./totals";

/** Os preços por página que `POST /orders` cobra. */
export const pricesQuery = queryOptions({
  queryKey: ["precos"],
  queryFn: () => api<Partial<Prices>>("/precos", { noStore: true }),
  retry: false,
});

export type Ink = {
  estado: string; nivel?: number;
  marcadores?: { nome?: string; nivel?: number }[];
};

/** O nível de tinta. Silencioso de propósito: isto é recado, não serviço. */
export const inkQuery = queryOptions({
  queryKey: ["tinta"],
  queryFn: () => api<Ink>("/impressora/tinta"),
  retry: false,
});

export type DeckSummary = {
  nome: string; comandantes: string[]; identidade?: string; total: number; arte?: string | null;
};
export type DeckOrder = {
  deck: DeckSummary;
  xml?: string | null;
  faltando: { nome: string; ficha?: boolean; face?: string }[];
};

export const deckOrderQuery = (id: string) => queryOptions({
  queryKey: ["deck-pedido", id],
  queryFn: () => api<DeckOrder>(`/decks/${encodeURIComponent(id)}/pedido`, { noStore: true }),
  retry: false,
  staleTime: Infinity,
});

export type QuoteJob = {
  estado: "cotando" | "pronto" | "erro";
  job_id?: string;
  resultado?: QuoteResult;
  detalhe?: string;
  cartas?: number; feitas?: number; total?: number; decorrido?: number;
};

/** O andamento de uma cotação, relido a cada 2 s enquanto ela anda. */
export const quoteJobQuery = (jobId: string) => queryOptions({
  queryKey: ["cotacao", jobId],
  queryFn: () => api<QuoteJob>(`/cotacao/${jobId}`),
  retry: false,
  refetchInterval: (q) => q.state.data?.estado === "cotando" ? 2000 : false,
  refetchOnWindowFocus: false,
});
