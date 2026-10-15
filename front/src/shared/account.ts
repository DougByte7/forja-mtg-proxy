/* A conta de quem está na tela, pelo cache do Query.

   `GET /conta` responde 200 com `{"usuario": null}` pra anônimo (ver
   `conta_atual` no `main.py`), então "sem conta" é dado, não erro. */
import { queryOptions, useMutation, useQuery } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { api } from "./api";
import { signOutClerk } from "./clerk";

export type User = {
  id?: string; login: string; nome: string; perfil?: string; [k: string]: unknown;
};

/** Quem pode fazer pedido de impressão: amigo do grupo e o admin. A mesma
    regra do `exige_amigo` do servidor — aqui é só pra a tela não oferecer o
    que o servidor vai recusar. */
export function canOrder(user: User | null | undefined): boolean {
  return user?.perfil === "amigo" || user?.perfil === "admin";
}

export const currentUserQuery = queryOptions({
  queryKey: ["conta"],
  queryFn: async () =>
    (await api<{ usuario: User | null }>("/conta", { noStore: true })).usuario ?? null,
  staleTime: 60_000,
});

export function useCurrentUser() {
  return useQuery(currentUserQuery);
}

/** Sair recarrega a página: tudo que a tela mostra muda com a conta. */
export function useLogout() {
  return useMutation({
    mutationFn: signOutClerk,
    onSettled: () => location.reload(),
  });
}

/* Telas de entrar e criar conta: quem já está logado não tem o que fazer
   ali. Acontece com quem clica "Entrar" num cabeçalho desatualizado, ou volta
   pelo histórico. Sem rede, a tela continua — é o lugar certo pra estar. */
export function useLeaveIfLoggedIn(target: string) {
  const { data: user } = useCurrentUser();
  useEffect(() => {
    if (user) location.replace(target);
  }, [user]);
}
