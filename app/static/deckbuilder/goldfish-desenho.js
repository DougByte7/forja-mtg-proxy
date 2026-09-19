/* ------------------------------------------------- o desenho da mesa

   Uma seção por jogador, e dentro dela a ordem de um tabuleiro: o campo de
   batalha (criaturas | outros), a linha dos terrenos entre o comando e o
   exílio, a linha da mão entre o deck e o cemitério e, na borda de quem joga,
   a barra com quem é e como está. As áreas existem sempre, mesmo vazias: são
   o lugar pra onde a carta vai, e uma área que só aparece com a primeira
   carta faria a mesa pular a cada jogada.

   Com dois decks a mesa é ESPELHADA na vertical, como numa mesa de verdade: o
   segundo jogador fica em cima com a ordem invertida — barra, mão, terrenos,
   campo de batalha —, e os dois campos de batalha se encaram no meio. Na
   horizontal nada vira: as criaturas de um ficam em cima das do outro.

   Este módulo só LÊ a mesa. Quem muda alguma coisa é `goldfish-acoes.js`, e a
   separação é o que deixa as regras (`goldfish.js`) rodarem no teste sem DOM
   nenhum por perto. O painel da carta mora aqui pelo mesmo motivo: ele lê a
   carta, e é repintado junto com a mesa. */

import {$, escapar} from "../comum/dom.js";
import {imagemDaFace} from "./artes.js";
import {detalheDaCarta} from "./carta.js";
import {assinaturaDoDeck} from "./combos.js";
import {CORES, estado, NOME_COR} from "./estado.js";
import {artesDoJogador, atacantes, cartaPorUid, combosDaCarta, devolveAoManterDe,
        ehTerreno, grupoDoCampo, nomeDaCarta, NOME_DA_ZONA, quantosCombos,
        resumoDaMao} from "./goldfish.js";
import {manaEmTexto, manaHTML} from "./utilidades.js";

/* A arte de uma carta da mesa: a escolhida no deck DO DONO, e a padrão quando
   não há. O dono importa com dois decks na mesa — o Sol Ring de um não pode
   aparecer com a arte que o outro escolheu. A face é a que está pra cima
   (ver `alternarFace`). */
function arteNaMesa(c){
  const face = c.verso ? "verso" : "frente";
  return imagemDaFace(c.carta || {}, face, 0, artesDoJogador(c.dono));
}

/* Cada selo diz a quantidade e o nome ("5: +1/+1"): marcador de Magic é
   lista aberta, e uma sigla de uma letra confunde "tempo" com "tesouro". */
