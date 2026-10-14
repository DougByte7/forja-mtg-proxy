/* ------------------------------------------- de onde vem o preço de uma carta

   Duas origens, e a lista prefere sempre a primeira:

   * COTADO — o preço da fonte principal da cotação (a LigaMagic, quando
     ligada). É medido: loja brasileira, em real, buscado agora. A cotação é
     automática (`agendarCotacao`) e fica em cache, então na prática ele já
     está ali quando a lista desenha.
   * BASE — o `preco_usd` da base local, que é dólar do dia da última
     sincronização, convertido pela taxa do câmbio. É estimativa em cima de
     estimativa: preço velho de outro mercado, vezes uma taxa aproximada.

   Entre um preço medido e uma conversão estimada, a lista mostra o medido.
   Mas as duas convivem na mesma tela por força da regra do formato, não por
   descuido: comandante e terreno básico ficam FORA da cotação (Commander 500,
   ver `cotacao.filtrar_cotaveis`) e carta que a loja não tem volta com `erro`.
   Por isso cada linha diz, no tracejado e no title, qual das duas está
   mostrando — um número que esconde de onde veio é pior que número nenhum. */

import {escapar} from "../../shared/dom.js";
import {cotar} from "./cotacao.js";
import {exchangeNote, exchangeRate, formatBRL, money, PRICEY_BRL, PRICEY_USD} from "./price";
import {state, touch} from "./state";

export function precoDaEntrada(entrada){
  return (entrada.carta?.preco_usd || 0) * entrada.quantidade;
}

let cotacaoIndice = null;     // Map: nome achatado -> preço da fonte principal
/* Qual objeto de cotação gerou o índice acima. Começa numa sentinela, e não em
   `null`, de propósito: `estado.cotacao` TAMBÉM é null antes da primeira
   cotação, e aí a comparação de memoização daria certo no primeiro uso e
   devolveria o índice ainda não construído. */
const SEM_COTACAO = {};
let cotacaoIndiceDe = SEM_COTACAO;

/* Casamento por nome. A cotação do deckbuilder já parte dos nomes da base
   local, que são os canônicos da Scryfall — os mesmos dos dois lados. O
   achatamento é cinto de segurança pro dia em que `resolver_nomes` trocar
   alguma coisa no meio do caminho. */
function chaveDeNome(nome){
  return String(nome || "").trim().toLowerCase();
}

/* Refeito só quando a cotação troca de objeto, e não a cada linha desenhada:
   `desenharDeck` chama isto uma vez por carta, e um deck tem 100. */
function indiceDaCotacao(){
  if (cotacaoIndiceDe === state.cotacao) return cotacaoIndice;
  cotacaoIndiceDe = state.cotacao;
  cotacaoIndice = new Map();
  const fonte = (state.cotacao?.fontes || [])[0];
  if (fonte){
    for (const linha of state.cotacao.linhas || []){
      const p = (linha.precos || {})[fonte.id];
      if (!p || p.erro || !p.preco_unitario) continue;
      cotacaoIndice.set(chaveDeNome(linha.nome), {
        valor: p.preco_unitario, moeda: fonte.moeda, fonte: "cotacao",
        rotulo: fonte.rotulo, loja: p.loja || "",
      });
    }
  }
  return cotacaoIndice;
}

/* O preço unitário de uma carta e de onde ele veio, ou null quando ninguém
   sabe. `fonte` é "cotacao" (medido) ou "base" (estimado). */
export function precoUnitario(carta){
  if (!carta) return null;
  const cotado = indiceDaCotacao().get(chaveDeNome(carta.nome));
  if (cotado) return cotado;
  if (!carta.preco_usd) return null;
  return {valor: carta.preco_usd, moeda: "USD", fonte: "base"};
}

/* Escreve um preço que já sabe a própria moeda.

   O cotado passa INTACTO: ele já é real de verdade, e passá-lo pela régua do
   câmbio converteria duas vezes — é o mesmo cuidado que o total do cabeçalho
   toma em `desenharPreviaOrcamento`. Só o da base, que é dólar, é convertido. */
