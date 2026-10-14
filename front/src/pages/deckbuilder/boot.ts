/* ---------------------------------------------------------------- abertura

   O que a página faz ao abrir, depois de a tela estar montada: lê a conta e
   o deck do link, e dispara o que depende deles. */
import { signal } from "@preact/signals";
import { greetAccount, loadAccount } from "./account";
import { loadArts } from "./art";
import { loadExchangeRate } from "./price";
import { redrawAll } from "./redraw";
import { api, rememberDeck, setSaveStatus } from "./save";
import { search, searchCommander } from "./search";
import { state } from "./state";
import { loadTokens } from "./tokens";
import type { Entry } from "./types";
import { toast } from "./ui/toast";

/* O aviso de base de cartas vazia ou em montagem, no topo do deck. */
export const cardBase = signal<{ cartas: number; rodando: boolean; lidas: number; erro?: string } | null>(null);

async function checkCardBase() {
  try {
    const base = await api("/cartas/estado");
    cardBase.value = base.cartas > 0 && !base.erro ? null : base;
    if (base.rodando) setTimeout(checkCardBase, 5000);
  } catch { /* a busca vai avisar sozinha se estiver fora do ar */ }
}

async function loadDeckFromLink() {
  const id = new URLSearchParams(location.search).get("deck");
  if (!id) return;
  try {
    const r = await api(`/decks/${id}`);
    state.id = r.deck.id;
    state.nome = r.deck.nome;
    state.validacao = r.validacao;
    state.versao = r.versao;
    state.comandantes = (r.deck.comandantes_completos || []).filter(Boolean);
    const entry = (e: Entry): Entry => ({ carta: e.carta, quantidade: e.quantidade, categoria: e.categoria || "" });
    state.cartas = ((r.deck.cartas_completas || []) as Entry[]).filter((e) => e.carta).map(entry);
    state.maybe = ((r.deck.maybeboard_completo || []) as Entry[]).filter((e) => e.carta).map(entry);
    state.categorias = r.deck.categorias || [];
    state.dono = r.deck.dono || null;
    rememberDeck();
    setSaveStatus("salvo", "ok");
  } catch (e) {
    toast("Não achei esse deck: " + (e as Error).message);
    history.replaceState(null, "", location.pathname);
  }
}

export async function boot() {
  checkCardBase();
  // Sem `await`: a taxa é a régua do preço, não o deck. Ela redesenha sozinha
  // quando chega, e enquanto não chega a tela mostra dólar em vez de esperar.
  loadExchangeRate();
  // Junto do deck, e não depois dele: o autosave pergunta se há conta, e a
  // primeira carta pode entrar antes de um `/conta` que viesse em seguida.
  const account = loadAccount();
  await loadDeckFromLink();
  redrawAll();
  // Depois do deck, de propósito: a oferta de reclamar precisa saber se este
  // deck tem dono, e o convite, se há deck aberto.
  account.then(greetAccount);
  // As artes escolhidas, uma vez: a lista desenha 100 botões e uma consulta
  // por botão seria 100 requisições.
  loadArts();
  // As fichas vão pro papel com o deck: sem elas, a aba Artes e o "Gerar
  // pedido" contariam só as cartas até a aba Tokens ser aberta.
  if (state.id) loadTokens();
  // O foco na busca só faz sentido onde ela está sempre à vista: no celular
  // ela é uma folha fechada, e focar dentro dela abriria o teclado sobre uma
  // superfície invisível.
  if (state.comandantes.length) {
    search();
    if (window.innerWidth > 900) document.getElementById("busca")?.focus();
  } else {
    searchCommander();
    document.getElementById("busca-cmd")?.focus();
  }
}
