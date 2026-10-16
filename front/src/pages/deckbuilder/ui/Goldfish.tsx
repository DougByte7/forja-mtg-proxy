/* ------------------------------------------------- o desenho da mesa

   Uma seção por jogador, e dentro dela a ordem de um tabuleiro: o campo de
   batalha (criaturas | outros), a linha dos terrenos entre o comando e o
   exílio, a linha da mão entre o deck e o cemitério e, na borda de quem joga,
   a barra com quem é e como está. As áreas existem sempre, mesmo vazias: são
   o lugar pra onde a carta vai, e uma área que só aparece com a primeira
   carta faria a mesa pular a cada jogada.

   Com dois decks a mesa é ESPELHADA na vertical, como numa mesa de verdade: o
   segundo jogador fica em cima com a ordem invertida — barra, mão, terrenos,
   campo de batalha —, e os dois campos de batalha se encaram no meio. Na
   horizontal nada vira: as criaturas de um ficam em cima das do outro.

   Na mesa ONLINE (ver `online.ts`) quem fica embaixo é a pessoa desta tela,
   e os outros ficam em cima, espelhados, um embaixo do outro. A mão e o
   baralho dos outros chegam como verso, e o que só o dono decide (manter a
   mão, comprar, buscar no deck) só aparece no lado dele.

   Este desenho só LÊ a mesa. Quem muda alguma coisa é `table.ts`, com as
   regras de `goldfish.ts`. */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { faceImage } from "../art";
import { deckSignature } from "../combos";
import {
  attackers, bottomCountOnKeep, cardByUid, cardName, comboCount, combosOf, fieldRow, handSummary,
  isLand, playerArts, ZONE_NAMES, type Player, type Table, type TableCard, type Zone,
} from "../goldfish";
import type { SeatInfo } from "../../../../../room/src/protocol";
import { isOnline, mySeat, online } from "../online";
import { COLOR_NAMES, COLORS, deckRevision, state } from "../state";
import {
  attackAll, bindTableDocument, changeCommanderDamage, changeLife, changePlayerCounter, clickCard, clickDeck,
  detail, endCombat, fullscreen, keep, mulligan, onTableDragEnd, onTableDragOver, onTableDragStart,
  onTableDrop, openTableMenu, openTableMenuAt, openTableModal, passTheTurn, primaryLabel, secondDeckButton,
  setFullscreen, setLife, shuffleUp, startOnline, tableRevision, toggleLog, undoTable, untapAll,
  type TableMenu,
} from "../table";
import { OnlineStrip } from "./OnlineStrip";
import { ManaCost, ManaText } from "./Mana";
import { SpriteIcon } from "./SpriteIcon";

/** A mesa, de dentro de um componente: redesenha a cada jogada e a cada
    mudança do deck (as artes e os combos da mesa vêm dele). */
export function useTable() {
  void tableRevision.value;
  void deckRevision.value;
  void online.value;
  return state.table;
}

/* Quem é cada lado da mesa, visto desta tela. `own` é o lado desta pessoa:
   na mesa local, todos (é ela dos dois lados); online, só o assento dela.

   Calculado UMA vez, em cima (`TableView`), e passado pra baixo como prop: um
   componente que lê sinal ganha do `@preact/signals` o atalho de não se
   redesenhar quando as props não mudam — e a mesa muda NO LUGAR, então as
   props de baixo (o jogador) chegam sempre iguais. Lendo `online` lá
   embaixo, a mão parava de acompanhar a mesa. */
interface Who {
  online: boolean;
  own: boolean;
  seat?: SeatInfo;
}

/* O ícone de cada zona: o mesmo no título da área, no menu da carta e nos
   destinos da busca, pra "cemitério" ser uma forma só na tela inteira. */
export const ZONE_ICONS: Record<Zone, string> = {
  baralho: "stack", mao: "hand", campo: "cards", cemiterio: "skull", exilio: "prohibit", comando: "crown-simple",
};

/* A arte de uma carta da mesa: a escolhida no deck DO DONO, e a padrão quando
   não há. O dono importa com dois decks na mesa — o Sol Ring de um não pode
   aparecer com a arte que o outro escolheu. A face é a que está pra cima
   (ver `toggleFace`). */
export function tableArt(c: TableCard) {
  return faceImage(c.card || { nome: "" }, c.backUp ? "verso" : "frente", 0, playerArts(c.owner) as any);
}

/* Cada selo diz a quantidade e o nome ("5: +1/+1"): marcador de Magic é
   lista aberta, e uma sigla de uma letra confunde "tempo" com "tesouro". */
function CardCounters({ c }: { c: TableCard }) {
  const names = Object.keys(c.counters || {});
  if (!names.length) return null;
  // Três cabem; a quarta viraria tarja sobre a arte. O `title` lista todas.
  return (
    <span class="gf-marcas" title={names.map((n) => `${n}: ${c.counters[n]}`).join(", ")}>
      {names.slice(0, 3).map((n) => <span class="gf-marca-b">{`${c.counters[n]}: ${n}`}</span>)}
    </span>
  );
}

/* O ⋯ que abre o menu, dentro de quem ele descreve (a carta, o deck). É um
   `span` porque quem o carrega já é botão, e botão dentro de botão é HTML
   inválido: pelo teclado o menu vem pela tecla de menu (o `contextmenu`). */
function MenuDots({ menu, label }: { menu: TableMenu; label: string }) {
  return (
    <span class="gf-pontos" data-gf-menu aria-hidden="true" title={label}
          onClick={(e) => { e.stopPropagation(); openTableMenu(menu, e.currentTarget.parentElement!); }}>
      <SpriteIcon name="dots-three" />
    </span>
  );
}

const openMenuHere = (menu: TableMenu) => (e: MouseEvent) => {
  e.preventDefault();
  openTableMenuAt(menu, e.clientX, e.clientY);
};

/* Nenhuma carta da mesa usa a prévia que segue o mouse: a carta aparece no
   painel (ver `showDetail`), e as duas juntas mostrariam a mesma carta duas
   vezes.

   O clique faz a jogada principal da zona (ver `clickCard`), e o `title` diz
   qual antes do clique; o resto mora no menu, pelo botão direito ou pelo ⋯. */
