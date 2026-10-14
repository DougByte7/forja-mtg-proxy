/* ------------------------------------------------------------------- conta

   Criar e alterar baralho pede conta; abrir um, não. O link compartilhado
   abre pra qualquer um, e quem chega sem conta recebe o convite de entrar ou
   criar uma. Com conta vem dono — e, com dono, "os meus" em qualquer
   aparelho.

   `state.usuario` é null pra anônimo. Não é erro: é quem está só olhando. */
import { signal } from "@preact/signals";
import { api } from "./save";
import { state } from "./state";
import { toast } from "./ui/toast";

/** A pergunta à vista: o convite pra entrar, ou a oferta de ficar com um
    deck sem dono. */
export const accountDialog = signal<"invite" | "orphan" | null>(null);

/* Sem conta legível (rede fora), a tela trata como anônimo: o servidor
   recusaria a gravação do mesmo jeito, e o convite ao menos diz por quê. */
export async function loadAccount() {
  try {
    state.usuario = (await api("/conta")).usuario || null;
  } catch {
    state.usuario = null;
  }
}

/* Chamada com o deck já em mãos: o reclamar precisa saber se ele tem dono,
   e o convite muda de texto quando há um deck aberto. */
export function greetAccount() {
  if (state.usuario) offerClaim();
  else accountDialog.value = "invite";
}

/* O caminho pra entrar ou criar conta, voltando pra esta mesma tela — com o
   deck aberto, se houver um. */
export function accountLink(page: string) {
  return `/${page}?voltar=${encodeURIComponent(location.pathname + location.search)}`;
}

/* Quem recusou, fica recusado. Sem isto, quem deixa um deck órfão de
   propósito (pra outra pessoa reclamar) leva a mesma pergunta em toda
   recarga — e pergunta que sempre volta é pergunta que se aprende a
   fechar sem ler. */
const DISMISSED_KEY = "forja.orfaos.dispensados";

function dismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

/* Oferece pra QUALQUER órfão que a pessoa abra, não só os deste navegador:
   quem montou no celular precisa poder reclamar no computador, e é
   justamente esse o caso que o login existe pra resolver. */
function offerClaim() {
  if (!state.usuario || !state.id) return;
  if (state.dono) return;                       // já é de alguém
  if (dismissed().includes(state.id)) return;
  accountDialog.value = "orphan";
}

export async function claimDeck() {
  accountDialog.value = null;
  try {
    const r = await api(`/decks/${state.id}/reclamar`, { method: "POST" });
    state.dono = r.deck.dono;
    toast("Pronto, o baralho é seu.");
  } catch (e) {
    toast("Não consegui: " + (e as Error).message);
  }
}

export function declineClaim() {
  accountDialog.value = null;
  try {
    localStorage.setItem(DISMISSED_KEY,
      JSON.stringify([state.id, ...dismissed().filter((x) => x !== state.id)].slice(0, 40)));
  } catch { /* navegador privado: a pergunta volta, e tudo bem */ }
}
