/* -------------------------------------------------------------------------
   O modelo da folha e as edições da revisão.

   `slots[i]` é a posição i da folha: renumerar é só mexer no array. Os slots
   são imutáveis — toda edição devolve um array novo, e é isso que deixa o
   desfazer guardar só referências.

   Cada edição devolve `{slots}` quando mudou a folha e/ou `{message}` quando
   tem algo a dizer no rodapé (inclusive o motivo de NÃO ter mudado).
   ------------------------------------------------------------------------- */
import { CARDS_PER_PAGE } from "./totals";
import type { CardMeta, Slot } from "./xml";

/** Verso conhecido de cada frente: frontId -> (backId -> meta). Mora à parte
    de propósito: quando o cliente tira o último verso de uma carta, a folha
    esquece que ele existia, mas a linha dele continua na lista com contador
    0 pra dar pra colocar de volta sem desfazer nada. */
export type BackCatalog = Map<string, Map<string, CardMeta>>;

export type BackGroup = { id: string; meta: CardMeta; idx: number[] };
/** Cartas agrupadas pela FRENTE, na ordem da folha. Os versos ficam dentro
    do grupo, cada um com a sua contagem: numa dupla-face dá pra ter 4
    frentes e só 2 versos, e é isso que deixa mexer num sem mexer no outro. */
export type Group = { key: string; front: CardMeta; idx: number[]; backs: Map<string, BackGroup> };

export type Edit = { slots?: Slot[]; message?: string };

export function catalogFrom(slots: Slot[]): BackCatalog {
  const catalog: BackCatalog = new Map();
  for (const s of slots) {
    if (!s.back) continue;
    let m = catalog.get(s.front.id);
    if (!m) { m = new Map(); catalog.set(s.front.id, m); }
    if (!m.has(s.back.id)) m.set(s.back.id, s.back);
  }
  return catalog;
}

export function groupSlots(slots: Slot[]) {
  const map = new Map<string, Group>();
  slots.forEach((slot, i) => {
    let g = map.get(slot.front.id);
    if (!g) {
      g = { key: slot.front.id, front: slot.front, idx: [], backs: new Map() };
      map.set(slot.front.id, g);
    }
    g.idx.push(i);
    if (slot.back) {
      let b = g.backs.get(slot.back.id);
      if (!b) { b = { id: slot.back.id, meta: slot.back, idx: [] }; g.backs.set(slot.back.id, b); }
      b.idx.push(i);
    }
  });
  return map;
}

/** Os grupos da folha, com os versos zerados ainda listados. */
export function sheetGroups(slots: Slot[], catalog: BackCatalog): Group[] {
  const map = groupSlots(slots);
  map.forEach((g, frontId) => {
    (catalog.get(frontId) || new Map()).forEach((meta, backId) => {
      if (!g.backs.has(backId)) g.backs.set(backId, { id: backId, meta, idx: [] });
    });
  });
  return Array.from(map.values());
}

/** A assinatura enxerga frente E verso, pra "tirei um verso" contar como
    revisão e reescrever o XML. */
export const signatureOf = (slots: Slot[]) =>
  slots.map((s) => s.front.id + "||" + (s.back ? s.back.id : "")).join(",");

/* Verso que uma cópia nova deve levar: só herda quando TODAS as cópias de
   agora têm o mesmo verso. Se o cliente já separou frente e verso na mão, a
   cópia nova sai sem verso, em vez de desfazer a escolha. */
function inheritedBack(g: Group) {
  const withBack = Array.from(g.backs.values()).filter((b) => b.idx.length);
  if (withBack.length !== 1) return null;
  return withBack[0].idx.length === g.idx.length ? withBack[0].meta : null;
}

const find = (slots: Slot[], catalog: BackCatalog, key: string) =>
  sheetGroups(slots, catalog).find((g) => g.key === key) || null;

const AT_LEAST_ONE = "O pedido precisa ter pelo menos uma carta.";

export function addCopy(slots: Slot[], catalog: BackCatalog, key: string): Edit {
  const g = find(slots, catalog, key);
  if (!g) return {};
  // A cópia nova entra logo depois da última do mesmo grupo, pra as cópias
  // ficarem juntas na folha em vez de espalhadas.
  const next = slots.slice();
  next.splice(g.idx[g.idx.length - 1] + 1, 0, { front: g.front, back: inheritedBack(g) });
  return { slots: next };
}

export function removeCopy(slots: Slot[], catalog: BackCatalog, key: string): Edit {
  const g = find(slots, catalog, key);
  if (!g) return {};
  if (slots.length <= 1) return { message: AT_LEAST_ONE };
  // Sai primeiro uma cópia SEM verso próprio: tirar uma frente não pode levar
  // junto um verso que o cliente quis manter. Quando todas as cópias têm
  // verso, não tem jeito — o verso é colado na frente.
  const plain = g.idx.filter((i) => !slots[i].back);
  const target = plain.length ? plain[plain.length - 1] : g.idx[g.idx.length - 1];
  const tookBack = !!slots[target].back;
  return {
    slots: slots.filter((_, i) => i !== target),
    message: tookBack ? "Essa cópia tinha verso próprio, então o verso saiu junto com ela." : undefined,
  };
}

