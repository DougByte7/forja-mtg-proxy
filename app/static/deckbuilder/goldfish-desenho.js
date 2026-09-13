/* ------------------------------------------------- o desenho da mesa

   Uma seção por jogador, e dentro dela a ordem de um tabuleiro: quem é e como
   está (vida, marcadores, zonas), o campo de batalha, os terrenos e, na borda
   de quem joga, a mão com o comando ao lado. As quatro áreas existem sempre,
   mesmo vazias: são o lugar pra onde a carta vai, e uma área que só aparece
   com a primeira carta faria a mesa pular a cada jogada.

   Com dois decks a mesa é ESPELHADA, como numa mesa de verdade: o segundo
   jogador fica em cima com a ordem invertida — mão, terrenos, campo de
   batalha —, e os dois campos de batalha se encaram no meio. O espelho vale
   dentro do campo de batalha também: as criaturas ficam do lado do meio,
   de frente pras do outro.

   Este módulo só LÊ a mesa. Quem muda alguma coisa é `goldfish-acoes.js`, e a
   separação é o que deixa as regras (`goldfish.js`) rodarem no teste sem DOM
   nenhum por perto. O painel da carta mora aqui pelo mesmo motivo: ele lê a
   carta, e é repintado junto com a mesa. */

import {$, escapar} from "../comum/dom.js";
import {imagemDaFace} from "./artes.js";
import {detalheDaCarta} from "./carta.js";
import {CORES, estado, NOME_COR} from "./estado.js";
import {artesDoJogador, atacantes, cartaPorUid, devolveAoManterDe, ehTerreno,
        grupoDoCampo, nomeDaCarta, resumoDaMao} from "./goldfish.js";
import {manaEmTexto, manaHTML} from "./utilidades.js";

/* A arte de uma carta da mesa: a escolhida no deck DO DONO, e a padrão quando
   não há. O dono importa com dois decks na mesa — o Sol Ring de um não pode
   aparecer com a arte que o outro escolheu. A face é a que está pra cima
   (ver `alternarFace`). */
function arteNaMesa(c){
  const face = c.verso ? "verso" : "frente";
  return imagemDaFace(c.carta || {}, face, 0, artesDoJogador(c.dono));
}

/* Um marcador na carta cabe em duas ou três letras, e não no nome: o canto
   da carta é o espaço de um selo. A sigla é o que se reconhece de relance
   ("+2" de +1/+1), e o nome inteiro fica no `title`. */
function siglaDaMarca(nome){
  if (nome === "+1/+1") return "+";
  if (nome === "-1/-1") return "−";
  return nome.slice(0, 1).toUpperCase();
}

function marcasDaCartaHTML(c){
  const nomes = Object.keys(c.marcas || {});
  if (!nomes.length) return "";
  // Três cabem; a quarta viraria tarja sobre a arte. O `title` lista todas.
  const titulo = nomes.map(n => `${n}: ${c.marcas[n]}`).join(", ");
  return `<span class="gf-marcas" title="${escapar(titulo)}">${
    nomes.slice(0, 3).map(n => `<span class="gf-marca-b">${
      escapar(siglaDaMarca(n))}${c.marcas[n]}</span>`).join("")}</span>`;
}

/* Nenhuma carta da mesa usa a prévia que segue o mouse: a carta aparece no
   painel (ver `mostrarPainel`), e as duas juntas mostrariam a mesma carta
   duas vezes. */
