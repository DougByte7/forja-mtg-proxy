/* O que a mesa abre por cima da página: o menu de uma carta (ou do deck, ou
   do marcador do jogador) e as quatro modais. Montado fora do painel, no fim
   do <body>, como o menu e a modal sempre estiveram: preso dentro da mesa, o
   `position:fixed` deles dependeria de nenhum ancestral criar um contexto
   novo. O menu da carta oferece TUDO de qualquer zona, de propósito,
   inclusive o que numa partida de verdade seria absurdo: aqui não tem juiz. */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { hasBack } from "../art";
import { openCard } from "../cardDetail";
import {
  attackers, CARD_COUNTERS, cardByUid, cardName, gameSummary, PLAYER_COUNTERS, ZONE_NAMES, zoneOf,
  type Action, type TokenModel, type Zone,
} from "../goldfish";
import { isOnline, online } from "../online";
import { state } from "../state";
import {
  closeTableMenu, closeTableModal, listDecks, makeToken, openTableModal, putSecondDeck, runMenuItem,
  savedTokens, sendFromSearch, tableMenu, tableModal, type DeckOption,
} from "../table";
import { deckTokens, tokenLabel } from "../tokens";
import { useTable } from "./Goldfish";

/* ------------------------------------------------------------------ menus */

/* Não deixa sair da tela por baixo nem pela direita. */
function useClampedPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    el.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  });
  return ref;
}

const askName = (question: string) => (prompt(question) || "").replace(/:/g, "").trim();

function CardMenu({ uid }: { uid: number }) {
  const c = cardByUid(uid);
  const zone = zoneOf(uid);
  if (!c) return null;
  const item = (label: string, action: Action, opts?: Parameters<typeof runMenuItem>[1]) => (
    <button onClick={() => runMenuItem(action, opts)}>{label}</button>
  );
  const enemies = attackers().filter((a) => a.owner !== c.owner);
  const counters = CARD_COUNTERS.concat(Object.keys(c.counters).filter((n) => !CARD_COUNTERS.includes(n)));
  const destinations = (["mao", "cemiterio", "exilio", "comando"] as Zone[])
    // Só comandante volta pro comando.
    .filter((z) => z !== zone && (z !== "comando" || c.commander));
  return (
    <>
      {zone === "campo" && (
        <>
          {item(c.tapped ? "Endireitar" : "Deitar", { type: "tap", uid })}
          {hasBack(c.card) && item(c.backUp ? "Virar pra frente" : "Virar pro verso", { type: "flip", uid })}
          {item(c.attacking ? "Não atacar" : "Atacar", { type: "attack", uid })}
          {enemies.length > 0 && (
            <>
              <div class="gf-menu-titulo">Bloquear</div>
              {enemies.map((a) => item((c.blocking === a.uid ? "✓ " : "") + cardName(a), { type: "block", uid, target: a.uid }))}
            </>
          )}
          <div class="gf-menu-titulo">Marcadores</div>
          {counters.map((name) => (
            <div class="gf-linha">
              <span>{name}</span>
              {item("−", { type: "cardCounter", uid, name, n: -1 }, { stay: true, gesture: `m${uid}${name}` })}
              <b>{c.counters[name] || 0}</b>
              {item("+", { type: "cardCounter", uid, name, n: 1 }, { stay: true, gesture: `m${uid}${name}` })}
            </div>
          ))}
          <button onClick={() => {
            const name = askName("Nome do marcador (ex.: veneno, tempo, munição):");
            if (name) runMenuItem({ type: "cardCounter", uid, name, n: 1 }, { stay: true });
          }}>Outro marcador…</button>
        </>
      )}

      <div class="gf-menu-titulo">Mandar pra</div>
      {/* O imposto é INFORMAÇÃO: a tela conta quantas vezes o comandante saiu
          da zona e diz quanto custaria a próxima. Não cobra nada. */}
      {zone === "comando" ? item("Campo (paga imposto)", { type: "cast", uid })
        : zone !== "campo" ? item("Campo", { type: "move", uid, to: "campo" }) : null}
      {destinations.map((z) => item(ZONE_NAMES[z], { type: "move", uid, to: z }))}
      {zone !== "baralho" && (
        <>
          {item("Topo do baralho", { type: "move", uid, to: "baralho", toTop: true })}
          {item("Fundo do baralho", { type: "move", uid, to: "baralho", toTop: false })}
        </>
      )}
      <div class="gf-menu-titulo">Esta carta</div>
      {item(c.faceDown ? "Desvirar" : "Virar pra baixo", { type: "faceDown", uid })}
      {!c.token && <button onClick={() => { closeTableMenu(); openCard(c.card); }}>Ver a carta</button>}
    </>
  );
}

