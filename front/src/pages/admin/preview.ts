/* A prévia de folhas da barra de combinar.

   Pedido pequeno desperdiça papel: 4 cartas ocupam uma folha inteira e
   deixam 5 slots em branco. Marcando vários, as filas de impressão deles
   viram uma fila corrida e só a última folha do conjunto sai incompleta.

   O que a barra mostra é o SLOT EM BRANCO que deixou de existir, não só a
   folha: a folha é o branco arredondado pra baixo (nove brancos = uma folha),
   e por isso dois pedidos nunca economizam mais que uma.

   É uma PRÉVIA, feita com o que a listagem já trouxe, pra barra responder na
   hora que se marca uma caixinha. Quem decide de verdade é o backend
   (`calc.resumo_combinado`), que refaz a mesma conta ao criar a combinação.
   Duas implementações da mesma regra é onde a divergência se esconde: os
   casos de `preview.cases.json` passam pelas duas (`preview.test.ts` aqui e
   `tests/test_combos.py` lá). */
import type { Order } from "./types";

export const SHEET_CARD_COUNT = 9;

type Sized = Pick<Order, "pages" | "blanks">;

/** Quantas cartas o pedido põe na fila. `pages * 9 - blanks` é exatamente o
    que o backend gravou como qty + versos na hora de cobrar. */
export const slotsOf = (p: Sized) =>
  Math.max(0, (Number(p.pages) || 0) * SHEET_CARD_COUNT - (Number(p.blanks) || 0));

export function localSummary(list: Sized[]) {
  const cards = list.reduce((n, p) => n + slotsOf(p), 0);
  const separate = list.reduce((n, p) => n + (Number(p.pages) || 0), 0);
  const separateBlanks = list.reduce((n, p) => n + Math.max(0, Number(p.blanks) || 0), 0);
  const combined = Math.ceil(cards / SHEET_CARD_COUNT);
  const rest = cards % SHEET_CARD_COUNT;
  const blanks = rest ? SHEET_CARD_COUNT - rest : 0;
  return {
    cards, separate, combined, separateBlanks, blanks,
    blanksSaved: Math.max(0, separateBlanks - blanks),
    sheetsSaved: Math.max(0, separate - combined),
  };
}

/** Na mesma ordem que o backend usa pra imprimir: do mais antigo pro mais novo. */
export const printOrder = <T extends Pick<Order, "id" | "created_at">>(list: T[]) =>
  list.slice().sort((a, b) => (a.created_at - b.created_at) || (a.id < b.id ? -1 : 1));

/** A chave identifica a SELEÇÃO, não a ordem do clique — igual ao id que o
    backend deriva do conjunto. É com ela que se sabe se a combinação já
    criada ainda corresponde ao que está marcado agora. */
export const selectionKey = (ids: Iterable<string>) => [...ids].sort().join(",");
