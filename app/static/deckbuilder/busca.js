"use strict";

/* ------------------------------------------------------------------- buscar */

let buscaTimer = null;

/* ------------------------------------------- teclado sobre os resultados

   A busca é usada de mão no teclado: digita, olha os cinco resultados,
   escolhe. A seta pra baixo entra na lista, as setas andam por ela, Enter
   manda a destacada pro destino escolhido e devolve o foco à caixa — que é
   onde a próxima carta vai ser digitada. Enter sem nada destacado manda a
   primeira, que é o caminho de quem já sabe o nome inteiro. */
let destaque = -1;

function itensDe(caixa){
  return [...caixa.querySelectorAll(".achado")];
}

function pintarDestaque(caixa){
  const itens = itensDe(caixa);
  itens.forEach((el, i) => el.classList.toggle("destacado", i === destaque));
  if (destaque >= 0) itens[destaque]?.scrollIntoView({block: "nearest"});
}

function limparDestaque(){
  destaque = -1;
  document.querySelectorAll(".achado.destacado")
    .forEach(e => e.classList.remove("destacado"));
}

function moverDestaque(caixa, passo){
  const itens = itensDe(caixa);
  if (!itens.length) return;
  // Da caixa de texto, a primeira seta pra baixo pega o primeiro item e a
  // primeira seta pra cima pega o último — as duas entram na lista pela
  // ponta mais próxima.
  destaque = destaque < 0
    ? (passo > 0 ? 0 : itens.length - 1)
    : (destaque + passo + itens.length) % itens.length;
  pintarDestaque(caixa);
}

function ligarTecladoDaBusca(input, caixa){
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp"){
      if (!itensDe(caixa).length) return;
      e.preventDefault();
      return moverDestaque(caixa, e.key === "ArrowDown" ? 1 : -1);
    }
    if (e.key === "Escape" && destaque >= 0){
      e.preventDefault();
      return limparDestaque();
    }
    if (e.key === "Enter"){
      if (!ultimosResultados.length) return;
      e.preventDefault();
      const carta = ultimosResultados[destaque >= 0 ? destaque : 0];
      limparDestaque();
      if (carta && caixa.aoClicar) caixa.aoClicar(carta);
      // A caixa do comandante sai da tela assim que um é escolhido: só
      // devolve o foco quem continua visível.
      if (input.offsetParent){ input.focus(); input.select(); }
    }
  });
}

function agendarBusca(){
  clearTimeout(buscaTimer);
  buscaTimer = setTimeout(buscar, 220);
}

async function buscar(){
  const termo = $("busca").value.trim();
  const identidade = estado.comandantes.length ? identidadeDoDeck() : null;
  const params = new URLSearchParams({q: termo, limite: "24"});
  if (identidade !== null) params.set("identidade", identidade);
  const f = estado.filtros;
  if (f.tipo) params.set("tipo", f.tipo);
  if (f.texto) params.set("texto", f.texto);
  if (f.cores) params.set("cores", f.cores);
  if (f.cmcMin !== "") params.set("cmc_min", f.cmcMin);
  if (f.cmcMax !== "") params.set("cmc_max", f.cmcMax);
  if (f.precoMax !== "") params.set("preco_max", precoMaxEmUsd(f.precoMax));
  if (f.ordem && f.ordem !== "nome") params.set("ordem", f.ordem);
  try {
    const r = await api("/cartas/busca?" + params);
    mostrarResultados($("res"), r.cartas, adicionarPeloDestino);
  } catch (e){
    $("res").innerHTML = `<div class="vazio">Busca falhou: ${escapar(e.message)}</div>`;
  }
}

async function buscarComandante(){
  const termo = $("busca-cmd").value.trim();
  const params = new URLSearchParams({q: termo, comandante: "true", limite: "25"});
  try {
    const r = await api("/cartas/busca?" + params);
    mostrarResultados($("res-cmd"), r.cartas, escolherComandante, true);
  } catch (e){
    $("res-cmd").innerHTML = `<div class="vazio">Busca falhou: ${escapar(e.message)}</div>`;
  }
}

let ultimosResultados = [];

