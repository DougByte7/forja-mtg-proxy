/* -------------------------------------------------------------------------
   A cotação de preços das cartas, pronta pra desenhar.

   Preço de COMPRAR as cartas, que é outra conta que a desta página (aqui se
   cobra impressão). Serve pra decidir se vale a pena proxiar. Tudo que é
   conta mora aqui; o componente só desenha.
   ------------------------------------------------------------------------- */

export type Price = {
  preco_unitario: number; loja?: string; condicao?: string;
  estoque_suficiente?: boolean; erro?: string;
};
export type Source = {
  id: string; rotulo: string; moeda: string; total: number;
  observacao?: string; cartas_faltando?: number;
};
export type Line = { nome: string; quantidade: number; tipo?: string; precos: Record<string, Price> };
export type QuoteResult = {
  fontes?: Source[];
  linhas?: Line[];
  excluidas?: { nome: string; quantidade: number; motivo: string }[];
  cambio?: { valor?: number; fonte?: string };
};

/** Linhas antes do "ver mais". */
export const VISIBLE = 10;
/* A partir de quanto acima do preço em dólar a carta ganha o indicador de
   "caro aqui". 20% é folga suficiente pra não marcar diferença de câmbio,
   spread de loja ou arredondamento — o que sobra é diferença de verdade. */
export const DISCREPANCY = 0.20;
/* Dólar de reserva, pra tela não ficar sem indicador quando o backend não
   mandar câmbio nenhum (cotação de uma versão anterior, por exemplo). */
const FALLBACK_RATE = 5;

/* Grupos da tabela expandida. A ORDEM daqui é a ordem na tela, e o primeiro
   padrão que casar vence — por isso "Terrenos" vem antes de "Criaturas"
   (Dryad Arbor é terreno pra quem monta) e "Criaturas" antes de "Artefatos". */
const GROUPS: [string, RegExp][] = [
  ["Planeswalkers", /planeswalker/],
  ["Batalhas", /battle/],
  ["Terrenos", /land/],
  ["Criaturas", /creature/],
  ["Artefatos", /artifact/],
  ["Encantamentos", /enchantment/],
  ["Mágicas instantâneas", /instant/],
  ["Feitiços", /sorcery/],
];
const OTHERS = "Outras";

export function money(value: number, code: string) {
  const n = value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (code === "BRL" ? "R$ " : code === "USD" ? "US$ " : code + " ") + n;
}

/** `type` é o type_line cru da Scryfall. Dupla-face vem "frente // verso", e
    quem manda é a frente, que é a que se joga da mão. */
export function groupOf(type?: string) {
  const front = String(type || "").split("//")[0].toLowerCase();
  return GROUPS.find(([, re]) => re.test(front))?.[0] ?? OTHERS;
}

export type Pricey = { pct: number; title: string };
export type Cell =
  | { error: true }
  | { error: false; price: string; lowStock: boolean; store: string; pricey: Pricey | null };
export type Row = { name: string; qty: number; found: boolean; cells: Cell[] };
export type Box = { title: string; total: string; note: string; list: string; theoretical?: boolean };

