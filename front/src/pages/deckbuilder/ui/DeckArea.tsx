/* O centro da tela: a pergunta do comandante, enquanto não há um, e depois
   as respostas sobre o deck em abas. */
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { cardBase, deckLoading } from "../boot";
import { createCategory, commanderPick } from "../editing";
import { importPastedLink } from "../importExport";
import { openDrawer } from "../drawers";
import { manabaseCall, switchTab, type Tab } from "../layout";
import { filterList, MIN_FOR_TOOLS, sortLists } from "../lists";
import { askNewCategory } from "../menus";
import { clearCommanderResults, onSearchKey, searchText, typeSearch } from "../search";
import { state as deckState } from "../state";
import { deckLinkSource } from "../text";
import { versionPillView } from "../versions";
import { ColorDistribution, DeckAlerts, Issues, Odds, Power, TypeDistribution } from "./Analysis";
import { CombosTabCount, DeckCombos } from "./Combos";
import { BoardList, CommanderBox, DeckTabCount } from "./DeckList";
import { HeroUnreleasedSwitch } from "./Filters";
import { DefaultArtsButton, Gallery } from "./Gallery";
import { GoldfishPanel } from "./Goldfish";
import { ManabasePanel } from "./Manabase";
import { SearchResults } from "./Search";
import { SpriteIcon } from "./SpriteIcon";
import { TokensPanel, TokensTabCount } from "./Tokens";
import { useDeck } from "./useDeck";
import { History } from "./Versions";

function CardBaseWarning() {
  const base = cardBase.value;
  if (!base) return <div class="aviso-base" id="aviso-base" hidden />;
  return (
    <div class="aviso-base" id="aviso-base">
      {base.rodando ? (
        <><b>Montando a base de cartas</b> — {base.lidas.toLocaleString("pt-BR")} cartas lidas até agora. A busca fica
          vazia até isso terminar; leva alguns minutos e só acontece na primeira vez.</>
      ) : (
        <><b>A base de cartas está vazia.</b> Ela se monta sozinha a partir do bulk data da Scryfall, mas ainda não
          rodou aqui — se isso não se resolver em alguns minutos, veja o log por <code>grep cartas</code>.</>
      )}
    </div>
  );
}

/* Importar o link que foi colado na busca de comandante. O trabalho é o
   mesmo da gaveta, e é pra lá que este atalho leva: o recado do que veio
   precisa de uma superfície que continue na tela, e a tela do comandante
   desaparece no instante em que o deck importado traz um. */
function importFromCommanderBox() {
  const url = searchText.cmd.value.trim();
  if (!deckLinkSource(url)) return;
  searchText.cmd.value = "";
  clearCommanderResults();
  openDrawer("gaveta-importar");
  importPastedLink(url);
}

/* Estado inicial: sem comandante não existe deck de Commander, então a tela
   inteira é essa única pergunta. */
function CommanderHero() {
  const state = useDeck();
  if (deckLoading.value) {
    return (
      <div class="painel heroi carregando-deck" id="heroi" role="status">
        <span class="girando" aria-hidden="true" />
        <p>Abrindo o deck…</p>
      </div>
    );
  }
  if (state.commanders.length && !commanderPick.partner) return null;
  return (
    <div class="painel heroi" id="heroi">
      <h1>Quem é o comandante?</h1>
      <p>Todo deck de Commander começa por uma criatura lendária: é ela que define a identidade de cor.</p>
      <div class="busca-caixa">
        <input class="campo" id="busca-cmd" autocomplete="off" spellcheck={false}
               placeholder="Buscar comandante… (ex.: Atraxa, Muldrotha)" value={searchText.cmd.value}
               onInput={(e) => typeSearch("cmd", e.currentTarget.value)}
               onKeyDown={(e) => {
                 // Enter sobre um link vale o mesmo que o botão: quem colou e
                 // apertou Enter pediu a mesma coisa que quem colou e clicou.
                 // Link nenhum deixa resultado na lista, então o teclado da
                 // busca não tem o que fazer com esse Enter.
                 if (e.key === "Enter" && deckLinkSource(e.currentTarget.value)) {
                   e.preventDefault();
                   return importFromCommanderBox();
                 }
                 onSearchKey(e, "cmd");
               }} />
      </div>
      {/* A coleção anunciada e ainda não lançada chega da Scryfall como
          ilegal, e por isso não aparece na busca. Quem está montando o deck
          dela precisa dizer isso UMA vez, e o lugar de dizer é aqui. */}
      <HeroUnreleasedSwitch />
      {/* A mesma caixa aceita o link do deck pronto: quem chega com um deck no
          Archidekt ou no Moxfield cola onde está o cursor. */}
      <p class="ou-link">Já tem o deck pronto? Cole aqui o link dele no <b>Archidekt</b> ou no <b>Moxfield</b>.</p>
      <div class="resultados" id="res-cmd"><SearchResults box="cmd" onImportLink={importFromCommanderBox} /></div>
    </div>
  );
}