export function precoTexto(p, quantidade){
  if (!p) return "";
  const valor = p.valor * (quantidade || 1);
  if (p.fonte === "base") return money(valor);
  return p.moeda === "BRL" ? "R$ " + formatBRL(valor) : "US$ " + valor.toFixed(2);
}

function ehCaro(p){
  if (!p) return false;
  return p.moeda === "BRL" ? p.valor >= PRICEY_BRL : p.valor >= PRICEY_USD;
}

/* O subtotal de um grupo, e o que ele é feito de.

   NÃO SOMA MOEDAS DIFERENTES — é a regra que o `cotacao.py` escreve em
   maiúsculas, e ela vale aqui pelo mesmo motivo. A soma acontece toda numa
   moeda só: com câmbio, tudo em real (o cotado entra intacto, o da base é
   convertido); sem câmbio, tudo em dólar, e aí o que só tem preço em real
   fica DE FORA da soma em vez de ser convertido de volta por uma taxa que a
   tela não tem. O que ficou de fora é contado e vai pro title. */
export function subtotalDoGrupo(itens){
  const emReais = !!exchangeRate();
  let valor = 0, medidas = 0, estimadas = 0, sem = 0, foraDaSoma = 0;
  for (const e of itens){
    const p = precoUnitario(e.carta);
    if (!p){ sem += e.quantidade; continue; }
    const daBase = p.fonte === "base";
    if (!emReais && !daBase && p.moeda === "BRL"){ foraDaSoma += e.quantidade; continue; }
    // `precoTexto` converte na hora de escrever; aqui a conta precisa do
    // número, então a mesma régua é aplicada à mão, e só ao que é dólar.
    const t = exchangeRate();
    const bruto = p.valor * e.quantidade;
    valor += (emReais && p.moeda === "USD") ? bruto * t : bruto;
    if (daBase) estimadas += e.quantidade; else medidas += e.quantidade;
  }
  return {valor, medidas, estimadas, sem, foraDaSoma, emReais};
}

export function subtotalTexto(s){
  if (!s.valor) return "";
  return s.emReais ? "R$ " + formatBRL(s.valor) : "US$ " + s.valor.toFixed(2);
}

export function subtotalTitulo(s){
  const partes = [];
  if (s.medidas) partes.push(`${s.medidas} cotada(s) na loja`);
  if (s.estimadas) partes.push(`${s.estimadas} pelo preço da base, convertido`);
  if (s.sem) partes.push(`${s.sem} sem preço conhecido, fora da soma`);
  if (s.foraDaSoma) partes.push(`${s.foraDaSoma} em real, fora da soma até o câmbio chegar`);
  return partes.join(" · ");
}

/* O preço de uma linha, como dados: a mesma conta serve o HTML em string
   (abaixo) e o componente (`ui/PriceCell.tsx`). */
export function valorView(entrada){
  const p = precoUnitario(entrada.carta);
  // Carta que ninguém sabe quanto custa não vira "R$ 0,00": zero é um preço,
  // e este é o caso de não saber. O travessão diz isso em um caractere.
  if (!p){
    return {classe: "valor desconhecido", texto: "—",
            titulo: "Nem a loja nem a base local têm preço desta carta."};
  }
  const medido = p.fonte === "cotacao";
  const unidade = entrada.quantidade > 1
    ? `${entrada.quantidade} × ${precoTexto(p)}` : precoTexto(p);
  return {
    classe: `valor ${ehCaro(p) ? "caro" : ""} ${medido ? "" : "estimado"}`,
    texto: precoTexto(p, entrada.quantidade),
    titulo: [
      unidade,
      medido
        ? `${p.rotulo}${p.loja ? " · " + p.loja : ""} — cotado agora, sem frete.`
        : "Preço da base local, do dia da última sincronização. " + exchangeNote(),
    ].join("\n"),
  };
}

export function valorHTML(entrada){
  const v = valorView(entrada);
  return `<span class="${v.classe}" title="${escapar(v.titulo)}">${v.texto}</span>`;
}