function gfCartaHTML(c, zona){
  const carta = c.carta || {};
  const arte = c.virada ? "" : arteNaMesa(c);
  const classes = ["gf-carta"];
  if (c.deitada) classes.push("deitada");
  if (c.virada) classes.push("virada");
  if (c.atacando) classes.push("atacando");
  if (c.bloqueando) classes.push("bloqueando");
  if (c.ficha) classes.push("ficha");
  const bloqueado = c.bloqueando ? cartaPorUid(c.bloqueando) : null;
  const marca = c.atacando ? `<span class="gf-combate" title="Atacando">⚔</span>`
    : c.bloqueando ? `<span class="gf-combate" title="Bloqueia ${
        escapar(nomeDaCarta(bloqueado))}">🛡</span>` : "";
  // Só a mão leva o nome: é onde a decisão acontece. Ficha não tem arte da
  // Scryfall se foi inventada na hora: o nome dentro do quadro é tudo o que
  // ela tem pra se identificar.
  const rotulo = zona === "mao" || (c.ficha && !arte)
    ? `<span class="gf-nome">${escapar(carta.nome || "")}${
        c.ficha && carta.poder ? ` ${carta.poder}/${carta.resistencia}` : ""}</span>`
    : "";
  return `<button class="${classes.join(" ")}" data-gf-uid="${c.uid}" draggable="true"
    title="${escapar(carta.nome || "")}"
    ${arte ? `style="background-image:url('${escapar(arte)}')"` : ""}>
    ${marcasDaCartaHTML(c)}${marca}${rotulo}
  </button>`;
}

function cartasHTML(lista, zona){
  return `<div class="gf-fila">${lista.map(c => gfCartaHTML(c, zona)).join("")}</div>`;
}

/* ------------------------------------------------ o painel da carta */

function corpoDaFace(f){
  if (f.poder != null && f.resistencia != null) return `${f.poder}/${f.resistencia}`;
  if (f.lealdade != null) return `Lealdade ${f.lealdade}`;
  if (f.defesa != null) return `Defesa ${f.defesa}`;
  return "";
}

function faceDoPainelHTML(f, comNome){
  const corpo = corpoDaFace(f);
  return `<div class="gf-detalhe-face">
    ${comNome ? `<div class="gf-detalhe-nome"><b>${escapar(f.nome)}</b>${
      manaHTML(f.mana_cost)}</div>` : ""}
    ${f.tipo ? `<div class="gf-detalhe-tipo">${escapar(f.tipo)}</div>` : ""}
    ${f.texto ? `<p class="gf-detalhe-texto">${manaEmTexto(f.texto)}</p>` : ""}
    ${corpo ? `<div class="gf-detalhe-pt">${escapar(corpo)}</div>` : ""}
  </div>`;
}

/* O que a carta impressa não diz e a mesa sabe: marcadores, deitada, combate,
   a face pra cima, e se ela é ficha ou comandante. Só o que está
   acontecendo — carta em pé e sem marcador não ganha linha nenhuma. */
function estadoDaCartaHTML(c){
  const itens = [];
  if (c.cmd) itens.push("Comandante");
  if (c.ficha) itens.push("Ficha");
  if (c.virada) itens.push("Virada pra baixo");
  if (c.verso) itens.push("Mostrando o verso");
  if (c.deitada) itens.push("Deitada");
  if (c.atacando) itens.push("Atacando");
  if (c.bloqueando) itens.push("Bloqueia " + nomeDaCarta(cartaPorUid(c.bloqueando)));
  for (const nome of Object.keys(c.marcas || {})) itens.push(`${nome}: ${c.marcas[nome]}`);
  if (!itens.length) return "";
  return `<div class="gf-detalhe-estado">${
    itens.map(t => `<span>${escapar(t)}</span>`).join("")}</div>`;
}

/* O texto do painel: o que decide a jogada — custo, tipo, oracle e corpo.
   Edição, preço e ambientação ficam na modal "Ver a carta".

   `d` é o detalhe da Scryfall quando já chegou, e é dele que saem poder,
   resistência, lealdade e defesa, que a base local não guarda. Antes dele o
   painel mostra o que a carta já traz; carta de duas faces vem da base com o
   texto emendado por "//", e com o detalhe ganha uma face por bloco. */
function painelDaCartaHTML(c, d){
  const carta = c.carta || {};
  const faces = d && d.faces && d.faces.length ? d.faces : [{
    nome: carta.nome, mana_cost: carta.mana_cost, tipo: carta.tipo,
    texto: carta.texto, poder: carta.poder || null,
    resistencia: carta.resistencia || null,
  }];
  const duas = faces.length > 1;
  return `<div class="gf-detalhe-topo"><b>${escapar(carta.nome || "")}</b>${
      manaHTML(carta.mana_cost)}</div>
    ${estadoDaCartaHTML(c)}
    ${faces.map(f => faceDoPainelHTML(f, duas)).join("")}`;
}

