/* A conta de quem está na tela, pelo cache do Query.

   `GET /conta` responde 200 com `{"usuario": null}` pra anônimo (ver
   `conta_atual` no `main.py`), então "sem conta" é dado, não erro. */
import { queryOptions, useMutation, useQuery } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { api } from "./api";

export type User = { id?: number; login: string; nome: string; [k: string]: unknown };

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
    mutationFn: () => api("/conta/sair", { method: "POST" }),
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