/* O preço de uma linha como NÚMERO, pra ordenar a lista por ele.

   É o mesmo valor que a linha ESCREVE — com a quantidade dentro, porque é o
   que está na tela: quem ordena por "mais cara primeiro" está olhando uma
   coluna de valores e espera que ela desça. E é reduzido a uma moeda só pelo
   mesmo caminho do subtotal: com câmbio, tudo em real; sem câmbio, o que só
   tem preço em real fica fora da comparação — não há régua pra convertê-lo.

   `null` é "ninguém sabe o preço desta carta", e quem ordena a resolve pro
   fim da lista nos dois sentidos: não saber não é ser barato nem ser cara. */
export function valorComparavel(entrada){
  const p = precoUnitario(entrada.carta);
  if (!p) return null;
  const t = exchangeRate();
  if (!t && p.moeda === "BRL") return null;
  const unidade = (t && p.moeda === "USD") ? p.valor * t : p.valor;
  return unidade * entrada.quantidade;
}

/* O total do deck, pelo mesmo critério do Commander 500 que a cotação usa
   (`cotacao.filtrar_cotaveis`): comandante e terreno básico ficam de fora.
   Duas contas diferentes pro mesmo deck na mesma tela seriam pior do que
   número nenhum. */
/* O maybeboard NÃO entra aqui, e isso é a razão de ele existir: quem põe
   uma carta em dúvida quer saber quanto o deck custa SEM ela. O sideboard
   entra — é carta que a pessoa quer ter. É a mesma divisão do servidor
   (`decks.para_cotacao`), e as duas precisam concordar, senão a prévia e a
   cotação dão números diferentes pro mesmo deck. */
export function orcamentoLocal(){
  let total = 0, semPreco = 0, fora = 0, cartas = 0;
  for (const entrada of state.cartas){
    const c = entrada.carta;
    if (!c) continue;
    if (c.basico){ fora += entrada.quantidade; continue; }
    cartas += entrada.quantidade;
    if (!c.preco_usd){ semPreco += entrada.quantidade; continue; }
    total += precoDaEntrada(entrada);
  }
  fora += state.comandantes.length;
  return {total, semPreco, fora, cartas};
}

/* O dinheiro, no cabeçalho, ao lado da contagem.

   O número mostrado é o melhor que a tela tem no momento: enquanto a cotação
   automática não voltou, é a soma da base local (marcada como prévia); depois
   dela, é o total de comprar de verdade, na fonte principal. Os dois nunca
   aparecem juntos — duas contas diferentes pro mesmo deck lado a lado seriam
   pior do que número nenhum.

   O detalhamento (quantas cartas contam, quantas ficam de fora, quantas não
   têm preço) fica no título: é conferência de uma vez na vida, e não vale uma
   linha permanente do cabeçalho. */
/* A prévia do cabeçalho virou componente (`ui/Meters.tsx`); quem ainda chama
   isto quer só o redesenho. */
export function desenharPreviaOrcamento(){
  touch();
}

/* ------------------------------------------------------- cotação automática

   A cotação persegue o deck sozinha, sem ninguém apertar nada — e sozinha de
   um jeito que não vira uma raspagem por carta adicionada:

   * espera o deck ficar QUIETO (quem adiciona trinta florestas faz trinta
     mudanças em vinte segundos, e isso é uma cotação, não trinta);
   * só sai se a lista cotável mudou de verdade — trocar o nome do deck ou
     mexer no maybeboard não muda preço nenhum;
   * nunca começa uma segunda enquanto a primeira não voltou. */
const ESPERA_COTACAO = 4000;
let cotacaoTimerAgenda = null;

export function assinaturaDeCotacao(){
  // O que a cotação cobre (`decks.para_cotacao`): as 99 e o sideboard, sem
  // comandante e sem básico. O maybeboard fica fora — é a razão de ele
  // existir.
  return JSON.stringify(state.cartas
    .filter(e => e.carta && !e.carta.basico)
    .map(e => [e.carta.nome, e.quantidade]).sort());
}

export function agendarCotacao(){
  clearTimeout(cotacaoTimerAgenda);
  if (!state.id || state.cotacaoRodando) return;
  if (assinaturaDeCotacao() === state.cotacaoAssinatura) return;
  if (!orcamentoLocal().cartas) return;   // só básico e comandante: nada a cotar
  cotacaoTimerAgenda = setTimeout(cotar, ESPERA_COTACAO);
}
