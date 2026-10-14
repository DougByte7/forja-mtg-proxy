/* Números e datas do painel do operador. */

/** "12/03, 14:05 (há 3 h)" — o `epoch` é em segundos. */
export function when(epoch: number | null | undefined, now = Date.now()) {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  const min = Math.floor((now - d.getTime()) / 60000);
  const relative = min < 1 ? "agora"
    : min < 60 ? `há ${min} min`
    : min < 60 * 24 ? `há ${Math.floor(min / 60)} h`
    : `há ${Math.floor(min / 1440)} d`;
  return `${d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit" })} (${relative})`;
}

export const money = (v: number) => "R$ " + Number(v || 0).toFixed(2).replace(".", ",");
export const int = (n: number) => Number(n || 0).toLocaleString("pt-BR");
export const fineMoney = (v: number) => "R$ " + Number(v || 0).toLocaleString("pt-BR",
  { minimumFractionDigits: 2, maximumFractionDigits: 3 });
export const decimal = (v: number) => Number(v || 0).toLocaleString("pt-BR",
  { maximumFractionDigits: 3 });
/** Valor pro campo do formulário: vírgula, sem zeros sobrando. */
export const fieldDecimal = (v: number) => Number(v)
  ? String(Number(Number(v).toFixed(4))).replace(".", ",") : "";
