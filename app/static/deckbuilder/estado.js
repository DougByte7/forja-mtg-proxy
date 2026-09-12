/* =========================================================================
   Deckbuilder de Commander.

   A regra desta tela: NADA espera o servidor pra responder ao clique. As
   cartas chegam completas da busca (a base é local, ver `cartas.py`), então
   contagem, curva, identidade de cor e singleton são recalculados aqui na
   hora. O servidor guarda o deck e devolve a validação dele junto do
   autosave — quando essa resposta chega, ela substitui a validação local,
   que é só a versão instantânea da mesma regra.
   ========================================================================= */

export const CORES = ["W","U","B","R","G"];
export const NOME_COR = {W:"Branco",U:"Azul",B:"Preto",R:"Vermelho",G:"Verde",C:"Incolor"};

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

export const CATEGORIA_SIDEBOARD = "Sideboard";
export const CATEGORIAS_FORA_DA_CONTA = new Set([CATEGORIA_SIDEBOARD]);

/* Categorias automáticas, na ordem em que aparecem. A primeira que casar o
   type_line ganha — daí Terreno vir antes de Criatura (terreno-criatura é
   terreno pra quem monta) e Artefato vir depois de Criatura (o Solemn é
   criatura, não artefato, na hora de contar bicho). */
export const CATEGORIAS = [
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
export const TIPOS = [
  ["", "Qualquer tipo"],
  ["creature","Criatura"], ["instant","Instantâneo"], ["sorcery","Feitiço"],
  ["artifact","Artefato"], ["enchantment","Encantamento"],
  ["planeswalker","Planeswalker"], ["land","Terreno"], ["battle","Batalha"],
  ["legendary","Lendária"], ["equipment","Equipamento"], ["aura","Aura"],
];
export const NOME_DO_TIPO = Object.fromEntries(TIPOS);

/* O estado neutro da gaveta. Serve pra duas coisas: começar, e comparar —
   `filtrosLigados` conta o que difere daqui, e é essa conta que vira o
   número na bolinha do botão. */
export const FILTROS_VAZIOS = {
  tipo: "", texto: "", cores: "", cmcMin: "", cmcMax: "", precoMax: "",
  ordem: "nome",
};

/* Tem algum filtro ligado? É a mesma pergunta que a bolinha do botão
   responde com um número (ver `filtrosLigados`, em `filtros.js`), e a que
   decide se a lista de resultados é paginada: sem filtro ela é uma vitrine
   curta de cinco, com filtro é um recorte que a pessoa pediu e quer ver
   inteiro. Mora aqui, e não lá, porque quem pergunta é a busca — e a busca
   já é importada por `filtros.js`. */
export function algumFiltro(){
  return Object.keys(FILTROS_VAZIOS)
    .some(k => estado.filtros[k] !== FILTROS_VAZIOS[k]);
}

export const estado = {
  id: null,
  nome: "Deck sem nome",
  comandantes: [],   // cartas completas
  cartas: [],        // [{quantidade, carta, categoria}]
  maybe: [],         // o mesmo formato — o que ainda está em dúvida
  categorias: [],    // os nomes criados à mão, na ordem escolhida
  validacao: null,   // a do servidor, quando chega
  // A régua com que o preço em dólar da base é lido: {valor, fonte, quando}.
  // Null até `GET /cambio` responder, e null pra sempre se ela falhar — nesse
  // caso a tela mostra dólar, que é o número que ela tem de verdade.
  cambio: null,
  usuario: null,     // quem está logado, ou null pra anônimo (que não é erro)
  dono: null,        // de quem é este deck, ou null pra órfão
  // A mesa do goldfish: uma lista de jogadores (um, ou dois com o segundo
  // deck), o turno e o log. `null` = nunca embaralhou nesta sessão. NÃO entra
  // no `corpoDoDeck`: mão de goldfish gravada no deck é mão que volta três
  // semanas depois, em outra máquina.
  mesa: null,
  mesaDesfazer: [],  // pilha de fotografias do JSON da mesa
  filtros: {...FILTROS_VAZIOS},
  // A paginação da busca, que só existe com filtro ligado. `buscaTotal` é o
  // que o servidor contou na última resposta paginada — sem ele o paginador
  // não saberia quantas páginas tem.
  buscaPagina: 0,
  buscaPorPagina: 5,
  buscaTotal: 0,
  desfazer: [],
  combos: null,             // a última resposta do Spellbook
  combosAssinatura: null,   // como o deck estava quando ela foi buscada
  poder: null,              // a última estimativa de bracket
  poderAssinatura: null,
  sugestoes: null,          // a última resposta do EDHREC
  sugestoesTema: null,
  // Um pedido de sugestão em voo. Existe porque a aba se abre sozinha de dois
  // lugares (o clique na aba e a estrela de uma carta) e sem isto os dois
  // caminhos juntos pediriam duas páginas ao EDHREC no mesmo gesto — a do
  // comandante, por reflexo, e a da carta, que é a que foi pedida.
  sugestoesRodando: false,
  manabase: null,           // a última análise de mana base
  manabaseTeto: null,       // teto de preço escolhido (null = o padrão)
  tokens: null,             // as fichas que o deck cria
  tokensAssinatura: null,   // o deck de quando elas foram listadas
  mbPagina: 0,              // página da lista de terrenos que fixam
  combosMexidos: 0,         // combos fechados aqui na tela desde a busca

  // Pra onde vai a próxima carta escolhida na busca. Fica no estado, e não
  // num parâmetro de cada clique, porque é uma decisão que vale pra várias
  // cartas seguidas: "agora estou montando o sideboard".
  destino: "deck",          // "deck" | "side" | "talvez"
  destinoCategoria: "",     // "" = pelo tipo da carta

  cotacao: null,            // o último resultado do servidor
  cotacaoAssinatura: null,  // o deck de quando ela foi pedida
  cotacaoRodando: false,
  cotacaoErro: null,

  aba: "deck",              // aba do centro
  rail: "buscar",           // aba do painel de adicionar

  // ------------------------------------------------- a lente das duas listas
  //
  // Como o deck e o maybeboard estão sendo OLHADOS agora: um texto que
  // esconde o que não casa, a ordem das cartas dentro de cada grupo e os
  // grupos recolhidos. Nada disto é o deck — não entra no `corpoDoDeck`, não
  // é salvo e o Ctrl+Z não mexe nisso. É por isso que vive aqui e não na
  // entrada de cada carta: mudar de ordem não pode marcar o deck como
  // alterado.
  //
  // Cada lista tem a SUA busca (procurar no deck não pode filtrar o
  // maybeboard junto), mas a ordem é uma só pras duas: são a mesma lista
  // lida em dois lugares, e ordená-las diferente seria ler duas listas.
  listaBusca: {deck: "", talvez: ""},
  listaOrdem: "cmc",        // ver `ORDENS_DA_LISTA` em desenho.js
  // Chaves "<tabuleiro>:<categoria>" — o mesmo nome de categoria pode estar
  // aberto de um lado e recolhido do outro.
  gruposFechados: new Set(),
};
