/* A impressora mora no homelab e quem imprime é o worker, que pergunta a
   fila de tempos em tempos. Se ele sumiu, o Imprimir continua enfileirando,
   mas nada sai — e isso precisa estar escrito ANTES de alguém clicar. */
import { when } from "./format";
import type { Session } from "./types";

export function workerWarning(s: Session | undefined, now = Date.now()) {
  if (!s) return "";
  const seen = s.worker?.visto_em;
  if (!seen) {
    return "A impressora nunca deu sinal: o worker não está rodando. " +
           "O botão Imprimir põe o pedido na fila, mas nada sai até ele subir.";
  }
  if (now / 1000 - seen > s.worker!.offline_segundos) {
    return `A impressora não dá sinal desde ${when(seen, now)}. ` +
           "Os pedidos ficam na fila até o worker voltar.";
  }
  if (!s.impressora) {
    return "O worker está no ar, mas sem PRINTER_QUEUE: o botão Imprimir " +
           "confirma o pagamento e monta o PDF, mas não manda nada pra impressora.";
  }
  return "";
}
