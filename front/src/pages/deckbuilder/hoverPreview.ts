/* Prévia da arte ao passar o mouse. Só no mouse: em toque ela roubaria o
   clique, e a lista já mostra tipo e custo.

   Uma função só pra tela inteira — a lista do deck, a busca, as sugestões, os
   terrenos que fixam e as peças de combo entram nela só por carregarem os
   atributos que `previewProps` (em `ui/preview.ts`) escreve. É DOM direto, e
   não componente, de propósito: ela anda a cada movimento do mouse, e um
   redesenho por quadro seria trabalho jogado fora. */

const PREVIEW_WIDTH = 250;    // largura da carta em pé
const PREVIEW_HEIGHT = 349;   // altura dela, na proporção 488x680 da Scryfall
const PREVIEW_LYING = 487;    // largura da carta girada (a altura vira largura)
const PREVIEW_GAP = 8;        // o `gap` do CSS entre frente e verso

/* As artes já pedidas, presas aqui pra continuarem no cache de imagens do
   navegador: com elas vivas, trocar o `src` da prévia mostra a carta no mesmo
   quadro, sem esperar rede nem decodificação. */
const warmed = new Map<string, HTMLImageElement>();

function warm(url: string | undefined) {
  if (!url || warmed.has(url)) return;
  const img = new Image();
  img.referrerPolicy = "no-referrer";   // o mesmo das <img> da prévia
  img.decoding = "async";
  img.src = url;
  warmed.set(url, img);
}

/* Baixa de antemão a arte de toda carta que está na tela, no tempo ocioso.
   Esperar o mouse chegar na carta pra só então pedir a imagem é o atraso que
   se vê. O observador pega o que entra depois — a busca, as sugestões, a
   carta adicionada. */
function preloadArts() {
  const idle = window.requestIdleCallback || ((fn: () => void) => setTimeout(fn, 200));
  let scheduled = false;
  const scan = () => {
    scheduled = false;
    for (const el of document.querySelectorAll<HTMLElement>("[data-arte]")) {
      warm(el.dataset.arte);
      if (el.dataset.deitada !== "1") warm(el.dataset.arteVerso);
    }
  };
  const schedule = () => { if (!scheduled) { scheduled = true; idle(scan); } };
  new MutationObserver(schedule).observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-arte", "data-arte-verso"],
  });
  schedule();
}

export function bindHoverPreview() {
  const preview = document.getElementById("previa")!;
  const front = document.getElementById("previa-frente") as HTMLImageElement;
  const back = document.getElementById("previa-verso") as HTMLImageElement;
  // Arte que não carrega deixaria uma caixa vazia com borda seguindo o mouse,
  // que parece defeito da página e não carta sem imagem. Se só o verso falha,
  // a frente continua valendo.
  front.addEventListener("error", () => preview.classList.remove("mostra"));
  back.addEventListener("error", () => back.classList.add("vazia"));
  // Enquanto a arte nova não chega o <img> segue mostrando a anterior, e por
  // um instante a prévia é de outra carta. Fica escondida até as duas faces
  // estarem prontas.
  const ready = () => front.complete && (back.classList.contains("vazia") || back.complete);
  const reveal = () => { if (ready()) preview.classList.remove("carregando"); };
  front.addEventListener("load", reveal);
  back.addEventListener("load", reveal);
  preloadArts();

  // Guardada porque o mousemove precisa dela a cada quadro e medir o elemento
  // ali dentro forçaria um reflow por movimento do mouse.
  let width = PREVIEW_WIDTH;

  document.addEventListener("mouseover", (e) => {
    const target = (e.target as Element).closest?.("[data-arte]") as HTMLElement | null;
    const art = target?.dataset.arte;
    if (!art) { preview.classList.remove("mostra"); return; }
    // Carta partida tem uma face física só: o verso e o giro nunca convivem.
    const lying = target!.dataset.deitada === "1";
    const behind = lying ? "" : (target!.dataset.arteVerso || "");
    front.src = art;
    back.classList.toggle("vazia", !behind);
    if (behind) back.src = behind;
    preview.classList.toggle("deitada", lying);
    warm(art); warm(behind);
    preview.classList.toggle("carregando", !ready());
    preview.classList.add("mostra");
    width = lying ? PREVIEW_LYING : behind ? PREVIEW_WIDTH * 2 + PREVIEW_GAP : PREVIEW_WIDTH;
  });

  document.addEventListener("mousemove", (e) => {
    if (!preview.classList.contains("mostra")) return;
    // Cai pro outro lado do cursor quando não cabe à direita, e sobe quando
    // não cabe embaixo: prévia cortada pela borda da janela não mostra a
    // carta, que é a única coisa que ela existe pra fazer.
    const y = Math.min(e.clientY + 14, window.innerHeight - PREVIEW_HEIGHT - 8);
    const x = e.clientX + 18 + width > window.innerWidth - 8 ? e.clientX - 18 - width : e.clientX + 18;
    preview.style.left = Math.max(8, x) + "px";
    preview.style.top = Math.max(8, y) + "px";
  });
}
