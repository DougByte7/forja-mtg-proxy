/* O resumo do pedido, as ações e a cobrança Pix. */
import { useMutation } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { api, ApiError } from "../../shared/api";
import { copyText } from "../../shared/clipboard";
import { saveOrder, setOrderStatus } from "./myOrders";
import { QuoteBox, QuoteControls, useStartQuote } from "./Quote";
import {
  bumpOrders, charge, chargeError, chargeExpired, chargeValid, declared, edited, foilPart, openReview,
  slots, summary, xmlText, type Charge, type ChargedOrder, type Totals,
} from "./store";
import { brl, cardsPerPage, LAMINATION_LABELS, type Lamination } from "./totals";
import { useFlash } from "./useFlash";

export const NOTIFY_LABEL = "Pagamento realizado, enviar notificação";

/** Só o que o cliente pode resolver chega até a tela: a frase do servidor,
    ou nada. Detalhe técnico não ajuda quem está tentando pagar. */
export const reason = (e: unknown) => e instanceof ApiError ? e.detail : "";

export function Summary() {
  const s = summary.value;
  const startQuote = useStartQuote();

  /* Trava do botão de cobrança: só libera com a declaração marcada E com um
     pedido válido na tela. É trava de TELA — a rota POST /orders continua
     aberta pra quem chamar direto. O que ela resolve é o caso real: alguém
     que caiu aqui por acaso, achou que é loja, e ia clicar em "Gerar
     cobrança" sem ler o aviso vermelho lá em cima. */
  const createCharge = useMutation({
    mutationFn: async () => {
      if (s.kind !== "ok") return;
      chargeError.value = "";
      const form = new FormData();
      form.append("xml_file", new Blob([xmlText.value], { type: "text/xml" }), "pedido.xml");
      form.append("lamination", s.lam);
      form.append("customer_name", s.name);
      const fp = foilPart.value;
      if (fp) form.append("xml_foil", new Blob([fp.xml], { type: "text/xml" }), "foil.xml");
      const data = await api<Omit<Charge, "signature">>("/orders", { body: form });
      charge.value = { ...data, signature: s.signature };
      // A partir daqui esse pedido existe no servidor com um id que só este
      // navegador conhece. Guardar agora é o que permite voltar depois pra
      // ver o andamento, avisar o pagamento ou desistir. No pedido misto
      // são dois, com o mesmo Pix: cada um guarda o grupo e o valor dele.
      const parts: ChargedOrder[] = data.pedidos?.length ? data.pedidos : [{
        order_id: data.order_id, deck_hash: data.deck_hash, lamination: s.lam, amount: data.amount,
        qty: s.qty, backs_count: s.backsCount, pages: s.pages, blanks: s.blanks }];
      const group = parts.length > 1 ? { grupo: data.order_id, grupoValor: data.amount } : {};
      // Ao contrário, pra o padrão ficar em cima na lista (a mais nova primeiro).
      [...parts].reverse().forEach((o) => saveOrder({
        id: o.order_id, deck_hash: o.deck_hash, nome: s.name, valor: o.amount,
        qty: o.qty, backs: o.backs_count, pages: o.pages, blanks: o.blanks, lam: o.lamination,
        lamLabel: LAMINATION_LABELS[o.lamination] || o.lamination,
        xml: o.lamination === "foil" && fp ? fp.xml : xmlText.value, pix: data.pix_copia_cola,
        qr: data.pix_qr_base64, status: "pending", criado_em: Date.now(), ...group,
      }));
      bumpOrders();
    },
    onError: (e) => {
      const r = reason(e);
      chargeError.value = r ? r + " Ajuste e tente de novo."
        : "Não deu pra gerar a cobrança agora. Tente de novo em instantes.";
    },
  });

  if (s.kind !== "ok") return <div class="result" />;

  const badge = chargeExpired.value ? "O pedido mudou — gere a cobrança de novo."
    : edited.value ? "Pedido revisado" : "";

  return (
    <div class="result show">
      <div class="perf"><span>RESUMO DO PEDIDO</span></div>

      <div class="receipt-row"><span>Pedido de</span><b>{s.name}</b></div>
      {s.foil ? (
        <>
          <PartRows title="Pedido 1 · Padrão" lam={s.lam} qty={s.qty} backs={s.backsCount} t={s} />
          <PartRows title="Pedido 2 · ✦ Foil" lam="foil" qty={s.foil.qty} backs={s.foil.backsCount} t={s.foil} />
        </>
      ) : <PartRows lam={s.lam} qty={s.qty} backs={s.backsCount} t={s} />}

      <div class="total-row">
        <span class="label">TOTAL</span>
        <span class="value">R$ {brl(s.grandTotal)}</span>
      </div>
      {s.foil && <p class="note total-nota">Dois pedidos, um Pix só: cada um vai pro seu papel.</p>}

      <div class="actions">
        <button class="review-btn" disabled={!slots.value.length} onClick={openReview}>
          Revisar o pedido antes de pagar</button>
        <label class={"conheco" + (declared.value ? " marcado" : "")} for="conhecoDono">
          <input type="checkbox" id="conhecoDono" checked={declared.value}
                 onChange={(e) => { declared.value = e.currentTarget.checked; }} />
          <span>Declaro que conheço o dono do sistema.</span>
        </label>
        <button class="pix-btn" disabled={!declared.value || createCharge.isPending}
                onClick={() => createCharge.mutate()}>
          {createCharge.isPending ? "Gerando cobrança..." : "Gerar cobrança Pix"}</button>
        <QuoteControls start={startQuote} />
        <div class={"review-badge" + (badge ? " show" : "") + (chargeExpired.value ? " atencao" : "")}>{badge}</div>
        {chargeError.value && <p class="note falha" style={{ display: "block" }}>{chargeError.value}</p>}
      </div>

      {/* Cotação: preço de comprar as cartas de verdade, não de imprimir. */}
      <QuoteBox starting={startQuote.isPending} />

      {chargeValid.value && <PixBox key={charge.value!.order_id} charge={charge.value!} />}
    </div>
  );
}

