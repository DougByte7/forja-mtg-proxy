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
import { COLOR_NAMES, COLORS, deckRevision, state } from "../state";
import {
  bindTableDocument, changeCommanderDamage, changeLife, changePlayerCounter, clickCard, detail,
  endCombat, fullscreen, keep, mulligan, onTableDragEnd, onTableDragOver, onTableDragStart,
  onTableDrop, openTableModal, openTableMenu, passTheTurn, secondDeckButton, setFullscreen,
  shuffleUp, tableRevision, tapFromIcon, toggleLog, undoTable,
} from "../table";
import { ManaCost, ManaText } from "./Mana";

/** A mesa, de dentro de um componente: redesenha a cada jogada e a cada
    mudança do deck (as artes e os combos da mesa vêm dele). */
export function useTable() {
  void tableRevision.value;
  void deckRevision.value;
  return state.mesa;
}

/* A arte de uma carta da mesa: a escolhida no deck DO DONO, e a padrão quando
   não há. O dono importa com dois decks na mesa — o Sol Ring de um não pode
   aparecer com a arte que o outro escolheu. A face é a que está pra cima
   (ver `toggleFace`). */
function tableArt(c: TableCard) {
  return faceImage(c.carta || { nome: "" }, c.verso ? "verso" : "frente", 0, playerArts(c.dono) as any);
}

/* Cada selo diz a quantidade e o nome ("5: +1/+1"): marcador de Magic é
   lista aberta, e uma sigla de uma letra confunde "tempo" com "tesouro". */
function CardCounters({ c }: { c: TableCard }) {
  const names = Object.keys(c.marcas || {});
  if (!names.length) return null;
  // Três cabem; a quarta viraria tarja sobre a arte. O `title` lista todas.
  return (
    <span class="gf-marcas" title={names.map((n) => `${n}: ${c.marcas[n]}`).join(", ")}>
      {names.slice(0, 3).map((n) => <span class="gf-marca-b">{`${c.marcas[n]}: ${n}`}</span>)}
    </span>
  );
}

/* Nenhuma carta da mesa usa a prévia que segue o mouse: a carta aparece no
   painel (ver `showDetail`), e as duas juntas mostrariam a mesma carta duas
   vezes. */
function TableCardButton({ c, zone }: { c: TableCard; zone: Zone }) {
  const card = c.carta || { nome: "" };
  const art = c.virada ? "" : tableArt(c);
  const cls = ["gf-carta"];
  if (c.deitada) cls.push("deitada");
  if (c.virada) cls.push("virada");
  if (c.atacando) cls.push("atacando");
  if (c.bloqueando) cls.push("bloqueando");
  if (c.ficha) cls.push("ficha");
  // A carta que é peça de combo se anuncia SEM hover: o painel responde
  // "quais combos", mas ninguém passa o mouse numa carta que não deu sinal de
  // ter o que contar. Carta virada pra baixo não ganha selo — ela está
  // escondida, e o selo a entregaria.
  const combos = c.virada ? 0 : comboCount(c);
  return (
    <button class={cls.join(" ")} data-gf-uid={c.uid} draggable title={card.nome || ""}
            style={art ? { backgroundImage: `url('${art}')` } : undefined}
            onClick={(e) => clickCard(c.uid, e.currentTarget)}>
      <CardCounters c={c} />
      {combos > 0 && <span class="gf-combo-selo" title={`Peça de ${combos} combo(s) do deck`}>{combos}</span>}
      {c.atacando ? <span class="gf-combate" title="Atacando">⚔</span>
        : c.bloqueando ? <span class="gf-combate" title={"Bloqueia " + cardName(cardByUid(c.bloqueando))}>🛡</span>
        : null}
      {/* Só a mão leva o nome: é onde a decisão acontece. Ficha inventada na
          hora não tem arte: o nome dentro do quadro é tudo o que ela tem. */}
      {(zone === "mao" || (c.ficha && !art)) && (
        <span class="gf-nome">{(card.nome || "") + (c.ficha && card.poder ? ` ${card.poder}/${card.resistencia}` : "")}</span>
      )}
      {/* Deitar e endireitar é o gesto que mais se repete na mesa, e o ícone
          faz no lugar, em um clique. É um `span` porque a carta já é o botão,
          e botão dentro de botão é HTML inválido: quem chega pelo teclado
          continua pelo menu, que é onde o item existe com nome. */}
      {zone === "campo" && (
        <span class="gf-tap" data-gf-tap={c.uid} aria-hidden="true" title={c.deitada ? "Endireitar" : "Deitar"}
              onClick={(e) => { e.stopPropagation(); tapFromIcon(c.uid); }}>{c.deitada ? "↺" : "↻"}</span>
      )}
    </button>
  );
}

