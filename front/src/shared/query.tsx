/* O TanStack Query de todas as telas.

   Cada tela monta com `mount()`, que já põe o `QueryClientProvider` em volta:
   o que é dado do servidor (conta, decks, pedidos) mora no cache do Query, e
   o estado só da tela (campo digitado, botão armado) continua no componente.

   Uma tentativa a mais, e não três: erro de rede aqui quase sempre é o
   servidor fora do ar, e insistir só atrasa a mensagem que diz isso. */
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { render } from "preact";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1 },
      mutations: { retry: false },
    },
  });
}

export function mount(app: ComponentChildren, el = document.getElementById("app")!) {
  render(
    <QueryClientProvider client={createQueryClient()}>{app}</QueryClientProvider>,
    el,
  );
}
