/* A faixa da mesa online, entre os botões e a mesa: em que pé está a
   conexão, quem está sentado, o link pra chamar os outros, sentar e sair.
   Só existe com a mesa online (ver `online.ts`). */
import { useEffect, useState } from "preact/hooks";
import { MAX_PLAYERS } from "../tableRules";
import { leaveRoom, online, roomLink, send, setRoomInUrl } from "../online";
import { state } from "../state";
import { listDecks, type DeckOption } from "../table";
import { toast } from "./toast";

function copyLink(roomId: string) {
  const link = roomLink(roomId);
  // Sem a área de transferência (http, navegador antigo), o link aparece
  // pra copiar à mão.
  const byHand = () => void prompt("Copie o link da mesa:", link);
  if (!navigator.clipboard) return byHand();
  navigator.clipboard.writeText(link).then(() => toast("Link da mesa copiado."), byHand);
}

function leave() {
  leaveRoom();
  setRoomInUrl(null);
}

/* Sentar é escolher um deck SALVO: a sala busca o deck no site pelo id, e
   não aceita as cartas desta tela (ver `room/src/durable.ts`). O deck aberto
   na tela vem escolhido, quando ele já foi salvo. */
function SitChooser() {
  const [decks, setDecks] = useState<DeckOption[] | null>(null);
  const [chosen, setChosen] = useState("");
  useEffect(() => {
    let alive = true;
    listDecks().then((list) => {
      if (!alive) return;
      setDecks(list);
      setChosen(list.some((d) => d.id === state.id) ? state.id! : list[0]?.id || "");
    });
    return () => { alive = false; };
  }, []);
  if (!decks) return <span class="gf-online-nota">carregando seus decks…</span>;
  if (!decks.length) return <span class="gf-online-nota">Salve um deck pra poder sentar.</span>;
  return (
    <span class="gf-online-sentar">
      <select class="campo" id="gf-online-deck" aria-label="Deck pra sentar" value={chosen}
              onChange={(e) => setChosen(e.currentTarget.value)}>
        {decks.map((d) => <option value={d.id}>{d.nome}</option>)}
      </select>
      <button class="btn ouro" id="gf-online-sentar" disabled={!chosen}
              onClick={() => send({ type: "sit", deckId: chosen })}>Sentar</button>
      <span class="gf-online-nota">A mesa usa o deck como está salvo no site.</span>
    </span>
  );
}

export function OnlineStrip() {
  const o = online.value;
  if (!o) return null;
  const status = o.status === "sem-conta" ? "Entre na sua conta pra entrar nesta mesa."
    : o.status === "conectando" ? "conectando…"
    : `${o.seats.length} de ${MAX_PLAYERS} na mesa`;
  return (
    <div class="gf-online" id="gf-online-faixa">
      <b class="gf-online-titulo">Mesa online</b>
      <span class={"gf-online-status" + (o.status === "aberta" ? "" : " espera")}>{status}</span>
      {o.seats.map((seat) => (
        <span class="gf-online-assento">
          <span class={"gf-conexao" + (seat.connected ? " on" : "")} aria-hidden="true" />{seat.name}
        </span>
      ))}
      {o.status === "aberta" && o.seat === null && o.seats.length < MAX_PLAYERS && <SitChooser />}
      <span class="gf-espaco" />
      <button class="btn" id="gf-online-link" onClick={() => copyLink(o.roomId)}>Copiar o link</button>
      <button class="btn" id="gf-online-sair" onClick={leave}>Sair da mesa</button>
    </div>
  );
}
