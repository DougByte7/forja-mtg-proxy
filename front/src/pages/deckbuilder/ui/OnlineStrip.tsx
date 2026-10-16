/* A faixa da mesa online, entre os botões e a mesa: em que pé está a
   conexão, quem está sentado, o link pra chamar os outros e sair. Sentar é
   no lobby (`TableLobby`), que ocupa o lugar da mesa até a pessoa sentar.
   Só existe com a mesa online (ver `online.ts`). */
import { MAX_PLAYERS } from "../tableRules";
import { leaveRoom, online, roomLink, setRoomInUrl, tableMode, watching } from "../online";
import { SpriteIcon } from "./SpriteIcon";
import { toast } from "./toast";

function copyLink(roomId: string) {
  const link = roomLink(roomId);
  // Sem a área de transferência (http, navegador antigo), o link aparece
  // pra copiar à mão.
  const byHand = () => void prompt("Copie o link da mesa:", link);
  if (!navigator.clipboard) return byHand();
  navigator.clipboard.writeText(link).then(() => toast("Link da mesa copiado."), byHand);
}

/* No modo mesa a página é só a mesa: sair leva pros decks da pessoa, que é
   de onde ela partiria pra outra coisa. Fora dele, volta pro deck aberto. */
function leave() {
  if (tableMode.value) {
    leaveRoom(false);
    location.assign("/");
    return;
  }
  leaveRoom();
  setRoomInUrl(null);
}

export function OnlineStrip() {
  const o = online.value;
  if (!o) return null;
  const status = o.status === "sem-conta" ? "Entre na sua conta pra entrar nesta mesa."
    : o.status === "conectando" ? "conectando…"
    : `${o.seats.length} de ${MAX_PLAYERS} na mesa`;
  return (
    <div class="gf-online" id="gf-online-faixa">
      <b class="gf-online-titulo"><SpriteIcon name="globe" /> Mesa online</b>
      <span class={"gf-online-status" + (o.status === "aberta" ? "" : " espera")}>{status}</span>
      {o.seats.map((seat) => (
        <span class="gf-online-assento">
          <span class={"gf-conexao" + (seat.connected ? " on" : "")} aria-hidden="true" />{seat.name}
        </span>
      ))}
      {/* Quem escolheu só assistir volta ao lobby por aqui (ver `TableLobby`). */}
      {o.status === "aberta" && o.seat === null && watching.value && o.seats.length < MAX_PLAYERS && (
        <button class="btn ouro" id="gf-online-sentar" onClick={() => { watching.value = false; }}>
          <SpriteIcon name="cards" /> Escolher deck e sentar</button>
      )}
      <span class="gf-espaco" />
      <button class="btn" id="gf-online-link" onClick={() => copyLink(o.roomId)}><SpriteIcon name="link" /> Copiar o link</button>
      <button class="btn" id="gf-online-sair" onClick={leave}><SpriteIcon name="sign-out" /> Sair da mesa</button>
    </div>
  );
}
