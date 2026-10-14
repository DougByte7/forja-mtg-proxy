import { deckRevision, state } from "../state";

/** O estado da tela, de dentro de um componente. Ler a revisão é o que
    inscreve o componente: ele se redesenha a cada `touch()`. */
export function useDeck() {
  void deckRevision.value;
  return state;
}