/* Menu de marcador do JOGADOR: veneno, energia e experiência são os três que
   o formato usa; o resto entra pelo nome. */
function CounterMenu({ player }: { player: number }) {
  const pick = (name: string) => {
    closeTableMenu();
    if (name) runMenuItem({ type: "playerCounter", player, name, n: 1 });
  };
  return (
    <>
      {PLAYER_COUNTERS.map((n) => <button onClick={() => pick(n)}>{n}</button>)}
      <button onClick={() => pick(askName("Nome do marcador:"))}>outro…</button>
    </>
  );
}

/* O menu do deck: comprar ou buscar. Os dois vêm juntos porque é o mesmo
   gesto de mesa — a mão vai no baralho. */
function DeckMenu({ player }: { player: number }) {
  return (
    <>
      <button onClick={() => runMenuItem({ type: "draw", player, n: 1 })}>Comprar 1</button>
      <button onClick={() => { closeTableMenu(); openTableModal({ kind: "search", player, zone: "baralho" }); }}>
        Buscar no deck</button>
    </>
  );
}

export function TableMenuView() {
  useTable();
  const menu = tableMenu.value;
  const ref = useClampedPosition(menu?.x || 0, menu?.y || 0);
  if (!menu) return null;
  return (
    <div class="gf-menu" ref={ref}>
      {menu.kind === "card" ? <CardMenu uid={menu.uid} />
        : menu.kind === "counter" ? <CounterMenu player={menu.player} />
        : <DeckMenu player={menu.player} />}
    </div>
  );
}

/* ----------------------------------------------------------------- modais */

/* Clique no fundo fecha; dentro da caixa, não. É o gesto de toda modal desta
   página. */
function Modal({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="gf-modal-fundo" onClick={(e) => { if (e.target === e.currentTarget) closeTableModal(); }}>
      <div class="gf-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div class="gf-modal-topo">
          <h3>{title}</h3>
          <span class="gf-espaco" />
          <button class="mini sai" data-gf-fechar title="Fechar" aria-label="Fechar" onClick={closeTableModal}>✕</button>
        </div>
        <div class="gf-modal-corpo">{children}</div>
      </div>
    </div>
  );
}

/* A busca é a mesma tela pras três zonas, e a diferença mora numa linha: sair
   do baralho reembaralha (ver `closeTableModal`). */
function SearchZone({ player, zone }: { player: number; zone: Zone }) {
  useTable();
  const [term, setTerm] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const p = state.table!.players[player];
  const destinations = (["mao", "campo", "cemiterio", "exilio"] as Zone[]).filter((z) => z !== zone);
  const t = term.trim().toLowerCase();
  // Online, a carta que este assento não vê chega sem carta (ver
  // `online.ts`): a virada no exílio de alguém não entra na lista, e o
  // baralho só aparece quando a sala responde que a busca começou.
  const opening = isOnline() && zone === "baralho" && !online.value?.looking;
  const cards = p[zone].filter((c) => c.card && cardName(c).toLowerCase().includes(t))
    .sort((a, b) => cardName(a).localeCompare(cardName(b)));
  return (
    <Modal title={`${ZONE_NAMES[zone]} de ${p.name}`}>
      <input class="campo gf-filtro" id="gf-busca-filtro" ref={input} autocomplete="off" spellcheck={false}
             placeholder="filtrar pelo nome…" onInput={(e) => setTerm(e.currentTarget.value)} />
      <div class="gf-lista" id="gf-busca-lista">
        {opening ? <div class="gf-vazio">abrindo o baralho…</div>
          : !cards.length ? <div class="gf-vazio">nada aqui</div> : cards.map((c) => (
          <div class="gf-lista-linha" key={c.uid}>
            <span class="gf-lista-nome" title={c.card?.tipo || ""}>{cardName(c)}</span>
            {destinations.map((z) => (
              <button class="mini" data-gf-manda={`${c.uid}:${z}`} onClick={() => sendFromSearch(c.uid, z)}>{ZONE_NAMES[z]}</button>
            ))}
          </div>
        ))}
      </div>
      {zone === "baralho" && <p class="nota">Ao fechar, o baralho é reembaralhado.</p>}
    </Modal>
  );
}

