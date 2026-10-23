/* A folha desenhada: a arte de uma carta, a linha da lista de cartas e as
   páginas A4. Servem à revisão (com os + e −) e ao "Meus Pedidos" (só
   leitura, porque ali o pedido já virou cobrança). */
import { useState } from "preact/hooks";
import { artSources, cardTitle } from "./art";
import { gridOf, PAGE_H_MM, PAGE_W_MM, pagesOf, type Group } from "./sheet";
import type { Lamination } from "./totals";
import type { CardMeta, Slot } from "./xml";

/** A miniatura, tentando cada endereço; se todos falharem, o nome da carta
    aparece no lugar — a prévia continua servindo pra conferir quantidades. */
export function CardArt({ meta, width, cls }: { meta: CardMeta; width: number; cls?: string }) {
  const sources = artSources(meta.id, width);
  const [attempt, setAttempt] = useState(0);
  const title = cardTitle(meta);
  return (
    <div class={"art" + (cls ? " " + cls : "")}>
      {attempt < sources.length
        ? <img key={attempt} src={sources[attempt]} alt={title} loading="lazy" decoding="async"
               referrerpolicy="no-referrer" onError={() => setAttempt((a) => a + 1)} />
        : <span class="fb">{title}</span>}
    </div>
  );
}

type Control = { label: string; onClick: () => void; disabled?: boolean };
export type RowControls = { less: Control; more: Control; remove: Control };

function CardRow({ cls, meta, title, desc, count, controls }:
  { cls: string; meta: CardMeta; title: string; desc: string; count: number; controls?: RowControls }) {
  const btn = (text: string, c: Control, extra?: string) => (
    <button type="button" class={extra} title={c.label} aria-label={c.label}
            disabled={!!c.disabled} onClick={c.onClick}>{text}</button>
  );
  return (
    <div class={cls}>
      <CardArt meta={meta} width={120} cls="ci-thumb" />
      <div class="ci-info">
        <div class="ci-name" title={title}>{title}</div>
        <div class="ci-meta">{desc}</div>
      </div>
      {controls ? (
        <>
          <div class="qty">
            {btn("−", controls.less)}
            <span class="n">{count}</span>
            {btn("+", controls.more)}
          </div>
          {btn("✕", controls.remove, "ci-del")}
        </>
      ) : (
        <div class="qty-ro">×{count}</div>
      )}
    </div>
  );
}

export type GroupControls = {
  front: (g: Group) => RowControls;
  back: (g: Group, backId: string) => RowControls;
};

/** Uma linha por FRENTE e, embaixo dela, uma linha por verso próprio — cada
    uma com o seu contador. É o que deixa tirar o verso sem tirar a carta. */
export function CardList({ groups, controls }: { groups: Group[]; controls?: GroupControls }) {
  return (
    <>
      {groups.map((g) => {
        const title = cardTitle(g.front);
        const backs = Array.from(g.backs.values());
        const withBack = backs.reduce((n, b) => n + b.idx.length, 0);
        return (
          <div class="ci-block" key={g.key}>
            <CardRow cls="ci" meta={g.front} title={title} count={g.idx.length}
              desc={`${g.idx.length} ${g.idx.length === 1 ? "cópia" : "cópias"}`
                + (withBack ? ` · ${withBack} com verso próprio` : "")}
              controls={controls?.front(g)} />
            {backs.map((b) => (
              <CardRow key={b.id} cls={"ci ci-sub" + (controls && !b.idx.length ? " vazia" : "")}
                meta={b.meta} title={cardTitle(b.meta)} count={b.idx.length}
                desc={`verso de ${title} · ${b.idx.length} de ${g.idx.length}`}
                controls={controls?.back(g, b.id)} />
            ))}
          </div>
        );
      })}
    </>
  );
}

const pct = (value: number, total: number) => (value / total * 100).toFixed(4) + "%";

export type SlotControls = {
  addCopy: (frontKey: string) => void;
  removeCopy: (frontKey: string) => void;
  addBack: (frontKey: string, backId: string) => void;
  removeBack: (frontKey: string, backId: string) => void;
};

/* Carta deitada (foil): a arte em pé, girada 90° no sentido anti-horário pra
   caber no slot 88x63 — o mesmo giro do `_draw_card` do pdf_generator. */
const ROTATED_ART = {
  left: "50%", top: "50%",
  width: (63 / 88 * 100).toFixed(4) + "%", height: (88 / 63 * 100).toFixed(4) + "%",
  transform: "translate(-50%, -50%) rotate(-90deg)",
};

/** As páginas como saem do PDF. Sem `controls`, a mesma folha sem os + e −.
    `lam` escolhe a grade: o foil sai com 8 cartas deitadas. */
export function SheetPages({ slots, lam, controls }:
  { slots: Slot[]; lam?: Lamination; controls?: SlotControls }) {
  const grid = gridOf(lam);
  const pages = pagesOf(slots, grid.perPage);
  return (
    <>
      {pages.map((items, p) => (
        <div class="pg-wrap" key={p}>
          <div class="pg-label">Página {p + 1} de {pages.length}</div>
          <div class="pg">
            {Array.from({ length: grid.perPage }, (_, i) => {
              const item = items[i];
              const style = {
                left: pct(grid.marginX + (i % grid.cols) * grid.slotW, PAGE_W_MM),
                top: pct(grid.marginY + Math.floor(i / grid.cols) * grid.slotH, PAGE_H_MM),
                width: pct(grid.slotW, PAGE_W_MM),
                height: pct(grid.slotH, PAGE_H_MM),
              };
              if (!item) return <div class="pg-slot empty" style={style}><span>livre</span></div>;
              const title = cardTitle(item.meta);
              return (
                <div class="pg-slot" style={style}>
                  {grid.rotated
                    ? <div class="pg-rot" style={ROTATED_ART}><CardArt meta={item.meta} width={400} /></div>
                    : <CardArt meta={item.meta} width={400} />}
                  {item.kind === "back" && <span class="pg-badge">VERSO</span>}
                  {controls && (
                    <div class="pg-ctrl">
                      {item.kind === "back" ? (
                        // O verso tem contador próprio: dá pra tirar o verso e
                        // deixar a frente na folha, ou o contrário.
                        <>
                          <button type="button" title="Remover este verso, mantendo a frente"
                                  aria-label="Remover este verso, mantendo a frente"
                                  onClick={() => controls.removeBack(item.frontKey, item.backId)}>−</button>
                          <button type="button" title="Adicionar mais um verso desta carta"
                                  aria-label="Adicionar mais um verso desta carta"
                                  onClick={() => controls.addBack(item.frontKey, item.backId)}>+</button>
                        </>
                      ) : (
                        <>
                          <button type="button" title={`Remover uma cópia de ${title}`}
                                  aria-label={`Remover uma cópia de ${title}`}
                                  onClick={() => controls.removeCopy(item.frontKey)}>−</button>
                          <button type="button" title={`Adicionar uma cópia de ${title}`}
                                  aria-label={`Adicionar uma cópia de ${title}`}
                                  onClick={() => controls.addCopy(item.frontKey)}>+</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <svg class="pg-guides" viewBox={`0 0 ${PAGE_W_MM} ${PAGE_H_MM}`} aria-hidden="true">
              {grid.guides.map((l) => <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} stroke-width="0.2" />)}
            </svg>
          </div>
        </div>
      ))}
    </>
  );
}