function Row({ cards, zone }: { cards: TableCard[]; zone: Zone }) {
  return <div class="gf-fila">{cards.map((c) => <TableCardButton key={c.uid} c={c} zone={zone} />)}</div>;
}

const Count = ({ name, n }: { name: string; n: number }) => <>{name} <b>{n}</b></>;
const Empty = ({ text }: { text: string }) => <div class="gf-vazio">{text}</div>;

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

/* Criaturas de um lado, o resto do outro: quem olha um tabuleiro procura uma
   coisa de cada vez ("tenho bicho pra atacar?"), e misturadas cada pergunta
   vira busca visual. Lado a lado, e não empilhadas, pra o campo ter a altura
   de uma carta só. Cada lado cresce na proporção das cartas que tem. A ordem
   dentro de cada lado é a que a pessoa arrumou (ver `reposition`). */
function Battlefield({ p, ij }: { p: Player; ij: number }) {
  const side = (name: string, list: TableCard[], empty: string) => (
    <div class="gf-lado" style={{ flexGrow: Math.max(1, list.length) }}>
      <div class="gf-area-titulo"><Count name={name} n={list.length} /></div>
      <div class="gf-area-corpo">{list.length ? <Row cards={list} zone="campo" /> : <Empty text={empty} />}</div>
    </div>
  );
  return (
    <div class="gf-area-mesa gf-batalha" data-gf-solta="campo" data-gf-j={ij}>
      {side("Criaturas", p.campo.filter((c) => fieldRow(c) === "Criaturas"), "nenhuma criatura")}
      {side("Outros", p.campo.filter((c) => fieldRow(c) === "Outros"), "nada mais em jogo")}
    </div>
  );
}

/* Terrenos iguais viram um MONTE: as cartas sobrepostas, cada uma mostrando
   uma tira, e a quantidade no canto. Igual quer dizer mesmo nome E mesmo
   estado — deitar uma Floresta a tira do monte das em pé e a põe no das
   deitadas, que é a pergunta que se faz ao terreno ("quantas ainda posso
   usar?"). Cada carta continua sendo o seu botão: o menu, o arrastar e o
   painel não sabem que o monte existe. */
function Piles({ lands }: { lands: TableCard[] }) {
  const piles = new Map<string, TableCard[]>();
  for (const c of lands) {
    const key = [cardName(c), c.deitada, c.virada, c.verso, c.ficha, c.atacando, c.bloqueando,
                 JSON.stringify(c.marcas)].join("|");
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key)!.push(c);
  }
  return (
    <div class="gf-fila">
      {[...piles.values()].map((pile) => pile.length === 1
        ? <TableCardButton key={pile[0].uid} c={pile[0]} zone="campo" />
        : (
          <div class="gf-monte" key={"monte" + pile[0].uid}>
            {pile.map((c) => <TableCardButton key={c.uid} c={c} zone="campo" />)}
            <span class="gf-monte-n" aria-hidden="true">×{pile.length}</span>
          </div>
        ))}
    </div>
  );
}

/* Terreno-criatura mora aqui: a primeira regra que casa ganha, e pra quem
   joga ele é o terreno que entrou no turno. */
function Lands({ p, ij }: { p: Player; ij: number }) {
  const lands = p.campo.filter((c) => fieldRow(c) === "Terrenos");
  return (
    <Area title={<Count name="Terrenos" n={lands.length} />} zone="campo" player={ij} cls="gf-terrenos">
      {lands.length ? <Piles lands={lands} /> : <Empty text="nenhum terreno" />}
    </Area>
  );
}

/* O comando fica ao lado dos terrenos porque é de onde se lança o comandante.
   O imposto é INFORMAÇÃO: quanto a próxima vez custaria, sem cobrar nada. */
