/* =========================================================================
   GOLDFISH

   Embaralhar o deck e jogar sozinho, pra ver se a mão anda. É o que "goldfish"
   quer dizer na mesa: jogar contra um peixinho dourado, que não faz nada.

   NÃO É MOTOR DE REGRAS, E ISSO É O RECURSO. Nada aqui impede nada: dá pra
   baixar dois terrenos no mesmo turno, jogar uma carta de 8 manas no turno 1 e
   mandar qualquer coisa pra qualquer zona. Quem julga é quem está jogando.
   A alternativa — validar custo, tipo e timing — é escrever um motor de Magic,
   que é um projeto inteiro, e que erraria em casos que a pessoa conhece melhor
   do que ele.

   Quatro consequências desenhadas de propósito:

   * A MANA NÃO É SOMADA. A tela mostra quantos terrenos estão em pé e quantos
     deitados, que é um fato do tabuleiro. No instante em que aparecesse "3 de
     mana disponível", a pessoa passaria a esperar que o número a impedisse de
     fazer coisa errada — e aí é motor de regras pela porta dos fundos.
   * O "terreno baixado neste turno" CONTA, não impede. Vira informação, não
     trava.
   * A VIDA É UM NÚMERO QUE SE AJUSTA, não uma conta. Começa em 40 e anda pelos
     botões: ninguém aqui sabe quanto uma criatura bate.
   * O COMANDANTE VAI PRA ZONA DE COMANDO, não pro baralho. Sem isso o goldfish
     estaria testando um deck de 99 cartas que ninguém joga. O imposto aparece
     como número; pagar ou não é decisão de quem joga.

   O que ele SABE são as regras do formato que mudam a mão: o primeiro mulligan
   é grátis e quem começa jogando compra no turno 1.

   NADA DISSO É SALVO. `corpoDoDeck` não sabe que `estado.mesa` existe: uma mão
   de goldfish gravada no deck é uma mão que volta três semanas depois, em outra
   máquina, no meio de uma edição.
   ========================================================================= */

import {$, escapar} from "../comum/dom.js";
import {abrirCarta, ganchosDaPrevia} from "./carta.js";
import {CORES, estado, NOME_COR} from "./estado.js";
import {cartasContadas, toast} from "./utilidades.js";

const MAO_INICIAL = 7;
const VIDA_INICIAL = 40;

/* Cada carta na mesa é uma CÓPIA com identidade própria (`uid`), e não a
   entrada do deck. Três Florestas são três objetos: uma pode estar deitada e as
   outras não, e uma pode estar no cemitério enquanto as outras jogam. Copiar a
   referência da entrada faria deitar uma deitar as trinta — é o bug clássico
   deste tipo de tela. */
let gfProximoUid = 1;

function gfCopia(carta){
  return {uid: gfProximoUid++, carta, virada: false, deitada: false, cont: 0};
}

/* O baralho: as cartas que valem pras 100, MENOS os comandantes.

   `cartasContadas()` é a mesma função do contador, da curva e da assinatura de
   cotação — sideboard e maybeboard ficam de fora aqui pelo mesmo motivo que
   ficam lá. Usar outra regra faria a mesa discordar do resto da tela sobre o
   que é o deck. */
function baralhoDoDeck(){
  const comandantes = new Set(estado.comandantes.map(c => (c.nome || "").toLowerCase()));
  const fora = [];
  for (const entrada of cartasContadas()){
    const c = entrada.carta;
    if (!c) continue;                       // carta que a base não conhece
    if (comandantes.has((c.nome || "").toLowerCase())) continue;
    for (let i = 0; i < entrada.quantidade; i++) fora.push(gfCopia(c));
  }
  return fora;
}

/* Fisher-Yates, no lugar. Escrito à mão e não com `sort(() => Math.random()-.5)`
   de propósito: aquele não é embaralhamento — é uma comparação inconsistente,
   que a maioria das engines resolve com um resultado enviesado, e ninguém
   percebe olhando. */
function embaralhar(cartas){
  for (let i = cartas.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const t = cartas[i]; cartas[i] = cartas[j]; cartas[j] = t;
  }
  return cartas;
}

