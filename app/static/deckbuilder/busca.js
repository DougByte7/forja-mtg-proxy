/* ------------------------------------------------------------------- buscar */

import {$, escapar} from "../comum/dom.js";
import {ganchosDaPrevia} from "./carta.js";
import {adicionar, escolherComandante, ondeEsta} from "./edicao.js";
import {algumFiltro, CATEGORIA_SIDEBOARD, estado} from "./estado.js";
import {precoMaxEmUsd} from "./preco.js";
import {api} from "./salvar.js";
import {ico, identidadeDoDeck, manaHTML, preco, toast,
        todasAsCategorias} from "./utilidades.js";

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

export function ligarTecladoDaBusca(input, caixa){
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

export function agendarBusca(){
  clearTimeout(buscaTimer);
  // Quem digitou uma letra ou mexeu num filtro está fazendo outra pergunta:
  // continuar na página 4 da pergunta anterior seria cair no meio de uma
  // lista que ninguém viu começar.
  estado.buscaPagina = 0;
  buscaTimer = setTimeout(buscar, 220);
}

/* A busca de novo, do começo. É o que os filtros chamam quando mudam sem
   passar pelo atraso do teclado — tirar um chip, limpar tudo. */
export function buscarDoComeco(){
  estado.buscaPagina = 0;
  return buscar();
}

export function agendarBuscaComandante(){
  clearTimeout(buscaTimer);
  buscaTimer = setTimeout(buscarComandante, 220);
}

export async function buscar(){
  const termo = $("busca").value.trim();
  const identidade = estado.comandantes.length ? identidadeDoDeck() : null;
  // Com filtro ligado a lista vira página; sem filtro continua a vitrine de
  // cinco com a frase no fim. Ver `algumFiltro`, em `estado.js`.
  const paginada = algumFiltro();
  const params = new URLSearchParams({
    q: termo,
    limite: paginada ? String(estado.buscaPorPagina) : "24",
  });
  if (paginada){
    params.set("pular", String(estado.buscaPagina * estado.buscaPorPagina));
    params.set("com_total", "true");
  }
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
    estado.buscaTotal = paginada ? (r.total ?? r.cartas.length) : 0;
    // A página em que se estava pode ter deixado de existir por baixo — um
    // comandante escolhido depois encurta a lista sem ninguém tocar no
    // filtro. Voltar pro começo é mais honesto do que mostrar nada.
    if (paginada && !r.cartas.length && estado.buscaPagina > 0){
      estado.buscaPagina = 0;
      return buscar();
    }
    mostrarResultados($("res"), r.cartas, adicionarPeloDestino,
                      {rodape: paginada ? paginadorDaBusca() : ""});
  } catch (e){
    $("res").innerHTML = `<div class="vazio">Busca falhou: ${escapar(e.message)}</div>`;
  }
}

export async function buscarComandante(){
  const termo = $("busca-cmd").value.trim();
  const params = new URLSearchParams({q: termo, comandante: "true", limite: "25"});
  try {
    const r = await api("/cartas/busca?" + params);
    mostrarResultados($("res-cmd"), r.cartas, escolherComandante,
                      {comandantes: true});
  } catch (e){
    $("res-cmd").innerHTML = `<div class="vazio">Busca falhou: ${escapar(e.message)}</div>`;
  }
}

export let ultimosResultados = [];

/* Cinco resultados, e o resto vira uma frase.

   Quem não achou nos cinco primeiros não vai achar no vigésimo: vai escrever
   mais uma letra, ou usar os filtros. Uma caixa com rolagem própria dentro de
   uma coluna que já rola faz escolher entre "Llanowar Elves" e "Llanowar
   Tribe" custar duas superfícies aninhadas. A frase no fim diz quantas
   sobraram, pra que a lista curta não pareça acervo acabado. */
const TETO_RESULTADOS = 5;