function Command({ p, ij }: { p: Player; ij: number }) {
  const title = (
    <>
      <Count name="Comando" n={p.comando.length} />
      {p.impostoPago > 0 && <> <span class="gf-imposto" title="Custo a mais na próxima vez">+{p.impostoPago * 2}</span></>}
    </>
  );
  return (
    <Area title={title} zone="comando" player={ij} cls="gf-comando">
      {p.comando.length ? <Row cards={p.comando} zone="comando" /> : <Empty text="vazia" />}
    </Area>
  );
}

/* Baralho, cemitério e exílio são PILHAS: uma carta de largura, e o clique
   abre a zona inteira em vez de agir sobre a carta de cima. A de cima aparece
   (com o painel no hover e o arrastar, pra puxar de volta a última que caiu);
   o baralho aparece de costas, como na mesa. */
function Pile({ p, ij, zone, title, label, action, onOpen }: {
  p: Player; ij: number; zone: Zone; title: ComponentChildren; label: string; action: string;
  onOpen: (anchor: Element) => void;
}) {
  const list = p[zone];
  const top = zone === "baralho" ? null : list[0];
  const art = top && !top.virada ? tableArt(top) : "";
  const cls = ["gf-pilha"];
  if (!list.length) cls.push("vazia");
  else if (!art) cls.push("verso");
  return (
    <Area title={title} zone={zone} player={ij} cls={`gf-pilha-area gf-${zone}`}>
      <button class={cls.join(" ")} data-gf-acao={action} title={label} aria-label={label}
              data-gf-uid={top ? top.uid : undefined} draggable={top ? true : undefined}
              style={art ? { backgroundImage: `url('${art}')` } : undefined}
              onClick={(e) => onOpen(e.currentTarget)}>
        {list.length ? "" : "vazio"}
      </button>
    </Area>
  );
}

function HandSummary({ hand }: { hand: TableCard[] }) {
  if (!hand.length) return null;
  const r = handSummary(hand);
  // `title` em cada cor porque bolinha colorida sozinha não é informação
  // acessível — a mesma regra dos pips do resto da página.
  const pips = COLORS.filter((c) => r.cores[c]);
  return (
    <span class="gf-resumo">
      <span><b>{r.terrenos}</b> terreno(s)</span>
      {r.feiticos > 0 && (
        <span title="Média de custo do que não é terreno">
          <b>{r.custoMedio.toFixed(1).replace(".", ",")}</b> de custo médio</span>
      )}
      {pips.length > 0 && (
        <span class="gf-cores" title="Símbolos de cor que a mão pede">
          {pips.map((c) => <span class="gf-cor" title={COLOR_NAMES[c]}><span class={"pip " + c} />{r.cores[c]}</span>)}
        </span>
      )}
    </span>
  );
}

function MulliganNote({ p, ij }: { p: Player; ij: number }) {
  const bottom = bottomCountOnKeep(ij);
  // A compra do turno só vem pra quem está na vez (ver `keepHand`).
  const onTurn = state.mesa!.ativo === ij;
  const later = onTurn ? "" : " A compra do turno vem quando chegar a vez.";
  if (p.fase === "fundo") {
    return (
      <p class="nota">Escolha <b>{p.aFundo}</b> carta(s) pra mandar pro fundo do baralho — clique nelas, na
        ordem que quiser.{onTurn ? " Depois delas vem a compra do turno." : later}</p>
    );
  }
  return (
    <p class="nota">
      {p.mulligans === 0 ? "Mão de abertura." : `${p.mulligans}º mulligan.`} Se manter agora, {bottom
        ? <>devolve <b>{bottom}</b> carta(s) pro fundo{onTurn ? " e compra a do turno" : ""}</>
        : onTurn ? <>compra a do turno e fica com <b>{p.mao.length + 1}</b></>
        : <>fica com <b>{p.mao.length}</b></>}.{later}
    </p>
  );
}

/* A mão com o resumo no título: é o que se lê antes de decidir manter, e na
   linha do título ele não rouba altura da mesa. No mulligan, a escolha fica
   dentro da própria mão, em cima das cartas que ela julga. */
