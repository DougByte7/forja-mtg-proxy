/* ------------------------------------------------------------- mana base */

import {$, escapar} from "../comum/dom.js";
import {ganchosDaPrevia} from "./carta.js";
import {desenharTudo} from "./desenho.js";
import {acharEntrada, guardarDesfazer} from "./edicao.js";
import {estado, NOME_COR} from "./estado.js";
import {trocarAba} from "./paineis.js";
import {moeda, notaDoCambio} from "./preco.js";
import {agendarSalvar, api, salvarAgora} from "./salvar.js";
import {ico, preco, toast} from "./utilidades.js";

/* Os grupos em que `manabase.py` junta os ciclos, com o rótulo que a lista
   de ciclos mostra acima de cada um. */
const GRUPOS_DE_CICLO = {
  desviradas: "Entram desviradas",
  condicionais: "Às vezes viradas",
  viradas: "Entram viradas",
  outros: "Outros",
};

/* Só a resposta do pedido mais recente é desenhada. Abrir um ciclo e o
   autosave pedem a análise em paralelo, e a resposta que chega por último
   não é necessariamente a do último pedido — sem isto, um autosave lento
   fecharia o ciclo que acabou de ser aberto. */
let pedidoDeManabase = 0;

export async function analisarManabase(){
  if (!estado.comandantes.length){
    toast("Escolha o comandante primeiro: é a identidade dele que define as cores.");
    return;
  }
  if (!estado.id) await salvarAgora();
  if (!estado.id){ toast("Não consegui salvar o deck antes de analisar."); return; }
  // Só avisa que está calculando quando ainda não há resposta na tela. Nos
  // recálculos do autosave, apagar a conta anterior faria o painel piscar a
  // cada carta digitada.
  if (!estado.manabase){
    $("mb-nota").hidden = false;
    $("mb-resultado").innerHTML = `<div class="nota">Calculando…</div>`;
  }
  const pedido = ++pedidoDeManabase;
  const params = [];
  if (estado.manabaseTeto !== null) params.push(`teto=${estado.manabaseTeto}`);
  if (estado.mbCategoria) params.push(`categoria=${encodeURIComponent(estado.mbCategoria)}`);
  let resposta;
  try {
    resposta = await api(`/decks/${estado.id}/manabase${
      params.length ? "?" + params.join("&") : ""}`);
  } catch (e){
    if (pedido !== pedidoDeManabase) return;
    $("mb-nota").hidden = false;
    $("mb-resultado").innerHTML =
      `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    return;
  }
  if (pedido !== pedidoDeManabase) return;
  estado.manabase = resposta;
  desenharManabase();
}

function desenharManabase(){
  const caixa = $("mb-resultado");
  const m = estado.manabase;
  if (!m){ $("mb-nota").hidden = false; caixa.innerHTML = ""; return; }
  // A conta está na tela: a explicação do que o painel faz vira ruído acima
  // dela.
  $("mb-nota").hidden = true;
  fixadoresPlanos = [];
  caixa.innerHTML = htmlResumo(m) + htmlBaseAtual(m) + htmlBasicos(m)
    + htmlFixacao(m) + `
    <details class="rodape-conta mb-como">
      <summary>Como a conta é feita</summary>
      <p>Parte de 36 terrenos numa curva média de 3,20: um terreno a mais a
      cada 0,25 de curva acima disso, um a menos a cada 0,25 abaixo. Cada
      rampa barata — rock ou dork de custo até 2 — vale meio terreno a menos,
      no máximo quatro. O resultado fica preso entre 32 e 40. As fontes
      pedidas de cada cor são proporcionais aos símbolos de mana que o deck
      pede daquela cor, com piso de 8 fontes pra um respingo (menos de 12% dos
      símbolos) e 12 pra uma cor de verdade — e fonte é o que <i>produz</i> a
      cor, então um terreno de duas cores conta pras duas. É regra de mesa,
      feita pra conferir de cabeça, não a simulação de Frank Karsten: ela
      aponta o buraco, não fecha a lista.</p>
    </details>`;
}

/* Os terrenos que estão na tela, na ordem do `data-fix` de cada linha. */
export let fixadoresPlanos = [];

/* O retrato do deck: a conta de terrenos, com o veredito dito em palavras, e
   as fontes de cada cor contra o que a cor pede. */
function htmlResumo(m){
  const t = m.terrenos;
  const situacao = t.diferenca === 0 ? "ok" : t.diferenca < 0 ? "falta" : "sobra";
  const veredito = t.diferenca === 0 ? "Na conta"
    : t.diferenca < 0 ? `Faltam ${-t.diferenca}` : `${t.diferenca} a mais`;
  const detalhes = [`Curva média ${m.cmc_media.toFixed(2)}`,
    `${m.magias} ${m.magias === 1 ? "magia" : "magias"}`];
  if (m.rampas_baratas){
    detalhes.push(`${m.rampas_baratas} ${m.rampas_baratas === 1
      ? "rampa barata" : "rampas baratas"}`);
  }

  const maior = Math.max(1, ...m.cores.map(c => Math.max(c.fontes, c.pedidas)));
  const linhas = m.cores.map(c => `
    <div class="mb-cor" title="${escapar(c.nome)}: ${c.pips} símbolo(s) de mana (${Math.round(c.parte*100)}% do deck)${
        c.fora_do_terreno ? " · mais " + c.fora_do_terreno + " fonte(s) em rocks/dorks" : ""}">
      <span class="pip ${c.cor}"></span>
      <span class="mb-cor-nome">${escapar(c.nome)}</span>
      <span class="trilho">
        <span class="cheio" style="width:${Math.min(100, (c.fontes/maior)*100)}%;background:var(--mana-${c.cor})"></span>
        <span class="marca" style="left:clamp(0px, calc(${(c.pedidas/maior)*100}% - 1px), calc(100% - 2px))"></span>
      </span>
      <span class="num"><b>${c.fontes}</b>/${c.pedidas}</span>
      ${c.faltam ? `<span class="dif falta">faltam ${c.faltam}</span>`
                 : `<span class="dif">${ico("check")} ok</span>`}
    </div>`).join("");

  return `<div class="mb-resumo">
    <div class="mb-cartao mb-conta ${situacao}">
      <span class="mb-rotulo">Terrenos</span>
      <div class="mb-numero"><b>${t.tem}</b><span>/ ${t.recomendado}</span></div>
      <span class="mb-veredito">${veredito}</span>
      <p class="nota">${detalhes.join(" · ")}</p>
    </div>
    <div class="mb-cartao">
      <div class="mb-cartao-cab">
        <span class="mb-rotulo">Fontes por cor</span>
        <span class="mb-legenda"><i class="barra"></i>tem <i class="marca"></i>pede</span>
      </div>
      ${linhas}
    </div>
  </div>`;
}

/* Os terrenos que o deck já tem, por como entram e por ciclo. A barra
   responde "quanto da base chega virada"; as pílulas, "de que é feita" — e
   a pílula de um ciclo que tem o que comprar abre esse ciclo na lista de
   baixo. */
const ENTRADAS = [["desvirada", "entram desviradas"],
                  ["condicional", "às vezes viradas"],
                  ["virada", "entram viradas"]];

function htmlBaseAtual(m){
  const b = m.base_atual;
  if (!b || !b.grupos.length) return "";
  const total = m.terrenos.tem;
  const partes = ENTRADAS.filter(([k]) => b.entrada[k]);
  const barra = partes.map(([k, rotulo]) => `<span class="seg ${k}"
    style="flex-grow:${b.entrada[k]}" title="${b.entrada[k]} ${rotulo}"></span>`).join("");
  const legenda = partes.map(([k, rotulo]) =>
    `<span><i class="${k}"></i><b>${b.entrada[k]}</b> ${rotulo}</span>`).join("");
  const abriveis = new Set(m.fixadores.map(c => c.id));
  const pilulas = b.grupos.map(g => {
    const miolo = `<b>${g.quantidade}</b>${escapar(g.nome)}`;
    const nomes = escapar(g.cartas.join(", "));
    return abriveis.has(g.id)
      ? `<button class="mb-base-grupo" data-mb-cat="${escapar(g.id)}"
           title="${nomes}">${miolo}${ico("caret-right")}</button>`
      : `<span class="mb-base-grupo" title="${nomes}">${miolo}</span>`;
  }).join("");
  return `<div class="mb-cartao mb-base">
    <div class="mb-cartao-cab">
      <span class="mb-rotulo">Sua base</span>
      <span class="mb-legenda">${total} ${total === 1 ? "terreno" : "terrenos"}</span>
    </div>
    <div class="mb-base-barra" role="img"
      aria-label="${partes.map(([k, rotulo]) => `${b.entrada[k]} ${rotulo}`).join(", ")}">${barra}</div>
    <div class="mb-base-legenda">${legenda}</div>
    <div class="mb-base-grupos">${pilulas}</div>
  </div>`;
}

/* O jeito de graça de fechar o buraco. Uma pílula por básico e, com mais de
   um, o lote inteiro num clique. */
function htmlBasicos(m){
  const t = m.terrenos;
  if (!m.basicos.length){
    if (t.diferenca >= 0) return "";
    return `<div class="mb-basicos"><span class="nota">Faltam ${-t.diferenca}
      terreno(s), mas nenhuma cor está descoberta — qualquer básico da
      identidade serve.</span></div>`;
  }
  const soma = m.basicos.reduce((s, b) => s + (b.carta ? b.quantidade : 0), 0);
  const pilulas = m.basicos.map((b, i) => `
    <button class="mb-basico" data-basico="${i}"${b.carta
        ? ` title="Adicionar ${b.quantidade}× ${escapar(b.nome)}"`
        : ` disabled title="Carta não encontrada"`}>
      <span class="pip ${b.cor}"></span>${b.quantidade}× ${escapar(b.nome)}${ico("plus")}
    </button>`).join("");
  return `<div class="mb-basicos">
    <span class="mb-rotulo">Fechar com básicos</span>
    <div class="mb-basicos-lista">${pilulas}</div>
    ${m.basicos.length > 1 && soma
      ? `<button class="add-peca" data-basicos-todos>${ico("plus")} Todos (${soma})</button>` : ""}
  </div>`;
}

/* Os terrenos pra comprar, por ciclo: a lista dos ciclos de um lado (que é
   também o mapa do que existe pra esta identidade) e, do outro, a visão
   geral com os primeiros de cada ciclo ou o ciclo aberto inteiro. */
function htmlFixacao(m){
  // O `data-teto` fica em DÓLAR: é o que `manabase.py` filtra do outro lado,
  // e o rótulo é a única parte que a régua toca. Converter o valor mandado
  // faria o teto mudar de significado conforme o dólar do dia.
  const chips = [1, 3, 10, 999].map(v => `
    <button class="chip ${m.teto_usd === v || (v === 999 && m.teto_usd >= 999) ? "ativo" : ""}"
      data-teto="${v}"${v >= 999 ? "" : ` title="${escapar(notaDoCambio())}"`
      }>${v >= 999 ? "Sem teto" : "até " + moeda(v)}</button>`).join("");
  let html = `<section class="mb-fixacao">
    <div class="mb-fix-cab">
      <h2 class="secao">${m.monocolor ? "Terrenos recomendados" : "Terrenos que fixam"}</h2>
      <div class="mb-teto" role="group" aria-label="Teto de preço">
        <span>Preço</span>${chips}</div>
    </div>`;
  if (m.monocolor){
    html += `<p class="nota mb-mono">Deck de uma cor: básico resolve a cor.</p>`;
  }

  const ciclos = m.fixadores;
  if (!ciclos.length){
    return html + `<div class="vazio">${m.monocolor
      ? "Nenhum MDFC da cor do deck."
      : "Nenhum terreno de duas ou mais cores da identidade."}</div></section>`;
  }
  // O ciclo aberto pode sumir da resposta — o comandante mudou e a
  // identidade com ele. Aí a tela volta pra visão geral.
  let aberto = ciclos.find(c => c.id === estado.mbCategoria);
  if (!aberto) estado.mbCategoria = "";

  const faltando = new Set(m.cores.filter(c => c.faltam > 0).map(c => c.cor));
  const lista = aberto
    ? htmlCicloAberto(aberto, faltando)
    : htmlVisaoGeral(ciclos, faltando);
  return html + `<div class="mb-navegador">
      ${htmlListaDeCiclos(ciclos, aberto)}
      <div class="mb-lista">${lista}</div>
    </div></section>`;
}

function htmlListaDeCiclos(ciclos, aberto){
  const todos = ciclos.reduce((s, c) => s + c.total, 0);
  let html = `<nav class="mb-ciclos" aria-label="Ciclos de terreno">
    <button class="mb-ciclo-btn ${aberto ? "" : "ativo"}" data-mb-cat=""
      aria-pressed="${aberto ? "false" : "true"}">
      <span class="rot">Todos</span><span class="n">${todos}</span></button>`;
  let grupo = null;
  for (const c of ciclos){
    if (c.grupo !== grupo){
      grupo = c.grupo;
      html += `<span class="mb-grupo-rot">${GRUPOS_DE_CICLO[grupo] || ""}</span>`;
    }
    const ativo = aberto && aberto.id === c.id;
    html += `<button class="mb-ciclo-btn ${ativo ? "ativo" : ""} ${c.total ? "" : "sem-terreno"}"
        data-mb-cat="${escapar(c.id)}" aria-pressed="${ativo ? "true" : "false"}"
        title="${escapar(c.descricao)}">
      <span class="rot">${escapar(c.nome)}</span>
      ${c.no_deck ? `<span class="tem" title="${c.no_deck} no deck">${ico("check")}${c.no_deck}</span>` : ""}
      <span class="n">${c.total}</span></button>`;
  }
  return html + `</nav>`;
}

/* A visão geral é uma olhada, não o catálogo: fica de fora o ciclo sem
   terreno pra mostrar (todos acima do teto, ou todos já no deck) e o grupo
   "Outros", que só interessa a quem foi procurar por ele. Os dois continuam
   na lista de ciclos. */
function htmlVisaoGeral(ciclos, faltando){
  const visiveis = ciclos.filter(c => c.grupo !== "outros" && c.total);
  const deFora = ciclos.filter(c => c.grupo === "outros" && c.total);
  if (!visiveis.length){
    return `<div class="vazio">Nenhum terreno dentro do teto de preço.</div>`;
  }
  return visiveis.map(c => htmlCicloResumido(c, faltando)).join("") + (deFora.length
    ? `<p class="nota mb-de-fora">${deFora.map(c => escapar(c.nome)).join(" e ")}
        ficam na lista de ciclos.</p>` : "");
}

function htmlCicloResumido(c, faltando){
  const existem = c.total + c.no_deck;
  const linhas = c.terrenos.map(t => htmlTerreno(t, c, faltando)).join("");
  return `<div class="mb-ciclo">
    <div class="mb-ciclo-cab">
      <div><h3>${escapar(c.nome)}</h3><p>${escapar(c.descricao)}</p></div>
      ${existem > c.terrenos.length
        ? `<button class="mb-ver" data-mb-cat="${escapar(c.id)}">Ver todos (${existem})${ico("caret-right")}</button>` : ""}
    </div>
    ${linhas ? `<div class="mb-grade">${linhas}</div>` : ""}
  </div>`;
}

function htmlCicloAberto(c, faltando){
  // Enquanto o ciclo inteiro não chega, a lista mostra os primeiros que já
  // estavam na tela.
  const chegando = c.terrenos.length < c.total + c.no_deck;
  return `<div class="mb-ciclo aberto">
    <div class="mb-ciclo-cab">
      <div><h3>${escapar(c.nome)}</h3><p>${escapar(c.descricao)}</p></div>
      <button class="mb-ver" data-mb-cat="">${ico("arrow-left")}Todos</button>
    </div>
    ${c.terrenos.length
      ? `<div class="mb-grade">${c.terrenos.map(t => htmlTerreno(t, c, faltando)).join("")}</div>` : ""}
    ${chegando ? `<p class="nota mb-chegando">Carregando o ciclo inteiro…</p>` : ""}
    ${c.acima_do_teto ? `<div class="mb-acima">
        <span>${c.acima_do_teto} ${c.acima_do_teto === 1 ? "terreno passa" : "terrenos passam"}
        do teto de preço.</span>
        <button class="mb-ver" data-teto="999">Mostrar sem teto</button>
      </div>` : ""}
  </div>`;
}

/* Uma linha da lista. Veste o `.achado` da busca porque é a mesma ação —
   clicar põe no deck —, e a bolinha com anel é cor que o deck ainda pede. */
function htmlTerreno(t, ciclo, faltando){
  const i = fixadoresPlanos.push(t) - 1;
  const legenda = [t.tipo.split(" // ").find(x => /land/i.test(x)) || t.tipo];
  if (t.entrada === "virada" && ciclo.grupo !== "viradas") legenda.push("entra virada");
  const pips = t.produz.split("").map(c => {
    const falta = faltando.has(c);
    return `<span class="pip ${c} ${falta ? "cobre" : ""}"
      title="${NOME_COR[c]}${falta ? " — o deck pede mais fontes" : ""}"></span>`;
  }).join("");
  return `<button class="achado mb-terreno ${t.no_deck ? "no-deck" : ""}" data-fix="${i}"${
      t.no_deck ? ` aria-disabled="true" title="Já está no deck"` : ""}${ganchosDaPrevia(t)}>
    <span class="nome"><b>${escapar(t.nome)}</b>
      <small>${escapar(legenda.join(" · "))}</small></span>
    <span class="mana">${pips}</span>
    <span class="preco">${preco(t) || "—"}</span>
  </button>`;
}

/* Abrir um ciclo desenha na hora com os terrenos que já estão na tela e
   pede o ciclo inteiro por trás. Quem clicou em "Ver todos" no fim da visão
   geral fica olhando pro vazio se a lista encolhe embaixo dele, e quem
   clicou numa pílula de "Sua base" abriu algo que está abaixo da dobra —
   nos dois casos a tela vai até o começo da seção. */
export function abrirCiclo(id){
  estado.mbCategoria = id || "";
  desenharManabase();
  const secao = document.querySelector("#mb-resultado .mb-fixacao");
  const topo = secao ? secao.getBoundingClientRect().top : 0;
  if (secao && (topo < 0 || topo > window.innerHeight - 160)){
    secao.scrollIntoView({behavior: "smooth", block: "start"});
  }
  const ciclo = (estado.manabase?.fixadores || []).find(c => c.id === id);
  if (ciclo && ciclo.terrenos.length < ciclo.total + ciclo.no_deck) analisarManabase();
}

/* Põe um lote de cartas de uma vez — é o que "3× Forest" e "Todos" fazem.
   Uma entrada só de desfazer, senão Ctrl+Z tiraria uma floresta por vez. */
export function adicionarLote(lote){
  guardarDesfazer();
  for (const {carta, quantidade} of lote){
    const entrada = acharEntrada(carta.nome);
    if (entrada) entrada.quantidade += quantidade;
    else estado.cartas.push({carta, quantidade, categoria: ""});
  }
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();
}

/* O atalho no cabeçalho de Terrenos. Ele não abre painel nenhum: rola até o
   que já existe embaixo do deck e o faz piscar, porque duas mana bases na
   mesma tela seriam duas respostas pra mesma pergunta. */
export function chamarManabase(){
  trocarAba("manabase");
  const painel = $("painel-manabase");
  painel.scrollIntoView({behavior: "smooth", block: "nearest"});
  painel.classList.remove("chamado");
  void painel.offsetWidth;          // reinicia a animação se já tiver rodado
  painel.classList.add("chamado");
  if (!estado.manabase) analisarManabase();
}
