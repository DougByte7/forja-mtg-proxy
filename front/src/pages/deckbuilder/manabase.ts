/* ------------------------------------------------------------- mana base

   A análise vem de `app/manabase.py`. Aqui fica o pedido, o ciclo aberto e
   as ações de pôr terreno no deck; o desenho é `ui/Manabase.tsx`. */
import { $ } from "../../shared/dom.js";
import { desenharTudo } from "./desenho.js";
import { addCard, findEntry, pushUndo } from "./editing";
import { trocarAba } from "./paineis.js";
import { agendarSalvar, api, salvarAgora } from "./salvar.js";
import { state, touch } from "./state";
import type { Card } from "./types";
import { toast } from "./ui/toast";

export type FixingLand = Card & { produz: string; entrada?: string; no_deck?: boolean };
export type Cycle = {
  id: string; nome: string; descricao: string; grupo: string; total: number; no_deck: number;
  acima_do_teto?: number; terrenos: FixingLand[];
};
export type Basic = { nome: string; cor: string; quantidade: number; carta: Card | null };
export type ManabaseResponse = {
  terrenos: { tem: number; recomendado: number; diferenca: number };
  cmc_media: number; magias: number; rampas_baratas?: number;
  cores: { cor: string; nome: string; pips: number; parte: number; fontes: number; pedidas: number;
           faltam: number; fora_do_terreno?: number }[];
  base_atual?: { entrada: Record<string, number>; grupos: { id: string; nome: string; quantidade: number; cartas: string[] }[] };
  basicos: Basic[];
  fixadores: Cycle[];
  monocolor?: boolean;
  teto_usd: number;
};

/* Só a resposta do pedido mais recente vale. Abrir um ciclo e o autosave
   pedem a análise em paralelo, e a resposta que chega por último não é
   necessariamente a do último pedido — sem isto, um autosave lento fecharia
   o ciclo que acabou de ser aberto. */
let latestRequest = 0;

export async function analyzeManabase() {
  if (!state.comandantes.length) {
    toast("Escolha o comandante primeiro: é a identidade dele que define as cores.");
    return;
  }
  if (!state.id) await salvarAgora();
  if (!state.id) { toast("Não consegui salvar o deck antes de analisar."); return; }
  // Só avisa que está calculando quando ainda não há resposta na tela. Nos
  // recálculos do autosave, apagar a conta anterior faria o painel piscar a
  // cada carta digitada.
  if (!state.manabase) { state.manabaseRodando = true; touch(); }
  const request = ++latestRequest;
  const params = [];
  if (state.manabaseTeto !== null) params.push(`teto=${state.manabaseTeto}`);
  if (state.mbCategoria) params.push(`categoria=${encodeURIComponent(state.mbCategoria)}`);
  try {
    const response = await api(`/decks/${state.id}/manabase${params.length ? "?" + params.join("&") : ""}`);
    if (request !== latestRequest) return;
    state.manabase = response;
    state.manabaseErro = null;
    // O ciclo aberto pode sumir da resposta — o comandante mudou e a
    // identidade com ele. Aí a tela volta pra visão geral.
    if (!response.fixadores.some((c: Cycle) => c.id === state.mbCategoria)) state.mbCategoria = "";
  } catch (e) {
    if (request !== latestRequest) return;
    state.manabaseErro = (e as Error).message;
  } finally {
    if (request === latestRequest) { state.manabaseRodando = false; touch(); }
  }
}

/** O teto de preço dos terrenos sugeridos, em DÓLAR (é o que o servidor filtra). */
export function setPriceCap(usd: number) {
  state.manabaseTeto = usd;
  return analyzeManabase();
}

/* Abrir um ciclo desenha na hora com os terrenos que já estão na tela e
   pede o ciclo inteiro por trás. Quem clicou em "Ver todos" no fim da visão
   geral fica olhando pro vazio se a lista encolhe embaixo dele, e quem
   clicou numa pílula de "Sua base" abriu algo que está abaixo da dobra —
   nos dois casos a tela vai até o começo da seção. */
export function openCycle(id: string) {
  state.mbCategoria = id || "";
  touch();
  requestAnimationFrame(() => {
    const section = document.querySelector("#mb-resultado .mb-fixacao");
    const top = section ? section.getBoundingClientRect().top : 0;
    if (section && (top < 0 || top > window.innerHeight - 160)) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  const cycle = (state.manabase?.fixadores || []).find((c: Cycle) => c.id === id);
  if (cycle && cycle.terrenos.length < cycle.total + cycle.no_deck) analyzeManabase();
}

/* Põe um lote de cartas de uma vez — é o que "3× Forest" e "Todos" fazem.
   Uma entrada só de desfazer, senão Ctrl+Z tiraria uma floresta por vez. */
export function addBatch(batch: { carta: Card; quantidade: number }[]) {
  pushUndo();
  for (const { carta, quantidade } of batch) {
    const entry = findEntry(carta.nome);
    if (entry) entry.quantidade += quantidade;
    else state.cartas.push({ carta, quantidade, categoria: "" });
  }
  state.validacao = null;
  desenharTudo();
  agendarSalvar();
}

/** Um básico ("3× Forest") ou, com `all`, o lote inteiro ("Todos"). */
export function addBasics(basics: Basic[], all = false) {
  const batch = basics.filter((b) => b.carta) as { carta: Card; quantidade: number; nome: string }[];
  if (!batch.length) return;
  addBatch(batch);
  toast(all
    ? `${batch.reduce((s, b) => s + b.quantidade, 0)} básicos no deck.`
    : `${batch[0].quantidade}× ${batch[0].carta.nome} no deck.`);
}

export function addFixingLand(land: FixingLand) {
  if (land.no_deck) return;
  addCard(land);
  toast(`${land.nome} entrou no deck.`);
}

/* O atalho no cabeçalho de Terrenos. Ele não abre painel nenhum: rola até o
   que já existe embaixo do deck e o faz piscar, porque duas mana bases na
   mesma tela seriam duas respostas pra mesma pergunta. */
export function callManabase() {
  trocarAba("manabase");
  const panel = $("painel-manabase") as HTMLElement;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  panel.classList.remove("chamado");
  void panel.offsetWidth;          // reinicia a animação se já tiver rodado
  panel.classList.add("chamado");
  if (!state.manabase) analyzeManabase();
}
