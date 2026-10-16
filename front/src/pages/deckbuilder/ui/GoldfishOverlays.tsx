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
  type Action, type TableCard, type TokenModel, type Zone,
} from "../goldfish";
import { isOnline, online } from "../online";
import { state } from "../state";
import {
  closeTableMenu, closeTableModal, drawCards, listDecks, makeToken, millCards, openTableModal, peekedCards,
  peekTop, putSecondDeck, runMenuItem, savedTokens, sendFromSearch, tableMenu, tableModal, type DeckOption,
  type Destination, type TableModal,
} from "../table";
import { deckTokens, tokenLabel } from "../tokens";
import { tableArt, useTable, ZONE_ICONS } from "./Goldfish";
import { ManaCost } from "./Mana";
import { SpriteIcon } from "./SpriteIcon";

/* ------------------------------------------------------------------ menus */

/* Não deixa sair da tela pela direita, e o menu que não cabe embaixo de quem
   o abriu sobe pra cima dele (`top`) — na mão, que mora no pé da tela, é
   quase sempre. Só quando não cabe de jeito nenhum ele é empurrado. */
function useClampedPosition(x: number, y: number, top: number) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - 8;
    const at = y + r.height <= room ? y : top - r.height >= 4 ? top - r.height : room - r.height;
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    el.style.top = Math.max(4, at) + "px";
  });
  return ref;
}

const cleanName = (name: string) => name.replace(/:/g, "").trim();

/* O nome de um marcador novo, dentro do próprio menu: o `prompt()` do
   navegador tirava a pessoa da mesa pra digitar uma palavra. */
