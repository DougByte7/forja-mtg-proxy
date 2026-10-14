/* A aba Mana base: a conta de terrenos, as fontes por cor, a base que o deck
   já tem e os terrenos pra fechar o buraco. A lógica é `manabase.ts`. */
import {
  addBasics, addFixingLand, openCycle, setPriceCap, type Cycle, type FixingLand, type ManabaseResponse,
} from "../manabase";
import { cardPrice, exchangeNote, money } from "../price";
import { COLOR_NAMES, state } from "../state";
import { previewProps } from "./preview";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* Os grupos em que `manabase.py` junta os ciclos, com o rótulo que a lista
   de ciclos mostra acima de cada um. */
const CYCLE_GROUPS: Record<string, string> = {
  desviradas: "Entram desviradas", condicionais: "Às vezes viradas", viradas: "Entram viradas", outros: "Outros",
};

/* O retrato do deck: a conta de terrenos, com o veredito dito em palavras, e
   as fontes de cada cor contra o que a cor pede. */
function Summary({ m }: { m: ManabaseResponse }) {
  const t = m.terrenos;
  const status = t.diferenca === 0 ? "ok" : t.diferenca < 0 ? "falta" : "sobra";
  const verdict = t.diferenca === 0 ? "Na conta" : t.diferenca < 0 ? `Faltam ${-t.diferenca}` : `${t.diferenca} a mais`;
  const details = [`Curva média ${m.cmc_media.toFixed(2)}`, `${m.magias} ${m.magias === 1 ? "magia" : "magias"}`];
  if (m.rampas_baratas) details.push(`${m.rampas_baratas} ${m.rampas_baratas === 1 ? "rampa barata" : "rampas baratas"}`);
  const max = Math.max(1, ...m.cores.map((c) => Math.max(c.fontes, c.pedidas)));
  return (
    <div class="mb-resumo">
      <div class={`mb-cartao mb-conta ${status}`}>
        <span class="mb-rotulo">Terrenos</span>
        <div class="mb-numero"><b>{t.tem}</b><span>/ {t.recomendado}</span></div>
        <span class="mb-veredito">{verdict}</span>
        <p class="nota">{details.join(" · ")}</p>
      </div>
      <div class="mb-cartao">
        <div class="mb-cartao-cab">
          <span class="mb-rotulo">Fontes por cor</span>
          <span class="mb-legenda"><i class="barra" />tem <i class="marca" />pede</span>
        </div>
        {m.cores.map((c) => (
          <div class="mb-cor" title={`${c.nome}: ${c.pips} símbolo(s) de mana (${Math.round(c.parte * 100)}% do deck)` +
               (c.fora_do_terreno ? ` · mais ${c.fora_do_terreno} fonte(s) em rocks/dorks` : "")}>
            <span class={`pip ${c.cor}`} />
            <span class="mb-cor-nome">{c.nome}</span>
            <span class="trilho">
              <span class="cheio" style={{ width: `${Math.min(100, (c.fontes / max) * 100)}%`, background: `var(--mana-${c.cor})` }} />
              <span class="marca" style={{ left: `clamp(0px, calc(${(c.pedidas / max) * 100}% - 1px), calc(100% - 2px))` }} />
            </span>
            <span class="num"><b>{c.fontes}</b>/{c.pedidas}</span>
            {c.faltam ? <span class="dif falta">faltam {c.faltam}</span> : <span class="dif"><SpriteIcon name="check" /> ok</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Os terrenos que o deck já tem, por como entram e por ciclo. A barra
   responde "quanto da base chega virada"; as pílulas, "de que é feita" — e
   a pílula de um ciclo que tem o que comprar abre esse ciclo na lista de
   baixo. */
const ENTRIES: [string, string][] = [["desvirada", "entram desviradas"], ["condicional", "às vezes viradas"], ["virada", "entram viradas"]];

function CurrentBase({ m }: { m: ManabaseResponse }) {
  const b = m.base_atual;
  if (!b || !b.grupos.length) return null;
  const total = m.terrenos.tem;
  const parts = ENTRIES.filter(([k]) => b.entrada[k]);
  const openable = new Set(m.fixadores.map((c) => c.id));
  return (
    <div class="mb-cartao mb-base">
      <div class="mb-cartao-cab">
        <span class="mb-rotulo">Sua base</span>
        <span class="mb-legenda">{total} {total === 1 ? "terreno" : "terrenos"}</span>
      </div>
      <div class="mb-base-barra" role="img" aria-label={parts.map(([k, l]) => `${b.entrada[k]} ${l}`).join(", ")}>
        {parts.map(([k, l]) => <span class={`seg ${k}`} style={{ flexGrow: b.entrada[k] }} title={`${b.entrada[k]} ${l}`} />)}
      </div>
      <div class="mb-base-legenda">
        {parts.map(([k, l]) => <span><i class={k} /><b>{b.entrada[k]}</b> {l}</span>)}
      </div>
      <div class="mb-base-grupos">
        {b.grupos.map((g) => {
          const names = g.cartas.join(", ");
          return openable.has(g.id)
            ? <button class="mb-base-grupo" title={names} onClick={() => openCycle(g.id)}>
                <b>{g.quantidade}</b>{g.nome}<SpriteIcon name="caret-right" /></button>
            : <span class="mb-base-grupo" title={names}><b>{g.quantidade}</b>{g.nome}</span>;
        })}
      </div>
    </div>
  );
}

/* O jeito de graça de fechar o buraco. Uma pílula por básico e, com mais de
   um, o lote inteiro num clique. */
function Basics({ m }: { m: ManabaseResponse }) {
  const t = m.terrenos;
  if (!m.basicos.length) {
    if (t.diferenca >= 0) return null;
    return <div class="mb-basicos"><span class="nota">Faltam {-t.diferenca} terreno(s), mas nenhuma cor está
      descoberta — qualquer básico da identidade serve.</span></div>;
  }
  const sum = m.basicos.reduce((s, b) => s + (b.carta ? b.quantidade : 0), 0);
  return (
    <div class="mb-basicos">
      <span class="mb-rotulo">Fechar com básicos</span>
      <div class="mb-basicos-lista">
        {m.basicos.map((b) => (
          <button class="mb-basico" disabled={!b.carta}
                  title={b.carta ? `Adicionar ${b.quantidade}× ${b.nome}` : "Carta não encontrada"}
                  onClick={() => addBasics([b])}>
            <span class={`pip ${b.cor}`} />{b.quantidade}× {b.nome}<SpriteIcon name="plus" />
          </button>
        ))}
      </div>
      {m.basicos.length > 1 && sum > 0 && (
        <button class="add-peca" onClick={() => addBasics(m.basicos, true)}><SpriteIcon name="plus" /> Todos ({sum})</button>
      )}
    </div>
  );
}

/* Uma linha da lista. Veste o `.achado` da busca porque é a mesma ação —
   clicar põe no deck —, e a bolinha com anel é cor que o deck ainda pede. */
function Land({ land: t, cycle, missing }: { land: FixingLand; cycle: Cycle; missing: Set<string> }) {
  const caption = [t.tipo!.split(" // ").find((x) => /land/i.test(x)) || t.tipo];
  if (t.entrada === "virada" && cycle.grupo !== "viradas") caption.push("entra virada");
  return (
    <button class={"achado mb-terreno" + (t.no_deck ? " no-deck" : "")} aria-disabled={t.no_deck ? "true" : undefined}
            title={t.no_deck ? "Já está no deck" : undefined} {...previewProps(t)} onClick={() => addFixingLand(t)}>
      <span class="nome"><b>{t.nome}</b><small>{caption.join(" · ")}</small></span>
      <span class="mana">{t.produz.split("").map((c) => {
        const needed = missing.has(c);
        return <span class={`pip ${c}${needed ? " cobre" : ""}`} title={COLOR_NAMES[c] + (needed ? " — o deck pede mais fontes" : "")} />;
      })}</span>
      <span class="preco">{cardPrice(t) || "—"}</span>
    </button>
  );
}

function CycleHeader({ cycle: c, children }: { cycle: Cycle; children?: preact.ComponentChildren }) {
  return <div class="mb-ciclo-cab"><div><h3>{c.nome}</h3><p>{c.descricao}</p></div>{children}</div>;
}

function CycleList({ cycles, open }: { cycles: Cycle[]; open: Cycle | undefined }) {
  const all = cycles.reduce((s, c) => s + c.total, 0);
  let group: string | null = null;
  return (
    <nav class="mb-ciclos" aria-label="Ciclos de terreno">
      <button class={"mb-ciclo-btn" + (open ? "" : " ativo")} aria-pressed={open ? "false" : "true"} onClick={() => openCycle("")}>
        <span class="rot">Todos</span><span class="n">{all}</span></button>
      {cycles.map((c) => {
        const header = c.grupo !== group ? <span class="mb-grupo-rot">{CYCLE_GROUPS[c.grupo] || ""}</span> : null;
        group = c.grupo;
        const active = open?.id === c.id;
        return (
          <>
            {header}
            <button class={`mb-ciclo-btn${active ? " ativo" : ""}${c.total ? "" : " sem-terreno"}`}
                    aria-pressed={active ? "true" : "false"} title={c.descricao} onClick={() => openCycle(c.id)}>
              <span class="rot">{c.nome}</span>
              {c.no_deck > 0 && <span class="tem" title={`${c.no_deck} no deck`}><SpriteIcon name="check" />{c.no_deck}</span>}
              <span class="n">{c.total}</span>
            </button>
          </>
        );
      })}
    </nav>
  );
}

/* A visão geral é uma olhada, não o catálogo: fica de fora o ciclo sem
   terreno pra mostrar (todos acima do teto, ou todos já no deck) e o grupo
   "Outros", que só interessa a quem foi procurar por ele. */
function Overview({ cycles, missing }: { cycles: Cycle[]; missing: Set<string> }) {
  const visible = cycles.filter((c) => c.grupo !== "outros" && c.total);
  const elsewhere = cycles.filter((c) => c.grupo === "outros" && c.total);
  if (!visible.length) return <div class="vazio">Nenhum terreno dentro do teto de preço.</div>;
  return (
    <>
      {visible.map((c) => (
        <div class="mb-ciclo">
          <CycleHeader cycle={c}>
            {c.total + c.no_deck > c.terrenos.length && (
              <button class="mb-ver" onClick={() => openCycle(c.id)}>Ver todos ({c.total + c.no_deck})<SpriteIcon name="caret-right" /></button>
            )}
          </CycleHeader>
          {c.terrenos.length > 0 && <div class="mb-grade">{c.terrenos.map((t) => <Land land={t} cycle={c} missing={missing} />)}</div>}
        </div>
      ))}
      {elsewhere.length > 0 && <p class="nota mb-de-fora">{elsewhere.map((c) => c.nome).join(" e ")} ficam na lista de ciclos.</p>}
    </>
  );
}

function OpenCycle({ cycle: c, missing }: { cycle: Cycle; missing: Set<string> }) {
  // Enquanto o ciclo inteiro não chega, a lista mostra os primeiros que já
  // estavam na tela.
  const loading = c.terrenos.length < c.total + c.no_deck;
  return (
    <div class="mb-ciclo aberto">
      <CycleHeader cycle={c}>
        <button class="mb-ver" onClick={() => openCycle("")}><SpriteIcon name="arrow-left" />Todos</button>
      </CycleHeader>
      {c.terrenos.length > 0 && <div class="mb-grade">{c.terrenos.map((t) => <Land land={t} cycle={c} missing={missing} />)}</div>}
      {loading && <p class="nota mb-chegando">Carregando o ciclo inteiro…</p>}
      {!!c.acima_do_teto && (
        <div class="mb-acima">
          <span>{c.acima_do_teto} {c.acima_do_teto === 1 ? "terreno passa" : "terrenos passam"} do teto de preço.</span>
          <button class="mb-ver" onClick={() => setPriceCap(999)}>Mostrar sem teto</button>
        </div>
      )}
    </div>
  );
}

/* Os terrenos pra comprar, por ciclo: a lista dos ciclos de um lado (que é
   também o mapa do que existe pra esta identidade) e, do outro, a visão
   geral com os primeiros de cada ciclo ou o ciclo aberto inteiro.

   O teto fica em DÓLAR: é o que `manabase.py` filtra do outro lado, e o
   rótulo é a única parte que a régua toca. */
function Fixing({ m }: { m: ManabaseResponse }) {
  const cycles = m.fixadores;
  // O ciclo aberto pode sumir da resposta — o comandante mudou e a
  // identidade com ele. Aí a tela volta pra visão geral.
  const open = cycles.find((c) => c.id === state.manabaseCycle);
  const missing = new Set(m.cores.filter((c) => c.faltam > 0).map((c) => c.cor));
  return (
    <section class="mb-fixacao">
      <div class="mb-fix-cab">
        <h2 class="secao">{m.monocolor ? "Terrenos recomendados" : "Terrenos que fixam"}</h2>
        <div class="mb-teto" role="group" aria-label="Teto de preço">
          <span>Preço</span>
          {[1, 3, 10, 999].map((v) => (
            <button class={"chip" + (m.teto_usd === v || (v === 999 && m.teto_usd >= 999) ? " ativo" : "")}
                    title={v >= 999 ? undefined : exchangeNote()} onClick={() => setPriceCap(v)}>
              {v >= 999 ? "Sem teto" : "até " + money(v)}</button>
          ))}
        </div>
      </div>
      {m.monocolor && <p class="nota mb-mono">Deck de uma cor: básico resolve a cor.</p>}
      {!cycles.length ? (
        <div class="vazio">{m.monocolor ? "Nenhum MDFC da cor do deck." : "Nenhum terreno de duas ou mais cores da identidade."}</div>
      ) : (
        <div class="mb-navegador">
          <CycleList cycles={cycles} open={open} />
          <div class="mb-lista">{open ? <OpenCycle cycle={open} missing={missing} /> : <Overview cycles={cycles} missing={missing} />}</div>
        </div>
      )}
    </section>
  );
}

export function ManabasePanel() {
  const state = useDeck();
  const m: ManabaseResponse | null = state.manabase;
  // A conta está na tela: a explicação do que o painel faz vira ruído acima dela.
  const showing = !!m && !state.manabaseError && !state.manabaseLoading;
  return (
    <>
      <p class="nota" id="mb-nota" hidden={showing}>Quantos terrenos a curva pede, quantas fontes de cada cor o
        deck tem e quantas precisaria.</p>
      <div id="mb-resultado" style={{ marginTop: "12px" }}>
        {state.manabaseError ? <div class="aponta erro"><span>{state.manabaseError}</span></div>
          : state.manabaseLoading ? <div class="nota">Calculando…</div>
          : m && (
            <>
              <Summary m={m} />
              <CurrentBase m={m} />
              <Basics m={m} />
              <Fixing m={m} />
              <details class="rodape-conta mb-como">
                <summary>Como a conta é feita</summary>
                <p>Parte de 36 terrenos numa curva média de 3,20: um terreno a mais a cada 0,25 de curva acima
                  disso, um a menos a cada 0,25 abaixo. Cada rampa barata — rock ou dork de custo até 2 — vale
                  meio terreno a menos, no máximo quatro. O resultado fica preso entre 32 e 40. As fontes
                  pedidas de cada cor são proporcionais aos símbolos de mana que o deck pede daquela cor, com
                  piso de 8 fontes pra um respingo (menos de 12% dos símbolos) e 12 pra uma cor de verdade — e
                  fonte é o que <i>produz</i> a cor, então um terreno de duas cores conta pras duas. É regra de
                  mesa, feita pra conferir de cabeça, não a simulação de Frank Karsten: ela aponta o buraco,
                  não fecha a lista.</p>
              </details>
            </>
          )}
      </div>
    </>
  );
}
