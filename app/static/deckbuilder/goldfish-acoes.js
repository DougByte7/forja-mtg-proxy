/* ------------------------------------------- o que se faz com a mesa

   Os cliques, o menu de cada carta, o arrastar e as quatro modais (buscar
   numa zona, criar ficha, pôr o segundo deck, ver o resumo do fim). Tudo o
   que muda a mesa passa por `guardarMesa()` antes — é o que faz o Ctrl+Z
   valer pra qualquer jogada, e não só pras que alguém lembrou de tratar.

   O menu da carta oferece TUDO de qualquer zona, de propósito, inclusive o
   que numa partida de verdade seria absurdo: aqui não tem juiz. */

import {$, escapar} from "../comum/dom.js";
import {abrirCarta} from "./carta.js";
import {estado} from "./estado.js";
import {ajustarDanoCmd, ajustarMarca, ajustarMarcaCarta, ajustarVida,
        alternarAtaque, alternarDeitada, alternarVirada, atacantes, cartaPorUid,
        comprar, criarFicha, deckDaResposta, deckDaTela, definirBloqueio,
        desfazerUmPasso, embaralharBaralho, gfMover, guardarMesa,
        lancarComandante, limparCombate, mandarPraFundo, manterMao,
        MARCAS_DE_CARTA, MARCAS_DE_JOGADOR, montarMesa, mulliganLondon,
        nomeDaCarta, NOME_DA_ZONA, passarTurno, porSegundoDeck,
        resumoDaPartida, tirarSegundoDeck, zonaDaCarta} from "./goldfish.js";
import {desenharMesa} from "./goldfish-desenho.js";
import {api, lidos} from "./salvar.js";
import {fichasDoDeck, rotuloDaFicha} from "./tokens.js";
import {cartasContadas, toast} from "./utilidades.js";

export function desfazerMesa(){
  if (desfazerUmPasso()) desenharMesa();
}

/* ------------------------------------------------------ menu de uma carta */

function fecharMenuGf(){
  const m = document.querySelector(".gf-menu");
  if (m) m.remove();
}

function posicionar(el, x, y){
  // Não deixa sair da tela por baixo nem pela direita.
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
}

/* O menu é montado numa lista de ações com índice: o HTML guarda o número e o
   clique procura a função. Item com `fica` não fecha o menu — ele é redesenhado
   no mesmo lugar, com o número novo, que é o que faz clicar três vezes em
   "+1/+1" ser um gesto só em vez de três aberturas de menu. */
function abrirMenuDaCarta(uid, x, y){
  fecharMenuGf();
  const c = cartaPorUid(uid);
  const zona = zonaDaCarta(uid);
  if (!c) return;
  const acoes = [];
  const item = (rotulo, fn, extra) => {
    acoes.push({fn, ...(extra || {})});
    return `<button data-gf-item="${acoes.length - 1}">${escapar(rotulo)}</button>`;
  };
  let html = "";

  if (zona === "campo"){
    html += item(c.deitada ? "Endireitar" : "Deitar", () => alternarDeitada(uid));
    html += item(c.atacando ? "Não atacar" : "Atacar", () => alternarAtaque(uid));
    const inimigos = atacantes().filter(a => a.dono !== c.dono);
    if (inimigos.length){
      html += `<div class="gf-menu-titulo">Bloquear</div>`;
      for (const a of inimigos){
        html += item((c.bloqueando === a.uid ? "✓ " : "") + nomeDaCarta(a),
                     () => definirBloqueio(uid, a.uid));
      }
    }
    html += `<div class="gf-menu-titulo">Marcadores</div>`;
    const nomes = MARCAS_DE_CARTA.concat(
      Object.keys(c.marcas).filter(n => !MARCAS_DE_CARTA.includes(n)));
    for (const nome of nomes){
      const menos = item("−", () => ajustarMarcaCarta(uid, nome, -1),
                         {fica: true, gesto: `m${uid}${nome}`});
      const mais = item("+", () => ajustarMarcaCarta(uid, nome, 1),
                        {fica: true, gesto: `m${uid}${nome}`});
      html += `<div class="gf-linha"><span>${escapar(nome)}</span>
        ${menos}<b>${c.marcas[nome] || 0}</b>${mais}</div>`;
    }
    html += item("Outro marcador…", () => {
      const nome = (prompt("Nome do marcador (ex.: veneno, tempo, munição):") || "")
        .replace(/:/g, "").trim();
      if (nome) ajustarMarcaCarta(uid, nome, 1);
    }, {fica: true});
  }

  html += `<div class="gf-menu-titulo">Mandar pra</div>`;
  if (zona === "comando"){
    // O imposto é INFORMAÇÃO: a tela conta quantas vezes o comandante saiu da
    // zona e diz quanto custaria a próxima. Não cobra nada.
    html += item("Campo (paga imposto)", () => lancarComandante(uid));
  } else if (zona !== "campo"){
    html += item("Campo", () => gfMover(uid, "campo"));
  }
  for (const z of ["mao", "cemiterio", "exilio", "comando"]){
    if (z === zona) continue;
    if (z === "comando" && !c.cmd) continue;   // só comandante volta pro comando
    html += item(NOME_DA_ZONA[z], () => gfMover(uid, z));
  }
  if (zona !== "baralho"){
    html += item("Topo do baralho", () => gfMover(uid, "baralho", true));
    html += item("Fundo do baralho", () => gfMover(uid, "baralho", false));
  }
  html += `<div class="gf-menu-titulo">Esta carta</div>`;
  html += item(c.virada ? "Desvirar" : "Virar pra baixo", () => alternarVirada(uid));
  if (!c.ficha) html += item("Ver a carta", () => abrirCarta(c.carta), {sem: true});

  const menu = document.createElement("div");
  menu.className = "gf-menu";
  menu.innerHTML = html;
  document.body.appendChild(menu);
  posicionar(menu, x, y);
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-gf-item]");
    if (!b) return;
    const acao = acoes[Number(b.dataset.gfItem)];
    if (!acao.sem) guardarMesa(acao.gesto);
    acao.fn();
    fecharMenuGf();
    desenharMesa();
    if (acao.fica) abrirMenuDaCarta(uid, x, y);
  });
}

