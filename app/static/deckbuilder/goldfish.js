/* =========================================================================
   GOLDFISH — as regras da mesa

   Embaralhar o deck e jogar sozinho, pra ver se a mão anda. É o que "goldfish"
   quer dizer na mesa: jogar contra um peixinho dourado, que não faz nada. Com
   um segundo deck posto na mesa, o peixinho ganha cartas — e continua sendo
   você dos dois lados.

   NÃO É MOTOR DE REGRAS, E ISSO É O RECURSO. Nada aqui impede nada: dá pra
   baixar dois terrenos no mesmo turno, jogar uma carta de 8 manas no turno 1 e
   mandar qualquer coisa pra qualquer zona. Quem julga é quem está jogando.
   A alternativa — validar custo, tipo e timing — é escrever um motor de Magic,
   que é um projeto inteiro, e que erraria em casos que a pessoa conhece melhor
   do que ele.

   Cinco consequências desenhadas de propósito:

   * A MANA NÃO É SOMADA. A tela mostra quantos terrenos estão em pé e quantos
     deitados, que é um fato do tabuleiro. No instante em que aparecesse "3 de
     mana disponível", a pessoa passaria a esperar que o número a impedisse de
     fazer coisa errada — e aí é motor de regras pela porta dos fundos.
   * O "terreno baixado neste turno" CONTA, não impede. Vira informação, não
     trava.
   * A VIDA E OS MARCADORES SÃO NÚMEROS QUE SE AJUSTAM, não contas. Ninguém
     aqui sabe quanto uma criatura bate.
   * O COMBATE É UMA MARCAÇÃO. Atacante e bloqueador ficam desenhados na carta;
     o dano quem aplica é quem joga, nos botões de vida.
   * O COMANDANTE VAI PRA ZONA DE COMANDO, não pro baralho. Sem isso o goldfish
     estaria testando um deck de 99 cartas que ninguém joga. O imposto aparece
     como número; pagar ou não é decisão de quem joga.

   O que ele SABE são as regras do formato que mudam a mão: o primeiro mulligan
   é grátis e quem começa jogando compra no turno 1.

   OS JOGADORES SÃO UMA LISTA, de um ou de dois. Mesmo com um só: um jogador
   solto mais um "segundo" opcional faria toda ação existir em duas versões, e
   é justamente aí que uma delas deixa de acompanhar a outra.

   CADA CARTA TEM DONO, e toda zona é do dono. Matar a criatura do outro manda
   ela pro cemitério DELE, que é o que acontece na mesa — e é o que faz a lista
   de zonas continuar fechando por jogador.

   NADA DISSO É SALVO. `corpoDoDeck` não sabe que `estado.mesa` existe: uma mão
   de goldfish gravada no deck é uma mão que volta três semanas depois, em outra
   máquina, no meio de uma edição.
   ========================================================================= */

import {CATEGORIAS_FORA_DA_CONTA, CORES, estado} from "./estado.js";
import {cartasContadas} from "./utilidades.js";

const MAO_INICIAL = 7;
const VIDA_INICIAL = 40;
const TETO_DESFAZER = 20;
const TETO_LOG = 200;

/* As zonas de um jogador. A ordem é a da varredura, e ela não é arbitrária: a
   mão e o campo vêm antes porque são onde quase toda carta procurada está. */
const GF_ZONAS = ["mao", "campo", "baralho", "cemiterio", "exilio", "comando"];
export const NOME_DA_ZONA = {
  baralho: "Baralho", mao: "Mão", campo: "Campo",
  cemiterio: "Cemitério", exilio: "Exílio", comando: "Comando",
};

/* Os marcadores que a tela oferece de cara. O resto entra pelo campo "outro":
   marcador de Magic é lista aberta, e uma lista fechada aqui viraria uma
   corrida atrás de cada carta nova que inventa um. */
export const MARCAS_DE_CARTA = ["+1/+1", "-1/-1", "lealdade"];
export const MARCAS_DE_JOGADOR = ["veneno", "energia", "experiência"];

/* Cada carta na mesa é uma CÓPIA com identidade própria (`uid`), e não a
   entrada do deck. Três Florestas são três objetos: uma pode estar deitada e as
   outras não, e uma pode estar no cemitério enquanto as outras jogam. Copiar a
   referência da entrada faria deitar uma deitar as trinta — é o bug clássico
   deste tipo de tela. */
let gfProximoUid = 1;