function montarMesa(){
  gfProximoUid = 1;
  estado.mesa = {
    baralho: embaralhar(baralhoDoDeck()),
    mao: [], campo: [], cemiterio: [], exilio: [],
    comando: estado.comandantes.filter(Boolean).map(gfCopia),
    turno: 1, terrenosBaixados: 0, mulligans: 0, aFundo: 0,
    fase: "mulligan", impostoPago: 0, vida: VIDA_INICIAL,
  };
  estado.mesaDesfazer = [];
  gfUltimoGesto = null;
  comprar(MAO_INICIAL);
}

function comprar(n){
  const m = estado.mesa;
  for (let i = 0; i < n && m.baralho.length; i++) m.mao.push(m.baralho.shift());
}

/* Mulligan London, com o PRIMEIRO GRÁTIS — que é a regra do Commander.

   Sempre se compram 7 cartas novas; o que muda é quantas voltam pro fundo ao
   manter: `mulligans - 1`. O primeiro mulligan sai de graça e a mão fica com 7;
   o segundo devolve 1, o terceiro 2. Cobrar já a primeira seria testar um deck
   de 60, não um de Commander — que é o formato deste deckbuilder inteiro. */
function devolveAoManter(){
  return Math.max(0, estado.mesa.mulligans - 1);
}

function mulliganLondon(){
  const m = estado.mesa;
  m.mulligans++;
  m.baralho = embaralhar(m.baralho.concat(m.mao));
  m.mao = [];
  m.aFundo = 0;
  comprar(MAO_INICIAL);
}

function manterMao(){
  const m = estado.mesa;
  // Nunca mais do que a mão tem: pedir pra devolver 3 de uma mão de 2 deixaria
  // a fase de fundo sem como terminar, e a mesa travada numa escolha
  // impossível. Só acontece em deck pequeno, que é justamente onde se testa.
  m.aFundo = Math.min(devolveAoManter(), m.mao.length);
  // Com zero a devolver a tela pula direto pro jogo: pedir "escolha 0 cartas"
  // é uma etapa que só existe pra ser fechada.
  if (m.aFundo) m.fase = "fundo";
  else confirmarMao();
}

function mandarPraFundo(uid){
  const m = estado.mesa;
  const i = m.mao.findIndex(c => c.uid === uid);
  if (i < 0 || !m.aFundo) return;
  m.baralho.push(m.mao.splice(i, 1)[0]);     // fundo, na ordem escolhida
  m.aFundo--;
  if (!m.aFundo) confirmarMao();
}

/* A mão fechada — e com ela a COMPRA DO TURNO 1. No Commander quem começa
   jogando compra: é o duelo de dois que tira essa compra do primeiro jogador,
   e a mesa deste deckbuilder é multiplayer.

   Ela vem depois das cartas que voltam pro fundo, e é uma só: o que se
   devolve é a mão de sete que se viu, e a carta a mais é a do turno, não
   parte da escolha. Daí `passarTurno` comprar do turno 2 em diante. */
function confirmarMao(){
  estado.mesa.fase = "jogo";
  comprar(1);
}

function passarTurno(){
  const m = estado.mesa;
  m.turno++;
  m.terrenosBaixados = 0;
  // Endireita tudo, como o desendireitar de verdade.
  for (const c of m.campo) c.deitada = false;
  // A compra do turno 1 saiu na confirmação da mão; daqui pra frente é uma
  // por turno.
  comprar(1);
}

function ajustarVida(n){
  estado.mesa.vida += n;
}

const GF_ZONAS = ["baralho", "mao", "campo", "cemiterio", "exilio", "comando"];

/* A ÚNICA mutação de zona. Tudo passa por aqui pra o invariante "cada uid
   existe em exatamente uma zona" ter um lugar só onde pode quebrar.

   `gfMover` e não `mover` porque JÁ EXISTE um `mover(nome, de, para)` nesta
   página — o que troca carta entre deck e maybeboard. Duas declarações de
   função com o mesmo nome não dão erro: a segunda simplesmente apaga a
   primeira no hoisting, e a mesa parava de mover carta sem nada na tela
   dizendo por quê. Foi o `tests/test_goldfish.py` que pegou. */
