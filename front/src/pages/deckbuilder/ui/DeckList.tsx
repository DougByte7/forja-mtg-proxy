/* As duas listas (o deck e o maybeboard) e a caixa do comandante.

   A marcação é a mesma que o HTML em string tinha — mesmas classes, mesmos
   `data-*` —, porque os cliques, o menu de clique direito e o arrastar ainda
   são ligados por delegação (`eventos.js`, `menus.js`, `arrastar.js`). */
import { deckIdentity, totalCards } from "../deck";
import { boardView, rowProblem, type GroupView } from "../lists";
import { subtotalTexto, subtotalTitulo } from "../orcamento.js";
import type { Board, Entry } from "../types";
import { ArtButton, PriceCell, UnreleasedTag } from "./CardBits";
import { GuardedInput } from "./GuardedInput";
import { ManaCost } from "./Mana";
import { previewProps } from "./preview";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* A quantidade se digita no próprio número (quem grava é o `change`, ligado
   por delegação em `eventos.js`). O campo NÃO é reescrito enquanto tem o
   foco: a lista se redesenha por motivos que não são ela (a cotação que
   chega, o autosave), e reescrever o valor no meio da digitação apagaria o
   que a pessoa acabou de digitar. */
function QuantityInput({ name, quantity }: { name: string; quantity: number }) {
  return (
    <GuardedInput class="qtd" type="number" min="0" max="99" step="1" inputMode="numeric"
                  value={String(quantity)} data-qtd={name} aria-label={`Quantidade de ${name}`}
                  title="Quantidade — zero tira a carta. Clique direito na linha pro menu." />
  );
}

/* A coluna do maybeboard tem 288px, e a linha do deck não cabe nela inteira:
   sai a estrela de sugerir (pedir o que combina com uma carta que talvez nem
   fique é sugestão pra um deck que não existe) e sai o botão de arte, que
   continua no menu. O preço fica — "vale o que custa?" é metade da dúvida.

   O resto da carta mora no menu da linha, e a quantidade se digita no
   próprio número: zero tira a carta. No celular não existe clique direito,
   então lá o menu ganha o ⋯ no fim da linha. */
function CardRow({ entry, identity, board }: { entry: Entry; identity: string; board: Board }) {
  const c = entry.carta;
  const { problem, why } = rowProblem(entry, identity, board);
  const narrow = board === "talvez";
  const where = narrow ? "maybeboard" : "deck";
  return (
    <div class={"linha" + (problem ? " problema" : "")} data-nome={c.nome} data-tabuleiro={board} draggable>
      <QuantityInput name={c.nome} quantity={entry.quantidade} />
      <span class="nome" {...previewProps(c)}>{c.nome}
        {why && <span class="porque">· {why}</span>}</span>
      <UnreleasedTag card={c} />
      <ManaCost cost={c.mana_cost} />
      <PriceCell entry={entry} />
      <span class="ctrl">
        {!narrow && (
          <>
            <button class="mini" data-sug-carta={c.nome} title={`O que o EDHREC vê jogando junto de ${c.nome}`}
                    aria-label={`Sugestões a partir de ${c.nome}`}><SpriteIcon name="sparkle" /></button>
            <ArtButton card={c} />
          </>
        )}
        <button class="mini sai" data-tirar={c.nome} title={`Tirar do ${where}`}
                aria-label={`Tirar ${c.nome} do ${where}`}><SpriteIcon name="x" /></button>
        <button class="mini so-celular" data-menu-carta={c.nome}
                title={narrow ? "Categoria, voltar pro deck e mais" : "Categoria, maybeboard e mais"}
                aria-label={`Opções de ${c.nome}`}><SpriteIcon name="dots-three" /></button>
      </span>
    </div>
  );
}