function mostrarResultados(caixa, cartas, aoClicar,
                           {comandantes = false, rodape = ""} = {}){
  ultimosResultados = cartas;
  caixa.aoClicar = aoClicar;
  // A lista trocou: o índice destacado apontava pra outra carta.
  destaque = -1;
  if (!cartas.length){
    caixa.innerHTML = `<div class="vazio">Nada com esse nome.${
      comandantes ? " Lembre: comandante é criatura lendária." : ""}</div>`;
    return;
  }
  // Paginada, a lista já veio do tamanho da página: o teto seria um segundo
  // corte por cima do que a pessoa pediu, e o rodapé é o paginador em vez da
  // frase que manda usar os filtros — que ela já está usando.
  const teto = rodape ? cartas.length : TETO_RESULTADOS;
  const sobrando = cartas.length - teto;
  const resto = rodape || (sobrando > 0
    ? `<div class="demais">E mais ${sobrando}${
        cartas.length >= 24 ? "+" : ""} carta(s) casam. Escreva mais uma letra
       ou use os filtros pra chegar na certa.</div>`
    : "");
  // Três estados, não dois: uma carta que já está no maybeboard não é uma
  // carta nova nem uma carta do deck, e mostrá-la como qualquer um dos dois
  // faria a pessoa adicionar de novo o que ela mesma pôs em dúvida.
  caixa.innerHTML = cartas.slice(0, teto).map((c, i) => {
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

/* ------------------------------------------------------ o paginador

   Ele só existe com filtro ligado, e é por isso que ele existe: sem filtro a
   lista é uma vitrine de cinco e passar página nela seria folhear a base
   inteira de carta em carta. Com filtro, a lista é um recorte que a pessoa
   pediu — "criatura verde de até 3 por menos de 5 reais" — e aí ver as 37 que
   casam é o ponto, não um consolo.

   Quantos por página é escolha de quem olha: cinco cabem sem rolagem na
   coluna, quinze pedem rolagem mas mostram o recorte quase inteiro de uma
   vez. */
const POR_PAGINA = [5, 10, 15];

function paginadorDaBusca(){
  const por = estado.buscaPorPagina;
  const paginas = Math.max(1, Math.ceil(estado.buscaTotal / por));
  const pagina = Math.min(estado.buscaPagina, paginas - 1);
  return `<div class="paginador res-paginador">
    <label class="por-pagina" title="Quantos resultados por página">
      <select id="res-por-pagina" aria-label="Resultados por página">${
        POR_PAGINA.map(n => `<option value="${n}"${
          n === por ? " selected" : ""}>${n}</option>`).join("")}</select>
      <span>de ${estado.buscaTotal}</span>
    </label>
    <span class="pag-passos">
      <button class="mini" data-res-pag="-1" title="Página anterior"
              aria-label="Página anterior"${pagina === 0 ? " disabled" : ""}>${
        ico("caret-left")}</button>
      <span>${pagina + 1} / ${paginas}</span>
      <button class="mini" data-res-pag="1" title="Próxima página"
              aria-label="Próxima página"${
                pagina >= paginas - 1 ? " disabled" : ""}>${
        ico("caret-right")}</button>
    </span>
  </div>`;
}

export function virarPagina(passo){
  const paginas = Math.max(1, Math.ceil(estado.buscaTotal / estado.buscaPorPagina));
  const nova = Math.min(Math.max(estado.buscaPagina + passo, 0), paginas - 1);
  if (nova === estado.buscaPagina) return;
  estado.buscaPagina = nova;
  buscar();
}

/* Mudar o tamanho da página volta pro começo: a carta que estava na tela
   está em outra página agora, e fingir que a página 4 de cinco em cinco é a
   página 4 de quinze em quinze levaria pra um lugar que ninguém pediu. */
export function escolherPorPagina(quantos){
  estado.buscaPorPagina = quantos;
  estado.buscaPagina = 0;
  buscar();
}

/* ------------------------------------------------------- destino da carta

   Quem monta o sideboard põe dez cartas seguidas nele: a decisão é a mesma
   pras dez, e se diz uma vez aqui em vez de dez visitas ao menu de cada linha
   depois de adicionada.

   "Sideboard" é categoria e não tabuleiro (é o que o servidor entende em
   `decks.CATEGORIAS_FORA_DA_CONTA`), então escolhê-lo aqui ocupa a vaga da
   categoria — e o seletor ao lado se desliga em vez de oferecer uma escolha
   que seria ignorada. */
export function adicionarPeloDestino(carta){
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

export function escolherDestino(destino){
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
export function atualizarCategoriasDoDestino(){
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
