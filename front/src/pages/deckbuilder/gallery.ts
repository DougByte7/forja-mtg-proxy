/* ----------------------------------------------------------------- galeria

   O deck como ele vai sair do papel: uma imagem por arte a imprimir, com o
   que já foi escolhido separado, de relance, do que continua no padrão.
   A lista responde "o que está no deck"; esta aba responde "como ele vai
   ficar" — e é daqui que se escolhe arte carta por carta sem caçar o botão
   em cada linha.

   UM QUADRO POR ARTE, NÃO POR CARTA. Carta de duas faces vira dois quadros,
   frente e verso lado a lado, porque são dois arquivos no papel e duas
   escolhas separadas (ver `art.ts`) — um quadro só esconderia o verso que
   ficou no padrão. As 30 Florestas com a mesma arte aparecem uma vez, com o
   30×; com arte por cópia (ver `artes.py`), aparecem uma vez por arte
   diferente — dez de uma e vinte de outra são dois quadros, 10× e 20×.

   O maybeboard fica de fora — não vai pro papel. O sideboard entra: é carta
   que a pessoa quer ter, e entra na lista de impressão.

   As fichas entram no fim, uma de cada (ver `deckTokens`): vão pro papel
   junto com o deck, e são a parte que se esquece de escolher.

   Aqui ficam as contas; o desenho é `ui/Gallery.tsx`. */
import { canOrder } from "../../shared/account";
import { artName, chosenArt, faceImage, hasBack, hasPerCopyArt, sideReady, type Face } from "./art";
import { categoryOf, categoryOrder } from "./deck";
import { state } from "./state";
import { deckTokens, tokenLabel } from "./tokens";
import type { Card, Entry } from "./types";

/* "1–3, 5": as cópias de um quadro, com as seguidas juntas. */
export function copiesText(copies: number[]) {
  const ranges: [number, number][] = [];
  for (const n of copies) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges.map(([a, b]) => a === b ? `${a}` : `${a}–${b}`).join(", ");
}

export type GalleryFrame = {
  key: string;
  artCard: string;      // o `data-arte-carta`: nome da carta, ou chave da ficha
  face: Face;
  copy: number;         // 0 = o quadro da arte de todas
  chosen: boolean;
  lying: boolean;
  src: string;
  preview: string;      // a prévia do hover: ESTE lado, maior
  quantity: number;
  label: string;        // o `title`/`aria-label`, sem o separador
  situation: string;
  badge: string;        // "Escolhida · verso · cópias 1–3"
};

/* `copies` é a lista de cópias que o quadro representa, na carta com arte
   por cópia; sem ela, o quadro é o da arte de todas. */
function galleryFrame(card: Card, face: Face, quantity: number, copies?: number[]): GalleryFrame {
  const copy = copies ? copies[0] : 0;
  const choice = chosenArt(card, face, null, copy);
  // Ficha leva o corpo e o texto: as duas Wurm do Wurmcoil são dois quadros
  // de mesmo nome, e o texto é o que diz qual é qual.
  const name = card.ficha ? tokenLabel(card) + (card.texto ? ` (${card.texto})` : "") : card.nome;
  const back = face === "verso";
  const src = faceImage(card, face, 400, null, copy);
  const which = copies ? ` · ${copies.length > 1 ? "cópias" : "cópia"} ${copiesText(copies)}` : "";
  return {
    key: `${artName(card)}|${face}|${copy}`,
    artCard: artName(card), face, copy, chosen: !!choice, lying: !!card.deitada, src,
    // A prévia do hover mostra ESTE lado, e não a carta inteira como na lista:
    // cada quadro já é um lado, e o outro está no quadro ao lado.
    preview: src ? faceImage(card, face, 500, null, copy) : "",
    quantity,
    label: (back ? "Verso de " : "") + name + which,
    situation: choice ? "arte escolhida: " + (choice.arquivo || choice.arte_id) : "arte padrão — clique pra escolher",
    badge: (choice ? "Escolhida" : "Padrão") + (back ? " · verso" : hasBack(card) ? " · frente" : "") + which,
  };
}

/* As cópias de uma carta com arte por cópia, juntas pela arte que imprimem.
   Frente e verso contam juntos: duas cópias só dividem quadro se os dois
   lados saem iguais. */
