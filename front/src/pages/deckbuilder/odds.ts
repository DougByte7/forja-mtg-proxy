/* ------------------------------------------------------ chances de comprar

   A conta da urna, hipergeométrica: a biblioteca tem N cartas, K delas são da
   categoria, e a pergunta é quantas aparecem nas primeiras compras. O
   comandante não entra na conta — ele começa na zona de comando, não no
   baralho.

   Todas as janelas assumem quem JOGA PRIMEIRO, que é o lado sem a compra do
   turno 1: é o caso pior, e é sobre o caso pior que se decide quantos terrenos
   o deck leva. */
import { autoCategory, categoryOf, countedCards, isCustomCategory } from "./deck";
import { state } from "./state";

export const SEEN_IN_HAND = 7;   // a mão inicial
export const SEEN_BY_T3 = 9;     // a mão mais as compras dos turnos 2 e 3
export const SEEN_BY_T4 = 10;    // idem, até o turno 4

/* Fatorial em logaritmo, e não fatorial direto: C(99,10) já passa de 10^13, e
   a divisão de dois números desses perde dígito. Em log tudo vira soma. */
const logFactorials = [0];
function logFactorial(n: number) {
  for (let i = logFactorials.length; i <= n; i++) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  return logFactorials[n];
}

function logChoose(n: number, k: number) {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** Chance de sair EXATAMENTE `k` cartas da categoria em `n` compras. */
export function hypergeometric(N: number, K: number, n: number, k: number) {
  if (k < 0 || k > K || n - k < 0 || n - k > N - K) return 0;
  return Math.exp(logChoose(K, k) + logChoose(N - K, n - k) - logChoose(N, n));
}

export function chanceAtLeast(N: number, K: number, n: number, min: number) {
  let sum = 0;
  for (let k = min; k <= Math.min(n, K); k++) sum += hypergeometric(N, K, n, k);
  return sum;
}

export function chanceAtMost(N: number, K: number, n: number, max: number) {
  let sum = 0;
  for (let k = 0; k <= Math.min(max, n, K); k++) sum += hypergeometric(N, K, n, k);
  return sum;
}

/* O primeiro mulligan do Commander é de graça: a mão inteira volta pro
   baralho, você embaralha, compra sete de novo e FICA com as sete — nenhuma
   carta vai pro fundo. São duas mãos de sete tiradas do mesmo baralho
   embaralhado, independentes uma da outra, então a chance de nenhuma das duas
   trazer a carta é a de uma ao quadrado. É a conta de quem dá o mulligan
   justamente quando a primeira mão não traz nada da categoria. */
export function chanceWithMulligan(N: number, K: number, min: number) {
  const empty = 1 - chanceAtLeast(N, K, SEEN_IN_HAND, min);
  return 1 - empty * empty;
}

export const percent = (p: number) => Math.round(p * 100) + "%";

/* Os dois riscos da mana base viram um estado escrito, não só uma cor: numa
   base de 36 terrenos em 99 os dois ficam perto de 10%, e é dos dois lados
   dessa marca que a régua foi tirada. */
const RISK_LEVELS: [number, string, string][] = [
  [0.12, "ok", "dentro do normal"],
  [0.18, "atencao", "no limite"],
  [1.01, "alto", "alto"],
];

export function manaRisk(p: number) {
  const [, level, label] = RISK_LEVELS.find(([max]) => p <= max)!;
  return { value: p, level, label };
}

/* A lista é contada duas vezes, e a tabela mostra os dois recortes.

   Pela categoria AUTOMÁTICA, a mesma da distribuição de tipos: a pergunta é
   "quando é que eu vejo uma criatura?", e um deck cujas criaturas estão
   guardadas em "combo principal" responderia nunca.

   E pelas categorias PRÓPRIAS, porque "quando é que eu vejo um sac outlet?"
   é a pergunta que quem montou o deck faz de verdade, e nenhum type_line
   responde a ela. As duas contagens se sobrepõem de propósito: a mesma carta
   é um sac outlet E uma criatura, e são duas perguntas sobre ela. */
export function oddsView() {
  const entries = countedCards();
  const N = entries.reduce((n, e) => n + e.quantidade, 0);
  if (N < SEEN_BY_T4) return { N, rows: null, shortage: null, flood: null };

  const byType = new Map<string, number>();
  const byCustom = new Map<string, number>();
  for (const entry of entries) {
    const auto = autoCategory(entry.carta);
    byType.set(auto, (byType.get(auto) || 0) + entry.quantidade);
    const cat = categoryOf(entry);
    if (isCustomCategory(cat)) byCustom.set(cat, (byCustom.get(cat) || 0) + entry.quantidade);
  }

  // As próprias em cima e na ordem em que a pessoa as pôs, como na lista: é a
  // organização dela, e ela vem antes do que a carta é. Os tipos seguem
  // ordenados por tamanho, que é a ordem que ninguém escolheu.
  const custom = state.categories.filter((c) => byCustom.has(c)).map((c) => [c, byCustom.get(c)!, true] as const);
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([c, K]) => [c, K, false] as const);
  const rows = [...custom, ...types].map(([category, K, isCustom]) => ({
    category, K, isCustom,
    hand: chanceAtLeast(N, K, SEEN_IN_HAND, 1),
    mulligan: chanceWithMulligan(N, K, 1),
    byT3: chanceAtLeast(N, K, SEEN_BY_T3, 1),
  }));

  const lands = byType.get("Terrenos") || 0;
  return {
    N, rows,
    // Chegar ao turno 3 com um terreno ou nenhum; ver 6 ou mais até o turno 4.
    shortage: manaRisk(chanceAtMost(N, lands, SEEN_BY_T3, 1)),
    flood: manaRisk(chanceAtLeast(N, lands, SEEN_BY_T4, 6)),
  };
}