function TableCardButton({ c, zone, own, fresh, choosing }: {
  c: TableCard; zone: Zone; own: boolean; fresh?: boolean; choosing?: boolean;
}) {
  const card = c.card || { nome: "" };
  const art = c.faceDown ? "" : tableArt(c);
  const cls = ["gf-carta"];
  if (c.tapped) cls.push("deitada");
  if (c.faceDown) cls.push("virada");
  if (c.attacking) cls.push("atacando");
  if (c.blocking) cls.push("bloqueando");
  if (c.token) cls.push("ficha");
  if (fresh) cls.push("nova");
  if (choosing) cls.push("escolhe");
  // A carta que é peça de combo se anuncia SEM hover: o painel responde
  // "quais combos", mas ninguém passa o mouse numa carta que não deu sinal de
  // ter o que contar. Carta virada pra baixo não ganha selo — ela está
  // escondida, e o selo a entregaria.
  const combos = c.faceDown ? 0 : comboCount(c);
  // A carta escondida da mesa online (mão e baralho dos outros) é só o
  // verso: não abre menu, não arrasta, não mostra painel.
  const hidden = c.uid < 0;
  const primary = hidden ? "" : primaryLabel(c.uid, own);
  const name = card.nome || "";
  return (
    <button class={cls.join(" ")} data-gf-uid={hidden ? undefined : c.uid} draggable={!hidden} disabled={hidden}
            title={primary ? `${name} — clique: ${primary}` : name}
            style={art ? { backgroundImage: `url('${art}')` } : undefined}
            onClick={(e) => clickCard(c.uid, e.currentTarget)}
            onContextMenu={hidden ? undefined : openMenuHere({ kind: "card", uid: c.uid })}>
      <CardCounters c={c} />
      {combos > 0 && <span class="gf-combo-selo" title={`Peça de ${combos} combo(s) do deck`}>{combos}</span>}
      {c.attacking ? <span class="gf-combate" title="Atacando"><SpriteIcon name="sword" /></span>
        : c.blocking ? <span class="gf-combate" title={"Bloqueia " + cardName(cardByUid(c.blocking))}><SpriteIcon name="shield" /></span>
        : null}
      {fresh && <span class="gf-nova-selo" aria-hidden="true">nova</span>}
      {/* Só a mão leva o nome: é onde a decisão acontece. Ficha inventada na
          hora não tem arte: o nome dentro do quadro é tudo o que ela tem. */}
      {(zone === "mao" || (c.token && !art)) && (
        <span class="gf-nome">{name + (c.token && card.poder ? ` ${card.poder}/${card.resistencia}` : "")}</span>
      )}
      {!hidden && <MenuDots menu={{ kind: "card", uid: c.uid }} label="Mais ações" />}
    </button>
  );
}

function Row({ cards, zone, own, fresh, choosing }: {
  cards: TableCard[]; zone: Zone; own: boolean; fresh?: ReadonlySet<number>; choosing?: boolean;
}) {
  return (
    <div class="gf-fila">
      {cards.map((c) => <TableCardButton key={c.uid} c={c} zone={zone} own={own} fresh={fresh?.has(c.uid)} choosing={choosing} />)}
    </div>
  );
}

const Count = ({ icon, name, n }: { icon: string; name: string; n: number }) =>
  <><SpriteIcon name={icon} />{name} <b>{n}</b></>;

/* A área vazia é um lugar marcado, e não uma frase: o ícone da zona no meio
   do contorno diz "isto vai aqui" sem somar texto a uma mesa que já tem
   muito. O nome fica no `title`, pra quem pergunta. */
const Empty = ({ icon, text }: { icon: string; text: string }) =>
  <div class="gf-vazio gf-vazio-zona" title={text}><SpriteIcon name={icon} label={text} /></div>;

/* Uma área da mesa: título com a contagem, e o corpo. A área inteira é alvo
   de soltar — soltar em qualquer ponto dela, e não só em cima de outra carta,
   é o que deixa a área vazia receber a primeira. */
function Area({ title, zone, player, cls, children }: {
  title: ComponentChildren; zone: Zone; player: number; cls: string; children: ComponentChildren;
}) {
  return (
    <div class={"gf-area-mesa " + cls} data-gf-solta={zone} data-gf-j={player}>
      <div class="gf-area-titulo">{title}</div>
      <div class="gf-area-corpo">{children}</div>
    </div>
  );
}

/* Os gestos de tabuleiro inteiro, numa coluna de ícones na ponta do campo:
   criar ficha (que nasce aqui), atacar com todas e endireitar tudo. Moram
   junto do campo porque é sobre ele que agem — na barra do jogador, longe
   dele, ninguém procurava. */
function FieldTools({ p, ij }: { p: Player; ij: number }) {
  const ready = p.campo.some((c) => !c.tapped && !c.attacking && fieldRow(c) === "Criaturas");
  const tapped = p.campo.some((c) => c.tapped);
  return (
    <div class="gf-campo-acoes">
      <button class="gf-icone" data-gf-acao={`ficha:${ij}`} title="Criar ficha" aria-label="Criar ficha"
              onClick={() => openTableModal({ kind: "token", player: ij })}><SpriteIcon name="plus-circle" /></button>
      <button class="gf-icone" data-gf-acao={`atacarTodas:${ij}`} disabled={!ready}
              title="Atacar com todas as criaturas em pé" aria-label="Atacar com todas"
              onClick={() => attackAll(ij)}><SpriteIcon name="sword" /></button>
      <button class="gf-icone" data-gf-acao={`endireitar:${ij}`} disabled={!tapped}
              title="Endireitar tudo" aria-label="Endireitar tudo"
              onClick={() => untapAll(ij)}><SpriteIcon name="arrows-clockwise" /></button>
    </div>
  );
}

/* Criaturas de um lado, o resto do outro: quem olha um tabuleiro procura uma
   coisa de cada vez ("tenho bicho pra atacar?"), e misturadas cada pergunta
   vira busca visual. Lado a lado, e não empilhadas, pra o campo ter a altura
   de uma carta só. Cada lado cresce na proporção das cartas que tem. A ordem
   dentro de cada lado é a que a pessoa arrumou (ver `reposition`). */