/* Cinco resultados, e o resto vira uma frase.

   Quem não achou nos cinco primeiros não vai achar no vigésimo: vai escrever
   mais uma letra, ou usar os filtros. Uma caixa com rolagem própria dentro de
   uma coluna que já rola faz escolher entre "Llanowar Elves" e "Llanowar
   Tribe" custar duas superfícies aninhadas. A frase no fim diz quantas
   sobraram, pra que a lista curta não pareça acervo acabado. */
const TETO_RESULTADOS = 5;

function mostrarResultados(caixa, cartas, aoClicar, comandantes){
  ultimosResultados = cartas;
  caixa.aoClicar = aoClicar;
  // A lista trocou: o índice destacado apontava pra outra carta.
  destaque = -1;
  if (!cartas.length){
    caixa.innerHTML = `<div class="vazio">Nada com esse nome.${
      comandantes ? " Lembre: comandante é criatura lendária." : ""}</div>`;
    return;
  }
  const sobrando = cartas.length - TETO_RESULTADOS;
  const resto = sobrando > 0
    ? `<div class="demais">E mais ${sobrando}${
        cartas.length >= 24 ? "+" : ""} carta(s) casam. Escreva mais uma letra
       ou use os filtros pra chegar na certa.</div>`
    : "";
  // Três estados, não dois: uma carta que já está no maybeboard não é uma
  // carta nova nem uma carta do deck, e mostrá-la como qualquer um dos dois
  // faria a pessoa adicionar de novo o que ela mesma pôs em dúvida.
  caixa.innerHTML = cartas.slice(0, TETO_RESULTADOS).map((c, i) => {
    const onde = ondeEsta(c.nome);
    return `
    <button class="achado ${onde === "deck" ? "no-deck" : ""} ${
              onde === "talvez" ? "no-talvez" : ""}" data-i="${i}"
            ${ganchosDaPrevia(c)}>
      <span class="nome">
        <b>${escapar(c.nome)}</b>
        <small>${escapar(c.tipo)}</small>
      </span>
      ${manaHTML(c.mana_cost)}
      <span class="preco">${preco(c)}</span>
    </button>`;
  }).join("") + resto;
}

/* ------------------------------------------------------- destino da carta

   Quem monta o sideboard põe dez cartas seguidas nele: a decisão é a mesma
   pras dez, e se diz uma vez aqui em vez de dez visitas ao menu de cada linha
   depois de adicionada.

   "Sideboard" é categoria e não tabuleiro (é o que o servidor entende em
   `decks.CATEGORIAS_FORA_DA_CONTA`), então escolhê-lo aqui ocupa a vaga da
   categoria — e o seletor ao lado se desliga em vez de oferecer uma escolha
   que seria ignorada. */
function adicionarPeloDestino(carta){
  const d = estado.destino;
  if (d === "side"){
    adicionar(carta, "deck", CATEGORIA_SIDEBOARD);
    toast(`${carta.nome} entrou no sideboard.`);
  } else if (d === "talvez"){
    adicionar(carta, "talvez", estado.destinoCategoria || undefined);
    toast(`${carta.nome} foi pro maybeboard.`);
  } else {
    adicionar(carta, "deck", estado.destinoCategoria || undefined);
  }
}

function escolherDestino(destino){
  estado.destino = destino;
  for (const b of $("seg-destino").children){
    b.classList.toggle("ativa", b.dataset.destino === destino);
  }
  $("sel-categoria").disabled = destino === "side";
  atualizarCategoriasDoDestino();
}

/* O seletor de categoria acompanha as categorias que existem: uma criada no
   menu de uma carta tem que aparecer aqui na hora, senão a pessoa a criaria duas
   vezes. Sideboard não entra na lista — ele é o segmento ao lado. */
function atualizarCategoriasDoDestino(){
  const sel = $("sel-categoria");
  if (!sel) return;
  const atual = estado.destinoCategoria;
  const opcoes = todasAsCategorias().filter(c => c !== CATEGORIA_SIDEBOARD);
  sel.innerHTML =
    `<option value="">Pelo tipo da carta</option>` +
    opcoes.map(c => `<option value="${escapar(c)}"${
      c === atual ? " selected" : ""}>${escapar(c)}</option>`).join("");
  // A categoria escolhida pode ter sido apagada por baixo: sem isto o seletor
  // voltaria pro topo calado e as próximas cartas iriam pro lugar errado.
  if (atual && !opcoes.includes(atual)){
    estado.destinoCategoria = "";
    sel.value = "";
  } else {
    sel.value = atual || "";
  }
}
