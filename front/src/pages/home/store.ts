/* -------------------------------------------------------------------------
   O estado da página do pedido, em signals.

   Do servidor vêm preços, tinta, conta, o deck do pedido e o progresso da
   cotação — esses passam pelo TanStack Query. Aqui fica o que é do
   navegador: o XML e a folha que sai dele, o formulário, a cobrança gerada,
   a revisão aberta e o "Meus Pedidos".

   A cobrança e a cotação guardam a ASSINATURA do pedido que as gerou. Mudou
   o pedido, a assinatura não bate e elas deixam de valer sozinhas — é o que
   impede um QR de outro pedido de ficar na tela.

   O DECK COM CARTAS FOIL vira dois pedidos num Pix só (ver `artes._montar`):
   o `xmlText` e a folha que se revisa são os do PADRÃO, e o foil vem à parte
   em `foilPart`, sem edição — as cartas foil se escolhem no deckbuilder.
   ------------------------------------------------------------------------- */
import { computed, signal } from "@preact/signals";
import { quoteName } from "./art";
import {
  catalogFrom, sheetGroups, signatureOf, type BackCatalog, type Edit,
} from "./sheet";
import { computeTotals, DEFAULT_PRICES, type Lamination, type Prices } from "./totals";
import { buildXml, parseOrder, parseSlots, type Slot } from "./xml";

/** O deck que o "Gerar pedido" do deckbuilder mandou (`?deck=`), ou "". Com
    ele, o XML vem do servidor em vez do upload. */
export const deckId = signal(new URLSearchParams(location.search).get("deck") || "");
/** A versão do histórico que o "Gerar pedido" dela mandou (`?versao=`), ou
    "". Com ela, o pedido leva só as cartas que entraram naquela versão. */
export const deckVersion = signal(new URLSearchParams(location.search).get("versao") || "");

/* ------------------------------------------------------------------- XML */

export const xmlText = signal("");
export const parsed = signal<{ qty: number; backsCount: number } | null>(null);
export const xmlError = signal("");

/* ------------------------------------------------------------------ foil */

/** A parte foil do pedido misto, ou null. Só o deckbuilder cria uma. */
export type FoilPart = { xml: string; qty: number; backsCount: number; slots: Slot[] };
export const foilPart = signal<FoilPart | null>(null);
/** O XML do deck INTEIRO, quando ele vem partido: é o que se cota (a cotação
    é das cartas, não do papel) e o que vira o pedido no "imprimir tudo no
    padrão". Vazio fora do pedido misto. */
export const wholeXml = signal("");
/** O "Imprimir tudo no padrão": ignora as marcas de foil do deckbuilder. */
export const ignoreFoil = signal(false);

export function loadFoilPart(xml: string | null) {
  if (!xml) {
    foilPart.value = null;
    return;
  }
  try {
    foilPart.value = { xml, ...parseOrder(xml), slots: parseSlots(xml).slots };
  } catch (e) {
    foilPart.value = null;
    xmlError.value = (e as Error).message;
  }
}

/* ----------------------------------------------------------------- folha */

let originalDoc: Document | null = null;
export const slots = signal<Slot[]>([]);
export const catalog = signal<BackCatalog>(new Map());
/** Pilha do desfazer: cada entrada é a folha de antes de uma edição. */
export const history = signal<Slot[][]>([]);
/** A folha que gerou o `xmlText` atual. */
export const loadedSignature = signal("");
/** Sobe a cada revisão confirmada: invalida a cobrança que estiver na tela. */
export const revision = signal(0);
export const edited = signal(false);

export function loadXml(text: string) {
  xmlText.value = text;
  try {
    parsed.value = parseOrder(text);
    const sheet = parseSlots(text);
    originalDoc = sheet.doc;
    slots.value = sheet.slots;
    catalog.value = catalogFrom(sheet.slots);
    xmlError.value = "";
  } catch (e) {
    parsed.value = null;
    originalDoc = null;
    slots.value = [];
    catalog.value = new Map();
    xmlError.value = (e as Error).message;
  }
  history.value = [];
  edited.value = false;
  loadedSignature.value = signatureOf(slots.value);
}