function Hand({ p, ij }: { p: Player; ij: number }) {
  return (
    <Area title={<><Count name="Mão" n={p.mao.length} /><HandSummary hand={p.mao} /></>} zone="mao" player={ij} cls="gf-area-mao">
      {p.fase !== "jogo" && (
        <div class="gf-mulligan">
          <MulliganNote p={p} ij={ij} />
          {p.fase !== "fundo" && (
            <div class="gf-acoes">
              <button class="btn ouro" data-gf-acao={`manter:${ij}`} onClick={() => keep(ij)}>Manter esta mão</button>
              <button class="btn" data-gf-acao={`mulligan:${ij}`} onClick={() => mulligan(ij)}>Mulligan</button>
            </div>
          )}
        </div>
      )}
      {p.mao.length ? <Row cards={p.mao} zone="mao" /> : <Empty text="mão vazia" />}
    </Area>
  );
}

/* Duas linhas numa grade de três colunas: comando, terrenos e exílio; deck,
   mão e cemitério. A grade é compartilhada pra as pilhas ficarem uma em cima
   da outra. No espelho, a linha da mão vai pra borda, como a do outro. */
function Zones({ p, ij, m, mirrored }: { p: Player; ij: number; m: Table; mirrored: boolean }) {
  const search = (zone: Zone) => () => openTableModal({ kind: "search", player: ij, zone });
  const lands = [
    <Command key="comando" p={p} ij={ij} />,
    <Lands key="terrenos" p={p} ij={ij} />,
    <Pile key="exilio" p={p} ij={ij} zone="exilio" title={<Count name="Exílio" n={p.exilio.length} />}
          label="Ver o exílio" action={`buscar:${ij}:exilio`} onOpen={search("exilio")} />,
  ];
  const hand = [
    // A tecla D compra pra quem está na vez: é nesse baralho que ela aparece.
    <Pile key="baralho" p={p} ij={ij} zone="baralho" label="Comprar ou buscar no deck" action={`deck:${ij}`}
          title={<><Count name="Deck" n={p.baralho.length} />{m.ativo === ij && <> <kbd title="Comprar">D</kbd></>}</>}
          onOpen={(anchor) => openTableMenu({ kind: "deck", player: ij }, anchor)} />,
    <Hand key="mao" p={p} ij={ij} />,
    <Pile key="cemiterio" p={p} ij={ij} zone="cemiterio" title={<Count name="Cemitério" n={p.cemiterio.length} />}
          label="Ver o cemitério" action={`buscar:${ij}:cemiterio`} onOpen={search("cemiterio")} />,
  ];
  return <div class="gf-zonas">{mirrored ? [...hand, ...lands] : [...lands, ...hand]}</div>;
}

/* Shift no clique anda de 5 em 5. */
function Step({ label, text, onStep }: { label: string; text: string; onStep: (times: number) => void }) {
  return (
    <button class="gf-passo" aria-label={label} title={`${label} (Shift: 5)`}
            onClick={(e) => onStep(e.shiftKey ? 5 : 1)}>{text}</button>
  );
}

/* Dano de comandante: só existe com dois decks na mesa. Sozinho, ele seria uma
   linha pra anotar o dano do próprio comandante em si mesmo. */
function CommanderDamage({ p, ij, m }: { p: Player; ij: number; m: Table }) {
  if (m.jogadores.length < 2) return null;
  return (
    <>
      {m.jogadores.map((other, io) => {
        if (io === ij) return null;
        const n = p.danoCmd[io] || 0;
        return (
          <span class={"gf-dano" + (n >= 21 ? " letal" : "")} title={`Dano do comandante de ${other.nome} — 21 mata`}>
            Cmd <Step label="Menos 1 de dano" text="−" onStep={(t) => changeCommanderDamage(ij, io, -t)} />
            <b>{n}</b>
            <Step label="Mais 1 de dano" text="+" onStep={(t) => changeCommanderDamage(ij, io, t)} />
          </span>
        );
      })}
    </>
  );
}

/* Fatos do tabuleiro, não conta de mana: quantos terrenos estão em pé e
   quantos deitados. Ver o cabeçalho de `goldfish.ts`. Os três ficam sempre,
   mesmo em zero, pra barra não mudar de largura a cada terreno. */
function BarLands({ p }: { p: Player }) {
  const lands = p.campo.filter((c) => isLand(c.carta));
  const up = lands.filter((c) => !c.deitada).length;
  const tapped = lands.length - up;
  return (
    <span class="gf-fatos-j">Terrenos <b>{up}</b> em pé · <b>{tapped}</b> {tapped === 1 ? "deitado" : "deitados"}{" "}
      <span title="Terrenos baixados neste turno">· Baixados <b>{p.terrenosBaixados}</b></span></span>
  );
}