function Battlefield({ p, ij, own }: { p: Player; ij: number; own: boolean }) {
  const side = (icon: string, name: string, list: TableCard[], empty: string) => (
    <div class="gf-lado" style={{ flexGrow: Math.max(1, list.length) }}>
      <div class="gf-area-titulo"><Count icon={icon} name={name} n={list.length} /></div>
      <div class="gf-area-corpo">{list.length ? <Row cards={list} zone="campo" own={own} /> : <Empty icon={icon} text={empty} />}</div>
    </div>
  );
  return (
    <div class="gf-area-mesa gf-batalha" data-gf-solta="campo" data-gf-j={ij}>
      {side("paw-print", "Criaturas", p.campo.filter((c) => fieldRow(c) === "Criaturas"), "nenhuma criatura")}
      {side("cube", "Outros", p.campo.filter((c) => fieldRow(c) === "Outros"), "nada mais em jogo")}
      {own && <FieldTools p={p} ij={ij} />}
    </div>
  );
}

/* Terrenos iguais viram um MONTE: as cartas sobrepostas, cada uma mostrando
   uma tira, e a quantidade no canto. Igual quer dizer mesmo nome E mesmo
   estado — deitar uma Floresta a tira do monte das em pé e a põe no das
   deitadas, que é a pergunta que se faz ao terreno ("quantas ainda posso
   usar?"). Cada carta continua sendo o seu botão: o menu, o arrastar e o
   painel não sabem que o monte existe. */
function Piles({ lands, own }: { lands: TableCard[]; own: boolean }) {
  const piles = new Map<string, TableCard[]>();
  for (const c of lands) {
    const key = [cardName(c), c.tapped, c.faceDown, c.backUp, c.token, c.attacking, c.blocking,
                 JSON.stringify(c.counters)].join("|");
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key)!.push(c);
  }
  return (
    <div class="gf-fila">
      {[...piles.values()].map((pile) => pile.length === 1
        ? <TableCardButton key={pile[0].uid} c={pile[0]} zone="campo" own={own} />
        : (
          <div class="gf-monte" key={"monte" + pile[0].uid}>
            {pile.map((c) => <TableCardButton key={c.uid} c={c} zone="campo" own={own} />)}
            <span class="gf-monte-n" aria-hidden="true">×{pile.length}</span>
          </div>
        ))}
    </div>
  );
}

/* Terreno-criatura mora aqui: a primeira regra que casa ganha, e pra quem
   joga ele é o terreno que entrou no turno. */
function Lands({ p, ij, own }: { p: Player; ij: number; own: boolean }) {
  const lands = p.campo.filter((c) => fieldRow(c) === "Terrenos");
  return (
    <Area title={<Count icon="mountains" name="Terrenos" n={lands.length} />} zone="campo" player={ij} cls="gf-terrenos">
      {lands.length ? <Piles lands={lands} own={own} /> : <Empty icon="mountains" text="nenhum terreno" />}
    </Area>
  );
}

/* O comando fica ao lado dos terrenos porque é de onde se lança o comandante.
   O imposto é INFORMAÇÃO: quanto a próxima vez custaria, sem cobrar nada. */
function Command({ p, ij, own }: { p: Player; ij: number; own: boolean }) {
  const title = (
    <>
      <Count icon={ZONE_ICONS.comando} name="Comando" n={p.comando.length} />
      {p.taxPaid > 0 && <> <span class="gf-imposto" title="Custo a mais na próxima vez">+{p.taxPaid * 2}</span></>}
    </>
  );
  return (
    <Area title={title} zone="comando" player={ij} cls="gf-comando">
      {p.comando.length ? <Row cards={p.comando} zone="comando" own={own} /> : <Empty icon={ZONE_ICONS.comando} text="vazia" />}
    </Area>
  );
}

/* Baralho, cemitério e exílio são PILHAS: uma carta de largura. O clique no
   baralho compra (é o que se faz com ele quase sempre); no cemitério e no
   exílio, abre a zona inteira. A de cima aparece (com o painel no hover e o
   arrastar, pra puxar de volta a última que caiu); o baralho aparece de
   costas, como na mesa. */
function Pile({ p, ij, zone, title, label, action, onOpen, menu }: {
  p: Player; ij: number; zone: Zone; title: ComponentChildren; label: string; action: string;
  onOpen: (anchor: Element) => void; menu?: TableMenu;
}) {
  const list = p[zone];
  const top = zone === "baralho" ? null : list[0];
  const art = top && !top.faceDown ? tableArt(top) : "";
  const cls = ["gf-pilha"];
  if (!list.length) cls.push("vazia");
  else if (!art) cls.push("verso");
  return (
    <Area title={title} zone={zone} player={ij} cls={`gf-pilha-area gf-${zone}`}>
      <button class={cls.join(" ")} data-gf-acao={action} title={label} aria-label={label}
              data-gf-uid={top ? top.uid : undefined} draggable={top ? true : undefined}
              style={art ? { backgroundImage: `url('${art}')` } : undefined}
              onClick={(e) => onOpen(e.currentTarget)}
              onContextMenu={menu ? openMenuHere(menu) : undefined}>
        {!list.length && <SpriteIcon name={ZONE_ICONS[zone]} />}
        {menu && list.length > 0 && <MenuDots menu={menu} label="Mais ações do deck" />}
      </button>
    </Area>
  );
}

function HandSummary({ hand }: { hand: TableCard[] }) {
  if (!hand.length) return null;
  const r = handSummary(hand);
  // `title` em cada cor porque bolinha colorida sozinha não é informação
  // acessível — a mesma regra dos pips do resto da página.
  const pips = COLORS.filter((c) => r.colors[c]);
  return (
    <span class="gf-resumo">
      <span><b>{r.lands}</b> terreno(s)</span>
      {r.spells > 0 && (
        <span title="Média de custo do que não é terreno">
          <b>{r.averageCost.toFixed(1).replace(".", ",")}</b> de custo médio</span>
      )}
      {pips.length > 0 && (
        <span class="gf-cores" title="Símbolos de cor que a mão pede">
          {pips.map((c) => <span class="gf-cor" title={COLOR_NAMES[c]}><span class={"pip " + c} />{r.colors[c]}</span>)}
        </span>
      )}
    </span>
  );
}

const OPENING_HAND = 7;

/* A decisão do mulligan diz o RESULTADO em cada botão — "fica com 7", "vai
   pra 6" —, e não numa frase de condicionais em cima deles: é a conta que a
   pessoa faria de cabeça antes de clicar. */
