/* ------------------------------------------------- o desenho da mesa

   Uma seção por jogador, de cima pra baixo, e dentro dela a ordem em que se
   olha um tabuleiro: quem é e como está (vida, marcadores), o que as zonas
   têm, o campo, o comando, a mão. Com um deck só a seção é a mesa inteira e
   nada disto parece dividido; com dois, é o mesmo desenho duas vezes — que é
   o que a lista de jogadores das regras existe pra permitir.

   Este módulo só LÊ a mesa. Quem muda alguma coisa é `goldfish-acoes.js`, e a
   separação é o que deixa as regras (`goldfish.js`) rodarem no teste sem DOM
   nenhum por perto. */

import {$, escapar} from "../comum/dom.js";
import {ganchosDaPrevia} from "./carta.js";
import {CORES, estado, NOME_COR} from "./estado.js";
import {atacantes, cartaPorUid, devolveAoManterDe, ehTerreno, GRUPOS_DO_CAMPO,
        grupoDoCampo, nomeDaCarta, resumoDaMao} from "./goldfish.js";

/* Um marcador na carta cabe em duas ou três letras, e não no nome: a carta
   tem 62px. A sigla é o que se reconhece de relance ("+2" de +1/+1), e o nome
   inteiro fica no `title`. */
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

function gfCartaHTML(c, zona){
  const carta = c.carta || {};
  const arte = c.virada ? "" : (carta.imagem || "");
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
  // Ficha não tem arte da Scryfall se foi inventada na hora: o nome dentro do
  // quadro é tudo o que ela tem pra se identificar.
  const rotulo = zona === "mao" || (c.ficha && !arte)
    ? `<span class="gf-nome">${escapar(carta.nome || "")}${
        c.ficha && carta.poder ? ` ${carta.poder}/${carta.resistencia}` : ""}</span>`
    : "";
  return `<button class="${classes.join(" ")}" data-gf-uid="${c.uid}" draggable="true"
    title="${escapar(carta.nome || "")}"
    ${arte ? `style="background-image:url('${escapar(arte)}')"` : ""}
    ${c.virada || c.ficha ? "" : ganchosDaPrevia(carta)}>
    ${marcasDaCartaHTML(c)}${marca}${rotulo}
  </button>`;
}

function filaHTML(lista, zona, ij, vazio){
  const solta = `data-gf-solta="${zona}" data-gf-j="${ij}"`;
  if (!lista.length){
    return `<div class="gf-vazio" ${solta}>${escapar(vazio)}</div>`;
  }
  return `<div class="gf-fila ${zona === "mao" ? "gf-mao" : ""}" ${solta}>${
    lista.map(c => gfCartaHTML(c, zona)).join("")}</div>`;
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

function campoHTML(j, ij){
  if (!j.campo.length){
    return `<div class="gf-vazio" data-gf-solta="campo" data-gf-j="${ij}">nada em jogo</div>`;
  }
  return GRUPOS_DO_CAMPO.map(([nome]) => {
    const lista = j.campo.filter(c => grupoDoCampo(c) === nome);
    if (!lista.length) return "";
    return `<div class="gf-subsecao">${nome} <b>${lista.length}</b></div>` +
      filaHTML(lista, "campo", ij, "");
  }).join("");
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
    <span>Mão <b>${j.mao.length}</b></span>
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

/* ----------------------------------------------------- corpo de cada fase */

function mulliganHTML(j, ij){
  const devolve = devolveAoManterDe(ij);
  const explica = j.fase === "fundo"
    ? `<p class="nota">Escolha <b>${j.aFundo}</b> carta(s) pra mandar pro
       fundo do baralho — clique nelas, na ordem que quiser. Depois delas
       vem a compra do turno 1.</p>`
    : `<p class="nota">${j.mulligans === 0
        ? "Mão de abertura."
        : `${j.mulligans}º mulligan.`} Se manter agora, ${devolve
        ? `devolve <b>${devolve}</b> carta(s) pro fundo e compra a do turno 1`
        : `compra a do turno 1 e fica com <b>${j.mao.length + 1}</b>`}.</p>`;
  return explica +
    `<div class="gf-secao">Mão</div>` +
    resumoHTML(j.mao) +
    filaHTML(j.mao, "mao", ij, "sem cartas") +
    (j.fase === "fundo" ? "" : `<div class="gf-acoes">
      <button class="btn ouro" data-gf-acao="manter:${ij}">Manter esta mão</button>
      <button class="btn" data-gf-acao="mulligan:${ij}">Mulligan</button>
    </div>`);
}

function jogoHTML(j, ij){
  return `<div class="gf-secao">Campo</div>` +
    campoHTML(j, ij) +
    (j.comando.length ? `<div class="gf-secao">Comando${j.impostoPago
      ? ` — próxima vez custa +${j.impostoPago * 2}` : ""}</div>`
      + filaHTML(j.comando, "comando", ij, "") : "") +
    `<div class="gf-secao">Mão (${j.mao.length})</div>` +
    resumoHTML(j.mao) +
    filaHTML(j.mao, "mao", ij, "mão vazia") +
    `<div class="gf-acoes">
      <button class="btn" data-gf-acao="comprar:${ij}">Comprar 1</button>
      <button class="btn" data-gf-acao="buscar:${ij}:baralho">Buscar no deck</button>
      <button class="btn" data-gf-acao="ficha:${ij}">Criar ficha</button>
    </div>`;
}

function jogadorHTML(j, ij, mesa){
  const dois = mesa.jogadores.length > 1;
  const eleJoga = dois && mesa.ativo === ij;
  return `<section class="gf-jogador${eleJoga ? " ativo" : ""}" data-gf-j="${ij}">
    <div class="gf-cabeca">
      ${dois ? `<b class="gf-nome-j">${escapar(j.nome)}</b>` : ""}
      ${eleJoga ? `<span class="gf-vez">é a vez</span>` : ""}
      ${vidaHTML(j, ij)}
      ${danoHTML(j, ij, mesa)}
      ${marcasDoJogadorHTML(j, ij)}
    </div>
    ${zonasHTML(j, ij)}
    ${j.fase === "jogo" ? jogoHTML(j, ij) : mulliganHTML(j, ij)}
  </section>`;
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
    return;
  }
  const dois = m.jogadores.length > 1;
  $("gf-segundo").textContent = dois ? "Tirar o 2º deck" : "Segundo deck";
  $("gf-segundo").title = dois
    ? "Tira o outro deck da mesa e volta ao goldfish solo"
    : "Põe um deck seu do outro lado da mesa";
  $("gf-turno").textContent = tituloDoTurno(m);
  alvo.innerHTML =
    `<div class="gf-jogadores">${
      m.jogadores.map((j, ij) => jogadorHTML(j, ij, m)).join("")}</div>` +
    rodapeHTML(m) + logHTML(m);
}