const TABS: [Tab, string][] = [
  ["deck", "Deck"], ["artes", "Artes"], ["analise", "Análise"], ["manabase", "Mana base"], ["combos", "Combos"],
  ["tokens", "Tokens"], ["goldfish", "Goldfish"], ["historico", "Histórico"],
];

function TabCount({ tab }: { tab: Tab }) {
  if (tab === "deck") return <> <span class="n" id="aba-deck-n"><DeckTabCount /></span></>;
  if (tab === "combos") return <> <span class="n" id="aba-combos-n"><CombosTabCount list="no_deck" /></span></>;
  if (tab === "tokens") return <> <span class="n" id="aba-tokens-n"><TokensTabCount /></span></>;
  return null;
}

/* Deck, artes, análise, mana base, combos, tokens e goldfish são perguntas
   sobre a MESMA lista, e só uma está sendo feita de cada vez: uma superfície
   só, com abas. Abrir a aba já dispara a conta dela. A aba do histórico só
   aparece a partir da v1: com uma versão só não há o que comparar. */
function Tabs() {
  const state = useDeck();
  const hasHistory = versionPillView().hasHistory;
  return (
    <div class="abas-painel" id="abas-deck" role="tablist">
      {TABS.map(([tab, label]) => (
        <button role="tab" data-painel={tab} id={tab === "historico" ? "aba-historico" : undefined}
                class={state.tab === tab ? "ativa" : undefined} aria-selected={state.tab === tab}
                hidden={tab === "historico" && !hasHistory} onClick={() => switchTab(tab)}>
          {label}<TabCount tab={tab} />
        </button>
      ))}
    </div>
  );
}

function Panel({ tab, children, id, panelRef }: {
  tab: Tab; children: ComponentChildren; id?: string; panelRef?: preact.Ref<HTMLDivElement>;
}) {
  return (
    <div class="painel" id={id || `painel-${tab}`} data-painel={tab} hidden={deckState.tab !== tab} ref={panelRef}>
      {children}
    </div>
  );
}

/* Achar e ordenar o que JÁ está no deck — outra pergunta que a busca da
   esquerda, que procura o que ainda não entrou. Aparece só quando a lista
   fica grande o bastante pra se perder nela. */
function ListTools() {
  const state = useDeck();
  const hidden = state.cards.length < MIN_FOR_TOOLS.deck && !state.listFilter.deck;
  return (
    <div class="ferramentas-lista" id="ferramentas-deck" hidden={hidden}>
      <input class="campo campo-lista" id="busca-deck" type="search" autocomplete="off" spellcheck={false}
             placeholder="Achar no deck…" aria-label="Achar uma carta que já está no deck" value={state.listFilter.deck}
             onInput={(e) => filterList("deck", e.currentTarget.value)}
             onKeyDown={(e) => {
               // Esc num campo cheio limpa o campo, e só isso: sem parar aqui
               // o mesmo Esc fecharia a gaveta ou a modal atrás.
               if (e.key !== "Escape" || !e.currentTarget.value) return;
               e.stopPropagation();
               filterList("deck", "");
             }} />
      {/* A ordem vale pras duas listas: o maybeboard é a mesma lista lida
          noutro canto, e ordená-lo diferente seria ler duas. */}
      <select class="campo campo-ordem" id="ordem-lista" value={state.listOrder}
              title="Ordem das cartas dentro de cada categoria — vale também no maybeboard"
              aria-label="Ordenar as cartas dentro de cada categoria" onChange={(e) => sortLists(e.currentTarget.value)}>
        <option value="cmc">Custo — menor primeiro</option>
        <option value="cmc_desc">Custo — maior primeiro</option>
        <option value="nome">Nome — A a Z</option>
        <option value="preco_desc">Preço — mais cara primeiro</option>
        <option value="preco">Preço — mais barata primeiro</option>
      </select>
    </div>
  );
}

function newCategory() {
  const name = askNewCategory();
  if (name) createCategory(name);
}

/* O atalho no cabeçalho de Terrenos rola até a mana base e a faz piscar. */
function useManabaseCall() {
  const ref = useRef<HTMLDivElement>(null);
  const call = manabaseCall.value;
  useEffect(() => {
    const panel = ref.current;
    if (!call || !panel) return;
    panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    panel.classList.remove("chamado");
    void panel.offsetWidth;          // reinicia a animação se já tiver rodado
    panel.classList.add("chamado");
  }, [call]);
  return ref;
}

