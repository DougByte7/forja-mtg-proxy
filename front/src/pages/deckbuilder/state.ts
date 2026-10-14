/* =========================================================================
   Deckbuilder de Commander.

   A regra desta tela: NADA espera o servidor pra responder ao clique. As
   cartas chegam completas da busca (a base é local, ver `cartas.py`), então
   contagem, curva, identidade de cor e singleton são recalculados aqui na
   hora. O servidor guarda o deck e devolve a validação dele junto do
   autosave — quando essa resposta chega, ela substitui a validação local,
   que é só a versão instantânea da mesma regra.
   ========================================================================= */
import { signal } from "@preact/signals";
import type { Combo, Table } from "./goldfish";
import type { Card, Color, Entry } from "./types";

export const COLORS: Color[] = ["W", "U", "B", "R", "G"];
export const COLOR_NAMES: Record<string, string> = {
  W: "Branco", U: "Azul", B: "Preto", R: "Vermelho", G: "Verde", C: "Incolor",
};

/* -------------------------------------------------------------- categorias

   Duas espécies, e a diferença entre elas é quem decidiu:

   * As AUTOMÁTICAS saem do tipo da carta e ninguém escolhe — um Sol Ring
     está em Artefatos porque ele é um artefato.
   * As PRÓPRIAS são de quem monta ("combo principal", "sac outlet") e moram
     na entrada da carta. Elas existem porque a pergunta que a lista responde
     não é "que tipo é isto?", é "o que esta carta faz no meu deck?".

   Uma carta com categoria própria sai do grupo do tipo dela e vai pro grupo
   escolhido: são grupos do mesmo tipo de coisa, não duas camadas. Ter uma
   carta em dois lugares faria a soma dos grupos passar de 100.

   `Sideboard` é a única embutida que não sai do tipo, e a única categoria
   que muda uma conta: fica FORA das 100 (senão o contador viveria acusando
   "5 cartas além das 100" num deck legal), mas continua na cotação e na
   lista de impressão — é carta que a pessoa quer ter. É o que a separa do
   maybeboard, e o servidor tem a mesma regra em `decks.CATEGORIAS_FORA_DA_CONTA`. */

export const SIDEBOARD = "Sideboard";
export const OUT_OF_COUNT: ReadonlySet<string> = new Set([SIDEBOARD]);

/* Categorias automáticas, na ordem em que aparecem. A primeira que casar o
   type_line ganha — daí Terreno vir antes de Criatura (terreno-criatura é
   terreno pra quem monta) e Artefato vir depois de Criatura (o Solemn é
   criatura, não artefato, na hora de contar bicho). */
export const AUTO_CATEGORIES: [string, (typeLine: string) => boolean][] = [
  ["Terrenos",      (t) => t.includes("land")],
  ["Criaturas",     (t) => t.includes("creature")],
  ["Planeswalkers", (t) => t.includes("planeswalker")],
  ["Artefatos",     (t) => t.includes("artifact")],
  ["Encantamentos", (t) => t.includes("enchantment")],
  ["Instantâneos",  (t) => t.includes("instant")],
  ["Feitiços",      (t) => t.includes("sorcery")],
  ["Batalhas",      (t) => t.includes("battle")],
];
/* Os tipos, como seletor dentro da gaveta de filtros. São treze opções, e
   treze controles soltos na coluna de 372px comeriam a lista de resultados
   que eles existem pra filtrar. */
export const TYPE_OPTIONS: [string, string][] = [
  ["", "Qualquer tipo"],
  ["creature","Criatura"], ["instant","Instantâneo"], ["sorcery","Feitiço"],
  ["artifact","Artefato"], ["enchantment","Encantamento"],
  ["planeswalker","Planeswalker"], ["land","Terreno"], ["battle","Batalha"],
  ["legendary","Lendária"], ["equipment","Equipamento"], ["aura","Aura"],
];
export const TYPE_LABELS: Record<string, string> = Object.fromEntries(TYPE_OPTIONS);

/* O estado neutro da gaveta. Serve pra duas coisas: começar, e comparar —
   `filtrosLigados` conta o que difere daqui, e é essa conta que vira o
   número na bolinha do botão. */
export type Filters = {
  type: string; text: string; colors: string; cmcMin: string; cmcMax: string;
  maxPrice: string; order: string; unreleased: boolean;
};