/* Menu de marcador do JOGADOR: veneno, energia e experiência são os três que
   o formato usa; o resto entra pelo nome. */
function abrirMenuDeMarca(ij, x, y){
  fecharMenuGf();
  const menu = document.createElement("div");
  menu.className = "gf-menu";
  const nomes = MARCAS_DE_JOGADOR.concat("outro…");
  menu.innerHTML = nomes.map((n, i) =>
    `<button data-gf-item="${i}">${escapar(n)}</button>`).join("");
  document.body.appendChild(menu);
  posicionar(menu, x, y);
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-gf-item]");
    if (!b) return;
    let nome = nomes[Number(b.dataset.gfItem)];
    if (nome === "outro…"){
      nome = (prompt("Nome do marcador:") || "").replace(/:/g, "").trim();
    }
    fecharMenuGf();
    if (!nome) return;
    guardarMesa();
    ajustarMarca(ij, nome, 1);
    desenharMesa();
  });
}

/* ----------------------------------------------------------------- modais */

let modalGf = null;

export function modalGfAberto(){ return !!modalGf; }

export function fecharModalGf(){
  if (!modalGf) return;
  const aoFechar = modalGf.aoFechar;
  modalGf.el.remove();
  modalGf = null;
  if (aoFechar) aoFechar();
}

function abrirModalGf(titulo, corpo, ligar, aoFechar){
  fecharModalGf();
  const el = document.createElement("div");
  el.className = "gf-modal-fundo";
  el.innerHTML = `<div class="gf-modal" role="dialog" aria-modal="true"
      aria-label="${escapar(titulo)}">
    <div class="gf-modal-topo">
      <h3>${escapar(titulo)}</h3>
      <span class="gf-espaco"></span>
      <button class="mini sai" data-gf-fechar title="Fechar" aria-label="Fechar">✕</button>
    </div>
    <div class="gf-modal-corpo">${corpo}</div>
  </div>`;
  document.body.appendChild(el);
  // Clique no fundo fecha; dentro da caixa, não. É o gesto de toda modal desta
  // página.
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-gf-fechar]")) fecharModalGf();
  });
  modalGf = {el, aoFechar};
  if (ligar) ligar(el.querySelector(".gf-modal-corpo"));
  return el;
}

/* ------------------------------------------------------- buscar numa zona */

/* A busca é a mesma tela pras três zonas, e a diferença mora numa linha: sair
   do baralho REEMBARALHA. Olhar a biblioteca inteira e devolvê-la na ordem em
   que estava é a única coisa que este simulador faria por você e que na mesa
   de verdade seria trapaça. */
