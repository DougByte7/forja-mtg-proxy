"use strict";

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

function precoDaEntrada(entrada){
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
  if (cotacaoIndiceDe === estado.cotacao) return cotacaoIndice;
  cotacaoIndiceDe = estado.cotacao;
  cotacaoIndice = new Map();
  const fonte = (estado.cotacao?.fontes || [])[0];
  if (fonte){
    for (const linha of estado.cotacao.linhas || []){
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
function precoUnitario(carta){
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
function precoTexto(p, quantidade){
  if (!p) return "";
  const valor = p.valor * (quantidade || 1);
  if (p.fonte === "base") return moeda(valor);
  return p.moeda === "BRL" ? "R$ " + reais(valor) : "US$ " + valor.toFixed(2);
}

function ehCaro(p){
  if (!p) return false;
  return p.moeda === "BRL" ? p.valor >= CARO_BRL : p.valor >= CARO_USD;
}

/* O subtotal de um grupo, e o que ele é feito de.

   NÃO SOMA MOEDAS DIFERENTES — é a regra que o `cotacao.py` escreve em
   maiúsculas, e ela vale aqui pelo mesmo motivo. A soma acontece toda numa
   moeda só: com câmbio, tudo em real (o cotado entra intacto, o da base é
   convertido); sem câmbio, tudo em dólar, e aí o que só tem preço em real
   fica DE FORA da soma em vez de ser convertido de volta por uma taxa que a
   tela não tem. O que ficou de fora é contado e vai pro title. */
function subtotalDoGrupo(itens){
  const emReais = !!taxa();
  let valor = 0, medidas = 0, estimadas = 0, sem = 0, foraDaSoma = 0;
  for (const e of itens){
    const p = precoUnitario(e.carta);
    if (!p){ sem += e.quantidade; continue; }
    const daBase = p.fonte === "base";
    if (!emReais && !daBase && p.moeda === "BRL"){ foraDaSoma += e.quantidade; continue; }
    // `precoTexto` converte na hora de escrever; aqui a conta precisa do
    // número, então a mesma régua é aplicada à mão, e só ao que é dólar.
    const t = taxa();
    const bruto = p.valor * e.quantidade;
    valor += (emReais && p.moeda === "USD") ? bruto * t : bruto;
    if (daBase) estimadas += e.quantidade; else medidas += e.quantidade;
  }
  return {valor, medidas, estimadas, sem, foraDaSoma, emReais};
}

function subtotalTexto(s){
  if (!s.valor) return "";
  return s.emReais ? "R$ " + reais(s.valor) : "US$ " + s.valor.toFixed(2);
}

function subtotalTitulo(s){
  const partes = [];
  if (s.medidas) partes.push(`${s.medidas} cotada(s) na loja`);
  if (s.estimadas) partes.push(`${s.estimadas} pelo preço da base, convertido`);
  if (s.sem) partes.push(`${s.sem} sem preço conhecido, fora da soma`);
  if (s.foraDaSoma) partes.push(`${s.foraDaSoma} em real, fora da soma até o câmbio chegar`);
  return partes.join(" · ");
}

function valorHTML(entrada){
  const p = precoUnitario(entrada.carta);
  // Carta que ninguém sabe quanto custa não vira "R$ 0,00": zero é um preço,
  // e este é o caso de não saber. O travessão diz isso em um caractere.
  if (!p){
    return `<span class="valor desconhecido"
      title="Nem a loja nem a base local têm preço desta carta.">—</span>`;
  }
  const medido = p.fonte === "cotacao";
  const unidade = entrada.quantidade > 1
    ? `${entrada.quantidade} × ${precoTexto(p)}` : precoTexto(p);
  const titulo = [
    unidade,
    medido
      ? `${p.rotulo}${p.loja ? " · " + p.loja : ""} — cotado agora, sem frete.`
      : "Preço da base local, do dia da última sincronização. " + notaDoCambio(),
  ].join("\n");
  return `<span class="valor ${ehCaro(p) ? "caro" : ""} ${medido ? "" : "estimado"}"
    title="${escapar(titulo)}">${precoTexto(p, entrada.quantidade)}</span>`;
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
function orcamentoLocal(){
  let total = 0, semPreco = 0, fora = 0, cartas = 0;
  for (const entrada of estado.cartas){
    const c = entrada.carta;
    if (!c) continue;
    if (c.basico){ fora += entrada.quantidade; continue; }
    cartas += entrada.quantidade;
    if (!c.preco_usd){ semPreco += entrada.quantidade; continue; }
    total += precoDaEntrada(entrada);
  }
  fora += estado.comandantes.length;
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
function desenharPreviaOrcamento(){
  const botao = $("btn-total");
  const caret = $("btn-cotacao");
  const temDeck = estado.comandantes.length || estado.cartas.length;
  botao.hidden = !temDeck;
  caret.hidden = !temDeck || !(estado.cotacao || estado.cotacaoErro);
  if (!temDeck) return;

  const o = orcamentoLocal();
  const talvez = estado.maybe.reduce((n, e) => n + e.quantidade, 0);
  const partes = [];
  if (o.cartas) partes.push(`${o.cartas} carta(s) contadas`);
  if (o.fora) partes.push(`${o.fora} fora do total (comandante e básicos)`);
  if (o.semPreco) partes.push(`${o.semPreco} sem preço na base`);
  if (talvez) partes.push(`${talvez} no maybeboard, fora da conta`);

  const fonte = (estado.cotacao?.fontes || [])[0];
  const cotado = fonte && fonte.cartas_cotadas;
  // Cotado, o número já vem na moeda da fonte e NÃO passa por `moeda()`: o
  // total da LigaMagic é real de verdade, e o da Scryfall pode já ter vindo
  // convertido pelo `USD_BRL` do .env. Converter aqui converteria duas vezes.
  // Não cotado, é a base local em dólar, e aí sim a régua se aplica.
  const texto = cotado
    ? `${fonte.moeda === "BRL" ? "R$" : "US$"} `
      + Number(fonte.total).toFixed(2).replace(".", ",")
    : moeda(o.total);

  $("total-n").textContent = texto;
  $("total-de").textContent = cotado ? fonte.rotulo : "prévia";
  // Entre mexer no deck e a cotação nova voltar existe uma janela em que o
  // número mostrado é de OUTRO deck. O giro cobre essa janela inteira — a
  // espera e a consulta — em vez de só a consulta.
  const esperando = estado.cotacaoRodando ||
    (estado.id && assinaturaDeCotacao() !== estado.cotacaoAssinatura && o.cartas);
  botao.className = "medidor" + (esperando ? " cotando" : "");
  botao.title = [
    cotado ? `Preço de comprar em ${fonte.rotulo}, cotado agora.`
           : "Soma da base local — a cotação de verdade chega em alguns segundos.",
    cotado ? "" : notaDoCambio(),
    partes.join(" · "),
    "Clique pra copiar a lista do deck.",
  ].filter(Boolean).join("\n");
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

function assinaturaDeCotacao(){
  // O que a cotação cobre (`decks.para_cotacao`): as 99 e o sideboard, sem
  // comandante e sem básico. O maybeboard fica fora — é a razão de ele
  // existir.
  return JSON.stringify(estado.cartas
    .filter(e => e.carta && !e.carta.basico)
    .map(e => [e.carta.nome, e.quantidade]).sort());
}

function agendarCotacao(){
  clearTimeout(cotacaoTimerAgenda);
  if (!estado.id || estado.cotacaoRodando) return;
  if (assinaturaDeCotacao() === estado.cotacaoAssinatura) return;
  if (!orcamentoLocal().cartas) return;   // só básico e comandante: nada a cotar
  cotacaoTimerAgenda = setTimeout(cotar, ESPERA_COTACAO);
}
