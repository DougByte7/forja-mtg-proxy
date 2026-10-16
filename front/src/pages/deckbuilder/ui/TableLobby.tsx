/* O lobby da mesa online: o que aparece no lugar da mesa pra quem ainda não
   sentou. É a porta de quem chega pelo link de convite, e a primeira pergunta
   dele é "com que deck eu jogo?" — por isso os decks são cartões com a arte
   do comandante, as cores e a contagem, como na tela de decks, e sentar é um
   clique no cartão.

   Quem está na mesa aparece em cima: entrar numa sala sem saber com quem é
   parece engano. Sem conta, o lobby é o convite pra entrar, e o login volta
   pra esta mesma mesa. Quem só quer olhar passa direto pra mesa
   (`watching`), e a faixa online guarda o caminho de volta pra cá. */
import { useEffect, useState } from "preact/hooks";
import { MAX_PLAYERS } from "../tableRules";
import { online, send, tableMode, watching } from "../online";
import { state } from "../state";
import { listDecks, type DeckOption } from "../table";
import { SpriteIcon } from "./SpriteIcon";

const loginLink = () => "/entrar?voltar=" + encodeURIComponent(location.pathname + location.search);

function Pips({ identity }: { identity?: string }) {
  if (!identity) return <span class="cores"><span class="pip C" title="Incolor" /></span>;
  return <span class="cores">{identity.split("").map((c) => <span class={`pip ${c}`} />)}</span>;
}

/* Um deck do lobby. O cartão inteiro é o botão: é a escolha, e a escolha
   já senta. */
function DeckChoice({ d, current, busy, onSit }: {
  d: DeckOption; current: boolean; busy: string | null; onSit: (id: string) => void;
}) {
  const sitting = busy === d.id;
  const incomplete = d.total !== undefined && d.total !== 100;
  return (
    <button class={"lobby-deck" + (current ? " atual" : "") + (sitting ? " sentando" : "")} data-lobby-deck={d.id}
            disabled={!!busy} onClick={() => onSit(d.id)} aria-label={`Sentar com ${d.nome}`}>
      <span class="lobby-capa">
        {d.arte ? <img src={d.arte} alt="" loading="lazy" referrerpolicy="no-referrer" />
          : <SpriteIcon name="cards" />}
        {current && <span class="lobby-selo">aberto agora</span>}
      </span>
      <span class="lobby-miolo">
        <b class="lobby-nome">{d.nome}</b>
        <span class="lobby-cmd">{d.comandantes?.length ? d.comandantes.join(" + ") : d.de}</span>
        <span class="lobby-info">
          {d.identidade !== undefined && <Pips identity={d.identidade} />}
          {d.total !== undefined && (
            <span class={incomplete ? "falta" : "completo"}
                  title={incomplete ? "Dá pra jogar mesmo assim: a mesa usa o deck como está." : "As 100 do formato."}>
              {d.total}/100</span>
          )}
        </span>
      </span>
      <span class="lobby-sentar">{sitting ? "Sentando…" : <><SpriteIcon name="arrow-right" /> Sentar</>}</span>
    </button>
  );
}

/* Quem já está na mesa, com o deck de cada um e se está conectado. */
function Seated() {
  const o = online.value!;
  if (!o.seats.length) return <p class="nota">Ninguém sentou ainda — você abre a mesa.</p>;
  return (
    <div class="lobby-sentados">
      {o.seats.map((seat, i) => (
        <span class="lobby-sentado">
          <span class={"gf-conexao" + (seat.connected ? " on" : "")} aria-label={seat.connected ? "na mesa" : "desconectado"} />
          <b>{seat.name}</b>
          {state.table?.players[i] && <span class="lobby-deck-de">· {state.table.players[i].name}</span>}
        </span>
      ))}
      <span class="nota">{o.seats.length} de {MAX_PLAYERS}</span>
    </div>
  );
}

function DeckGrid() {
  const [decks, setDecks] = useState<DeckOption[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => {
    setDecks(null);
    listDecks().then(setDecks);
  };
  useEffect(load, []);
  // A sala responde sentando (a visão nova tira o lobby da tela) ou com um
  // aviso de erro, que não muda nada aqui: o cartão destrava sozinho.
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(null), 8000);
    return () => clearTimeout(t);
  }, [busy]);
  const sit = (deckId: string) => {
    setBusy(deckId);
    send({ type: "sit", deckId });
  };

  if (!decks) return <div class="lobby-vazio">Procurando seus decks…</div>;
  if (!decks.length) {
    return (
      <div class="lobby-vazio">
        <SpriteIcon name="cards" />
        <p>Você ainda não tem deck salvo. Monte um numa aba nova — esta mesa espera — e volte aqui.</p>
        <div class="gf-acoes">
          <a class="btn ouro" href="/deckbuilder" target="_blank" rel="noopener"><SpriteIcon name="plus" /> Montar um deck</a>
          <button class="btn" onClick={load}><SpriteIcon name="arrows-clockwise" /> Já montei, atualizar</button>
        </div>
      </div>
    );
  }
  // O deck aberto na tela (quem chamou a mesa do próprio deck) vem primeiro.
  const ordered = decks.slice().sort((a, b) => Number(b.id === state.id) - Number(a.id === state.id));
  return (
    <>
      <div class="lobby-grade">
        {ordered.map((d) => <DeckChoice key={d.id} d={d} current={d.id === state.id} busy={busy} onSit={sit} />)}
      </div>
      <p class="nota lobby-nota">A mesa usa o deck como está salvo no site. Montou outro numa aba nova?{" "}
        <button class="link" onClick={load}>Atualizar a lista</button></p>
    </>
  );
}

export function TableLobby() {
  const o = online.value!;
  const full = o.seats.length >= MAX_PLAYERS;
  let body;
  if (o.status === "conectando") {
    body = <div class="lobby-vazio"><SpriteIcon name="hourglass" /><p>Entrando na mesa…</p></div>;
  } else if (o.status === "sem-conta") {
    body = (
      <div class="lobby-vazio">
        <SpriteIcon name="users" />
        <p>Entre na sua conta pra sentar: é ela que diz à mesa quem é você, e é dela que vêm os seus decks.
          Depois do login você volta direto pra cá.</p>
        <div class="gf-acoes"><a class="btn ouro" id="lobby-entrar" href={loginLink()}>Entrar e sentar</a></div>
      </div>
    );
  } else if (full) {
    body = <div class="lobby-vazio"><SpriteIcon name="users" /><p>A mesa já tem {MAX_PLAYERS} jogadores. Dá pra assistir.</p></div>;
  } else {
    body = <DeckGrid />;
  }
  return (
    <div class="mesa-lobby" id="mesa-lobby">
      <div class="lobby-cabeca">
        <h2>{tableMode.value ? "Você foi chamado pra uma mesa de Commander" : "Escolha o deck pra sentar"}</h2>
        {o.status === "aberta" && <Seated />}
      </div>
      {body}
      {o.status === "aberta" && (
        <div class="lobby-pe">
          <button class="btn" id="lobby-assistir" onClick={() => { watching.value = true; }}>
            <SpriteIcon name="eye" /> Só assistir</button>
        </div>
      )}
    </div>
  );
}
