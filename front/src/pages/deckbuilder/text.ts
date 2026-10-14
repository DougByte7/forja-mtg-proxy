/* Texto: datas, busca sem acento e o reconhecimento de link de deck. */

/** "2026-11-13" vira "13/11/2026". */
export function brDate(iso: string | null | undefined) {
  return String(iso || "").split("-").reverse().join("/");
}

/* Texto reduzido ao que se digita de fato: minúsculo e sem acento. Quem
   procura "jotun" no deck quer achar o Jötun Grunt — o trema está no nome da
   carta, não no teclado de quem busca. */
export function foldAccents(s: string | null | undefined) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/* De que site é este link de deck — `"Archidekt"`, `"Moxfield"` ou nada.

   Serve pra uma caixa de texto saber que o que caiu nela não é nome de
   carta: nenhuma carta tem "moxfield.com" no nome, então a pergunta não é
   ambígua e nada precisa ser adivinhado. Os dois padrões são os do
   `importar.py` — quem decide de verdade se o link presta é o servidor, e
   este teste só escolhe o que oferecer na tela. */
export function deckLinkSource(text: string) {
  if (/archidekt\.com\/(?:api\/)?decks\/\d+/i.test(text)) return "Archidekt";
  if (/moxfield\.com\/decks\/[A-Za-z0-9_-]+/i.test(text)) return "Moxfield";
  return null;
}
