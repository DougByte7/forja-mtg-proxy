import { useQuery } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { canOrder, useCurrentUser } from "../../shared/account";
import { Header } from "./Header";
import { MyOrdersModal } from "./MyOrdersModal";
import { OrderForm } from "./OrderForm";
import { pricesQuery } from "./queries";
import { ReviewModal } from "./ReviewModal";
import { prices } from "./store";
import { Summary } from "./Summary";
import { DEFAULT_PRICES } from "./totals";

export function HomePage() {
  // Os preços nascem com o padrão e passam a ser os que `POST /orders` cobra
  // assim que `GET /precos` responde. Falhou, fica o padrão: o valor da
  // cobrança vem do servidor de qualquer jeito.
  const p = useQuery(pricesQuery).data;
  useEffect(() => {
    if (!p) return;
    prices.value = {
      single: typeof p.single === "number" ? p.single : DEFAULT_PRICES.single,
      double: typeof p.double === "number" ? p.double : DEFAULT_PRICES.double,
      foil: typeof p.foil === "number" ? p.foil : DEFAULT_PRICES.foil,
    };
  }, [p]);

  return (
    <>
      <div class="wrap">
        <Header />
        <div class="card">
          <OrderGate />
        </div>
      </div>
      <ReviewModal />
      <MyOrdersModal />
    </>
  );
}

/* Pedido é só pra amigo do grupo (`exige_amigo` no servidor). A tela não
   mostra formulário que o servidor recusaria: diz a quem chegou aqui o que
   falta — entrar, ou falar com o dono. */
function OrderGate() {
  const { data: user, isPending } = useCurrentUser();
  if (isPending) return <p class="gate">Carregando…</p>;
  if (canOrder(user)) return <><OrderForm /><Summary /></>;
  if (!user) {
    return (
      <div class="gate">
        <h2>Entre pra fazer pedido</h2>
        <p>Pedido de impressão é só pra quem é do grupo, com conta.</p>
        <a class="btn-gate" href={"/entrar?voltar=" + encodeURIComponent(location.pathname + location.search)}>
          Entrar</a>
      </div>
    );
  }
  return (
    <div class="gate">
      <h2>Pedido é só pra amigos do grupo</h2>
      <p>Sua conta monta e guarda baralhos à vontade, mas imprimir é um favor
        pro grupo de jogo, não uma loja. Se você é do grupo, fale com o dono
        da Forja pra liberar sua conta.</p>
      <a class="btn-gate" href="/">Voltar pros meus decks</a>
    </div>
  );
}