const PAINEL_LARGO = 288;   // o `width` de `.gf-detalhe` no CSS
const PAINEL_VAO = 16;
let painelUid = null;

/* Flutuando (fora da tela cheia) o painel cobre a busca, então ele some
   quando o mouse sai da carta. Na coluna reservada da tela cheia ele é o
   lugar da carta, e fica com a última carta olhada até o próximo hover.
   Quem decide o modo é o CSS (`body.gf-cheia .gf-area`); o script só lê. */
export function painelFlutua(){
  return getComputedStyle($("gf-detalhe")).position === "fixed";
}

export function esconderPainel(){
  painelUid = null;
  $("gf-detalhe").classList.remove("mostra");
}

/* Hover numa carta da mesa — de qualquer zona — abre a carta grande com o
   que decide a jogada. Flutuando, o painel fica preso à mesa e não ao
   cursor: as cartas são grandes, e seguindo o mouse ele cobriria as vizinhas
   que a pessoa está comparando. */
export async function mostrarPainel(uid){
  const painel = $("gf-detalhe");
  // O mouseover dispara de novo a cada filho da carta (o nome, um marcador):
  // repintar ali pediria o detalhe de novo à toa.
  if (painelUid === uid && painel.classList.contains("mostra")) return;
  const c = cartaPorUid(uid);
  if (!c) return esconderPainel();
  painelUid = uid;

  // A arte só é trocada quando muda: reatribuir o mesmo `src` faz o navegador
  // repintar a imagem, e o painel piscaria a cada repintura da mesa.
  const img = $("gf-detalhe-arte");
  const src = arteNaMesa(c);
  if (img.dataset.src !== src){
    img.dataset.src = src;
    if (src) img.src = src; else img.removeAttribute("src");
  }
  img.classList.toggle("vazia", !src);
  $("gf-detalhe-corpo").innerHTML = painelDaCartaHTML(c, null);

  if (painelFlutua()){
    const mesa = $("gf-mesa").getBoundingClientRect();
    painel.style.left = Math.max(8, mesa.left - PAINEL_LARGO - PAINEL_VAO) + "px";
  } else {
    painel.style.left = "";
  }
  painel.classList.add("mostra");

  // Ficha inventada na hora não existe na Scryfall.
  const nome = c.ficha ? "" : (c.carta || {}).nome;
  if (!nome) return;
  let d;
  try {
    d = await detalheDaCarta(nome);
  } catch (e){
    return;   // fica o que a base local sabe, que é o que já está na tela
  }
  // A carta pode ter mudado enquanto o detalhe vinha (um marcador, o verso).
  const agora = painelUid === uid && cartaPorUid(uid);
  if (agora) $("gf-detalhe-corpo").innerHTML = painelDaCartaHTML(agora, d);
}

/* A mesa foi redesenhada. Flutuando, o painel fecha: o elemento sob o mouse
   foi trocado, e o próximo movimento o abre de novo. Na coluna ele se repinta
   com a carta como ela está agora — ou fecha, se ela deixou de existir
   (ficha que saiu do campo). */
function atualizarPainel(){
  if (painelUid === null) return;
  const uid = painelUid;
  if (!estado.mesa || !cartaPorUid(uid) || painelFlutua()) return esconderPainel();
  painelUid = null;   // senão `mostrarPainel` acharia que já está mostrando
  mostrarPainel(uid);
}

/* ------------------------------------------------------------- o resumo */

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

/* ------------------------------------------------------------- as áreas */

/* Uma área da mesa: título com a contagem, e o corpo. A área inteira é alvo
   de soltar — soltar em qualquer ponto dela, e não só em cima de outra carta,
   é o que deixa a área vazia receber a primeira. */
function areaHTML(titulo, conta, corpo, zona, ij, classe){
  return `<div class="gf-area-mesa ${classe}" data-gf-solta="${zona}" data-gf-j="${ij}">
    <div class="gf-area-titulo">${titulo} <b>${conta}</b></div>
    <div class="gf-area-corpo">${corpo}</div>
  </div>`;
}

function vazioHTML(texto){
  return `<div class="gf-vazio">${escapar(texto)}</div>`;
}

