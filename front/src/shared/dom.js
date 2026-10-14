/* =========================================================================
   O que o deckbuilder usa pra falar com o DOM. As telas em Preact não
   precisam disto (o JSX escapa sozinho); some quando o deckbuilder virar
   componentes.
   ========================================================================= */

export const $ = (id) => document.getElementById(id);

/* Texto seguro pra entrar num template HTML, inclusive como valor de atributo
   entre aspas duplas. */
export function escapar(txt){
  return String(txt == null ? "" : txt)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}