function gfMover(uid, para, aoTopo){
  const m = estado.mesa;
  if (!m || GF_ZONAS.indexOf(para) < 0) return;
  for (const zona of GF_ZONAS){
    const i = m[zona].findIndex(c => c.uid === uid);
    if (i < 0) continue;
    const carta = m[zona].splice(i, 1)[0];
    if (para === "campo" && zona !== "campo"){
      carta.deitada = false;   // entra em pé
      if (ehTerreno(carta.carta)) m.terrenosBaixados++;
    }
    if (para !== "campo"){ carta.deitada = false; carta.cont = 0; }
    if (para === "baralho" && !aoTopo) m.baralho.push(carta);
    else m[para].unshift(carta);
    return;
  }
}

function ehTerreno(carta){
  return ehTipo(carta, "land");
}

function ehTipo(carta, tipo){
  return ((carta && carta.tipo) || "").toLowerCase().includes(tipo);
}

function cartaPorUid(uid){
  const m = estado.mesa;
  for (const zona of GF_ZONAS){
    const c = m[zona].find(x => x.uid === uid);
    if (c) return c;
  }
  return null;
}

/* Desfazer por FOTOGRAFIA do estado, e não por operação inversa: num sistema
   sem regras, o inverso de uma jogada não é definido — mandar uma carta do
   cemitério pro campo não "desfaz" nada, é outra jogada. Vinte fotos de uma
   mesa de 100 cartas é barato. */
/* Gesto repetido é UM passo de desfazer: baixar a vida de 40 pra 33 são sete
   cliques, e sem isto eles comeriam sete das vinte fotos — o Ctrl+Z seguinte
   devolveria 34, 35, 36… em vez da jogada que veio antes. Qualquer outra ação
   fecha a sequência, porque ela guarda sem nome. */
let gfUltimoGesto = null;

function gfGuardar(gesto){
  if (!estado.mesa) return;
  if (gesto && gesto === gfUltimoGesto) return;
  gfUltimoGesto = gesto || null;
  estado.mesaDesfazer.push(JSON.stringify(estado.mesa));
  if (estado.mesaDesfazer.length > 20) estado.mesaDesfazer.shift();
}

export function desfazerMesa(){
  const foto = estado.mesaDesfazer.pop();
  if (!foto) return;
  estado.mesa = JSON.parse(foto);
  gfUltimoGesto = null;
  desenharMesa();
}

/* ------------------------------------------------------------ desenho */

function gfCartaHTML(c, zona){
  const carta = c.carta || {};
  const arte = c.virada ? "" : (carta.imagem || "");
  const classes = ["gf-carta"];
  if (c.deitada) classes.push("deitada");
  if (c.virada) classes.push("virada");
  return `<button class="${classes.join(" ")}" data-gf-uid="${c.uid}"
    data-gf-zona="${zona}" title="${escapar(carta.nome || "")}"
    ${arte ? `style="background-image:url('${escapar(arte)}')"` : ""}
    ${c.virada ? "" : ganchosDaPrevia(carta)}>
    ${c.cont ? `<span class="gf-cont">${c.cont}</span>` : ""}
    ${zona === "mao" ? `<span class="gf-nome">${escapar(carta.nome || "")}</span>` : ""}
  </button>`;
}

function gfFilaHTML(lista, zona, vazio){
  if (!lista.length) return `<div class="gf-vazio">${escapar(vazio)}</div>`;
  return `<div class="gf-fila ${zona === "mao" ? "gf-mao" : ""}">${
    lista.map(c => gfCartaHTML(c, zona)).join("")}</div>`;
}

/* O resumo da mão, do lado das cartas: quantos terrenos, quanto custa em
   média o que não é terreno, e que cores ela pede. É a conta que se faz de
   cabeça a cada mulligan — sete cartas, três perguntas, toda vez — e é com
   ela que se decide manter.

   Duas escolhas acompanham o resto da tela. O custo médio IGNORA terreno,
   como a curva da análise: terreno custa zero e puxaria a média pra um número
   que não diz o que dá pra lançar. E as cores são o que a mão PEDE, lidas dos
   símbolos do custo, como a distribuição da análise — não o que ela produz. */
