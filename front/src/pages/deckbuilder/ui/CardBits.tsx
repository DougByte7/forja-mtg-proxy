/* Os pedaços de uma linha de carta que aparecem em mais de um lugar: o botão
   de arte, o preço, a etiqueta de inédita e a marca de foil. */
import { artButtonView } from "../art";
import { openArtPicker } from "../art";
import { priceView } from "../budget";
import { foilCopies } from "../foil";
import { brDate } from "../text";
import type { Card, Entry } from "../types";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* O botão de arte na linha. Mostra a miniatura quando há arte escolhida, e o
   ícone quando está no padrão: ver de relance o que já foi customizado é
   metade do valor. É o botão da FRENTE; o verso se escolhe dentro da modal. */
export function ArtButton({ card }: { card: Card }) {
  const v = artButtonView(card);
  return (
    <button class={"mini" + (v.escolhida ? " tem-arte" : "")}
            onClick={(e) => { e.stopPropagation(); openArtPicker(card.nome); }}
            style={v.escolhida ? { backgroundImage: `url('${v.miniatura}')` } : undefined}
            title={v.titulo} aria-label={`Escolher arte de ${card.nome}`}>
      {!v.escolhida && <SpriteIcon name="image" />}
    </button>
  );
}

/* O ✦ ao lado do nome da carta com cópia no foil. Lê o deck por conta
   própria: marcar foil na galeria não muda as props da linha. */
export function FoilMark({ card, quantity }: { card: Card; quantity: number }) {
  useDeck();
  const n = foilCopies(card).length;
  if (!n) return null;
  const title = n >= quantity ? "Sai no foil" : `${n} de ${quantity} cópias no foil`;
  return <span class="foil-marca" title={title} aria-label={title}>✦{n < quantity ? ` ${n}` : ""}</span>;
}

export function PriceCell({ entry }: { entry: Entry }) {
  const v = priceView(entry);
  return <span class={v.classe} title={v.titulo}>{v.texto}</span>;
}

/* A marca da carta que ainda não saiu. É a única carta da lista que não se
   pode comprar nem jogar hoje, e nada no nome, no tipo ou no custo diz isso —
   então é uma etiqueta com palavra, e não um ícone, com a data no `title`. */
export function UnreleasedTag({ card }: { card: Card | null | undefined }) {
  if (!card?.inedita) return null;
  return <span class="selo-inedita" title={"Ainda não lançada" + (card.sai_em ? " — sai em " + brDate(card.sai_em) : "")}>inédita</span>;
}
