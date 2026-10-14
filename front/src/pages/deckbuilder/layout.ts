/* ------------------------------------------------------------------- abas

   Duas fitas de abas — a das respostas sobre o deck (centro) e a do painel
   de adicionar (esquerda) —, a folha de baixo do celular e a coluna do
   maybeboard. Trocar de aba não recalcula nada que já esteja em dia: os
   painéis do centro são desenhados a cada mudança do deck, estejam à vista
   ou não, senão abrir "Análise" mostraria o deck de dois minutos atrás por
   um quadro. */
import { signal } from "@preact/signals";
import { deckSignature, searchCombos } from "./combos";
import { analyzeManabase } from "./manabase";
import { estimatePower } from "./power";
import { state, touch } from "./state";
import { loadSuggestions } from "./suggestions";
import { loadTokens } from "./tokens";
import { loadHistory } from "./versions";

export type Tab = "deck" | "artes" | "analise" | "manabase" | "combos" | "tokens" | "goldfish" | "historico";
export type Rail = "buscar" | "sugestoes" | "combos";

/* Abrir a aba é o pedido: quem clica em "Análise" quer a análise inteira,
   nível de poder incluído, não um botão que promete o nível. A conta só sai
   se ainda não houver resposta ou se o deck tiver mudado desde a última —
   trocar de aba ida e volta não repete consulta. */
function runOnOpen(name: string) {
  if (!state.comandantes.length) return;
  if (name === "manabase" && !state.manabase) return analyzeManabase();
  // Sempre, e não só na primeira vez: o bloco do que mudou desde a última
  // versão acompanha a lista gravada.
  if (name === "historico") return loadHistory();
  // As sugestões dependem do comandante, não da lista: refazê-las a cada
  // carta adicionada seria uma consulta por clique pra receber quase a mesma
  // resposta. Busca uma vez; o botão do painel refaz quando a pessoa quiser.
  if (name === "sugestoes" && !state.sugestoes && !state.sugestoesRodando) {
    return loadSuggestions({ theme: state.sugestoesTema });
  }
  const signature = deckSignature();
  if (name === "analise" && state.poderAssinatura !== signature) return estimatePower();
  if (name === "combos" && state.combosAssinatura !== signature) return searchCombos();
  if (name === "tokens" && state.tokensAssinatura !== signature) return loadTokens();
  // O goldfish NÃO embaralha sozinho ao abrir a aba, ao contrário das outras:
  // as demais recalculam algo sobre o deck, e recalcular é de graça; aqui
  // "recalcular" seria jogar fora a mesa que a pessoa está jogando.
}

export function switchTab(name: Tab) {
  state.aba = name;
  touch();
  runOnOpen(name);
}

/* No computador a busca está sempre à vista e receber o foco ao trocar de
   aba é o que se espera. No celular ela é uma folha: quem abre a folha é
   `openSheet`, e é ele quem foca — depois da animação. */
export function switchRail(name: Rail) {
  state.rail = name;
  touch();
  if (name === "buscar" && window.innerWidth > 900) focusSearch();
  if (name === "combos" || name === "sugestoes") runOnOpen(name);
}

export function focusSearch() {
  document.getElementById("busca")?.focus();
}

/* ------------------------------------------------- folha de baixo (celular)

   A busca não é uma coluna no telefone: é uma tarefa que se abre por cima do
   deck, se usa e se fecha. */
export const sheetOpen = signal(false);

export function openSheet() {
  sheetOpen.value = true;
  switchRail(state.rail as Rail);
  setTimeout(focusSearch, 220);
}

export function closeSheet() {
  sheetOpen.value = false;
}

/* ---------------------------------------------------- coluna do maybeboard

   Recolher fica guardado no navegador: quem não usa maybeboard recolhe uma
   vez e recupera a coluna pra sempre, e quem usa não recolhe nunca. Refazer
   essa escolha a cada visita seria cobrar por uma decisão já tomada. */
const MAYBE_KEY = "forja.deck.talvez-aberto";

export const maybeCollapsed = signal(false);
try { maybeCollapsed.value = localStorage.getItem(MAYBE_KEY) === "0"; }
catch { /* navegador privado: a coluna abre, que é o padrão */ }

export function toggleMaybeColumn(force?: boolean) {
  const collapsed = force !== undefined ? force : !maybeCollapsed.value;
  maybeCollapsed.value = collapsed;
  try { localStorage.setItem(MAYBE_KEY, collapsed ? "0" : "1"); } catch { /* vale só pra esta visita */ }
}

/* O atalho no cabeçalho de Terrenos rola até o painel da mana base e o faz
   piscar: sobe a cada chamada, e o painel reinicia a animação. */
export const manabaseCall = signal(0);
