/* ------------------------------------------------------------------- desenhar */

import {$} from "../../shared/dom.js";
import {agendarCotacao, desenharPreviaOrcamento} from "./orcamento.js";
import {state, touch} from "./state";
import {LIST_ORDERS, MIN_FOR_TOOLS} from "./lists";
import {syncVersion} from "./versions";

export function desenharTudo(){
  touch();
  desenharDeck();
  desenharMaybe();
  desenharContador();
  syncVersion();
  desenharPreviaOrcamento();
  // A cotação persegue o deck: cada mudança marca uma nova, que só sai depois
  // de o deck ficar quieto.
  agendarCotacao();
}

/* O contador do cabeçalho virou componente (`ui/Meters.tsx`); quem ainda
   chama isto quer só o redesenho. */
export function desenharContador(){
  touch();
}

/* As listas, a caixa do comandante e as contagens viraram componentes
   (`ui/DeckList.tsx`). O que sobra aqui é ligar e desligar as partes da
   página que ainda são marcação fixa — e isso some quando a página inteira
   virar componente. */
export function desenharDeck(){
  touch();
  const temComandante = state.comandantes.length > 0;
  $("heroi").hidden = temComandante;
  $("area-deck").hidden = !temComandante;
  $("corpo").classList.toggle("sem-comandante", !temComandante);
  if (!temComandante) return;
  $("deck-vazio").hidden = state.cartas.length > 0;
  $("ferramentas-deck").hidden =
    state.cartas.length < MIN_FOR_TOOLS.deck && !state.listaBusca.deck;
  escreverBusca("busca-deck", state.listaBusca.deck);
  $("ordem-lista").value = state.listaOrdem;
}

/* O campo só é reescrito quando discorda do estado. Escrever por cima do que
   já está lá manda o cursor pro fim em alguns navegadores — e este campo é
   reescrito a cada tecla digitada nele. */
function escreverBusca(id, texto){
  if ($(id).value !== texto) $(id).value = texto;
}

/* ---------------------------------------------------------------- maybeboard

   A mesma lista, com as mesmas categorias e o mesmo desenho de linha — de
   propósito. Mover uma carta pra cá não pode parecer mudar de programa: é a
   mesma carta, no mesmo deck, com a decisão adiada. O que muda é uma coluna
   só (a área é estreita) e o fato de nada aqui contar em lugar nenhum. */
export function desenharMaybe(){
  touch();
  const n = state.maybe.reduce((soma, e) => soma + e.quantidade, 0);
  $("talvez-vazio").hidden = n > 0;
  $("busca-talvez").hidden =
    state.maybe.length < MIN_FOR_TOOLS.talvez && !state.listaBusca.talvez;
  escreverBusca("busca-talvez", state.listaBusca.talvez);
}

/* Recolher e abrir um grupo. Fica na memória da sessão e não no deck: é como
   a lista está sendo olhada agora, não o que ela é — recarregar a página
   devolve tudo aberto, de propósito. */
export function alternarGrupo(cat, tabuleiro){
  const chave = `${tabuleiro}:${cat}`;
  if (state.gruposFechados.has(chave)) state.gruposFechados.delete(chave);
  else state.gruposFechados.add(chave);
  touch();
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
  state.listaOrdem = LIST_ORDERS[ordem] ? ordem : "cmc";
  desenharDeck();
  desenharMaybe();
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

