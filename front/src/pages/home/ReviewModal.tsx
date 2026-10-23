/* Revisão da folha: prévia do PDF e editor de cópias, 100% no navegador.
   O que sai daqui é o XML revisado (ver `confirmReview`). */
import { useEffect, useRef } from "preact/hooks";
import { cardTitle } from "./art";
import { CardList, SheetPages, type GroupControls, type SlotControls } from "./Sheet";
import * as edit from "./sheet";
import {
  applyEdit, cancelReview, catalog, confirmReview, footMessage, history, lamination,
  prices, reviewOpen, slots, undo,
} from "./store";
import { brl, cardsPerPage, computeTotals } from "./totals";

const copies: SlotControls = {
  addCopy: (k) => applyEdit((s, c) => edit.addCopy(s, c, k)),
  removeCopy: (k) => applyEdit((s, c) => edit.removeCopy(s, c, k)),
  addBack: (k, b) => applyEdit((s, c) => edit.addBack(s, c, k, b)),
  removeBack: (k, b) => applyEdit((s, c) => edit.removeBack(s, c, k, b)),
};

const rows: GroupControls = {
  front: (g) => {
    const t = cardTitle(g.front);
    return {
      less: { label: `Remover uma cópia de ${t}`, onClick: () => copies.removeCopy(g.key) },
      more: { label: `Adicionar uma cópia de ${t}`, onClick: () => copies.addCopy(g.key) },
      remove: { label: `Tirar ${t} do pedido`, onClick: () => applyEdit((s, c) => edit.removeGroup(s, c, g.key)) },
    };
  },
  back: (g, backId) => {
    const t = cardTitle(g.front);
    const empty = !g.backs.get(backId)!.idx.length;
    return {
      less: { label: `Remover um verso de ${t}`, onClick: () => copies.removeBack(g.key, backId), disabled: empty },
      more: { label: `Adicionar um verso de ${t}`, onClick: () => copies.addBack(g.key, backId) },
      remove: { label: `Tirar todos os versos de ${t}`, disabled: empty,
                onClick: () => applyEdit((s, c) => edit.removeAllBacks(s, c, g.key, backId)) },
    };
  },
};

const plural = (n: number, one: string, many: string) => <><b>{n}</b> {n === 1 ? one : many}</>;

export function ReviewModal() {
  const open = reviewOpen.value;
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    pane.current && (pane.current.scrollTop = 0);
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelReview();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = slots.value;
  const backs = current.filter((s) => s.back).length;
  const t = computeTotals(current.length, backs, lamination.value, prices.value);

  return (
    <div class={"modal" + (open ? " show" : "")} role="dialog" aria-modal="true" aria-labelledby="reviewTitle"
         onClick={(e) => { if (e.target === e.currentTarget) cancelReview(); }}>
      <div class="modal-box">
        <div class="modal-head">
          <h2 id="reviewTitle">Revisar o pedido
            <span class="sub">Confira as cartas e ajuste as quantidades. Cada página leva {cardsPerPage(lamination.value)} cartas.</span>
          </h2>
          <button class="icon-btn" disabled={!history.value.length} onClick={undo}
                  title="Desfazer a última ação (Ctrl+Z)">↶ Desfazer</button>
          <button class="icon-btn" onClick={cancelReview} title="Descartar as alterações (Esc)">✕</button>
        </div>

        {open && (
          <div class="modal-body">
            <div class="deck-pane">
              <p class="pane-title">Cartas do pedido</p>
              <div><CardList groups={edit.sheetGroups(current, catalog.value)} controls={rows} /></div>
            </div>
            <div class="sheet-pane" ref={pane}>
              <div><SheetPages slots={current} lam={lamination.value} controls={copies} /></div>
            </div>
          </div>
        )}

        <div class="modal-foot">
          <div class="foot-sum">
            <div>{plural(current.length, "carta", "cartas")}
              {backs > 0 && <> · <b>{backs}</b> com verso próprio</>}
              {" · "}{plural(t.pages, "página", "páginas")}
              {t.blanks ? <> · sobram {plural(t.blanks, "espaço livre", "espaços livres")}</> : " · última página completa"}
            </div>
            <div>{t.lamLabel} · <span class="price">R$ {brl(t.total)}</span></div>
          </div>
          <button class="icon-btn" onClick={cancelReview}>Cancelar</button>
          <button class="confirm-btn" onClick={confirmReview}>Confirmar revisão</button>
          <p class="foot-msg">{footMessage.value}</p>
        </div>
      </div>
    </div>
  );
}