export function failXml(message: string) {
  loadXml("");
  foilPart.value = null;
  wholeXml.value = "";
  xmlError.value = message;
}

/* ----------------------------------------------------------- formulário */

export const customerName = signal("");
export const lamination = signal<Lamination>("double");
/** "Declaro que conheço o dono do sistema." */
export const declared = signal(false);
export const prices = signal<Prices>(DEFAULT_PRICES);

export type Totals = ReturnType<typeof computeTotals>;
export type FoilTotals = { qty: number; backsCount: number } & Totals;
export type Summary =
  | { kind: "error"; message: string }
  | { kind: "hint"; message: string }
  | ({ kind: "ok"; qty: number; backsCount: number; lam: Lamination; name: string; signature: string;
       /** A parte foil do pedido misto, e a soma dos dois — o valor do Pix. */
       foil: FoilTotals | null; grandTotal: number }
      & Totals);

export const summary = computed((): Summary => {
  if (xmlError.value) return { kind: "error", message: xmlError.value };
  const name = customerName.value.trim();
  const order = parsed.value;
  if (!order && !name) {
    return { kind: "hint", message: deckId.value
      ? "Escreva seu nome — o resumo aparece sozinho."
      : "Selecione o XML e escreva seu nome — o resumo aparece sozinho." };
  }
  if (!order) {
    return { kind: "hint", message: deckId.value ? "Montando o pedido do deck…" : "Falta selecionar o arquivo .xml do MPC Fill." };
  }
  if (!name) return { kind: "hint", message: "Falta escrever seu nome no passo 2." };
  const fp = foilPart.value;
  // No pedido misto o resto não sai em foil: a opção nem aparece.
  const lam = fp && lamination.value === "foil" ? "double" : lamination.value;
  const totals = computeTotals(order.qty, order.backsCount, lam, prices.value);
  const foil = fp ? { qty: fp.qty, backsCount: fp.backsCount,
                      ...computeTotals(fp.qty, fp.backsCount, "foil", prices.value) } : null;
  return {
    kind: "ok", qty: order.qty, backsCount: order.backsCount, lam, name,
    // A cobrança vale só para o pedido exato que a originou.
    signature: [order.qty, order.backsCount, lam, name, revision.value, fp ? `foil:${fp.qty}` : ""].join("|"),
    ...totals,
    foil,
    grandTotal: Math.round((totals.total + (foil?.total ?? 0)) * 100) / 100,
  };
});

/* ------------------------------------------------------------- cobrança */

export type ChargedOrder = {
  order_id: string; deck_hash: string; lamination: Lamination; amount: number;
  qty: number; backs_count: number; pages: number; blanks: number;
};
export type Charge = {
  signature: string;
  order_id: string; deck_hash: string; amount: number;
  pix_copia_cola: string; pix_qr_base64: string;
  /** Os pedidos que esta cobrança paga: dois no pedido misto. */
  pedidos?: ChargedOrder[];
};
export const charge = signal<Charge | null>(null);
export const chargeError = signal("");

const currentSignature = () => summary.value.kind === "ok" ? summary.value.signature : "";
export const chargeValid = computed(() => !!charge.value && charge.value.signature === currentSignature());
/** O pedido mudou depois de uma cobrança gerada: o QR sumiu, e a pessoa
    precisa saber por quê — senão parece que a página quebrou. */
export const chargeExpired = computed(() => !!charge.value && !chargeValid.value);

/* -------------------------------------------------------------- cotação */

/** O comandante escolhido pra cotação (não conta no teto do Commander 500). */
export const commander = signal("");