/* A barra fica na borda de fora de cada jogador: embaixo de quem está
   embaixo e em cima de quem está em cima. À esquerda quem é e como está; à
   direita o que se cria na mesa. */
function Bar({ p, ij, m }: { p: Player; ij: number; m: Table }) {
  return (
    <div class="gf-barra">
      <b class="gf-nome-j" title={p.nome}>{p.nome}</b>
      {m.jogadores.length > 1 && m.ativo === ij && <span class="gf-vez">sua vez</span>}
      <span class="gf-vida">Vida{" "}
        <Step label="Menos 1 de vida" text="−" onStep={(t) => changeLife(ij, -t)} />
        <b>{p.vida}</b>
        <Step label="Mais 1 de vida" text="+" onStep={(t) => changeLife(ij, t)} />
      </span>
      <CommanderDamage p={p} ij={ij} m={m} />
      {Object.keys(p.marcas).map((name) => (
        <span class="gf-marca">
          {name}
          <button class="gf-passo" aria-label={`Menos 1 de ${name}`} onClick={() => changePlayerCounter(ij, name, -1)}>−</button>
          <b>{p.marcas[name]}</b>
          <button class="gf-passo" aria-label={`Mais 1 de ${name}`} onClick={() => changePlayerCounter(ij, name, 1)}>+</button>
        </span>
      ))}
      <span class="gf-divisor" aria-hidden="true" />
      <BarLands p={p} />
      <span class="gf-espaco" />
      <button class="gf-botao" data-gf-acao={`ficha:${ij}`}
              onClick={() => openTableModal({ kind: "token", player: ij })}>Criar ficha</button>
      <button class="gf-botao" data-gf-acao={`novaMarca:${ij}`} title="Pôr um marcador neste jogador"
              onClick={(e) => openTableMenu({ kind: "counter", player: ij }, e.currentTarget)}>Marcador</button>
    </div>
  );
}

/* De cima pra baixo, quem está embaixo: campo de batalha, as duas linhas de
   zonas e a barra. Quem está em cima tem a mesma ordem de baixo pra cima. */
function PlayerSection({ ij, m, mirrored }: { ij: number; m: Table; mirrored: boolean }) {
  const p = m.jogadores[ij];
  const parts = [
    <Battlefield key="campo" p={p} ij={ij} />,
    <Zones key="zonas" p={p} ij={ij} m={m} mirrored={mirrored} />,
    <Bar key="barra" p={p} ij={ij} m={m} />,
  ];
  if (mirrored) parts.reverse();
  const active = m.jogadores.length > 1 && m.ativo === ij;
  return (
    <section class={"gf-jogador" + (active ? " ativo" : "") + (mirrored ? " espelhado" : "")} data-gf-j={ij}>
      {parts}
    </section>
  );
}

