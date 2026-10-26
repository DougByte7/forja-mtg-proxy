/* A modal de escolher a arte. Um segmento por origem (ver `art.ts`); no do
   MPC Fill há duas listas, e a diferença entre elas é a coisa mais
   importante dele: em cima, as impressões OFICIAIS da Scryfall — servem pra
   achar, e clicar nelas não escolhe nada. Embaixo, os arquivos do MPC Fill. */
import { useEffect, useRef, useState } from "preact/hooks";
import {
  artKey, artName, artState, artThumbnail, chosenArt, closeArtPicker, filteredIds, hasBack, NO_IMAGE_STATUS, pageOf,
  paperQuantity, revertToDefault, setArtFilter, setCloseOnPick, setCopy, setOrigin, setPerCopy,
  showFace, togglePrintingFilter, uploadArtFile, UPLOADED_ID, pickMpcArt, pickScryfallArt,
  visiblePages, goToPage, scryfallOptions, type Face, type Origin,
} from "../art";
import { canBeFoil, foilCopies, NO_FOIL_REASON, setAllFoil, setFoilCopies } from "../foil";
import { tokenLabel } from "../tokens";
import type { Card } from "../types";
import { Frame } from "./Gallery";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

const ORIGINS: [Origin, string][] = [["mpcfill", "MPC Fill"], ["scryfall", "Scryfall"], ["enviar", "Enviar arquivo"]];
const DPI_OPTIONS: [number, string][] = [[0, "qualquer DPI"], [600, "600+"], [800, "800+"], [1200, "1200+"]];

/* O seletor de lado, só em carta de duas faces. O ✓ diz qual lado já tem
   arte escolhida — sem ele, escolher a frente e fechar deixaria o verso no
   padrão sem nada na tela contando. */
function Faces({ card }: { card: Card }) {
  useDeck();
  return (
    <div class="segmento arte-faces" id="arte-faces" hidden={!hasBack(card)} role="group" aria-label="Lado da carta">
      {(["frente", "verso"] as Face[]).map((f) => {
        const on = f === artState.face;
        const done = !!chosenArt(card, f, null, artState.copy);
        return (
          <button type="button" data-face={f} class={on ? "ativa" : undefined} aria-pressed={on}
                  title={done ? "Arte escolhida pra este lado" : "Este lado está na arte padrão"}
                  onClick={() => { if (!on) showFace(f); }}>
            {f === "verso" ? "Verso" : "Frente"}{done && <> <SpriteIcon name="check" /></>}
          </button>
        );
      })}
    </div>
  );
}

/* "Uma arte por cópia" e o seletor de cópia, só com mais de uma cópia no
   deck. O ✓ no seletor marca a cópia com arte própria neste lado; a sem ✓
   sai com a arte das outras. */
function Copies({ card }: { card: Card }) {
  useDeck();
  const quantity = paperQuantity(card);
  const copies = (artState.choices[artKeyOf(card)] || {}).copias || {};
  return (
    <div class="arte-copias" id="arte-copias" hidden={quantity <= 1}>
      <label class="interruptor">
        <input type="checkbox" id="arte-por-copia" checked={artState.perCopy}
               onChange={(e) => setPerCopy(e.currentTarget.checked)} />
        <span class="trilho-int" aria-hidden="true" />
        Uma arte por cópia
      </label>
      <select class="campo" id="arte-copia" aria-label="Cópia" hidden={!artState.perCopy}
              value={String(artState.copy)} onChange={(e) => setCopy(Number(e.currentTarget.value))}>
        {artState.perCopy && Array.from({ length: quantity }, (_, i) => (
          <option value={String(i + 1)}>Cópia {i + 1}{copies[i + 1]?.[artState.face] ? " ✓" : ""}</option>
        ))}
      </select>
    </div>
  );
}

const artKeyOf = (card: Card) => artKey(artName(card));

/* Padrão ou foil, o mesmo dado do ✦ da galeria, à mão de quem já está
   escolhendo a arte. Com "Uma arte por cópia", vale pra cópia do seletor;
   sem, pra todas — e a carta com só algumas cópias foil fica sem lado aceso,
   com a conta ao lado. Carta com verso: apagado, com o porquê. */
