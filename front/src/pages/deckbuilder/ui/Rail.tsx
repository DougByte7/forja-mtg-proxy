/* ================= esquerda: pôr carta no deck =================
   Um painel só, com abas. Busca, sugestão do EDHREC e combo a uma carta de
   fechar são três formas de responder a MESMA pergunta ("que carta entra
   agora?"), e trocar de forma tem que ser um clique. */
import { createCategory } from "../editing";
import { closeSheet, sheetOpen, switchRail, type Rail as RailName } from "../layout";
import { askNewCategory } from "../menus";
import { onSearchKey, searchText, typeSearch } from "../search";
import { state as deckState, touch } from "../state";
import { IdentityNote } from "./Analysis";
import { CombosTabCount, NearCombos } from "./Combos";
import { FiltersButton, FilterTape } from "./Filters";
import { DestinationCategory, DestinationSegment, SearchResults } from "./Search";
import { SpriteIcon } from "./SpriteIcon";
import { AverageDeck, SuggestionsPanel } from "./Suggestions";
import { useDeck } from "./useDeck";

/* Cada aba leva um ícone porque um deles precisa existir SOZINHO em outro
   canto da tela: a estrela é o botão de sugestão que aparece no hover de
   cada carta do deck, e chegar aqui por ele só se lê como "cheguei onde
   cliquei" se o desenho for o mesmo. */
const RAILS: [RailName, string, string][] = [
  ["buscar", "magnifying-glass", "Adicionar"], ["sugestoes", "sparkle", "Sugestões"], ["combos", "lightning", "Combos"],
];

/* Criar daqui não mexe em carta nenhuma: cria a categoria vazia e já a
   deixa escolhida, pra que as próximas cartas da busca caiam nela. */
function newDestinationCategory() {
  const name = askNewCategory();
  if (!name) return;
  deckState.destinoCategoria = createCategory(name) || "";
  touch();
}

function Content({ rail, children }: { rail: RailName; children: preact.ComponentChildren }) {
  return <div class="rail-conteudo" data-rail={rail} hidden={deckState.rail !== rail}>{children}</div>;
}

export function Rail() {
  const state = useDeck();
  return (
    <aside class={"lateral" + (sheetOpen.value ? " aberta" : "")} id="lateral">
      <span class="puxador" id="puxador" onClick={closeSheet} />
      <div class="painel" id="painel-adicionar">
        <div class="abas-painel miuda" id="abas-rail" role="tablist">
          {RAILS.map(([rail, icon, label]) => (
            <button role="tab" data-rail={rail} class={state.rail === rail ? "ativa" : undefined}
                    aria-selected={state.rail === rail} onClick={() => switchRail(rail)}>
              <SpriteIcon name={icon} />
              {" "}{label}
              {rail === "combos" && <> <span class="n" id="rail-combos-n"><CombosTabCount list="faltando_uma" /></span></>}
            </button>
          ))}
        </div>

        <Content rail="buscar">
          <div class="linha-busca">
            <input class="campo" id="busca" autocomplete="off" spellcheck={false} placeholder="Buscar carta…  (tecle /)"
                   value={searchText.main.value} onInput={(e) => typeSearch("main", e.currentTarget.value)}
                   onKeyDown={(e) => onSearchKey(e, "main")} />
            <FiltersButton />
          </div>
          <div class="ligados" id="ligados"><FilterTape /></div>

          {/* Pra onde a carta vai, decidido UMA vez em vez de carta por carta
              no menu de cada linha depois de adicionada. */}
          <div class="destino">
            <div class="destino-linha">
              <span class="destino-rot">Vai para</span>
              <DestinationSegment />
            </div>
            <div class="destino-linha">
              <span class="destino-rot">Categoria</span>
              <DestinationCategory />
              <button type="button" class="btn-nova-cat" id="btn-nova-cat" onClick={newDestinationCategory}
                      title={'Criar uma categoria sua — "combo principal", "sac outlet" — e já mandar as próximas cartas pra ela'}
                      aria-label="Criar nova categoria"><SpriteIcon name="plus" /></button>
            </div>
          </div>

          <IdentityNote />
          <div class="resultados" id="res"><SearchResults box="main" /></div>
        </Content>

        <Content rail="sugestoes">
          <p class="nota" id="sug-nota">Cartas que combinam, segundo os decks registrados no EDHREC; a sinergia diz o
            quanto cada uma aparece mais junto do alvo da lista do que num deck qualquer. A lista começa no
            <b> comandante</b> — a estrela no hover de qualquer carta do deck troca pra <b>ela</b>.</p>
          <AverageDeck />
          <div id="sug-resultado" style={{ marginTop: "4px" }}><SuggestionsPanel /></div>
        </Content>

        <Content rail="combos">
          <p class="nota" id="combos-rail-nota">Combos que o deck fecha com <b>uma carta</b> a mais. Cada peça que
            falta tem um botão pra entrar direto no deck.</p>
          <div id="combos-rail-resultado" style={{ marginTop: "4px" }}><NearCombos /></div>
        </Content>
      </div>
    </aside>
  );
}