function CardGroup({ group: g, identity, board }: { group: GroupView; identity: string; board: Board }) {
  const cls = ["grupo", g.custom && "propria", g.outOfCount && "fora-da-conta", g.collapsed && "fechado"].filter(Boolean).join(" ");
  return (
    <div class={cls} data-categoria={g.category} data-tabuleiro={board}>
      <h3>
        <button class="grupo-titulo" data-recolher-grupo={g.category} aria-expanded={g.collapsed ? "false" : "true"}
                title={`${g.collapsed ? "Abrir" : "Recolher"} ${g.category}`}>
          <SpriteIcon name={g.collapsed ? "caret-right" : "caret-down"} />
          <span>{g.category}</span>
          <span class="n">{g.countText}</span>
        </button>
        {g.outOfCount && (
          <span class="fora-rot" title={"O sideboard fica fora das 100\ne fora das análises, mas entra na cotação e na lista de impressão — é carta\nque você quer ter."}>fora das 100</span>
        )}
        {g.subtotal && g.subtotal.valor > 0 && (
          <span class="valor-grupo" title={subtotalTitulo(g.subtotal)}>{subtotalTexto(g.subtotal)}</span>
        )}
        <span class="traco" />
        {g.category === "Terrenos" && board === "deck" && (
          <button class="btn-atalho" data-abrir-manabase title="A conta de terrenos deste deck, no painel de baixo">
            <SpriteIcon name="dice-five" /> Mana base</button>
        )}
        <span class="acoes-grupo">
          {g.custom && (
            <button class="mini" data-menu-grupo={g.category} title="Renomear, mover ou apagar a categoria"
                    aria-label={`Ações da categoria ${g.category}`}><SpriteIcon name="dots-three" /></button>
          )}
        </span>
      </h3>
      {!g.collapsed && (g.items.length ? (
        <div class="colunas">{g.items.map((e) => <CardRow key={e.carta.nome} entry={e} identity={identity} board={board} />)}</div>
      ) : (
        <div class="grupo-vazio">Categoria vazia. Arraste uma carta pra cá, ou escolha esta categoria no menu da
          linha dela — clique direito, ou o <SpriteIcon name="dots-three" /> no celular.</div>
      ))}
    </div>
  );
}

export function BoardList({ board }: { board: Board }) {
  const state = useDeck();
  const entries = board === "talvez" ? state.maybe : state.cartas;
  // O maybeboard vazio não desenha nada: o aviso de vazio mora fora da lista.
  if (board === "talvez" && !entries.length) return null;
  const identity = deckIdentity();
  const { groups, noMatch } = boardView(entries, board);
  if (noMatch) return <div class="vazio lista-sem-achado">{noMatch}</div>;
  return <>{groups.map((g) => <CardGroup key={g.category} group={g} identity={identity} board={board} />)}</>;
}

/* O comandante (ou a dupla de parceiros), em cima da lista. Segundo
   comandante só faz sentido quando o primeiro tem parceria. */
export function CommanderBox() {
  const state = useDeck();
  const commanders = state.comandantes;
  return (
    <>
      {commanders.map((c, i) => (
        <>
          {i > 0 && <div style={{ width: "100%", height: "1px", background: "var(--border)" }} />}
          <button class="ver" data-ver-cmd={i} {...previewProps(c)} title={`Ver ${c.nome} inteira`}>
            <img src={c.imagem} alt="" loading="lazy" />
            <span class="dados"><b>{c.nome}</b><small>{c.tipo}</small></span>
            <UnreleasedTag card={c} />
          </button>
          <div class="mana"><ManaCost cost={c.mana_cost} /></div>
          <ArtButton card={c} />
          <button class="mini sai" data-tirar-cmd={i} title="Trocar comandante"><SpriteIcon name="x" /></button>
        </>
      ))}
      {commanders.length === 1 && commanders[0].parceiro && (
        <button class="btn" id="btn-parceiro" style={{ width: "100%", marginTop: "8px" }}>
          <SpriteIcon name="plus" /> Adicionar parceiro</button>
      )}
    </>
  );
}

/** Quantas cartas o maybeboard tem (a contagem do título da coluna). */
export function MaybeCount() {
  const state = useDeck();
  const n = state.maybe.reduce((sum, e) => sum + e.quantidade, 0);
  return <span class="talvez-n" id="talvez-n" hidden={!n}>{n}</span>;
}

/** O número na aba Deck: as cartas que contam, comandante incluído. */
export function DeckTabCount() {
  useDeck();
  return <>{totalCards()}</>;
}
