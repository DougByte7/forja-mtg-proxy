/* Os atributos que ligam um elemento à prévia que segue o mouse (ver
   `ligarPrevia`, em `carta.js`, que lê `data-arte` por delegação). Passar a
   carta inteira em vez de só a URL é o que faz a carta de duas faces aparecer
   inteira; cada lado sai pela `imagemDaFace`, então com arte escolhida a
   prévia mostra o arquivo que vai pro papel. */
import { imagemDaFace } from "../artes.js";
import type { Card } from "../types";

export function previewProps(card: Card | null | undefined, choices?: unknown): Record<string, string> {
  if (!card || !card.imagem) return {};
  const props: Record<string, string> = { "data-arte": imagemDaFace(card, "frente", 0, choices) };
  if (card.imagem_verso) props["data-arte-verso"] = imagemDaFace(card, "verso", 0, choices);
  if (card.deitada) props["data-deitada"] = "1";
  return props;
}
