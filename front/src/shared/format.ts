/* Datas e números do jeito que as telas mostram. */

/** "hoje", "ontem", "há 5 dias", "há 3 meses" (o `ts` é epoch em segundos). */
export function daysAgo(ts: number, now = Date.now()) {
  if (!ts) return "";
  const days = Math.floor((now / 1000 - ts) / 86400);
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  const months = Math.round(days / 30);
  return months === 1 ? "há um mês" : `há ${months} meses`;
}
