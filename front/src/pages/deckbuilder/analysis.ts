/* O que a aba de análise conta: os apontamentos da validação agrupados, a
   curva de mana e a distribuição de cores e de tipos. */
import { autoCategory, countedCards } from "./deck";
import { COLORS } from "./state";

export type Issue = { tipo: string; nivel: string; mensagem: string; carta?: string };

export const ISSUE_LABELS: Record<string, string> = {
  identidade: "Fora da identidade de cor",
  singleton: "Singleton quebrado",
  banida: "Não é legal em Commander",
  desconhecida: "Não achei na base local",
  "comandante-repetido": "Comandante repetido nas 99",
};

/** "Faltam" e "sobram" não são erro: são o estado de quem está montando. */
export const isCountIssue = (a: Issue) => a.tipo === "faltam" || a.tipo === "sobram";

/* Um erro por carta vira ruído numa lista de 99: agrupa por tipo e mostra
   "12 cartas fora da identidade" com os nomes juntos. */
export function groupIssues(issues: Issue[]) {
  const byType = new Map<string, Issue[]>();
  for (const a of issues) {
    if (!byType.has(a.tipo)) byType.set(a.tipo, []);
    byType.get(a.tipo)!.push(a);
  }
  return [...byType.values()].map((group) => {
    const first = group[0];
    const names = group.map((x) => x.carta).filter(Boolean) as string[];
    return {
      level: first.nivel,
      title: names.length > 1 ? ISSUE_LABELS[first.tipo] || "" : "",
      text: names.length > 1
        ? `${names.length} cartas: ${names.slice(0, 6).join(", ")}` + (names.length > 6 ? ` e mais ${names.length - 6}` : "")
        : first.mensagem,
    };
  });
}

/* A curva, de 0 a 7+. Terreno fica de fora: ele não tem custo, e incluí-lo
   achataria a curva toda no zero, que é justamente o número que ninguém quer
   ler. */
export function manaCurve() {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const { carta, quantidade } of countedCards()) {
    if (!carta || (carta.tipo || "").toLowerCase().includes("land")) continue;
    counts[Math.min(7, Math.floor(carta.cmc || 0))] += quantidade;
  }
  return counts;
}

/* O que o deck PEDE de cor, lido dos símbolos do custo (terreno e o que
   produz mana não entram: isto não é o que ele produz). */
export function colorDemand() {
  const demand: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let total = 0;
  for (const { carta, quantidade } of countedCards()) {
    if (!carta) continue;
    for (const symbol of (carta.mana_cost || "").match(/\{[^}]+\}/g) || []) {
      for (const c of symbol.slice(1, -1).split("/")) {
        if (demand[c] !== undefined) { demand[c] += quantidade; total += quantidade; }
      }
    }
  }
  return COLORS.filter((c) => demand[c] > 0).map((c) => ({ color: c, count: demand[c], share: total ? demand[c] / total : 0 }));
}

/* Por tipo, e não pela categoria escolhida à mão: aqui a pergunta é "meu
   deck tem criatura demais?", e um deck cujas criaturas estão em "combo
   principal" responderia zero. */
export function typeCounts() {
  const byCategory = new Map<string, number>();
  for (const { carta, quantidade } of countedCards()) {
    const cat = autoCategory(carta);
    byCategory.set(cat, (byCategory.get(cat) || 0) + quantidade);
  }
  const max = Math.max(1, ...byCategory.values());
  return [...byCategory.entries()].sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count, share: count / max }));
}
