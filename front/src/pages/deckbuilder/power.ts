/* --------------------------------------------------------- nível de poder

   A estimativa de bracket vem do Commander Spellbook, pelo servidor (ver
   `app/poder.py`). Aqui fica a busca e o estado dela; o desenho é
   `ui/Power.tsx`. */
import { deckSignature } from "./combos";
import { api, salvarAgora } from "./salvar.js";
import { state, touch } from "./state";
import { toast } from "./ui/toast";

export const BRACKETS: [number, string, string][] = [
  [1, "Exibição", "Deck de mesa leve: sem combo, sem game changer."],
  [2, "Núcleo", "Nível de precon de fábrica — a régua da maioria das mesas."],
  [3, "Turbinado", "Precon melhorado: até três game changers."],
  [4, "Otimizado", "Sem freio: o deck joga pra ganhar o quanto antes."],
  [5, "cEDH", "Não dá pra calcular: cEDH é definido pelo metagame e pela " +
              "intenção de quem monta, não pela lista de cartas."],
];

export type PowerReason = { titulo: string; detalhe: string; nivel?: string; cartas: string[] };
export type PowerResult = {
  bracket: number | null; nome?: string; explicacao?: string; motivos: PowerReason[]; cache?: boolean;
};

export async function estimatePower() {
  if (!state.comandantes.length && !state.cartas.length) {
    toast("Monte alguma coisa antes de estimar o nível.");
    return;
  }
  if (!state.id) await salvarAgora();
  if (!state.id) { toast("Não consegui salvar o deck antes de estimar."); return; }

  state.poderRodando = true;
  state.poderErro = null;
  touch();
  try {
    state.poder = await api(`/decks/${state.id}/poder`, { method: "POST" });
    state.poderAssinatura = deckSignature();
  } catch (e) {
    state.poderErro = (e as Error).message;
  } finally {
    state.poderRodando = false;
    touch();
  }
}
