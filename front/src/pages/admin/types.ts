/* O que as rotas `/admin/*` devolvem, do jeito que a tela usa. */

export type OrderStatus =
  | "pending" | "notified" | "a_imprimir" | "imprimindo"
  | "impresso" | "erro_impressao" | "cancelado";

export type Order = {
  id: string;
  status: OrderStatus;
  customer_name: string;
  amount: number;
  deck_hash?: string;
  qty: number;
  pages: number;
  blanks: number;
  lamination: string;
  created_at: number;
  notified_at?: number | null;
  impresso_em?: number | null;
  impressao_em?: number | null;
  impressao_msg?: string | null;
  impressao_falhas?: number;
};

export type OrderList = { pedidos: Order[]; contagem: Record<string, number> };

export type AdminDeck = {
  id: string;
  nome: string;
  comandantes: string[];
  arte?: string | null;
  atualizado_em: number;
  total: number;
  faltam: number;
  dono?: string | null;
};

export type DeckList = { decks: AdminDeck[]; contagem: { total?: number; sem_dono?: number } };

export type Session = {
  impressora?: string | null;
  worker?: { visto_em?: number | null; offline_segundos: number } | null;
};

export type StockItem = {
  id: string; nome: string; unidade: string; quantidade: number;
  minimo: number; custo_unitario: number; baixo: boolean;
};
export type SheetCost = Record<"papel" | "plastico" | "tinta" | "total" | "cobrado" | "margem", number>;
export type Ink = {
  cor: string; nome: string; preco_garrafa: number; ml_garrafa: number;
  ml_por_folha: number; custo_folha: number;
};
export type StockMove = {
  item: string; motivo: string; delta: number; saldo: number;
  referencia?: string | null; criado_em: number;
};
export type Stock = {
  itens: StockItem[];
  custo_folha: Record<"single" | "double" | "foil", SheetCost>;
  config: Record<string, number>;
  tintas: Ink[];
  movimentos: StockMove[];
};

/** Um pedido (ou combinação) lido enquanto a impressora trabalha. */
export type QueueState = Pick<Order, "status" | "impressao_msg" | "impressao_falhas">;

export type ComboMapEntry = {
  id: string; customer_name?: string; cartas: number;
  primeira_pagina: number; ultima_pagina: number; inicio: number; fim: number;
};
export type Combo = { id: string; mapa: ComboMapEntry[]; brancos_evitados: number };
