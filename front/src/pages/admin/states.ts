import type { OrderStatus } from "./types";

export const ORDER_STATES: Record<OrderStatus, string> = {
  pending: "Aguardando pagamento",
  notified: "Avisou que pagou",
  a_imprimir: "Na fila da impressora",
  imprimindo: "Imprimindo",
  impresso: "Impresso",
  erro_impressao: "Erro na impressão",
  cancelado: "Cancelado",
};

export const LAMINATION: Record<string, string> = {
  single: "Um lado", double: "Dois lados", foil: "Foil",
};