function abrirBusca(ij, zona){
  const j = estado.mesa.jogadores[ij];
  const titulo = `${NOME_DA_ZONA[zona]} de ${j.nome}`;
  const destinos = ["mao", "campo", "cemiterio", "exilio"].filter(z => z !== zona);

  const corpo = `
    <input class="campo gf-filtro" id="gf-busca-filtro" autocomplete="off"
      spellcheck="false" placeholder="filtrar pelo nome…">
    <div class="gf-lista" id="gf-busca-lista"></div>
    ${zona === "baralho" ? `<p class="nota">Ao fechar, o baralho é
      reembaralhado — olhar a biblioteca e devolvê-la na ordem seria a única
      trapaça que esta tela sabe fazer.</p>` : ""}`;

  abrirModalGf(titulo, corpo, (caixa) => {
    const filtro = caixa.querySelector("#gf-busca-filtro");
    const lista = caixa.querySelector("#gf-busca-lista");
    const desenhar = () => {
      const termo = filtro.value.trim().toLowerCase();
      const cartas = estado.mesa.jogadores[ij][zona]
        .filter(c => nomeDaCarta(c).toLowerCase().includes(termo))
        .sort((a, b) => nomeDaCarta(a).localeCompare(nomeDaCarta(b)));
      if (!cartas.length){
        lista.innerHTML = `<div class="gf-vazio">nada aqui</div>`;
        return;
      }
      lista.innerHTML = cartas.map(c => `<div class="gf-lista-linha">
        <span class="gf-lista-nome" title="${escapar((c.carta || {}).tipo || "")}"
          >${escapar(nomeDaCarta(c))}</span>
        ${destinos.map(z => `<button class="mini" data-gf-manda="${c.uid}:${z}"
          >${escapar(NOME_DA_ZONA[z])}</button>`).join("")}
      </div>`).join("");
    };
    filtro.addEventListener("input", desenhar);
    lista.addEventListener("click", (e) => {
      const b = e.target.closest("[data-gf-manda]");
      if (!b) return;
      const [uid, z] = b.dataset.gfManda.split(":");
      guardarMesa();
      gfMover(Number(uid), z);
      desenhar();
      desenharMesa();
    });
    desenhar();
    filtro.focus();
  }, () => {
    if (zona !== "baralho") return;
    guardarMesa();
    embaralharBaralho(ij);
    desenharMesa();
  });
}

/* ------------------------------------------------------------ criar ficha */

/* Os modelos que a pessoa monta ficam no navegador: uma mesa de Commander cria
   as mesmas três fichas a partida inteira, e redigitar "Soldado 1/1 branco" a
   cada uma delas é o tipo de trabalho que faz a pessoa parar de usar a ficha e
   começar a "lembrar" que ela está lá. */
const CHAVE_FICHAS = "forja.goldfish.fichas";

function fichasSalvas(){
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_FICHAS) || "[]");
    return Array.isArray(bruto) ? bruto : [];
  } catch(e){ return []; }
}

function salvarFicha(modelo){
  try {
    const iguais = (m) => m.nome === modelo.nome && m.poder === modelo.poder &&
                          m.resistencia === modelo.resistencia;
    localStorage.setItem(CHAVE_FICHAS, JSON.stringify(
      [modelo, ...fichasSalvas().filter(m => !iguais(m))].slice(0, 12)));
  } catch(e){ /* navegador privado: a lista é conveniência */ }
}