function MulliganChoice({ p, ij }: { p: Player; ij: number }) {
  const bottom = bottomCountOnKeep(ij);
  // A compra do turno só vem pra quem está na vez (ver `keepHand`).
  const onTurn = state.table!.active === ij;
  const keeps = p.mao.length - Math.min(bottom, p.mao.length) + (onTurn ? 1 : 0);
  // O próximo mulligan devolve `mulligans` cartas (o primeiro é grátis).
  const next = OPENING_HAND - p.mulligans;
  return (
    <>
      <p class="nota">
        <b>{p.mulligans === 0 ? "Mão de abertura" : `${p.mulligans}º mulligan`}</b>
        {bottom > 0 && <> · manter devolve <b>{bottom}</b> pro fundo</>}
        {onTurn ? " · a compra do turno vem junto" : " · a compra do turno vem quando chegar a vez"}
      </p>
      <div class="gf-acoes">
        <button class="btn ouro" data-gf-acao={`manter:${ij}`} onClick={() => keep(ij)}>
          Manter <small>fica com {keeps}</small></button>
        <button class="btn" data-gf-acao={`mulligan:${ij}`} onClick={() => mulligan(ij)}>
          Mulligan <small>{p.mulligans === 0 ? "grátis, fica com 7" : `fica com ${Math.max(0, next)}`}</small></button>
      </div>
    </>
  );
}

/* Na fase de fundo, quanto falta e o que fazer — com as cartas da mão
   acesas, que são as que dá pra escolher. */
function BottomChoice({ p, ij }: { p: Player; ij: number }) {
  const total = Math.min(bottomCountOnKeep(ij), p.mao.length + p.toBottom);
  const chosen = total - p.toBottom;
  return (
    <p class="nota">Clique nas cartas que vão pro fundo do baralho, na ordem que quiser:{" "}
      <b>{chosen} de {total}</b>. Errou? <kbd>Ctrl</kbd>+<kbd>Z</kbd> desfaz a última.</p>
  );
}

/* As cartas que acabaram de chegar à mão, desde o último desenho em que ela
   mudou: a compra do turno não se perde numa mão de oito. Ficam marcadas até
   a próxima mudança na mão. Na troca de mão do mulligan nada se marca — a
   mão inteira é nova, e marcar tudo é não marcar nada. */
function useFresh(hand: TableCard[], active: boolean) {
  const seen = useRef<{ key: string; uids: Set<number>; fresh: Set<number> } | null>(null);
  const uids = hand.map((c) => c.uid);
  const key = uids.join();
  if (!seen.current || seen.current.key !== key) {
    const before = seen.current?.uids;
    const fresh = new Set(active && before ? uids.filter((u) => u > 0 && !before.has(u)) : []);
    seen.current = { key, uids: new Set(uids), fresh };
  }
  return seen.current.fresh;
}

/* A mão com o resumo no título: é o que se lê antes de decidir manter, e na
   linha do título ele não rouba altura da mesa. No mulligan, a escolha fica
   dentro da própria mão, em cima das cartas que ela julga. */
function Hand({ p, ij, own }: { p: Player; ij: number; own: boolean }) {
  const fresh = useFresh(p.mao, own && p.phase === "jogo");
  return (
    <Area title={<><Count icon={ZONE_ICONS.mao} name="Mão" n={p.mao.length} />{own && <HandSummary hand={p.mao} />}</>}
          zone="mao" player={ij} cls={"gf-area-mao" + (own && p.phase === "fundo" ? " escolhendo" : "")}>
      {p.phase !== "jogo" && !own && (
        <div class="gf-mulligan">
          <p class="nota">{p.phase === "fundo" ? "Escolhendo o que vai pro fundo do baralho…" : "Decidindo a mão…"}</p>
        </div>
      )}
      {p.phase !== "jogo" && own && (
        <div class="gf-mulligan">
          {p.phase === "fundo" ? <BottomChoice p={p} ij={ij} /> : <MulliganChoice p={p} ij={ij} />}
        </div>
      )}
      {p.mao.length
        ? <Row cards={p.mao} zone="mao" own={own} fresh={fresh} choosing={own && p.phase === "fundo"} />
        : <Empty icon={ZONE_ICONS.mao} text="mão vazia" />}
    </Area>
  );
}

/* Duas linhas numa grade de três colunas: comando, terrenos e exílio; deck,
   mão e cemitério. A grade é compartilhada pra as pilhas ficarem uma em cima
   da outra. No espelho, a linha da mão vai pra borda, como a do outro. */
function Zones({ p, ij, m, mirrored, own }: { p: Player; ij: number; m: Table; mirrored: boolean; own: boolean }) {
  const search = (zone: Zone) => () => openTableModal({ kind: "search", player: ij, zone });
  const lands = [
    <Command key="comando" p={p} ij={ij} own={own} />,
    <Lands key="terrenos" p={p} ij={ij} own={own} />,
    <Pile key="exilio" p={p} ij={ij} zone="exilio" title={<Count icon={ZONE_ICONS.exilio} name="Exílio" n={p.exilio.length} />}
          label="Ver o exílio" action={`buscar:${ij}:exilio`} onOpen={search("exilio")} />,
  ];
  const hand = [
    // A tecla D compra pra quem está na vez: é nesse baralho que ela aparece.
    <Pile key="baralho" p={p} ij={ij} zone="baralho" action={`deck:${ij}`}
          label={own ? "Comprar 1 (botão direito: buscar, olhar o topo, moer)" : `O deck de ${p.name}`}
          title={<><Count icon={ZONE_ICONS.baralho} name="Deck" n={p.baralho.length} />{m.active === ij && own && <> <kbd title="Comprar">D</kbd></>}</>}
          onOpen={(anchor) => clickDeck(ij, anchor)}
          menu={own ? { kind: "deck", player: ij } : undefined} />,
    <Hand key="mao" p={p} ij={ij} own={own} />,
    <Pile key="cemiterio" p={p} ij={ij} zone="cemiterio" title={<Count icon={ZONE_ICONS.cemiterio} name="Cemitério" n={p.cemiterio.length} />}
          label="Ver o cemitério" action={`buscar:${ij}:cemiterio`} onOpen={search("cemiterio")} />,
  ];
  return <div class="gf-zonas">{mirrored ? [...hand, ...lands] : [...lands, ...hand]}</div>;
}

/* Shift no clique anda de 5 em 5. */
function Step({ label, minus, onStep }: { label: string; minus?: boolean; onStep: (times: number) => void }) {
  return (
    <button class="gf-passo" aria-label={label} title={`${label} (Shift: 5)`}
            onClick={(e) => onStep(e.shiftKey ? 5 : 1)}><SpriteIcon name={minus ? "minus" : "plus"} /></button>
  );
}

