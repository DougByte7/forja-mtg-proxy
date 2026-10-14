/* A lista de TODOS os baralhos, a única tela do projeto que enumera deck.
   Ela mostra o dono de cada um; "sem dono" é o acervo de antes do login, ou o
   que ainda não foi reclamado por ninguém. Isso é informação, não pendência. */
import { daysAgo } from "../../shared/format";
import type { useAdminActions } from "./actions";
import type { AdminDeck, DeckList } from "./types";

export function DeckCount({ counts: c }: { counts: DeckList["contagem"] }) {
  if (!c.total) return null;
  return (
    <div class="chip" style={{ cursor: "default" }}>
      {c.sem_dono === c.total
        ? `${c.total} baralho(s), nenhum com dono ainda`
        : `${c.total} baralho(s) · ${c.sem_dono} sem dono`}
    </div>
  );
}

export function DecksList({ decks, search, actions }:
  { decks: AdminDeck[]; search: string; actions: ReturnType<typeof useAdminActions> }) {
  if (!decks.length) {
    return <div class="vazio">{search ? "Nenhum baralho casa com essa busca." : "Nenhum baralho no banco ainda."}</div>;
  }
  return (
    <>
      {decks.map((d) => (
        <div class="deck" key={d.id}>
          {d.arte
            ? <img class="arte" src={d.arte} alt="" loading="lazy" referrerpolicy="no-referrer" />
            : <div class="arte" />}
          <div class="miolo">
            <div class="nome">{d.nome}</div>
            <div class="meta"><span class="mono">{d.id}</span> ·{" "}
              {(d.comandantes || []).join(" + ") || "sem comandante"} · mexido {daysAgo(d.atualizado_em)}</div>
          </div>
          <div class="conta" title={d.faltam
            ? `Faltam ${d.faltam} pras 100. O sideboard não conta.`
            : "As 100 do formato, fechadas."}>{d.total}/100</div>
          <div class="dono">{d.dono || <span class="sem">sem dono</span>}</div>
          <div class="acoes">
            {/* Aba nova: o operador quase sempre volta pra lista depois de olhar. */}
            <button class="btn-sec" onClick={() => window.open(
              `/deckbuilder?deck=${encodeURIComponent(d.id)}`, "_blank", "noopener")}>Abrir</button>
            <button class="btn-sec" onClick={() => actions.confirmDeleteDeck(d.id, d.nome)}>Apagar</button>
          </div>
        </div>
      ))}
    </>
  );
}
