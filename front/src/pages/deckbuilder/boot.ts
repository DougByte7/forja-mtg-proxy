/* ---------------------------------------------------------------- abertura

   O que a página faz ao abrir, depois de a tela estar montada: lê a conta e
   o deck do link, e dispara o que depende deles. */
import { signal } from "@preact/signals";
import { greetAccount, loadAccount } from "./account";
import { loadArts } from "./art";
import { openDrawer } from "./drawers";
import { importPastedLink } from "./importExport";
import { switchTab } from "./layout";
import { joinRoom, tableMode } from "./online";
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

/* O deck do link ainda a caminho. Sem isso, os segundos da requisição
   mostram a página de deck vazio, pedindo um comandante que o deck já tem. */
export const deckLoading = signal(new URLSearchParams(location.search).has("deck"));

async function loadDeckFromLink() {
  const id = new URLSearchParams(location.search).get("deck");
  if (!id) return;
  try {
    const r = await api(`/decks/${id}`);
    state.id = r.deck.id;
    state.name = r.deck.nome;
    state.validation = r.validacao;
    state.version = r.versao;
    state.commanders = (r.deck.comandantes_completos || []).filter(Boolean);
    const entry = (e: Entry): Entry => ({ carta: e.carta, quantidade: e.quantidade, categoria: e.categoria || "" });
    state.cards = ((r.deck.cartas_completas || []) as Entry[]).filter((e) => e.carta).map(entry);
    state.maybe = ((r.deck.maybeboard_completo || []) as Entry[]).filter((e) => e.carta).map(entry);
    state.categories = r.deck.categorias || [];
    state.owner = r.deck.dono || null;
    rememberDeck();
    setSaveStatus("salvo", "ok");
  } catch (e) {
    toast("Não achei esse deck: " + (e as Error).message);
    history.replaceState(null, "", location.pathname);
  } finally {
    deckLoading.value = false;
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
  // A mesa online do link (`?mesa=`, ver `online.ts`): a página abre na aba
  // do goldfish, já entrando nela. No modo mesa (o link de convite), a conta
  // vem antes: o lobby lista os decks dela, e sem ela listaria só os que o
  // navegador lembra.
  const room = new URLSearchParams(location.search).get("mesa");
  if (room && /^[A-Za-z0-9_-]{8,64}$/.test(room)) {
    if (tableMode.value) {
      document.title = "Mesa online · Forja";
      await account;
    }
    switchTab("goldfish");
    joinRoom(room);
  } else if (tableMode.value) {
    // Link de mesa quebrado: a página volta a ser o deckbuilder, com aviso.
    tableMode.value = false;
    toast("Esse link de mesa não está completo. Peça o link de novo a quem chamou.");
  }
  // O resto é de quem monta deck: no modo mesa não há busca nem deck à vista.
  if (tableMode.value) return;
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
  if (state.commanders.length) search();
  else searchCommander();
  // O link do Archidekt ou do Moxfield colado em Meus decks (`?importar=`):
  // a importação roda na gaveta, que é onde fica o recado do que não veio, e
  // o foco fica com ela. O parâmetro sai do endereço antes, pra um F5 não
  // importar de novo.
  const link = new URLSearchParams(location.search).get("importar");
  if (link) {
    history.replaceState(null, "", location.pathname);
    openDrawer("gaveta-importar");
    importPastedLink(link);
    return;
  }
  // Num quadro depois: a caixa que recebe o foco só existe na tela quando o
  // carregando do deck sai dela.
  requestAnimationFrame(() => {
    if (!state.commanders.length) document.getElementById("busca-cmd")?.focus();
    else if (window.innerWidth > 900) document.getElementById("busca")?.focus();
  });
}