/* A vida é o número que mais se lê na barra, e o que mais se acerta de uma
   vez ("tomei 7"): clicar nele vira campo pra digitar o valor novo. A vida
   vem como número, e não lida do jogador: com `useState` aqui, o
   `@preact/signals` só redesenha quando alguma prop muda, e o jogador muda
   no lugar. */
function LifeValue({ life, ij }: { life: number; ij: number }) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  if (editing) {
    const done = (save: boolean) => {
      if (save) setLife(ij, Number(input.current!.value));
      setEditing(false);
    };
    return (
      <input ref={input} class="gf-vida-campo" type="number" inputMode="numeric" defaultValue={String(life)}
             aria-label="Vida" onBlur={() => done(true)}
             onKeyDown={(e) => {
               e.stopPropagation();   // o D e o Espaço daqui são do campo, não da mesa
               if (e.key === "Enter") done(true);
               if (e.key === "Escape") done(false);
             }} />
    );
  }
  return (
    <button class="gf-vida-valor" title="Clique pra digitar a vida" onClick={() => setEditing(true)}><b>{life}</b></button>
  );
}

/* Dano de comandante: só existe com dois decks na mesa. Sozinho, ele seria uma
   linha pra anotar o dano do próprio comandante em si mesmo. Cada um leva o
   nome de quem bate, encurtado, porque com quatro na mesa "Cmd" três vezes
   não diz de quem é cada número. */
function CommanderDamage({ p, ij, m }: { p: Player; ij: number; m: Table }) {
  if (m.players.length < 2) return null;
  return (
    <>
      {m.players.map((other, io) => {
        if (io === ij) return null;
        const n = p.commanderDamage[io] || 0;
        return (
          <span class={"gf-dano" + (n >= 21 ? " letal" : "")} title={`Dano do comandante de ${other.name} — 21 mata`}>
            <SpriteIcon name="crown-simple" /><span class="gf-dano-de">{other.name}</span>
            <Step label={`Menos 1 de dano de ${other.name}`} minus onStep={(t) => changeCommanderDamage(ij, io, -t)} />
            <b>{n}</b>
            <Step label={`Mais 1 de dano de ${other.name}`} onStep={(t) => changeCommanderDamage(ij, io, t)} />
          </span>
        );
      })}
    </>
  );
}

/* Fatos do tabuleiro, não conta de mana: quantos terrenos estão em pé, de
   quantos. Ver o cabeçalho de `goldfish.ts`. O segundo terreno do turno vira
   aviso — é o único dado daqui que o tabuleiro não mostra sozinho, e a mesa
   conta sem impedir (tem carta que deixa). */
function BarLands({ p }: { p: Player }) {
  const lands = p.campo.filter((c) => isLand(c.card));
  const up = lands.filter((c) => !c.tapped).length;
  return (
    <span class="gf-fatos-j" title="Terrenos em pé, do total no campo">
      <SpriteIcon name="mountains" /> <b>{up}</b>/{lands.length} em pé
      {p.landsThisTurn > 1 && (
        <span class="gf-alerta" title="Terrenos baixados neste turno">
          <SpriteIcon name="warning" /> {p.landsThisTurn} neste turno</span>
      )}
    </span>
  );
}

/* Na mesa local o jogador é o deck. Online é a pessoa, com o deck do lado, e
   um ponto que diz se ela está conectada agora. */
function PlayerName({ p, seat }: { p: Player; seat?: SeatInfo }) {
  if (!seat) return <b class="gf-nome-j" title={p.name}>{p.name}</b>;
  return (
    <b class="gf-nome-j" title={`${seat.name} · ${p.name}`}>
      <span class={"gf-conexao" + (seat.connected ? " on" : "")}
            title={seat.connected ? "Na mesa" : "Desconectado"} aria-label={seat.connected ? "na mesa" : "desconectado"} />
      {seat.name} <span class="gf-deck-j">· {p.name}</span>
    </b>
  );
}

/* A barra fica na borda de fora de cada jogador: embaixo de quem está
   embaixo e em cima de quem está em cima. Quem é, a vez, a vida (o número
   maior), o dano de comandante e os marcadores; à direita, os terrenos. */
function Bar({ p, ij, m, who }: { p: Player; ij: number; m: Table; who: Who }) {
  return (
    <div class="gf-barra">
      <PlayerName p={p} seat={who.seat} />
      {m.players.length > 1 && m.active === ij && (
        <span class="gf-vez">{who.online && who.own ? "sua vez" : "na vez"}</span>
      )}
      <span class="gf-vida" title="Vida">
        <SpriteIcon name="heart" />
        <Step label="Menos 1 de vida" minus onStep={(t) => changeLife(ij, -t)} />
        <LifeValue life={p.life} ij={ij} />
        <Step label="Mais 1 de vida" onStep={(t) => changeLife(ij, t)} />
      </span>
      <CommanderDamage p={p} ij={ij} m={m} />
      {Object.keys(p.counters).map((name) => (
        <span class="gf-marca">
          <SpriteIcon name="hash" />{name}
          <button class="gf-passo" aria-label={`Menos 1 de ${name}`} onClick={() => changePlayerCounter(ij, name, -1)}><SpriteIcon name="minus" /></button>
          <b>{p.counters[name]}</b>
          <button class="gf-passo" aria-label={`Mais 1 de ${name}`} onClick={() => changePlayerCounter(ij, name, 1)}><SpriteIcon name="plus" /></button>
        </span>
      ))}
      <button class="gf-botao" data-gf-acao={`novaMarca:${ij}`} title="Pôr um marcador neste jogador (veneno, energia…)"
              onClick={(e) => openTableMenu({ kind: "counter", player: ij }, e.currentTarget)}>
        <SpriteIcon name="plus" /> Marcador</button>
      <span class="gf-espaco" />
      <BarLands p={p} />
    </div>
  );
}

/* De cima pra baixo, quem está embaixo: campo de batalha, as duas linhas de
   zonas e a barra. Quem está em cima tem a mesma ordem de baixo pra cima. */
