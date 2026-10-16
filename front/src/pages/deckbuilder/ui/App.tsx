/* O deckbuilder inteiro. Primeiro no DOM vem o deck, de propósito: é o
   assunto da tela. Leitor de tela e telefone pegam a lista de cara, e a
   ordem visual do computador (busca à esquerda, deck no meio, apoio à
   direita) vem do CSS. */
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { accountDialog, accountLink, claimDeck, declineClaim } from "../account";
import { bindDeckDrag } from "../deckDrag";
import { closeDrawer, drawer, type DrawerId } from "../drawers";
import { clearFilters } from "../filters";
import { importForm, runImport, setImportField } from "../importExport";
import { onPageKey } from "../keyboard";
import { tableMode } from "../online";
import { closeSheet, maybeCollapsed, openSheet, sheetOpen, switchTab, toggleMaybeColumn } from "../layout";
import { filterList, MIN_FOR_TOOLS } from "../lists";
import { bindHoverPreview } from "../hoverPreview";
import { Curve } from "./Analysis";
import { ArtPicker } from "./ArtPicker";
import { CardModal } from "./CardModal";
import { DeckArea } from "./DeckArea";
import { BoardList, MaybeCount } from "./DeckList";
import { FilterFields } from "./Filters";
import { GoldfishPanel } from "./Goldfish";
import { TableOverlays } from "./GoldfishOverlays";
import { Header } from "./Header";
import { ImportNotice } from "./ImportNotice";
import { PopupMenu } from "./PopupMenu";
import { QuoteBox } from "./Quote";
import { Rail } from "./Rail";
import { SpriteIcon } from "./SpriteIcon";
import { Toast } from "./toast";
import { useDeck } from "./useDeck";

/* ================= direita: o que se olha enquanto monta ================= */
function MaybeColumn() {
  const state = useDeck();
  const collapsed = maybeCollapsed.value;
  const count = state.maybe.reduce((n, e) => n + e.quantidade, 0);
  return (
    <aside class="trilho" id="trilho">
      {/* Fora dos painéis, porque recolhe a coluna inteira e não um deles. */}
      <button class="mini trilho-recolher" id="btn-recolher-talvez" aria-expanded={!collapsed}
              aria-controls="trilho-conteudo" title={collapsed ? "Abrir a coluna" : "Recolher a coluna"}
              onClick={() => toggleMaybeColumn()}>
        <SpriteIcon name={collapsed ? "caret-left" : "caret-right"} /></button>
      <span class="trilho-vertical">Curva e maybeboard</span>

      <div class="trilho-conteudo" id="trilho-conteudo">
        <div class="painel cartao-curva">
          <h2 class="secao">Curva de mana</h2>
          <div class="barras" id="curva"><Curve /></div>
          <button class="btn" id="btn-ver-analise" style={{ width: "100%", marginTop: "11px" }} onClick={() => {
            switchTab("analise");
            document.getElementById("painel-analise")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
          }}>Ver análise</button>
        </div>

        {/* Do lado oposto à busca, com o deck no meio: o que talvez entre de
            um lado, o que se procura pra entrar do outro. */}
        <div class="painel painel-talvez">
          <div class="talvez-topo">
            <h2 class="secao">Maybeboard</h2>
            <MaybeCount />
          </div>
          <p class="nota talvez-nota">Cartas em dúvida. Não contam pras 100, não entram na cotação e não aparecem em
            análise nenhuma — ficam aqui até você decidir.</p>
          <input class="campo campo-lista" id="busca-talvez" type="search" autocomplete="off" spellcheck={false}
                 hidden={state.maybe.length < MIN_FOR_TOOLS.talvez && !state.listFilter.talvez}
                 placeholder="Achar aqui…" aria-label="Achar uma carta que já está no maybeboard"
                 value={state.listFilter.talvez} onInput={(e) => filterList("talvez", e.currentTarget.value)}
                 onKeyDown={(e) => {
                   if (e.key !== "Escape" || !e.currentTarget.value) return;
                   e.stopPropagation();
                   filterList("talvez", "");
                 }} />
          <div class="talvez-lista" id="talvez-lista"><BoardList board="talvez" /></div>
          <div class="talvez-vazio" id="talvez-vazio" hidden={count > 0}>Arraste uma carta do deck pra cá — ou mande
            direto, pelo <b>Vai para</b> da busca.</div>
        </div>
      </div>
    </aside>
  );
}

