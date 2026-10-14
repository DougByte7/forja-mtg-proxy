/* A arte de uma carta: de onde vem a miniatura e como a carta se chama. */
import type { CardMeta } from "./xml";

/** O nome pra tela: o do arquivo da arte (é a arte que se confere aqui),
    com a busca e o id como reserva. */
export function cardTitle(meta: CardMeta) {
  const name = (meta.name || "").replace(/\.(png|jpe?g|webp|gif)$/i, "").trim();
  return name || (meta.query || "").trim() || meta.id;
}

/** O nome que o backend vai enxergar. Tem que seguir a MESMA regra do
    `calc._card_name` (o <query> na frente, o nome do arquivo como reserva),
    senão o comandante escolhido aqui não casa com a carta lá. */
export function quoteName(meta: CardMeta) {
  const q = (meta.query || "").trim().replace(/\s+/g, " ");
  return q || (meta.name || "").trim().replace(/\s+/g, " ");
}

/* De onde vem a miniatura, pelo prefixo do id (ver `arte_id.py` no
   backend). A do Drive, igual ao download do backend, não é API oficial —
   por isso tem um endereço alternativo e, se os dois falharem, o nome da
   carta aparece no lugar da arte. */
export function artSources(id: string, width: number): string[] {
  const scryfall = /^scryfall:([0-9a-f]{8}-[0-9a-f-]{27}):(front|back)$/.exec(id);
  if (scryfall) {
    const imp = scryfall[1];
    return [`https://cards.scryfall.io/${width > 488 ? "large" : "normal"}/${scryfall[2]}/${imp[0]}/${imp[1]}/${imp}.jpg`];
  }
  const uploaded = /^enviada:([0-9a-f]{64})$/.exec(id);
  if (uploaded) return [`/artes/enviadas/${uploaded[1]}/miniatura`];
  return [
    `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`,
    `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}=w${width}`,
  ];
}
