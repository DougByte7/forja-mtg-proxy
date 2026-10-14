/* ------------------------------------------- o que se faz com a mesa

   Os cliques, o menu de cada carta, o painel da carta e as quatro modais
   (buscar numa zona, criar ficha, pôr o segundo deck, ver o resumo do fim).
   Tudo o que muda a mesa passa por `saveTableSnapshot()` antes — é o que faz
   o Ctrl+Z valer pra qualquer jogada, e não só pras que alguém lembrou de
   tratar.

   As regras são de `goldfish.ts`, que roda no teste sem DOM nenhum por
   perto; o desenho é `ui/Goldfish*.tsx`. Aqui fica o estado da TELA da mesa
   (menu aberto, modal aberta, a carta no painel), em signals, e as ações que
   juntam regra e redesenho.

   A mesa tem a revisão dela (`tableRevision`): uma jogada redesenha só a
   mesa, e não a lista, a análise e as chances do deck inteiro. */
import { signal } from "@preact/signals";
import { fetchCardInfo } from "./cardDetail";
import { countedCards } from "./deck";
import {
  addSecondDeck, adjustCommanderDamage, adjustLife, adjustPlayerCounter, cardByUid, clearCombat,
  createToken, deckFromResponse, draw, keepHand, londonMulligan, moveToZone, passTurn,
  putOnBottom, removeSecondDeck, reposition, saveTableSnapshot, screenDeck, setUpTable,
  shuffleLibrary, toggleTapped, undoTableStep, fitsInRow, type TokenModel, type Zone,
} from "./goldfish";
import { readLocalDecks } from "../../shared/localDecks";
import { api } from "./save";
import { state } from "./state";
import { toast } from "./ui/toast";

export const tableRevision = signal(0);

/* A mesa mudou. Com o painel aberto numa carta que deixou de existir (ficha
   que saiu do campo, mesa nova), ele fecha. */
export function touchTable() {
  const uid = detail.value?.uid;
  if (uid != null && (!state.table || !cardByUid(uid))) hideDetail();
  tableRevision.value++;
}

/* Uma jogada: foto pro desfazer, a regra, o redesenho. */
function play(rule: () => unknown, gesture?: string) {
  if (!state.table) return;
  saveTableSnapshot(gesture);
  rule();
  touchTable();
}

export function undoTable() {
  if (undoTableStep()) touchTable();
}

/* D compra pra quem está na vez e Espaço passa o turno. Devolve se a tecla
   era da mesa, pra quem ouve o teclado parar ali. Tecla segurada não repete:
   um Espaço que escorrega não pode passar três turnos. O Espaço também não
   chega ao botão que estiver com o foco — senão o turno passaria e o botão
   seria clicado junto. */
export function tableShortcut(e: KeyboardEvent) {
  if (!state.table || e.ctrlKey || e.metaKey || e.altKey) return false;
  const space = e.key === " ";
  if (!space && e.key.toLowerCase() !== "d") return false;
  e.preventDefault();
  if (e.repeat) return true;
  closeTableMenu();
  play(() => space ? passTurn() : draw(state.table!.active, 1));
  return true;
}

/* ------------------------------------------------------- os botões do topo */

export function shuffleUp() {
  if (!countedCards().length && !state.commanders.length) return toast("Monte o deck primeiro.");
  hideDetail();   // os uids recomeçam do 1 na mesa nova
  setUpTable([screenDeck()]);
  touchTable();
}

export const passTheTurn = () => play(passTurn);
export const endCombat = () => play(clearCombat);

/* Abrir o log não é jogada: não passa pelo `saveTableSnapshot`. */
export function toggleLog() {
  if (!state.table) return;
  state.table.logOpen = !state.table.logOpen;
  touchTable();
}

export function secondDeckButton() {
  if (!state.table) return;
  if (state.table.players.length > 1) return play(removeSecondDeck);
  openTableModal({ kind: "second" });
}

