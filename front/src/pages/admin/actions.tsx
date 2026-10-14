/* O que os botões do painel fazem. Cada ação fala com a API, anota o
   resultado (na nota do pedido, na barra de combinar ou no topo do estoque)
   e manda o Query reler o que mudou. Erro 401 não vira nota: a tela já
   voltou pra entrada (ver `adminApi`). */
import { useQueryClient } from "@tanstack/preact-query";
import { adminApi, form, isUnauthorized } from "./adminApi";
import { int, fieldDecimal } from "./format";
import { localSummary, selectionKey } from "./preview";
import { followQueue, queueResult } from "./queue";
import { stockQuery } from "./queries";
import {
  combo, comboMap, comboNote, dropNote, markedOrders, note, openModal, selected,
  stockNote, token, topError, whileBusy,
} from "./store";
import type { Combo, Order, QueueState, Stock } from "./types";

const message = (e: unknown) => (e as Error).message;

/* Campos "cor.campo" do modal viram {cor: {campo: valor}}. */
export function byColor(values: Record<string, string>) {
  const out: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(values)) {
    const [color, field] = key.split(".");
    (out[color] ??= {})[field] = value;
  }
  return out;
}

export function useAdminActions() {
  const qc = useQueryClient();
  const reload = () => qc.invalidateQueries({ queryKey: ["admin", token.value] });

  /* --------------------------------------------------------- pedidos */

  async function changeStatus(p: Order, status: string, done: string) {
    try {
      await adminApi(`/admin/pedidos/${p.id}/status`, { method: "POST", body: form({ status }) });
      note(p.id, "ok", done);
      await reload();
    } catch (e) {
      if (!isUnauthorized(e)) note(p.id, "erro", message(e));
    }
  }

  function confirmPrint(p: Order) {
    openModal({
      title: "Imprimir agora?",
      text: <>Isso confirma o Pix do pedido <b>#{p.id}</b> ({p.customer_name},{" "}
        {p.pages} página(s)) e põe a folha na fila da impressora. Confira o Pix no
        app do banco antes.</>,
      ok: "Imprimir",
      onConfirm: () => whileBusy(async () => {
        note(p.id, "andando", "Pondo na fila…");
        try {
          const r = await adminApi<{ mensagem: string }>(`/admin/pedidos/${p.id}/imprimir`, { method: "POST" });
          note(p.id, "andando", r.mensagem);
          const state = await followQueue(
            () => adminApi<QueueState>(`/admin/pedidos/${p.id}`),
            (s) => note(p.id, "andando", s.status === "imprimindo"
              ? "A impressora pegou o pedido — montando a folha e mandando pro CUPS…"
              : r.mensagem));
          const end = queueResult(state);
          note(p.id, end.kind, end.text);
          await reload();
        } catch (e) {
          if (!isUnauthorized(e)) note(p.id, "erro", message(e));
        }
      }),
    });
  }

  function confirmDelete(p: Order) {
    openModal({
      title: "Apagar de vez?",
      text: <>O pedido <b>#{p.id}</b> sai do banco junto com o XML do deck — isso
        não tem volta. Pra tirar da fila sem perder o histórico, use{" "}
        <b>Cancelar</b>. Digite o id pra confirmar:</>,
      ok: "Apagar",
      danger: true,
      confirmWith: p.id,
      onConfirm: async () => {
        try {
          await adminApi(`/admin/pedidos/${p.id}`, { method: "DELETE" });
          dropNote(p.id);
          await reload();
        } catch (e) {
          if (!isUnauthorized(e)) note(p.id, "erro", message(e));
        }
      },
    });
  }

  /* -------------------------------------------------------- combinar */

  /* Cria (ou reaproveita) a combinação no backend. Não monta PDF nenhum: só
     a conta oficial e o mapa. O mesmo conjunto sempre cai na mesma
     combinação, então isto também revalida a seleção contra o banco (pedido
     apagado, cancelado, laminação trocada) antes de liberar o Imprimir. */
  async function combine() {
    await whileBusy(async () => {
      try {
        const ids = [...selected.value];
        const c = await adminApi<Combo>("/admin/combos", { method: "POST", body: form({ ids: ids.join(",") }) });
        combo.value = { id: c.id, key: selectionKey(ids) };
        comboMap.value = c.mapa;
        comboNote.value = {
          kind: c.brancos_evitados ? "ok" : "andando",
          text: (c.brancos_evitados ? "" : "Esta seleção não aproveita nenhum " +
            "espaço em branco, mas sai tudo numa fila só. ") +
            "O worker já está montando a folha: confira no painel dele, na rede " +
            "de casa, antes de imprimir. Cada folha sai com uma legenda na margem " +
            "dizendo de quem é cada carta.",
        };
      } catch (e) {
        if (!isUnauthorized(e)) comboNote.value = { kind: "erro", text: message(e) };
      }
    });
  }

  function confirmComboPrint() {
    const list = markedOrders.value;
    const summary = localSummary(list);
    openModal({
      title: "Imprimir a folha combinada?",
      text: <>Isso confirma o Pix de <b>todos</b> estes pedidos e põe{" "}
        {summary.combined} folha(s) na fila da impressora:{" "}
        {list.map((p, i) => <>{i > 0 && ", "}<b>#{p.id}</b> {p.customer_name}</>)}.
        As cartas saem misturadas no mesmo papel, então não dá pra imprimir só
        uma parte — confira o Pix de cada um antes.</>,
      ok: "Imprimir tudo",
      onConfirm: () => whileBusy(async () => {
        const id = combo.value!.id;
        comboNote.value = { kind: "andando", text: "Pondo na fila…" };
        try {
          const r = await adminApi<{ mensagem: string }>(`/admin/combos/${id}/imprimir`, { method: "POST" });
          comboNote.value = { kind: "andando", text: r.mensagem };
          const state = await followQueue(
            () => adminApi<QueueState>(`/admin/combos/${id}`),
            (s) => { comboNote.value = { kind: "andando", text: s.status === "imprimindo"
              ? "A impressora pegou a folha — montando e mandando pro CUPS…" : r.mensagem }; });
          comboNote.value = queueResult(state);
          await reload();
        } catch (e) {
          if (!isUnauthorized(e)) comboNote.value = { kind: "erro", text: message(e) };
        }
      }),
    });
  }

  /* -------------------------------------------------------- baralhos */

  function confirmDeleteDeck(id: string, name: string) {
    openModal({
      title: "Apagar este baralho?",
      // O deck é da pessoa que montou, não do sistema: ela não é avisada, e o
      // link que ela guardou simplesmente para de abrir. Isso precisa estar
      // escrito na hora de clicar, não descoberto depois.
      text: <><b>{name}</b> some do banco pra sempre. Quem montou não é avisado —
        o link dela apenas para de abrir, e não há como desfazer.<br /><br />
        Digite o id <b>{id}</b> pra confirmar.</>,
      ok: "Apagar",
      danger: true,
      confirmWith: id,
      onConfirm: async () => {
        try {
          await adminApi(`/decks/${encodeURIComponent(id)}`, { method: "DELETE" });
          topError.value = "";
          await reload();
        } catch (e) {
          if (!isUnauthorized(e)) topError.value = "Não consegui apagar: " + message(e);
        }
      },
    });
  }

  /* --------------------------------------------------------- estoque */

  async function saveStock(url: string, values: unknown, done: string) {
    try {
      const stock = await adminApi<Stock>(url, { body: values });
      qc.setQueryData(stockQuery(token.value).queryKey, stock);
      stockNote.value = { kind: "ok", text: done };
    } catch (e) {
      if (!isUnauthorized(e)) stockNote.value = { kind: "erro", text: message(e) };
    }
  }

  function stockAction(stock: Stock, action: string, itemId?: string) {
    const item = stock.itens.find((i) => i.id === itemId);
    const cfg = stock.config;
    if (action === "entrada" && item) {
      openModal({
        title: `Entrada — ${item.nome}`,
        text: `Quantas ${item.unidade} chegaram e quanto custou a compra.`,
        fields: [
          { name: "quantidade", label: "Quantidade", mode: "numeric" },
          { name: "valor_pago", label: "Valor pago (R$, opcional)", mode: "decimal" },
        ],
        ok: "Somar ao estoque",
        onConfirm: (v) => saveStock(`/admin/estoque/${item.id}/entrada`, v,
          `Entrada de ${v.quantidade} em ${item.nome}.`),
      });
    } else if (action === "contagem" && item) {
      openModal({
        title: `Contagem — ${item.nome}`,
        text: <>O estoque marca <b>{int(item.quantidade)}</b>. Quantas {item.unidade} há de fato?</>,
        fields: [{ name: "quantidade", label: "Contado", mode: "numeric",
                   value: String(Math.max(0, item.quantidade)) }],
        ok: "Salvar contagem",
        onConfirm: (v) => saveStock(`/admin/estoque/${item.id}/contagem`, v,
          `${item.nome} passou a ${v.quantidade}.`),
      });
    } else if (action === "ajustes" && item) {
      openModal({
        title: item.nome,
        fields: [
          { name: "minimo", label: "Avisar quando chegar a", mode: "numeric", value: String(item.minimo || 0) },
          { name: "custo_unitario", label: "Preço por unidade (R$)", mode: "decimal",
            value: fieldDecimal(item.custo_unitario) },
        ],
        ok: "Salvar",
        onConfirm: (v) => saveStock(`/admin/estoque/${item.id}/ajustes`, v, `${item.nome} atualizado.`),
      });
    } else if (action === "custos") {
      const pair = (key: string, label: string) => [
        { name: `preco_${key}`, label: `${label} — R$ por página`, mode: "decimal" as const,
          value: fieldDecimal(cfg[`preco_${key}`]) },
        { name: `folhas_por_plastico_${key}`, label: `${label} — folhas por plástico`,
          mode: "numeric" as const, value: String(cfg[`folhas_por_plastico_${key}`]) },
      ];
      openModal({
        title: "Preço e plástico",
        text: "O preço novo vale para os próximos pedidos.",
        columns: 2,
        fields: [...pair("um_lado", "Um lado"), ...pair("dois_lados", "Dois lados"), ...pair("foil", "Foil")],
        ok: "Salvar",
        onConfirm: (v) => saveStock("/admin/estoque/custos", v, "Preço e plástico atualizados."),
      });
    } else if (action === "tinta-precos") {
      openModal({
        title: "Garrafas de tinta",
        columns: 2,
        fields: stock.tintas.flatMap((t) => [
          { name: `${t.cor}.preco_garrafa`, label: `${t.nome} — garrafa (R$)`, mode: "decimal" as const,
            value: fieldDecimal(t.preco_garrafa) },
          { name: `${t.cor}.ml_garrafa`, label: `${t.nome} — ml`, mode: "decimal" as const,
            value: fieldDecimal(t.ml_garrafa) },
        ]),
        ok: "Salvar",
        onConfirm: (v) => saveStock("/admin/estoque/tinta", byColor(v), "Garrafas atualizadas."),
      });
    } else if (action === "tinta-consumo") {
      openModal({
        title: "Consumo por folha",
        text: "ml de cada cor numa folha de cartas.",
        columns: 2,
        fields: stock.tintas.map((t) => ({ name: `${t.cor}.ml_por_folha`, label: `${t.nome} — ml`,
          mode: "decimal" as const, value: fieldDecimal(t.ml_por_folha) })),
        ok: "Salvar",
        onConfirm: (v) => saveStock("/admin/estoque/tinta", byColor(v), "Consumo atualizado."),
      });
    }
  }

  return { changeStatus, confirmPrint, confirmDelete, combine, confirmComboPrint,
           confirmDeleteDeck, stockAction };
}
