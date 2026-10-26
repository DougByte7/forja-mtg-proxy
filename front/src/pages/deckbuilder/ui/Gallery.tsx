/* A aba Artes (a galeria e o atalho das artes padrão) e o "Gerar pedido" do
   cabeçalho. As contas são de `gallery.ts`. */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { applyDefaultsToMissing, artState, findArtCard, openArtPicker } from "../art";
import { BACK_FOLLOWS_FRONT, setFoilCountOf } from "../foil";
import {
  defaultsShortcutHidden, galleryCount, galleryGroups, orderLinkView, paperCount, type GalleryFrame,
} from "../gallery";
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
    <div class={"galeria-item" + (f.lying ? " deitada" : "")}>
      <button class={"galeria-carta" + (f.chosen ? " tem-arte" : "") + (f.lying ? " deitada" : "") + (f.foil ? " foil" : "")}
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
      <FoilToggle frame={f} />
    </div>
  );
}

/* O ✦ do quadro. Fora do botão do quadro (botão dentro de botão não existe),
   por cima dele, no canto. Uma cópia: liga e desliga. Mais de uma: abre o
   contador, porque "3 das 30 Florestas" é um pedido comum e o ✦ sozinho só
   diria "todas" ou "nenhuma". No verso, travado: ele mostra o que a frente
   decidiu, e o title diz onde se muda. */
function FoilToggle({ frame: f }: { frame: GalleryFrame }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const card = () => findArtCard(f.artCard);
  const set = (count: number) => { const c = card(); if (c) setFoilCountOf(c, f.copies, count); };
  const many = f.quantity > 1;
  const label = !f.foilable ? (f.foil ? "Sai no foil junto com a frente. " : "") + BACK_FOLLOWS_FRONT
    : many ? `Foil: ${f.foil} de ${f.quantity} — clique pra mudar`
    : f.foil ? "Sai no foil — clique pra voltar ao padrão" : "Marcar como foil";
  return (
    <div class="foil-ctrl" ref={box}>
      <button type="button" class={"foil-btn" + (f.foil ? " ligado" : "")} disabled={!f.foilable}
              aria-pressed={many ? undefined : !!f.foil} aria-expanded={many ? open : undefined}
              title={label} aria-label={`${f.label}: ${label}`}
              onClick={() => many ? setOpen(!open) : set(f.foil ? 0 : 1)}>
        <span aria-hidden="true">✦</span>{many && f.foil > 0 && <span class="foil-n">{f.foil}</span>}
      </button>
      {open && (
        <div class="foil-pop" role="group" aria-label="Cópias no foil">
          <span class="foil-pop-tit">Cópias no foil</span>
          <div class="foil-passo">
            <button type="button" class="mini" aria-label="Uma a menos no foil" disabled={!f.foil}
                    onClick={() => set(f.foil - 1)}>−</button>
            <b>{f.foil}</b><span>de {f.quantity}</span>
            <button type="button" class="mini" aria-label="Uma a mais no foil" disabled={f.foil >= f.quantity}
                    onClick={() => set(f.foil + 1)}>+</button>
          </div>
          <div class="foil-atalhos">
            <button type="button" class="btn" disabled={!f.foil} onClick={() => set(0)}>Nenhuma</button>
            <button type="button" class="btn" disabled={f.foil >= f.quantity} onClick={() => set(f.quantity)}>Todas</button>
          </div>
        </div>
      )}
    </div>
  );
}

type FinishFilter = "todas" | "foil" | "padrao";
const FINISH_FILTERS: [FinishFilter, string][] = [["todas", "Todas"], ["foil", "Foil"], ["padrao", "Padrão"]];

function keepFrame(f: GalleryFrame, filter: FinishFilter) {
  if (filter === "foil") return f.foil > 0;
  if (filter === "padrao") return f.foil < f.quantity;
  return true;
}

export function Gallery() {
  useDeck();
  const [filter, setFilter] = useState<FinishFilter>("todas");
  const groups = galleryGroups();
  if (!groups.length) return null;
  const { total, chosen } = galleryCount();
  const paper = paperCount();
  const pct = total ? (chosen / total) * 100 : 0;
  // Sem foil nenhum, o filtro não tem o que separar — volta pra "Todas".
  const active = paper.foil ? filter : "todas";
  const shown = groups.map((g) => ({ ...g, frames: g.frames.filter((f) => keepFrame(f, active)) }))
    .filter((g) => g.frames.length);
  return (
    <>
      <div class="progresso">
        <div class="texto"><span>{chosen === total ? "Todas as artes escolhidas" : "Artes escolhidas"}</span>
          <b>{`${chosen}/${total}`}</b></div>
        <span class="trilho"><span class="cheio" style={{ width: `${pct}%` }} /></span>
      </div>
      <div class="acabamento-linha">
        <span class="acabamento-conta">
          {paper.foil
            ? <><b>{paper.standard}</b> padrão · <b class="foil-cor">✦ {paper.foil}</b> foil</>
            : <>Nenhuma carta no foil — marque no <span class="foil-cor">✦</span> de cada carta.</>}
        </span>
        {paper.foil > 0 && (
          <div class="segmento acabamento-filtro" role="group" aria-label="Mostrar">
            {FINISH_FILTERS.map(([k, label]) => (
              <button type="button" class={k === active ? "ativa" : undefined} aria-pressed={k === active}
                      onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {paper.foil > 0 && paper.standard > 0 && (
        <p class="nota acabamento-nota">O foil sai num pedido à parte, no mesmo Pix: a laminação é da folha
          inteira. A do resto você escolhe na tela do pedido.</p>
      )}
      {shown.map((g) => (
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