/* As linhas de um pedido no resumo. Com `title`, é uma parte do pedido
   misto, com o subtotal dela; sem, é o pedido sozinho, e o total diz o resto. */
function PartRows({ title, lam, qty, backs, t }:
  { title?: string; lam: Lamination; qty: number; backs: number; t: Totals }) {
  const perPage = cardsPerPage(lam);
  const foil = lam === "foil";
  return (
    <div class={title ? "parte" + (foil ? " foil" : "") : undefined}>
      {title && <div class="parte-tit">{title}</div>}
      <div class="receipt-row"><span>Cartas solicitadas</span><b>{qty}</b></div>
      {backs > 0 && (
        <div class="receipt-row" style={{ display: "flex" }}>
          <span>Versos próprios (dupla-face)</span><b>{backs}</b></div>
      )}
      <div class="receipt-row"><span>Páginas ({perPage} cartas por página)</span><b>{t.pages}</b></div>
      <div class="receipt-row">
        <span>Espaços livres na última página</span>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <b>{t.blanks}</b>
          <div class={"grid-preview" + (foil ? " foil" : "")}>
            {Array.from({ length: perPage }, (_, i) =>
              <div class={"slot " + (i < t.lastPageFilled ? "filled" : "blank")} />)}
          </div>
        </div>
      </div>
      {/* A folha foil é cara e leva só 8: vale dizer que o que sobra nela
          sai de graça. */}
      {title && foil && t.blanks > 0 && (
        <p class="parte-dica">Cabem mais {t.blanks} carta(s) foil nesta folha sem custo extra.</p>
      )}
      <div class="receipt-row"><span>Laminação</span><b>{t.lamLabel}</b></div>
      {title && <div class="receipt-row subtotal"><span>Subtotal</span><b>R$ {brl(t.total)}</b></div>}
    </div>
  );
}

function PixBox({ charge: c }: { charge: Charge }) {
  const [copyLabel, flash] = useFlash("Copiar Pix Copia e Cola");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  // Só dispara o e-mail de aviso. A conferência do Pix e a impressão
  // continuam do lado do operador, pelo link que vai nesse e-mail.
  const many = (c.pedidos?.length ?? 0) > 1;
  const notify = useMutation({
    mutationFn: () => api<{ message?: string }>(`/orders/${c.order_id}/notify-payment`, { method: "POST" }),
    onSuccess: (data) => {
      // A lista de "Meus Pedidos" acompanha — o grupo inteiro, que o aviso é um só.
      for (const o of c.pedidos?.length ? c.pedidos : [c]) setOrderStatus(o.order_id, "notified");
      bumpOrders();
      setNote({ ok: true, text: data?.message || "Aviso enviado." });
    },
    onError: (e) => {
      const r = reason(e);
      setNote({ ok: false, text: "Não deu pra enviar o aviso." + (r ? " " + r : "")
        + " Tenta de novo em instantes — se insistir, avisa direto pelo contato de sempre." });
    },
  });

  return (
    <div id="pixBox" style={{ display: "block", marginTop: "16px", paddingTop: "16px",
                              borderTop: "1px dashed var(--border)", textAlign: "center" }}>
      <img src={`data:image/png;base64,${c.pix_qr_base64}`} alt="QR code Pix"
           style={{ width: "180px", height: "180px", borderRadius: "8px", background: "#fff", padding: "8px" }} />
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "10px 0 4px" }}>Valor desta cobrança:</p>
      <p style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: "16px", color: "var(--gold-light)", margin: "0 0 6px" }}>
        R$ {brl(c.amount)}</p>
      {many && <p class="note" style={{ margin: "0 0 6px" }}>Paga os dois pedidos: o padrão e o foil.</p>}
      <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "0 0 10px" }}>
        {many ? "Códigos dos pedidos:" : "Código do pedido:"}{" "}
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: "var(--text)" }}>
          {many ? c.pedidos!.map((o) => o.deck_hash).join(" + ") : c.deck_hash}</span></p>
      <button class="sec-btn" style={{ width: "100%" }} onClick={async () =>
        flash((await copyText(c.pix_copia_cola)) ? "Copiado!" : "Selecione o código e copie")}>{copyLabel}</button>
      <button class="pix-btn" style={{ width: "100%", marginTop: "10px" }}
              disabled={notify.isPending || notify.isSuccess} onClick={() => notify.mutate()}>
        {notify.isPending ? "Enviando aviso..." : notify.isSuccess ? "Aviso enviado ✓" : NOTIFY_LABEL}</button>
      {note && <p class="note" style={{ display: "block", color: note.ok ? "var(--green)" : "var(--red)" }}>{note.text}</p>}
    </div>
  );
}