function TableView() {
  const m = useTable();
  return (
    <div id="gf-mesa" onDragStart={onTableDragStart} onDragEnd={onTableDragEnd}
         onDragOver={onTableDragOver} onDrop={onTableDrop}>
      {!m ? (
        <div class="gf-vazio">Clique em <b>Embaralhar</b> pra começar. O comandante vai pra zona de comando; o
          sideboard e o maybeboard ficam de fora, como em toda análise desta tela.</div>
      ) : (
        // O segundo jogador vem primeiro: ele é o lado de cima da mesa espelhada.
        <div class={"gf-jogadores" + (m.jogadores.length > 1 ? " dois" : "")}>
          {(m.jogadores.length > 1 ? [1, 0] : [0]).map((ij) => (
            <PlayerSection key={ij} ij={ij} m={m} mirrored={m.jogadores.length > 1 && ij === 1} />
          ))}
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
  if (c.cmd) items.push("Comandante");
  if (c.ficha) items.push("Ficha");
  if (c.virada) items.push("Virada pra baixo");
  if (c.verso) items.push("Mostrando o verso");
  if (c.deitada) items.push("Deitada");
  if (c.atacando) items.push("Atacando");
  if (c.bloqueando) items.push("Bloqueia " + cardName(cardByUid(c.bloqueando)));
  for (const name of Object.keys(c.marcas || {})) items.push(`${name}: ${c.marcas[name]}`);
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
      {state.combosAssinatura !== deckSignature() && <div class="gf-combo-velho">O deck mudou desde a busca de combos.</div>}
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
  const card = c?.carta || { nome: "" };
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
function CombosNote({ m }: { m: Table | null }) {
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
  if (state.combosAssinatura !== deckSignature()) caveats.push("o deck mudou desde a busca");
  if (m.jogadores.length > 1) caveats.push("o segundo deck não foi perguntado");
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
          <button class="gf-log-cabeca" aria-expanded={m.logAberto} onClick={toggleLog}>
            {m.logAberto ? "▾" : "▸"} Log da partida <b>{m.log.length}</b></button>
          {m.logAberto && (
            <ol class="gf-log-lista">
              {m.log.slice().reverse().map((l) => <li><span class="gf-log-t">T{l.turno}</span> {l.texto}</li>)}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function turnTitle(m: Table) {
  const p = m.jogadores[m.ativo];
  const whose = m.jogadores.length > 1 ? ` · vez de ${p.nome}` : "";
  if (p.fase !== "jogo" && m.turno === 1) return (p.mulligans ? `Mulligan ${p.mulligans}` : "Mão de abertura") + whose;
  return `Turno ${m.turno}${whose}`;
}

/* ------------------------------------------------------------ o painel */

export function GoldfishPanel() {
  const m = useTable();
  useEffect(bindTableDocument, []);
  const two = !!m && m.jogadores.length > 1;
  const inCombat = !!m && (attackers().length > 0 || m.jogadores.some((p) => p.campo.some((c) => c.bloqueando)));
  return (
    <>
      <div class="gf-topo">
        <h2 class="secao" style={{ margin: 0 }}>Goldfish</h2>
        <span class="gf-dica">
          <button class="gf-dica-botao" type="button" aria-label="Sobre o goldfish" aria-describedby="gf-aviso">?</button>
          <span class="gf-dica-texto" role="tooltip" id="gf-aviso">Aqui não tem juiz: nada impede de baixar dois
            terrenos no mesmo turno nem de jogar uma carta de 8 manas no turno 1. O que se mede aqui é
            a <b>mão</b>, não a legalidade. Clique numa carta pra abrir o menu dela — ou arraste pra outra
            zona.</span>
        </span>
        <span class="gf-turno" id="gf-turno">{m ? turnTitle(m) : ""}</span>
        <button class="btn ouro" id="gf-passar" disabled={!m} title="Passar turno (Espaço)" onClick={passTheTurn}>Passar turno</button>
        <button class="btn" id="gf-fim-combate" hidden={!inCombat} onClick={endCombat}>Fim do combate</button>
        <span class="gf-espaco" />
        <button class="btn" id="gf-segundo" disabled={!m} onClick={secondDeckButton}
                title={two ? "Tira o outro deck da mesa e volta ao goldfish solo" : "Põe um deck seu do outro lado da mesa"}>
          {two ? "Tirar o 2º deck" : "Segundo deck"}</button>
        <button class="btn" id="gf-encerrar" disabled={!m} onClick={() => openTableModal({ kind: "summary" })}
                title="Resumo da partida: comandante, curva realizada e o que não foi puxado">Como foi</button>
        <button class="btn" id="gf-desfazer" title="Desfaz a última jogada (Ctrl+Z)"
                disabled={!state.mesaDesfazer.length} onClick={undoTable}>Desfazer</button>
        <button class="btn" id="gf-tela" onClick={() => setFullscreen(!fullscreen.value)}>
          {fullscreen.value ? "Sair da tela cheia" : "Tela cheia"}</button>
        <button class="btn ouro" id="gf-embaralhar" onClick={shuffleUp}>Embaralhar</button>
      </div>

      <div class="gf-area">
        <TableView />
        <div class="gf-coluna">
          <CardDetail />
          <CombosNote m={m} />
          <Log m={m} />
          <div class="gf-atalhos">
            <div class="gf-atalhos-titulo">Atalhos</div>
            <dl>
              <dt><kbd>D</kbd></dt><dd>Comprar</dd>
              <dt><kbd>Espaço</kbd></dt><dd>Passar turno</dd>
              <dt><kbd>Ctrl</kbd>+<kbd>Z</kbd></dt><dd>Desfazer</dd>
              <dt><kbd>Shift</kbd>+clique</dt><dd>Vida e dano de 5 em 5</dd>
            </dl>
          </div>
        </div>
      </div>
    </>
  );
}