function abrirCriarFicha(ij){
  // As fichas que o DECK cria já foram lidas da base pela aba Tokens: são elas
  // que a partida vai precisar, e vêm com arte.
  const doDeck = fichasDoDeck().map(f => ({
    nome: f.nome, tipo: f.tipo, poder: f.poder, resistencia: f.resistencia,
    imagem: f.imagem, rotulo: rotuloDaFicha(f),
  }));
  const salvas = fichasSalvas().map(m => ({...m, rotulo:
    m.nome + (m.poder ? ` ${m.poder}/${m.resistencia}` : "")}));
  const chip = (m, i, fonte) => `<button class="chip" data-gf-modelo="${fonte}:${i}"
    >${escapar(m.rotulo)}</button>`;

  const corpo = `
    ${doDeck.length ? `<div class="gf-secao">As que este deck cria</div>
      <div class="gf-chips">${doDeck.map((m, i) => chip(m, i, "deck")).join("")}</div>` : ""}
    ${salvas.length ? `<div class="gf-secao">Salvas neste navegador</div>
      <div class="gf-chips">${salvas.map((m, i) => chip(m, i, "salva")).join("")}</div>` : ""}
    <div class="gf-secao">Montar uma</div>
    <div class="gf-forma">
      <label>Nome <input class="campo" id="gf-f-nome" value="Ficha" maxlength="40"></label>
      <label>Tipo <input class="campo" id="gf-f-tipo" value="Token Creature" maxlength="60"></label>
      <label>Poder <input class="campo curto" id="gf-f-p" value="1" maxlength="3"></label>
      <label>Resistência <input class="campo curto" id="gf-f-r" value="1" maxlength="3"></label>
      <label>Quantas <input class="campo curto" id="gf-f-n" value="1" maxlength="2"></label>
    </div>
    <div class="gf-cores-escolha" id="gf-f-cores">
      ${["W","U","B","R","G"].map(c =>
        `<button class="gf-cor-btn" data-gf-cor="${c}"><span class="pip ${c}"></span></button>`).join("")}
    </div>
    <div class="gf-acoes"><button class="btn ouro" id="gf-f-criar">Criar</button></div>`;

  abrirModalGf("Criar ficha", corpo, (caixa) => {
    const cores = new Set();
    caixa.querySelector("#gf-f-cores").addEventListener("click", (e) => {
      const b = e.target.closest("[data-gf-cor]");
      if (!b) return;
      const c = b.dataset.gfCor;
      if (cores.has(c)) cores.delete(c); else cores.add(c);
      b.classList.toggle("ativa", cores.has(c));
    });
    caixa.addEventListener("click", (e) => {
      const b = e.target.closest("[data-gf-modelo]");
      if (!b) return;
      const [fonte, i] = b.dataset.gfModelo.split(":");
      const modelo = (fonte === "deck" ? doDeck : salvas)[Number(i)];
      guardarMesa();
      criarFicha(ij, modelo, 1);
      fecharModalGf();
      desenharMesa();
    });
    caixa.querySelector("#gf-f-criar").addEventListener("click", () => {
      const modelo = {
        nome: caixa.querySelector("#gf-f-nome").value.trim() || "Ficha",
        tipo: caixa.querySelector("#gf-f-tipo").value.trim() || "Token Creature",
        poder: caixa.querySelector("#gf-f-p").value.trim(),
        resistencia: caixa.querySelector("#gf-f-r").value.trim(),
        cores: [...cores],
      };
      salvarFicha(modelo);
      guardarMesa();
      criarFicha(ij, modelo, caixa.querySelector("#gf-f-n").value);
      fecharModalGf();
      desenharMesa();
    });
  });
}

/* -------------------------------------------------------- o segundo deck */

/* Os decks vêm de dois lugares porque a conta é opcional nesta página: o
   navegador lembra o que foi montado aqui, e quem entrou tem os seus em
   qualquer aparelho. A união dos dois é a lista que a pessoa reconhece. */
async function listaDeDecks(){
  const porId = new Map();
  for (const d of lidos()) porId.set(d.id, {id: d.id, nome: d.nome, de: "neste navegador"});
  if (estado.usuario){
    try {
      const r = await api("/decks/meus");
      for (const d of r.decks || []){
        porId.set(d.id, {id: d.id, nome: d.nome || "Deck sem nome", de: "da sua conta"});
      }
    } catch(e){ /* sem rede, fica o que o navegador lembra */ }
  }
  return [...porId.values()];
}

async function abrirSegundoDeck(){
  abrirModalGf("Segundo deck", `<div class="nota">Procurando seus decks…</div>`);
  const decks = await listaDeDecks();
  const corpo = decks.length
    ? `<div class="gf-lista">${decks.map(d => `<div class="gf-lista-linha">
        <span class="gf-lista-nome">${escapar(d.nome)}</span>
        <span class="gf-lista-de">${escapar(d.de)}</span>
        <button class="mini" data-gf-deck="${escapar(d.id)}">Pôr na mesa</button>
      </div>`).join("")}</div>
      <p class="nota">O segundo deck entra na mesa que já está rolando, com a
        mão dele e o mulligan dele. Nada disto é salvo em nenhum dos dois.</p>`
    : `<div class="gf-vazio">Nenhum deck salvo por aqui ainda. Monte e salve um
        deck (ou entre na sua conta) e ele aparece nesta lista.</div>`;
  abrirModalGf("Segundo deck", corpo, (caixa) => {
    caixa.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-gf-deck]");
      if (!b) return;
      b.disabled = true;
      b.textContent = "Carregando…";
      try {
        const r = await api(`/decks/${b.dataset.gfDeck}`);
        guardarMesa();
        porSegundoDeck(deckDaResposta(r));
        fecharModalGf();
        desenharMesa();
      } catch (err){
        toast("Não consegui abrir esse deck: " + err.message);
        b.disabled = false;
        b.textContent = "Pôr na mesa";
      }
    });
  });
}

