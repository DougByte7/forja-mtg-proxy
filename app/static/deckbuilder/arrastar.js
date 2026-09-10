"use strict";

/* -------------------------------------------------------------- arrastar

   Atalho de quem tem mouse, nunca o único caminho: no toque não existe
   `dragstart`, e a mesma carta se move pelo ⋯ da linha. Solta em cima de um
   grupo (muda a categoria, e o tabuleiro se for o outro) ou em cima da
   coluna do maybeboard (que aceita a carta na categoria em que ela já
   estava). */
let arrastando = null;

function ligarArrastar(){
  document.addEventListener("dragstart", (e) => {
    const linha = e.target.closest?.(".linha");
    if (!linha){ return; }
    arrastando = {nome: linha.dataset.nome, tabuleiro: linha.dataset.tabuleiro};
    linha.classList.add("arrastando");
    e.dataTransfer.effectAllowed = "move";
    // Firefox só dispara `drop` quando alguma coisa foi escrita aqui.
    e.dataTransfer.setData("text/plain", linha.dataset.nome);
  });
  document.addEventListener("dragend", () => {
    document.querySelectorAll(".linha.arrastando")
      .forEach(l => l.classList.remove("arrastando"));
    document.querySelectorAll(".alvo-solta")
      .forEach(a => a.classList.remove("alvo-solta"));
    arrastando = null;
  });

  const alvoDe = (e) => e.target.closest?.("[data-categoria]") ||
                        e.target.closest?.(".painel-talvez");

  document.addEventListener("dragover", (e) => {
    if (!arrastando) return;
    const alvo = alvoDe(e);
    if (!alvo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!alvo.classList.contains("alvo-solta")){
      document.querySelectorAll(".alvo-solta")
        .forEach(a => a.classList.remove("alvo-solta"));
      alvo.classList.add("alvo-solta");
    }
  });
  document.addEventListener("drop", (e) => {
    if (!arrastando) return;
    const alvo = alvoDe(e);
    if (!alvo) return;
    e.preventDefault();
    const {nome, tabuleiro} = arrastando;
    const grupo = alvo.dataset.categoria !== undefined ? alvo : null;
    const destino = grupo ? grupo.dataset.tabuleiro : "talvez";
    // Move primeiro, categoriza depois: as duas coisas guardam desfazer, e
    // o Ctrl+Z devolve o passo inteiro em dois toques em vez de um. Vale o
    // preço — a alternativa seria uma terceira função que faz as duas.
    if (destino !== tabuleiro) mover(nome, tabuleiro, destino);
    if (grupo){
      const cat = grupo.dataset.categoria;
      // Grupo automático: a carta perde a categoria à mão e volta a ser
      // agrupada pelo tipo. Só faz sentido se for o tipo DELA — soltar uma
      // criatura em "Artefatos" não a transforma em artefato, então nesse
      // caso não há o que fazer e o silêncio é a resposta certa.
      const propria = ehPropria(cat) || CATEGORIAS_FORA_DA_CONTA.has(cat);
      const entrada = acharEntrada(nome, destino);
      if (propria) definirCategoria(nome, destino, cat);
      else if (entrada && categoriaAutomatica(entrada.carta) === cat){
        definirCategoria(nome, destino, "");
      }
    }
  });
}
