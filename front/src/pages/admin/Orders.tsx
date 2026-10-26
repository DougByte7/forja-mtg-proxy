import type { useAdminActions } from "./actions";
import { money, when } from "./format";
import { IN_QUEUE } from "./queue";
import { LAMINATION, ORDER_STATES } from "./states";
import { notes, selected, statusFilter, toggleSelected } from "./store";
import type { Order, OrderList } from "./types";

type Actions = ReturnType<typeof useAdminActions>;

export function OrderFilters({ counts }: { counts: OrderList["contagem"] }) {
  const chips: [string, string, number | undefined][] = [
    ["", "Todos", counts.total],
    ["notified", "Avisou que pagou", counts.notified],
    ["pending", "Aguardando", counts.pending],
    ["fila", "Na fila", (counts.a_imprimir || 0) + (counts.imprimindo || 0)],
    ["erro_impressao", "Erro na impressão", counts.erro_impressao],
    ["impresso", "Impressos", counts.impresso],
    ["cancelado", "Cancelados", counts.cancelado],
  ];
  return (
    <>
      {chips.map(([value, name, n]) => (
        <button class={"chip" + (value === statusFilter.value ? " ativo" : "")}
                onClick={() => { statusFilter.value = value; }}>
          {name}<span class="n">{n || 0}</span>
        </button>
      ))}
    </>
  );
}

export function OrdersList({ orders, search, actions }:
  { orders: Order[]; search: string; actions: Actions }) {
  if (!orders.length) {
    return <div class="vazio">{search ? `Nenhum pedido casa com "${search}".` : "Nenhum pedido por aqui."}</div>;
  }
  return <>{orders.map((p) => <OrderCard key={p.id} order={p} actions={actions} />)}</>;
}

function OrderCard({ order: p, actions }: { order: Order; actions: Actions }) {
  const marked = selected.value.has(p.id);
  const n = notes.value[p.id];
  const sep = <span class="sep">|</span>;
  return (
    <div class={`pedido ${p.status}${marked ? " marcado" : ""}`}>
      <div class="p-topo">
        {/* Cancelado não entra em folha combinada: o operador já disse que
            aquele pedido não vai acontecer, e o backend recusa de qualquer jeito. */}
        {p.status !== "cancelado" && (
          <input type="checkbox" class="marcar" checked={marked}
                 title="Combinar este pedido com outros numa folha só"
                 aria-label={`Combinar o pedido de ${p.customer_name || p.id}`}
                 onChange={(e) => toggleSelected(p.id, e.currentTarget.checked)} />
        )}
        <span class="p-nome">{p.customer_name || "(sem nome)"}</span>
        <span class={`pill ${p.status}`}>{ORDER_STATES[p.status] || p.status}</span>
        <span class="p-valor">{money(p.amount)}</span>
      </div>
      <div class="p-meta">
        <b>#{p.id}</b>{sep}deck {p.deck_hash || "?"}{sep}{Number(p.qty)} carta(s)
        {sep}{Number(p.pages)} pág.{sep}{LAMINATION[p.lamination] || p.lamination}
        {/* O Pix que chega é a soma dos dois: sem isto, o valor não bate
            com nenhum pedido sozinho. */}
        {p.grupo && <>{sep}<span title="Pago num Pix só com o outro pedido do grupo">
          mesmo Pix de #{p.grupo}{p.grupo === p.id ? " (este + foil)" : ""}</span></>}<br />
        criado {when(p.created_at)}
        {p.notified_at && <>{sep}avisou {when(p.notified_at)}</>}
        {p.impresso_em && <>{sep}impresso {when(p.impresso_em)}</>}
        {p.status === "imprimindo" && p.impressao_em &&
          <>{sep}pego pela impressora {when(p.impressao_em)}</>}
        {/* O que a impressora respondeu. No erro é o motivo; no impresso, a
            resposta do CUPS. */}
        {p.impressao_msg && (p.status === "erro_impressao" || p.status === "impresso") && (
          <div class="p-resposta">
            {(p.status === "erro_impressao" ? "Recusado: " : "") + p.impressao_msg}
          </div>
        )}
      </div>
      <OrderActions order={p} actions={actions} />
      {n && <div class={"p-nota " + n.kind}>{n.text}</div>}
    </div>
  );
}

function OrderActions({ order: p, actions: a }: { order: Order; actions: Actions }) {
  const open = p.status === "pending" || p.status === "notified";
  const reprint = ({ impresso: "Imprimir de novo", erro_impressao: "Tentar de novo" } as
    Record<string, string>)[p.status];
  const btn = (label: string, onClick: () => void, cls = "") =>
    <button class={"btn-sec" + (cls ? " " + cls : "")} onClick={onClick}>{label}</button>;
  return (
    <div class="p-acoes">
      {(open || reprint) && btn(reprint || "Imprimir", () => a.confirmPrint(p))}
      {open && btn("Marcar impresso", () => a.changeStatus(p, "impresso",
        "Marcado como impresso, sem passar pela fila."))}
      {open && btn("Cancelar", () => a.changeStatus(p, "cancelado", "Pedido cancelado."), "perigo")}
      {/* Na fila, o pedido é do worker. Tirar de lá é voltar pra "avisou que
          pagou"; e um `imprimindo` que não sai do lugar (o worker caiu no
          meio) nunca volta pra fila sozinho, porque o CUPS pode já ter
          aceitado — quem sabe se saiu no papel é quem está do lado da
          impressora. */}
      {IN_QUEUE.has(p.status) && btn("Tirar da fila", () => a.changeStatus(p, "notified",
        "Saiu da fila de impressão."))}
      {(p.status === "imprimindo" || p.status === "erro_impressao") &&
        btn("Saiu no papel", () => a.changeStatus(p, "impresso", "Marcado como impresso."))}
      {(p.status === "impresso" || p.status === "erro_impressao" || p.status === "cancelado") &&
        btn(p.status === "cancelado" ? "Reabrir" : "Voltar pra pendente",
            () => a.changeStatus(p, "pending", "Voltou pra aguardando pagamento."))}
      {btn("Apagar", () => a.confirmDelete(p), "perigo")}
    </div>
  );
}
