/* =========================================================================
   FOIL, CÓPIA A CÓPIA

   A laminação é da FOLHA: o foil sai num vinil holográfico que cobre a folha
   inteira. Então o deck com algumas cartas foil vira dois pedidos — o foil e
   o resto —, pagos num Pix só (ver `artes._montar` e `main.create_order`). O
   que se escolhe aqui é QUAIS cópias vão pro foil; a laminação do resto se
   escolhe na tela do pedido.

   POR CÓPIA, E NÃO POR FACE. Frente e verso são a mesma carta: a de duas
   faces marcada no foil sai com os dois lados no foil. Por isso o foil se
   marca na frente, e o verso só mostra o que a frente decidiu
   (`BACK_FOLLOWS_FRONT`). Por cópia porque as 30 Florestas podem ter 3 foil
   — o número da cópia é o mesmo da arte por cópia (ver `artes.py`).

   TABELA PRÓPRIA NO SERVIDOR (`cartas_foil`), separada das artes: trocar a
   arte não pode desmarcar o foil. O que se grava é a lista inteira das
   cópias foil de uma carta, que é o que o contador da galeria produz.
   ========================================================================= */
import { artKey, artName, artState, paperQuantity } from "./art";
import { api } from "./save";
import { state, touch } from "./state";
import type { Card } from "./types";
import { toast } from "./ui/toast";

export const BACK_FOLLOWS_FRONT = "O verso acompanha a frente: marque o foil na frente da carta.";

/* As cópias foil da carta que ainda estão no deck: a 30ª Floresta marcada
   continua guardada quando o deck desce pra 20, mas não vai pro papel. */
export function foilCopies(card: Card): number[] {
  const quantity = paperQuantity(card);
  return (artState.foil[artKey(artName(card))] || []).filter((n) => n <= quantity);
}

export function isFoilCopy(card: Card, copy: number) {
  return foilCopies(card).includes(copy);
}

/* Quantas das `copies` saem no foil. */
export function foilCountOf(card: Card, copies: number[]) {
  const marked = foilCopies(card);
  return copies.filter((n) => marked.includes(n)).length;
}

/* Grava as cópias foil de uma carta. Muda a tela na hora e desfaz se o
   servidor recusar: o clique no ✦ tem que responder sem esperar a rede. */
export async function setFoilCopies(card: Card, copies: number[]) {
  if (!state.id) return toast("Salve o deck antes de marcar foil.");
  const key = artKey(artName(card));
  const before = artState.foil[key] || [];
  const after = [...new Set(copies)].sort((a, b) => a - b);
  artState.foil[key] = after;
  touch();
  try {
    await api(`/decks/${state.id}/foil`, { method: "PUT", body: { nome: artName(card), copias: after } });
  } catch (e) {
    artState.foil[key] = before;
    touch();
    toast("Não consegui guardar o foil: " + (e as Error).message);
  }
}

/* O contador de um quadro: das `group` (as cópias que o quadro representa),
   as `count` primeiras no foil e o resto fora. As cópias dos outros quadros
   da mesma carta ficam como estão. */
export function setFoilCountOf(card: Card, group: number[], count: number) {
  const others = foilCopies(card).filter((n) => !group.includes(n));
  return setFoilCopies(card, [...others, ...group.slice(0, Math.max(0, count))]);
}

/* Tudo de uma carta no foil, ou nada. */
export function setAllFoil(card: Card, on: boolean) {
  const all = Array.from({ length: paperQuantity(card) }, (_, i) => i + 1);
  return setFoilCopies(card, on ? all : []);
}
