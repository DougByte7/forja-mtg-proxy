/* O detalhe da cotação, ancorado no número do cabeçalho. Só o que não cabe
   no cabeçalho: as fontes, onde está o dinheiro, o que ficou de fora. */
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { closeQuote, quoteBox } from "../budget";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

type Source = { id: string; rotulo: string; moeda: string; total: number; cartas_cotadas: number; cartas_faltando: number };
type QuotedCard = { nome: string; fontes?: Record<string, { preco?: number }> };

const symbol = (currency: string) => currency === "BRL" ? "R$" : "US$";

/* Total que não cobre o deck inteiro precisa dizer isso NO LUGAR do número,
   não embaixo dele: uma fonte fora do ar devolve zero carta cotada, e
   "US$ 0,00" lido como total é pior do que não ter cotado. */
function SourceLine({ f }: { f: Source }) {
  const asked = f.cartas_cotadas + f.cartas_faltando;
  if (!f.cartas_cotadas) {
    return (
      <div class="aponta aviso" style={{ marginTop: "6px" }}>
        <span><b>{f.rotulo}</b> não devolveu preço de nenhuma das {asked} cartas. Fonte fora do ar ou bloqueando a
          consulta — não é que o deck seja de graça.</span>
      </div>
    );
  }
  return (
    <div class="fonte">
      <span class="rot">{f.rotulo}<br />
        <small style={{ color: f.cartas_faltando ? "var(--gold-light)" : "var(--text-muted)" }}>
          {f.cartas_cotadas} de {asked} cartas{f.cartas_faltando ? " — total incompleto" : ""}</small></span>
      <span class="tot">{symbol(f.moeda)} {Number(f.total).toFixed(2)}</span>
    </div>
  );
}

export function QuoteDetail() {
  const state = useDeck();
  if (state.cotacaoErro) {
    return <div class="aponta erro" style={{ gridColumn: "1/-1" }}><span>{state.cotacaoErro}</span></div>;
  }
  const result = state.cotacao;
  if (!result) return null;
  const sources: Source[] = result.fontes || [];
  // As mais caras primeiro: é o que responde "onde está o dinheiro do deck",
  // que é a pergunta de quem cota antes de proxiar.
  const main = sources[0];
  const pricey = ((result.cartas || []) as QuotedCard[])
    .filter((c) => main && c.fontes?.[main.id]?.preco)
    .sort((a, b) => b.fontes![main.id].preco! - a.fontes![main.id].preco!)
    .slice(0, 8);
  const excluded = (result.excluidas || []).length;
  const maybe = state.maybe.reduce((n, e) => n + e.quantidade, 0);
  return (
    <>
      <div>{sources.map((f) => <SourceLine f={f} />)}</div>
      {pricey.length > 0 && (
        <div class="caras">
          <h2 class="secao">Onde está o dinheiro</h2>
          {pricey.map((c) => (
            <div class="cara"><b>{c.nome}</b>
              <span>{symbol(main.moeda)} {Number(c.fontes![main.id].preco).toFixed(2)}</span></div>
          ))}
        </div>
      )}
      <div>
        {excluded > 0 && (
          <p class="nota">{excluded} carta(s) fora do total: comandante e terrenos básicos, pelo critério do
            Commander 500.</p>
        )}
        {maybe > 0 && (
          <p class="nota" style={{ marginTop: "8px" }}>{maybe} carta(s) no maybeboard não foram cotadas — é pra
            isso que ele serve.</p>
        )}
      </div>
    </>
  );
}

/* O popover. Fecha no clique de fora, como os menus — menos o clique no
   próprio ⌄, que é quem o alterna. */
export function QuoteBox() {
  const anchor = quoteBox.value;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !anchor) return;
    const width = box.getBoundingClientRect().width;
    box.style.left = Math.max(8, Math.min(anchor.left - width + anchor.width, window.innerWidth - width - 8)) + "px";
    box.style.top = anchor.bottom + 6 + "px";
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest?.("#btn-cotacao")) closeQuote();
    };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [anchor]);
  return (
    <div class="cotacao-caixa" id="cotacao-caixa" ref={ref} hidden={!anchor}>
      <div class="cotacao-topo">
        <h2 class="secao">Cotação</h2>
        <button class="mini sai" id="btn-fechar-cotacao" title="Fechar" onClick={closeQuote}><SpriteIcon name="x" /></button>
      </div>
      <div id="orc-resultado" class="orc-resultado"><QuoteDetail /></div>
    </div>
  );
}