export function removeGroup(slots: Slot[], catalog: BackCatalog, key: string): Edit {
  const g = find(slots, catalog, key);
  if (!g) return {};
  if (g.idx.length >= slots.length) return { message: AT_LEAST_ONE };
  const out = new Set(g.idx);
  return { slots: slots.filter((_, i) => !out.has(i)) };
}

/* O verso mora no slot da frente (é assim que o XML do MPC Fill amarra os
   dois), então mexer num verso é trocar o slot inteiro por um igual com
   outro verso — nunca alterar o slot no lugar. */
function withBacks(slots: Slot[], idx: number[], meta: CardMeta | null) {
  const set = new Set(idx);
  return slots.map((s, i) => set.has(i) ? { front: s.front, back: meta } : s);
}

export function addBack(slots: Slot[], catalog: BackCatalog, frontKey: string, backId: string): Edit {
  const g = find(slots, catalog, frontKey);
  const b = g?.backs.get(backId);
  if (!g || !b) return {};
  const free = g.idx.find((i) => !slots[i].back);
  if (free === undefined) {
    return { message: "Cada verso vai colado numa cópia, e todas as cópias já têm o " +
                      "seu. Adicione mais uma cópia pra caber mais um verso." };
  }
  return { slots: withBacks(slots, [free], b.meta) };
}

export function removeBack(slots: Slot[], catalog: BackCatalog, frontKey: string, backId: string): Edit {
  const b = find(slots, catalog, frontKey)?.backs.get(backId);
  if (!b || !b.idx.length) return {};
  return { slots: withBacks(slots, [b.idx[b.idx.length - 1]], null) };
}

export function removeAllBacks(slots: Slot[], catalog: BackCatalog, frontKey: string, backId: string): Edit {
  const b = find(slots, catalog, frontKey)?.backs.get(backId);
  if (!b || !b.idx.length) return {};
  return { slots: withBacks(slots, b.idx, null) };
}

/* ------------------------------------------------------------ impressão */

export type QueueItem =
  | { kind: "front"; meta: CardMeta; frontKey: string }
  | { kind: "back"; meta: CardMeta; frontKey: string; backId: string };

/** Mesma ordem do `_build_print_queue` do backend: as frentes em ordem de
    slot, depois os versos especiais, também em ordem de slot. */
export function printQueue(slots: Slot[]): QueueItem[] {
  const queue: QueueItem[] = slots.map((s) => ({ kind: "front", meta: s.front, frontKey: s.front.id }));
  for (const s of slots) {
    if (s.back) queue.push({ kind: "back", meta: s.back, frontKey: s.front.id, backId: s.back.id });
  }
  return queue;
}

/** A fila cortada em páginas de 9 (sempre pelo menos uma). */
export function pagesOf(slots: Slot[]) {
  const queue = printQueue(slots);
  const count = Math.max(1, Math.ceil(queue.length / CARDS_PER_PAGE));
  return Array.from({ length: count }, (_, p) => queue.slice(p * CARDS_PER_PAGE, (p + 1) * CARDS_PER_PAGE));
}

/* A geometria do `app/pdf_generator.py`: A4, cartas de 63x88 mm numa grade
   3x3 centrada, marcas de corte nas margens e cruzes verdes nos cantos. */
export const PAGE_W_MM = 210, PAGE_H_MM = 297;
export const CARD_W_MM = 63, CARD_H_MM = 88;
export const COLS = 3, ROWS = 3;
export const MARGIN_X_MM = (PAGE_W_MM - CARD_W_MM * COLS) / 2;   // 10,5 mm
export const MARGIN_Y_MM = (PAGE_H_MM - CARD_H_MM * ROWS) / 2;   // 16,5 mm
const CROSS_ARM_MM = 3;

export type GuideLine = { x1: number; y1: number; x2: number; y2: number; color: string };

/** Guias de corte e cruzes, nas mesmas coordenadas em mm que o reportlab usa. */
export const GUIDES: GuideLine[] = (() => {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i <= COLS; i++) xs.push(MARGIN_X_MM + i * CARD_W_MM);
  for (let i = 0; i <= ROWS; i++) ys.push(MARGIN_Y_MM + i * CARD_H_MM);
  const lines: GuideLine[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, color: string) =>
    lines.push({ x1, y1, x2, y2, color });
  // marcas de corte: só nas margens, indo até a borda do papel
  xs.forEach((x) => {
    line(x, 0, x, MARGIN_Y_MM, "#000");
    line(x, PAGE_H_MM - MARGIN_Y_MM, x, PAGE_H_MM, "#000");
  });
  ys.forEach((y) => {
    line(0, y, MARGIN_X_MM, y, "#000");
    line(PAGE_W_MM - MARGIN_X_MM, y, PAGE_W_MM, y, "#000");
  });
  // cruzes verdes em cada canto de carta, por cima da arte
  xs.forEach((x) => ys.forEach((y) => {
    line(x - CROSS_ARM_MM, y, x + CROSS_ARM_MM, y, "#8aff0c");
    line(x, y - CROSS_ARM_MM, x, y + CROSS_ARM_MM, "#8aff0c");
  }));
  return lines;
})();
