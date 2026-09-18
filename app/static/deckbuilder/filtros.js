/* ------------------------------------------------------- gaveta e filtros

   Uma gaveta por vez, e o fundo escuro é o mesmo pras duas. Fechar por Esc e
   por clique no fundo existe porque uma gaveta modal que só fecha no ✕ é uma
   armadilha em tela de toque, onde o ✕ fica longe do polegar. */

import {$, escapar} from "../comum/dom.js";
import {agendarBusca, buscarComandante, buscarDoComeco} from "./busca.js";
import {estado, FILTROS_VAZIOS, NOME_DO_TIPO, TIPOS} from "./estado.js";
import {simboloDaTela} from "./preco.js";
import {ico} from "./utilidades.js";

export let gavetaAberta = null;

export function abrirGaveta(id){
  fecharGaveta();
  const g = $(id);
  g.hidden = false;
  // Um quadro de espera antes da classe: `hidden` some e a transição de
  // `transform` precisa de um estado inicial pintado pra ter de onde sair —
  // sem isso a gaveta aparece pronta, sem deslizar.
  requestAnimationFrame(() => {
    g.classList.add("aberta");
    $("gaveta-fundo").classList.add("aberta");
  });
  gavetaAberta = id;
  const primeiro = g.querySelector("input,textarea,select");
  if (primeiro) setTimeout(() => primeiro.focus(), 180);
}

export function fecharGaveta(){
  $("gaveta-fundo").classList.remove("aberta");
  if (!gavetaAberta) return;
  const g = $(gavetaAberta);
  g.classList.remove("aberta");
  // `hidden` só depois da animação: pôr na hora tiraria a gaveta da tela
  // antes de ela ter deslizado pra fora.
  setTimeout(() => { if (!g.classList.contains("aberta")) g.hidden = true; }, 220);
  gavetaAberta = null;
}

/* Quais filtros estão ligados, no formato que a fita desenha: `{chave,
   rotulo}`. Também é o que conta o número na bolinha do botão. */
function filtrosLigados(){
  const f = estado.filtros;
  const ligados = [];
  if (f.tipo) ligados.push({chave:"tipo", rotulo: NOME_DO_TIPO[f.tipo] || f.tipo});
  if (f.texto) ligados.push({chave:"texto", rotulo: `“${f.texto}”`});
  if (f.cores) ligados.push({chave:"cores", rotulo: f.cores.split("").join("")});
  if (f.cmcMin !== "" || f.cmcMax !== ""){
    const de = f.cmcMin === "" ? "0" : f.cmcMin;
    const ate = f.cmcMax === "" ? "∞" : f.cmcMax;
    ligados.push({chave:"cmc", rotulo: `custo ${de}–${ate}`});
  }
  if (f.precoMax !== "") ligados.push({chave:"precoMax",
    rotulo: `até ${simboloDaTela()} ${f.precoMax}`});
  // Este não estreita a lista, alarga (ver `algumFiltro`) — mas está ligado,
  // e a fita é onde se vê o que está ligado. Sem ele aqui, a carta que ainda
  // não saiu apareceria na busca sem nada dizendo por quê, e sem o ✕ que a
  // tira de volta.
  if (f.ineditas) ligados.push({chave:"ineditas", rotulo:"inéditas"});
  if (f.ordem && f.ordem !== "nome"){
    // O chip da ordenação é a única coisa da barra em que a seta É o
    // conteúdo: "preço" sozinho não diz se a mais cara vem antes. Por isso
    // ela sai como ícone com nome, e não escondida do leitor de tela.
    const campo = {cmc:"custo", cmc_desc:"custo",
                   preco:"preço", preco_desc:"preço"}[f.ordem];
    const desc = f.ordem.endsWith("_desc");
    ligados.push(campo
      ? {chave:"ordem", rotulo: campo,
         icone: desc ? "arrow-down" : "arrow-up",
         sentido: desc ? "maior primeiro" : "menor primeiro"}
      : {chave:"ordem", rotulo: f.ordem});
  }
  return ligados;
}

export function desenharBarraFiltros(){
  const ligados = filtrosLigados();
  const conta = $("conta-filtros");
  conta.hidden = ligados.length === 0;
  conta.textContent = ligados.length;
  // A cor mostra a mesma coisa que o número, pra quem não repara em bolinha.
  $("btn-gaveta-filtros").classList.toggle("ouro", ligados.length > 0);
  $("ligados").innerHTML = ligados.map(l => `
    <span class="ligado"><b>${escapar(l.rotulo)}</b>${
      l.icone ? ico(l.icone, l.sentido) : ""}
      <button data-tira-filtro="${l.chave}" title="Tirar este filtro"
              aria-label="Tirar o filtro ${escapar(l.rotulo)}${
                l.sentido ? ", " + l.sentido : ""}">${ico("x")}</button></span>
  `).join("");
}