export const EMPTY_FILTERS: Readonly<Filters> = {
  type: "", text: "", colors: "", cmcMin: "", cmcMax: "", maxPrice: "",
  order: "nome", unreleased: false,
};

/* Tem algum filtro ligado? É a mesma pergunta que a bolinha do botão
   responde com um número (ver `activeFilters`, em `filters.ts`), e a que
   decide se a lista de resultados é paginada: sem filtro ela é uma vitrine
   curta de cinco, com filtro é um recorte que a pessoa pediu e quer ver
   inteiro. Mora aqui, e não lá, porque quem pergunta é a busca — e a busca
   já é importada por `filters.ts`.

   As inéditas ficam de fora da conta porque elas ALARGAM a lista em vez de
   estreitá-la: deixar passar a coleção que ainda não saiu não é um recorte
   que alguém pediu pra ver inteiro, e paginar por causa dele trocaria a
   vitrine de cinco por um paginador que ninguém abriu. Na fita de etiquetas
   ela aparece, porque lá a pergunta é outra: o que está ligado. */
export function anyFilterOn() {
  return (Object.keys(EMPTY_FILTERS) as (keyof Filters)[])
    .some((k) => k !== "unreleased" && state.filters[k] !== EMPTY_FILTERS[k]);
}

/** O estado da tela. Os campos que espelham a API ficam com o nome de lá
    (ver `types.ts`); as respostas que só passam por aqui e são desenhadas
    pelos módulos de tela ficam soltas (`any`) até esses módulos virarem
    componentes. */
export interface DeckState {
  id: string | null;
  name: string;
  commanders: Card[];
  cards: Entry[];
  maybe: Entry[];
  categories: string[];
  validation: any;
  rate: { valor: number; fonte?: string; quando?: number } | null;
  user: any;
  owner: string | null;
  version: any;
  history: any;
  table: Table | null;
  tableUndo: string[];
  filters: Filters;
  searchPage: number;
  searchPageSize: number;
  searchTotal: number;
  undoStack: string[];
  combos: { no_deck?: Combo[]; faltando_uma?: Combo[]; [k: string]: unknown } | null;
  combosSignature: string | null;
  combosLoading: boolean;
  combosError: string | null;
  combosAdded: number;
  power: any;
  powerSignature: string | null;
  powerLoading: boolean;
  powerError: string | null;
  suggestions: any;
  suggestionsTheme: string | null;
  suggestionsLoading: boolean;
  suggestionsTarget: string;
  suggestionsError: string | null;
  manabase: any;
  manabaseCap: number | null;
  manabaseLoading: boolean;
  manabaseError: string | null;
  manabaseCycle: string;
  tokens: any;
  tokensSignature: string | null;
  tokensLoading: boolean;
  tokensError: string | null;
  historyError: string | null;
  destination: string;
  destinationCategory: string;
  quote: any;
  quotedSignature: string | null;
  quoteLoading: boolean;
  quoteError: string | null;
  tab: string;
  rail: string;
  results: any;
  listFilter: { deck: string; talvez: string };
  listOrder: string;
  collapsedGroups: Set<string>;
}

