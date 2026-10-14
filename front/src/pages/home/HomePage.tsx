import { useQuery } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
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
          <OrderForm />
          <Summary />
        </div>
      </div>
      <ReviewModal />
      <MyOrdersModal />
    </>
  );
}