/* A cor no filtro é a cor DA CARTA, não a identidade dela: um Deathrite
   Shaman é preto-e-verde nos dois, mas um Ancestral Vision é azul de cor e
   azul de identidade enquanto um terreno que produz azul é INCOLOR de cor e
   azul de identidade. Quem procura "minhas cartas azuis" quer a primeira. */
const CORES_FILTRO = [["W","Branco"],["U","Azul"],["B","Preto"],
                      ["R","Vermelho"],["G","Verde"],["C","Incolor"]];

export function montarGavetaFiltros(){
  $("f-tipo").innerHTML = TIPOS.map(([valor, rotulo]) =>
    `<option value="${valor}">${rotulo}</option>`).join("");
  $("f-cores").innerHTML = CORES_FILTRO.map(([c, nome]) => `
    <button class="cor-btn" data-cor="${c}" title="${nome}"
            aria-label="${nome}" aria-pressed="false">
      <span class="pip ${c}"></span></button>`).join("");
}

/* Escreve o estado nos controles. Roda ao abrir a gaveta e ao limpar, pra a
   gaveta nunca discordar da fita que está do lado de fora dela. */
export function preencherGavetaFiltros(){
  const f = estado.filtros;
  $("f-tipo").value = f.tipo;
  $("f-texto").value = f.texto;
  $("f-cmc-min").value = f.cmcMin;
  $("f-cmc-max").value = f.cmcMax;
  $("f-preco").value = f.precoMax;
  $("f-ordem").value = f.ordem;
  // O mesmo filtro tem dois interruptores: o da gaveta e o da tela de
  // abertura, que existe porque lá a gaveta ainda não está na tela — sem
  // comandante não há painel de busca. Os dois mostram o mesmo estado, senão
  // um deles mentiria assim que o outro fosse tocado.
  $("f-ineditas").checked = f.ineditas;
  $("cmd-ineditas").checked = f.ineditas;
  [...$("f-cores").children].forEach(b => {
    const ligada = f.cores.includes(b.dataset.cor);
    b.classList.toggle("ativo", ligada);
    b.setAttribute("aria-pressed", ligada ? "true" : "false");
  });
}

/* Lê os controles de volta pro estado e rebusca. Passa pela busca com atraso
   (`agendarBusca`) porque o campo de efeito dispara a cada tecla. */
export function lerGavetaFiltros(){
  const numero = (id) => {
    const v = $(id).value.trim();
    if (v === "") return "";
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? String(n) : "";
  };
  estado.filtros = {
    tipo: $("f-tipo").value,
    texto: $("f-texto").value.trim(),
    cores: [...$("f-cores").children]
      .filter(b => b.classList.contains("ativo"))
      .map(b => b.dataset.cor).join(""),
    cmcMin: numero("f-cmc-min"),
    cmcMax: numero("f-cmc-max"),
    precoMax: numero("f-preco"),
    ordem: $("f-ordem").value,
    ineditas: $("f-ineditas").checked,
  };
  desenharBarraFiltros();
  agendarBusca();
}

/* O interruptor da tela de abertura. O da gaveta não passa por aqui — lá o
   `lerGavetaFiltros` já lê todos os controles de uma vez —, e o que este tem
   de diferente é a busca que ele refaz: a de comandante, que é a única
   acontecendo enquanto essa tela está no ar. */
export function mudarIneditas(ligado){
  estado.filtros.ineditas = ligado;
  preencherGavetaFiltros();
  desenharBarraFiltros();
  // Só refaz a busca se houver o que buscar: com a caixa vazia a lista está
  // vazia de propósito, e enchê-la de vinte e cinco lendários porque alguém
  // mexeu num interruptor seria responder uma pergunta que ninguém fez.
  if ($("busca-cmd").value.trim()) buscarComandante();
}

export function tirarFiltro(chave){
  if (chave === "cmc"){
    // A única etiqueta que fala por dois controles: "custo 2–4" é o par.
    estado.filtros.cmcMin = "";
    estado.filtros.cmcMax = "";
  } else {
    // Tirar um filtro é devolvê-lo ao estado neutro da gaveta, e quem sabe
    // qual é ele é o `FILTROS_VAZIOS` — a ordenação volta pra "nome" e o
    // interruptor das inéditas pra desligado, sem uma lista de exceções aqui
    // que envelhece a cada filtro novo.
    estado.filtros[chave] = FILTROS_VAZIOS[chave];
  }
  preencherGavetaFiltros();
  desenharBarraFiltros();
  buscarDoComeco();
}

export function limparFiltros(){
  estado.filtros = {...FILTROS_VAZIOS};
  preencherGavetaFiltros();
  desenharBarraFiltros();
  buscarDoComeco();
}
