/* O cabeçalho: o nome do deck (com a versão colada nele), o estado do
   autosave, os medidores e as ações. */
import { copyText } from "../../../shared/clipboard";
import { openHeaderMenu } from "../menus";
import { renameDeck, saveStatus } from "../save";
import { OrderLink } from "./Gallery";
import { GuardedInput } from "./GuardedInput";
import { Meters } from "./Meters";
import { SpriteIcon } from "./SpriteIcon";
import { toast } from "./toast";
import { useDeck } from "./useDeck";
import { VersionPill } from "./Versions";

async function shareLink(id: string) {
  const url = location.origin + location.pathname + "?deck=" + id;
  if (await copyText(url)) toast("Link copiado. Quem abrir vê e edita este mesmo deck.");
  else prompt("Link do deck:", url);
}

export function Header() {
  const state = useDeck();
  const status = saveStatus.value;
  return (
    <header class="topo">
      <div class="topo-in">
        <div class="rune"><span>⌘</span></div>
        <div class="titulo-deck">
          {/* A versão é um atributo do nome ("Atraxa v3"), e por isso mora
              colada nele. Ela é o estado e a porta: o clique abre o menu que
              conclui a próxima versão (ver `versions.ts`). */}
          <div class="titulo-linha">
            <GuardedInput id="nome-deck" value={state.name} maxlength={80} aria-label="Nome do deck" spellcheck={false}
                          onInput={(e: Event) => renameDeck((e.currentTarget as HTMLInputElement).value)} />
            <VersionPill />
          </div>
          <div class={"estado-salvo" + (status.cls ? " " + status.cls : "")} id="estado-salvo">{status.text}</div>
        </div>

        {/* O traço separa a identidade do deck (nome, estado do autosave) do
            estado dele (quantas cartas, quanto custa). */}
        <div class="divisor" />
        <div class="medidores" id="medidores"><Meters /></div>

        {/* O vão que empurra as ações pro canto direito. Sem ele, o traço e os
            medidores seriam afastados do nome do deck pelo crescimento do
            título, e os três blocos flutuariam no meio da barra. */}
        <div class="espaco" />

        <div class="acoes">
          {/* Link, e não botão: leva o deck pra tela de orçamento. Só ganha
              `href` com todas as artes escolhidas (ver `orderLinkView`). */}
          <OrderLink />
          <button class="btn ouro" id="btn-compartilhar" hidden={!state.id} onClick={() => shareLink(state.id!)}>
            Compartilhar</button>
          <button class="btn redondo" id="btn-mais" type="button" aria-haspopup="menu"
                  aria-expanded={false} title="Mais ações" aria-label="Mais ações"
                  onClick={(e) => openHeaderMenu(e.currentTarget)}>
            <SpriteIcon name="dots-three" /></button>
        </div>
      </div>
    </header>
  );
}
