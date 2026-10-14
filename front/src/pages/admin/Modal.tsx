/* A confirmação. Uma caixa só, reaproveitada: imprimir e apagar são as
   ações que não dá pra desfazer, e os ajustes de estoque usam a mesma caixa
   com campos. */
import { useEffect, useRef, useState } from "preact/hooks";
import { closeModal, modal, type ModalSpec } from "./store";

export function Modal() {
  const spec = modal.value;
  return (
    <div class={"modal" + (spec ? " show" : "")}
         onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      {spec && <ModalBox key={spec.seq} spec={spec} />}
    </div>
  );
}

function ModalBox({ spec }: { spec: ModalSpec }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries((spec.fields ?? []).map((f) => [f.name, f.value ?? ""])));
  const [typed, setTyped] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  // Com campo de confirmação o botão nasce travado: apagar não pode ser um
  // clique só, ainda mais numa lista onde as linhas são parecidas.
  const locked = !!spec.confirmWith && typed.trim() !== spec.confirmWith;

  useEffect(() => {
    const first = box.current?.querySelector("input");
    if (first) { first.focus(); first.select(); }
    else okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function confirm() {
    if (locked) return;
    const trimmed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
    closeModal();
    spec.onConfirm(trimmed);
  }

  // Enter num campo vale como clique — mas só com o botão destravado, senão
  // o Enter viraria o atalho pra apagar sem conferir.
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
  };

  return (
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modalTitulo" ref={box}>
      <h3 id="modalTitulo">{spec.title}</h3>
      {spec.text && <p>{spec.text}</p>}
      <div id="modalCampos" class={spec.columns === 2 ? "grade" : ""}>
        {(spec.fields ?? []).map((f) => (
          <label class="modal-campo" key={f.name}>
            <span class="rotulo">{f.label}</span>
            <input type="text" name={f.name} inputMode={f.mode ?? "text"} autocomplete="off"
                   value={values[f.name]} onKeyDown={enter}
                   onInput={(e) => {
                     const v = e.currentTarget.value;
                     setValues((old) => ({ ...old, [f.name]: v }));
                   }} />
          </label>
        ))}
      </div>
      {spec.confirmWith && (
        <input type="text" id="modalInput" autocomplete="off" aria-label="Confirmação"
               value={typed} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={enter} />
      )}
      <div class="modal-acoes">
        <button class="btn-sec" onClick={closeModal}>Voltar</button>
        <button class={"btn-confirma" + (spec.danger ? " perigo" : "")} ref={okRef}
                disabled={locked} onClick={confirm}>{spec.ok}</button>
      </div>
    </div>
  );
}
