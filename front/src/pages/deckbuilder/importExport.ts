/* --------------------------------------------------------------- importar

   Quem chega aqui quase nunca chega do zero: chega com um deck que já mantém
   em outro lugar. O servidor traz a lista e resolve os nomes na base local
   (ver `importar.py` e `decks.importado_para_deck`); esta parte só põe o
   resultado na tela.

   O deck importado NÃO substitui o atual em silêncio. Se já há carta na
   mesa, pergunta — perder duas horas de montagem por um clique errado num
   botão de importar seria o pior estrago que esta tela sabe fazer. */
import { signal } from "@preact/signals";
import { copyText } from "../../shared/clipboard";
import { pushUndo } from "./editing";
import { redrawAll } from "./redraw";
import { api, scheduleSave } from "./save";
import { search } from "./search";
import { SIDEBOARD, state } from "./state";
import type { Card, Entry } from "./types";
import { toast } from "./ui/toast";

/** O que o servidor devolve de uma importação (e do deck médio). */
export type Imported = {
  nome?: string; fonte?: string; link?: string; decks?: number; categorias?: string[];
  comandantes_completos: Card[];
  cartas_completas: Entry[];
  maybeboard_completo?: Entry[];
  nao_encontradas?: { nome: string }[];
};

/* O recado de uma importação, numa caixa (a gaveta, ou o bloco do deck
   médio): uma nota enquanto trabalha ou depois de cancelar, um erro, ou o
   que veio. */
export type ImportNotice = { note: string } | { error: string } | { imported: Imported } | null;

export const importForm = signal({ url: "", text: "", running: false, notice: null as ImportNotice });

function setForm(change: Partial<typeof importForm.value>) {
  importForm.value = { ...importForm.value, ...change };
}

export function setImportField(field: "url" | "text", value: string) {
  setForm({ [field]: value });
}

export async function runImport() {
  const url = importForm.value.url.trim();
  const text = importForm.value.text.trim();
  if (!url && !text) return setForm({ notice: { error: "Cole o link do deck ou a lista em texto." } });

  setForm({ running: true, notice: { note: "Trazendo a lista…" } });
  let imported: Imported;
  try {
    imported = await api("/decks/importar", {
      method: "POST",
      body: url ? { url } : { texto: text, nome: state.name },
    });
  } catch (e) {
    return setForm({ running: false, notice: { error: (e as Error).message } });
  }
  setForm({ running: false });

  const count = (list: Entry[] | undefined) => (list || []).reduce((n, e) => n + e.quantidade, 0);
  const total = count(imported.cartas_completas) + imported.comandantes_completos.length + count(imported.maybeboard_completo);
  if (state.cards.length || state.commanders.length) {
    if (!confirm(`Trocar o deck atual pelas ${total} cartas importadas?\n\n` +
                 "O deck de agora continua salvo e na lista de Meus decks — " +
                 "mas esta janela passa a mostrar o importado.")) {
      return setForm({ notice: { note: "Importação cancelada." } });
    }
  }
  applyImported(imported);
  setForm({ notice: { imported } });
}

/* Importar o link que foi colado na busca de comandante. O trabalho é o
   mesmo da gaveta, e é pra lá que este atalho leva: o recado do que veio
   precisa de uma superfície que continue na tela, e a tela do comandante
   desaparece no instante em que o deck importado traz um. A lista em texto
   que tenha sobrado de uma importação anterior não vale aqui: quem colou um
   link pediu o link. */
export function importPastedLink(url: string) {
  setForm({ url, text: "" });
  return runImport();
}

/* O deck importado vira um deck NOVO, com id novo.

   Escrever por cima do deck aberto apagaria do servidor o que alguém pode ter
   compartilhado por link. Um id novo custa uma linha no banco e não destrói
   nada — é a mesma escolha do botão "duplicar".

   `sameDeck` é a exceção, pra quem chama sabendo que o deck aberto não tem o
   que perder: só o comandante, nenhuma carta (ver `importAverageDeck`). Aí o
   id novo é que faria estrago — deixaria em Meus decks um deck vazio. */
export function applyImported(imported: Imported, { sameDeck = false } = {}) {
  pushUndo();
  // Deck novo nasce WIP, e o histórico era do deck que ficou pra trás.
  if (!sameDeck) {
    state.id = null;
    state.version = state.history = null;
  }
  state.validation = null;
  state.commanders = imported.comandantes_completos;
  const entry = (e: Entry): Entry => ({ carta: e.carta, quantidade: e.quantidade, categoria: e.categoria || "" });
  state.cards = imported.cartas_completas.map(entry);
  // O maybeboard do site de origem vem junto: é o mesmo rascunho, e trazer
  // só as 100 obrigaria a copiar à mão a parte da lista que a pessoa ainda
  // estava decidindo (ver `importar.py`).
  state.maybe = (imported.maybeboard_completo || []).map(entry);
  state.categories = imported.categorias || [];
  // As análises são do deck que acabou de ser substituído. Deixá-las na
  // tela mostraria a curva de um deck e os combos de outro — e a cotação
  // também: os preços da loja eram das cartas de lá.
  state.combos = state.power = state.suggestions = state.manabase = null;
  state.combosAdded = 0;
  state.quote = state.quoteError = null;

  // No mesmo deck, o nome que a pessoa deu fica: ele é dela, e o que mudou
  // foram as cartas. Só o nome de fábrica cede lugar ao que veio.
  if (imported.nome && (!sameDeck || state.name === "Deck sem nome")) state.name = imported.nome;
  if (!sameDeck) history.replaceState(null, "", location.pathname);
  redrawAll();
  search();
  scheduleSave();
}

/* O que se diz depois de importar, como dados (o desenho é
   `ui/ImportNotice.tsx`). */
export function importSummary(imported: Imported) {
  const sum = (list: Entry[] | undefined) => (list || []).reduce((n, e) => n + e.quantidade, 0);
  return {
    total: sum(imported.cartas_completas) + imported.comandantes_completos.length,
    source: imported.fonte || "",
    commanders: imported.comandantes_completos.map((c) => c.nome).join(" + "),
    maybe: sum(imported.maybeboard_completo),
    side: sum(imported.cartas_completas.filter((e) => e.categoria === SIDEBOARD)),
    missing: (imported.nao_encontradas || []).map((c) => c.nome),
    noCommander: !imported.comandantes_completos.length,
  };
}

/* --------------------------------------------------------------- exportar */

/* O sideboard entra e o maybeboard não, pelo mesmo critério da cotação: esta
   lista é o que vai pra impressão, e o que ainda está sendo decidido não vai
   pra impressão. Igual ao `decks.lista_texto` do servidor. */
export function listText() {
  const lines = state.commanders.map((c) => `1 ${c.nome}`);
  for (const e of state.cards) lines.push(`${e.quantidade} ${e.carta.nome}`);
  return lines.join("\n");
}

export async function exportList() {
  const text = listText();
  if (!text) return toast("Deck vazio.");
  if (await copyText(text)) return toast("Lista copiada — cole no MPC Fill pra escolher as artes.");
  // Sem área de transferência: mostra o texto pra copiar na mão em vez de
  // falhar calado.
  const tab = window.open("", "_blank");
  if (!tab) return toast("Não consegui copiar. Use o link de baixar a lista.");
  const pre = tab.document.createElement("pre");
  pre.textContent = text;
  tab.document.body.append(pre);
}