/* Uma gaveta. Só uma por vez, e o fundo escuro é o mesmo pras duas. */
function Drawer({ id, label, title, children, footer }: {
  id: DrawerId; label: string; title: string; children: ComponentChildren; footer: ComponentChildren;
}) {
  const d = drawer.value;
  const shown = d?.id === id;
  const ref = useRef<HTMLDivElement>(null);
  // O foco vai pro primeiro campo depois de a gaveta ter deslizado.
  useEffect(() => {
    if (!shown) return;
    const first = ref.current?.querySelector<HTMLElement>("input,textarea,select");
    const t = setTimeout(() => first?.focus(), 180);
    return () => clearTimeout(t);
  }, [shown]);
  return (
    <div class={"gaveta" + (shown && d!.open ? " aberta" : "")} id={id} role="dialog" aria-modal="true"
         aria-label={label} hidden={!shown} ref={ref}>
      <div class="gaveta-topo">
        <h2>{title}</h2>
        <button class="mini sai" title="Fechar" onClick={closeDrawer}><SpriteIcon name="x" /></button>
      </div>
      {children}
      <div class="gaveta-rodape">{footer}</div>
    </div>
  );
}

function ImportDrawer() {
  const f = importForm.value;
  return (
    <Drawer id="gaveta-importar" label="Importar deck" title="Importar deck" footer={
      <>
        <button class="btn" onClick={closeDrawer}>Cancelar</button>
        <button class="btn ouro" id="btn-fazer-importar" disabled={f.running} onClick={runImport}>Importar</button>
      </>
    }>
      <div class="gaveta-corpo">
        <div class="campo-grupo">
          <label for="i-url">Link do deck</label>
          <input class="campo" id="i-url" autocomplete="off" spellcheck={false} value={f.url}
                 placeholder="archidekt.com/decks/…  ou  moxfield.com/decks/…"
                 onInput={(e) => setImportField("url", e.currentTarget.value)} />
          <p class="ajuda">Funciona com <b>Archidekt</b> e <b>Moxfield</b>. Deck privado não abre de fora — nesse
            caso, e em qualquer outro site, use o <b>Export</b> de lá e cole a lista aqui embaixo.</p>
        </div>
        <div class="campo-grupo">
          <label for="i-texto">…ou a lista em texto</label>
          <textarea class="campo" id="i-texto" spellcheck={false} value={f.text}
                    placeholder={"1 Atraxa, Praetors' Voice\n1 Sol Ring\n1 Arcane Signet\n10 Forest"}
                    onInput={(e) => setImportField("text", e.currentTarget.value)} />
          <p class="ajuda">Uma carta por linha. Engole o que os sites exportam: com ou sem quantidade, com edição entre
            parênteses, com cabeçalho de seção. O que estiver depois de <b>Sideboard</b> ou <b>Maybeboard</b> fica de
            fora, e um cabeçalho <b>Commander</b> (ou um <b>*CMDR*</b> na linha) diz quem é o comandante.</p>
        </div>
        <div id="i-resultado"><ImportNotice notice={f.notice} /></div>
      </div>
    </Drawer>
  );
}

function FiltersDrawer() {
  return (
    <Drawer id="gaveta-filtros" label="Filtros avançados" title="Filtros" footer={
      <>
        <button class="btn" id="btn-limpar-filtros" onClick={clearFilters}>Limpar tudo</button>
        <button class="btn ouro" onClick={closeDrawer}>Ver resultados</button>
      </>
    }>
      <div class="gaveta-corpo" id="campos-filtros"><FilterFields /></div>
    </Drawer>
  );
}

/* Oferta de reclamar um deck sem dono, só pra quem está logado abrindo um
   deck órfão. Não é `confirm()` porque o texto tem duas frases, e a segunda
   — o link continua abrindo pra quem receber — é justamente a que evita a
   recusa por medo.

   E o convite pra quem abre a tela sem conta: o texto muda quando há um
   deck aberto, porque aí a pessoa veio olhar um link, não montar. "Só
   olhar" fecha e deixa a tela à mão — abrir baralho não pede conta. */
