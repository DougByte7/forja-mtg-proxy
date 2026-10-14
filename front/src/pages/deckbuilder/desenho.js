/* ------------------------------------------------------------------- desenhar */

import {$, escapar} from "../../shared/dom.js";
import {botaoDeArte} from "./artes.js";
import {atualizarCategoriasDoDestino} from "./busca.js";
import {ganchosDaPrevia} from "./carta.js";
import {desenharCombos} from "./combos.js";
import {categoryOf, categoryOrder, deckIdentity, isCustomCategory, totalCards} from "./deck";
import {atualizarBotaoPedido, desenharGaleria} from "./galeria.js";
import {agendarCotacao, desenharPreviaOrcamento, subtotalDoGrupo,
        subtotalTexto, subtotalTitulo, valorComparavel, valorHTML} from "./orcamento.js";
import {screenCurrency} from "./price";
import {OUT_OF_COUNT, state, touch} from "./state";
import {foldAccents} from "./text";
import {ico, manaHTML, seloInedita} from "./utilidades.js";
import {syncVersion} from "./versions";

export function desenharTudo(){
  touch();
  desenharDeck();
  desenharMaybe();
  desenharGaleria();
  atualizarBotaoPedido();
  desenharContador();
  syncVersion();
  desenharPreviaOrcamento();
  $("rot-preco-moeda").textContent = screenCurrency();
  atualizarCategoriasDoDestino();
  // Redesenha os combos pra o aviso de "o deck mudou desde esta busca"
  // aparecer no mesmo instante em que ele passa a ser verdade.
  if (state.combos) desenharCombos();
  // A cotação persegue o deck: cada mudança marca uma nova, que só sai depois
  // de o deck ficar quieto.
  agendarCotacao();
}

/* O contador do cabeçalho virou componente (`ui/Meters.tsx`); quem ainda
   chama isto quer só o redesenho. */
export function desenharContador(){
  touch();
}

export function desenharDeck(){
  const temComandante = state.comandantes.length > 0;
  $("heroi").hidden = temComandante;
  $("area-deck").hidden = !temComandante;
  $("corpo").classList.toggle("sem-comandante", !temComandante);
  $("aba-deck-n").textContent = totalCards();
  if (!temComandante) return;

  const identidade = deckIdentity();
  $("cmd-box").innerHTML = state.comandantes.map((c, i) => `
    <button class="ver" data-ver-cmd="${i}"${ganchosDaPrevia(c)}
            title="Ver ${escapar(c.nome)} inteira">
      <img src="${escapar(c.imagem)}" alt="" loading="lazy">
      <span class="dados">
        <b>${escapar(c.nome)}</b>
        <small>${escapar(c.tipo)}</small>
      </span>
      ${seloInedita(c)}
    </button>
    <div class="mana">${manaHTML(c.mana_cost)}</div>
    ${botaoDeArte(c)}
    <button class="mini sai" data-tirar-cmd="${i}" title="Trocar comandante">${ico("x")}</button>
  `).join('<div style="width:100%;height:1px;background:var(--border)"></div>');

  // Segundo comandante só faz sentido quando o primeiro tem parceria.
  if (state.comandantes.length === 1 && state.comandantes[0].parceiro){
    $("cmd-box").insertAdjacentHTML("beforeend",
      `<button class="btn" id="btn-parceiro" style="width:100%;margin-top:8px;">
         ${ico("plus")} Adicionar parceiro</button>`);
  }

  $("lista-deck").innerHTML = gruposHTML(state.cartas, identidade, "deck");
  $("deck-vazio").hidden = state.cartas.length > 0;
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
    state.cartas.length < MINIMO_PRA_FERRAMENTAS.deck && !state.listaBusca.deck;
  escreverBusca("busca-deck", state.listaBusca.deck);
  $("ordem-lista").value = state.listaOrdem;
}

/* O campo só é reescrito quando discorda do estado. Escrever por cima do que
   já está lá manda o cursor pro fim em alguns navegadores — e este campo é
   reescrito a cada tecla digitada nele. */
function escreverBusca(id, texto){
  if ($(id).value !== texto) $(id).value = texto;
}