function resumoDaMao(mao){
  const feiticos = mao.filter(c => !ehTerreno(c.carta));
  const soma = feiticos.reduce((n, c) => n + (((c.carta || {}).cmc) || 0), 0);
  const cores = {};
  for (const c of mao){
    const custo = ((c.carta || {}).mana_cost) || "";
    for (const simbolo of custo.match(/\{[^}]+\}/g) || []){
      // Híbrido conta pras duas cores: "{G/W}" é uma carta que cabe nas duas.
      for (const parte of simbolo.slice(1, -1).split("/")){
        if (CORES.includes(parte)) cores[parte] = (cores[parte] || 0) + 1;
      }
    }
  }
  return {terrenos: mao.length - feiticos.length, feiticos: feiticos.length,
          custoMedio: feiticos.length ? soma / feiticos.length : 0, cores};
}

function resumoHTML(mao){
  if (!mao.length) return "";
  const r = resumoDaMao(mao);
  // `title` em cada cor porque bolinha colorida sozinha não é informação
  // acessível — a mesma regra dos pips do resto da página.
  const pips = CORES.filter(c => r.cores[c]).map(c =>
    `<span class="gf-cor" title="${NOME_COR[c]}"><span class="pip ${c}"></span>${
      r.cores[c]}</span>`).join("");
  return `<div class="gf-resumo">
    <span><b>${r.terrenos}</b> terreno(s) em ${mao.length}</span>
    ${r.feiticos ? `<span title="Média de custo do que não é terreno"><b>${
      r.custoMedio.toFixed(1).replace(".", ",")}</b> de custo médio</span>` : ""}
    ${pips ? `<span class="gf-cores" title="Símbolos de cor que a mão pede"
      >${pips}</span>` : ""}
  </div>`;
}

/* O campo em três filas: terrenos, criaturas e o resto. Quem olha um tabuleiro
   procura uma coisa de cada vez ("tenho mana? tenho bicho?"), e numa fila só
   de trinta cartas cada pergunta dessas vira busca visual.

   Terreno-criatura entra em Terrenos, e pela mesma razão de `CATEGORIAS`: a
   primeira regra que casa ganha, porque pra quem joga ele é o terreno que
   entrou no turno. */
const GRUPOS_DO_CAMPO = [
  ["Terrenos",  (c) => ehTerreno(c.carta)],
  ["Criaturas", (c) => ehTipo(c.carta, "creature")],
  ["Outros",    () => true],
];

function grupoDoCampo(c){
  return GRUPOS_DO_CAMPO.find(([, casa]) => casa(c))[0];
}

function campoHTML(campo){
  if (!campo.length) return `<div class="gf-vazio">nada em jogo</div>`;
  return GRUPOS_DO_CAMPO.map(([nome]) => {
    const lista = campo.filter(c => grupoDoCampo(c) === nome);
    if (!lista.length) return "";
    return `<div class="gf-subsecao">${nome} <b>${lista.length}</b></div>` +
      gfFilaHTML(lista, "campo", "");
  }).join("");
}

function vidaHTML(vida){
  return `<span class="gf-vida">Vida
    <button data-gf-vida="-5" aria-label="Menos 5 de vida">−5</button>
    <button data-gf-vida="-1" aria-label="Menos 1 de vida">−1</button>
    <b>${vida}</b>
    <button data-gf-vida="1" aria-label="Mais 1 de vida">+1</button>
    <button data-gf-vida="5" aria-label="Mais 5 de vida">+5</button>
  </span>`;
}

