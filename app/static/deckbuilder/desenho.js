/* ------------------------------------------------------------------- desenhar */

import {$, escapar} from "../comum/dom.js";
import {botaoDeArte} from "./artes.js";
import {atualizarCategoriasDoDestino} from "./busca.js";
import {ganchosDaPrevia} from "./carta.js";
import {desenharChances} from "./chances.js";
import {desenharCombos} from "./combos.js";
import {CATEGORIAS_FORA_DA_CONTA, CORES, estado, NOME_COR} from "./estado.js";
import {atualizarBotaoPedido, desenharGaleria} from "./galeria.js";
import {agendarCotacao, desenharPreviaOrcamento, subtotalDoGrupo,
        subtotalTexto, subtotalTitulo, valorComparavel,
        valorHTML} from "./orcamento.js";
import {desenharPoder} from "./poder.js";
import {simboloDaTela} from "./preco.js";
import {validacaoAtual} from "./salvar.js";
import {cartasContadas, categoriaAutomatica, categoriaDe, ehPropria, ico,
        identidadeDoDeck, manaHTML, ordemDasCategorias, semAcento,
        totalCartas} from "./utilidades.js";

export function desenharTudo(){
  desenharDeck();
  desenharMaybe();
  desenharGaleria();
  atualizarBotaoPedido();
  desenharAnalise();
  desenharContador();
  desenharPreviaOrcamento();
  $("rot-preco-moeda").textContent = simboloDaTela();
  atualizarNotaIdentidade();
  atualizarCategoriasDoDestino();
  // Redesenha os combos pra o aviso de "o deck mudou desde esta busca"
  // aparecer no mesmo instante em que ele passa a ser verdade.
  if (estado.combos) desenharCombos();
  if (estado.poder) desenharPoder();
  // A cotação persegue o deck: cada mudança marca uma nova, que só sai depois
  // de o deck ficar quieto.
  agendarCotacao();
}

/* Os dois medidores do cabeçalho. O ponto colorido carrega a validação
   inteira num pixel: verde é deck legal, vermelho é erro de verdade (carta
   fora da identidade, singleton quebrado, banida), cinza é "ainda montando" —
   que não é erro nenhum e por isso não é vermelho. O título diz o que o ponto
   resume, pra quem quiser a frase. */
export function desenharContador(){
  const total = totalCartas();
  const v = validacaoAtual();
  const graves = (v.apontamentos || []).filter(
    a => a.nivel === "erro" && a.tipo !== "faltam" && a.tipo !== "sobram");

  $("contador-n").textContent = total;
  const el = $("contador");
  el.className = "medidor" +
    (graves.length ? " erro" : total === 100 && v.ok ? " completo"
                             : total > 100 ? " passou" : "");
  el.title = graves.length
    ? `${graves.length} problema(s) — veja a aba Análise`
    : total === 100 && v.ok
      ? "Deck legal: 100 cartas, singleton respeitado e tudo na identidade"
      : total > 100
        ? `${total - 100} carta(s) além das 100`
        : `Faltam ${100 - total} carta(s) pras 100`;
}

export function desenharDeck(){
  const temComandante = estado.comandantes.length > 0;
  $("heroi").hidden = temComandante;
  $("area-deck").hidden = !temComandante;
  $("corpo").classList.toggle("sem-comandante", !temComandante);
  $("aba-deck-n").textContent = totalCartas();
  if (!temComandante) return;

  const identidade = identidadeDoDeck();
  $("cmd-box").innerHTML = estado.comandantes.map((c, i) => `
    <button class="ver" data-ver-cmd="${i}"${ganchosDaPrevia(c)}
            title="Ver ${escapar(c.nome)} inteira">
      <img src="${escapar(c.imagem)}" alt="" loading="lazy">
      <span class="dados">
        <b>${escapar(c.nome)}</b>
        <small>${escapar(c.tipo)}</small>
      </span>
    </button>
    <div class="mana">${manaHTML(c.mana_cost)}</div>
    ${botaoDeArte(c)}
    <button class="mini sai" data-tirar-cmd="${i}" title="Trocar comandante">${ico("x")}</button>
  `).join('<div style="width:100%;height:1px;background:var(--border)"></div>');

  // Segundo comandante só faz sentido quando o primeiro tem parceria.
  if (estado.comandantes.length === 1 && estado.comandantes[0].parceiro){
    $("cmd-box").insertAdjacentHTML("beforeend",
      `<button class="btn" id="btn-parceiro" style="width:100%;margin-top:8px;">
         ${ico("plus")} Adicionar parceiro</button>`);
  }

  $("lista-deck").innerHTML = gruposHTML(estado.cartas, identidade, "deck");
  $("deck-vazio").hidden = estado.cartas.length > 0;
  atualizarFerramentasDaLista();
}