/* ------------------------------------------------------ ordem dentro do grupo

   A ordem vale DENTRO de cada categoria; a ordem dos grupos é outra coisa
   (`categoryOrder`) e continua sendo a decisão de quem monta.

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
  const n = state.maybe.reduce((soma, e) => soma + e.quantidade, 0);
  $("talvez-n").hidden = !n;
  $("talvez-n").textContent = n;
  $("talvez-vazio").hidden = n > 0;
  $("busca-talvez").hidden =
    state.maybe.length < MINIMO_PRA_FERRAMENTAS.talvez && !state.listaBusca.talvez;
  escreverBusca("busca-talvez", state.listaBusca.talvez);
  $("talvez-lista").innerHTML = n
    ? gruposHTML(state.maybe, deckIdentity(), "talvez") : "";
}

/* Os grupos de uma lista, do jeito que as duas áreas desenham.

   As categorias próprias VAZIAS aparecem mesmo sem carta, e só no deck: uma
   categoria recém-criada que não se vê na tela parece não ter sido criada, e
   é justamente nela que a próxima carta vai. No maybeboard elas não
   aparecem — dez grupos vazios numa coluna de 288px seriam a coluna
   inteira. */
export function gruposHTML(entradas, identidade, tabuleiro){
  const porCategoria = new Map();
  for (const entrada of entradas){
    const cat = categoryOf(entrada);
    if (!porCategoria.has(cat)) porCategoria.set(cat, []);
    porCategoria.get(cat).push(entrada);
  }

  let ordem = categoryOrder(entradas);
  if (tabuleiro === "talvez") ordem = ordem.filter(c => porCategoria.has(c));

  // Procurar é uma pergunta sobre a lista inteira, e ela atravessa os dois
  // estados que escondem carta: os grupos recolhidos se abrem e as categorias
  // vazias somem. Nenhum dos dois é apagado — os recolhidos voltam a fechar
  // quando a busca sai do campo.
  const procurado = foldAccents(state.listaBusca[tabuleiro] || "").trim();
  const casa = (e) => foldAccents(e.carta.nome).includes(procurado);

  const html = ordem.map(cat => {
    const todos = porCategoria.get(cat) || [];
    const itens = procurado ? todos.filter(casa) : todos.slice();
    if (procurado && !itens.length) return "";
    itens.sort(ORDENS_DA_LISTA[state.listaOrdem] || ORDENS_DA_LISTA.cmc);
    // A conta do cabeçalho é sempre a do GRUPO, não a do que sobrou do
    // filtro: ela é o número de cartas que o deck tem ali, e uma busca não
    // muda isso. Com filtro ligado ela ganha o "de", que diz as duas coisas.
    const n = todos.reduce((soma, e) => soma + e.quantidade, 0);
    const nFiltrado = itens.reduce((soma, e) => soma + e.quantidade, 0);
    const contaTexto = procurado ? `${nFiltrado} de ${n}` : String(n);
    const fechado = !procurado && state.gruposFechados.has(`${tabuleiro}:${cat}`);
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
    const propria = isCustomCategory(cat);
    const fora = OUT_OF_COUNT.has(cat);
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
      “${escapar(state.listaBusca[tabuleiro].trim())}” ${tabuleiro === "talvez"
        ? "no maybeboard" : "no deck"}.</div>`;
  }
  return html;
}

/* Recolher e abrir um grupo. Fica na memória da sessão e não no deck: é como
   a lista está sendo olhada agora, não o que ela é — recarregar a página
   devolve tudo aberto, de propósito. */
export function alternarGrupo(cat, tabuleiro){
  const chave = `${tabuleiro}:${cat}`;
  if (state.gruposFechados.has(chave)) state.gruposFechados.delete(chave);
  else state.gruposFechados.add(chave);
  if (tabuleiro === "talvez") desenharMaybe(); else desenharDeck();
}

/* O que se digitou pra achar uma carta já adicionada. Redesenha SÓ a lista
   mexida: o campo mora fora dela, então continua com o foco e o cursor onde
   estavam — e a cotação, a curva e o resto não têm por que recalcular por
   causa de uma letra digitada. */
export function procurarNaLista(tabuleiro, texto){
  state.listaBusca[tabuleiro] = texto;
  if (tabuleiro === "talvez") desenharMaybe(); else desenharDeck();
}

export function ordenarLista(ordem){
  state.listaOrdem = ORDENS_DA_LISTA[ordem] ? ordem : "cmc";
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
  // A carta que ainda não saiu também é ilegal hoje, e não é problema: ela
  // vira legal sozinha no dia do lançamento, e a etiqueta ao lado do nome já
  // diz isso sem pintar a linha de vermelho por três semanas. Mesma divisão
  // do `decks.validar`, que a aponta como aviso.
  const problema = tabuleiro === "deck"
    && (fora.length || repetida || (!c.legal && !c.inedita));
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
    ${seloInedita(c)}
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
/* A análise (apontamentos, curva, distribuição, chances) e os alertas em
   cima da lista viraram componentes (`ui/Analysis.tsx`); quem ainda chama
   isto quer só o redesenho. */
export function desenharAnalise(){
  touch();
}