function NewCounter({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const add = () => { const n = cleanName(name); if (n) { onAdd(n); setName(""); } };
  return (
    <form class="gf-menu-novo" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <input class="campo" value={name} maxLength={40} placeholder={placeholder} aria-label={placeholder}
             onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
      <button type="submit" class="gf-menu-icone" title="Pôr o marcador" aria-label="Pôr o marcador" disabled={!cleanName(name)}>
        <SpriteIcon name="plus" /></button>
    </form>
  );
}

/* Um botão de ícone da fila de ações rápidas do menu: o nome vai no `title`
   e no `aria-label`, e o ícone é o que se acha de relance. */
function QuickAction({ icon, label, on, onClick }: { icon: string; label: string; on?: boolean; onClick: () => void }) {
  return (
    <button class={"gf-menu-icone" + (on ? " ligado" : "")} title={label} aria-label={label} onClick={onClick}>
      <SpriteIcon name={icon} /></button>
  );
}

/* Os destinos de uma carta, numa grade de ícones com o nome embaixo: seis
   linhas de texto viravam o menu mais comprido da tela. */
function Destinations({ list }: { list: { icon: string; label: string; onClick: () => void; title?: string }[] }) {
  return (
    <div class="gf-destinos">
      {list.map((d) => (
        <button class="gf-destino" title={d.title || d.label} onClick={d.onClick}>
          <SpriteIcon name={d.icon} /><span>{d.label}</span></button>
      ))}
    </div>
  );
}

function CardMenu({ uid }: { uid: number }) {
  const c = cardByUid(uid);
  const zone = zoneOf(uid);
  if (!c || !zone) return null;
  const run = (action: Action, opts?: Parameters<typeof runMenuItem>[1]) => () => runMenuItem(action, opts);
  const enemies = attackers().filter((a) => a.owner !== c.owner);
  const counters = Object.keys(c.counters);
  const suggested = CARD_COUNTERS.filter((n) => !counters.includes(n));
  const stay = (name: string) => ({ stay: true, gesture: `m${uid}${name}` });

  const destinations: { icon: string; label: string; onClick: () => void; title?: string }[] = [];
  // O imposto é INFORMAÇÃO: a tela conta quantas vezes o comandante saiu da
  // zona e diz quanto custaria a próxima. Não cobra nada.
  if (zone === "comando") destinations.push({ icon: "cards", label: "Lançar", title: "Campo (conta o imposto)", onClick: run({ type: "cast", uid }) });
  else if (zone !== "campo") destinations.push({ icon: ZONE_ICONS.campo, label: "Campo", onClick: run({ type: "move", uid, to: "campo" }) });
  for (const z of ["mao", "cemiterio", "exilio", "comando"] as Zone[]) {
    // Só comandante volta pro comando.
    if (z === zone || (z === "comando" && !c.commander)) continue;
    destinations.push({ icon: ZONE_ICONS[z], label: ZONE_NAMES[z], onClick: run({ type: "move", uid, to: z }) });
  }
  if (zone !== "baralho") {
    destinations.push({ icon: "arrow-line-up", label: "Topo", title: "Topo do baralho", onClick: run({ type: "move", uid, to: "baralho", toTop: true }) });
    destinations.push({ icon: "arrow-line-down", label: "Fundo", title: "Fundo do baralho", onClick: run({ type: "move", uid, to: "baralho", toTop: false }) });
  }

  return (
    <>
      <div class="gf-menu-cabeca"><b>{cardName(c)}</b><ManaCost cost={c.card?.mana_cost} /></div>
      <div class="gf-menu-rapido">
        {zone === "campo" && (
          <>
            <QuickAction icon={c.tapped ? "arrow-counter-clockwise" : "arrow-clockwise"} label={c.tapped ? "Endireitar" : "Deitar"}
                         onClick={run({ type: "tap", uid })} />
            <QuickAction icon="sword" label={c.attacking ? "Não atacar" : "Atacar"} on={c.attacking}
                         onClick={run({ type: "attack", uid })} />
            {hasBack(c.card) && (
              <QuickAction icon="swap" label={c.backUp ? "Virar pra frente" : "Virar pro verso"} on={c.backUp}
                           onClick={run({ type: "flip", uid })} />
            )}
          </>
        )}
        {zone === "mao" && (
          <QuickAction icon="eye-slash" label="Baixar virada pra baixo" onClick={run({ type: "move", uid, to: "campo", faceDown: true })} />
        )}
        {zone !== "mao" && (
          <QuickAction icon={c.faceDown ? "eye" : "eye-slash"} label={c.faceDown ? "Desvirar" : "Virar pra baixo"} on={c.faceDown}
                       onClick={run({ type: "faceDown", uid })} />
        )}
        {!c.token && (
          <QuickAction icon="magnifying-glass" label="Ver a carta" onClick={() => { closeTableMenu(); openCard(c.card); }} />
        )}
      </div>

      {zone === "campo" && enemies.length > 0 && (
        <>
          <div class="gf-menu-titulo"><SpriteIcon name="shield" /> Bloquear</div>
          {enemies.map((a) => (
            <button class={"gf-menu-item" + (c.blocking === a.uid ? " ligado" : "")} onClick={run({ type: "block", uid, target: a.uid })}>
              {c.blocking === a.uid && <SpriteIcon name="check" />} {cardName(a)}</button>
          ))}
        </>
      )}

      {zone === "campo" && (
        <>
          <div class="gf-menu-titulo"><SpriteIcon name="hash" /> Marcadores</div>
          {counters.map((name) => (
            <div class="gf-linha">
              <span>{name}</span>
              <button aria-label={`Menos 1 de ${name}`} onClick={run({ type: "cardCounter", uid, name, n: -1 }, stay(name))}><SpriteIcon name="minus" /></button>
              <b>{c.counters[name]}</b>
              <button aria-label={`Mais 1 de ${name}`} onClick={run({ type: "cardCounter", uid, name, n: 1 }, stay(name))}><SpriteIcon name="plus" /></button>
            </div>
          ))}
          {suggested.length > 0 && (
            <div class="gf-menu-chips">
              {suggested.map((name) => (
                <button class="chip" onClick={run({ type: "cardCounter", uid, name, n: 1 }, stay(name))}>+ {name}</button>
              ))}
            </div>
          )}
          <NewCounter placeholder="outro (tempo, munição…)"
                      onAdd={(name) => runMenuItem({ type: "cardCounter", uid, name, n: 1 }, { stay: true })} />
        </>
      )}

      <div class="gf-menu-titulo">Mandar pra</div>
      <Destinations list={destinations} />
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
      <div class="gf-menu-titulo"><SpriteIcon name="hash" /> Marcador do jogador</div>
      {PLAYER_COUNTERS.map((n) => <button class="gf-menu-item" onClick={() => pick(n)}>{n}</button>)}
      <NewCounter placeholder="outro marcador" onAdd={pick} />
    </>
  );
}

/* O menu do deck: o clique nele já compra uma, e aqui fica o resto do que se
   faz com o baralho — com a quantidade escolhida uma vez pra todas as
   jogadas de N cartas (comprar, olhar, moer). */
function DeckMenu({ player }: { player: number }) {
  const [n, setN] = useState(1);
  const size = state.table?.players[player].baralho.length || 0;
  const max = Math.max(1, Math.min(20, size));
  const then = (fn: () => void) => () => { closeTableMenu(); fn(); };
  const many = n > 1 ? ` ${n}` : "";
  return (
    <>
      <div class="gf-menu-cabeca"><b>Deck</b><span class="gf-menu-sub">{size} carta(s)</span></div>
      <div class="gf-linha">
        <span>Quantas</span>
        <button aria-label="Menos uma" disabled={n <= 1} onClick={() => setN(Math.max(1, n - 1))}><SpriteIcon name="minus" /></button>
        <b>{n}</b>
        <button aria-label="Mais uma" disabled={n >= max} onClick={() => setN(Math.min(max, n + 1))}><SpriteIcon name="plus" /></button>
      </div>
      <button class="gf-menu-item" onClick={then(() => drawCards(player, n))}>
        <SpriteIcon name="hand-arrow-down" /> Comprar{many}</button>
      <button class="gf-menu-item" onClick={() => peekTop(player, n)}>
        <SpriteIcon name="eye" /> Olhar o topo{many}</button>
      <button class="gf-menu-item" onClick={then(() => millCards(player, n, "cemiterio"))}>
        <SpriteIcon name="skull" /> Moer{many} (pro cemitério)</button>
      <button class="gf-menu-item" onClick={then(() => millCards(player, n, "exilio"))}>
        <SpriteIcon name="prohibit" /> Exilar{many} do topo</button>
      <hr />
      <button class="gf-menu-item" onClick={() => { closeTableMenu(); openTableModal({ kind: "search", player, zone: "baralho" }); }}>
        <SpriteIcon name="magnifying-glass" /> Buscar no deck</button>
      <button class="gf-menu-item" onClick={then(() => runMenuItem({ type: "shuffle", player }))}>
        <SpriteIcon name="shuffle" /> Embaralhar</button>
    </>
  );
}

/* O menu anda pelas setas e começa com o foco no primeiro item: quem abriu
   pela tecla de menu continua no teclado. O Esc já fecha (ver `keyboard.ts`). */
function moveFocus(e: KeyboardEvent) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const menu = e.currentTarget as HTMLElement;
  const items = [...menu.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next].focus();
}

