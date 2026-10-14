/* As duas listas (o deck e o maybeboard) e a caixa do comandante.

   Os `data-*` da linha e do grupo são do arrastar (`deckDrag.ts`), que lê
   de onde a carta saiu e onde ela caiu. */
import { openCard } from "../cardDetail";
import { deckIdentity, totalCards } from "../deck";
import { findEntry, removeCard, removeCommander, setQuantity, startPartnerPick } from "../editing";
import { callManabase } from "../manabase";
import { openCardMenu, openGroupMenu } from "../menus";
import { suggestFromCard } from "../suggestions";
import { boardView, rowProblem, toggleGroup, type GroupView } from "../lists";
import { subtotalText, subtotalTitle } from "../budget";
import type { Board, Entry } from "../types";
import { ArtButton, PriceCell, UnreleasedTag } from "./CardBits";
import { GuardedInput } from "./GuardedInput";
import { ManaCost } from "./Mana";
import { previewProps } from "./preview";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* A quantidade vale no Enter, nas setas e ao sair do campo. Vazio ou lixo
   volta pro número de antes em vez de virar zero — zero tira a carta, e
   apagar o campo pra digitar outro número não é pedir isso. */
function changeQuantity(input: HTMLInputElement, name: string, board: Board) {
  const n = Math.floor(Number(input.value));
  if (input.value.trim() === "" || !Number.isFinite(n)) {
    input.value = String(findEntry(name, board)?.quantidade ?? "");
    return;
  }
  // Escrito de volta porque, quando a conta não muda (150 num deck que já
  // tem 99, 2,5 onde já há 2), nada se redesenha e o campo ficaria mentindo.
  input.value = String(Math.min(99, n));
  setQuantity(name, Math.min(99, n), board);
}

/* A quantidade se digita no próprio número. O campo NÃO é reescrito
   enquanto tem o foco: a lista se redesenha por motivos que não são ela (a
   cotação que chega, o autosave), e reescrever o valor no meio da digitação
   apagaria o que a pessoa acabou de digitar. Clicar nele é ir editá-lo, não
   abrir a carta. */
function QuantityInput({ name, quantity, board }: { name: string; quantity: number; board: Board }) {
  return (
    <GuardedInput class="qtd" type="number" min="0" max="99" step="1" inputMode="numeric"
                  value={String(quantity)} data-qtd={name} aria-label={`Quantidade de ${name}`}
                  title="Quantidade — zero tira a carta. Clique direito na linha pro menu."
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                  onChange={(e: Event) => changeQuantity(e.currentTarget as HTMLInputElement, name, board)} />
  );
}

/* Os botões da linha não abrem a carta: o clique pára neles. */
const only = (fn: (e: MouseEvent) => unknown) => (e: MouseEvent) => { e.stopPropagation(); fn(e); };

/* O menu da carta abre no clique direito da linha (no celular, pelo ⋯
   dela). Pelo teclado, a tecla de menu (ou Shift+F10) com o número da
   quantidade em foco chega aqui do mesmo jeito — o número é a parte da linha
   que recebe foco. Vindo do teclado não há ponteiro, e o evento chega em
   (0, 0): aí o menu ancora na própria linha. */
function rowMenu(e: MouseEvent, name: string, board: Board) {
  e.preventDefault();
  // A prévia da arte segue o mouse, que está parado em cima do nome: sem
  // isto ela ficaria aberta por baixo do menu.
  document.getElementById("previa")?.classList.remove("mostra");
  const row = e.currentTarget as Element;
  openCardMenu(e.clientX || e.clientY ? new DOMRect(e.clientX, e.clientY, 0, 0) : row, name, board);
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
    // A linha inteira abre a carta — clicar no nome é o gesto óbvio pra "me
    // conta mais sobre esta carta", e o "Ver a carta" do menu é o caminho do
    // teclado.
    <div class={"linha" + (problem ? " problema" : "")} data-nome={c.nome} data-tabuleiro={board} draggable
         onClick={() => openCard(c)} onContextMenu={(e) => rowMenu(e, c.nome, board)}>
      <QuantityInput name={c.nome} quantity={entry.quantidade} board={board} />
      <span class="nome" {...previewProps(c)}>{c.nome}
        {why && <span class="porque">· {why}</span>}</span>
      <UnreleasedTag card={c} />
      <ManaCost cost={c.mana_cost} />
      <PriceCell entry={entry} />
      <span class="ctrl">
        {!narrow && (
          <>
            <button class="mini" title={`O que o EDHREC vê jogando junto de ${c.nome}`}
                    onClick={only(() => suggestFromCard(c.nome))}
                    aria-label={`Sugestões a partir de ${c.nome}`}><SpriteIcon name="sparkle" /></button>
            <ArtButton card={c} />
          </>
        )}
        <button class="mini sai" title={`Tirar do ${where}`} onClick={only(() => removeCard(c.nome, board))}
                aria-label={`Tirar ${c.nome} do ${where}`}><SpriteIcon name="x" /></button>
        <button class="mini so-celular" onClick={only((e) => openCardMenu(e.currentTarget as Element, c.nome, board))}
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
        {/* O título do grupo é o botão de recolher: é o alvo grande, e
            recolher é o que se faz num cabeçalho de lista. */}
        <button class="grupo-titulo" aria-expanded={g.collapsed ? "false" : "true"} onClick={() => toggleGroup(g.category, board)}
                title={`${g.collapsed ? "Abrir" : "Recolher"} ${g.category}`}>
          <SpriteIcon name={g.collapsed ? "caret-right" : "caret-down"} />
          <span>{g.category}</span>
          <span class="n">{g.countText}</span>
        </button>
        {g.outOfCount && (
          <span class="fora-rot" title={"O sideboard fica fora das 100\ne fora das análises, mas entra na cotação e na lista de impressão — é carta\nque você quer ter."}>fora das 100</span>
        )}
        {g.subtotal && g.subtotal.valor > 0 && (
          <span class="valor-grupo" title={subtotalTitle(g.subtotal)}>{subtotalText(g.subtotal)}</span>
        )}
        <span class="traco" />
        {g.category === "Terrenos" && board === "deck" && (
          <button class="btn-atalho" onClick={callManabase} title="A conta de terrenos deste deck, no painel de baixo">
            <SpriteIcon name="dice-five" /> Mana base</button>
        )}
        <span class="acoes-grupo">
          {g.custom && (
            <button class="mini" onClick={(e) => openGroupMenu(e.currentTarget, g.category)} title="Renomear, mover ou apagar a categoria"
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
  const entries = board === "talvez" ? state.maybe : state.cards;
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
  const commanders = state.commanders;
  return (
    <>
      {commanders.map((c, i) => (
        <>
          {i > 0 && <div style={{ width: "100%", height: "1px", background: "var(--border)" }} />}
          <button class="ver" {...previewProps(c)} title={`Ver ${c.nome} inteira`} onClick={() => openCard(c)}>
            <img src={c.imagem} alt="" loading="lazy" />
            <span class="dados"><b>{c.nome}</b><small>{c.tipo}</small></span>
            <UnreleasedTag card={c} />
          </button>
          <div class="mana"><ManaCost cost={c.mana_cost} /></div>
          <ArtButton card={c} />
          <button class="mini sai" title="Trocar comandante" onClick={() => removeCommander(i)}><SpriteIcon name="x" /></button>
        </>
      ))}
      {commanders.length === 1 && commanders[0].parceiro && (
        <button class="btn" id="btn-parceiro" style={{ width: "100%", marginTop: "8px" }} onClick={() => {
          startPartnerPick();
          document.getElementById("busca-cmd")?.focus();
        }}>
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