/* A carta em si mora AQUI, fora da mesa, porque ela nunca muda: o que muda é o
   estado da cópia (deitada, virada, marcas, zona). Isso deixa a fotografia do
   desfazer pequena — uma mesa de dois decks tem 200 cartas completas, e
   guardar as vinte últimas jogadas com elas dentro é alguns megabytes de JSON
   reescritos a cada clique. */
const gfCartas = new Map();

function gfCopia(carta, dono, extra){
  const c = {
    uid: gfProximoUid++, dono, carta, virada: false, deitada: false,
    marcas: {}, atacando: false, bloqueando: null, ficha: false, cmd: false,
    ...(extra || {}),
  };
  gfCartas.set(c.uid, carta);
  return c;
}

export function nomeDaCarta(c){
  return ((c && c.carta && c.carta.nome) || "carta");
}

/* ------------------------------------------------------------- o baralho */

/* Um deck pra mesa: nome, comandantes e entradas `{carta, quantidade}`. O da
   tela sai de `cartasContadas()`, a mesma função do contador, da curva e da
   assinatura de cotação — sideboard e maybeboard ficam de fora aqui pelo mesmo
   motivo que ficam lá. Usar outra regra faria a mesa discordar do resto da
   tela sobre o que é o deck. */
export function deckDaTela(){
  return {
    nome: estado.nome || "Este deck",
    comandantes: estado.comandantes.filter(Boolean),
    entradas: cartasContadas(),
  };
}

/* O mesmo formato, vindo de `GET /decks/{id}`: é como o segundo deck entra. A
   regra do que conta é a do servidor e a da tela ao mesmo tempo — as
   categorias fora da conta são as mesmas dos dois lados. */
export function deckDaResposta(resposta){
  const deck = resposta.deck || {};
  return {
    nome: deck.nome || "Segundo deck",
    comandantes: (deck.comandantes_completos || []).filter(Boolean),
    entradas: (deck.cartas_completas || []).filter(
      e => e.carta && !CATEGORIAS_FORA_DA_CONTA.has(e.categoria || "")),
  };
}