/* A barra de achar-e-ordenar aparece quando a lista já é grande o bastante
   pra se perder nela. Num deck de seis cartas ela seria só mais um controle
   em cima do que cabe inteiro na tela — e some de novo, mas NUNCA com uma
   busca digitada: sumir levando o filtro junto esconderia cartas sem deixar
   como desfazer. */
const MINIMO_PRA_FERRAMENTAS = {deck: 10, talvez: 5};

function atualizarFerramentasDaLista(){
  $("ferramentas-deck").hidden =
    estado.cartas.length < MINIMO_PRA_FERRAMENTAS.deck && !estado.listaBusca.deck;
  escreverBusca("busca-deck", estado.listaBusca.deck);
  $("ordem-lista").value = estado.listaOrdem;
}

/* O campo só é reescrito quando discorda do estado. Escrever por cima do que
   já está lá manda o cursor pro fim em alguns navegadores — e este campo é
   reescrito a cada tecla digitada nele. */
function escreverBusca(id, texto){
  if ($(id).value !== texto) $(id).value = texto;
}

/* ------------------------------------------------------ ordem dentro do grupo

   A ordem vale DENTRO de cada categoria; a ordem dos grupos é outra coisa
   (`ordemDasCategorias`) e continua sendo a decisão de quem monta.

   Todas desempatam pelo nome: sem isso, duas cartas de custo 3 trocariam de
   lugar entre um desenho e o outro, e a lista tremeria a cada tecla. */
const porNome = (a, b) => a.carta.nome.localeCompare(b.carta.nome);

/* Preço desconhecido vai pro fim nos DOIS sentidos — ver `valorComparavel`. */
function porPreco(a, b, sinal){
  const va = valorComparavel(a), vb = valorComparavel(b);
  if (va === null && vb === null) return porNome(a, b);
  if (va === null) return 1;
  if (vb === null) return -1;
  return (va - vb) * sinal || porNome(a, b);
}

const ORDENS_DA_LISTA = {
  cmc:       (a, b) => (a.carta.cmc - b.carta.cmc) || porNome(a, b),
  cmc_desc:  (a, b) => (b.carta.cmc - a.carta.cmc) || porNome(a, b),
  nome:      porNome,
  preco:     (a, b) => porPreco(a, b, +1),
  preco_desc:(a, b) => porPreco(a, b, -1),
};

/* ---------------------------------------------------------------- maybeboard

   A mesma lista, com as mesmas categorias e o mesmo desenho de linha — de
   propósito. Mover uma carta pra cá não pode parecer mudar de programa: é a
   mesma carta, no mesmo deck, com a decisão adiada. O que muda é uma coluna
   só (a área é estreita) e o fato de nada aqui contar em lugar nenhum. */
export function desenharMaybe(){
  const n = estado.maybe.reduce((soma, e) => soma + e.quantidade, 0);
  $("talvez-n").hidden = !n;
  $("talvez-n").textContent = n;
  $("talvez-vazio").hidden = n > 0;
  $("busca-talvez").hidden =
    estado.maybe.length < MINIMO_PRA_FERRAMENTAS.talvez && !estado.listaBusca.talvez;
  escreverBusca("busca-talvez", estado.listaBusca.talvez);
  $("talvez-lista").innerHTML = n
    ? gruposHTML(estado.maybe, identidadeDoDeck(), "talvez") : "";
}

/* Os grupos de uma lista, do jeito que as duas áreas desenham.

   As categorias próprias VAZIAS aparecem mesmo sem carta, e só no deck: uma
   categoria recém-criada que não se vê na tela parece não ter sido criada, e
   é justamente nela que a próxima carta vai. No maybeboard elas não
   aparecem — dez grupos vazios numa coluna de 288px seriam a coluna
   inteira. */