function copyGroups(card: Card, quantity: number, faces: Face[]) {
  const groups = new Map<string, number[]>();
  for (let n = 1; n <= quantity; n++) {
    const key = faces.map((f) => chosenArt(card, f, null, n)?.arte_id || "").join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  return [...groups.values()];
}

export function cardFrames(card: Card, quantity: number): GalleryFrame[] {
  const faces: Face[] = hasBack(card) ? ["frente", "verso"] : ["frente"];
  if (quantity > 1 && hasPerCopyArt(card)) {
    return copyGroups(card, quantity, faces).flatMap((copies) =>
      faces.map((f) => galleryFrame(card, f, copies.length, copies)));
  }
  return faces.map((f) => galleryFrame(card, f, quantity));
}

/* O que falta escolher, contado por ARTE: carta de duas faces conta duas,
   que é o que vai pro papel. Ficha conta como carta. Um lado só conta como
   escolhido com todas as cópias dele cobertas. */
export function galleryCount() {
  const entries: [Card, number][] = [
    ...state.commanders.map((c): [Card, number] => [c, 1]),
    ...state.cards.map((e): [Card, number] => [e.carta, e.quantidade]),
    ...deckTokens().map((f): [Card, number] => [f, 1]),
  ];
  let total = 0, chosen = 0;
  for (const [card, quantity] of entries) {
    for (const face of (hasBack(card) ? ["frente", "verso"] : ["frente"]) as Face[]) {
      total++;
      if (sideReady(card, face, quantity)) chosen++;
    }
  }
  return { total, chosen };
}

/* Os grupos da galeria: comandante, as categorias na ordem e com o desempate
   da lista (a pessoa acha a carta aqui onde ela já sabe que a carta mora lá),
   e as fichas no fim. */
export function galleryGroups() {
  const groups: { title: string; frames: GalleryFrame[] }[] = [];
  if (!state.commanders.length) return groups;
  groups.push({
    title: state.commanders.length > 1 ? "Comandantes" : "Comandante",
    frames: state.commanders.flatMap((c) => cardFrames(c, 1)),
  });
  const byCategory = new Map<string, Entry[]>();
  for (const e of state.cards) {
    const cat = categoryOf(e);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(e);
  }
  for (const cat of categoryOrder(state.cards)) {
    const items = byCategory.get(cat);
    if (!items) continue;
    items.sort((a, b) => ((a.carta.cmc ?? 0) - (b.carta.cmc ?? 0)) || a.carta.nome.localeCompare(b.carta.nome));
    groups.push({ title: cat, frames: items.flatMap((e) => cardFrames(e.carta, e.quantidade)) });
  }
  const tokens = deckTokens();
  if (tokens.length) groups.push({ title: "Tokens", frames: tokens.flatMap((f) => cardFrames(f, 1)) });
  return groups;
}

/* O "Gerar pedido" do cabeçalho: um link pra tela de orçamento com o id do
   deck, que lá vira pedido com as artes escolhidas aqui (ver `artes.pedido`).
   Só ganha `href` com TODAS as artes escolhidas, pela mesma conta desta aba:
   a arte padrão da tela é só a miniatura da base, e o PDF imprime o que foi
   escolhido. Sem id não há deck no servidor pra levar, e ele some junto com
   o Compartilhar. Também some pra quem não pode pedir (`canOrder`). */
export function orderLinkView() {
  const { total, chosen } = galleryCount();
  const ready = !!state.id && total > 0 && chosen === total;
  return {
    hidden: !state.id || !canOrder(state.user),
    href: ready ? `/pedido?deck=${encodeURIComponent(state.id!)}` : undefined,
    title: ready ? "Levar este deck pra tela de orçamento"
      : total ? `Faltam ${total - chosen} arte(s) — escolha na aba Artes`
      : "O deck ainda não tem carta",
  };
}

/* O atalho "Usar a arte padrão nas que faltam" só aparece quando há o que
   aplicar, e num deck já salvo. */
export function defaultsShortcutHidden() {
  if (!state.commanders.length || !state.id) return true;
  const { total, chosen } = galleryCount();
  return chosen === total;
}