function Finish({ card }: { card: Card }) {
  useDeck();
  const ok = canBeFoil(card);
  const quantity = paperQuantity(card);
  const marked = foilCopies(card);
  const copy = artState.perCopy ? artState.copy : 0;
  const foil = copy ? marked.includes(copy) : marked.length > 0 && marked.length === quantity;
  const standard = copy ? !foil : marked.length === 0;
  function choose(on: boolean) {
    if (!copy) return setAllFoil(card, on);
    const rest = marked.filter((n) => n !== copy);
    return setFoilCopies(card, on ? [...rest, copy] : rest);
  }
  return (
    <div class="arte-acabamento" title={ok ? undefined : NO_FOIL_REASON}>
      <div class="segmento" id="arte-acabamento" role="group" aria-label="Acabamento">
        <button type="button" data-acabamento="padrao" class={ok && standard ? "ativa" : undefined}
                aria-pressed={ok && standard} disabled={!ok} onClick={() => choose(false)}>Padrão</button>
        <button type="button" data-acabamento="foil" class={foil ? "ativa foil" : "foil"}
                aria-pressed={foil} disabled={!ok} onClick={() => choose(true)}>✦ Foil</button>
      </div>
      {ok && !copy && quantity > 1 && !foil && !standard && (
        <span class="arte-nota">{marked.length} de {quantity} no foil</span>
      )}
    </div>
  );
}

/* No lugar da tira de impressões, a ficha que o deck cria, com o que está
   escrito nela. É o que separa um arquivo certo de um quase certo: a grade de
   "Wurm" tem "Wurm (Deathtouch)" e "Wurm (Lifelink)", e só o texto diz qual
   das duas esta é. */
function TokenShowcase({ token }: { token: Card }) {
  const back = artState.face === "verso";
  const body = token.poder && token.resistencia ? ` · ${token.poder}/${token.resistencia}` : "";
  return (
    <>
      <span class="arte-ficha"><Frame src={(back && token.imagem_verso) || token.imagem} /></span>
      <span class="arte-nota" style={{ maxWidth: "260px" }}>É esta a ficha que o deck
        cria: <b>{(token.tipo || token.nome) + body}</b>{token.texto ? ` — ${token.texto}` : ""}. Escolha abaixo um
        arquivo que diga o mesmo.</span>
    </>
  );
}

function Showcase({ card }: { card: Card }) {
  useDeck();
  const printings = artState.printings;
  let body;
  if (card.ficha) body = <TokenShowcase token={card} />;
  else if (printings === null) body = <span class="arte-nota">Carregando as impressões oficiais…</span>;
  else if (printings === false) {
    body = <span class="arte-nota">Não consegui falar com a Scryfall — a grade abaixo continua funcionando.</span>;
  } else if (printings.length) {
    const back = artState.face === "verso";
    const lying = !!card.deitada;
    const lit = artState.filter.printing ? artState.filter.printing.k : -1;
    body = (
      <>
        <span class="arte-nota" style={{ maxWidth: "120px" }}>Estas são as artes oficiais. Clique numa pra
          ver só os arquivos dela.</span>
        {printings.slice(0, 24).map((i, k) => (
          <button class={"arte-impressao" + (lying ? " deitada" : "") + (k === lit ? " ativa" : "")}
                  data-impressao={k} title={i.edicao + (i.artista ? " · " + i.artista : "")}
                  onClick={() => togglePrintingFilter(k)}>
            <Frame src={(back && i.imagem_verso) || i.imagem} lying={lying} />
            <small>{i.sigla + (i.lancamento ? " · " + i.lancamento.slice(0, 4) : "")}</small>
          </button>
        ))}
      </>
    );
  }
  return <div class="arte-vitrine" id="arte-vitrine" hidden={artState.origin !== "mpcfill"}>{body}</div>;
}

function Filters() {
  useDeck();
  const timer = useRef(0);
  const f = artState.filter;
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div class="arte-filtros" id="arte-filtros" hidden={artState.origin !== "mpcfill" || !artState.ids.length}>
      <input class="campo" id="arte-busca" placeholder="filtrar pelo nome do arquivo" autocomplete="off"
             spellcheck={false} onInput={(e) => {
               clearTimeout(timer.current);
               const v = e.currentTarget.value.trim().toLowerCase();
               timer.current = window.setTimeout(() => setArtFilter({ texto: v }), 250);
             }} />
      <select class="campo" id="arte-fonte" value={f.source} onChange={(e) => setArtFilter({ fonte: e.currentTarget.value })}>
        <option value="">todas as fontes</option>
        {artState.sources.map((s) => <option value={s.nome}>{s.nome}</option>)}
      </select>
      <select class="campo" id="arte-dpi" value={String(f.dpi)}
              onChange={(e) => setArtFilter({ dpi: Number(e.currentTarget.value) || 0 })}>
        {DPI_OPTIONS.map(([v, label]) => <option value={String(v)}>{label}</option>)}
      </select>
    </div>
  );
}

