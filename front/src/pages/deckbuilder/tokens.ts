/* ------------------------------------------------------------------ tokens

   A aba responde uma pergunta que só aparece no fim da montagem: "o que eu
   preciso levar ALÉM das 100 cartas?". Ficha não vai dentro do deck — é
   material separado, e por isso é a parte que se esquece em casa.

   Sem botão de buscar, ao contrário dos combos: a base local já guarda, carta
   por carta, quais fichas ela cria, então a resposta não custa rede e pode
   acompanhar o deck como a mana base acompanha. O desenho é `ui/Tokens.tsx`. */
import { deckSignature } from "./combos";
import { api, saveNow } from "./save";
import { state, touch } from "./state";
import type { Card } from "./types";
import { toast } from "./ui/toast";

export type Token = {
  nome: string; tipo?: string; texto?: string; poder?: string; resistencia?: string;
  imagem?: string; imagem_verso?: string; chave_arte?: string;
};
export type TokenGroup = { carta: string; tokens: Token[]; [field: string]: unknown };
export type TokensResponse = { total: number; grupos: TokenGroup[] };

export async function loadTokens() {
  if (!state.comandantes.length) return;
  if (!state.id) await saveNow();
  if (!state.id) {
    toast("Não consegui salvar o deck antes de listar as fichas.");
    return;
  }
  // Só avisa que está procurando quando ainda não há lista na tela. Nos
  // recálculos do autosave, apagar a grade faria as artes piscarem a cada
  // carta adicionada.
  if (!state.tokens) { state.tokensRodando = true; touch(); }
  try {
    state.tokens = await api(`/decks/${state.id}/tokens`);
    state.tokensAssinatura = deckSignature();
    state.tokensErro = null;
  } catch (e) {
    state.tokensErro = (e as Error).message;
  } finally {
    state.tokensRodando = false;
    // As fichas também vão pro papel: a aba Artes tem um quadro por ficha, e
    // o "Gerar pedido" conta as artes delas. O redesenho alcança os dois.
    touch();
  }
}

/* As fichas como coisa a imprimir: UMA DE CADA, pela `chave_arte` que o
   servidor manda com cada uma. A aba Tokens lista por carta que cria; o papel
   leva a mesma Treasure uma vez só, peça quantas cartas pedirem (ver
   `artes.pedido`).

   Cada uma vira um objeto com a forma de carta que a modal de arte e a
   galeria já sabem desenhar — `ficha` e `chaveArte` são o que as separa de
   uma carta (ver `artName` e `searchNameFor`). Montado uma vez por
   resposta do servidor: a galeria e a conta do "Gerar pedido" pedem a lista
   a cada desenho, e o autosave redesenha a cada carta. */
const built: { from: TokensResponse | null; list: Card[] } = { from: null, list: [] };

export function deckTokens(): Card[] {
  const data: TokensResponse | null = state.tokens;
  if (data && built.from === data) return built.list;
  const seen = new Map<string, Card>();
  for (const g of data?.grupos || []) {
    for (const t of g.tokens) {
      if (!t.chave_arte || seen.has(t.chave_arte)) continue;
      seen.set(t.chave_arte, {
        nome: t.nome, chaveArte: t.chave_arte, ficha: true,
        tipo: t.tipo || "", texto: t.texto || "",
        poder: t.poder || "", resistencia: t.resistencia || "",
        imagem: t.imagem || "", imagem_verso: t.imagem_verso || "",
      });
    }
  }
  built.from = data;
  built.list = Array.from(seen.values());
  return built.list;
}

/* "Wurm 3/3": o nome sozinho não distingue ficha, e o corpo é o que se
   reconhece de relance. O resto (tipo, texto) mora no título do quadro e na
   vitrine da modal. */
export function tokenLabel(t: { nome: string; poder?: unknown; resistencia?: unknown }) {
  return t.nome + (t.poder && t.resistencia ? ` ${t.poder}/${t.resistencia}` : "");
}
