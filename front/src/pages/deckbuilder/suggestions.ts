/* ------------------------------------------------------------- sugestões

   As cartas vêm do EDHREC já filtradas pelo servidor (sem o que o deck tem,
   sem o que a base local não conhece, sem o que não cabe na identidade), e
   com a carta completa junto — então adicionar é o mesmo clique da busca,
   sem uma segunda consulta.

   A aba responde a DUAS perguntas com a mesma lista. A padrão é a do
   comandante ("o que combina com ele?"); a estrela no hover de cada linha do
   deck troca pra outra ("já que o deck tem esta carta, o que mais entra?"),
   que é a pergunta que aparece quando o comandante já foi esgotado e o deck
   está meio montado. São listas parecidas o bastante pra se confundirem, e
   nenhuma carta listada denuncia de qual das duas veio — por isso a resposta
   traz `alvo` e o cabeçalho o diz por extenso. */

import { signal } from "@preact/signals";
import { applyImported, type Imported, type ImportNotice } from "./importExport";
import { openSheet, sheetOpen, switchRail } from "./layout";
import { api, saveNow, flushSave } from "./save";
import { addByDestination } from "./search";
import { state, touch } from "./state";
import type { Card } from "./types";
import { toast } from "./ui/toast";

export type Suggestion = { carta: Card; sinergia?: number | null; porcento?: number };
export type SuggestionsResponse = {
  alvo?: { tipo: string; nome?: string };
  temas?: { slug: string; nome: string; decks?: number }[];
  listas: { titulo: string; cartas: Suggestion[] }[];
  link: string;
  cache?: boolean;
};

export async function loadSuggestions({ theme = null, card = null }: { theme?: string | null; card?: string | null } = {}) {
  if (!state.commanders.length) {
    toast("Escolha o comandante primeiro: é ele que define o que combina.");
    return;
  }
  // Antes do primeiro `await`: quem chama daqui de dentro da tela troca de aba
  // na linha seguinte, e um deck ainda sem id (que passa pelo salvamento
  // abaixo) abriria a janela em que `rodarAoAbrir` não veria pedido nenhum em
  // voo e pediria a página do comandante por cima desta.
  state.suggestionsLoading = true;
  state.suggestionsTarget = card || state.commanders.map((c) => c.nome).join(" e ");
  state.suggestionsError = null;
  touch();
  try {
    if (!state.id) await saveNow();
    if (!state.id) {
      state.suggestionsError = "Não consegui salvar o deck antes de sugerir.";
      return;
    }
    state.suggestions = await api(`/decks/${state.id}/sugestoes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tema: card ? null : (theme || null), carta: card || null }),
    });
    // O tema é do comandante: a página de uma carta não tem nenhum, e deixar
    // o anterior guardado faria o "voltar ao comandante" cair num tema que a
    // pessoa escolheu duas listas atrás.
    state.suggestionsTheme = card ? null : (theme || null);
  } catch (e) {
    state.suggestionsError = (e as Error).message;
  } finally {
    state.suggestionsLoading = false;
    touch();
  }
}

/* A estrela de uma linha do deck. Pede a lista ANTES de trocar de aba, e não
   depois, porque `switchRail` também busca sugestão quando a aba chega vazia:
   com o pedido já em voo ele vê a bandeira e não pergunta a mesma coisa duas
   vezes pra dois alvos diferentes. */
export function suggestFromCard(name: string) {
  loadSuggestions({ card: name });
  switchRail("sugestoes");
  if (window.innerWidth <= 900 && !sheetOpen.value) openSheet();
}

/* Sugestão do EDHREC: a carta completa já veio junto, então adicionar é o
   mesmo clique da busca — com o mesmo destino, porque as duas abas do
   painel respondem a mesma pergunta. Depois ela sai da lista: continuar
   sugerindo o que a pessoa acabou de adicionar é o jeito mais rápido de a
   lista parecer burra. */
export function addSuggestion(card: Card) {
  addByDestination(card);
  for (const list of (state.suggestions as SuggestionsResponse | null)?.listas || []) {
    list.cartas = list.cartas.filter((c) => c.carta.nome !== card.nome);
  }
  touch();
}

/* ------------------------------------------------------------ deck médio

   A outra pergunta que o EDHREC responde nesta aba: não "que carta entra
   agora?", e sim "por onde eu começo?". O deck médio é a lista das cartas
   mais jogadas nos decks registrados com o comandante, estreitada por
   bracket e orçamento. Vem do servidor no formato do importar e entra pelo
   mesmo `applyImported`.

   Deck só com o comandante recebe a lista nele mesmo: não há carta pra
   perder. Com carta no deck, vale a regra do importar — pergunta antes, e o
   resultado vira um deck novo, com o de agora intacto em Meus decks. */
export const averageDeck = signal({ bracket: "", budget: "", running: false, notice: null as ImportNotice });

export function setAverageDeck(change: Partial<typeof averageDeck.value>) {
  averageDeck.value = { ...averageDeck.value, ...change };
}

export async function importAverageDeck() {
  if (!state.commanders.length) {
    toast("Escolha o comandante primeiro: o deck médio é dele.");
    return;
  }
  setAverageDeck({ running: true, notice: { note: "Pedindo o deck médio ao EDHREC…" } });
  let imported: Imported;
  try {
    imported = await api("/decks/deck-medio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        comandantes: state.commanders.map((c) => c.nome),
        bracket: averageDeck.value.bracket,
        orcamento: averageDeck.value.budget,
      }),
    });
  } catch (e) {
    return setAverageDeck({ running: false, notice: { error: (e as Error).message } });
  }
  setAverageDeck({ running: false });

  const hasCards = state.cards.length || state.maybe.length;
  if (hasCards && !confirm("Trocar as cartas do deck pelo deck médio do EDHREC?\n\n" +
      "O deck de agora continua salvo e na lista de Meus decks — mas esta janela passa a mostrar o deck médio.")) {
    return setAverageDeck({ notice: { note: "Importação cancelada." } });
  }
  applyImported(imported, { sameDeck: !hasCards });
  setAverageDeck({ notice: { imported } });

  // As sugestões foram zeradas junto com o deck antigo, e esta é a aba que
  // está à vista: pede de novo, contra o deck que acabou de entrar. Grava
  // antes, porque é o deck do SERVIDOR que filtra o que já está nele.
  if (await flushSave()) loadSuggestions({ theme: state.suggestionsTheme });
}