/* Criaturas numa fila, o resto noutra: quem olha um tabuleiro procura uma
   coisa de cada vez ("tenho bicho pra atacar?"), e misturadas cada pergunta
   vira busca visual. Fila vazia não é desenhada — a área já tem a altura de
   uma carta. A ordem dentro de cada fila é a que a pessoa arrumou (ver
   `reposicionar`). */
function campoDeBatalhaHTML(j, ij, espelhado){
  const criaturas = j.campo.filter(c => grupoDoCampo(c) === "Criaturas");
  const outras = j.campo.filter(c => grupoDoCampo(c) === "Outros");
  const filas = espelhado ? [outras, criaturas] : [criaturas, outras];
  const total = criaturas.length + outras.length;
  const corpo = total
    ? filas.filter(l => l.length).map(l => cartasHTML(l, "campo")).join("")
    : vazioHTML("nada em jogo");
  return areaHTML("Campo de batalha", total, corpo, "campo", ij, "gf-batalha");
}

/* Terreno-criatura mora aqui, e pela mesma razão de `CATEGORIAS`: a primeira
   regra que casa ganha, e pra quem joga ele é o terreno que entrou no turno. */
function terrenosHTML(j, ij){
  const terrenos = j.campo.filter(c => grupoDoCampo(c) === "Terrenos");
  const corpo = terrenos.length ? cartasHTML(terrenos, "campo") : vazioHTML("nenhum terreno");
  return areaHTML("Terrenos", terrenos.length, corpo, "campo", ij, "gf-terrenos");
}

/* O comando fica ao lado da mão porque é de onde se lança o comandante —
   são as duas áreas de "o que eu posso jogar agora". O imposto é
   INFORMAÇÃO: quanto a próxima vez custaria, sem cobrar nada. */
function maoEComandoHTML(j, ij){
  const imposto = j.impostoPago
    ? `<div class="gf-imposto">próxima vez custa +${j.impostoPago * 2}</div>` : "";
  const comando = areaHTML("Comando", j.comando.length,
    (j.comando.length ? cartasHTML(j.comando, "comando") : vazioHTML("vazia")) + imposto,
    "comando", ij, "gf-comando");
  const mao = areaHTML("Mão", j.mao.length,
    resumoHTML(j.mao) + (j.mao.length ? cartasHTML(j.mao, "mao") : vazioHTML("mão vazia")),
    "mao", ij, "gf-area-mao");
  return `<div class="gf-linha-mao">${comando}${mao}</div>`;
}

/* ------------------------------------------------- cabeça de cada jogador */

function passoHTML(acao, rotulo, texto){
  return `<button data-gf-acao="${acao}" aria-label="${escapar(rotulo)}"
    title="${escapar(rotulo)}">${texto}</button>`;
}

function vidaHTML(j, ij){
  return `<span class="gf-vida">Vida
    ${passoHTML(`vida:${ij}:-5`, "Menos 5 de vida", "−5")}
    ${passoHTML(`vida:${ij}:-1`, "Menos 1 de vida", "−1")}
    <b>${j.vida}</b>
    ${passoHTML(`vida:${ij}:1`, "Mais 1 de vida", "+1")}
    ${passoHTML(`vida:${ij}:5`, "Mais 5 de vida", "+5")}
  </span>`;
}

function marcasDoJogadorHTML(j, ij){
  const chips = Object.keys(j.marcas).map(nome => `<span class="gf-marca">
    ${escapar(nome)}
    ${passoHTML(`marca:${ij}:${nome}:-1`, `Menos 1 de ${nome}`, "−")}
    <b>${j.marcas[nome]}</b>
    ${passoHTML(`marca:${ij}:${nome}:1`, `Mais 1 de ${nome}`, "+")}
  </span>`).join("");
  return chips + `<button class="gf-mais" data-gf-acao="novaMarca:${ij}"
    title="Pôr um marcador neste jogador">+ marcador</button>`;
}

/* Dano de comandante: só existe com dois decks na mesa. Sozinho, ele seria uma
   linha pra anotar o dano do próprio comandante em si mesmo. */
