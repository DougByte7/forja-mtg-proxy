/* Acompanhar a impressora.

   Quem imprime é o worker, que pergunta a fila de tempos em tempos. Depois de
   pôr um pedido (ou uma combinação) na fila, a tela fica lendo o estado dele
   até sair de a_imprimir/imprimindo, e diz o que aconteceu. */
import { ORDER_STATES } from "./states";
import type { QueueState } from "./types";

export const IN_QUEUE = new Set(["a_imprimir", "imprimindo"]);

export type NoteKind = "ok" | "erro" | "andando";
export type Note = { kind: NoteKind; text: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lê até o estado sair da fila. Desiste depois de `maxMinutes` — o pedido
    continua na fila, e a lista mostra quando ele sair. */
export async function followQueue<T extends QueueState>(
  read: () => Promise<T>,
  onStep: (state: T) => void,
  { maxMinutes = 15, everyMs = 4000, wait = sleep, now = Date.now } = {},
): Promise<T> {
  const end = now() + maxMinutes * 60000;
  let state = await read();
  while (IN_QUEUE.has(state.status) && now() < end) {
    onStep(state);
    await wait(everyMs);
    state = await read();
  }
  return state;
}

export function queueResult(state: QueueState): Note {
  if (state.status === "impresso") {
    let text = state.impressao_msg || "Enviado pra impressora.";
    if (state.impressao_falhas) {
      text += ` ATENÇÃO: ${state.impressao_falhas} carta(s) não baixaram e ` +
              `saíram como quadro de falha no papel.`;
    }
    return { kind: state.impressao_falhas ? "erro" : "ok", text };
  }
  if (state.status === "erro_impressao") {
    return { kind: "erro", text: "A impressora recusou: " + (state.impressao_msg || "sem detalhe.") };
  }
  if (IN_QUEUE.has(state.status)) {
    return { kind: "andando", text: "Continua na fila — a lista mostra quando sair." };
  }
  return { kind: "erro",
           text: `Saiu da fila sem imprimir (${ORDER_STATES[state.status] || state.status}).` };
}