function marcasDaCartaHTML(c){
  const nomes = Object.keys(c.marcas || {});
  if (!nomes.length) return "";
  // Três cabem; a quarta viraria tarja sobre a arte. O `title` lista todas.
  const titulo = nomes.map(n => `${n}: ${c.marcas[n]}`).join(", ");
  return `<span class="gf-marcas" title="${escapar(titulo)}">${
    nomes.slice(0, 3).map(n => `<span class="gf-marca-b">${
      c.marcas[n]}: ${escapar(n)}</span>`).join("")}</span>`;
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
  // A carta que é peça de combo se anuncia SEM hover: o painel responde
  // "quais combos", mas ninguém passa o mouse numa carta que não deu sinal de
  // ter o que contar. Carta virada pra baixo não ganha selo — ela está
  // escondida, e o selo a entregaria.
  const quantos = c.virada ? 0 : quantosCombos(c);
  const selo = quantos
    ? `<span class="gf-combo-selo" title="Peça de ${quantos} combo(s) do deck"
        >${quantos}</span>`
    : "";
  return `<button class="${classes.join(" ")}" data-gf-uid="${c.uid}" draggable="true"
    title="${escapar(carta.nome || "")}"
    ${arte ? `style="background-image:url('${escapar(arte)}')"` : ""}>
    ${marcasDaCartaHTML(c)}${selo}${marca}${rotulo}
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
/* Os combos desta carta, no painel. A peça vem com a zona onde está — campo,
   mão, baralho —, e é isso que responde a pergunta do meio da partida: não
   "este deck tem o combo" (a aba de combos já diz), e sim "quanto falta pra
   ele acontecer AGORA".

   A carta que abriu o painel se marca entre as peças: sem isso um combo de
   quatro nomes vira uma lista em que a pessoa procura qual deles ela está
   olhando.

   O que o combo PEDE (mana, estado de jogo) vem como o texto do Spellbook, e
   fica visualmente separado do que ele PRODUZ — um é condição, o outro é
   consequência, e trocar os dois é ler o combo ao contrário. A mesa não
   confere nenhum dos dois: ela não soma mana (ver o cabeçalho de
   `goldfish.js`), e um "pode fazer" daqui seria palpite com cara de regra.

   Sem link pro Spellbook de propósito: o painel é `pointer-events:none` —
   ele é leitura, e não pode roubar o hover da carta que o abriu —, então um
   link aqui seria um link que não clica. */
function pecaDoComboHTML(p){
  const zona = p.zona
    ? `<i>${escapar(NOME_DA_ZONA[p.zona])}</i>`
    : `<i title="Esta peça não foi embaralhada: ou saiu do deck depois da busca
        de combos, ou a base local não conhece a carta.">fora da mesa</i>`;
  return `<span class="gf-peca z-${p.zona || "fora"}${p.esta ? " esta" : ""}"
    >${escapar(p.nome)}${zona}</span>`;
}

function comboDoPainelHTML(achado){
  const combo = achado.combo;
  const pecas = achado.pecas.map(pecaDoComboHTML).join('<span class="mais">+</span>');
  // Peça GENÉRICA ("uma criatura com vigilância") é critério, não carta: não
  // tem zona porque não tem uma carta específica pra procurar na mesa. Quem
  // decide se alguma coisa em jogo serve é quem está jogando.
  const genericas = (combo.requer || []).map(r =>
    `<span class="mais">+</span><span class="gf-peca generica"
      title="Critério, não carta: qualquer carta do deck que se encaixe serve."
     >${escapar(r)}</span>`).join("");

  const precisa = [];
  if (combo.mana) precisa.push(`<b>Mana:</b> ${manaEmTexto(combo.mana)}`);
  if (combo.prerequisitos) precisa.push(escapar(combo.prerequisitos));

  return `<div class="gf-combo">
    <div class="gf-combo-pecas">${pecas}${genericas}</div>
    ${precisa.length ? `<div class="gf-combo-precisa">${precisa.join("<br>")}</div>` : ""}
    ${combo.produz && combo.produz.length
      ? `<div class="gf-combo-produz">${escapar(combo.produz.join(", "))}</div>` : ""}
  </div>`;
}

