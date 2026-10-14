/* O deck mudou: a tela inteira se redesenha (`touch`), a pílula da versão
   confere se a lista se afastou da última versão, e a cotação persegue o
   deck — cada mudança marca uma nova, que só sai depois de o deck ficar
   quieto (ver `scheduleQuote`). */
import { scheduleQuote } from "./budget";
import { touch } from "./state";
import { syncVersion } from "./versions";

export function redrawAll() {
  touch();
  syncVersion();
  scheduleQuote();
}