export function desenharMesa(){
  const alvo = $("gf-mesa");
  const m = estado.mesa;
  if (!m){
    $("gf-turno").textContent = "";
    $("gf-desfazer").disabled = true;
    alvo.innerHTML = `<div class="gf-vazio">Clique em <b>Embaralhar</b> pra
      começar. O comandante vai pra zona de comando; o sideboard e o maybeboard
      ficam de fora, como em toda análise desta tela.</div>`;
    return;
  }

  $("gf-desfazer").disabled = !estado.mesaDesfazer.length;

  // Fatos do tabuleiro, não conta de mana: quantos terrenos estão em pé e
  // quantos deitados. Ver o cabeçalho desta seção.
  const terrenos = m.campo.filter(c => ehTerreno(c.carta));
  const emPe = terrenos.filter(c => !c.deitada).length;

  if (m.fase === "jogo"){
    $("gf-turno").textContent = `Turno ${m.turno}`;
  } else {
    $("gf-turno").textContent = m.mulligans
      ? `Mulligan ${m.mulligans}` : "Mão de abertura";
  }

  const zonas = `<div class="gf-zonas">
    ${vidaHTML(m.vida)}
    <span>Baralho <b>${m.baralho.length}</b></span>
    <span>Mão <b>${m.mao.length}</b></span>
    <span>Terrenos <b>${emPe}</b> em pé${
      terrenos.length - emPe ? ` · <b>${terrenos.length - emPe}</b> deitados` : ""}</span>
    ${m.terrenosBaixados ? `<span title="Conta, não impede — aqui não tem juiz."
      >Baixados neste turno <b>${m.terrenosBaixados}</b></span>` : ""}
    <span><button data-gf-ver="cemiterio">Cemitério <b>${m.cemiterio.length}</b></button></span>
    ${m.exilio.length ? `<span><button data-gf-ver="exilio">Exílio
      <b>${m.exilio.length}</b></button></span>` : ""}
  </div>`;

  if (m.fase !== "jogo"){
    const devolve = devolveAoManter();
    const explica = m.fase === "fundo"
      ? `<p class="nota">Escolha <b>${m.aFundo}</b> carta(s) pra mandar pro
         fundo do baralho — clique nelas, na ordem que quiser. Depois delas
         vem a compra do turno 1.</p>`
      : `<p class="nota">${m.mulligans === 0
          ? "Mão de abertura."
          : `${m.mulligans}º mulligan.`} Se manter agora, ${devolve
          ? `devolve <b>${devolve}</b> carta(s) pro fundo e compra a do turno 1`
          : `compra a do turno 1 e fica com <b>${m.mao.length + 1}</b>`}.</p>`;
    alvo.innerHTML = zonas + explica +
      `<div class="gf-secao">Mão</div>` +
      resumoHTML(m.mao) +
      gfFilaHTML(m.mao, "mao", "sem cartas") +
      (m.fase === "fundo" ? "" : `<div class="gf-acoes">
        <button class="btn ouro" id="gf-manter">Manter esta mão</button>
        <button class="btn" id="gf-mulligan">Mulligan</button>
      </div>`);
    return;
  }

  alvo.innerHTML = zonas +
    `<div class="gf-secao">Campo</div>` +
    campoHTML(m.campo) +
    (m.comando.length ? `<div class="gf-secao">Comando${m.impostoPago
      ? ` — próxima vez custa +${m.impostoPago * 2}` : ""}</div>`
      + gfFilaHTML(m.comando, "comando", "") : "") +
    `<div class="gf-secao">Mão (${m.mao.length})</div>` +
    resumoHTML(m.mao) +
    gfFilaHTML(m.mao, "mao", "mão vazia") +
    `<div class="gf-acoes">
      <button class="btn ouro" id="gf-turno-btn">Passar turno (compra 1)</button>
      <button class="btn" id="gf-comprar">Comprar 1</button>
    </div>`;
}

/* ------------------------------------------------------------ interação */

function gfFecharMenu(){
  const m = document.querySelector(".gf-menu");
  if (m) m.remove();
}

/* O menu de uma carta: pra onde ela pode ir. Tudo é permitido de qualquer
   zona, de propósito — inclusive o que numa partida de verdade seria absurdo. */