function combosDaCartaHTML(c){
  const achados = combosDaCarta(c);
  if (!achados.length) return "";
  // A lista fecha com o deck de quando a busca rodou, não com o de agora —
  // mesma ressalva que a aba de combos faz, e pelo mesmo motivo: a mesa foi
  // embaralhada de um deck que pode ter mudado desde então.
  const velho = estado.combosAssinatura !== assinaturaDoDeck()
    ? `<div class="gf-combo-velho">O deck mudou desde a busca de combos.</div>` : "";
  return `<div class="gf-combos">
    <div class="gf-combos-titulo">Combos <b>${achados.length}</b></div>
    ${velho}${achados.map(comboDoPainelHTML).join("")}
  </div>`;
}

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
    ${faces.map(f => faceDoPainelHTML(f, duas)).join("")}
    ${combosDaCartaHTML(c)}`;
}

const PAINEL_LARGO = 288;   // o `width` de `.gf-detalhe` no CSS
const PAINEL_VAO = 16;
let painelUid = null;

/* Flutuando (fora da tela cheia) o painel cobre a busca, então ele some
   quando o mouse sai da carta. Na coluna reservada da tela cheia ele é o
   lugar da carta, e fica com a última carta olhada até o próximo hover.
   Quem decide o modo é o CSS (`body.gf-cheia .gf-coluna`); o script só lê. */
export function painelFlutua(){
  return getComputedStyle($("gf-detalhe")).position === "fixed";
}

export function esconderPainel(){
  painelUid = null;
  $("gf-detalhe").classList.remove("mostra");
}

/* Marca se ainda há texto embaixo do que está à vista. É o que acende a
   franja no pé do painel flutuante — lá a barra de rolagem fica escondida (ver
   `.gf-detalhe.flutua`), e sem nenhum sinal a pessoa não tem como saber que a
   carta continua. Some ao chegar no fim, senão prometeria um resto que não
   existe. */
function marcarSobra(){
  const corpo = $("gf-detalhe-corpo");
  const fim = corpo.scrollHeight - corpo.clientHeight;
  $("gf-detalhe").classList.toggle("tem-mais", fim > 1 && corpo.scrollTop < fim - 1);
}

/* A roda do mouse rola o painel FLUTUANTE, porque a barra dele não tem como
   ser agarrada: ele não pega o ponteiro (senão fecharia a carta que o abriu,
   ver `.gf-detalhe`), e a mão de quem lê está na carta, do outro lado da
   mesa. Rolar dali é o único caminho até o texto que não coube — e era por
   isso que carta de texto longo, ou peça de muitos combos, terminava cortada
   na borda sem jeito de chegar no resto.

   Devolve `true` só quando o painel de fato andou. No fim da rolagem ele
   devolve o gesto ao documento, senão parar no último combo prenderia a
   página inteira embaixo do cursor.

   Na tela cheia esta função não faz nada: lá o painel mora numa coluna, pega
   o ponteiro e rola pela barra como qualquer texto. */
export function rolarPainel(quanto){
  const painel = $("gf-detalhe");
  if (!painel.classList.contains("mostra") || !painelFlutua()) return false;
  const corpo = $("gf-detalhe-corpo");
  const fim = corpo.scrollHeight - corpo.clientHeight;
  if (fim <= 0) return false;
  const antes = corpo.scrollTop;
  corpo.scrollTop = Math.max(0, Math.min(fim, antes + quanto));
  marcarSobra();
  return corpo.scrollTop !== antes;
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

  // O modo é do CSS, mas a franja e a barra escondida precisam dele como
  // classe: `painelFlutua` lê a posição calculada, e seletor nenhum pergunta
  // isso. `body.gf-cheia` não serve no lugar — a tela cheia só vira coluna
  // acima de certa largura, e abaixo dela o painel continua flutuando.
  const flutua = painelFlutua();
  painel.classList.toggle("flutua", flutua);
  if (flutua){
    const mesa = $("gf-mesa").getBoundingClientRect();
    painel.style.left = Math.max(8, mesa.left - PAINEL_LARGO - PAINEL_VAO) + "px";
  } else {
    painel.style.left = "";
  }
  painel.classList.add("mostra");
  // Depois de `mostra`: painel escondido não tem altura, e a medida da sobra
  // sairia zero.
  marcarSobra();

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
  if (!agora) return;
  // A rolagem sobrevive à segunda pintura. Trocar o `innerHTML` zera o
  // `scrollTop`, e quem já tinha descido até os combos enquanto a Scryfall
  // respondia voltaria ao topo sozinho, sem nada na tela explicando por quê.
  const corpo = $("gf-detalhe-corpo");
  const onde = corpo.scrollTop;
  corpo.innerHTML = painelDaCartaHTML(agora, d);
  corpo.scrollTop = onde;
  marcarSobra();
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
  return `<span class="gf-resumo">
    <span><b>${r.terrenos}</b> terreno(s)</span>
    ${r.feiticos ? `<span title="Média de custo do que não é terreno"><b>${
      r.custoMedio.toFixed(1).replace(".", ",")}</b> de custo médio</span>` : ""}
    ${pips ? `<span class="gf-cores" title="Símbolos de cor que a mão pede"
      >${pips}</span>` : ""}
  </span>`;
}

/* ------------------------------------------------------------- as áreas */

/* Uma área da mesa: título com a contagem, e o corpo. A área inteira é alvo
   de soltar — soltar em qualquer ponto dela, e não só em cima de outra carta,
   é o que deixa a área vazia receber a primeira. */
function areaHTML(titulo, corpo, zona, ij, classe){
  return `<div class="gf-area-mesa ${classe}" data-gf-solta="${zona}" data-gf-j="${ij}">
    <div class="gf-area-titulo">${titulo}</div>
    <div class="gf-area-corpo">${corpo}</div>
  </div>`;
}

function contaHTML(nome, n){
  return `${nome} <b>${n}</b>`;
}

function vazioHTML(texto){
  return `<div class="gf-vazio">${escapar(texto)}</div>`;
}

/* Criaturas de um lado, o resto do outro: quem olha um tabuleiro procura uma
   coisa de cada vez ("tenho bicho pra atacar?"), e misturadas cada pergunta
   vira busca visual. Lado a lado, e não empilhadas, pra o campo ter a altura
   de uma carta só. Cada lado cresce na proporção das cartas que tem, e as
   criaturas ficam à esquerda nos dois jogadores: com a mesa espelhada, as de
   um ficam em cima das do outro. A ordem dentro de cada lado é a que a pessoa
   arrumou (ver `reposicionar`). */
function campoDeBatalhaHTML(j, ij){
  const lado = (nome, lista, vazio) => `<div class="gf-lado"
      style="flex-grow:${Math.max(1, lista.length)}">
      <div class="gf-area-titulo">${contaHTML(nome, lista.length)}</div>
      <div class="gf-area-corpo">${
        lista.length ? cartasHTML(lista, "campo") : vazioHTML(vazio)}</div>
    </div>`;
  const criaturas = j.campo.filter(c => grupoDoCampo(c) === "Criaturas");
  const outras = j.campo.filter(c => grupoDoCampo(c) === "Outros");
  return `<div class="gf-area-mesa gf-batalha" data-gf-solta="campo" data-gf-j="${ij}">
    ${lado("Criaturas", criaturas, "nenhuma criatura")}
    ${lado("Outros", outras, "nada mais em jogo")}
  </div>`;
}

/* Terrenos iguais viram um MONTE: as cartas sobrepostas, cada uma mostrando
   uma tira, e a quantidade no canto. Oito Florestas em fila são uma segunda
   fileira da mesa; num monte, a largura de uma carta e pouco. Igual quer
   dizer mesmo nome E mesmo estado — deitar uma Floresta a tira do monte das
   em pé e a põe no das deitadas, que é a pergunta que se faz ao terreno
   ("quantas ainda posso usar?"). Cada carta continua sendo o seu botão: o
   menu, o arrastar e o painel não sabem que o monte existe. O monte fica no
   lugar da primeira carta dele, na ordem que a pessoa arrumou. */
function montesHTML(terrenos){
  const montes = new Map();
  for (const c of terrenos){
    const chave = [nomeDaCarta(c), c.deitada, c.virada, c.verso, c.ficha,
                   c.atacando, c.bloqueando, JSON.stringify(c.marcas)].join("|");
    if (!montes.has(chave)) montes.set(chave, []);
    montes.get(chave).push(c);
  }
  return `<div class="gf-fila">${[...montes.values()].map(monte => monte.length === 1
    ? gfCartaHTML(monte[0], "campo")
    : `<div class="gf-monte">${monte.map(c => gfCartaHTML(c, "campo")).join("")
      }<span class="gf-monte-n" aria-hidden="true">×${monte.length}</span></div>`
  ).join("")}</div>`;
}

/* Terreno-criatura mora aqui, e pela mesma razão de `CATEGORIAS`: a primeira
   regra que casa ganha, e pra quem joga ele é o terreno que entrou no turno. */
function terrenosHTML(j, ij){
  const terrenos = j.campo.filter(c => grupoDoCampo(c) === "Terrenos");
  const corpo = terrenos.length ? montesHTML(terrenos) : vazioHTML("nenhum terreno");
  return areaHTML(contaHTML("Terrenos", terrenos.length), corpo, "campo", ij, "gf-terrenos");
}

/* O comando fica ao lado dos terrenos porque é de onde se lança o comandante.
   O imposto é INFORMAÇÃO: quanto a próxima vez custaria, sem cobrar nada. */
function comandoHTML(j, ij){
  const imposto = j.impostoPago
    ? ` <span class="gf-imposto" title="Custo a mais na próxima vez">+${
        j.impostoPago * 2}</span>` : "";
  return areaHTML(contaHTML("Comando", j.comando.length) + imposto,
    j.comando.length ? cartasHTML(j.comando, "comando") : vazioHTML("vazia"),
    "comando", ij, "gf-comando");
}

/* Baralho, cemitério e exílio são PILHAS: uma carta de largura, e o clique
   abre a zona inteira em vez de agir sobre a carta de cima. A de cima aparece
   (com o painel no hover e o arrastar, pra puxar de volta a última que caiu);
   o baralho aparece de costas, como na mesa. */
function pilhaHTML(j, ij, zona, titulo, acao, rotulo){
  const lista = j[zona];
  const topo = zona === "baralho" ? null : lista[0];
  const arte = topo && !topo.virada ? arteNaMesa(topo) : "";
  const classes = ["gf-pilha"];
  if (!lista.length) classes.push("vazia");
  else if (!arte) classes.push("verso");
  const botao = `<button class="${classes.join(" ")}" data-gf-acao="${acao}"
    title="${escapar(rotulo)}" aria-label="${escapar(rotulo)}"
    ${topo ? `data-gf-uid="${topo.uid}" draggable="true"` : ""}
    ${arte ? `style="background-image:url('${escapar(arte)}')"` : ""}
    >${lista.length ? "" : "vazio"}</button>`;
  return areaHTML(titulo, botao, zona, ij, `gf-pilha-area gf-${zona}`);
}

function baralhoHTML(j, ij, naVez){
  // A tecla D compra pra quem está na vez: é nesse baralho que ela aparece.
  const tecla = naVez ? ` <kbd title="Comprar">D</kbd>` : "";
  return pilhaHTML(j, ij, "baralho", contaHTML("Deck", j.baralho.length) + tecla,
    `deck:${ij}`, "Comprar ou buscar no deck");
}

/* A mão com o resumo no título: é o que se lê antes de decidir manter, e na
   linha do título ele não rouba altura da mesa. No mulligan, a escolha fica
   dentro da própria mão, em cima das cartas que ela julga. */
function maoHTML(j, ij){
  const mulligan = j.fase === "jogo" ? "" : `<div class="gf-mulligan">${controlesDoMulliganHTML(j, ij)}</div>`;
  return areaHTML(contaHTML("Mão", j.mao.length) + resumoHTML(j.mao),
    mulligan + (j.mao.length ? cartasHTML(j.mao, "mao") : vazioHTML("mão vazia")),
    "mao", ij, "gf-area-mao");
}

/* Duas linhas numa grade de três colunas: comando, terrenos e exílio; deck,
   mão e cemitério. A grade é compartilhada pra as pilhas ficarem uma em cima
   da outra. No espelho, a linha da mão vai pra borda, como a do outro. */
function zonasHTML(j, ij, mesa, espelhado){
  const naVez = mesa.ativo === ij;
  const terrenos = comandoHTML(j, ij) + terrenosHTML(j, ij) +
    pilhaHTML(j, ij, "exilio", contaHTML("Exílio", j.exilio.length),
              `buscar:${ij}:exilio`, "Ver o exílio");
  const mao = baralhoHTML(j, ij, naVez) + maoHTML(j, ij) +
    pilhaHTML(j, ij, "cemiterio", contaHTML("Cemitério", j.cemiterio.length),
              `buscar:${ij}:cemiterio`, "Ver o cemitério");
  return `<div class="gf-zonas">${espelhado ? mao + terrenos : terrenos + mao}</div>`;
}

/* ------------------------------------------------- a barra de cada jogador */

/* Shift no clique anda de 5 em 5 (ver `fazerAcao`). */
function passoHTML(acao, rotulo, texto){
  return `<button class="gf-passo" data-gf-acao="${acao}" aria-label="${escapar(rotulo)}"
    title="${escapar(rotulo)} (Shift: 5)">${texto}</button>`;
}

function vidaHTML(j, ij){
  return `<span class="gf-vida">Vida
    ${passoHTML(`vida:${ij}:-1`, "Menos 1 de vida", "−")}
    <b>${j.vida}</b>
    ${passoHTML(`vida:${ij}:1`, "Mais 1 de vida", "+")}
  </span>`;
}

function marcasDoJogadorHTML(j, ij){
  return Object.keys(j.marcas).map(nome => `<span class="gf-marca">
    ${escapar(nome)}
    <button class="gf-passo" data-gf-acao="marca:${ij}:${nome}:-1"
      aria-label="Menos 1 de ${escapar(nome)}">−</button>
    <b>${j.marcas[nome]}</b>
    <button class="gf-passo" data-gf-acao="marca:${ij}:${nome}:1"
      aria-label="Mais 1 de ${escapar(nome)}">+</button>
  </span>`).join("");
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

/* Fatos do tabuleiro, não conta de mana: quantos terrenos estão em pé e
   quantos deitados. Ver o cabeçalho de `goldfish.js`. Os três ficam sempre,
   mesmo em zero, pra barra não mudar de largura a cada terreno. */
function terrenosDaBarraHTML(j){
  const terrenos = j.campo.filter(c => ehTerreno(c.carta));
  const emPe = terrenos.filter(c => !c.deitada).length;
  const deitados = terrenos.length - emPe;
  return `<span class="gf-fatos-j">Terrenos <b>${emPe}</b> em pé ·
    <b>${deitados}</b> ${deitados === 1 ? "deitado" : "deitados"}
    <span title="Terrenos baixados neste turno">· Baixados <b>${j.terrenosBaixados}</b></span></span>`;
}

/* A barra fica na borda de fora de cada jogador: embaixo de quem está
   embaixo e em cima de quem está em cima. À esquerda quem é e como está; à
   direita o que se cria na mesa. */
function barraHTML(j, ij, mesa){
  const vez = mesa.jogadores.length > 1 && mesa.ativo === ij
    ? `<span class="gf-vez">sua vez</span>` : "";
  return `<div class="gf-barra">
    <b class="gf-nome-j" title="${escapar(j.nome)}">${escapar(j.nome)}</b>${vez}
    ${vidaHTML(j, ij)}${danoHTML(j, ij, mesa)}${marcasDoJogadorHTML(j, ij)}
    <span class="gf-divisor" aria-hidden="true"></span>
    ${terrenosDaBarraHTML(j)}
    <span class="gf-espaco"></span>
    <button class="gf-botao" data-gf-acao="ficha:${ij}">Criar ficha</button>
    <button class="gf-botao" data-gf-acao="novaMarca:${ij}"
      title="Pôr um marcador neste jogador">Marcador</button>
  </div>`;
}

/* ------------------------------------------------- a escolha do mulligan */

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

function controlesDoMulliganHTML(j, ij){
  return notaDoMulliganHTML(j, ij) + (j.fase === "fundo" ? "" : `<div class="gf-acoes">
      <button class="btn ouro" data-gf-acao="manter:${ij}">Manter esta mão</button>
      <button class="btn" data-gf-acao="mulligan:${ij}">Mulligan</button>
    </div>`);
}

/* De cima pra baixo, quem está embaixo: campo de batalha, as duas linhas de
   zonas e a barra. Quem está em cima tem a mesma ordem de baixo pra cima. */
function jogadorHTML(j, ij, mesa, espelhado){
  const partes = [campoDeBatalhaHTML(j, ij), zonasHTML(j, ij, mesa, espelhado),
                  barraHTML(j, ij, mesa)];
  if (espelhado) partes.reverse();
  const ativo = mesa.jogadores.length > 1 && mesa.ativo === ij;
  return `<section class="gf-jogador${ativo ? " ativo" : ""}${
    espelhado ? " espelhado" : ""}" data-gf-j="${ij}">${partes.join("")}</section>`;
}