export function quoteView(r: QuoteResult) {
  const sources = r.fontes || [];
  const all = r.linhas || [];
  // Câmbio só pra COMPARAR as duas colunas — ver `cambio.py`. Não entra em
  // total nenhum: nada é convertido pra mostrar, só pra decidir se a carta
  // está desproporcionalmente cara no Brasil.
  const fx = r.cambio || {};
  const rate = fx.valor && fx.valor > 0 ? fx.valor : FALLBACK_RATE;
  const fixedRate = fx.fonte === "fixa";
  // A comparação é entre a fonte principal (a brasileira, que ordena a
  // tabela) e a seguinte, o mercado em dólar.
  const base = sources[0] || null;
  const ref = sources[1] || null;
  const comparable = !!base && !!ref && base.moeda === "BRL";
  const inBRL = (value: number, code: string) =>
    code === "BRL" ? value : code === "USD" ? value * rate : null;

  /** O menor preço da carta em real, venha de onde vier. */
  function cheapestBRL(l: Line) {
    let min: number | null = null;
    for (const s of sources) {
      const p = l.precos[s.id];
      if (!p || p.erro) continue;
      const v = inBRL(p.preco_unitario, s.moeda);
      if (v !== null && v > 0 && (min === null || v < min)) min = v;
    }
    return min;
  }

  function pricey(l: Line): Pricey | null {
    if (!comparable) return null;
    const here = l.precos[base!.id], there = l.precos[ref!.id];
    if (!here || !there || here.erro || there.erro) return null;
    const a = inBRL(here.preco_unitario, base!.moeda);
    const b = inBRL(there.preco_unitario, ref!.moeda);
    if (!(a! > 0) || !(b! > 0)) return null;
    const excess = a! / b! - 1;
    if (excess < DISCREPANCY) return null;
    const pct = Math.round(excess * 100);
    return {
      pct,
      title: `${pct}% acima da ${ref!.rotulo} (${money(there.preco_unitario, ref!.moeda)}`
        + (ref!.moeda === "BRL" ? "" : ` ≈ ${money(b!, "BRL")} a ${money(rate, "BRL")} por dólar`) + ")",
    };
  }

  /* "Nome [R$ x,xx]", uma carta por linha, na ordem da tabela. Carta sem
     preço na caixa fica de fora: quem cola isso quer o que dá pra comprar. */
  const listText = (priceOf: (l: Line) => string | null) => all
    .map((l) => { const p = priceOf(l); return p ? `${l.nome} [${p}]` : null; })
    .filter(Boolean).join("\n");

  // Uma caixa por fonte, e cada botão copia a lista com o preço que AQUELA
  // caixa somou — nunca mistura o preço de uma fonte com o total de outra.
  const boxes: Box[] = sources.map((s) => ({
    title: s.rotulo,
    total: money(s.total, s.moeda),
    note: (s.observacao || "") + (s.cartas_faltando ? ` · ${s.cartas_faltando} carta(s) sem preço` : ""),
    list: listText((l) => { const p = l.precos[s.id]; return !p || p.erro ? null : money(p.preco_unitario, s.moeda); }),
  }));

  /* O piso teórico: carta a carta, o menor entre o preço em real e o de fora
     convertido. Nenhuma loja vende o deck por esse total — é o chão de quem
     garimpa nas duas pontas, e por isso vive numa caixa separada. */
  if (sources.length > 1 && sources.some((s) => s.moeda === "BRL" || s.moeda === "USD")) {
    let total = 0, missing = 0;
    for (const l of all) {
      const v = cheapestBRL(l);
      if (v === null) missing++;
      else total += v * l.quantidade;
    }
    boxes.push({
      title: "Menor custo teórico",
      total: money(total, "BRL"),
      note: `o menor preço de cada carta entre as fontes, o de fora convertido a ${money(rate, "BRL")} por dólar`
        + (fixedRate ? " (valor fixo, sem consultar câmbio)" : "")
        + " · nenhuma loja vende tudo por esse total"
        + (missing ? ` · ${missing} carta(s) sem preço` : ""),
      list: listText((l) => { const v = cheapestBRL(l); return v === null ? null : money(v, "BRL"); }),
      theoretical: true,
    });
  }

  const rowOf = (l: Line): Row => {
    const mark = pricey(l);
    return {
      name: l.nome,
      qty: l.quantidade,
      found: sources.some((s) => l.precos[s.id] && !l.precos[s.id].erro),
      cells: sources.map((s): Cell => {
        const p = l.precos[s.id];
        if (!p || p.erro) return { error: true };
        return {
          error: false,
          price: money(p.preco_unitario, s.moeda),
          lowStock: !p.estoque_suficiente,
          store: (p.loja || "") + (p.condicao ? " · " + p.condicao : ""),
          // O indicador vai na coluna brasileira, colado no número que critica.
          pricey: s === base ? mark : null,
        };
      }),
    };
  };

  // Fechada: as 10 mais caras (as linhas já chegam do backend do subtotal
  // maior pro menor). Aberta: a lista inteira agrupada por tipo, cada grupo
  // ainda do mais caro pro mais barato.
  const top = all.slice(0, VISIBLE).map(rowOf);
  const byGroup = new Map<string, Line[]>();
  for (const l of all) {
    const g = groupOf(l.tipo);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(l);
  }
  // Sem tipo em carta nenhuma (Scryfall fora) não há o que agrupar: cai na
  // lista corrida em vez de uma gaveta "Outras" com o deck inteiro dentro.
  const groupable = all.some((l) => l.tipo) && !(byGroup.size === 1 && byGroup.has(OTHERS));
  const groups = groupable
    ? [...GROUPS.map(([name]) => name), OTHERS].filter((g) => byGroup.has(g)).map((name) => {
        const lines = byGroup.get(name)!;
        return { name, cards: lines.length, copies: lines.reduce((n, l) => n + l.quantidade, 0),
                 rows: lines.map(rowOf) };
      })
    : null;

  // O que ficou de fora do total, e por quê. Sem isso o total parece menor
  // do que é sem explicação nenhuma.
  const out = r.excluidas || [];
  let excluded: { parts: string[]; hasToken: boolean } | null = null;
  if (out.length) {
    const byReason = new Map<string, number>();
    for (const c of out) byReason.set(c.motivo, (byReason.get(c.motivo) || 0) + c.quantidade);
    const parts: string[] = [];
    byReason.forEach((copies, reason) => {
      parts.push(reason === "comandante"
        ? `o comandante (${out.filter((c) => c.motivo === "comandante").map((c) => c.nome).join(", ")})`
        : `${copies} ${reason}${copies > 1 ? "s" : ""}`);
    });
    excluded = { parts, hasToken: byReason.has("token") };
  }

  return {
    boxes,
    sourceLabels: sources.map((s) => s.rotulo),
    top,
    all: groupable ? null : all.map(rowOf),
    groups,
    hidden: Math.max(0, all.length - VISIBLE),
    total: all.length,
    excluded,
    // Explica o ▲ sempre que ele PUDER aparecer, mesmo que nenhuma carta o
    // tenha ganhado: triângulo vermelho sem legenda assusta sem informar.
    priceyNote: comparable ? {
      refLabel: ref!.rotulo,
      conversion: ref!.moeda === "BRL" ? "" : `, convertido a ${money(rate, "BRL")} por dólar (${
        fixedRate ? "valor fixo, sem consultar câmbio" : "câmbio de hoje"})`,
    } : null,
  };
}

export type QuoteView = ReturnType<typeof quoteView>;
