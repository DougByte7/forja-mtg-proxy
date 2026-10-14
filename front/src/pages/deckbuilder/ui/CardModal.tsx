/* A modal da carta inteira (ver `cardDetail.ts`). */
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import {
  brDay, cardFacts, cardImages, cardModal, cardModalOpen, closeCard, faceStats, localFace,
  referencePrices, type CardFace, type CardInfo,
} from "../cardDetail";
import { ManaCost, ManaText } from "./Mana";
import { SpriteIcon } from "./SpriteIcon";

/* Cabeça por face só quando são duas: numa carta de face única ela repetiria
   o nome e o tipo que estão logo acima. */
function Face({ f, withHead }: { f: CardFace; withHead: boolean }) {
  const stats = faceStats(f);
  return (
    <div class="carta-face">
      {withHead && (
        <div class="cabeca"><b>{f.nome}</b><ManaCost cost={f.mana_cost} /><span class="tipo">{f.tipo}</span></div>
      )}
      {f.texto && <p class="carta-oracle"><ManaText text={f.texto} /></p>}
      {f.sabor && <p class="carta-sabor">{f.sabor}</p>}
      {stats && <div class="carta-pt">{stats}</div>}
    </div>
  );
}

export function ReferencePrices({ info }: { info: CardInfo }) {
  const chips = referencePrices(info);
  if (!chips.length) return null;
  return (
    <div>
      <h2 class="secao">Preço de referência</h2>
      <div class="carta-chips">{chips.map(([label, v]) => <span class="carta-chip">{label} <b>{v}</b></span>)}</div>
    </div>
  );
}

/* "Notes and Rules Information" é como a Scryfall chama isto na página da
   carta. São os rulings — as respostas oficiais sobre como a carta funciona,
   e a razão principal de esta modal existir: é a informação que não cabe na
   linha do deck e que ninguém decora. */
function Rulings({ info }: { info: CardInfo }) {
  const rulings = info.regras || [];
  if (!rulings.length) return null;
  return (
    <div>
      <h2 class="secao">Notas e regras ({rulings.length})</h2>
      {rulings.map((r) => (
        <div class="regra"><span class="quando">{brDay(r.data)}</span><p><ManaText text={r.texto} /></p></div>
      ))}
    </div>
  );
}

function Facts({ info }: { info: CardInfo }) {
  const items = cardFacts(info);
  if (!items.length) return null;
  return (
    <div class="carta-dados">
      {items.map(([label, value]) => <div><span class="rot">{label}</span><span class="val">{value}</span></div>)}
    </div>
  );
}

function Links({ info, fallback }: { info: CardInfo; fallback?: string }) {
  const scryfall = info.scryfall || fallback;
  if (!scryfall && !info.gatherer) return null;
  return (
    <div class="carta-links">
      {scryfall && <a href={scryfall} target="_blank" rel="noopener">Ver na Scryfall <SpriteIcon name="arrow-square-out" /></a>}
      {info.gatherer && <a href={info.gatherer} target="_blank" rel="noopener">Gatherer <SpriteIcon name="arrow-square-out" /></a>}
    </div>
  );
}

export function CardModal() {
  const shown = cardModal.value;
  const open = cardModalOpen.value;
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const name = shown?.card.nome;
  useEffect(() => { if (name) closeRef.current?.focus(); }, [name]);
  // O topo só na primeira pintura desta carta: o detalhe chega depois e
  // repinta, e rolar de volta ali jogaria fora o oracle que a pessoa já
  // estava lendo.
  useLayoutEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [name]);
  if (!shown) return <div class="carta-fundo" id="carta-fundo" hidden />;
  const { card, info } = shown;
  const faces = info && info.faces?.length ? info.faces : [localFace(card)];
  const type = info ? faces.map((f) => f.tipo).filter(Boolean).join(" // ") : card.tipo || "";
  return (
    // Só o fundo fecha: clique dentro da modal (selecionar um trecho de
    // ruling, por exemplo) não pode fechá-la.
    <div class={"carta-fundo" + (open ? " aberta" : "")} id="carta-fundo"
         onClick={(e) => { if (e.target === e.currentTarget) closeCard(); }}>
      <div class="carta-modal" role="dialog" aria-modal="true" aria-labelledby="carta-titulo">
        <button class="mini sai carta-x" id="btn-fechar-carta" ref={closeRef} aria-label="Fechar" title="Fechar (Esc)"
                onClick={closeCard}><SpriteIcon name="x" /></button>
        <div class={"carta-arte" + (card.deitada ? " deitada" : "")} id="carta-arte">
          {cardImages(card, info).map((u) => <img key={u} src={u} alt={card.nome} />)}
        </div>
        <div class="carta-corpo" id="carta-corpo" ref={bodyRef}>
          <div class="carta-topo">
            <h2 id="carta-titulo">{card.nome}<ManaCost cost={card.mana_cost} /></h2>
            <p class="tipo">{type}</p>
            {info && info.edicao && <p class="edicao">{info.edicao_sigla} · {info.edicao}</p>}
          </div>
          <div>{faces.map((f) => <Face f={f} withHead={faces.length > 1} />)}</div>
          {/* As notas de regras vêm logo depois do oracle porque são a
              continuação dele. Edição, ilustração e preço são ficha técnica
              e podem esperar. */}
          {info ? (
            <>
              <Rulings info={info} />
              <Facts info={info} />
              <ReferencePrices info={info} />
              <Links info={info} fallback={card.scryfall as string | undefined} />
            </>
          ) : info === null ? (
            <div class="carta-nota">Buscando edição, ambientação e notas de regras na Scryfall…</div>
          ) : (
            <div class="carta-nota">A Scryfall não respondeu agora — o que está aí em cima é o que a base local
              guarda. Fechar e abrir de novo tenta outra vez.</div>
          )}
        </div>
      </div>
    </div>
  );
}
