/* O XML do MPC Fill: ler a quantidade, ler a folha e escrever a folha
   revisada de volta.

   Nada aqui fala com o backend. O XML revisado só vai pro servidor quando o
   cliente gera a cobrança, e quem monta o PDF de verdade continua sendo ele. */

export type CardMeta = { id: string; name: string; query: string };
/** Uma posição da folha. Frente e verso andam juntos de propósito — numa
    carta dupla-face, cada cópia física precisa do seu próprio verso. */
export type Slot = { front: CardMeta; back: CardMeta | null };

const countSlots = (text: string) => text.split(",").filter((x) => x.trim() !== "").length;

function parseXml(xmlText: string, invalid: string) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error(invalid);
  return doc;
}

/** Quantas cartas e quantos versos próprios o pedido tem. */
export function parseOrder(xmlText: string) {
  const doc = parseXml(xmlText,
    "Esse XML não é válido. Confere se selecionou o arquivo completo exportado do MPC Fill.");

  let qty: number | null = null;
  const qtyTag = doc.querySelector("details > quantity");
  if (qtyTag?.textContent?.trim()) {
    const n = parseInt(qtyTag.textContent.trim(), 10);
    if (!isNaN(n) && n > 0) qty = n;
  }
  if (qty === null) {
    // reserva: soma os slots das cartas em fronts
    let total = 0;
    doc.querySelectorAll("fronts > card > slots").forEach((s) => { total += countSlots(s.textContent || ""); });
    if (total > 0) qty = total;
  }
  if (qty === null) {
    throw new Error("Não encontrei a quantidade de cartas nesse XML. Confirma se é um XML de pedido exportado do MPC Fill.");
  }

  // Cartas de dupla-face (MDFC) têm um verso próprio na seção <backs>. Esse
  // verso não pode usar o verso genérico da folha — é impresso à parte e
  // depois colado, então ele consome um espaço "em branco" da folha.
  let backsCount = 0;
  doc.querySelectorAll("backs > card > slots").forEach((s) => { backsCount += countSlots(s.textContent || ""); });

  return { qty, backsCount };
}

function childText(el: Element, tag: string) {
  const n = el.querySelector(":scope > " + tag);
  return n ? (n.textContent || "").trim() : "";
}

function readSection(doc: Document, section: string) {
  const out: { slot: number; meta: CardMeta }[] = [];
  doc.querySelectorAll(section + " > card").forEach((el) => {
    const meta = { id: childText(el, "id"), name: childText(el, "name"), query: childText(el, "query") };
    if (!meta.id) return;
    childText(el, "slots").split(",").forEach((raw) => {
      const s = raw.trim();
      if (/^\d+$/.test(s)) out.push({ slot: parseInt(s, 10), meta });
    });
  });
  return out;
}

/** A folha do XML, em ordem de slot. O documento volta junto pra a escrita
    preservar o que a tela não conhece (stock, foil, cardback…). */
export function parseSlots(xmlText: string): { doc: Document; slots: Slot[] } {
  const doc = parseXml(xmlText, "Esse XML não é válido.");
  const backs = new Map<number, CardMeta>();
  readSection(doc, "backs").forEach((b) => backs.set(b.slot, b.meta));
  const fronts = readSection(doc, "fronts").sort((a, b) => a.slot - b.slot);
  return { doc, slots: fronts.map((f) => ({ front: f.meta, back: backs.get(f.slot) || null })) };
}

/* Tamanhos de pedido do MPC Fill. Não muda nada por aqui, mas mantém o XML
   revisado válido pra reabrir no site deles depois. */
const MPC_BRACKETS = [18, 36, 55, 72, 90, 108, 126, 144, 162, 180, 198, 216,
                      234, 252, 270, 288, 306, 324, 342, 360, 396, 504, 612];

export function bracketFor(n: number) {
  return MPC_BRACKETS.find((b) => n <= b) ?? n;
}

