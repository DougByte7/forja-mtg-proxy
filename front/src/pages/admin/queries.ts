import { queryOptions } from "@tanstack/preact-query";
import { adminApi } from "./adminApi";
import type { DeckList, OrderList, Session, Stock } from "./types";

/* Todas as chaves começam com "admin" e levam o token: trocar de token é
   outra sessão, e nada do cache da anterior pode aparecer.

   Sem reler ao voltar o foco pra aba: quem atualiza é o intervalo do painel,
   que para enquanto há confirmação aberta ou ação andando. Redesenhar a lista
   embaixo de um clique é a melhor forma de imprimir o pedido errado. */
const base = { refetchOnWindowFocus: false } as const;

export const sessionQuery = (token: string) => queryOptions({
  ...base,
  queryKey: ["admin", token, "sessao"],
  queryFn: () => adminApi<Session>("/admin/sessao"),
  retry: false,
});

export const ordersQuery = (token: string, status: string, search: string) => queryOptions({
  ...base,
  queryKey: ["admin", token, "pedidos", status, search],
  queryFn: () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (search) params.set("busca", search);
    return adminApi<OrderList>("/admin/pedidos?" + params);
  },
});

export const decksQuery = (token: string, search: string) => queryOptions({
  ...base,
  queryKey: ["admin", token, "decks", search],
  queryFn: () => adminApi<DeckList>("/admin/decks?" + new URLSearchParams(search ? { busca: search } : {})),
});

export const stockQuery = (token: string) => queryOptions({
  ...base,
  queryKey: ["admin", token, "estoque"],
  queryFn: () => adminApi<Stock>("/admin/estoque"),
});