export function TableMenuView() {
  useTable();
  const menu = tableMenu.value;
  const ref = useClampedPosition(menu?.x || 0, menu?.y || 0, menu?.top || 0);
  const opened = menu ? `${menu.kind}:${"uid" in menu ? menu.uid : menu.player}` : "";
  useEffect(() => {
    if (opened) ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [opened]);
  if (!menu) return null;
  return (
    <div class="gf-menu" ref={ref} role="menu" onKeyDown={moveFocus}>
      {menu.kind === "card" ? <CardMenu uid={menu.uid} />
        : menu.kind === "counter" ? <CounterMenu player={menu.player} />
        : <DeckMenu player={menu.player} />}
    </div>
  );
}

/* ----------------------------------------------------------------- modais */

/* Clique no fundo fecha; dentro da caixa, não. É o gesto de toda modal desta
   página. O Tab dá a volta dentro da caixa: atrás dela a mesa continua, e o
   foco que escapa pra lá clica em carta sem ninguém ver. */
function Modal({ title, wide, footer, closeLabel, children }: {
  title: string; wide?: boolean; footer?: ComponentChildren; closeLabel?: string; children: ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);
  const trap = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = [...box.current!.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, summary")];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div class="gf-modal-fundo" onClick={(e) => { if (e.target === e.currentTarget) closeTableModal(); }}>
      <div class={"gf-modal" + (wide ? " larga" : "")} role="dialog" aria-modal="true" aria-label={title} ref={box} onKeyDown={trap}>
        <div class="gf-modal-topo">
          <h3>{title}</h3>
          <span class="gf-espaco" />
          <button class="mini sai" data-gf-fechar title={closeLabel || "Fechar"} aria-label={closeLabel || "Fechar"}
                  onClick={closeTableModal}><SpriteIcon name="x" /></button>
        </div>
        <div class="gf-modal-corpo">{children}</div>
        {footer && <div class="gf-modal-pe">{footer}</div>}
      </div>
    </div>
  );
}

const DESTINATION_INFO: Record<Destination, { icon: string; label: string }> = {
  mao: { icon: ZONE_ICONS.mao, label: "Mão" },
  campo: { icon: ZONE_ICONS.campo, label: "Campo" },
  cemiterio: { icon: ZONE_ICONS.cemiterio, label: "Cemitério" },
  exilio: { icon: ZONE_ICONS.exilio, label: "Exílio" },
  comando: { icon: ZONE_ICONS.comando, label: "Comando" },
  baralho: { icon: ZONE_ICONS.baralho, label: "Baralho" },
  topo: { icon: "arrow-line-up", label: "Topo do baralho" },
  fundo: { icon: "arrow-line-down", label: "Fundo do baralho" },
};

/* Uma carta numa modal de zona: a arte (é o que se reconhece numa busca, mais
   que o nome numa lista), o nome, e os destinos em ícones embaixo. */
function ZoneCard({ c, destinations, marked, position }: {
  c: TableCard; destinations: Destination[]; marked?: string; position?: number;
}) {
  const art = tableArt(c);
  return (
    <div class={"gf-busca-carta" + (marked ? " marcada" : "")}>
      <div class="gf-busca-arte" style={art ? { backgroundImage: `url('${art}')` } : undefined} title={c.card?.tipo || ""}>
        {position !== undefined && <span class="gf-busca-pos">{position}</span>}
        {marked && <span class="gf-busca-marca">{marked}</span>}
      </div>
      <span class="gf-busca-nome" title={cardName(c)}>{cardName(c)}</span>
      <div class="gf-busca-destinos">
        {destinations.map((z) => (
          <button class="mini" data-gf-manda={`${c.uid}:${z}`} title={DESTINATION_INFO[z].label} aria-label={DESTINATION_INFO[z].label}
                  onClick={() => sendFromSearch(c.uid, z)}><SpriteIcon name={DESTINATION_INFO[z].icon} /></button>
        ))}
      </div>
    </div>
  );
}

/* A busca é a mesma tela pras três zonas, e a diferença mora numa linha: sair
   do baralho reembaralha (ver `closeTableModal`) — e o botão de fechar diz
   isso, em vez de uma nota no rodapé que ninguém lê antes de fechar. */
function SearchZone({ modal }: { modal: Extract<TableModal, { kind: "search" }> }) {
  useTable();
  const { player, zone } = modal;
  const [term, setTerm] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const p = state.table!.players[player];
  const library = zone === "baralho";
  const destinations: Destination[] = (["mao", "campo", "cemiterio", "exilio"] as Destination[])
    .filter((z) => z !== zone).concat(library ? ["topo"] : ["topo", "fundo"]);
  const t = term.trim().toLowerCase();
  // Online, a carta que este assento não vê chega sem carta (ver
  // `online.ts`): a virada no exílio de alguém não entra na lista, e o
  // baralho só aparece quando a sala responde que a busca começou.
  const opening = isOnline() && library && !online.value?.looking;
  const cards = p[zone].filter((c) => c.card && cardName(c).toLowerCase().includes(t))
    .sort((a, b) => cardName(a).localeCompare(cardName(b)));
  const top = modal.keepTop || [];
  const footer = library ? (
    <>
      <span class="nota">{top.length ? `${top.length} carta(s) vão pro topo depois de embaralhar.` : "O baralho é reembaralhado ao fechar."}</span>
      <button class="btn ouro" onClick={closeTableModal}><SpriteIcon name="shuffle" /> Fechar e embaralhar</button>
    </>
  ) : undefined;
  return (
    <Modal title={`${ZONE_NAMES[zone]} de ${p.name}`} wide footer={footer}
           closeLabel={library ? "Fechar e embaralhar" : undefined}>
      <input class="campo gf-filtro" id="gf-busca-filtro" ref={input} autocomplete="off" spellcheck={false}
             placeholder="filtrar pelo nome…" onInput={(e) => setTerm(e.currentTarget.value)} />
      <div class="gf-busca-grade" id="gf-busca-lista">
        {opening ? <div class="gf-vazio">abrindo o baralho…</div>
          : !cards.length ? <div class="gf-vazio">nada aqui</div>
          : cards.map((c) => (
            <ZoneCard key={c.uid} c={c} destinations={destinations}
                      marked={top.includes(c.uid) ? `topo ${top.length - top.indexOf(c.uid)}º` : undefined} />
          ))}
      </div>
    </Modal>
  );
}

/* Olhar o topo: as cartas na ordem do baralho, numeradas de cima. "Topo"
   põe a carta em cima de todas — clicando na ordem inversa, a pessoa monta
   a ordem que quiser. Fechar NÃO embaralha: olhar e devolver é a jogada. */
function PeekTop({ modal }: { modal: Extract<TableModal, { kind: "peek" }> }) {
  useTable();
  const p = state.table!.players[modal.player];
  const cards = peekedCards(modal);
  const position = (c: TableCard) => p.baralho.indexOf(c) + 1;
  const opening = isOnline() && !cards.length && p.baralho.length > 0;
  return (
    <Modal title={`Topo do baralho de ${p.name}`} wide
           footer={<><span class="nota">Fechar deixa o baralho como está — sem embaralhar.</span>
             <button class="btn ouro" onClick={closeTableModal}><SpriteIcon name="check" /> Pronto</button></>}>
      <div class="gf-busca-grade">
        {opening ? <div class="gf-vazio">olhando o topo…</div>
          : !cards.length ? <div class="gf-vazio">nenhuma carta olhada continua no baralho</div>
          : cards.map((c) => (
            <ZoneCard key={c.uid} c={c} position={position(c)}
                      destinations={["topo", "fundo", "mao", "campo", "cemiterio", "exilio"]} />
          ))}
      </div>
    </Modal>
  );
}

type LabeledModel = TokenModel & { rotulo: string };

/* Os tipos de ficha, na língua da tela e no do tipo impresso: é o inglês que
   decide a fila do campo (`fieldRow` procura "creature"), igual às cartas. */
const TOKEN_TYPES = [
  { label: "Criatura", type: "Token Creature" },
  { label: "Artefato", type: "Token Artifact" },
  { label: "Encantamento", type: "Token Enchantment" },
  { label: "Artefato criatura", type: "Token Artifact Creature" },
];

function TokenMaker({ player }: { player: number }) {
  // As fichas que o DECK cria já foram lidas da base pela aba Tokens: são elas
  // que a partida vai precisar, e vêm com arte.
  const fromDeck: LabeledModel[] = deckTokens().map((f) => ({
    nome: f.nome, tipo: f.tipo, poder: f.poder as string, resistencia: f.resistencia as string,
    imagem: f.imagem, chaveArte: f.chaveArte, rotulo: tokenLabel(f),
  }));
  const saved: LabeledModel[] = savedTokens().map((m) => ({ ...m, rotulo: (m.nome || "") + (m.poder ? ` ${m.poder}/${m.resistencia}` : "") }));
  const [name, setName] = useState("Soldado");
  const [type, setType] = useState(TOKEN_TYPES[0].type);
  const [power, setPower] = useState("1");
  const [toughness, setToughness] = useState("1");
  const [count, setCount] = useState(1);
  const [colors, setColors] = useState<string[]>([]);
  const creature = type.includes("Creature");
  const create = () => {
    const model: TokenModel = {
      nome: name.trim() || "Ficha", tipo: type,
      poder: creature ? power.trim() : "", resistencia: creature ? toughness.trim() : "",
      cores: colors,
    };
    makeToken(player, model, count, true);
  };
  const chips = (list: LabeledModel[]) => (
    <div class="gf-chips">
      {list.map((m) => <button class="chip" onClick={() => makeToken(player, m, count)}>{m.rotulo}</button>)}
    </div>
  );
  return (
    <Modal title="Criar ficha">
      <div class="gf-linha gf-quantas">
        <span>Quantas</span>
        <button class="gf-passo" aria-label="Menos uma" disabled={count <= 1} onClick={() => setCount(Math.max(1, count - 1))}><SpriteIcon name="minus" /></button>
        <b id="gf-f-n">{count}</b>
        <button class="gf-passo" aria-label="Mais uma" disabled={count >= 20} onClick={() => setCount(Math.min(20, count + 1))}><SpriteIcon name="plus" /></button>
      </div>
      {fromDeck.length > 0 && <><div class="gf-secao">As que este deck cria</div>{chips(fromDeck)}</>}
      {saved.length > 0 && <><div class="gf-secao">Salvas neste navegador</div>{chips(saved)}</>}
      <div class="gf-secao">Montar uma</div>
      <div class="gf-ficha-montar">
        <div class={"gf-ficha-previa" + (colors.length ? " cor-" + (colors.length > 1 ? "M" : colors[0]) : "")} aria-hidden="true">
          <b>{name.trim() || "Ficha"}</b>
          <span>{TOKEN_TYPES.find((t) => t.type === type)!.label}</span>
          {creature && <span class="gf-ficha-pt">{power || "0"}/{toughness || "0"}</span>}
        </div>
        <div class="gf-forma">
          <label>Nome <input class="campo" id="gf-f-nome" value={name} maxlength={40} onInput={(e) => setName(e.currentTarget.value)} /></label>
          <label>Tipo
            <select class="campo" id="gf-f-tipo" value={type} onChange={(e) => setType(e.currentTarget.value)}>
              {TOKEN_TYPES.map((t) => <option value={t.type}>{t.label}</option>)}
            </select>
          </label>
          {creature && (
            <>
              <label>Poder <input class="campo curto" id="gf-f-p" value={power} maxlength={3} onInput={(e) => setPower(e.currentTarget.value)} /></label>
              <label>Resistência <input class="campo curto" id="gf-f-r" value={toughness} maxlength={3} onInput={(e) => setToughness(e.currentTarget.value)} /></label>
            </>
          )}
          <div class="gf-forma-cores">Cores
            <div class="gf-cores-escolha" id="gf-f-cores">
              {["W", "U", "B", "R", "G"].map((c) => (
                <button class={"gf-cor-btn" + (colors.includes(c) ? " ativa" : "")} data-gf-cor={c} aria-pressed={colors.includes(c)}
                        title={({ W: "Branco", U: "Azul", B: "Preto", R: "Vermelho", G: "Verde" } as Record<string, string>)[c]}
                        onClick={() => setColors(colors.includes(c) ? colors.filter((x) => x !== c) : [...colors, c])}>
                  <span class={"pip " + c} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div class="gf-acoes"><button class="btn ouro" id="gf-f-criar" onClick={create}>
        <SpriteIcon name="plus-circle" /> Criar {count > 1 ? `${count} fichas` : "ficha"}</button></div>
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
    <Modal title="Resumo da partida">
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
    case "search": return <SearchZone modal={modal} />;
    case "peek": return <PeekTop modal={modal} />;
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