export function DeckArea() {
  const state = useDeck();
  const manabaseRef = useManabaseCall();
  return (
    <section class="principal">
      <CardBaseWarning />
      <CommanderHero />
      <div id="area-deck" hidden={!state.commanders.length}>
        <Tabs />

        <Panel tab="deck">
          <div class="comandante" id="cmd-box"><CommanderBox /></div>
          {/* O que está ERRADO fica aqui, sempre à vista, mesmo com a análise
              numa aba: uma carta fora da identidade não pode esperar a pessoa
              lembrar de conferir. */}
          <div id="alertas-deck"><DeckAlerts /></div>
          <ListTools />
          <div id="lista-deck"><BoardList board="deck" /></div>
          <div class="vazio" id="deck-vazio" hidden={state.cards.length > 0}>
            As 99 cartas entram pela busca. Comece pelas que o comandante pede.
          </div>
          <div class="rodape-deck">
            <button class="btn" id="btn-nova-categoria" onClick={newCategory}><SpriteIcon name="plus" /> Nova categoria</button>
            <span class="nota" style={{ flex: 1, minWidth: "160px" }}>Categoria é sua: "combo principal", "sac outlet".
              A carta sem categoria fica no grupo do tipo dela.</span>
          </div>
        </Panel>

        {/* O deck como ele vai sair do papel. Ao lado do Deck porque é a mesma
            lista vista de outro jeito, e é daqui que se escolhe arte em série. */}
        <Panel tab="artes">
          <h2 class="secao">Artes do deck</h2>
          <p class="nota">Uma imagem por arte que vai pro papel — carta de duas faces aparece duas vezes, frente e
            verso, e os tokens que o deck cria vêm no fim, um de cada. Clique numa pra escolher a arte que imprime;
            as de contorno dourado já têm arte escolhida, as outras saem com a arte padrão. O ✦ no canto marca a
            carta como foil.</p>
          <div class="galeria-acoes"><DefaultArtsButton /></div>
          <div id="galeria-resultado" style={{ marginTop: "12px" }}><Gallery /></div>
        </Panel>

        <Panel tab="analise">
          <h2 class="secao">Como o deck está</h2>
          <div id="apontamentos"><Issues /></div>
          {/* O nível de poder é a segunda coisa que se pergunta depois de "o
              deck está legal?", e a resposta cabe em três linhas. */}
          <h2 class="secao" style={{ marginTop: "16px" }}>Nível de poder</h2>
          <p class="nota" id="poder-nota">A escala oficial de brackets do Commander — e <b>por quê</b>, carta por
            carta. Quem classifica é o Commander Spellbook, que acompanha a lista de game changers da Wizards.</p>
          <div id="poder-resultado" style={{ marginTop: "10px" }}><Power /></div>
          <div class="distrib-duo" style={{ marginTop: "16px" }}>
            <div><h2 class="secao">Cores</h2><div class="distrib" id="distrib-cores"><ColorDistribution /></div></div>
            <div><h2 class="secao">Tipos</h2><div class="distrib" id="distrib-tipos"><TypeDistribution /></div></div>
          </div>
          <h2 class="secao" style={{ marginTop: "16px" }}>Chances de comprar</h2>
          <div id="chances"><Odds /></div>
        </Panel>

        <Panel tab="manabase" panelRef={manabaseRef}>
          <h2 class="secao">Mana base</h2>
          <ManabasePanel />
        </Panel>

        {/* Aqui só o que JÁ FECHA no deck. O que está a uma carta de fechar é
            uma lista de compras, e mora do outro lado da tela, junto da busca. */}
        <Panel tab="combos">
          <h2 class="secao">Combos no deck</h2>
          <p class="nota" id="combos-nota">Os combos que o Commander Spellbook reconhece entre as cartas que você já
            tem. Os que ficam a <b>uma carta</b> de fechar aparecem na aba <b>Combos</b> do painel de adicionar.</p>
          <div id="combos-resultado" style={{ marginTop: "12px" }}><DeckCombos /></div>
        </Panel>

        {/* As fichas são a única parte do deck que não vai dentro do deck: é
            material separado, que se esquece em casa. */}
        <Panel tab="tokens">
          <h2 class="secao">Tokens do deck</h2>
          <TokensPanel />
        </Panel>

        <Panel tab="historico">
          <h2 class="secao">Histórico</h2>
          <div id="historico-resultado" style={{ marginTop: "12px" }}><History /></div>
        </Panel>

        {/* Jogar sozinho pra ver se a mão anda. NÃO é motor de regras: nada
            aqui impede nada, e a dica ao lado do título diz isso. */}
        <Panel tab="goldfish">
          <GoldfishPanel />
        </Panel>
      </div>
    </section>
  );
}