/* ---------------------------------------------------------------- log */

/* O log fica fechado, e aberto continua aberto: ele é conferência depois do
   fato ("em que turno eu baixei aquilo?"), não o assunto da tela — por isso
   mora na coluna do painel, e não embaixo da mesa. O estado de aberto mora na
   mesa porque o desenho reescreve o HTML a cada clique, e um `open` nascido do
   HTML fecharia sozinho a cada jogada. */
function logHTML(m){
  if (!m.log.length) return "";
  const linhas = m.log.slice().reverse().map(l =>
    `<li><span class="gf-log-t">T${l.turno}</span> ${escapar(l.texto)}</li>`).join("");
  return `<button class="gf-log-cabeca" aria-expanded="${m.logAberto}"
      >${m.logAberto ? "▾" : "▸"} Log da partida <b>${m.log.length}</b></button>
    ${m.logAberto ? `<ol class="gf-log-lista">${linhas}</ol>` : ""}`;
}

/* ------------------------------------------------ a nota dos combos */

/* Uma linha só sobre os combos, na coluna. O selo da carta é silencioso, e
   silêncio não distingue "este deck não tem combo" de "ninguém procurou" —
   são opostos que se parecem numa mesa sem marca nenhuma.

   Ela mora aqui, e não no painel de cada carta, porque é uma frase sobre a
   MESA: repetida em cada carta que se olha, viraria aviso que se aprende a
   não ler. */