export const fullscreen = signal(false);

/* O painel troca de modo junto (ver `panelFloats`). */
export function setFullscreen(on: boolean) {
  hideDetail();
  fullscreen.value = on;
  document.body.classList.toggle("gf-cheia", on);
}

/* --------------------------------------------------------- jogadas da mesa */

/* Shift no clique anda de 5 em 5: vida e dano de comandante são os dois
   passos que a mesa usa, dano de criatura e dano de comandante. Clique
   repetido conta como um passo só (ver `saveTableSnapshot`). */
export function changeLife(player: number, n: number) {
  play(() => adjustLife(player, n), "vida" + player);
}

export function changePlayerCounter(player: number, name: string, n: number) {
  play(() => adjustPlayerCounter(player, name, n), "marca" + player + name);
}

export function changeCommanderDamage(player: number, from: number, n: number) {
  play(() => adjustCommanderDamage(player, from, n), "dano" + player + from);
}

export const keep = (player: number) => play(() => keepHand(player));
export const mulligan = (player: number) => play(() => londonMulligan(player));

/* O ícone de deitar age na hora, antes de a carta virar menu: ele existe
   justamente pra o gesto mais repetido da mesa não passar pelo menu. */
export function tapFromIcon(uid: number) {
  closeTableMenu();
  play(() => toggleTapped(uid));
}

/* Na fase de mandar pro fundo, clicar na mão é ESCOLHER — não abrir menu. */
export function clickCard(uid: number, anchor: Element) {
  const c = cardByUid(uid);
  if (c && state.table!.players[c.owner].phase === "fundo" && zoneOfHand(uid)) {
    return play(() => putOnBottom(uid));
  }
  openTableMenu({ kind: "card", uid }, anchor);
}

function zoneOfHand(uid: number) {
  return state.table!.players.some((p) => p.mao.some((c) => c.uid === uid));
}

/* ------------------------------------------------------------------ menus */

export type TableMenu =
  | { kind: "card"; uid: number }
  | { kind: "counter"; player: number }
  | { kind: "deck"; player: number };

/* O menu aberto e onde. Um item que `fica` não fecha o menu: ele se redesenha
   no mesmo lugar, com o número novo, que é o que faz clicar três vezes em
   "+1/+1" ser um gesto só em vez de três aberturas de menu. */
export const tableMenu = signal<(TableMenu & { x: number; y: number }) | null>(null);

export function openTableMenu(menu: TableMenu, anchor: Element) {
  const r = anchor.getBoundingClientRect();
  tableMenu.value = { ...menu, x: r.left, y: r.bottom + 4 };
}

export function closeTableMenu() {
  tableMenu.value = null;
}

/* Um item do menu. `undo: false` é o que não é jogada ("Ver a carta"). */
export function runMenuItem(fn: () => unknown, { stay = false, gesture = undefined as string | undefined, undo = true } = {}) {
  if (undo) saveTableSnapshot(gesture);
  fn();
  if (!stay) closeTableMenu();
  touchTable();
}

/* ----------------------------------------------------------------- modais */

export type TableModal =
  | { kind: "search"; player: number; zone: Zone }
  | { kind: "token"; player: number }
  | { kind: "second" }
  | { kind: "summary" };

export const tableModal = signal<TableModal | null>(null);

export function openTableModal(modal: TableModal) {
  closeTableModal();
  tableModal.value = modal;
}

export function isTableModalOpen() {
  return !!tableModal.value;
}

/* A busca no baralho REEMBARALHA ao fechar. Olhar a biblioteca inteira e
   devolvê-la na ordem em que estava é a única coisa que este simulador faria
   por você e que na mesa de verdade seria trapaça. */
export function closeTableModal() {
  const modal = tableModal.value;
  if (!modal) return;
  tableModal.value = null;
  if (modal.kind === "search" && modal.zone === "baralho") {
    play(() => shuffleLibrary(modal.player));
  }
}

