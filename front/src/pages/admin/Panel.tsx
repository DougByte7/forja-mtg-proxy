import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useState } from "preact/hooks";
import { useAdminActions } from "./actions";
import { isUnauthorized } from "./adminApi";
import { ComboBar } from "./ComboBar";
import { DeckCount, DecksList } from "./Decks";
import { Modal } from "./Modal";
import { OrderFilters, OrdersList } from "./Orders";
import { decksQuery, ordersQuery, sessionQuery, stockQuery } from "./queries";
import {
  autoRefreshPaused, forgetToken, rememberOrders, search, statusFilter, switchTab, tab,
  token, topError, type Tab,
} from "./store";
import { StockTab } from "./Stock";
import { workerWarning } from "./worker";

const EVERY = 30_000;

export function Panel() {
  const qc = useQueryClient();
  const actions = useAdminActions();
  const t = token.value;
  const current = tab.value;
  // Atualiza sozinho só com a tela parada (ver `autoRefreshPaused`). O Query
  // já não relê com a aba do navegador escondida.
  const every = autoRefreshPaused.value ? false : EVERY;

  const sessionQ = useQuery({ ...sessionQuery(t), refetchInterval: every });
  const ordersQ = useQuery({
    ...ordersQuery(t, statusFilter.value, search.value),
    enabled: current === "pedidos", refetchInterval: every, placeholderData: keepPreviousData,
  });
  const decksQ = useQuery({
    ...decksQuery(t, search.value),
    enabled: current === "decks", refetchInterval: every, placeholderData: keepPreviousData,
  });
  // O estoque carrega na entrada mesmo fora da aba: é ele que acende o
  // "baixo" na aba. Falhar aqui não impede o resto.
  const stockQ = useQuery({ ...stockQuery(t), refetchInterval: current === "estoque" ? every : false });

  useEffect(() => {
    if (ordersQ.data) rememberOrders(ordersQ.data.pedidos);
  }, [ordersQ.data]);

  const active = { pedidos: ordersQ, decks: decksQ, estoque: stockQ }[current];
  const notice = [workerWarning(sessionQ.data), topError.value].filter(Boolean).join(" ");
  const stockLow = !!stockQ.data?.itens.some((i) => i.baixo);

  function logout() {
    forgetToken();
    qc.removeQueries({ queryKey: ["admin"] });
  }

  const tabButton = (id: Tab, label: string, badge?: preact.ComponentChildren) => (
    <button class={"aba" + (current === id ? " ativo" : "")} onClick={() => switchTab(id)}>
      {label}{badge}
    </button>
  );

  return (
    <>
      <div class="wrap">
        <header>
          <div class="brand">
            <div class="rune"><span>⛨</span></div>
            <div>
              <h1>Pedidos</h1>
              <p>Forja de Proxies — painel do operador</p>
            </div>
          </div>
          <button class="btn-sec" disabled={active.isFetching}
                  onClick={() => qc.invalidateQueries({ queryKey: ["admin", t] })}>Atualizar</button>
          <button class="btn-sec" onClick={logout}>Sair</button>
        </header>

        {notice && <div class="aviso">{notice}</div>}

        <div class="abas">
          {tabButton("pedidos", "Pedidos")}
          {tabButton("decks", "Baralhos",
            <span class="n">{decksQ.data?.contagem.total ?? ""}</span>)}
          {tabButton("estoque", "Estoque",
            <span class={"n" + (stockLow ? " alerta" : "")}>{stockLow ? "baixo" : ""}</span>)}
        </div>

        <div class="barra">
          {current === "pedidos" && ordersQ.data && <OrderFilters counts={ordersQ.data.contagem} />}
          {current === "decks" && decksQ.data && <DeckCount counts={decksQ.data.contagem} />}
        </div>
        {current !== "estoque" && <SearchBox key={current} />}

        <div>
          {active.error && !isUnauthorized(active.error) ? (
            <div class="vazio">Não consegui carregar: {active.error.message}</div>
          ) : current === "pedidos" ? (
            ordersQ.data && <OrdersList orders={ordersQ.data.pedidos} search={search.value} actions={actions} />
          ) : current === "decks" ? (
            decksQ.data && <DecksList decks={decksQ.data.decks} search={search.value} actions={actions} />
          ) : (
            stockQ.data && <StockTab stock={stockQ.data} actions={actions} />
          )}
        </div>

        <Footer tab={current} />
      </div>

      {/* A barra de combinar é dos pedidos: some junto com eles, senão fica
          uma ação de outro assunto flutuando sobre uma lista que não a entende. */}
      {current === "pedidos" && <ComboBar actions={actions} />}
      <Modal />
    </>
  );
}

/* Espera parar de digitar: cada tecla seria uma consulta ao banco. */
function SearchBox() {
  const [value, setValue] = useState(search.value);
  useEffect(() => {
    const timer = setTimeout(() => { search.value = value.trim(); }, 350);
    return () => clearTimeout(timer);
  }, [value]);
  return (
    <div class="busca-linha">
      <input type="search" value={value} aria-label="Buscar"
             placeholder={tab.value === "decks"
               ? "Buscar por nome do baralho, comandante, dono ou id"
               : "Buscar por nome, id do pedido ou código do deck"}
             onInput={(e) => setValue(e.currentTarget.value)} />
    </div>
  );
}

function Footer({ tab }: { tab: Tab }) {
  if (tab === "decks") {
    return (
      <p class="rodape">
        Todos os baralhos do banco, do mais mexido pro mais parado.<br />
        <b>Apagar</b> aqui é definitivo e não avisa quem montou — o deck é da pessoa,
        não do sistema.
      </p>
    );
  }
  if (tab === "estoque") {
    return (
      <p class="rodape">
        O material sai quando o cliente avisa que pagou e volta se o pedido for
        cancelado ou reaberto.<br />
        <b>Contagem</b> troca o saldo pelo número da prateleira.
      </p>
    );
  }
  return (
    <p class="rodape">
      <b>Imprimir</b> confirma o Pix e põe o pedido na fila da impressora — é a única ação que gasta papel.<br />
      Marque dois ou mais pedidos pra juntá-los numa folha só e aproveitar o papel.<br />
      A folha se confere no painel do worker, na rede de casa — o site não monta PDF.<br />
      Conferir o Pix no app do banco continua sendo com você.
    </p>
  );
}