type LabeledModel = TokenModel & { rotulo: string };

function TokenMaker({ player }: { player: number }) {
  // As fichas que o DECK cria já foram lidas da base pela aba Tokens: são elas
  // que a partida vai precisar, e vêm com arte.
  const fromDeck: LabeledModel[] = deckTokens().map((f) => ({
    nome: f.nome, tipo: f.tipo, poder: f.poder as string, resistencia: f.resistencia as string,
    imagem: f.imagem, chaveArte: f.chaveArte, rotulo: tokenLabel(f),
  }));
  const saved: LabeledModel[] = savedTokens().map((m) => ({ ...m, rotulo: (m.nome || "") + (m.poder ? ` ${m.poder}/${m.resistencia}` : "") }));
  const [colors, setColors] = useState<string[]>([]);
  const form = useRef<HTMLDivElement>(null);
  const value = (id: string) => (form.current!.querySelector<HTMLInputElement>("#" + id)!.value || "").trim();
  const create = () => {
    const model: TokenModel = {
      nome: value("gf-f-nome") || "Ficha",
      tipo: value("gf-f-tipo") || "Token Creature",
      poder: value("gf-f-p"),
      resistencia: value("gf-f-r"),
      cores: colors,
    };
    makeToken(player, model, value("gf-f-n"), true);
  };
  const chips = (list: LabeledModel[]) => (
    <div class="gf-chips">
      {list.map((m) => <button class="chip" onClick={() => makeToken(player, m, 1)}>{m.rotulo}</button>)}
    </div>
  );
  return (
    <Modal title="Criar ficha">
      {fromDeck.length > 0 && <><div class="gf-secao">As que este deck cria</div>{chips(fromDeck)}</>}
      {saved.length > 0 && <><div class="gf-secao">Salvas neste navegador</div>{chips(saved)}</>}
      <div class="gf-secao">Montar uma</div>
      <div ref={form}>
        <div class="gf-forma">
          <label>Nome <input class="campo" id="gf-f-nome" defaultValue="Ficha" maxlength={40} /></label>
          <label>Tipo <input class="campo" id="gf-f-tipo" defaultValue="Token Creature" maxlength={60} /></label>
          <label>Poder <input class="campo curto" id="gf-f-p" defaultValue="1" maxlength={3} /></label>
          <label>Resistência <input class="campo curto" id="gf-f-r" defaultValue="1" maxlength={3} /></label>
          <label>Quantas <input class="campo curto" id="gf-f-n" defaultValue="1" maxlength={2} /></label>
        </div>
      </div>
      <div class="gf-cores-escolha" id="gf-f-cores">
        {["W", "U", "B", "R", "G"].map((c) => (
          <button class={"gf-cor-btn" + (colors.includes(c) ? " ativa" : "")} data-gf-cor={c}
                  onClick={() => setColors(colors.includes(c) ? colors.filter((x) => x !== c) : [...colors, c])}>
            <span class={"pip " + c} />
          </button>
        ))}
      </div>
      <div class="gf-acoes"><button class="btn ouro" id="gf-f-criar" onClick={create}>Criar</button></div>
    </Modal>
  );
}

