/* ----------------------------------------------------------------- combos

   Uma consulta só ao Commander Spellbook, e só no clique: o deck muda a cada
   carta adicionada, e buscar sozinho viraria uma requisição por clique num
   serviço gratuito. Por isso a tela guarda a assinatura do deck de quando a
   busca rodou e, quando ela deixa de bater, avisa em vez de rebuscar. O
   desenho é `ui/Combos.tsx`. */
import { countedCards } from "./deck";
import { addCard } from "./editing";
import { api, salvarAgora } from "./salvar.js";
import { state, touch } from "./state";
import type { Card } from "./types";
import { toast } from "./ui/toast";

export type ComboPiece = Card & { no_deck?: boolean; comandante?: boolean; na_base?: boolean };
export type SpellbookCombo = {
  pecas: ComboPiece[];
  requer: string[];
  produz: string[];
  mana?: string;
  prerequisitos?: string;
  faltam: string[];
  link: string;
  bracket?: string; bracket_rotulo?: string; bracket_explicacao?: string;
  custo_usd?: number; pecas_sem_preco?: number;
  custo_faltando_usd?: number; pecas_faltando_sem_preco?: number;
};
export type CombosResponse = { no_deck: SpellbookCombo[]; faltando_uma: SpellbookCombo[]; cache?: boolean };

/* O deck como o servidor o viu quando a busca rodou. Só o que conta: mexer
   no maybeboard ou no sideboard não muda combo nem bracket, e avisar "o deck
   mudou" por causa disso ensinaria a ignorar o aviso. */
export function deckSignature() {
  return JSON.stringify([
    state.comandantes.map((c) => c.nome).sort(),
    countedCards().map((e) => [e.carta.nome, e.quantidade]).sort(),
  ]);
}

export async function searchCombos() {
  if (!state.comandantes.length && !state.cartas.length) {
    toast("Monte alguma coisa antes de procurar combos.");
    return;
  }
  if (!state.id) await salvarAgora();
  if (!state.id) { toast("Não consegui salvar o deck antes de buscar."); return; }

  // As duas abas de combo podem pedir a mesma consulta quase junto (abrir uma
  // e a outra em seguida): a segunda desiste em vez de repetir a chamada. A
  // consulta é uma só e alimenta os dois lugares, que esperam juntos.
  if (state.combosRodando) return;
  state.combosRodando = true;
  state.combosErro = null;
  touch();
  try {
    state.combos = await api(`/decks/${state.id}/combos`, { method: "POST" });
    state.combosAssinatura = deckSignature();
    state.combosMexidos = 0;   // a resposta nova já sabe de tudo
  } catch (e) {
    // "Não sei" nunca pode virar "não tem combo": são opostos que parecem
    // iguais numa lista vazia.
    state.combosErro = (e as Error).message;
  } finally {
    state.combosRodando = false;
    touch();
  }
}

/* Adiciona a carta que falta pra fechar um combo. O nome vem do Spellbook,
   que usa o nome canônico da Scryfall — o mesmo que a base local guarda —,
   então a resolução é por nome exato e não por busca difusa. Devolve se deu
   certo, pra o botão saber se volta a valer. */
export async function addComboPiece(name: string) {
  try {
    const r = await api("/cartas/busca?" + new URLSearchParams({ q: name, limite: "5" }));
    const cards: Card[] = r.cartas || [];
    const target = cards.find((c) => c.nome.toLowerCase() === name.toLowerCase()) || cards[0];
    if (!target) {
      toast(`Não achei "${name}" na base local — talvez ela precise sincronizar.`);
      return false;
    }
    addCard(target);
    const closed = closeCombosWith(target.nome);
    toast(closed ? `${target.nome} entrou no deck e fechou ${closed} combo(s).` : `${target.nome} entrou no deck.`);
    touch();
    return true;
  } catch (e) {
    toast("Não consegui adicionar: " + (e as Error).message);
    return false;
  }
}

/* A carta entrou no deck: os combos que a esperavam passam pra "no deck".

   A conta é local e exata — sabemos qual carta entrou e quais combos a citam
   — e evita gastar uma requisição num serviço gratuito só pra confirmar o que
   a própria tela acabou de fazer.

   O que NÃO dá pra saber daqui é o contrário — que combos NOVOS essa carta
   deixou a uma peça de fechar. Por isso a assinatura é atualizada (o aviso de
   "o deck mudou" seria mentira, já que a lista está em dia com o deck) e no
   lugar dele fica um recado dizendo o que ainda vale rebuscar.

   Devolve quantos combos fecharam, pra quem chamou saber o que dizer. */
export function closeCombosWith(name: string) {
  const data: CombosResponse | null = state.combos as any;
  if (!data) return 0;
  const target = name.toLowerCase();
  const closed: SpellbookCombo[] = [];

  // Marca a peça em TODOS os combos das duas listas: a mesma carta pode ser
  // peça de vários, e marcar só no combo clicado deixaria os outros mentindo.
  for (const list of [data.no_deck || [], data.faltando_uma || []]) {
    for (const combo of list) {
      for (const piece of combo.pecas || []) {
        if (piece.nome.toLowerCase() === target) piece.no_deck = true;
      }
      const missing = (combo.pecas || []).filter((p) => !p.no_deck);
      combo.faltam = missing.map((p) => p.nome);
      combo.custo_faltando_usd = Number(missing.reduce((sum, p) => sum + (p.preco_usd || 0), 0).toFixed(2));
      combo.pecas_faltando_sem_preco = missing.filter((p) => !p.preco_usd).length;
    }
  }

  // Combo sem peça faltando muda de lista. `requer` (peça genérica: "uma
  // criatura com vigilância") NÃO impede: o Spellbook já contava o combo como
  // "a uma carta" com esse requisito em aberto, então quem decide se ele está
  // fechado é a lista de cartas, do mesmo jeito que lá.
  data.faltando_uma = (data.faltando_uma || []).filter((combo) => {
    if (combo.faltam.length) return true;
    closed.push(combo);
    return false;
  });
  data.no_deck = closed.concat(data.no_deck || []);

  if (closed.length) {
    state.combosMexidos += closed.length;
    // A lista voltou a bater com o deck: o aviso de "procure de novo" seria
    // falso agora. O recado do `combosMexidos` toma o lugar dele.
    state.combosAssinatura = deckSignature();
  }
  return closed.length;
}