function PlayerSection({ ij, m, mirrored, who }: { ij: number; m: Table; mirrored: boolean; who: Who }) {
  const p = m.players[ij];
  const parts = [
    <Battlefield key="campo" p={p} ij={ij} own={who.own} />,
    <Zones key="zonas" p={p} ij={ij} m={m} mirrored={mirrored} own={who.own} />,
    <Bar key="barra" p={p} ij={ij} m={m} who={who} />,
  ];
  if (mirrored) parts.reverse();
  const active = m.players.length > 1 && m.active === ij;
  return (
    <section class={"gf-jogador" + (active ? " ativo" : "") + (mirrored ? " espelhado" : "")} data-gf-j={ij}>
      {parts}
    </section>
  );
}

/* O combate em curso, no meio da mesa — entre os campos que se encaram, que
   é onde ele acontece —, com o botão que o encerra. Antes o botão aparecia e
   sumia no alto da tela, longe das criaturas. */
function CombatStrip({ m }: { m: Table }) {
  const attacking = attackers().length;
  const blocking = m.players.reduce((n, p) => n + p.campo.filter((c) => c.blocking).length, 0);
  if (!attacking && !blocking) return null;
  return (
    <div class="gf-combate-faixa" role="status">
      <SpriteIcon name="sword" />
      <span><b>{attacking}</b> atacando{blocking > 0 && <> · <b>{blocking}</b> bloqueando</>}</span>
      <span class="nota">o dano se aplica na vida</span>
      <button class="btn" id="gf-fim-combate" onClick={endCombat}><SpriteIcon name="check" /> Fim do combate</button>
    </div>
  );
}

const bottomSeat = () => (isOnline() ? mySeat() ?? 0 : 0);

function whoIs(ij: number): Who {
  const o = online.value;
  return { online: !!o, own: !o || o.seat === ij, seat: o?.seats[ij] };
}

function seatOrder(m: Table) {
  const bottom = bottomSeat();
  return m.players.map((_, i) => i).filter((i) => i !== bottom).concat(bottom);
}

/* A mesa vazia chama pra começar no lugar onde a mesa vai estar: o botão é
   o assunto da tela vazia, e não uma instrução apontando pro canto. */
function EmptyTable() {
  const o = online.value;
  if (!o) {
    return (
      <div class="gf-comecar">
        <button class="btn ouro grande" id="gf-comecar" onClick={shuffleUp}>
          <SpriteIcon name="shuffle" /> Embaralhar e comprar 7</button>
        <p class="nota">O comandante vai pra zona de comando; o sideboard e o maybeboard ficam de fora, como em
          toda análise desta tela.</p>
      </div>
    );
  }
  if (o.status !== "aberta") return <div class="gf-vazio">Entrando na mesa…</div>;
  return <div class="gf-vazio">Ninguém sentou ainda. Escolha um deck acima pra abrir a mesa.</div>;
}

