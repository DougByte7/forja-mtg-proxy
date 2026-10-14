/* Copiar texto. A página também roda em http na rede local, e aí
   `navigator.clipboard` simplesmente não existe — o navegador só o expõe em
   contexto seguro. O textarea escondido com execCommand é o caminho que
   ainda funciona lá. */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* segue pro plano B */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
