/* As ilhas: as partes da página que já são componentes Preact, cada uma
   montada no contêiner que a marcação reserva pra ela. O resto da página
   ainda é HTML em string (ver o plano da Fase 4d); a ponte entre os dois
   mundos é `deckRevision`, em `state.ts`. */
import { render } from "preact";
import { $ } from "../../shared/dom.js";
import {
  ColorDistribution, Curve, DeckAlerts, IdentityNote, Issues, Odds, Power, TypeDistribution,
} from "./ui/Analysis";
import { Meters } from "./ui/Meters";
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
}
