/* ------------------------------------------------------- a carta inteira

   Clique numa linha do deck ou do maybeboard. A lista responde "o que está no
   deck"; uma hora a pergunta vira "o que esta carta faz, mesmo?" — e aí é
   oracle inteiro, ambientação, edição e as notas de regras.

   A modal abre NA HORA com o que a base local já tem (a carta chega completa
   da busca, ver `cartas.py`) e completa depois com o que só a API da Scryfall
   sabe. Esperar a rede pra mostrar uma carta que já está na tela seria fazer
   o clique parecer travado por causa da metade menos urgente da informação.

   Aqui ficam o estado da modal e a conversa com o servidor; o desenho é
   `ui/CardModal.tsx`. */
import { signal } from "@preact/signals";
import { api } from "./save";
import type { Card } from "./types";

export type CardFace = {
  nome?: string; mana_cost?: string; tipo?: string; texto?: string; sabor?: string;
  poder?: string | null; resistencia?: string | null; lealdade?: string | null; defesa?: string | null;
  imagem?: string; artista?: string;
};
export type CardInfo = {
  faces?: CardFace[]; edicao?: string; edicao_sigla?: string; numero?: string; raridade?: string;
  lancamento?: string; edhrec?: number; reservada?: boolean; scryfall?: string; gatherer?: string;
  precos?: Record<string, string | null | undefined>; regras?: { data?: string; texto: string }[];
};

/* A carta na modal e o detalhe dela. `info` é `null` enquanto a Scryfall não
   respondeu e `false` se ela não respondeu — a modal fala as duas coisas, e
   nenhuma delas é erro: o que a base local sabe continua na tela.

   `open` é separado de `card` por causa do desvanecer: ao fechar, a carta
   continua desenhada enquanto a modal some, e só depois sai. */
export const cardModal = signal<{ card: Card; info: CardInfo | null | false } | null>(null);
export const cardModalOpen = signal(false);

// Por sessão: reabrir a mesma carta é comum (comparar duas, voltar pra
// conferir um ruling) e a segunda vez não pode custar rede de novo.
const seen = new Map<string, CardInfo>();
const inFlight = new Map<string, Promise<CardInfo>>();

let opening = 0;
let isOpen = false;

/* Aberta desde o clique, e não só depois do quadro da animação: o Esc logo
   em seguida tem que fechar. */
export function isCardOpen() {
  return isOpen;
}

/* Recebe a CARTA, não o nome: quem abre a modal são vários lugares que
   guardam a carta em listas diferentes (deck, maybeboard, a zona de comando,
   a mesa), e procurar o nome aqui dentro obrigaria esta função a conhecer
   todas. */
export function openCard(card: Card | null | undefined) {
  if (!card) return;
  // A prévia do hover fica presa embaixo da modal se ela não for dispensada
  // aqui: o clique não move o mouse, e é movimento que a apaga.
  document.getElementById("previa")?.classList.remove("mostra");
  cardModal.value = { card, info: seen.get(card.nome) ?? null };
  // A classe que anima entra um quadro depois de a modal existir, senão a
  // transição não teria de onde partir — e só se nada a fechou nesse meio
  // tempo (`opening` muda a cada abrir e fechar).
  const mine = ++opening;
  isOpen = true;
  requestAnimationFrame(() => { if (opening === mine) cardModalOpen.value = true; });
  if (!seen.has(card.nome)) loadInfo(card);
}

export function closeCard() {
  if (!cardModal.value) return;
  opening++;
  isOpen = false;
  cardModalOpen.value = false;
  // A carta sai só depois da transição, como nas gavetas: na hora, a modal
  // sumiria sem o desvanecer.
  const closing = cardModal.value;
  setTimeout(() => { if (!cardModalOpen.value && cardModal.value === closing) cardModal.value = null; }, 200);
}

async function loadInfo(card: Card) {
  let info: CardInfo | false = false;
  try {
    info = await fetchCardInfo(card.nome);
  } catch { /* a própria modal avisa; não vale um toast por cima dela */ }
  if (cardModal.value?.card === card) cardModal.value = { card, info };
}