function danoHTML(j, ij, mesa){
  if (mesa.jogadores.length < 2) return "";
  return mesa.jogadores.map((outro, io) => {
    if (io === ij) return "";
    const n = j.danoCmd[io] || 0;
    return `<span class="gf-dano${n >= 21 ? " letal" : ""}"
      title="Dano do comandante de ${escapar(outro.nome)} — 21 mata">
      Cmd ${passoHTML(`dano:${ij}:${io}:-1`, "Menos 1 de dano", "−")}
      <b>${n}</b>
      ${passoHTML(`dano:${ij}:${io}:1`, "Mais 1 de dano", "+")}
    </span>`;
  }).join("");
}

function zonasHTML(j, ij){
  const terrenos = j.campo.filter(c => ehTerreno(c.carta));
  const emPe = terrenos.filter(c => !c.deitada).length;
  // Fatos do tabuleiro, não conta de mana: quantos terrenos estão em pé e
  // quantos deitados. Ver o cabeçalho de `goldfish.js`.
  return `<div class="gf-zonas">
    <button data-gf-acao="buscar:${ij}:baralho" data-gf-solta="baralho"
      data-gf-j="${ij}" title="Ver e buscar no baralho (ele é reembaralhado ao fechar)"
      >Baralho <b>${j.baralho.length}</b></button>
    <span>Terrenos <b>${emPe}</b> em pé${
      terrenos.length - emPe ? ` · <b>${terrenos.length - emPe}</b> deitados` : ""}</span>
    ${j.terrenosBaixados ? `<span title="Conta, não impede — aqui não tem juiz."
      >Baixados neste turno <b>${j.terrenosBaixados}</b></span>` : ""}
    <button data-gf-acao="buscar:${ij}:cemiterio" data-gf-solta="cemiterio"
      data-gf-j="${ij}">Cemitério <b>${j.cemiterio.length}</b></button>
    <button data-gf-acao="buscar:${ij}:exilio" data-gf-solta="exilio"
      data-gf-j="${ij}">Exílio <b>${j.exilio.length}</b></button>
  </div>`;
}

/* ------------------------------------------------ o que vai junto da mão */

function notaDoMulliganHTML(j, ij){
  const devolve = devolveAoManterDe(ij);
  // A compra do turno só vem pra quem está na vez (ver `confirmarMao`).
  const naVez = estado.mesa.ativo === ij;
  const depois = naVez ? "" : " A compra do turno vem quando chegar a vez.";
  if (j.fase === "fundo"){
    return `<p class="nota">Escolha <b>${j.aFundo}</b> carta(s) pra mandar pro
      fundo do baralho — clique nelas, na ordem que quiser.${naVez
        ? " Depois delas vem a compra do turno." : depois}</p>`;
  }
  return `<p class="nota">${j.mulligans === 0
      ? "Mão de abertura."
      : `${j.mulligans}º mulligan.`} Se manter agora, ${devolve
      ? `devolve <b>${devolve}</b> carta(s) pro fundo${naVez ? " e compra a do turno" : ""}`
      : naVez ? `compra a do turno e fica com <b>${j.mao.length + 1}</b>`
      : `fica com <b>${j.mao.length}</b>`}.${depois}</p>`;
}

function controlesDaMaoHTML(j, ij){
  if (j.fase === "jogo"){
    return `<div class="gf-acoes">
      <button class="btn" data-gf-acao="comprar:${ij}">Comprar 1</button>
      <button class="btn" data-gf-acao="buscar:${ij}:baralho">Buscar no deck</button>
      <button class="btn" data-gf-acao="ficha:${ij}">Criar ficha</button>
    </div>`;
  }
  return notaDoMulliganHTML(j, ij) + (j.fase === "fundo" ? "" : `<div class="gf-acoes">
      <button class="btn ouro" data-gf-acao="manter:${ij}">Manter esta mão</button>
      <button class="btn" data-gf-acao="mulligan:${ij}">Mulligan</button>
    </div>`);
}

/* Os controles da mão ficam do lado de fora, na borda de quem joga: embaixo
   da mão de quem está embaixo, e em cima da de quem está em cima. */