function notaDeCombosHTML(m){
  if (!estado.combos){
    return `A mesa marca as peças de combo nas cartas — procure os combos do
      deck na aba <b>Combos</b> pra ligar as marcas.`;
  }
  const n = (estado.combos.no_deck || []).length;
  // As duas ressalvas são sobre o que a marcação NÃO cobre, e nenhuma delas
  // dá pra deduzir olhando a mesa: um deck editado depois da busca e o
  // segundo deck, que entrou pelo id e nunca foi perguntado.
  const ressalvas = [];
  if (estado.combosAssinatura !== assinaturaDoDeck()){
    ressalvas.push("o deck mudou desde a busca");
  }
  if (m.jogadores.length > 1) ressalvas.push("o segundo deck não foi perguntado");
  return (n
    ? `<b>${n}</b> combo(s) do deck — as peças estão marcadas nas cartas.`
    : `O Spellbook não achou combo fechado neste deck.`)
    + (ressalvas.length ? ` ${ressalvas.join("; ")}.` : "");
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
  $("gf-passar").disabled = !m;
  $("gf-fim-combate").hidden = !(m && (atacantes().length ||
    m.jogadores.some(j => j.campo.some(c => c.bloqueando))));
  if (!m){
    $("gf-turno").textContent = "";
    $("gf-log").innerHTML = "";
    $("gf-nota-combos").innerHTML = "";
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
    `<div class="gf-jogadores${dois ? " dois" : ""}">${ordem.map(ij =>
      jogadorHTML(m.jogadores[ij], ij, m, dois && ij === 1)).join("")}</div>`;
  $("gf-log").innerHTML = logHTML(m);
  $("gf-nota-combos").innerHTML = notaDeCombosHTML(m);
  atualizarPainel();
}