function gfAbrirMenu(uid, zona, x, y){
  gfFecharMenu();
  const c = cartaPorUid(uid);
  if (!c) return;
  const itens = [];
  if (zona === "campo"){
    itens.push([c.deitada ? "Endireitar" : "Deitar", () => { c.deitada = !c.deitada; }]);
    itens.push([`Contador +1${c.cont ? ` (${c.cont})` : ""}`, () => { c.cont++; }]);
    if (c.cont) itens.push(["Zerar contadores", () => { c.cont = 0; }]);
  }
  if (zona !== "campo") itens.push(["Pro campo", () => gfMover(uid, "campo")]);
  if (zona !== "mao") itens.push(["Pra mão", () => gfMover(uid, "mao")]);
  if (zona !== "cemiterio") itens.push(["Pro cemitério", () => gfMover(uid, "cemiterio")]);
  if (zona !== "exilio") itens.push(["Pro exílio", () => gfMover(uid, "exilio")]);
  if (zona !== "baralho"){
    itens.push(["Pro topo do baralho", () => gfMover(uid, "baralho", true)]);
    itens.push(["Pro fundo do baralho", () => gfMover(uid, "baralho", false)]);
  }
  if (zona === "comando"){
    // O imposto é INFORMAÇÃO: a tela conta quantas vezes o comandante saiu da
    // zona e diz quanto custaria a próxima. Não cobra nada.
    itens.push(["Pro campo (paga imposto)", () => {
      estado.mesa.impostoPago++;
      gfMover(uid, "campo");
    }]);
  }
  itens.push([c.virada ? "Desvirar" : "Virar pra baixo", () => { c.virada = !c.virada; }]);
  itens.push(["Ver a carta", () => abrirCarta(c.carta)]);

  const menu = document.createElement("div");
  menu.className = "gf-menu";
  menu.innerHTML = itens.map((it, i) => `<button data-gf-item="${i}">${escapar(it[0])}</button>`).join("");
  document.body.appendChild(menu);
  // Não deixa o menu sair da tela por baixo nem pela direita.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-gf-item]");
    if (!b) return;
    const acao = itens[Number(b.dataset.gfItem)][1];
    gfGuardar();
    acao();
    gfFecharMenu();
    desenharMesa();
  });
}

function gfVerZona(zona){
  const m = estado.mesa;
  const lista = m[zona] || [];
  if (!lista.length) return toast("Zona vazia.");
  // Sem tela nova: a lista de nomes responde "o que tem aí" e o menu de cada
  // carta continua alcançável pelo campo. Uma quarta fila permanente na mesa
  // custaria altura que a mão precisa mais.
  toast(lista.map(c => (c.carta && c.carta.nome) || "?").join(", "));
}

export function ligarGoldfish(){
  $("gf-embaralhar").addEventListener("click", () => {
    if (!cartasContadas().length && !estado.comandantes.length){
      return toast("Monte o deck primeiro.");
    }
    estado.mesaDesfazer = [];
    montarMesa();
    desenharMesa();
  });

  $("gf-desfazer").addEventListener("click", desfazerMesa);

  $("gf-tela").addEventListener("click", () => {
    const cheia = document.body.classList.toggle("gf-cheia");
    $("gf-tela").textContent = cheia ? "Sair da tela cheia" : "Tela cheia";
  });

  $("gf-mesa").addEventListener("click", (e) => {
    const ver = e.target.closest("[data-gf-ver]");
    if (ver) return gfVerZona(ver.dataset.gfVer);

    const vida = e.target.closest("[data-gf-vida]");
    if (vida){
      gfGuardar("vida");
      ajustarVida(Number(vida.dataset.gfVida));
      return desenharMesa();
    }

    if (e.target.closest("#gf-manter")){ gfGuardar(); manterMao(); return desenharMesa(); }
    if (e.target.closest("#gf-mulligan")){ gfGuardar(); mulliganLondon(); return desenharMesa(); }
    if (e.target.closest("#gf-turno-btn")){ gfGuardar(); passarTurno(); return desenharMesa(); }
    if (e.target.closest("#gf-comprar")){ gfGuardar(); comprar(1); return desenharMesa(); }

    const carta = e.target.closest("[data-gf-uid]");
    if (!carta) return;
    const uid = Number(carta.dataset.gfUid);
    const zona = carta.dataset.gfZona;

    // Na fase de mandar pro fundo, clicar na mão é ESCOLHER — não abrir menu.
    if (estado.mesa && estado.mesa.fase === "fundo" && zona === "mao"){
      gfGuardar();
      mandarPraFundo(uid);
      return desenharMesa();
    }
    const r = carta.getBoundingClientRect();
    gfAbrirMenu(uid, zona, r.left, r.bottom + 4);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".gf-menu") && !e.target.closest("[data-gf-uid]")) gfFecharMenu();
  });
}
