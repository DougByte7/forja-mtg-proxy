/* Um ícone do sprite da página (os `<symbol id="i-…">` no topo do HTML).
   Sai `aria-hidden` porque quase todo botão daqui já se nomeia pelo `title`
   ou pelo `aria-label`; quando o ícone é a ÚNICA informação, passe `label`
   e ele vira imagem com nome. */
export function SpriteIcon({ name, label }: { name: string; label?: string }) {
  return label
    ? <svg class="ico" role="img" aria-label={label}><use href={`#i-${name}`} /></svg>
    : <svg class="ico" aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}