function TableView() {
  const m = useTable();
  const order = m ? seatOrder(m) : [];
  return (
    <div id="gf-mesa" onDragStart={onTableDragStart} onDragEnd={onTableDragEnd}
         onDragOver={onTableDragOver} onDrop={onTableDrop}>
      {!m ? <EmptyTable /> : (
        // Quem fica embaixo vem por último: os outros são o lado de cima da
        // mesa espelhada. Na mesa local, embaixo é o primeiro deck. A faixa
        // do combate senta entre eles.
        <div class={"gf-jogadores" + (m.players.length > 1 ? " dois" : "")}>
          {order.slice(0, -1).map((ij) => (
            <PlayerSection key={ij} ij={ij} m={m} mirrored who={whoIs(ij)} />
          ))}
          <CombatStrip m={m} />
          <PlayerSection key={order.at(-1)} ij={order.at(-1)!} m={m} mirrored={false} who={whoIs(order.at(-1)!)} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------ o painel da carta */

type Face = { nome?: string; mana_cost?: string; tipo?: string; texto?: string;
              poder?: string | null; resistencia?: string | null; lealdade?: string; defesa?: string };

function faceBody(f: Face) {
  if (f.poder != null && f.resistencia != null) return `${f.poder}/${f.resistencia}`;
  if (f.lealdade != null) return `Lealdade ${f.lealdade}`;
  if (f.defesa != null) return `Defesa ${f.defesa}`;
  return "";
}

function DetailFace({ f, withName }: { f: Face; withName: boolean }) {
  const body = faceBody(f);
  return (
    <div class="gf-detalhe-face">
      {withName && <div class="gf-detalhe-nome"><b>{f.nome}</b><ManaCost cost={f.mana_cost} /></div>}
      {f.tipo && <div class="gf-detalhe-tipo">{f.tipo}</div>}
      {f.texto && <p class="gf-detalhe-texto"><ManaText text={f.texto} /></p>}
      {body && <div class="gf-detalhe-pt">{body}</div>}
    </div>
  );
}

/* O que a carta impressa não diz e a mesa sabe: marcadores, deitada, combate,
   a face pra cima, e se ela é ficha ou comandante. Só o que está
   acontecendo — carta em pé e sem marcador não ganha linha nenhuma. */
function CardStatus({ c }: { c: TableCard }) {
  const items: string[] = [];
  if (c.commander) items.push("Comandante");
  if (c.token) items.push("Ficha");
  if (c.faceDown) items.push("Virada pra baixo");
  if (c.backUp) items.push("Mostrando o verso");
  if (c.tapped) items.push("Deitada");
  if (c.attacking) items.push("Atacando");
  if (c.blocking) items.push("Bloqueia " + cardName(cardByUid(c.blocking)));
  for (const name of Object.keys(c.counters || {})) items.push(`${name}: ${c.counters[name]}`);
  if (!items.length) return null;
  return <div class="gf-detalhe-estado">{items.map((t) => <span>{t}</span>)}</div>;
}

/* Os combos desta carta, no painel. A peça vem com a zona onde está — campo,
   mão, baralho —, e é isso que responde a pergunta do meio da partida: não
   "este deck tem o combo" (a aba de combos já diz), e sim "quanto falta pra
   ele acontecer AGORA". A carta que abriu o painel se marca entre as peças.

   O que o combo PEDE (mana, estado de jogo) fica visualmente separado do que
   ele PRODUZ — um é condição, o outro é consequência. A mesa não confere
   nenhum dos dois: ela não soma mana (ver o cabeçalho de `goldfish.ts`).

   Sem link pro Spellbook de propósito: o painel é `pointer-events:none`, e
   um link aqui seria um link que não clica. */
function CardCombos({ c }: { c: TableCard }) {
  const found = combosOf(c);
  if (!found.length) return null;
  return (
    <div class="gf-combos">
      <div class="gf-combos-titulo">Combos <b>{found.length}</b></div>
      {/* A lista fecha com o deck de quando a busca rodou, não com o de agora. */}
      {state.combosSignature !== deckSignature() && <div class="gf-combo-velho">O deck mudou desde a busca de combos.</div>}
      {found.map(({ combo, pecas }) => {
        const c2 = combo as any;
        const needs: ComponentChildren[] = [];
        if (c2.mana) needs.push(<><b>Mana:</b> <ManaText text={c2.mana} /></>);
        if (c2.prerequisitos) needs.push(c2.prerequisitos);
        return (
          <div class="gf-combo">
            <div class="gf-combo-pecas">
              {pecas.map((p, i) => (
                <>
                  {i > 0 && <span class="mais">+</span>}
                  <span class={`gf-peca z-${p.zona || "fora"}` + (p.esta ? " esta" : "")}>
                    {p.nome}
                    {p.zona ? <i>{ZONE_NAMES[p.zona]}</i>
                      : <i title="Esta peça não foi embaralhada: ou saiu do deck depois da busca de combos, ou a base local não conhece a carta.">fora da mesa</i>}
                  </span>
                </>
              ))}
              {/* Peça GENÉRICA ("uma criatura com vigilância") é critério, não
                  carta: não tem zona porque não tem uma carta pra procurar. */}
              {((c2.requer || []) as string[]).map((r) => (
                <>
                  <span class="mais">+</span>
                  <span class="gf-peca generica" title="Critério, não carta: qualquer carta do deck que se encaixe serve.">{r}</span>
                </>
              ))}
            </div>
            {needs.length > 0 && (
              <div class="gf-combo-precisa">{needs.map((n, i) => <>{i > 0 && <br />}{n}</>)}</div>
            )}
            {combo.produz && combo.produz.length > 0 && <div class="gf-combo-produz">{combo.produz.join(", ")}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* O texto do painel: o que decide a jogada — custo, tipo, oracle e corpo.
   Edição, preço e ambientação ficam na modal "Ver a carta". Antes do
   detalhe da Scryfall o painel mostra o que a carta já traz; carta de duas
   faces vem da base com o texto emendado por "//", e com o detalhe ganha uma
   face por bloco. */
function CardDetail() {
  useTable();
  const d = detail.value;
  const c = d ? cardByUid(d.uid) : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  // Marca se ainda há texto embaixo do que está à vista. É o que acende a
  // franja no pé do painel flutuante — lá a barra de rolagem fica escondida,
  // e sem nenhum sinal a pessoa não tem como saber que a carta continua.
  const measure = () => {
    const body = bodyRef.current;
    if (!body) return;
    const end = body.scrollHeight - body.clientHeight;
    setMore(end > 1 && body.scrollTop < end - 1);
  };
  useLayoutEffect(measure);
  const art = c ? tableArt(c) : "";
  const card = c?.card || { nome: "" };
  const faces: Face[] = d?.data?.faces?.length ? d.data.faces : [{
    nome: card.nome, mana_cost: card.mana_cost, tipo: card.tipo, texto: card.texto as string,
    poder: (card.poder as string) || null, resistencia: (card.resistencia as string) || null,
  }];
  return (
    <aside class={"gf-detalhe" + (c ? " mostra" : "") + (d?.floats ? " flutua" : "") + (more ? " tem-mais" : "")}
           id="gf-detalhe" aria-hidden="true" style={{ left: d?.left || "" }}>
      <img id="gf-detalhe-arte" class={art ? undefined : "vazia"} src={art || undefined} alt="" referrerpolicy="no-referrer" />
      <div id="gf-detalhe-corpo" ref={bodyRef} onScroll={measure}>
        {c && (
          <>
            <div class="gf-detalhe-topo"><b>{card.nome || ""}</b><ManaCost cost={card.mana_cost} /></div>
            <CardStatus c={c} />
            {faces.map((f) => <DetailFace f={f} withName={faces.length > 1} />)}
            <CardCombos c={c} />
          </>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------ a coluna: combos e log */

/* Uma linha só sobre os combos, na coluna. O selo da carta é silencioso, e
   silêncio não distingue "este deck não tem combo" de "ninguém procurou" —
   são opostos que se parecem numa mesa sem marca nenhuma. */
function CombosNote({ m, online }: { m: Table | null; online: boolean }) {
  if (!m) return <div class="gf-nota-combos" id="gf-nota-combos" />;
  if (!state.combos) {
    return (
      <div class="gf-nota-combos" id="gf-nota-combos">A mesa marca as peças de combo nas cartas — procure os
        combos do deck na aba <b>Combos</b> pra ligar as marcas.</div>
    );
  }
  const n = (state.combos.no_deck || []).length;
  // As duas ressalvas são sobre o que a marcação NÃO cobre, e nenhuma delas
  // dá pra deduzir olhando a mesa.
  const caveats: string[] = [];
  if (state.combosSignature !== deckSignature()) caveats.push("o deck mudou desde a busca");
  if (m.players.length > 1) caveats.push(online ? "os decks dos outros não foram perguntados" : "o segundo deck não foi perguntado");
  return (
    <div class="gf-nota-combos" id="gf-nota-combos">
      {n ? <><b>{n}</b> combo(s) do deck — as peças estão marcadas nas cartas.</>
        : "O Spellbook não achou combo fechado neste deck."}
      {caveats.length > 0 && ` ${caveats.join("; ")}.`}
    </div>
  );
}

/* O log fica fechado, e aberto continua aberto: ele é conferência depois do
   fato ("em que turno eu baixei aquilo?"), não o assunto da tela — por isso
   mora na coluna do painel, e não embaixo da mesa. */
function Log({ m }: { m: Table | null }) {
  return (
    <div class="gf-log" id="gf-log">
      {m && m.log.length > 0 && (
        <>
          <button class="gf-log-cabeca" aria-expanded={m.logOpen} onClick={toggleLog}>
            <SpriteIcon name={m.logOpen ? "caret-down" : "caret-right"} /> Log da partida <b>{m.log.length}</b></button>
          {m.logOpen && (
            <ol class="gf-log-lista">
              {m.log.slice().reverse().map((l) => <li><span class="gf-log-t">T{l.turn}</span> {l.text}</li>)}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function turnTitle(m: Table) {
  const p = m.players[m.active];
  const whose = m.players.length > 1 ? ` · vez de ${p.name}` : "";
  if (p.phase !== "jogo" && m.turn === 1) return (p.mulligans ? `Mulligan ${p.mulligans}` : "Mão de abertura") + whose;
  return `Turno ${m.turn}${whose}`;
}

/* ------------------------------------------------------------ o painel */

/* A ajuda da mesa: o aviso de que aqui não tem juiz, o que o clique faz em
   cada zona e os atalhos. Mora no "?" do título — é consulta, e na coluna
   ela ocupava o lugar da carta o tempo todo. */
function Help() {
  return (
    <span class="gf-dica">
      <button class="gf-dica-botao" type="button" aria-label="Como a mesa funciona" aria-describedby="gf-aviso">
        <SpriteIcon name="question" /></button>
      <span class="gf-dica-texto" role="tooltip" id="gf-aviso">
        Aqui não tem juiz: nada impede de baixar dois terrenos no mesmo turno nem de jogar uma carta de 8 manas no
        turno 1. O que se mede aqui é a <b>mão</b>, não a legalidade.
        <span class="gf-dica-secao">O clique</span>
        <span class="gf-dica-lista">
          <span><SpriteIcon name="hand" /> na mão: <b>baixa</b> a carta</span>
          <span><SpriteIcon name="cards" /> no campo: <b>deita / endireita</b></span>
          <span><SpriteIcon name="crown-simple" /> no comando: <b>lança</b> o comandante</span>
          <span><SpriteIcon name="stack" /> no deck: <b>compra</b> uma</span>
          <span><SpriteIcon name="dots-three" /> botão direito ou ⋯: todas as outras ações. Arrastar também
            leva a carta pra outra zona.</span>
        </span>
        <span class="gf-dica-secao">Atalhos</span>
        <span class="gf-dica-lista">
          <span><kbd>D</kbd> comprar · <kbd>Espaço</kbd> passar turno · <kbd>Ctrl</kbd>+<kbd>Z</kbd> desfazer</span>
          <span><kbd>Shift</kbd>+clique no − e + anda de 5 em 5</span>
        </span>
      </span>
    </span>
  );
}

/* Um botão da parte de "mesa" da barra de cima: ícone com o nome ao lado,
   e o nome some em tela estreita (o `title` e o `aria-label` ficam). */
function ToolButton({ id, icon, label, title, disabled, onClick }: {
  id: string; icon: string; label: string; title?: string; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button class="btn gf-ferramenta" id={id} disabled={disabled} title={title || label} aria-label={label} onClick={onClick}>
      <SpriteIcon name={icon} /><span class="rotulo">{label}</span></button>
  );
}

/* A barra de cima em duas metades. À esquerda o JOGO — de quem é a vez,
   passar, desfazer (com a jogada que ele desfaria). À direita a MESA — o
   resumo, o segundo deck, online, tela cheia e partida nova —, que se usa
   uma vez por partida e por isso fala baixo. */
export function GoldfishPanel() {
  const m = useTable();
  useEffect(bindTableDocument, []);
  const two = !!m && m.players.length > 1;
  const o = online.value;
  const canUndo = o ? o.canUndo : state.tableUndo.length > 0;
  const deciding = !!m && m.players[m.active].phase !== "jogo";
  const last = m?.log.at(-1)?.text;
  return (
    <>
      <div class="gf-topo">
        <h2 class="secao" style={{ margin: 0 }}>Goldfish</h2>
        <Help />
        <span class="gf-turno" id="gf-turno">{m ? turnTitle(m) : ""}</span>
        <button class="btn ouro" id="gf-passar" disabled={!m || deciding || (!!o && m.active !== o.seat)}
                title={deciding ? "Decida a mão antes de passar o turno" : "Passar turno (Espaço)"} onClick={passTheTurn}>
          Passar turno <SpriteIcon name="skip-forward" /></button>
        <button class="btn" id="gf-desfazer" disabled={!canUndo} onClick={undoTable}
                title={o ? "Desfaz a sua última jogada, se ninguém jogou depois (Ctrl+Z)" : "Desfaz a última jogada (Ctrl+Z)"}>
          <SpriteIcon name="arrow-counter-clockwise" /> Desfazer</button>
        {m && last && <span class="gf-ultima" title={"Última jogada: " + last}>{last}</span>}
        <span class="gf-espaco" />
        {/* O segundo deck e o resumo do fim são da mesa local: online, quem
            senta é gente, e o resumo leria o baralho que ninguém vê. */}
        {!o && (
          <>
            <ToolButton id="gf-encerrar" icon="chart-bar" label="Resumo" disabled={!m}
                        title="Resumo da partida: comandante, curva realizada e o que não foi puxado"
                        onClick={() => openTableModal({ kind: "summary" })} />
            <ToolButton id="gf-segundo" icon="users" label={two ? "Tirar o 2º deck" : "Segundo deck"} disabled={!m}
                        title={two ? "Tira o outro deck da mesa e volta ao goldfish solo" : "Põe um deck seu do outro lado da mesa"}
                        onClick={secondDeckButton} />
            <ToolButton id="gf-online" icon="globe" label="Jogar online"
                        title="Abre uma mesa pra jogar com outras pessoas, cada uma no seu navegador" onClick={startOnline} />
          </>
        )}
        <ToolButton id="gf-tela" icon={fullscreen.value ? "corners-in" : "corners-out"}
                    label={fullscreen.value ? "Sair da tela cheia" : "Tela cheia"}
                    onClick={() => setFullscreen(!fullscreen.value)} />
        {/* Sem mesa, embaralhar é O botão; com mesa, recomeçar é o último
            recurso — e pede confirmação (ver `shuffleUp`). */}
        {(m || o) && (
          <button class={"btn" + (!m ? " ouro" : "")} id="gf-embaralhar" onClick={shuffleUp}
                  disabled={!!o && (o.seat === null || !m)}
                  title={o ? "Partida nova pra mesa inteira, com os decks como estão salvos" : "Embaralhar de novo e começar outra partida"}>
            <SpriteIcon name="shuffle" /> {o ? "Recomeçar" : "Nova partida"}</button>
        )}
      </div>
      <OnlineStrip />

      <div class="gf-area">
        <TableView />
        <div class="gf-coluna">
          <CardDetail />
          <CombosNote m={m} online={!!o} />
          <Log m={m} />
        </div>
      </div>
    </>
  );
}
