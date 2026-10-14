/* A aba Artes (a galeria e o atalho das artes padrão) e o "Gerar pedido" do
   cabeçalho. As contas são de `gallery.ts`. */
import type { ComponentChildren } from "preact";
import { applyDefaultsToMissing, artState, openArtPicker } from "../art";
import { defaultsShortcutHidden, galleryCount, galleryGroups, orderLinkView, type GalleryFrame } from "../gallery";
import { flushSave, isSavePending } from "../save";
import { toast } from "./toast";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* A imagem dentro de uma moldura que sabe deitar. Carta partida (os Rooms,
   Fire // Ice) é impressa de lado e a imagem vem em pé, com o texto de lado:
   a moldura toma a proporção da carta DEITADA e a imagem gira dentro dela —
   o mesmo giro da prévia e da modal da carta. */
export function Frame({ src, lying, children }: { src?: string; lying?: boolean; children?: ComponentChildren }) {
  return (
    <span class={"quadro" + (lying ? " deitada" : "")}>
      {src && <img src={src} alt="" loading="lazy" referrerpolicy="no-referrer" />}
      {children}
    </span>
  );
}

function GalleryCard({ frame: f }: { frame: GalleryFrame }) {
  return (
    <button class={"galeria-carta" + (f.chosen ? " tem-arte" : "") + (f.lying ? " deitada" : "")}
            data-arte-carta={f.artCard} data-arte-face={f.face} data-arte-copia={f.copy || undefined}
            data-arte={f.preview || undefined} data-deitada={f.preview && f.lying ? "1" : undefined}
            title={`${f.label} — ${f.situation}`} aria-label={`${f.label}: ${f.situation}`}
            onClick={() => openArtPicker(f.artCard, f.face, f.copy)}>
      <Frame src={f.src} lying={f.lying}>
        {f.chosen && <span class="galeria-marca"><SpriteIcon name="check" /></span>}
        {f.quantity > 1 && <span class="galeria-qtd">{f.quantity}×</span>}
      </Frame>
      <span class="galeria-selo">{f.badge}</span>
    </button>
  );
}

export function Gallery() {
  useDeck();
  const groups = galleryGroups();
  if (!groups.length) return null;
  const { total, chosen } = galleryCount();
  const pct = total ? (chosen / total) * 100 : 0;
  return (
    <>
      <div class="progresso">
        <div class="texto"><span>{chosen === total ? "Todas as artes escolhidas" : "Artes escolhidas"}</span>
          <b>{`${chosen}/${total}`}</b></div>
        <span class="trilho"><span class="cheio" style={{ width: `${pct}%` }} /></span>
      </div>
      {groups.map((g) => (
        <div class="galeria-grupo" key={g.title}>
          <h3>{g.title}</h3>
          <div class="galeria-grade">{g.frames.map((f) => <GalleryCard key={f.key} frame={f} />)}</div>
        </div>
      ))}
    </>
  );
}

export function DefaultArtsButton() {
  useDeck();
  return (
    <button class="btn" id="btn-artes-padrao" type="button" hidden={defaultsShortcutHidden()}
            disabled={artState.applyingDefaults} onClick={applyDefaultsToMissing}>
      Usar a arte padrão nas que faltam
    </button>
  );
}

/* O link segue sozinho quando o servidor já tem o deck da tela. Com uma
   gravação pendente, grava antes: senão o pedido sairia sem a última carta. */
async function followOrderLink(e: MouseEvent) {
  const link = e.currentTarget as HTMLAnchorElement;
  if (!link.hasAttribute("href") || !isSavePending()) return;
  e.preventDefault();
  if (await flushSave()) location.href = link.href;
  else toast("Não consegui salvar o deck — o pedido fica pra depois.");
}

export function OrderLink() {
  useDeck();
  const v = orderLinkView();
  return (
    <a class="btn" id="btn-pedido" hidden={v.hidden} href={v.href} aria-disabled={!v.href}
       title={v.title} onClick={followOrderLink}>Gerar pedido</a>
  );
}
