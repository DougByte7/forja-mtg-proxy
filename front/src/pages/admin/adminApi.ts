/* A API do painel: toda chamada leva o token no `X-Admin-Token`.

   401 é token trocado no .env, ou colado errado: a tela volta pra entrada em
   vez de ficar mostrando uma lista velha que não atualiza mais. Quem chama
   recebe o erro mesmo assim, e o ignora com `isUnauthorized`. */
import { api, ApiError, type ApiOptions } from "../../shared/api";
import { forgetToken, token } from "./store";

export async function adminApi<T = unknown>(url: string, opts: ApiOptions = {}): Promise<T> {
  try {
    return await api<T>(url, {
      noStore: true, ...opts, headers: { "X-Admin-Token": token.value, ...opts.headers },
    });
  } catch (e) {
    if (isUnauthorized(e)) forgetToken("O token foi recusado. Confira o ADMIN_TOKEN do .env.");
    throw e;
  }
}

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;

/** As rotas de mudar status e combinar recebem formulário, não JSON. */
export function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.append(k, v);
  return f;
}
