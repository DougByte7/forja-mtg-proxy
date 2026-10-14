/* -------------------------------------------------------------------------
   Os dados da tela de decks.

   ONDE MORA A VERDADE. Pra quem não tem conta, no `localStorage`, e não no
   servidor. O servidor não lista os decks de ninguém pra um anônimo (ver
   `decks.py`: quem tem o id, abre), então não existe "liste os meus" — existe
   "eu tenho estes ids, me diz o que eles são". É por isso que a rota é um
   `POST /decks/resumo` que RECEBE a lista.

   Duas fontes pra mesma lista, e a conta manda quando existe:

   * COM conta -> `GET /decks/meus`, que traz os decks daquela pessoa de
     qualquer aparelho. É o que o outro caminho não consegue dar: um deck
     montado no celular não está no `localStorage` do computador.
   * SEM conta -> `POST /decks/resumo` com os ids que este navegador guardou.

   Quem tem conta e decks órfãos neste navegador vê os dois: os órfãos são
   acrescentados à lista, com a oferta de reclamá-los. Sumir com eles seria
   esconder deck que a pessoa tem na mão.
   ------------------------------------------------------------------------- */
import { queryOptions } from "@tanstack/preact-query";
import type { User } from "../../shared/account";
import { api } from "../../shared/api";
import { daysAgo } from "../../shared/format";
import { readLocalDecks } from "../../shared/localDecks";

export type DeckSummary = {
  id: string;
  nome: string;
  versao: number | null;
  comandantes: string[];
  identidade: string;
  total: number;
  faltam: number;
  talvez: number;
  atualizado_em: number;
  arte?: string | null;
  dono?: unknown;
};

type Summary = { decks: DeckSummary[]; desconhecidos: string[] };

export type DeckList = {
  decks: DeckSummary[];
  /** Ids que o navegador tem e o servidor não conhece. */
  missing: string[];
};

const OPTS = { noStore: true, errorText: true } as const;

export function fetchSummary(ids: string[]) {
  return api<Summary>("/decks/resumo", { ...OPTS, body: { ids } });
}

/* Ordena pelo `atualizado_em` DO SERVIDOR, não pelo `quando` local: o
   servidor sabe quando o deck mudou, o navegador só sabe quando ele próprio
   encostou. Num deck mexido no celular, os dois discordam — e quem responde
   "no que eu estava mexendo" é o do servidor. */
const byUpdated = (a: DeckSummary, b: DeckSummary) =>
  (b.atualizado_em || 0) - (a.atualizado_em || 0);

export async function fetchDeckList(user: User | null): Promise<DeckList> {
  const localIds = readLocalDecks().map((d) => d.id);

  if (!user) {
    if (!localIds.length) return { decks: [], missing: [] };
    const r = await fetchSummary(localIds);
    return { decks: (r.decks || []).slice().sort(byUpdated), missing: r.desconhecidos || [] };
  }

  const mine = (await api<{ decks: DeckSummary[] }>("/decks/meus", OPTS)).decks || [];
  const known = new Set(mine.map((d) => d.id));
  const loose = localIds.filter((id) => !known.has(id));
  if (!loose.length) return { decks: mine.slice().sort(byUpdated), missing: [] };

  // Os órfãos que este navegador conhece entram junto, marcados.
  const r = await fetchSummary(loose.slice(0, 60));
  const orphans = (r.decks || []).filter((d) => !d.dono);
  return { decks: mine.concat(orphans).sort(byUpdated), missing: r.desconhecidos || [] };
}

export const deckListQuery = (user: User | null) => queryOptions({
  queryKey: ["decks", user?.login ?? null],
  queryFn: () => fetchDeckList(user),
});

export function relativeTime(ts: number, now = Date.now()) {
  return ts ? "mexido " + daysAgo(ts, now) : "";
}

/* Aceita o link inteiro ou só o id: quem compartilha manda a URL, e exigir
   que a pessoa recorte o id dela seria trabalho de máquina jogado pra ela.
   Os ids do deck têm 12 dígitos hex (ver `decks.py`). */
export function deckIdFromText(raw: string) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const inQuery = /[?&]deck=([0-9a-f]{6,32})/i.exec(text);
  if (inQuery) return inQuery[1].toLowerCase();
  const bare = /^([0-9a-f]{6,32})$/i.exec(text);
  return bare ? bare[1].toLowerCase() : "";
}
