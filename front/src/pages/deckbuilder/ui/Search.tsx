/* Os resultados das duas buscas, o paginador e o destino da carta que entra.
   A lógica é `search.ts`. */
import { useEffect, useRef } from "preact/hooks";
import { allCategories } from "../deck";
import { whereIs } from "../editing";
import { cardPrice } from "../price";
import {
  chooseDestination, PAGE_SIZES, pagerView, pickHandler, RESULTS_SHOWN, setPageSize, turnPage,
  type SearchBox, type SearchResult,
} from "../search";
import { SIDEBOARD, touch } from "../state";
import { UnreleasedTag } from "./CardBits";
import { ManaCost } from "./Mana";
import { previewProps } from "./preview";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

export function Pager() {
  useDeck();
  const p = pagerView();
  return (
    <div class="paginador res-paginador">
      <label class="por-pagina" title="Quantos resultados por página">
        <select id="res-por-pagina" aria-label="Resultados por página" value={String(p.per)}
                onChange={(e) => setPageSize(Number(e.currentTarget.value))}>
          {PAGE_SIZES.map((n) => <option value={String(n)} selected={n === p.per}>{n}</option>)}
        </select>
        <span>de {p.total}</span>
      </label>
      <span class="pag-passos">
        <button class="mini" title="Página anterior" aria-label="Página anterior" disabled={p.page === 0}
                onClick={() => turnPage(-1)}><SpriteIcon name="caret-left" /></button>
        <span>{p.page + 1} / {p.pages}</span>
        <button class="mini" title="Próxima página" aria-label="Próxima página" disabled={p.page >= p.pages - 1}
                onClick={() => turnPage(1)}><SpriteIcon name="caret-right" /></button>
      </span>
    </div>
  );
}

/* O link colado na caixa do comandante. Ele não importa sozinho: importar
   troca o deck inteiro, e uma colagem não é um pedido de troca. A oferta
   fica visível e o clique (ou o Enter) é que decide. */
function PastedLink({ source, onImport }: { source: string | null; onImport: () => void }) {
  if (!source) {
    return <div class="aponta aviso"><span>Desse link eu não trago a lista — só do <b>Archidekt</b> e do{" "}
      <b>Moxfield</b>. De qualquer outro site, use o <b>Export</b> de lá e cole a lista em{" "}
      <b>··· › Importar lista</b>.</span></div>;
  }
  return (
    <>
      <div class="aponta ok"><span>Isso é um link do <b>{source}</b> — dá pra trazer o deck inteiro de lá:
        comandante, as 99 e o maybeboard.</span></div>
      <button class="btn ouro" id="btn-importar-colado" onClick={onImport}>Importar do {source}</button>
    </>
  );
}

export function SearchResults({ box, onImportLink }: { box: SearchBox; onImportLink?: () => void }) {
  const state = useDeck();
  const r: SearchResult = state.resultados[box];
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (r.highlight >= 0) host.current?.querySelectorAll(".achado")[r.highlight]?.scrollIntoView?.({ block: "nearest" });
  }, [r.highlight]);

  if (r.pastedLink) return <PastedLink source={r.pastedLink.source} onImport={() => onImportLink?.()} />;
  if (r.error) return <div class="vazio">Busca falhou: {r.error}</div>;
  if (!r.cards.length) {
    if (!r.done) return null;
    return <div class="vazio">Nada com esse nome.{box === "cmd" && " Lembre: comandante é criatura lendária."}</div>;
  }
  // Paginada, a lista já veio do tamanho da página: o teto seria um segundo
  // corte por cima do que a pessoa pediu, e o fim da lista é o paginador.
  const shown = r.paged ? r.cards.length : RESULTS_SHOWN;
  const rest = r.cards.length - shown;
  const more = `${rest}${r.cards.length >= 24 ? "+" : ""} carta(s)`;
  const pick = pickHandler(box);
  return (
    <div ref={host} style={{ display: "contents" }}>
      {/* Três estados, não dois: uma carta que já está no maybeboard não é
          uma carta nova nem uma carta do deck, e mostrá-la como qualquer um
          dos dois faria a pessoa adicionar de novo o que ela mesma pôs em
          dúvida. */}
      {r.cards.slice(0, shown).map((c, i) => {
        const where = whereIs(c.nome);
        return (
          <button class={["achado", where === "deck" && "no-deck", where === "talvez" && "no-talvez",
                          i === r.highlight && "destacado"].filter(Boolean).join(" ")}
                  data-i={i} {...previewProps(c)}
                  onClick={() => { r.highlight = -1; pick(c); touch(); }}>
            <span class="nome"><b>{c.nome}</b><small>{c.tipo}</small></span>
            <UnreleasedTag card={c} />
            <ManaCost cost={c.mana_cost} />
            <span class="preco">{cardPrice(c)}</span>
          </button>
        );
      })}
      {r.paged ? <Pager /> : rest > 0 && (
        <div class="demais">{r.term
          ? `E mais ${more} casam. Escreva mais uma letra pra chegar na certa.`
          : `E mais ${more} na base. Escreva um nome ou use os filtros.`}</div>
      )}
    </div>
  );
}

/* Pra onde vai a próxima carta: deck, sideboard ou maybeboard. */
const DESTINATIONS: [string, string][] = [["deck", "Deck"], ["side", "Sideboard"], ["talvez", "Maybe"]];

export function DestinationSegment() {
  const state = useDeck();
  return (
    <div class="segmento" id="seg-destino">
      {DESTINATIONS.map(([d, label]) => (
        <button type="button" class={state.destino === d ? "ativa" : undefined} data-destino={d}
                onClick={() => chooseDestination(d)}>{label}</button>
      ))}
    </div>
  );
}

/* O seletor de categoria acompanha as categorias que existem: uma criada no
   menu de uma carta tem que aparecer aqui na hora, senão a pessoa a criaria
   duas vezes. Sideboard não entra — ele é o segmento ao lado, e com ele
   escolhido o seletor se desliga. A categoria escolhida que for apagada por
   baixo volta pra "pelo tipo" (ver `editing.ts`), em vez de as próximas
   cartas irem pra um lugar que não existe. */
export function DestinationCategory() {
  const state = useDeck();
  const options = allCategories().filter((c) => c !== SIDEBOARD);
  const current = options.includes(state.destinoCategoria) ? state.destinoCategoria : "";
  return (
    <select class="campo" id="sel-categoria" aria-label="Categoria da carta que entra"
            disabled={state.destino === "side"} value={current}
            onChange={(e) => { state.destinoCategoria = e.currentTarget.value; }}>
      <option value="">Pelo tipo da carta</option>
      {options.map((c) => <option value={c}>{c}</option>)}
    </select>
  );
}