/* ------------------------------------------------------- resumo do fim */

const FAIXAS = ["0", "1", "2", "3", "4", "5", "6", "7+"];

function barrasHTML(curva, teto){
  return `<div class="gf-curva">${curva.map((n, i) => `
    <div class="barra" title="${n} carta(s) de custo ${FAIXAS[i]}">
      <span class="qt">${n || ""}</span>
      <div class="haste" style="height:${teto ? (n / teto) * 100 : 0}%"></div>
      <span class="cmc">${FAIXAS[i]}</span>
    </div>`).join("")}</div>`;
}

function abrirResumo(){
  const corpo = resumoDaPartida().map(r => {
    const teto = Math.max(1, ...r.teorica, ...r.realizada);
    return `<div class="gf-resumo-bloco">
      <div class="gf-secao">${escapar(r.nome)}</div>
      <ul class="gf-fatos">
        <li>Comandante desceu ${r.turnoDoComandante === null
          ? "<b>nunca</b>" : `no turno <b>${r.turnoDoComandante}</b>`}</li>
        <li>Terrenos jogados: <b>${r.terrenosJogados}</b></li>
        <li>Feitiços jogados: <b>${r.feiticosJogados}</b> de ${r.feiticosNoDeck}</li>
        <li>Vida no fim: <b>${r.vida}</b></li>
        <li>Nunca puxadas: <b>${r.naoPuxadas}</b></li>
      </ul>
      <div class="gf-duas-curvas">
        <div><span class="gf-legenda">Curva do deck</span>${barrasHTML(r.teorica, teto)}</div>
        <div><span class="gf-legenda">O que desceu</span>${barrasHTML(r.realizada, teto)}</div>
      </div>
      <details class="gf-nao-puxadas"><summary>As que ficaram no baralho</summary>
        <p>${escapar(r.restante.join(", ")) || "nenhuma"}</p></details>
    </div>`;
  }).join("");
  abrirModalGf("Como foi a partida", corpo + `<p class="nota">A curva do deck
    conta as cartas que não são terreno nem comandante; a de baixo conta o que
    de fato desceu pro campo. A mesa continua aí — fechar isto não encerra nada.
    </p>`);
}

/* --------------------------------------------------------------- arrastar */

/* Atalho de quem tem mouse, nunca o único caminho: no toque não existe
   `dragstart`, e a mesma carta se move pelo menu dela. Só aceita a zona do
   DONO da carta — a criatura do outro que morre vai pro cemitério dele, e
   deixar soltá-la no meu faria a mesa mentir sobre de quem é a carta. */
let arrastandoNaMesa = null;

function alvoDeSolta(e){
  if (arrastandoNaMesa === null) return null;
  const alvo = e.target.closest?.("[data-gf-solta]");
  if (!alvo) return null;
  const c = cartaPorUid(arrastandoNaMesa);
  if (!c || Number(alvo.dataset.gfJ) !== c.dono) return null;
  return alvo;
}

function ligarArrastarMesa(mesa){
  mesa.addEventListener("dragstart", (e) => {
    const b = e.target.closest?.("[data-gf-uid]");
    if (!b) return;
    arrastandoNaMesa = Number(b.dataset.gfUid);
    b.classList.add("arrastando");
    e.dataTransfer.effectAllowed = "move";
    // Firefox só dispara `drop` quando alguma coisa foi escrita aqui.
    e.dataTransfer.setData("text/plain", b.dataset.gfUid);
  });
  mesa.addEventListener("dragend", () => {
    arrastandoNaMesa = null;
    mesa.querySelectorAll(".arrastando").forEach(el => el.classList.remove("arrastando"));
    mesa.querySelectorAll(".alvo-solta").forEach(el => el.classList.remove("alvo-solta"));
  });
  mesa.addEventListener("dragover", (e) => {
    const alvo = alvoDeSolta(e);
    if (!alvo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!alvo.classList.contains("alvo-solta")){
      mesa.querySelectorAll(".alvo-solta").forEach(el => el.classList.remove("alvo-solta"));
      alvo.classList.add("alvo-solta");
    }
  });
  mesa.addEventListener("drop", (e) => {
    const alvo = alvoDeSolta(e);
    if (!alvo) return;
    e.preventDefault();
    guardarMesa();
    gfMover(arrastandoNaMesa, alvo.dataset.gfSolta);
    arrastandoNaMesa = null;
    desenharMesa();
  });
}