function AccountDialogs() {
  const state = useDeck();
  const dialog = accountDialog.value;
  if (dialog === "orphan") {
    return (
      <div class="orfao-fundo" id="orfao-fundo">
        <div class="orfao-caixa" role="dialog" aria-modal="true" aria-labelledby="orfao-titulo">
          <h3 id="orfao-titulo">Este baralho não tem dono</h3>
          <p>Quer ficar com ele? Depois disso só você edita e apaga — o link continua abrindo normalmente pra quem você
            mandar.</p>
          <div class="orfao-acoes">
            <button class="btn" id="orfao-nao" onClick={declineClaim}>Agora não</button>
            <button class="btn ouro" id="orfao-sim" onClick={claimDeck}>Ficar com ele</button>
          </div>
        </div>
      </div>
    );
  }
  if (dialog !== "invite") return null;
  return (
    <div class="orfao-fundo" id="convite-fundo">
      <div class="orfao-caixa" role="dialog" aria-modal="true" aria-labelledby="convite-titulo">
        <h3 id="convite-titulo">{state.id ? "Você está vendo este baralho" : "Entre pra montar seu baralho"}</h3>
        <p id="convite-texto">{state.id
          ? "Pra editar ou montar o seu, entre na sua conta ou crie uma."
          : "Criar um baralho pede uma conta. Sem entrar, você ainda abre os baralhos que compartilharem com você."}</p>
        <div class="orfao-acoes">
          <button class="btn" id="convite-olhar" type="button" onClick={() => { accountDialog.value = null; }}>Só olhar</button>
          <a class="btn" id="convite-entrar" href={accountLink("entrar")}>Entrar</a>
          <a class="btn ouro" id="convite-cadastro" href={accountLink("cadastro")}>Criar conta</a>
        </div>
      </div>
    </div>
  );
}

/* A página no modo mesa (ver `tableMode`): o cabeçalho diz onde a pessoa
   está e leva pros decks dela, e o corpo é só a mesa — sem busca, sem abas,
   sem o "escolha seu comandante" de um deck que ninguém está montando. */
function TableModePage() {
  useEffect(() => {
    document.addEventListener("keydown", onPageKey);
    return () => document.removeEventListener("keydown", onPageKey);
  }, []);
  return (
    <>
      <header class="topo mesa-topo">
        <div class="topo-in">
          <a class="rune" href="/" title="Meus decks"><span>⌘</span></a>
          <div class="mesa-titulo">
            <b>Mesa online</b>
            <span>Commander, até 4 na mesa</span>
          </div>
          <div class="espaco" />
          <div class="acoes"><a class="btn" href="/"><SpriteIcon name="cards" /> Meus decks</a></div>
        </div>
      </header>
      <main class="corpo modo-mesa" id="corpo">
        <section class="principal">
          <div class="painel" id="painel-goldfish"><GoldfishPanel /></div>
        </section>
      </main>
      <TableOverlays />
      <CardModal />
      <Toast />
    </>
  );
}

/* As duas páginas são componentes separados, e não um `if` no meio de uma:
   o modo pode cair no `boot` (link de mesa quebrado), e trocar de página
   no meio dos hooks de outra quebraria a ordem deles. */
export function App() {
  return tableMode.value ? <TableModePage /> : <DeckbuilderPage />;
}

function DeckbuilderPage() {
  const state = useDeck();
  useEffect(() => {
    bindHoverPreview();
    document.addEventListener("keydown", onPageKey);
    const unbindDrag = bindDeckDrag();
    return () => {
      document.removeEventListener("keydown", onPageKey);
      unbindDrag();
    };
  }, []);
  const noCommander = !state.commanders.length;
  return (
    <>
      <Header />
      <main class={"corpo" + (noCommander ? " sem-comandante" : "") + (maybeCollapsed.value ? " talvez-fechado" : "")} id="corpo">
        <DeckArea />
        <Rail />
        <MaybeColumn />
      </main>

      {/* No celular a busca sobe por cima do deck a partir daqui, e some
          quando a carta entrou. */}
      <div class={"folha-fundo" + (sheetOpen.value ? " aberta" : "")} id="folha-fundo" onClick={closeSheet} />
      <nav class="barra-mobile">
        <button class="btn ouro" id="btn-abrir-busca" onClick={openSheet}><SpriteIcon name="plus" /> Adicionar carta</button>
        <button class="btn redondo" id="btn-subir" title="Voltar ao topo" aria-label="Voltar ao topo"
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><SpriteIcon name="arrow-up" /></button>
      </nav>

      <div class={"gaveta-fundo" + (drawer.value?.open ? " aberta" : "")} id="gaveta-fundo" onClick={closeDrawer} />
      <FiltersDrawer />
      <ImportDrawer />

      <QuoteBox />
      <AccountDialogs />
      <ArtPicker />
      <TableOverlays />
      <CardModal />
      <PopupMenu />

      <div class="previa" id="previa" aria-hidden="true">
        {/* Sem referrer pelo mesmo motivo da grade de artes: a prévia também
            mostra miniatura do Google Drive quando a carta tem arte escolhida. */}
        <img id="previa-frente" alt="" referrerpolicy="no-referrer" />
        <img id="previa-verso" alt="" referrerpolicy="no-referrer" />
      </div>
      <Toast />
    </>
  );
}