/* O detalhe da Scryfall de uma carta, uma vez por sessão. Também é quem
   alimenta o painel da mesa do goldfish, que passa o mouse por sete cartas em
   seguida e volta nelas: o pedido em voo fica guardado pra o segundo hover
   esperar o primeiro em vez de pedir de novo. */
export async function fetchCardInfo(name: string): Promise<CardInfo> {
  if (seen.has(name)) return seen.get(name)!;
  if (!inFlight.has(name)) inFlight.set(name, api("/cartas/detalhe?nome=" + encodeURIComponent(name)));
  try {
    const info = await inFlight.get(name)!;
    seen.set(name, info);
    return info;
  } finally {
    inFlight.delete(name);
  }
}

/* As artes, sem repetição. Carta partida e aventura têm duas faces de TEXTO
   numa imagem só, e as duas faces devolvem a mesma URL — desenhá-la duas
   vezes mostraria a mesma carta empilhada em si mesma. */
export function cardImages(local: Card, info: CardInfo | null | false) {
  const urls = (info ? (info.faces || []).map((f) => f.imagem) : []).concat([local.imagem, local.imagem_verso]);
  return [...new Set(urls.filter(Boolean))] as string[];
}

/* A carta local no formato de face que a modal desenha. É o que fica na tela
   enquanto a Scryfall não responde — e o que fica pra sempre se ela não
   responder. O texto de carta de duas faces vem da base emendado por
   "\n//\n", que é como a lista do deck já o mostra. */
export function localFace(card: Card): CardFace {
  return { nome: card.nome, mana_cost: card.mana_cost, tipo: card.tipo, texto: card.texto, sabor: "",
           poder: null, resistencia: null, lealdade: null, defesa: null };
}

export function faceStats(f: CardFace) {
  return f.poder != null && f.resistencia != null ? `${f.poder}/${f.resistencia}`
    : f.lealdade != null ? `Lealdade ${f.lealdade}`
    : f.defesa != null ? `Defesa ${f.defesa}` : "";
}

const RARITY: Record<string, string> = {
  common: "Comum", uncommon: "Incomum", rare: "Rara", mythic: "Mítica", special: "Especial", bonus: "Bônus",
};

export const brDay = (iso: string | undefined) => (iso || "").split("-").reverse().join("/");

/* A ficha técnica: edição, raridade, ilustração, lançamento e o resto. */
export function cardFacts(info: CardInfo): [string, string][] {
  const artists = [...new Set((info.faces || []).map((f) => f.artista).filter(Boolean))].join(", ");
  const items: [string, string][] = [];
  if (info.edicao) items.push(["Edição", `${info.edicao}${info.numero ? ` · nº ${info.numero}` : ""}`]);
  if (info.raridade) items.push(["Raridade", RARITY[info.raridade] || info.raridade]);
  if (artists) items.push(["Ilustração", artists]);
  if (info.lancamento) items.push(["Lançamento", brDay(info.lancamento)]);
  // Posição no EDHREC = "quão jogada em Commander". Quanto menor, mais
  // jogada — daí o "#", que é o que a própria Scryfall mostra.
  if (info.edhrec) items.push(["EDHREC", "#" + info.edhrec.toLocaleString("pt-BR")]);
  if (info.reservada) items.push(["Lista reservada", "Sim — nunca será reimpressa"]);
  return items;
}

/* Preço de referência, e só: são os do mercado americano/europeu, não os de
   comprar no Brasil. Quem responde "quanto custa" é o botão de cotar.

   Único lugar da tela que NÃO passa pela régua do câmbio, de propósito: são
   quatro moedas de quatro mercados (dólar, dólar foil, euro e tix, que nem
   dinheiro é), cruas da Scryfall. Passar euro e tix por uma taxa de dólar
   inventaria um real que não existe em nenhum dos dois, e o rótulo de cada
   chip já diz em que moeda o número está. */
export function referencePrices(info: CardInfo): [string, string][] {
  const p = info.precos || {};
  return ([["US$", p.usd], ["US$ foil", p.usd_foil], ["€", p.eur], ["tix", p.tix]] as [string, string | null | undefined][])
    .filter(([, v]) => v) as [string, string][];
}