export function sendFromSearch(uid: number, zone: Zone) {
  play(() => moveToZone(uid, zone));
}

/* Os modelos de ficha que a pessoa monta ficam no navegador: uma mesa de
   Commander cria as mesmas três fichas a partida inteira, e redigitar
   "Soldado 1/1 branco" a cada uma delas é o tipo de trabalho que faz a pessoa
   parar de usar a ficha e começar a "lembrar" que ela está lá. */
const SAVED_TOKENS_KEY = "forja.goldfish.fichas";

export function savedTokens(): TokenModel[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_TOKENS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveTokenModel(model: TokenModel) {
  try {
    const same = (m: TokenModel) => m.nome === model.nome && m.poder === model.poder &&
                                    m.resistencia === model.resistencia;
    localStorage.setItem(SAVED_TOKENS_KEY, JSON.stringify(
      [model, ...savedTokens().filter((m) => !same(m))].slice(0, 12)));
  } catch { /* navegador privado: a lista é conveniência */ }
}

/* `remember` é a ficha montada à mão, que entra na lista do navegador. */
export function makeToken(player: number, model: TokenModel, howMany: number | string, remember = false) {
  if (remember) saveTokenModel(model);
  tableModal.value = null;
  play(() => createToken(player, model, howMany));
}

export type DeckOption = { id: string; nome: string; de: string };

/* Os decks vêm de dois lugares porque a conta é opcional nesta página: o
   navegador lembra o que foi montado aqui, e quem entrou tem os seus em
   qualquer aparelho. A união dos dois é a lista que a pessoa reconhece. */
export async function listDecks(): Promise<DeckOption[]> {
  const byId = new Map<string, DeckOption>();
  for (const d of readLocalDecks()) byId.set(d.id, { id: d.id, nome: d.nome, de: "neste navegador" });
  if (state.user) {
    try {
      const r = await api("/decks/meus");
      for (const d of r.decks || []) byId.set(d.id, { id: d.id, nome: d.nome || "Deck sem nome", de: "da sua conta" });
    } catch { /* sem rede, fica o que o navegador lembra */ }
  }
  return [...byId.values()];
}

/* Devolve se o deck entrou; o erro já foi dito. */
export async function putSecondDeck(id: string) {
  try {
    const [r, arts] = await Promise.all([
      api(`/decks/${id}`),
      // Sem as escolhas o deck entra com as artes padrão, o que é melhor do
      // que não entrar.
      api(`/decks/${id}/artes`).catch(() => ({})),
    ]);
    tableModal.value = null;
    play(() => addSecondDeck(deckFromResponse(r, id, arts.escolhas)));
    return true;
  } catch (e) {
    toast("Não consegui abrir esse deck: " + (e as Error).message);
    return false;
  }
}

/* -------------------------------------------------------- o painel da carta */

/* `data` é o detalhe da Scryfall quando já chegou (ver `fetchCardInfo`), e é
   dele que saem poder, resistência, lealdade e defesa, que a base local não
   guarda. `floats` e `left` são medidos ao abrir. */
export const detail = signal<{ uid: number; data: any; floats: boolean; left: string } | null>(null);

const PANEL_WIDTH = 288;   // o `width` de `.gf-detalhe` no CSS
const PANEL_GAP = 16;

/* Flutuando (fora da tela cheia) o painel cobre a busca, então ele some
   quando o mouse sai da carta. Na coluna reservada da tela cheia ele é o
   lugar da carta, e fica com a última carta olhada até o próximo hover.
   Quem decide o modo é o CSS (`body.gf-cheia .gf-coluna`); o script só lê. */
export function panelFloats() {
  const panel = document.getElementById("gf-detalhe");
  return !!panel && getComputedStyle(panel).position === "fixed";
}

export function hideDetail() {
  detail.value = null;
}

/* Hover numa carta da mesa — de qualquer zona — abre a carta grande com o
   que decide a jogada. Flutuando, o painel fica preso à mesa e não ao
   cursor: as cartas são grandes, e seguindo o mouse ele cobriria as vizinhas
   que a pessoa está comparando. */
export async function showDetail(uid: number) {
  // O mouseover dispara de novo a cada filho da carta (o nome, um marcador):
  // repintar ali pediria o detalhe de novo à toa.
  if (detail.value?.uid === uid) return;
  const c = cardByUid(uid);
  if (!c) return hideDetail();
  const floats = panelFloats();
  const table = document.getElementById("gf-mesa");
  const left = floats && table
    ? Math.max(8, table.getBoundingClientRect().left - PANEL_WIDTH - PANEL_GAP) + "px" : "";
  detail.value = { uid, data: null, floats, left };

  // Ficha inventada na hora não existe na Scryfall.
  const name = c.token ? "" : c.card?.nome;
  if (!name) return;
  let data;
  try {
    data = await fetchCardInfo(name);
  } catch {
    return;   // fica o que a base local sabe, que é o que já está na tela
  }
  if (detail.value?.uid === uid) detail.value = { ...detail.value, data };
}

/* A roda do mouse rola o painel FLUTUANTE, porque a barra dele não tem como
   ser agarrada: ele não pega o ponteiro (senão fecharia a carta que o abriu,
   ver `.gf-detalhe`), e a mão de quem lê está na carta, do outro lado da
   mesa. Rolar dali é o único caminho até o texto que não coube.

   Devolve `true` só quando o painel de fato andou. No fim da rolagem ele
   devolve o gesto ao documento, senão parar no último combo prenderia a
   página inteira embaixo do cursor. Na tela cheia não faz nada: lá o painel
   mora numa coluna, pega o ponteiro e rola pela barra como qualquer texto. */
export function scrollDetail(amount: number) {
  if (!detail.value || !panelFloats()) return false;
  const body = document.getElementById("gf-detalhe-corpo");
  if (!body) return false;
  const end = body.scrollHeight - body.clientHeight;
  if (end <= 0) return false;
  const before = body.scrollTop;
  body.scrollTop = Math.max(0, Math.min(end, before + amount));
  body.dispatchEvent(new Event("scroll"));
  return body.scrollTop !== before;
}

/* ------------------------------------------------------------- arrastar */

/* Atalho de quem tem mouse, nunca o único caminho: no toque não existe
   `dragstart`, e a mesma carta se move pelo menu dela. Só aceita a zona do
   DONO da carta — a criatura do outro que morre vai pro cemitério dele, e
   deixar soltá-la no meu faria a mesa mentir sobre de quem é a carta.

   Soltar SOBRE uma carta do campo arruma a fila: a arrastada entra do lado
   dela em que o ponteiro está (ver `reposition`). Vale também pra carta que
   chega da mão, que desce já no lugar escolhido.

   O arrastar é de eventos nativos e marca as classes direto no DOM: são
   marcas de um gesto em curso, que nenhum redesenho precisa conhecer. */
let dragging: number | null = null;

function dropArea(e: DragEvent) {
  if (dragging === null) return null;
  const area = (e.target as Element).closest?.("[data-gf-solta]") as HTMLElement | null;
  if (!area) return null;
  const c = cardByUid(dragging);
  if (!c || Number(area.dataset.gfJ) !== c.owner) return null;
  return area;
}

/* A carta do campo sob o ponteiro, quando a arrastada pode entrar do lado
   dela — mesmo dono e mesma fila. Fora disso, soltar ali é soltar na área. */
function dropSlot(e: DragEvent) {
  if (dragging === null) return null;
  const el = (e.target as Element).closest?.("[data-gf-uid]") as HTMLElement | null;
  if (!el) return null;
  const uid = Number(el.dataset.gfUid);
  if (!fitsInRow(dragging, uid)) return null;
  const r = el.getBoundingClientRect();
  return { el, uid, after: e.clientX > r.left + r.width / 2 };
}

const DROP_MARKS = ["alvo-solta", "solta-antes", "solta-depois"];

/* Uma marca por vez na mesa: a área que recebe, ou o lado da carta onde a
   arrastada vai entrar. `dragover` dispara a cada movimento do mouse, então
   só mexe nas classes quando a marca muda. */
function markDrop(root: Element, el: Element | null, cls?: string) {
  if (el && cls && el.classList.contains(cls)) return;
  root.querySelectorAll("." + DROP_MARKS.join(",.")).forEach((x) => x.classList.remove(...DROP_MARKS));
  if (el && cls) el.classList.add(cls);
}

export function onTableDragStart(e: DragEvent) {
  const b = (e.target as Element).closest?.("[data-gf-uid]") as HTMLElement | null;
  if (!b) return;
  if (panelFloats()) hideDetail();
  dragging = Number(b.dataset.gfUid);
  b.classList.add("arrastando");
  e.dataTransfer!.effectAllowed = "move";
  // Firefox só dispara `drop` quando alguma coisa foi escrita aqui.
  e.dataTransfer!.setData("text/plain", b.dataset.gfUid!);
}

export function onTableDragEnd(e: DragEvent) {
  dragging = null;
  const root = e.currentTarget as Element;
  root.querySelectorAll(".arrastando").forEach((el) => el.classList.remove("arrastando"));
  markDrop(root, null);
}

export function onTableDragOver(e: DragEvent) {
  const slot = dropSlot(e);
  const area = slot ? null : dropArea(e);
  if (!slot && !area) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  const root = e.currentTarget as Element;
  if (slot) markDrop(root, slot.el, slot.after ? "solta-depois" : "solta-antes");
  else markDrop(root, area, "alvo-solta");
}

export function onTableDrop(e: DragEvent) {
  const slot = dropSlot(e);
  const area = slot ? null : dropArea(e);
  if (!slot && !area) return;
  e.preventDefault();
  const uid = dragging!;
  dragging = null;
  markDrop(e.currentTarget as Element, null);
  play(() => {
    if (slot) {
      moveToZone(uid, "campo");   // não faz nada se ela já está no campo
      reposition(uid, slot.uid, slot.after);
    } else {
      moveToZone(uid, area!.dataset.gfSolta!);
    }
  });
}

/* --------------------------------------------- os ouvintes do documento */

/* No documento, e não na mesa: sair da mesa por qualquer borda também é sair
   da carta. A roda com o cursor numa carta rola o painel, não a página (ver
   `scrollDetail`), com `passive:false` porque segurar a rolagem da página
   exige `preventDefault`. E o clique fora fecha o menu da mesa. Devolve quem
   desliga os três. */
export function bindTableDocument() {
  const over = (e: MouseEvent) => {
    const card = (e.target as Element).closest?.("#gf-mesa [data-gf-uid]") as HTMLElement | null;
    if (card) return void showDetail(Number(card.dataset.gfUid));
    if (detail.value && panelFloats()) hideDetail();
  };
  const wheel = (e: WheelEvent) => {
    if (!(e.target as Element).closest?.("#gf-mesa [data-gf-uid]")) return;
    // `deltaMode` 1 conta LINHAS, não pixels: sem a conversão a roda andaria
    // três pixels por clique nos navegadores que reportam assim.
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (scrollDetail(step)) e.preventDefault();
  };
  const click = (e: MouseEvent) => {
    const t = e.target as Element;
    if (!t.closest?.(".gf-menu") && !t.closest?.("[data-gf-uid]") && !t.closest?.("[data-gf-acao]")) closeTableMenu();
  };
  document.addEventListener("mouseover", over);
  document.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("click", click);
  return () => {
    document.removeEventListener("mouseover", over);
    document.removeEventListener("wheel", wheel);
    document.removeEventListener("click", click);
  };
}
