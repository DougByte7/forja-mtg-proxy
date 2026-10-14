/* "Meus Pedidos": o que este navegador já pediu (ver `myOrders.ts`). */
import { useEffect, useState } from "preact/hooks";
import { api } from "../../shared/api";
import { copyText } from "../../shared/clipboard";
import {
  forgetOrder, readableDate, readOrders, refreshStatuses, setOrderStatus, stateInfo,
  type SavedOrder,
} from "./myOrders";
import { CardList, SheetPages } from "./Sheet";
import { catalogFrom, sheetGroups } from "./sheet";
import { NOTIFY_LABEL, reason } from "./Summary";
import { bumpOrders, ordersMessage, ordersOpen, ordersVersion, selectedOrder } from "./store";
import { brl } from "./totals";
import { useFlash } from "./useFlash";
import { parseSlots } from "./xml";

const say = (text: string, tone?: "bom" | "ruim") => { ordersMessage.value = { text, tone }; };
const plural = (n: number, one: string, many: string) => <><b>{n}</b> {n === 1 ? one : many}</>;

export function MyOrdersModal() {
  const open = ordersOpen.value;
  ordersVersion.value;   // relê a lista guardada quando ela muda
  const list = readOrders();
  const current = list.find((p) => p.id === selectedOrder.value) || null;
  const [armedForget, setArmedForget] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const saved = readOrders();
    if (!saved.some((p) => p.id === selectedOrder.value)) selectedOrder.value = saved[0]?.id ?? null;
    say("");
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") ordersOpen.value = false; };
    document.addEventListener("keydown", onKey);
    // O andamento vem depois da tela aparecer: a lista guardada já mostra o
    // pedido na hora, e só redesenha se algo tiver mudado.
    const before = JSON.stringify(saved.map((p) => [p.id, p.status]));
    refreshStatuses(saved.map((p) => p.id)).then(() => {
      if (JSON.stringify(readOrders().map((p) => [p.id, p.status])) !== before) bumpOrders();
    });
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function select(id: string) {
    selectedOrder.value = id;
    setArmedForget(null);
    say("");
  }

  function askToForget(id: string) {
    if (armedForget !== id) {
      setArmedForget(id);
      say("Clique no ✕ de novo pra tirar esse pedido da lista. Ele some só daqui — não é cancelamento.");
      return;
    }
    setArmedForget(null);
    const rest = forgetOrder(id);
    if (selectedOrder.value === id) selectedOrder.value = rest[0]?.id ?? null;
    bumpOrders();
    say("Pedido tirado da lista deste navegador.");
  }

  return (
    <div class={"modal" + (open ? " show" : "")} role="dialog" aria-modal="true" aria-labelledby="ordersTitle"
         onClick={(e) => { if (e.target === e.currentTarget) ordersOpen.value = false; }}>
      <div class="modal-box">
        <div class="modal-head">
          <h2 id="ordersTitle">Meus Pedidos
            <span class="sub">Ficam guardados só neste navegador. Escolha um pedido pra ver as cartas e o andamento.</span>
          </h2>
          <button class="icon-btn" title="Fechar (Esc)" onClick={() => { ordersOpen.value = false; }}>✕</button>
        </div>

        {open && (
          <div class="modal-body">
            <div class="deck-pane">
              <p class="pane-title">Pedidos guardados</p>
              <div>
                {!list.length && <p class="od-vazio">Nenhum pedido guardado neste navegador.</p>}
                {list.map((o) => {
                  const info = stateInfo(o.status);
                  const sel = o.id === selectedOrder.value;
                  return (
                    <div class={"oi" + (sel ? " sel" : "")} key={o.id}>
                      <button type="button" class="oi-open" aria-pressed={sel} onClick={() => select(o.id)}>
                        <div class="oi-info">
                          <div class="oi-name">{o.nome || "Pedido"}</div>
                          <div class="oi-meta">{readableDate(o.criado_em)} · R$ {brl(o.valor)} · {o.qty}
                            {o.qty === 1 ? " carta" : " cartas"}</div>
                        </div>
                        <span class={"chip " + info.cls}>{info.label}</span>
                      </button>
                      <button type="button" class="oi-del" onClick={() => askToForget(o.id)}
                              title="Tirar da lista deste navegador (não cancela o pedido)"
                              aria-label="Tirar da lista deste navegador (não cancela o pedido)">✕</button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div class="sheet-pane">
              <OrderDetail key={current?.id ?? ""} order={current} />
            </div>
          </div>
        )}

        <OrdersFoot key={current?.id ?? ""} order={current} />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: preact.ComponentChildren }) {
  return <div class="receipt-row"><span>{label}</span><b>{value}</b></div>;
}

function OrderDetail({ order: o }: { order: SavedOrder | null }) {
  const [copyLabel, flash] = useFlash("Copiar Pix Copia e Cola");
  if (!o) return <p class="od-vazio">Escolha um pedido na lista pra ver as cartas e o andamento.</p>;

  const info = stateInfo(o.status);
  let slots: ReturnType<typeof parseSlots>["slots"] = [];
  try { slots = parseSlots(o.xml || "").slots; } catch { slots = []; }

  return (
    <div>
      <div class="od-topo">
        <span class={"chip " + info.cls}>{info.label}</span>
        <span class="od-quando">{readableDate(o.criado_em)}</span>
      </div>
      <p class={"od-recado" + (info.cls === "pago" ? " bom" : "")
                + (o.status === "cancelado" || o.status === "sumiu" ? " ruim" : "")}>{info.message}</p>
      <div class="od-dados">
        <Row label="Pedido de" value={o.nome} />
        <Row label="Cartas" value={o.qty} />
        {!!o.backs && <Row label="Versos próprios (dupla-face)" value={o.backs} />}
        <Row label="Páginas" value={o.pages} />
        {!!o.blanks && <Row label="Espaços livres na última página" value={o.blanks} />}
        <Row label="Laminação" value={o.lamLabel} />
        <Row label="Código do pedido" value={o.deck_hash} />
        <Row label="Total" value={"R$ " + brl(o.valor)} />
      </div>

      {/* O QR só faz sentido enquanto ninguém avisou nada: depois do aviso o
          Pix já foi pago, e mostrar o código de novo é convite pra pagar duas. */}
      {o.status === "pending" && (o.qr || o.pix) && (
        <div class="od-pix">
          {o.qr && <img src={"data:image/png;base64," + o.qr} alt="QR code Pix deste pedido" />}
          <p>Valor desta cobrança: R$ {brl(o.valor)}</p>
          {o.pix && (
            <button type="button" class="sec-btn" title="Copiar o código Pix deste pedido"
                    onClick={async () => flash((await copyText(o.pix)) ? "Copiado!" : "Selecione o código e copie")}>
              {copyLabel}</button>
          )}
        </div>
      )}

      <p class="pane-title">Cartas do pedido</p>
      {!slots.length ? (
        <p class="od-vazio">Não consegui reler as cartas guardadas deste pedido — os números acima continuam valendo.</p>
      ) : (
        <>
          {/* As mesmas linhas da revisão, sem os + e −: aqui o pedido já
              virou cobrança, então não há mais o que ajustar. */}
          <div><CardList groups={sheetGroups(slots, catalogFrom([]))} /></div>
          <p class="pane-title">Como sai na folha</p>
          <div><SheetPages slots={slots} /></div>
        </>
      )}
    </div>
  );
}

/* As duas ações só aparecem em 'pending' — ou seja, enquanto ninguém do
   outro lado ficou sabendo do pedido. Depois do aviso, quem mexe sou eu. */
function OrdersFoot({ order: o }: { order: SavedOrder | null }) {
  const [busy, setBusy] = useState<"" | "notify" | "cancel">("");
  const [cancelArmed, setCancelArmed] = useState(false);
  const msg = ordersMessage.value;

  async function run(kind: "notify" | "cancel") {
    if (!o) return;
    if (kind === "cancel" && !cancelArmed) {
      // Cancelar não tem volta e some com a cobrança, então pede dois
      // cliques — o primeiro só troca o rótulo e explica o que vai acontecer.
      setCancelArmed(true);
      say("Isso não tem volta: pra pedir de novo é montar o pedido do começo. Não pague o Pix depois de cancelar.");
      return;
    }
    setBusy(kind);
    say("");
    let text = "", tone: "bom" | "ruim" = "bom";
    try {
      const path = kind === "notify" ? "notify-payment" : "cancel";
      const data = await api<{ message?: string }>(`/orders/${encodeURIComponent(o.id)}/${path}`, { method: "POST" });
      text = data?.message || (kind === "notify" ? "Aviso enviado." : "Pedido cancelado.");
      if (kind === "cancel") setOrderStatus(o.id, "cancelado");
    } catch (e) {
      tone = "ruim";
      const r = reason(e);
      text = kind === "notify"
        ? "Não deu pra enviar o aviso." + (r ? " " + r : "")
          + " Tenta de novo em instantes — se insistir, me chama pelo contato de sempre."
        : "Não deu pra cancelar." + (r ? " " + r : "") + " Tenta de novo em instantes.";
    }
    await refreshStatuses([o.id]);
    setBusy("");
    setCancelArmed(false);
    bumpOrders();
    say(text, tone);
  }

  const pending = o?.status === "pending";
  return (
    <div class="modal-foot">
      <div class="foot-sum">
        {o && (
          <>
            <div>{plural(o.qty, "carta", "cartas")} · {plural(o.pages, "página", "páginas")}
              {" · "}<span class="price">R$ {brl(o.valor)}</span></div>
            <div>{o.lamLabel} · {o.deck_hash}</div>
          </>
        )}
      </div>
      {pending && (
        <button class="perigo-btn" disabled={!!busy} onClick={() => run("cancel")}>
          {busy === "cancel" ? "Cancelando..." : cancelArmed ? "Confirmar cancelamento" : "Cancelar pedido"}</button>
      )}
      {pending && (
        <button class="confirm-btn" disabled={!!busy} onClick={() => run("notify")}>
          {busy === "notify" ? "Enviando aviso..." : NOTIFY_LABEL}</button>
      )}
      <p class="foot-msg" style={{ color: msg.tone === "ruim" ? "var(--red)" : msg.tone === "bom" ? "var(--green)" : "" }}>
        {msg.text}</p>
    </div>
  );
}
