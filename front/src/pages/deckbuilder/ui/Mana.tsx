/* Custo de mana em bolinhas (o modelo é `mana.ts`). */
import { manaSides, manaTextParts, type ManaSymbol } from "../mana";

function Pip({ symbol: s }: { symbol: ManaSymbol }) {
  if (s.kind === "hybrid") {
    return <span class="pip hibrido" title={s.title}
      style={{ "--pip-a": `var(--mana-${s.colors[0]})`, "--pip-b": `var(--mana-${s.colors[1]})` }} />;
  }
  if (s.kind === "color") return <span class={`pip ${s.color}`} title={s.title} />;
  return <span class="pip C" title={s.title}>{s.label}</span>;
}

export function ManaCost({ cost }: { cost: string | null | undefined }) {
  const sides = manaSides(cost);
  if (!sides.length) return null;
  return (
    <span class="mana">
      {sides.map((side) => <span class="lado">{side.map((s) => <Pip symbol={s} />)}</span>)}
    </span>
  );
}

/** Uma frase com custos de mana dentro: os custos viram bolinha. */
export function ManaText({ text }: { text: string | null | undefined }) {
  return <>{manaTextParts(text).map((p) => "mana" in p ? <ManaCost cost={p.mana} /> : p.text)}</>;
}