/* ----------------------------------------------------------- os cliques */

/* Toda ação da mesa é um `data-gf-acao="nome:argumento:…"`, lido num lugar só.
   A alternativa — um `id` e um `addEventListener` por botão — não funciona
   aqui: o HTML da mesa é reescrito a cada jogada, e os ouvintes morreriam
   junto com os botões. */
function fazerAcao(texto, ancora){
  const [nome, ...args] = texto.split(":");
  const ij = Number(args[0]);

  // Primeiro as que NÃO mexem na mesa: abrir uma modal ou o log não pode
  // gastar uma das vinte fotos de desfazer.
  if (nome === "novaMarca"){
    const r = ancora.getBoundingClientRect();
    return abrirMenuDeMarca(ij, r.left, r.bottom + 4);
  }
  if (nome === "buscar") return abrirBusca(ij, args[1]);
  if (nome === "ficha") return abrirCriarFicha(ij);
  if (nome === "log"){
    estado.mesa.logAberto = !estado.mesa.logAberto;
    return;
  }

  // Depois as de clique repetido, que contam como um passo só (ver
  // `guardarMesa`): vida, marcador e dano de comandante andam de um em um.
  if (nome === "vida"){
    guardarMesa("vida" + ij);
    return ajustarVida(ij, Number(args[1]));
  }
  if (nome === "marca"){
    guardarMesa("marca" + ij + args[1]);
    return ajustarMarca(ij, args[1], Number(args[2]));
  }
  if (nome === "dano"){
    guardarMesa("dano" + ij + args[1]);
    return ajustarDanoCmd(ij, Number(args[1]), Number(args[2]));
  }

  guardarMesa();
  if (nome === "manter") return manterMao(ij);
  if (nome === "mulligan") return mulliganLondon(ij);
  if (nome === "comprar") return comprar(ij, 1);
  if (nome === "turno") return passarTurno();
  if (nome === "combate") return limparCombate();
}

export function ligarGoldfish(){
  $("gf-embaralhar").addEventListener("click", () => {
    if (!cartasContadas().length && !estado.comandantes.length){
      return toast("Monte o deck primeiro.");
    }
    montarMesa([deckDaTela()]);
    desenharMesa();
  });

  $("gf-desfazer").addEventListener("click", desfazerMesa);

  $("gf-segundo").addEventListener("click", () => {
    if (!estado.mesa) return;
    if (estado.mesa.jogadores.length > 1){
      guardarMesa();
      tirarSegundoDeck();
      return desenharMesa();
    }
    abrirSegundoDeck();
  });

  $("gf-encerrar").addEventListener("click", () => {
    if (estado.mesa) abrirResumo();
  });

  $("gf-tela").addEventListener("click", () => {
    const cheia = document.body.classList.toggle("gf-cheia");
    $("gf-tela").textContent = cheia ? "Sair da tela cheia" : "Tela cheia";
  });

  const mesa = $("gf-mesa");
  ligarArrastarMesa(mesa);

  mesa.addEventListener("click", (e) => {
    const acao = e.target.closest("[data-gf-acao]");
    if (acao){
      fazerAcao(acao.dataset.gfAcao, acao);
      return desenharMesa();
    }

    const carta = e.target.closest("[data-gf-uid]");
    if (!carta) return;
    const uid = Number(carta.dataset.gfUid);
    const c = cartaPorUid(uid);
    // Na fase de mandar pro fundo, clicar na mão é ESCOLHER — não abrir menu.
    if (c && estado.mesa.jogadores[c.dono].fase === "fundo"
        && zonaDaCarta(uid) === "mao"){
      guardarMesa();
      mandarPraFundo(uid);
      return desenharMesa();
    }
    const r = carta.getBoundingClientRect();
    abrirMenuDaCarta(uid, r.left, r.bottom + 4);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".gf-menu") && !e.target.closest("[data-gf-uid]")
        && !e.target.closest("[data-gf-acao]")) fecharMenuGf();
  });
}