/* O que a grade mostra no segmento aberto: a contagem (ou o porquê de estar
   vazia), as opções e quantas páginas há. */
function gridView(card: Card) {
  const what = `${artState.face === "verso" ? "o verso desta" : "esta"} ${card.ficha ? "ficha" : "carta"}`;
  const chosen = chosenArt(card, artState.face, null, artState.copy)?.arte_id || "";
  if (artState.origin === "scryfall") {
    const options = scryfallOptions();
    const empty = artState.printings === null ? "Carregando as impressões oficiais…"
      : artState.printings === false ? "Não consegui falar com a Scryfall agora."
      : !options.length ? `A Scryfall não tem imagem pra ${what}.` : "";
    if (empty) return { count: empty, pages: 0, page: 0, buttons: [] };
    const p = pageOf(options);
    return {
      count: `${options.length} impressão(ões) oficial(is) — mostrando ${p.start + 1}–${p.start + p.items.length}`,
      pages: p.pages, page: p.page,
      buttons: p.items.map((o) => {
        const noImage = NO_IMAGE_STATUS.includes(o.status);
        return (
          <button key={o.id} class={"arte-op" + (o.id === chosen ? " ativa" : "")} disabled={noImage}
                  title={o.titulo || o.legenda} onClick={() => pickScryfallArt(o)}>
            <Frame src={o.imagem} lying={!!card.deitada}>
              {o.status === "lowres" && <span class="arte-selo">Baixa resolução</span>}
            </Frame>
            <small>{o.legenda + (noImage ? " · sem imagem" : "")}</small>
          </button>
        );
      }),
    };
  }
  if (artState.loadingIds || artState.idsError) {
    return { count: artState.idsError || "Procurando as artes…", pages: 0, page: 0, buttons: [] };
  }
  const ids = filteredIds();
  if (!ids.length) {
    const printing = artState.filter.printing;
    const count = !artState.ids.length ? `O MPC Fill não tem arte pra ${what}.`
      : printing
        ? `Nenhum arquivo do MPC Fill identificado como ${printing.sigla}${
            printing.artista ? " ou de " + printing.artista : ""} — clique de novo na impressão pra ver todas.`
        : "Nenhuma arte com esses filtros.";
    return { count, pages: 0, page: 0, buttons: [] };
  }
  const p = pageOf(ids);
  return {
    count: `${ids.length} arte(s) — mostrando ${p.start + 1}–${p.start + p.items.length}`,
    pages: p.pages, page: p.page,
    buttons: p.items.map((id) => {
      const m = artState.meta[id] || {};
      return (
        <button key={id} class={"arte-op" + (id === chosen ? " ativa" : "")} data-arte-id={id} onClick={() => pickMpcArt(id)}>
          <Frame src={m.miniatura || artThumbnail(id, 400)} lying={!!card.deitada} />
          <small>{(m.arquivo || "…") + (m.dpi ? ` · ${m.dpi} DPI` : "")}</small>
        </button>
      );
    }),
  };
}

function Pages({ page, pages }: { page: number; pages: number }) {
  if (pages <= 1) return <nav class="arte-paginas" id="arte-paginas" aria-label="Páginas de artes" />;
  const arrow = (to: number, off: boolean, label: string, icon: string) => (
    <button class="pag" disabled={off} title={label} aria-label={label} onClick={() => goToPage(to)}>
      <SpriteIcon name={icon} />
    </button>
  );
  return (
    <nav class="arte-paginas" id="arte-paginas" aria-label="Páginas de artes">
      {arrow(page - 1, page === 0, "Página anterior", "caret-left")}
      {visiblePages(page, pages).map((n, i) => n === "…"
        ? <span key={"vao" + i} class="pag-vao" aria-hidden="true">…</span>
        : <button key={n} class={"pag" + (n === page ? " ativa" : "")} aria-current={n === page ? "page" : undefined}
                  aria-label={`Página ${n + 1}`} onClick={() => goToPage(n)}>{n + 1}</button>)}
      {arrow(page + 1, page >= pages - 1, "Próxima página", "caret-right")}
    </nav>
  );
}

/* O segmento de envio: a arte enviada que este lado já usa, quando é o caso,
   e a caixa pra mandar outra. */
