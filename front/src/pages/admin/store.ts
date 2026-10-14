/* -------------------------------------------------------------------------
   O estado do painel que mora no navegador, em signals.

   O que vem do servidor (pedidos, baralhos, estoque, sessão) mora no cache do
   TanStack Query (`queries.ts`). Aqui fica o que só esta tela sabe: o token,
   a aba e os filtros, a nota embaixo de cada pedido, o que está marcado pra
   combinar, a confirmação aberta e quantas ações longas estão andando.
   ------------------------------------------------------------------------- */
import { computed, signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { printOrder, selectionKey } from "./preview";
import type { Note, NoteKind } from "./queue";
import type { ComboMapEntry, Order } from "./types";

/* ------------------------------------------------------------------ token

   Por padrão, sessionStorage: fecha a aba, some. A caixinha "lembrar" troca
   pro localStorage, que é o que serve pro celular do operador, onde entrar de
   novo a cada vez é o que faria a tela deixar de ser usada. */
const TOKEN_KEY = "forja_admin_token";

function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export const token = signal(storedToken());
/** O motivo de a entrada estar à vista (token recusado, servidor fora). */
export const gateError = signal("");

export function saveToken(value: string, remember: boolean) {
  token.value = value;
  gateError.value = "";
  try {
    sessionStorage.setItem(TOKEN_KEY, value);
    if (remember) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* navegador privado: vale só enquanto a página estiver aberta */ }
}

export function forgetToken(reason = "") {
  token.value = "";
  gateError.value = reason;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* nada guardado */ }
}

/* ------------------------------------------------------------- navegação */

export type Tab = "pedidos" | "decks" | "estoque";
export const tab = signal<Tab>("pedidos");
export const statusFilter = signal("");   // "" = todos
export const search = signal("");

export function switchTab(next: Tab) {
  if (tab.value === next) return;
  tab.value = next;
  search.value = "";
  statusFilter.value = "";
  stockNote.value = null;
}

/* --------------------------------------------------------------- avisos */

/** id do pedido -> a nota embaixo dele. */
export const notes = signal<Record<string, Note>>({});
export const stockNote = signal<Note | null>(null);
/** Erro de uma ação fora de pedido (apagar baralho), mostrado no topo. */
export const topError = signal("");

export function note(id: string, kind: NoteKind, text: string) {
  notes.value = { ...notes.value, [id]: { kind, text } };
}

export function dropNote(id: string) {
  const { [id]: _, ...rest } = notes.value;
  notes.value = rest;
}

/* Ações longas em andamento (montagem, impressão). Enquanto houver alguma,
   a lista não se atualiza sozinha: redesenhar embaixo de um clique é a
   melhor forma de imprimir o pedido errado. */
export const busy = signal(0);

export async function whileBusy<T>(work: () => Promise<T>) {
  busy.value++;
  try {
    return await work();
  } finally {
    busy.value--;
  }
}

/* -------------------------------------------------------- confirmação */

export type ModalField = { name: string; label: string; mode?: "numeric" | "decimal" | "text"; value?: string };

export type ModalSpec = {
  title: string;
  text?: ComponentChildren;
  ok: string;
  danger?: boolean;
  /** Texto que tem de ser digitado pra destravar o botão (o id, no apagar). */
  confirmWith?: string;
  fields?: ModalField[];
  columns?: 2;
  onConfirm: (values: Record<string, string>) => unknown;
};

/** `seq` muda a cada abertura: é o que faz a caixa nascer de novo, com os
    valores da vez, mesmo quando uma confirmação substitui outra. */
export const modal = signal<(ModalSpec & { seq: number }) | null>(null);
let modalSeq = 0;
export const openModal = (spec: ModalSpec) => { modal.value = { ...spec, seq: ++modalSeq }; };
export const closeModal = () => { modal.value = null; };

/* Atualizar sozinho só com a tela parada: sem confirmação aberta e sem ação
   longa andando. */
export const autoRefreshPaused = computed(() => busy.value > 0 || modal.value !== null);

/* ------------------------------------------------- combinar pedidos

   `selected` é o que está marcado; `known` guarda os dados de todo pedido
   que já passou pela tela, porque trocar de filtro ou buscar tira o pedido
   da lista sem tirar a marca dele — e a conta de folhas precisa dos dados de
   TODOS os marcados, não só dos visíveis. */
export const selected = signal<ReadonlySet<string>>(new Set());
export const known = signal<Record<string, Order>>({});

/** A combinação já criada no backend, e de qual seleção ela é. */
export const combo = signal<{ id: string; key: string } | null>(null);
export const comboNote = signal<Note | null>(null);
export const comboMap = signal<ComboMapEntry[] | null>(null);

export function rememberOrders(orders: Order[]) {
  const next = { ...known.value };
  for (const o of orders) next[o.id] = o;
  known.value = next;
}

function resetCombo() {
  combo.value = null;
  comboMap.value = null;
  comboNote.value = null;
}

export function setSelected(ids: ReadonlySet<string>) {
  selected.value = ids;
  // Mudou a seleção? A combinação criada é de outro conjunto e não serve mais.
  if (combo.value && combo.value.key !== selectionKey(ids)) resetCombo();
}

export function toggleSelected(id: string, on: boolean) {
  const next = new Set(selected.value);
  if (on) next.add(id);
  else next.delete(id);
  setSelected(next);
}

export function clearSelection() {
  selected.value = new Set();
  resetCombo();
}

/** Os marcados que a tela conhece, na ordem em que o backend imprime.
    Marcado que a tela não conhece fica de fora da prévia — o backend ainda
    assim vai contar com ele. */
export const markedOrders = computed(() =>
  printOrder([...selected.value].map((id) => known.value[id]).filter(Boolean)));

/** Volta tudo ao estado de quem acabou de abrir a página (usado nos testes). */
export function resetAdminState() {
  token.value = storedToken();
  gateError.value = "";
  tab.value = "pedidos";
  statusFilter.value = "";
  search.value = "";
  notes.value = {};
  stockNote.value = null;
  topError.value = "";
  busy.value = 0;
  modal.value = null;
  selected.value = new Set();
  known.value = {};
  combo.value = null;
  comboNote.value = null;
  comboMap.value = null;
}