function DeckRow({ d }: { d: DeckOption }) {
  const [loading, setLoading] = useState(false);
  return (
    <div class="gf-lista-linha">
      <span class="gf-lista-nome">{d.nome}</span>
      <span class="gf-lista-de">{d.de}</span>
      <button class="mini" data-gf-deck={d.id} disabled={loading} onClick={async () => {
        setLoading(true);
        if (!(await putSecondDeck(d.id))) setLoading(false);
      }}>{loading ? "Carregando…" : "Pôr na mesa"}</button>
    </div>
  );
}

function SecondDeck() {
  const [decks, setDecks] = useState<DeckOption[] | null>(null);
  useEffect(() => { listDecks().then(setDecks); }, []);
  return (
    <Modal title="Segundo deck">
      {decks === null ? <div class="nota">Procurando seus decks…</div>
        : decks.length ? (
          <>
            <div class="gf-lista">{decks.map((d) => <DeckRow key={d.id} d={d} />)}</div>
            <p class="nota">O segundo deck entra na mesa que já está rolando, com a mão dele e o mulligan dele.
              Nada disto é salvo em nenhum dos dois.</p>
          </>
        ) : (
          <div class="gf-vazio">Nenhum deck salvo por aqui ainda. Monte e salve um deck (ou entre na sua conta) e
            ele aparece nesta lista.</div>
        )}
    </Modal>
  );
}

const BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7+"];

function Bars({ curve, max }: { curve: number[]; max: number }) {
  return (
    <div class="gf-curva">
      {curve.map((n, i) => (
        <div class="barra" title={`${n} carta(s) de custo ${BUCKETS[i]}`}>
          <span class="qt">{n || ""}</span>
          <div class="haste" style={{ height: `${max ? (n / max) * 100 : 0}%` }} />
          <span class="cmc">{BUCKETS[i]}</span>
        </div>
      ))}
    </div>
  );
}

function Summary() {
  return (
    <Modal title="Como foi a partida">
      {gameSummary().map((r) => {
        const max = Math.max(1, ...r.deckCurve, ...r.playedCurve);
        return (
          <div class="gf-resumo-bloco">
            <div class="gf-secao">{r.name}</div>
            <ul class="gf-fatos">
              <li>Comandante desceu {r.commanderTurn === null ? <b>nunca</b> : <>no turno <b>{r.commanderTurn}</b></>}</li>
              <li>Terrenos jogados: <b>{r.landsPlayed}</b></li>
              <li>Feitiços jogados: <b>{r.spellsPlayed}</b> de {r.spellsInDeck}</li>
              <li>Vida no fim: <b>{r.life}</b></li>
              <li>Nunca puxadas: <b>{r.neverDrawn}</b></li>
            </ul>
            <div class="gf-duas-curvas">
              <div><span class="gf-legenda">Curva do deck</span><Bars curve={r.deckCurve} max={max} /></div>
              <div><span class="gf-legenda">O que desceu</span><Bars curve={r.playedCurve} max={max} /></div>
            </div>
            <details class="gf-nao-puxadas"><summary>As que ficaram no baralho</summary>
              <p>{r.remaining.join(", ") || "nenhuma"}</p></details>
          </div>
        );
      })}
      <p class="nota">A curva do deck conta as cartas que não são terreno nem comandante; a de baixo conta o que de
        fato desceu pro campo. A mesa continua aí — fechar isto não encerra nada.</p>
    </Modal>
  );
}

export function TableModalView() {
  useTable();
  const modal = tableModal.value;
  if (!modal || (modal.kind !== "second" && !state.table)) return null;
  switch (modal.kind) {
    case "search": return <SearchZone player={modal.player} zone={modal.zone} />;
    case "token": return <TokenMaker player={modal.player} />;
    case "second": return <SecondDeck />;
    case "summary": return <Summary />;
  }
}

export function TableOverlays() {
  return (
    <>
      <TableMenuView />
      <TableModalView />
    </>
  );
}