function baralhoDoDeck(deck, dono){
  const comandantes = new Set(deck.comandantes.map(c => (c.nome || "").toLowerCase()));
  const fora = [];
  for (const entrada of deck.entradas){
    const c = entrada.carta;
    if (!c) continue;                       // carta que a base não conhece
    if (comandantes.has((c.nome || "").toLowerCase())) continue;
    for (let i = 0; i < entrada.quantidade; i++) fora.push(gfCopia(c, dono));
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

export function embaralharBaralho(ij){
  const j = estado.mesa.jogadores[ij];
  embaralhar(j.baralho);
  registrar(`${j.nome}: baralho reembaralhado`);
}

/* --------------------------------------------------------------- a mesa */

function novoJogador(deck, indice){
  return {
    nome: deck.nome, indice,
    baralho: embaralhar(baralhoDoDeck(deck, indice)),
    mao: [], campo: [], cemiterio: [], exilio: [],
    comando: deck.comandantes.map(c => gfCopia(c, indice, {cmd: true})),
    vida: VIDA_INICIAL,
    marcas: {},        // veneno, energia, experiência e o que mais for criado
    danoCmd: [0, 0],   // dano de comandante recebido, por jogador de origem
    mulligans: 0, aFundo: 0, fase: "mulligan",
    terrenosBaixados: 0, impostoPago: 0,
    turnoDoComandante: null,   // pro resumo do fim
    jogadas: [],               // o que desceu pro campo, pra curva realizada
  };
}

export function montarMesa(decks){
  gfProximoUid = 1;
  gfCartas.clear();
  estado.mesa = {
    jogadores: decks.map((d, i) => novoJogador(d, i)),
    ativo: 0, turno: 1, log: [], logAberto: false,
  };
  estado.mesaDesfazer = [];
  gfUltimoGesto = null;
  for (const j of estado.mesa.jogadores) comprarPara(j, MAO_INICIAL);
  registrar(decks.length > 1
    ? `Mesa embaralhada: ${decks.map(d => d.nome).join(" × ")}`
    : "Deck embaralhado");
}

/* O segundo deck entra na mesa que já está rolando, e não recomeça a partida:
   quem pede um oponente no meio de um goldfish quer ver a mão que está na tela
   contra alguma coisa, não jogar a mão fora. */
export function porSegundoDeck(deck){
  const m = estado.mesa;
  if (!m || m.jogadores.length > 1) return;
  const j = novoJogador(deck, m.jogadores.length);
  m.jogadores.push(j);
  comprarPara(j, MAO_INICIAL);
  registrar(`${j.nome} entrou na mesa`);
}

export function tirarSegundoDeck(){
  const m = estado.mesa;
  if (!m || m.jogadores.length < 2) return;
  const fora = m.jogadores.pop();
  m.ativo = 0;
  registrar(`${fora.nome} saiu da mesa`);
}

function jogadorAtivo(){
  return estado.mesa.jogadores[estado.mesa.ativo];
}

function comprarPara(j, n){
  for (let i = 0; i < n && j.baralho.length; i++) j.mao.push(j.baralho.shift());
}

export function comprar(ij, n){
  const j = estado.mesa.jogadores[ij];
  const antes = j.mao.length;
  comprarPara(j, n);
  const veio = j.mao.length - antes;
  if (veio) registrar(`${j.nome}: comprou ${veio}`);
  else registrar(`${j.nome}: baralho vazio, nada a comprar`);
}

/* ------------------------------------------------------------- mulligan */

/* Mulligan London, com o PRIMEIRO GRÁTIS — que é a regra do Commander.

   Sempre se compram 7 cartas novas; o que muda é quantas voltam pro fundo ao
   manter: `mulligans - 1`. O primeiro mulligan sai de graça e a mão fica com 7;
   o segundo devolve 1, o terceiro 2. Cobrar já a primeira seria testar um deck
   de 60, não um de Commander — que é o formato deste deckbuilder inteiro.

   Cada jogador tem o seu contador: dois decks na mesa são duas decisões
   independentes, e um contador compartilhado cobraria de um o mulligan do
   outro. */
function devolveAoManter(j){
  return Math.max(0, j.mulligans - 1);
}

export function devolveAoManterDe(ij){
  return devolveAoManter(estado.mesa.jogadores[ij]);
}

export function mulliganLondon(ij){
  const j = estado.mesa.jogadores[ij];
  j.mulligans++;
  j.baralho = embaralhar(j.baralho.concat(j.mao));
  j.mao = [];
  j.aFundo = 0;
  comprarPara(j, MAO_INICIAL);
  registrar(`${j.nome}: mulligan ${j.mulligans}`);
}

export function manterMao(ij){
  const j = estado.mesa.jogadores[ij];
  // Nunca mais do que a mão tem: pedir pra devolver 3 de uma mão de 2 deixaria
  // a fase de fundo sem como terminar, e a mesa travada numa escolha
  // impossível. Só acontece em deck pequeno, que é justamente onde se testa.
  j.aFundo = Math.min(devolveAoManter(j), j.mao.length);
  // Com zero a devolver a tela pula direto pro jogo: pedir "escolha 0 cartas"
  // é uma etapa que só existe pra ser fechada.
  if (j.aFundo) j.fase = "fundo";
  else confirmarMao(j);
}

export function mandarPraFundo(uid){
  const achado = acharCarta(uid);
  if (!achado) return;
  const j = achado.jogador;
  if (achado.zona !== "mao" || !j.aFundo) return;
  j.mao.splice(achado.indice, 1);
  j.baralho.push(achado.carta);              // fundo, na ordem escolhida
  j.aFundo--;
  if (!j.aFundo) confirmarMao(j);
}

/* A mão fechada — e com ela a COMPRA DO TURNO 1. No Commander quem começa
   jogando compra: é o duelo de dois que tira essa compra do primeiro jogador,
   e a mesa deste deckbuilder é multiplayer.

   Ela vem depois das cartas que voltam pro fundo, e é uma só: o que se
   devolve é a mão de sete que se viu, e a carta a mais é a do turno, não
   parte da escolha. Daí `passarTurno` comprar do turno 2 em diante. */
function confirmarMao(j){
  j.fase = "jogo";
  comprarPara(j, 1);
  registrar(`${j.nome}: manteve com ${j.mao.length} (a do turno 1 incluída)`);
}

/* --------------------------------------------------------------- turnos */

export function passarTurno(){
  const m = estado.mesa;
  m.ativo = (m.ativo + 1) % m.jogadores.length;
  // O número do turno anda quando a vez volta pro primeiro: com um jogador é
  // todo "passar turno", com dois é a rodada inteira.
  if (m.ativo === 0) m.turno++;
  limparCombate();
  const j = jogadorAtivo();
  j.terrenosBaixados = 0;
  // Endireita tudo de quem está jogando, como o desendireitar de verdade.
  for (const c of j.campo) c.deitada = false;
  registrar(`— turno ${m.turno}, vez de ${j.nome}`);
  // A compra do turno 1 saiu na confirmação da mão; daqui pra frente é uma
  // por turno.
  comprarPara(j, 1);
}

/* ---------------------------------------------------------------- zonas */

function acharCarta(uid){
  for (const j of estado.mesa.jogadores){
    for (const zona of GF_ZONAS){
      const i = j[zona].findIndex(c => c.uid === uid);
      if (i >= 0) return {jogador: j, zona, indice: i, carta: j[zona][i]};
    }
  }
  return null;
}

export function cartaPorUid(uid){
  const achado = estado.mesa && acharCarta(uid);
  return achado ? achado.carta : null;
}

export function zonaDaCarta(uid){
  const achado = estado.mesa && acharCarta(uid);
  return achado ? achado.zona : null;
}

/* A ÚNICA mutação de zona. Tudo passa por aqui pra o invariante "cada uid
   existe em exatamente uma zona de um jogador" ter um lugar só onde pode
   quebrar.

   `gfMover` e não `mover` porque JÁ EXISTE um `mover(nome, de, para)` nesta
   página — o que troca carta entre deck e maybeboard. Duas declarações de
   função com o mesmo nome não dão erro: a segunda simplesmente apaga a
   primeira no hoisting, e a mesa parava de mover carta sem nada na tela
   dizendo por quê. Foi o `tests/test_goldfish.py` que pegou. */
export function gfMover(uid, para, aoTopo){
  const m = estado.mesa;
  if (!m || GF_ZONAS.indexOf(para) < 0) return;
  const achado = acharCarta(uid);
  if (!achado) return;
  const {jogador, zona, indice, carta} = achado;
  if (zona === para && para !== "baralho") return;
  jogador[zona].splice(indice, 1);

  // Ficha que sai do campo SOME. Ela não existe fora dele, e um cemitério com
  // três Soldados mentiria sobre o que dá pra devolver de lá.
  if (carta.ficha && para !== "campo"){
    registrar(`${jogador.nome}: ${nomeDaCarta(carta)} (ficha) deixou de existir`);
    return;
  }

  // A carta vai pra zona do DONO dela, não de quem a moveu: matar a criatura
  // do outro manda ela pro cemitério dele.
  const dono = m.jogadores[carta.dono] || jogador;
  if (para === "campo" && zona !== "campo"){
    carta.deitada = false;   // entra em pé
    if (ehTerreno(carta.carta)) dono.terrenosBaixados++;
    dono.jogadas.push({nome: nomeDaCarta(carta), cmc: (carta.carta || {}).cmc || 0,
                       terreno: ehTerreno(carta.carta), turno: m.turno});
    if (carta.cmd && dono.turnoDoComandante === null) dono.turnoDoComandante = m.turno;
  }
  if (para !== "campo"){
    carta.deitada = false; carta.marcas = {};
    carta.atacando = false; carta.bloqueando = null;
  }
  if (para === "baralho" && !aoTopo) dono.baralho.push(carta);
  else dono[para].unshift(carta);
  registrar(`${dono.nome}: ${nomeDaCarta(carta)} — ${NOME_DA_ZONA[zona]} → ${NOME_DA_ZONA[para]}`);
}

/* O comandante indo pro campo pela zona de comando: o imposto é INFORMAÇÃO. A
   tela conta quantas vezes ele saiu de lá e diz quanto custaria a próxima.
   Não cobra nada. */
export function lancarComandante(uid){
  const achado = acharCarta(uid);
  if (!achado) return;
  estado.mesa.jogadores[achado.carta.dono].impostoPago++;
  gfMover(uid, "campo");
}

export function ehTerreno(carta){
  return ehTipo(carta, "land");
}

function ehTipo(carta, tipo){
  return ((carta && carta.tipo) || "").toLowerCase().includes(tipo);
}

/* ------------------------------------------------- vida, marcas, combate */

export function ajustarVida(ij, n){
  const j = estado.mesa.jogadores[ij];
  j.vida += n;
  registrar(`${j.nome}: vida ${n > 0 ? "+" : ""}${n} (${j.vida})`);
}

/* Marcador de jogador (veneno, energia, experiência) mora no JOGADOR, e não
   numa carta: quem tem dez de veneno é a pessoa, não a criatura que a
   envenenou. Zero apaga a linha — uma lista de marcadores em zero é uma lista
   de coisas que não estão acontecendo. */
export function ajustarMarca(ij, nome, n){
  const j = estado.mesa.jogadores[ij];
  const valor = Math.max(0, (j.marcas[nome] || 0) + n);
  if (valor) j.marcas[nome] = valor; else delete j.marcas[nome];
  registrar(`${j.nome}: ${nome} ${valor}`);
}

export function ajustarMarcaCarta(uid, nome, n){
  const c = cartaPorUid(uid);
  if (!c) return;
  const valor = Math.max(0, (c.marcas[nome] || 0) + n);
  if (valor) c.marcas[nome] = valor; else delete c.marcas[nome];
  registrar(`${nomeDaCarta(c)}: ${nome} ${valor}`);
}

/* Dano de comandante é por ORIGEM: 21 do comandante de um não se soma aos 21
   do outro, e é essa separação que faz o número valer alguma coisa. */
export function ajustarDanoCmd(ij, de, n){
  const j = estado.mesa.jogadores[ij];
  j.danoCmd[de] = Math.max(0, (j.danoCmd[de] || 0) + n);
  registrar(`${j.nome}: dano de comandante ${j.danoCmd[de]}`);
}

export function alternarDeitada(uid){
  const c = cartaPorUid(uid);
  if (!c) return;
  c.deitada = !c.deitada;
  registrar(`${nomeDaCarta(c)}: ${c.deitada ? "deitada" : "endireitada"}`);
}

export function alternarVirada(uid){
  const c = cartaPorUid(uid);
  if (!c) return;
  c.virada = !c.virada;
  registrar(`${nomeDaCarta(c)}: ${c.virada ? "virada pra baixo" : "desvirada"}`);
}

export function alternarAtaque(uid){
  const c = cartaPorUid(uid);
  if (!c) return;
  c.atacando = !c.atacando;
  c.bloqueando = null;
  registrar(`${nomeDaCarta(c)}: ${c.atacando ? "ataca" : "não ataca mais"}`);
}

export function definirBloqueio(uid, alvo){
  const c = cartaPorUid(uid);
  if (!c) return;
  c.bloqueando = c.bloqueando === alvo ? null : alvo;
  c.atacando = false;
  const quem = c.bloqueando ? nomeDaCarta(cartaPorUid(alvo)) : "";
  registrar(`${nomeDaCarta(c)}: ${quem ? "bloqueia " + quem : "não bloqueia mais"}`);
}

export function limparCombate(){
  for (const j of estado.mesa.jogadores){
    for (const c of j.campo){ c.atacando = false; c.bloqueando = null; }
  }
}

export function atacantes(){
  const fora = [];
  for (const j of estado.mesa.jogadores){
    for (const c of j.campo) if (c.atacando) fora.push(c);
  }
  return fora;
}

/* ---------------------------------------------------------------- fichas */

/* A ficha é uma carta inventada na hora, com a mesma forma das outras pra o
   desenho, a prévia e a modal não precisarem saber que ela é diferente. O que
   a separa é `ficha`, e o efeito dele está no `gfMover`: fora do campo, ela
   deixa de existir. */
export function criarFicha(ij, modelo, quantas){
  const j = estado.mesa.jogadores[ij];
  const carta = {
    nome: modelo.nome || "Ficha",
    tipo: modelo.tipo || "Token Creature",
    identidade: (modelo.cores || []).join(""),
    mana_cost: "", cmc: 0,
    poder: modelo.poder || "", resistencia: modelo.resistencia || "",
    imagem: modelo.imagem || "", ficha: true,
  };
  const n = Math.max(1, Math.min(20, Number(quantas) || 1));
  for (let i = 0; i < n; i++) j.campo.unshift(gfCopia(carta, ij, {ficha: true}));
  registrar(`${j.nome}: criou ${n} × ${carta.nome}`);
}

/* ------------------------------------------------------------------- log */

function registrar(texto){
  const m = estado.mesa;
  if (!m) return;
  m.log.push({turno: m.turno, texto});
  if (m.log.length > TETO_LOG) m.log.shift();
}

/* --------------------------------------------------------------- resumo */

function curvaDe(cmcs){
  const faixas = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const cmc of cmcs) faixas[Math.min(7, Math.floor(cmc || 0))]++;
  return faixas;
}

/* O resumo do fim: em que turno o comandante desceu, o que a curva prometia
   contra o que a partida entregou, e o que ficou no baralho sem ser visto.

   A curva TEÓRICA sai das cartas do próprio jogador, achatadas de todas as
   zonas: a mesa conserva as cartas, então a soma das zonas é o deck inteiro,
   sem precisar guardar uma segunda cópia da lista. Terreno e comandante ficam
   de fora dos dois lados, como na curva da análise. */
export function resumoDaPartida(){
  const m = estado.mesa;
  return m.jogadores.map((j) => {
    const todas = GF_ZONAS.reduce((fora, z) => fora.concat(j[z]), [])
      .filter(c => !c.ficha && !c.cmd);
    const feiticos = todas.filter(c => !ehTerreno(c.carta));
    const jogadas = j.jogadas.filter(x => !x.terreno);
    return {
      nome: j.nome,
      vida: j.vida,
      turnoDoComandante: j.turnoDoComandante,
      terrenosJogados: j.jogadas.filter(x => x.terreno).length,
      teorica: curvaDe(feiticos.map(c => (c.carta || {}).cmc || 0)),
      realizada: curvaDe(jogadas.map(x => x.cmc)),
      feiticosJogados: jogadas.length,
      feiticosNoDeck: feiticos.length,
      naoPuxadas: j.baralho.length,
      restante: j.baralho.map(c => nomeDaCarta(c)).sort(),
    };
  });
}

/* ------------------------------------------------------- resumo da mão */

/* O resumo da mão, do lado das cartas: quantos terrenos, quanto custa em
   média o que não é terreno, e que cores ela pede. É a conta que se faz de
   cabeça a cada mulligan — sete cartas, três perguntas, toda vez — e é com
   ela que se decide manter.

   Duas escolhas acompanham o resto da tela. O custo médio IGNORA terreno,
   como a curva da análise: terreno custa zero e puxaria a média pra um número
   que não diz o que dá pra lançar. E as cores são o que a mão PEDE, lidas dos
   símbolos do custo, como a distribuição da análise — não o que ela produz. */
export function resumoDaMao(mao){
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

/* O campo em três filas: terrenos, criaturas e o resto. Quem olha um tabuleiro
   procura uma coisa de cada vez ("tenho mana? tenho bicho?"), e numa fila só
   de trinta cartas cada pergunta dessas vira busca visual.

   Terreno-criatura entra em Terrenos, e pela mesma razão de `CATEGORIAS`: a
   primeira regra que casa ganha, porque pra quem joga ele é o terreno que
   entrou no turno. */
export const GRUPOS_DO_CAMPO = [
  ["Terrenos",  (c) => ehTerreno(c.carta)],
  ["Criaturas", (c) => ehTipo(c.carta, "creature")],
  ["Outros",    () => true],
];

export function grupoDoCampo(c){
  return GRUPOS_DO_CAMPO.find(([, casa]) => casa(c))[0];
}

/* ------------------------------------------------------------- desfazer */

/* Desfazer por FOTOGRAFIA do estado, e não por operação inversa: num sistema
   sem regras, o inverso de uma jogada não é definido — mandar uma carta do
   cemitério pro campo não "desfaz" nada, é outra jogada.

   A foto sai sem as cartas (`carta` fica de fora do JSON e volta pelo
   registro, na revelação): sem isso cada clique reescreveria a base de cartas
   inteira da mesa. */
let gfUltimoGesto = null;

/* Gesto repetido é UM passo de desfazer: baixar a vida de 40 pra 33 são sete
   cliques, e sem isto eles comeriam sete das vinte fotos — o Ctrl+Z seguinte
   devolveria 34, 35, 36… em vez da jogada que veio antes. Qualquer outra ação
   fecha a sequência, porque ela guarda sem nome. */
export function guardarMesa(gesto){
  if (!estado.mesa) return;
  if (gesto && gesto === gfUltimoGesto) return;
  gfUltimoGesto = gesto || null;
  estado.mesaDesfazer.push(JSON.stringify(estado.mesa,
    (chave, valor) => chave === "carta" ? undefined : valor));
  if (estado.mesaDesfazer.length > TETO_DESFAZER) estado.mesaDesfazer.shift();
}

export function desfazerUmPasso(){
  const foto = estado.mesaDesfazer.pop();
  if (!foto) return false;
  const mesa = JSON.parse(foto);
  for (const j of mesa.jogadores){
    for (const zona of GF_ZONAS){
      for (const c of j[zona]) c.carta = gfCartas.get(c.uid) || null;
    }
  }
  estado.mesa = mesa;
  gfUltimoGesto = null;
  return true;
}