export const state: DeckState = {
  id: null,
  name: "Deck sem nome",
  commanders: [],   // cartas completas
  cards: [],        // [{quantidade, carta, categoria}]
  maybe: [],         // o mesmo formato — o que ainda está em dúvida
  categories: [],    // os nomes criados à mão, na ordem escolhida
  validation: null,   // a do servidor, quando chega
  // A régua com que o preço em dólar da base é lido: {valor, fonte, quando}.
  // Null até `GET /cambio` responder, e null pra sempre se ela falhar — nesse
  // caso a tela mostra dólar, que é o número que ela tem de verdade.
  rate: null,
  user: null,     // quem está logado, ou null pra anônimo (que não é erro)
  owner: null,        // de quem é este deck, ou null pra órfão
  // Onde o deck está no histórico, como a última resposta do servidor contou:
  // {atual, concluida_em, mudou, entraram, sairam}. `atual` nulo é WIP.
  version: null,
  history: null,   // a última resposta de `GET /decks/{id}/versoes`
  historyError: null,
  // A mesa do goldfish: uma lista de jogadores (um, ou dois com o segundo
  // deck), o turno e o log. `null` = nunca embaralhou nesta sessão. NÃO entra
  // no `deckBody`: mão de goldfish gravada no deck é mão que volta três
  // semanas depois, em outra máquina.
  table: null,
  tableUndo: [],  // pilha de fotografias do JSON da mesa
  filters: {...EMPTY_FILTERS},
  // A paginação da busca, que só existe com filtro ligado. `searchTotal` é o
  // que o servidor contou na última resposta paginada — sem ele o paginador
  // não saberia quantas páginas tem.
  searchPage: 0,
  searchPageSize: 5,
  searchTotal: 0,
  undoStack: [],
  combos: null,             // a última resposta do Spellbook
  combosSignature: null,   // como o deck estava quando ela foi buscada
  combosLoading: false,
  combosError: null,
  power: null,              // a última estimativa de bracket
  powerSignature: null,
  powerLoading: false,
  powerError: null,
  suggestions: null,          // a última resposta do EDHREC
  suggestionsTheme: null,
  // Um pedido de sugestão em voo. Existe porque a aba se abre sozinha de dois
  // lugares (o clique na aba e a estrela de uma carta) e sem isto os dois
  // caminhos juntos pediriam duas páginas ao EDHREC no mesmo gesto — a do
  // comandante, por reflexo, e a da carta, que é a que foi pedida.
  suggestionsLoading: false,
  suggestionsTarget: "",        // de quem é a lista pedida: o comandante ou uma carta
  suggestionsError: null,
  manabase: null,           // a última análise de mana base
  manabaseCap: null,       // teto de preço escolhido (null = o padrão)
  manabaseLoading: false,
  manabaseError: null,
  tokens: null,             // as fichas que o deck cria
  tokensSignature: null,   // o deck de quando elas foram listadas
  tokensLoading: false,
  tokensError: null,
  manabaseCycle: "",          // ciclo de terreno aberto na mana base ("" = todos)
  combosAdded: 0,         // combos fechados aqui na tela desde a busca

  // Pra onde vai a próxima carta escolhida na busca. Fica no estado, e não
  // num parâmetro de cada clique, porque é uma decisão que vale pra várias
  // cartas seguidas: "agora estou montando o sideboard".
  destination: "deck",          // "deck" | "side" | "talvez"
  destinationCategory: "",     // "" = pelo tipo da carta

  quote: null,            // o último resultado do servidor
  quotedSignature: null,  // o deck de quando ela foi pedida
  quoteLoading: false,
  quoteError: null,

  tab: "deck",              // aba do centro
  rail: "buscar",           // aba do painel de adicionar
  results: null,         // o que as duas buscas trouxeram (ver `search.ts`)

  // ------------------------------------------------- a lente das duas listas
  //
  // Como o deck e o maybeboard estão sendo OLHADOS agora: um texto que
  // esconde o que não casa, a ordem das cartas dentro de cada grupo e os
  // grupos recolhidos. Nada disto é o deck — não entra no `deckBody`, não
  // é salvo e o Ctrl+Z não mexe nisso. É por isso que vive aqui e não na
  // entrada de cada carta: mudar de ordem não pode marcar o deck como
  // alterado.
  //
  // Cada lista tem a SUA busca (procurar no deck não pode filtrar o
  // maybeboard junto), mas a ordem é uma só pras duas: são a mesma lista
  // lida em dois lugares, e ordená-las diferente seria ler duas listas.
  listFilter: {deck: "", talvez: ""},
  listOrder: "cmc",        // ver `LIST_ORDERS` em lists.ts
  // Chaves "<tabuleiro>:<categoria>" — o mesmo nome de categoria pode estar
  // aberto de um lado e recolhido do outro.
  collapsedGroups: new Set(),
};

/* ------------------------------------------------- a ponte com os componentes

   O estado acima é um objeto comum, mudado no lugar (`entry.quantidade += 1`),
   e signal não enxerga mudança dentro de objeto. A ponte é esta: toda
   mudança termina num `touch()` (direto, ou pelo `redrawAll` das edições), e
   ele sobe a revisão. Componente que lê `deckRevision.value` (ver
   `ui/useDeck.ts`) se redesenha junto com o resto da página. */
export const deckRevision = signal(0);

export function touch() {
  deckRevision.value++;
}
