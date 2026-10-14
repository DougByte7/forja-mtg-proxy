/* Pra onde voltar depois de entrar (ou de criar a conta).

   Só caminho relativo é aceito: um `?voltar=` que aceitasse URL inteira
   viraria redirecionamento aberto — o link parece do site, e joga a pessoa
   num clone que pede a senha de novo. `//outro.site` e `/\outro.site` também
   ficam de fora: o navegador lê os dois como outro domínio. */
export function returnPath(search: string = location.search): string {
  const raw = new URLSearchParams(search).get("voltar") || "";
  return /^\/[^/\\]/.test(raw) ? raw : "/";
}
