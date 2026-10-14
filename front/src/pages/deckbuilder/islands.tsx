/* As ilhas: as partes da página que já são componentes Preact, cada uma
   montada no contêiner que a marcação reserva pra ela. O resto da página
   ainda é HTML em string (ver o plano da Fase 4d); a ponte entre os dois
   mundos é `deckRevision`, em `state.ts`. */
import { render } from "preact";
import { $ } from "../../shared/dom.js";
import { Meters } from "./ui/Meters";
import { Toast } from "./ui/toast";

export function mountIslands() {
  render(<Meters />, $("medidores")!);
  render(<Toast />, $("ilha-toast")!);
}
