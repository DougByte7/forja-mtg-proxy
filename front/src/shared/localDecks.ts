/* A lista de decks que este navegador conhece (`forja.decks`).

   É a mesma chave e o mesmo formato que o deckbuilder escreve
   (`rememberDeck`, em `pages/deckbuilder/save.ts`), e as duas telas
   precisam continuar concordando: um formato que divergisse faria um deck
   salvo numa sumir da outra. Quem mexer no formato de um lado mexe no outro. */

export type LocalDeck = { id: string; nome: string; quando: number; comandante: string };

const KEY = "forja.decks";
const MAX_LOCAL = 20;

export function readLocalDecks(): LocalDeck[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((d) => d && d.id) : [];
  } catch {
    return [];
  }
}

function save(list: LocalDeck[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_LOCAL)));
  } catch { /* cota cheia ou navegador privado: a lista é conveniência */ }
}

export function forgetLocalDeck(id: string) {
  save(readLocalDecks().filter((d) => d.id !== id));
}

export function rememberLocalDeck(id: string, nome?: string, comandante?: string) {
  const list = readLocalDecks().filter((d) => d.id !== id);
  list.unshift({ id, nome: nome || "Deck sem nome", quando: Date.now(),
                 comandante: comandante || "" });
  save(list);
}
