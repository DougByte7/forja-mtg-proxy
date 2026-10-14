/* A conta do pedido. A MESMA do `app/calc.py` — usada tanto no resumo
   quanto no rodapé da revisão, pra os dois nunca discordarem. */

export const CARDS_PER_PAGE = 9;

export type Lamination = "single" | "double" | "foil";
export type Prices = Record<Lamination, number>;

/** Reais por página. Valem até `GET /precos` responder com os de verdade. */
export const DEFAULT_PRICES: Prices = { single: 2.50, double: 3.3333, foil: 8.00 };

export const LAMINATION_LABELS: Record<Lamination, string> = {
  single: "Um lado", double: "Dois lados", foil: "Foil",
};

export function computeTotals(qty: number, backsCount: number, lam: Lamination, prices: Prices) {
  const slotsNeeded = qty + backsCount;
  const pages = Math.ceil(slotsNeeded / CARDS_PER_PAGE);
  const rest = slotsNeeded % CARDS_PER_PAGE;
  const lastPageFilled = rest === 0 ? CARDS_PER_PAGE : rest;
  const blanks = rest === 0 ? 0 : CARDS_PER_PAGE - lastPageFilled;
  const total = Math.round(pages * prices[lam] * 100) / 100;
  return { slotsNeeded, pages, lastPageFilled, blanks, total, lamLabel: LAMINATION_LABELS[lam] || lam };
}

export const brl = (n: number) =>
  n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