/** Os nomes que o backend vai enxergar, um por carta, em ordem alfabética. */
export const commanderOptions = computed(() => {
  const names: string[] = [];
  const seen = new Set<string>();
  // O comandante foil está na parte foil, e continua sendo o comandante.
  const fp = foilPart.value;
  const groups = [...sheetGroups(slots.value, catalog.value),
                  ...(fp ? sheetGroups(fp.slots, catalogFrom(fp.slots)) : [])];
  for (const g of groups) {
    const name = quoteName(g.front);
    if (!name || !g.idx.length || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b, "pt-BR"));
});

/** A escolha vale enquanto a carta continuar no deck. */
export const effectiveCommander = computed(() =>
  commanderOptions.value.includes(commander.value) ? commander.value : "");

export type Quote = { signature: string; commander: string; jobId?: string; result?: unknown; error?: string };
export const quote = signal<Quote | null>(null);

/** A cotação só vale pro deck e pro comandante que a pediram. */
export const quoteCurrent = computed(() => {
  const q = quote.value;
  return q && summary.value.kind === "ok" && q.signature === loadedSignature.value
    && q.commander === effectiveCommander.value ? q : null;
});

/* -------------------------------------------------------------- revisão */

export const reviewOpen = signal(false);
export const footMessage = signal("");
let reviewSnapshot: { slots: Slot[]; history: Slot[][] } | null = null;

export function openReview() {
  if (!slots.value.length) return;
  reviewSnapshot = { slots: slots.value, history: history.value };
  footMessage.value = "";
  reviewOpen.value = true;
}

export function cancelReview() {
  if (reviewSnapshot) {
    slots.value = reviewSnapshot.slots;
    history.value = reviewSnapshot.history;
  }
  reviewOpen.value = false;
}

export function confirmReview() {
  const signature = signatureOf(slots.value);
  if (signature !== loadedSignature.value && originalDoc) {
    const xml = buildXml(originalDoc, slots.value);
    xmlText.value = xml;
    loadedSignature.value = signature;
    revision.value++;
    edited.value = true;
    try {
      parsed.value = parseOrder(xml);
      xmlError.value = "";
    } catch (e) {
      parsed.value = null;
      xmlError.value = (e as Error).message;
    }
  }
  reviewOpen.value = false;
}

/** Aplica uma edição da folha (ver `sheet.ts`), guardando o desfazer. */
export function applyEdit(edit: (s: Slot[], c: BackCatalog) => Edit) {
  const r = edit(slots.value, catalog.value);
  if (r.slots) {
    history.value = [...history.value, slots.value].slice(-200);
    slots.value = r.slots;
  }
  footMessage.value = r.message ?? "";
}

export function undo() {
  const h = history.value;
  if (!h.length) return;
  slots.value = h[h.length - 1];
  history.value = h.slice(0, -1);
  footMessage.value = "";
}

/* ---------------------------------------------------------- meus pedidos */

export const ordersOpen = signal(false);
export const selectedOrder = signal<string | null>(null);
/** Sobe a cada mudança na lista guardada: é o que faz a tela reler. */
export const ordersVersion = signal(0);
export const ordersMessage = signal<{ text: string; tone?: "bom" | "ruim" }>({ text: "" });
export const bumpOrders = () => { ordersVersion.value++; };

/** Volta tudo ao estado de quem acabou de abrir a página (usado nos testes). */
export function resetHomeState() {
  deckId.value = "";
  deckVersion.value = "";
  foilPart.value = null;
  wholeXml.value = "";
  ignoreFoil.value = false;
  loadXml("");
  xmlError.value = "";
  revision.value = 0;
  customerName.value = "";
  lamination.value = "double";
  declared.value = false;
  prices.value = DEFAULT_PRICES;
  charge.value = null;
  chargeError.value = "";
  commander.value = "";
  quote.value = null;
  reviewOpen.value = false;
  footMessage.value = "";
  ordersOpen.value = false;
  selectedOrder.value = null;
  ordersMessage.value = { text: "" };
}
