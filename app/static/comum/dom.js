/* =========================================================================
   O que as páginas da Forja usam pra falar com o DOM e que é IGUAL em todas.

   Só entra aqui o que não varia de uma página pra outra. `api` e `toast`
   parecem candidatos, mas cada página tem a sua de propósito — a do admin
   manda o token, a de decks pede `no-store` e lê erro que não é JSON — e
   juntá-las mudaria o comportamento delas. Hoje só o deckbuilder importa
   daqui; as outras páginas carregam cópias idênticas destas duas funções no
   próprio script.
   ========================================================================= */

export const $ = (id) => document.getElementById(id);

/* Texto seguro pra entrar num template HTML, inclusive como valor de atributo
   entre aspas duplas. */
export function escapar(txt){
  return String(txt == null ? "" : txt)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}