function jogadorHTML(j, ij, mesa, espelhado){
  const dois = mesa.jogadores.length > 1;
  const eleJoga = dois && mesa.ativo === ij;
  const cabeca = `<div class="gf-cabeca">
      ${dois ? `<b class="gf-nome-j">${escapar(j.nome)}</b>` : ""}
      ${eleJoga ? `<span class="gf-vez">é a vez</span>` : ""}
      ${vidaHTML(j, ij)}
      ${danoHTML(j, ij, mesa)}
      ${marcasDoJogadorHTML(j, ij)}
    </div>
    ${zonasHTML(j, ij)}`;
  const partes = espelhado
    ? [cabeca, controlesDaMaoHTML(j, ij), maoEComandoHTML(j, ij),
       terrenosHTML(j, ij), campoDeBatalhaHTML(j, ij, true)]
    : [cabeca, campoDeBatalhaHTML(j, ij, false), terrenosHTML(j, ij),
       maoEComandoHTML(j, ij), controlesDaMaoHTML(j, ij)];
  return `<section class="gf-jogador${eleJoga ? " ativo" : ""}${
    espelhado ? " espelhado" : ""}" data-gf-j="${ij}">${partes.join("")}</section>`;
}

/* ------------------------------------------------------- rodapé e log */

function rodapeHTML(m){
  const emCombate = atacantes().length ||
    m.jogadores.some(j => j.campo.some(c => c.bloqueando));
  return `<div class="gf-acoes gf-rodape">
    <button class="btn ouro" data-gf-acao="turno">Passar turno (compra 1)</button>
    ${emCombate ? `<button class="btn" data-gf-acao="combate">Fim do combate</button>` : ""}
  </div>`;
}

/* O log fica fechado, e aberto continua aberto: ele é conferência depois do
   fato ("em que turno eu baixei aquilo?"), não o assunto da tela. O estado do
   `details` mora na mesa porque o desenho reescreve o HTML a cada clique — um
   `open` nascido do HTML fecharia sozinho a cada jogada. */
function logHTML(m){
  if (!m.log.length) return "";
  const linhas = m.log.slice().reverse().map(l =>
    `<li><span class="gf-log-t">T${l.turno}</span> ${escapar(l.texto)}</li>`).join("");
  return `<div class="gf-log">
    <button class="gf-log-cabeca" data-gf-acao="log" aria-expanded="${m.logAberto}"
      >${m.logAberto ? "▾" : "▸"} Log da partida <b>${m.log.length}</b></button>
    ${m.logAberto ? `<ol class="gf-log-lista">${linhas}</ol>` : ""}
  </div>`;
}

function tituloDoTurno(m){
  const j = m.jogadores[m.ativo];
  const vez = m.jogadores.length > 1 ? ` · vez de ${j.nome}` : "";
  if (j.fase !== "jogo" && m.turno === 1){
    return (j.mulligans ? `Mulligan ${j.mulligans}` : "Mão de abertura") + vez;
  }
  return `Turno ${m.turno}${vez}`;
}

export function desenharMesa(){
  const alvo = $("gf-mesa");
  const m = estado.mesa;
  $("gf-desfazer").disabled = !estado.mesaDesfazer.length;
  $("gf-segundo").disabled = !m;
  $("gf-encerrar").disabled = !m;
  if (!m){
    $("gf-turno").textContent = "";
    alvo.innerHTML = `<div class="gf-vazio">Clique em <b>Embaralhar</b> pra
      começar. O comandante vai pra zona de comando; o sideboard e o maybeboard
      ficam de fora, como em toda análise desta tela.</div>`;
    atualizarPainel();
    return;
  }
  const dois = m.jogadores.length > 1;
  $("gf-segundo").textContent = dois ? "Tirar o 2º deck" : "Segundo deck";
  $("gf-segundo").title = dois
    ? "Tira o outro deck da mesa e volta ao goldfish solo"
    : "Põe um deck seu do outro lado da mesa";
  $("gf-turno").textContent = tituloDoTurno(m);
  // O segundo jogador vem primeiro: ele é o lado de cima da mesa espelhada.
  const ordem = dois ? [1, 0] : [0];
  alvo.innerHTML =
    `<div class="gf-jogadores">${ordem.map(ij =>
      jogadorHTML(m.jogadores[ij], ij, m, dois && ij === 1)).join("")}</div>` +
    rodapeHTML(m) + logHTML(m);
  atualizarPainel();
}