function newEl(doc: Document, tag: string, text: string) {
  const el = doc.createElement(tag);
  el.textContent = text;
  return el;
}

type Entry = { meta: CardMeta; slots: number[] };

function writeSection(doc: Document, root: Element, tag: string, entries: Map<string, Entry>) {
  let section = root.querySelector(":scope > " + tag);
  if (entries.size === 0) {
    if (section) root.removeChild(section);
    return;
  }
  if (!section) {
    section = doc.createElement(tag);
    root.insertBefore(section, root.querySelector(":scope > cardback"));
  }
  while (section.firstChild) section.removeChild(section.firstChild);
  entries.forEach((e) => {
    const card = doc.createElement("card");
    card.appendChild(newEl(doc, "id", e.meta.id));
    card.appendChild(newEl(doc, "slots", e.slots.join(",")));
    if (e.meta.name) card.appendChild(newEl(doc, "name", e.meta.name));
    if (e.meta.query) card.appendChild(newEl(doc, "query", e.meta.query));
    section!.appendChild(card);
  });
}

/** O XML da folha revisada, sobre uma cópia do documento original. */
export function buildXml(original: Document, slots: Slot[]) {
  const doc = original.cloneNode(true) as Document;
  const root = doc.documentElement;

  // Um <card> por id com todos os slots dele, que é como o MPC Fill escreve
  // e como o backend lê. Os slots são renumerados 0..n-1 na ordem da folha.
  const fronts = new Map<string, Entry>(), backs = new Map<string, Entry>();
  const add = (map: Map<string, Entry>, meta: CardMeta, i: number) => {
    let e = map.get(meta.id);
    if (!e) { e = { meta, slots: [] }; map.set(meta.id, e); }
    e.slots.push(i);
  };
  slots.forEach((slot, i) => {
    add(fronts, slot.front, i);
    if (slot.back) add(backs, slot.back, i);
  });
  writeSection(doc, root, "fronts", fronts);
  writeSection(doc, root, "backs", backs);

  // A quantidade tem que acompanhar: é ela que o backend usa pra cobrar.
  let details = root.querySelector(":scope > details");
  if (!details) {
    details = doc.createElement("details");
    root.insertBefore(details, root.firstChild);
  }
  let quantity = details.querySelector(":scope > quantity");
  if (!quantity) {
    quantity = doc.createElement("quantity");
    details.insertBefore(quantity, details.firstChild);
  }
  quantity.textContent = String(slots.length);
  const bracket = details.querySelector(":scope > bracket");
  if (bracket) bracket.textContent = String(bracketFor(slots.length));

  return '<?xml version="1.0" encoding="UTF-8"?>\n' + serialize(root, 0) + "\n";
}

const escapeXml = (t: string) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Serializador próprio em vez do XMLSerializer: reaproveitar o documento
   original preserva tudo que não conhecemos, mas deixa pra trás a indentação
   do arquivo antigo, e o resultado sai todo grudado. Reindentar aqui devolve
   um XML limpo, do jeito que o MPC Fill escreve. Serve porque esse XML não
   tem conteúdo misto — texto e elementos nunca dividem o mesmo pai. */
function serialize(el: Element, level: number): string {
  const indent = "    ".repeat(level);
  const attrs = Array.from(el.attributes || [])
    .map((a) => ` ${a.name}="${escapeXml(a.value).replace(/"/g, "&quot;")}"`).join("");
  const children = Array.from(el.children);
  if (!children.length) {
    const text = (el.textContent || "").trim();
    return text
      ? `${indent}<${el.nodeName}${attrs}>${escapeXml(text)}</${el.nodeName}>`
      : `${indent}<${el.nodeName}${attrs}/>`;
  }
  return `${indent}<${el.nodeName}${attrs}>\n`
    + children.map((c) => serialize(c, level + 1)).join("\n")
    + `\n${indent}</${el.nodeName}>`;
}
