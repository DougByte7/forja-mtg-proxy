/* Os dados do deckbuilder, no formato em que o servidor os manda e recebe.

   Os CAMPOS são os da API (`app/decks.py`, `app/cartas.py`) e por isso
   ficam como lá estão, em português: renomeá-los aqui exigiria traduzir na
   ida e na volta de cada requisição. */

export type Color = "W" | "U" | "B" | "R" | "G";

/** Uma carta como a busca a devolve (ver `cartas.carta_pra_tela`). */
export interface Card {
  nome: string;
  tipo?: string;
  identidade?: string;
  mana_cost?: string;
  cmc?: number;
  preco_usd?: number | null;
  imagem?: string;
  imagem_verso?: string;
  legal?: boolean;
  basico?: boolean;
  inedita?: boolean;
  sai_em?: string;
  ficha?: boolean;
  /** Carta partida (os Rooms, Fire // Ice): impressa de lado. */
  deitada?: boolean;
  texto?: string;
  /** Só na ficha: a chave sob a qual a arte dela é guardada (ver `artName`). */
  chaveArte?: string;
  [field: string]: unknown;
}

/** Uma linha do deck ou do maybeboard. `categoria` vazia é "pelo tipo". */
export interface Entry {
  carta: Card;
  quantidade: number;
  categoria?: string;
}

/** As duas listas: o deck (com o sideboard dentro) e o maybeboard. */
export type Board = "deck" | "talvez";
