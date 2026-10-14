/* As duas listas (o deck e o maybeboard) como dados: os grupos, a ordem
   dentro de cada um, o que a busca da lista deixa à vista e o que marca uma
   linha de vermelho. O desenho é `ui/DeckList.tsx`. */
import { categoryOf, categoryOrder, isCustomCategory } from "./deck";
import { groupSubtotal, sortablePrice } from "./budget";
import { OUT_OF_COUNT, state, touch } from "./state";
import { foldAccents } from "./text";
import type { Board, Entry } from "./types";

/* ------------------------------------------------------ ordem dentro do grupo

   A ordem vale DENTRO de cada categoria; a ordem dos grupos é outra coisa
   (`categoryOrder`) e continua sendo a decisão de quem monta.

   Todas desempatam pelo nome: sem isso, duas cartas de custo 3 trocariam de
   lugar entre um desenho e o outro, e a lista tremeria a cada tecla. */
type Compare = (a: Entry, b: Entry) => number;
const byName: Compare = (a, b) => a.carta.nome.localeCompare(b.carta.nome);

/* Preço desconhecido vai pro fim nos DOIS sentidos — ver `sortablePrice`. */
function byPrice(a: Entry, b: Entry, sign: number) {
  const va = sortablePrice(a), vb = sortablePrice(b);
  if (va === null && vb === null) return byName(a, b);
  if (va === null) return 1;
  if (vb === null) return -1;
  return (va - vb) * sign || byName(a, b);
}

export const LIST_ORDERS: Record<string, Compare> = {
  cmc: (a, b) => ((a.carta.cmc || 0) - (b.carta.cmc || 0)) || byName(a, b),
  cmc_desc: (a, b) => ((b.carta.cmc || 0) - (a.carta.cmc || 0)) || byName(a, b),
  nome: byName,
  preco: (a, b) => byPrice(a, b, +1),
  preco_desc: (a, b) => byPrice(a, b, -1),
};

/* A barra de achar-e-ordenar aparece quando a lista já é grande o bastante
   pra se perder nela — e some de novo, mas NUNCA com uma busca digitada:
   sumir levando o filtro junto esconderia cartas sem deixar como desfazer. */
export const MIN_FOR_TOOLS: Record<Board, number> = { deck: 10, talvez: 5 };

export type GroupView = {
  category: string;
  items: Entry[];
  countText: string;
  collapsed: boolean;
  custom: boolean;
  outOfCount: boolean;
  subtotal: ReturnType<typeof groupSubtotal> | null;
};

/* Os grupos de uma lista, do jeito que as duas áreas desenham.

   As categorias próprias VAZIAS aparecem mesmo sem carta, e só no deck: uma
   categoria recém-criada que não se vê na tela parece não ter sido criada, e
   é justamente nela que a próxima carta vai. No maybeboard elas não
   aparecem — dez grupos vazios numa coluna de 288px seriam a coluna
   inteira. */
export function boardView(entries: Entry[], board: Board) {
  const byCategory = new Map<string, Entry[]>();
  for (const entry of entries) {
    const cat = categoryOf(entry);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(entry);
  }
  let order = categoryOrder(entries);
  if (board === "talvez") order = order.filter((c) => byCategory.has(c));

  // Procurar é uma pergunta sobre a lista inteira, e ela atravessa os dois
  // estados que escondem carta: os grupos recolhidos se abrem e as categorias
  // vazias somem. Nenhum dos dois é apagado — os recolhidos voltam a fechar
  // quando a busca sai do campo.
  const searched = foldAccents(state.listFilter[board] || "").trim();
  const matches = (e: Entry) => foldAccents(e.carta.nome).includes(searched);
  const compare = LIST_ORDERS[state.listOrder] || LIST_ORDERS.cmc;

  const groups: GroupView[] = [];
  for (const category of order) {
    const all = byCategory.get(category) || [];
    const items = searched ? all.filter(matches) : all.slice();
    if (searched && !items.length) continue;
    items.sort(compare);
    // A conta do cabeçalho é sempre a do GRUPO, não a do que sobrou do
    // filtro: ela é o número de cartas que o deck tem ali, e uma busca não
    // muda isso. Com filtro ligado ela ganha o "de", que diz as duas coisas.
    const n = all.reduce((sum, e) => sum + e.quantidade, 0);
    const filtered = items.reduce((sum, e) => sum + e.quantidade, 0);
    groups.push({
      category, items,
      countText: searched ? `${filtered} de ${n}` : String(n),
      collapsed: !searched && state.collapsedGroups.has(`${board}:${category}`),
      custom: isCustomCategory(category),
      outOfCount: OUT_OF_COUNT.has(category),
      // Sem subtotal no maybeboard: ele não entra na cotação, e um preço ao
      // lado do grupo diria o contrário. Somado sobre o grupo INTEIRO mesmo
      // com busca ligada: é quanto o grupo custa no deck, e filtrar a tela
      // não barateia o deck.
      subtotal: board === "talvez" ? null : groupSubtotal(all),
    });
  }
  // Busca sem resultado precisa DIZER isso: lista vazia é o mesmo desenho de
  // "este deck não tem carta nenhuma", e o susto é achar que o filtro apagou
  // o deck.
  const noMatch = searched && !groups.length
    ? `Nenhuma carta com “${state.listFilter[board].trim()}” ${board === "talvez" ? "no maybeboard" : "no deck"}.`
    : "";
  return { groups, noMatch };
}

/* O que marca a linha de vermelho, e por quê. O maybeboard não acusa nada:
   é rascunho, e uma carta em dúvida marcada de vermelho seria alarme sobre
   uma decisão que ainda não foi tomada. A carta que ainda não saiu também é
   ilegal hoje, e não é problema: ela vira legal sozinha no dia do
   lançamento, e a etiqueta ao lado do nome já diz isso. Mesma divisão do
   `decks.validar`, que a aponta como aviso. */
export function rowProblem(entry: Entry, identity: string, board: Board) {
  const c = entry.carta;
  if (board !== "deck") return { problem: false, why: "" };
  const outside = (c.identidade || "").split("").filter((x) => !identity.includes(x));
  const repeated = entry.quantidade > 1 && !c.basico && !c.ilimitada;
  const illegal = !c.legal && !c.inedita;
  const why = outside.length ? `fora da identidade (${outside.join("")})`
    : repeated ? "singleton: só uma cópia"
    : illegal ? "não é legal em Commander" : "";
  return { problem: !!why, why };
}

/* Recolher e abrir um grupo. Fica na memória da sessão e não no deck: é como
   a lista está sendo olhada agora, não o que ela é — recarregar a página
   devolve tudo aberto, de propósito. */
export function toggleGroup(cat: string, board: Board) {
  const key = `${board}:${cat}`;
  if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
  else state.collapsedGroups.add(key);
  touch();
}

/* O que se digitou pra achar uma carta já adicionada. Sem atraso, ao
   contrário da busca da esquerda: aqui não há rede nenhuma — é filtrar uma
   lista de 100 que já está na memória. E a cotação, a curva e o resto não
   têm por que recalcular por causa de uma letra digitada: só redesenha. */
export function filterList(board: Board, text: string) {
  state.listFilter[board] = text;
  touch();
}

export function sortLists(order: string) {
  state.listOrder = LIST_ORDERS[order as keyof typeof LIST_ORDERS] ? order : "cmc";
  touch();
}