function gruposHTML(entradas, identidade, tabuleiro){
  const porCategoria = new Map();
  for (const entrada of entradas){
    const cat = categoriaDe(entrada);
    if (!porCategoria.has(cat)) porCategoria.set(cat, []);
    porCategoria.get(cat).push(entrada);
  }

  let ordem = ordemDasCategorias(entradas);
  if (tabuleiro === "talvez") ordem = ordem.filter(c => porCategoria.has(c));

  // Procurar é uma pergunta sobre a lista inteira, e ela atravessa os dois
  // estados que escondem carta: os grupos recolhidos se abrem e as categorias
  // vazias somem. Nenhum dos dois é apagado — os recolhidos voltam a fechar
  // quando a busca sai do campo.
  const procurado = semAcento(estado.listaBusca[tabuleiro] || "").trim();
  const casa = (e) => semAcento(e.carta.nome).includes(procurado);

  const html = ordem.map(cat => {
    const todos = porCategoria.get(cat) || [];
    const itens = procurado ? todos.filter(casa) : todos.slice();
    if (procurado && !itens.length) return "";
    itens.sort(ORDENS_DA_LISTA[estado.listaOrdem] || ORDENS_DA_LISTA.cmc);
    // A conta do cabeçalho é sempre a do GRUPO, não a do que sobrou do
    // filtro: ela é o número de cartas que o deck tem ali, e uma busca não
    // muda isso. Com filtro ligado ela ganha o "de", que diz as duas coisas.
    const n = todos.reduce((soma, e) => soma + e.quantidade, 0);
    const nFiltrado = itens.reduce((soma, e) => soma + e.quantidade, 0);
    const contaTexto = procurado ? `${nFiltrado} de ${n}` : String(n);
    const fechado = !procurado && estado.gruposFechados.has(`${tabuleiro}:${cat}`);
    // Sem subtotal no maybeboard: ele não entra na cotação, e um preço ao
    // lado do grupo diria o contrário — a pessoa somaria de cabeça um
    // dinheiro que a faixa de orçamento não está cobrando dela. O preço de
    // cada carta fica na linha, que é onde ele ajuda a decidir.
    //
    // Somado sobre o grupo INTEIRO mesmo com busca ligada, pelo mesmo motivo
    // da contagem: é quanto o grupo custa no deck, e filtrar a tela não
    // barateia o deck.
    const subtotal = tabuleiro === "talvez"
      ? null : subtotalDoGrupo(todos);
    const propria = ehPropria(cat);
    const fora = CATEGORIAS_FORA_DA_CONTA.has(cat);
    const corpo = fechado ? ""
      : itens.length
        ? `<div class="colunas">${itens.map(e =>
              linhaHTML(e, identidade, tabuleiro)).join("")}</div>`
        : `<div class="grupo-vazio">Categoria vazia. Arraste uma carta pra cá,
             ou escolha esta categoria no menu da linha dela — clique direito,
             ou o ${ico("dots-three")} no celular.</div>`;
    return `<div class="grupo ${propria ? "propria" : ""} ${fora ? "fora-da-conta" : ""}
      ${fechado ? "fechado" : ""}"
      data-categoria="${escapar(cat)}" data-tabuleiro="${tabuleiro}">
      <h3>
        <button class="grupo-titulo" data-recolher-grupo="${escapar(cat)}"
                aria-expanded="${fechado ? "false" : "true"}"
                title="${fechado ? "Abrir" : "Recolher"} ${escapar(cat)}">
          ${ico(fechado ? "caret-right" : "caret-down")}
          <span>${escapar(cat)}</span>
          <span class="n">${contaTexto}</span>
        </button>
        ${fora ? `<span class="fora-rot" title="O sideboard fica fora das 100
e fora das análises, mas entra na cotação e na lista de impressão — é carta
que você quer ter.">fora das 100</span>` : ""}
        ${subtotal && subtotal.valor ? `<span class="valor-grupo"
          title="${escapar(subtotalTitulo(subtotal))}">${subtotalTexto(subtotal)}</span>` : ""}
        <span class="traco"></span>
        ${cat === "Terrenos" && tabuleiro === "deck"
          ? `<button class="btn-atalho" data-abrir-manabase
               title="A conta de terrenos deste deck, no painel de baixo">${ico("dice-five")} Mana base</button>` : ""}
        <span class="acoes-grupo">
          ${propria ? `<button class="mini" data-menu-grupo="${escapar(cat)}"
             title="Renomear, mover ou apagar a categoria"
             aria-label="Ações da categoria ${escapar(cat)}">${ico("dots-three")}</button>` : ""}
        </span>
      </h3>${corpo}</div>`;
  }).join("");

  // Busca sem resultado precisa DIZER isso. Devolver lista vazia deixaria a
  // área em branco, que é o mesmo desenho de "este deck não tem carta
  // nenhuma" — e aí o susto é achar que o filtro apagou o deck.
  if (procurado && !html){
    return `<div class="vazio lista-sem-achado">Nenhuma carta com
      “${escapar(estado.listaBusca[tabuleiro].trim())}” ${tabuleiro === "talvez"
        ? "no maybeboard" : "no deck"}.</div>`;
  }
  return html;
}

/* Recolher e abrir um grupo. Fica na memória da sessão e não no deck: é como
   a lista está sendo olhada agora, não o que ela é — recarregar a página
   devolve tudo aberto, de propósito. */
export function alternarGrupo(cat, tabuleiro){
  const chave = `${tabuleiro}:${cat}`;
  if (estado.gruposFechados.has(chave)) estado.gruposFechados.delete(chave);
  else estado.gruposFechados.add(chave);
  if (tabuleiro === "talvez") desenharMaybe(); else desenharDeck();
}

/* O que se digitou pra achar uma carta já adicionada. Redesenha SÓ a lista
   mexida: o campo mora fora dela, então continua com o foco e o cursor onde
   estavam — e a cotação, a curva e o resto não têm por que recalcular por
   causa de uma letra digitada. */
export function procurarNaLista(tabuleiro, texto){
  estado.listaBusca[tabuleiro] = texto;
  if (tabuleiro === "talvez") desenharMaybe(); else desenharDeck();
}

export function ordenarLista(ordem){
  estado.listaOrdem = ORDENS_DA_LISTA[ordem] ? ordem : "cmc";
  desenharDeck();
  desenharMaybe();
}

function linhaHTML(entrada, identidade, tabuleiro){
  const c = entrada.carta;
  const fora = (c.identidade||"").split("").filter(x => !identidade.includes(x));
  const repetida = entrada.quantidade > 1 && !c.basico && !c.ilimitada;
  // O maybeboard não acusa nada: é rascunho, e uma carta em dúvida marcada
  // de vermelho por estar fora da identidade seria alarme sobre uma decisão
  // que ainda não foi tomada.
  const problema = tabuleiro === "deck" && (fora.length || repetida || !c.legal);
  let porque = "";
  if (problema && fora.length) porque = `fora da identidade (${fora.join("")})`;
  else if (problema && repetida) porque = "singleton: só uma cópia";
  else if (problema && !c.legal) porque = "não é legal em Commander";

  const nome = escapar(c.nome);
  // A coluna do maybeboard tem 288px, e a linha do deck não cabe nela
  // inteira: sai a estrela de sugerir (pedir o que combina com uma carta que
  // talvez nem fique é sugestão pra um deck que não existe) e sai o botão de
  // arte, que continua no menu. O preço fica — "vale o que custa?" é metade
  // da dúvida sobre uma carta.
  //
  // O resto da carta (categoria, trocar de tabuleiro, ver, arte) mora no
  // menu da linha, e a quantidade se digita no próprio número: zero tira a
  // carta. No mouse o menu abre no clique direito; no celular não existe
  // clique direito (e o toque longo não o dispara em todo navegador), então
  // lá ele ganha o ⋯ no fim da linha.
  const estreita = tabuleiro === "talvez";
  const onde = estreita ? "maybeboard" : "deck";
  const botaoMenu = `<button class="mini so-celular" data-menu-carta="${nome}"
    title="${estreita ? "Categoria, voltar pro deck e mais"
                      : "Categoria, maybeboard e mais"}"
    aria-label="Opções de ${nome}">${ico("dots-three")}</button>`;
  const botaoTirar = `<button class="mini sai" data-tirar="${nome}"
    title="Tirar do ${onde}" aria-label="Tirar ${nome} do ${onde}">${ico("x")}</button>`;
  return `<div class="linha ${problema ? "problema" : ""}" data-nome="${nome}"
    data-tabuleiro="${tabuleiro}" draggable="true">
    <input class="qtd" type="number" min="0" max="99" step="1"
           inputmode="numeric" value="${entrada.quantidade}" data-qtd="${nome}"
           aria-label="Quantidade de ${nome}"
           title="Quantidade — zero tira a carta. Clique direito na linha pro menu.">
    <span class="nome"${ganchosDaPrevia(c)}>${nome}
      ${porque ? `<span class="porque">· ${porque}</span>` : ""}</span>
    ${manaHTML(c.mana_cost)}
    ${valorHTML(entrada)}
    <span class="ctrl">
      ${estreita ? "" : `<button class="mini" data-sug-carta="${nome}"
              title="O que o EDHREC vê jogando junto de ${nome}"
              aria-label="Sugestões a partir de ${nome}">${ico("sparkle")}</button>
      ${botaoDeArte(c)}`}
      ${botaoTirar}
      ${botaoMenu}
    </span>
  </div>`;
}

/* O que está errado NÃO pode morar só numa aba: uma carta fora da identidade
   precisa aparecer na mesma tela em que ela foi adicionada, senão o erro
   espera a pessoa lembrar de conferir. Então a análise se divide em duas: os
   erros de verdade ficam presos acima da lista do deck, e o resto (progresso,
   curva, cores) fica na aba, que é conferência e não alarme. */
function desenharAlertasDoDeck(){
  const v = validacaoAtual();
  const graves = (v.apontamentos || []).filter(
    a => a.nivel === "erro" && a.tipo !== "faltam" && a.tipo !== "sobram");
  const caixa = $("alertas-deck");
  if (!graves.length){ caixa.innerHTML = ""; return; }

  // Agrupado por tipo, como na aba: um erro por carta vira ruído numa lista
  // de 99, e "12 cartas fora da identidade" é a mesma informação numa linha.
  const porTipo = new Map();
  for (const a of graves){
    if (!porTipo.has(a.tipo)) porTipo.set(a.tipo, []);
    porTipo.get(a.tipo).push(a);
  }
  caixa.innerHTML = [...porTipo.values()].map(grupo => {
    const a = grupo[0];
    const nomes = grupo.map(x => x.carta).filter(Boolean);
    const texto = nomes.length > 1
      ? `${nomes.length} cartas: ${escapar(nomes.slice(0, 6).join(", "))}` +
        (nomes.length > 6 ? ` e mais ${nomes.length - 6}` : "")
      : escapar(a.mensagem);
    const titulo = nomes.length > 1 ? rotuloTipo(a.tipo) : "";
    return `<div class="aponta erro" style="margin-bottom:8px">
      <span>${titulo ? `<b>${titulo}</b> — ` : ""}${texto}</span></div>`;
  }).join("");
}

export function desenharAnalise(){
  const v = validacaoAtual();
  const caixa = $("apontamentos");
  desenharAlertasDoDeck();

  if (!estado.comandantes.length){
    caixa.innerHTML = `<div class="vazio" style="padding:8px 0;">Escolha o
      comandante pra análise começar.</div>`;
  } else if (v.ok){
    caixa.innerHTML = `<div class="aponta ok">${ico("check")} Deck legal: 100 cartas,
      singleton respeitado e tudo dentro da identidade
      ${v.identidade ? pipsHTML(v.identidade) : "incolor"}.</div>`;
  } else {
    // "Faltam 43 cartas" sai da lista de erros e vira barra de progresso: é o
    // estado normal de quem está montando, e pintá-lo de vermelho junto com
    // uma carta banida ensinaria a ignorar os dois.
    const faltam = v.apontamentos.filter(a => a.tipo === "faltam" || a.tipo === "sobram");
    const resto = v.apontamentos.filter(a => a.tipo !== "faltam" && a.tipo !== "sobram");
    let html = "";
    if (faltam.length){
      const pct = Math.min(100, (v.total / 100) * 100);
      html += `<div class="progresso">
        <div class="texto"><span>${v.total > 100 ? "Passou das 100" : "Montando o deck"}</span>
          <b>${v.total}/100</b></div>
        <span class="trilho"><span class="cheio" style="width:${pct}%"></span></span>
      </div>`;
    }

    // Um erro por carta vira ruído numa lista de 99: agrupa por tipo e mostra
    // "12 cartas fora da identidade" com os nomes juntos.
    const porTipo = new Map();
    for (const a of resto){
      if (!porTipo.has(a.tipo)) porTipo.set(a.tipo, []);
      porTipo.get(a.tipo).push(a);
    }
    caixa.innerHTML = html + [...porTipo.values()].map(grupo => {
      const a = grupo[0];
      const nomes = grupo.map(x => x.carta).filter(Boolean);
      const texto = nomes.length > 1
        ? `${nomes.length} cartas: ${escapar(nomes.slice(0, 6).join(", "))}` +
          (nomes.length > 6 ? ` e mais ${nomes.length - 6}` : "")
        : escapar(a.mensagem);
      const titulo = nomes.length > 1 ? rotuloTipo(a.tipo) : "";
      return `<div class="aponta ${a.nivel}">
        <span>${titulo ? `<b>${titulo}</b> — ` : ""}${texto}</span></div>`;
    }).join("");
  }

  desenharCurva();
  desenharDistribuicao();
  desenharChances();
}

function rotuloTipo(tipo){
  return {
    identidade: "Fora da identidade de cor",
    singleton: "Singleton quebrado",
    banida: "Não é legal em Commander",
    desconhecida: "Não achei na base local",
    "comandante-repetido": "Comandante repetido nas 99",
  }[tipo] || "";
}

function pipsHTML(identidade){
  return `<span class="mana" title="${identidade.split("").map(c => NOME_COR[c]).join(", ")}">` +
    identidade.split("").map(c => `<span class="pip ${c}"></span>`).join("") +
    "</span>";
}

function desenharCurva(){
  // Terreno fica de fora: ele não tem custo, e incluí-lo achataria a curva
  // toda no zero, que é justamente o número que ninguém quer ler.
  const faixas = [0,1,2,3,4,5,6,7];
  const contas = faixas.map(() => 0);
  for (const {carta, quantidade} of cartasContadas()){
    if (!carta || (carta.tipo||"").toLowerCase().includes("land")) continue;
    const cmc = Math.min(7, Math.floor(carta.cmc || 0));
    contas[cmc] += quantidade;
  }
  const teto = Math.max(1, ...contas);
  $("curva").innerHTML = faixas.map((f, i) => `
    <div class="barra" title="${contas[i]} carta(s) com custo ${f}${f === 7 ? "+" : ""}">
      <span class="qt">${contas[i] || ""}</span>
      <div class="haste" style="height:${(contas[i] / teto) * 100}%"></div>
      <span class="cmc">${f}${f === 7 ? "+" : ""}</span>
    </div>`).join("");
}

function desenharDistribuicao(){
  // Fontes de cor (terreno e o que produz mana não entram: isso é a
  // distribuição do que o deck PEDE de cor, não do que ele produz).
  const pedidos = {W:0,U:0,B:0,R:0,G:0};
  let totalPips = 0;
  for (const {carta, quantidade} of cartasContadas()){
    if (!carta) continue;
    for (const s of (carta.mana_cost || "").match(/\{[^}]+\}/g) || []){
      for (const c of s.slice(1,-1).split("/")){
        if (pedidos[c] !== undefined){ pedidos[c] += quantidade; totalPips += quantidade; }
      }
    }
  }
  const cores = CORES.filter(c => pedidos[c] > 0).map(c => `
    <div class="item">
      <span class="pip ${c}"></span>
      <span style="width:56px">${NOME_COR[c]}</span>
      <span class="trilho"><span class="cheio" style="width:${totalPips ? (pedidos[c]/totalPips)*100 : 0}%;background:var(--mana-${c})"></span></span>
      <span class="num">${pedidos[c]}</span>
    </div>`).join("");

  // Por tipo, e não pela categoria escolhida à mão: aqui a pergunta é "meu
  // deck tem criatura demais?", e um deck cujas criaturas estão em "combo
  // principal" responderia zero.
  const porCat = new Map();
  for (const {carta, quantidade} of cartasContadas()){
    const cat = categoriaAutomatica(carta);
    porCat.set(cat, (porCat.get(cat) || 0) + quantidade);
  }
  const maiorCat = Math.max(1, ...porCat.values());
  const tipos = [...porCat.entries()].sort((a,b) => b[1]-a[1]).map(([cat, n]) => `
    <div class="item">
      <span style="width:70px">${cat}</span>
      <span class="trilho"><span class="cheio" style="width:${(n/maiorCat)*100}%;background:var(--purple)"></span></span>
      <span class="num">${n}</span>
    </div>`).join("");

  const vazio = '<div class="vazio" style="padding:8px 0;">Sem cartas ainda.</div>';
  $("distrib-cores").innerHTML = cores || vazio;
  $("distrib-tipos").innerHTML = tipos || vazio;
}

function atualizarNotaIdentidade(){
  const nota = $("nota-identidade");
  if (!estado.comandantes.length){ nota.hidden = true; return; }
  const identidade = identidadeDoDeck();
  nota.hidden = false;
  nota.innerHTML = identidade
    ? `Mostrando só o que cabe na identidade ${pipsHTML(identidade)} do comandante.`
    : "Comandante incolor: só cartas sem cor aparecem na busca.";
}
