/* As ilhas: as partes da página que já são componentes Preact, cada uma
   montada no contêiner que a marcação reserva pra ela. O resto da página
   ainda é HTML em string (ver o plano da Fase 4d); a ponte entre os dois
   mundos é `deckRevision`, em `state.ts`. */
import { render } from "preact";
import { $ } from "../../shared/dom.js";
import {
  ColorDistribution, Curve, DeckAlerts, IdentityNote, Issues, Odds, Power, TypeDistribution,
} from "./ui/Analysis";
import { CombosTabCount, DeckCombos, NearCombos } from "./ui/Combos";
import { BoardList, CommanderBox, DeckTabCount, MaybeCount } from "./ui/DeckList";
import { importarLinkColado } from "./eventos.js";
import { FilterFields, FiltersButton, FilterTape, HeroUnreleasedSwitch } from "./ui/Filters";
import { ManabasePanel } from "./ui/Manabase";
import { Meters } from "./ui/Meters";
import { DestinationCategory, DestinationSegment, SearchResults } from "./ui/Search";
import { SuggestionsPanel } from "./ui/Suggestions";
import { TokensPanel, TokensTabCount } from "./ui/Tokens";
import { History, VersionPill } from "./ui/Versions";
import { Toast } from "./ui/toast";

export function mountIslands() {
  render(<Meters />, $("medidores")!);
  render(<Toast />, $("ilha-toast")!);
  render(<DeckAlerts />, $("alertas-deck")!);
  render(<Issues />, $("apontamentos")!);
  render(<Power />, $("poder-resultado")!);
  render(<ColorDistribution />, $("distrib-cores")!);
  render(<TypeDistribution />, $("distrib-tipos")!);
  render(<Odds />, $("chances")!);
  render(<Curve />, $("curva")!);
  render(<IdentityNote />, $("ilha-nota-identidade")!);
  render(<VersionPill />, $("ilha-versao")!);
  render(<History />, $("historico-resultado")!);
  render(<TokensPanel />, $("ilha-tokens")!);
  render(<TokensTabCount />, $("aba-tokens-n")!);
  render(<DeckCombos />, $("combos-resultado")!);
  render(<NearCombos />, $("combos-rail-resultado")!);
  render(<CombosTabCount list="no_deck" />, $("aba-combos-n")!);
  render(<CombosTabCount list="faltando_uma" />, $("rail-combos-n")!);
  render(<ManabasePanel />, $("ilha-manabase")!);
  render(<CommanderBox />, $("cmd-box")!);
  render(<BoardList board="deck" />, $("lista-deck")!);
  render(<BoardList board="talvez" />, $("talvez-lista")!);
  render(<DeckTabCount />, $("aba-deck-n")!);
  render(<MaybeCount />, $("ilha-talvez-n")!);
  render(<SearchResults box="main" />, $("res")!);
  render(<SearchResults box="cmd" onImportLink={importarLinkColado} />, $("res-cmd")!);
  render(<DestinationSegment />, $("ilha-destino")!);
  render(<DestinationCategory />, $("ilha-categoria-destino")!);
  render(<FiltersButton />, $("ilha-btn-filtros")!);
  render(<FilterTape />, $("ligados")!);
  render(<FilterFields />, $("campos-filtros")!);
  render(<HeroUnreleasedSwitch />, $("ilha-cmd-ineditas")!);
  render(<SuggestionsPanel />, $("sug-resultado")!);
}
