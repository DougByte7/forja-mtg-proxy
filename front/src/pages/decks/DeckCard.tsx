import { Icon } from "../../shared/Icon";
import { relativeTime, type DeckSummary } from "./data";

type Props = {
  deck: DeckSummary;
  loggedIn: boolean;
  armed: boolean;
  onCopyLink: () => void;
  onCopyList: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
};

function Colors({ identity }: { identity: string }) {
  if (!identity) {
    return <span class="cores"><span class="pip C" title="Incolor" /></span>;
  }
  return <span class="cores">{identity.split("").map((c) => <span class={`pip ${c}`} />)}</span>;
}

function Cover({ deck }: { deck: DeckSummary }) {
  if (deck.arte) {
    return (
      <div class="capa">
        <img src={deck.arte} alt="" loading="lazy" referrerpolicy="no-referrer" />
      </div>
    );
  }
  // Sem comandante escolhido (ou a base local não conhece o que está lá) não
  // há arte. O espaço fica, com o motivo: um cartão sem capa entre cartões
  // com capa parece defeito.
  return (
    <div class="capa"><span class="semarte">{deck.comandantes.length
      ? "arte não está na base local" : "sem comandante escolhido"}</span></div>
  );
}

export function DeckCard({ deck: d, loggedIn, armed, ...on }: Props) {
  const complete = d.total === 100;
  return (
    <article class="cartao">
      <Cover deck={d} />
      <div class="miolo">
        <div class="titulo">
          <h2>{d.nome}</h2>
          {d.versao == null
            ? <span class="versao wip" title="Trabalho em progresso">WIP</span>
            : <span class="versao" title={`Versão ${d.versao}`}>v{d.versao}</span>}
        </div>
        <div class="cmd">{d.comandantes.length ? d.comandantes.join(" + ") : "Sem comandante"}</div>
        <div class="linha-info">
          <Colors identity={d.identidade} />
          <span class={`contagem ${complete ? "completo" : "falta"}`}
                title={complete ? "As 100 do formato, fechadas."
                  : `Faltam ${d.faltam} pras 100. O sideboard não conta.`}>
            {d.total}/100
          </span>
          {d.talvez > 0 && <span title="No maybeboard, fora da conta">{d.talvez} talvez</span>}
          <span>{relativeTime(d.atualizado_em)}</span>
          {loggedIn && !d.dono && (
            <span title="Este baralho não está na sua conta. Abra e escolha ficar com ele.">
              sem dono
            </span>
          )}
        </div>
      </div>
      <div class="acoes">
        <a class="btn mini ouro" href={`/deckbuilder?deck=${encodeURIComponent(d.id)}`}>
          <Icon name="arrow-square-out" /> Abrir
        </a>
        <button class="btn mini" title="Copia o link deste deck" onClick={on.onCopyLink}>
          <Icon name="link" />
        </button>
        <button class="btn mini" title="Copia a decklist em texto, pra colar no MPC Fill"
                onClick={on.onCopyList}>
          <Icon name="cards" />
        </button>
        <button class="btn mini" title="Cria uma cópia deste deck" onClick={on.onDuplicate}>
          <Icon name="copy" />
        </button>
        <span style={{ flex: 1 }} />
        <button class="btn mini perigo" data-apagar onClick={on.onDelete}
                aria-label={armed ? "Apagar mesmo?" : "Apagar deck"}>
          <Icon name="trash" /> {armed ? "Apagar mesmo?" : ""}
        </button>
      </div>
    </article>
  );
}
