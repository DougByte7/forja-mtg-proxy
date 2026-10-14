/* A barra de combinar pedidos numa folha só. Nasce escondida e só aparece
   com pedido marcado. */
import { useEffect } from "preact/hooks";
import type { useAdminActions } from "./actions";
import { localSummary } from "./preview";
import { LAMINATION } from "./states";
import { busy, clearSelection, combo, comboMap, comboNote, markedOrders, selected } from "./store";

export function ComboBar({ actions }: { actions: ReturnType<typeof useAdminActions> }) {
  const n = selected.value.size;

  useEffect(() => {
    document.body.classList.toggle("com-combo", n > 0);
    return () => document.body.classList.remove("com-combo");
  }, [n > 0]);

  if (!n) return null;

  const list = markedOrders.value;
  const laminations = [...new Set(list.map((p) => p.lamination))];
  const mixed = laminations.length > 1;
  const few = n < 2;
  const s = localSummary(list);
  const blocked = few || mixed;
  const note = comboNote.value;
  const map = comboMap.value;

  return (
    <div class="combo-barra">
      <div class="combo-dentro">
        <div class="combo-conta">
          <b>{n}</b> pedido(s) marcado(s) — <b>{s.cards}</b> carta(s)<br />
          {few ? (
            <span class="nada">Marque pelo menos dois pra combinar.</span>
          ) : mixed ? (
            // A laminação é uma propriedade da FOLHA, não da carta: o papel
            // inteiro passa (ou não) pela plastificadora. Misturar entregaria
            // acabamento errado pra metade da gente, e não tem desfazer.
            <span class="erro">Laminação misturada ({laminations.map((l) => LAMINATION[l] || l)
              .join(" e ")}) — só dá pra combinar pedidos com o mesmo acabamento.</span>
          ) : (
            <>
              {/* A linha de cima é o desperdício: quantos slots em branco os
                  pedidos jogariam fora separados, e quantos sobram depois de
                  emendados. A folha economizada é a tradução em papel. */}
              {s.separateBlanks} espaço(s) em branco separados → <b>{s.blanks}</b> combinados{" "}
              {s.blanksSaved
                ? <span class="ganho">({s.blanksSaved} espaço(s) aproveitado(s) = {s.sheetsSaved} folha(s))</span>
                : <span class="nada">(nada aproveitado — o branco não fecha folha ainda)</span>}
              <br />
              {s.separate} folha(s) separadas → <b>{s.combined}</b> combinadas{" "}
              {/* O branco que sobra é convite: dá pra decidir se vale esperar
                  mais um pedido pequeno em vez de imprimir folha pela metade. */}
              {s.blanks
                ? <span class="nada">— ainda cabe(m) {s.blanks} carta(s) na última folha</span>
                : <span class="ganho">— a última folha fecha certinho</span>}
            </>
          )}
        </div>
        <div class="combo-acoes">
          {/* Combinar é só a conta oficial e o mapa. A folha em si é montada
              pelo worker, e é no painel dele, na rede de casa, que ela se
              confere antes de imprimir. */}
          {!combo.value && (
            <button class="btn-ouro" disabled={blocked || busy.value > 0}
                    onClick={actions.combine}>Combinar</button>
          )}
          {combo.value && !blocked && (
            <button class="btn-sec" onClick={actions.confirmComboPrint}>Imprimir</button>
          )}
          <button class="btn-sec" onClick={clearSelection}>Limpar</button>
        </div>
      </div>
      {(note || map) && (
        <div class="combo-mapa">
          {note && <div class={"p-nota " + note.kind} style={{ margin: "0 0 8px" }}>{note.text}</div>}
          {/* O mapa é o que salva a hora de separar a pilha depois do corte:
              uma folha pode ter carta de dois clientes. */}
          {map?.map((m) => (
            <div>
              <b>#{m.id}</b> {m.customer_name || "(sem nome)"} — {Number(m.cartas)} carta(s),{" "}
              {m.primeira_pagina === m.ultima_pagina
                ? `folha ${m.primeira_pagina}` : `folhas ${m.primeira_pagina}–${m.ultima_pagina}`}{" "}
              (posições {Number(m.inicio)}–{Number(m.fim)} da fila)
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