function Upload({ card }: { card: Card }) {
  useDeck();
  const [over, setOver] = useState(false);
  const choice = chosenArt(card, artState.face, null, artState.copy);
  const uploaded = choice && UPLOADED_ID.test(choice.arte_id) ? choice : null;
  return (
    <div class="arte-envio" id="arte-envio" hidden={artState.origin !== "enviar"}>
      <div class="arte-envio-atual" id="arte-envio-atual">
        {uploaded && (
          <>
            <span class="arte-envio-quadro"><Frame src={artThumbnail(uploaded.arte_id, 500)} lying={!!card.deitada} /></span>
            <span class="arte-nota">Em uso: <b>{uploaded.arquivo || "arquivo enviado"}</b>
              {uploaded.dpi ? ` · ${uploaded.dpi} DPI` : ""}
              {uploaded.baixa_resolucao && (
                <><br /><span class="arte-alerta">Baixa resolução: pode sair borrada no papel.</span></>
              )}</span>
          </>
        )}
      </div>
      <label class={"arte-soltar" + (over ? " sobre" : "")} id="arte-soltar"
             onDragOver={(e) => { e.preventDefault(); setOver(true); }}
             onDragLeave={() => setOver(false)}
             onDrop={(e) => { e.preventDefault(); setOver(false); uploadArtFile(e.dataTransfer?.files[0]); }}>
        <input type="file" id="arte-arquivo" accept="image/png,image/jpeg,image/webp" onChange={(e) => {
          uploadArtFile(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";   // o mesmo arquivo de novo tem que disparar outra vez
        }} />
        <span class="btn ouro">Escolher arquivo</span>
        <span>ou arraste a imagem pra cá</span>
        <span class="arte-nota">PNG, JPG ou WebP no formato da carta (63 × 88 mm), com ou sem sangria.</span>
      </label>
      <div class="arte-conta" id="arte-envio-estado" role="status">{artState.uploadStatus}</div>
    </div>
  );
}

function Picker({ card }: { card: Card }) {
  useDeck();
  const upload = artState.origin === "enviar";
  const grid = upload ? null : gridView(card);
  const gridRef = useRef<HTMLDivElement>(null);
  // A página nova começa do começo: trocar de página com a grade rolada até o
  // fim mostraria o fim da página seguinte.
  useEffect(() => { if (gridRef.current) gridRef.current.scrollTop = 0; }, [grid?.page]);
  return (
    <div class="arte-fundo" id="arte-fundo" onClick={(e) => { if (e.target === e.currentTarget) closeArtPicker(); }}>
      <div class="arte-caixa" role="dialog" aria-modal="true" aria-labelledby="arte-titulo">
        <div class="arte-topo">
          <h3 id="arte-titulo">{card.ficha ? tokenLabel(card) : card.nome}</h3>
          <Faces card={card} />
          <Copies card={card} />
          <Finish card={card} />
          <span class="gf-espaco" />
          <button class="mini sai" id="arte-fechar" title="Fechar" aria-label="Fechar" onClick={closeArtPicker}>✕</button>
        </div>

        <div class="segmento arte-origens" id="arte-origens" role="group" aria-label="De onde vem a arte">
          {ORIGINS.map(([o, label]) => (
            <button type="button" data-origem={o} class={o === artState.origin ? "ativa" : undefined}
                    aria-pressed={o === artState.origin} onClick={() => setOrigin(o)}>{label}</button>
          ))}
        </div>

        <Showcase card={card} />
        <Filters />

        <div class="arte-conta" id="arte-conta" hidden={upload}>{grid?.count}</div>
        <div class={"arte-grade" + (card.deitada ? " deitada" : "")} id="arte-grade" ref={gridRef} hidden={upload}>
          {grid?.buttons}
        </div>

        <Upload card={card} />

        <div class="arte-rodape">
          <label class="interruptor" title="Lembrado neste navegador">
            <input type="checkbox" id="arte-fecha" checked={artState.closeOnPick}
                   onChange={(e) => setCloseOnPick(e.currentTarget.checked)} />
            <span class="trilho-int" aria-hidden="true" />
            Fechar ao escolher
          </label>
          {upload ? <nav class="arte-paginas" id="arte-paginas" hidden /> : <Pages page={grid!.page} pages={grid!.pages} />}
          <button class="btn" id="arte-padrao" onClick={revertToDefault}>
            {artState.copy ? "Igual às outras cópias" : "Voltar ao padrão"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Cada pedaço lê `useDeck()` por conta própria: o Preact com signals não
   redesenha um filho cujas props não mudaram, e a carta aberta é a mesma.

   Fechada, a modal não existe na página. Cada abertura remonta tudo
   (`aberturas`), e é isso que limpa o filtro digitado na carta anterior. */
export function ArtPicker() {
  useDeck();
  const card = artState.card;
  return card ? <Picker key={artState.opens} card={card} /> : null;
}
