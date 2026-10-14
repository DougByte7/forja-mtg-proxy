/* ------------------------------------------- de onde vem o preço de uma carta

   Duas origens, e a lista prefere sempre a primeira:

   * COTADO — o preço da fonte principal da cotação (a LigaMagic, quando
     ligada). É medido: loja brasileira, em real, buscado agora. A cotação é
     automática (`scheduleQuote`) e fica em cache, então na prática ele já
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
import { signal } from "@preact/signals";
import { exchangeNote, exchangeRate, formatBRL, money, PRICEY_BRL, PRICEY_USD } from "./price";
import { api, saveNow } from "./save";
import { state, touch } from "./state";
import type { Card, Entry } from "./types";

export type UnitPrice = { valor: number; moeda: "BRL" | "USD"; fonte: "cotacao" | "base"; rotulo?: string; loja?: string };

export function entryPrice(entry: Entry) {
  return (entry.carta?.preco_usd || 0) * entry.quantidade;
}

let quoteIndex: Map<string, UnitPrice> | null = null;   // nome achatado -> preço da fonte principal
/* Qual objeto de cotação gerou o índice acima. Começa numa sentinela, e não em
   `null`, de propósito: `state.quote` TAMBÉM é null antes da primeira
   cotação, e aí a comparação de memoização daria certo no primeiro uso e
   devolveria o índice ainda não construído. */
const NO_QUOTE = {};
let quoteIndexOf: unknown = NO_QUOTE;

/* Casamento por nome. A cotação do deckbuilder já parte dos nomes da base
   local, que são os canônicos da Scryfall — os mesmos dos dois lados. O
   achatamento é cinto de segurança pro dia em que `resolver_nomes` trocar
   alguma coisa no meio do caminho. */
function nameKey(name: string | undefined) {
  return String(name || "").trim().toLowerCase();
}

/* Refeito só quando a cotação troca de objeto, e não a cada linha desenhada:
   a lista chama isto uma vez por carta, e um deck tem 100. */
function indexOfQuote() {
  if (quoteIndexOf === state.quote) return quoteIndex!;
  quoteIndexOf = state.quote;
  quoteIndex = new Map();
  const source = (state.quote?.fontes || [])[0];
  if (source) {
    for (const line of state.quote.linhas || []) {
      const p = (line.precos || {})[source.id];
      if (!p || p.erro || !p.preco_unitario) continue;
      quoteIndex.set(nameKey(line.nome), {
        valor: p.preco_unitario, moeda: source.moeda, fonte: "cotacao", rotulo: source.rotulo, loja: p.loja || "",
      });
    }
  }
  return quoteIndex;
}

/* O preço unitário de uma carta e de onde ele veio, ou null quando ninguém
   sabe. `fonte` é "cotacao" (medido) ou "base" (estimado). */
export function unitPrice(card: Card | null | undefined): UnitPrice | null {
  if (!card) return null;
  const quoted = indexOfQuote().get(nameKey(card.nome));
  if (quoted) return quoted;
  if (!card.preco_usd) return null;
  return { valor: card.preco_usd, moeda: "USD", fonte: "base" };
}

/* Escreve um preço que já sabe a própria moeda.

   O cotado passa INTACTO: ele já é real de verdade, e passá-lo pela régua do
   câmbio converteria duas vezes — é o mesmo cuidado que o total do cabeçalho
   toma. Só o da base, que é dólar, é convertido. */
export function priceText(p: UnitPrice | null, quantity?: number) {
  if (!p) return "";
  const value = p.valor * (quantity || 1);
  if (p.fonte === "base") return money(value);
  return p.moeda === "BRL" ? "R$ " + formatBRL(value) : "US$ " + value.toFixed(2);
}

function isPricey(p: UnitPrice | null) {
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
export function groupSubtotal(items: Entry[]) {
  const inReais = !!exchangeRate();
  let valor = 0, medidas = 0, estimadas = 0, sem = 0, foraDaSoma = 0;
  for (const e of items) {
    const p = unitPrice(e.carta);
    if (!p) { sem += e.quantidade; continue; }
    const fromBase = p.fonte === "base";
    if (!inReais && !fromBase && p.moeda === "BRL") { foraDaSoma += e.quantidade; continue; }
    // `priceText` converte na hora de escrever; aqui a conta precisa do
    // número, então a mesma régua é aplicada à mão, e só ao que é dólar.
    const raw = p.valor * e.quantidade;
    valor += (inReais && p.moeda === "USD") ? raw * exchangeRate()! : raw;
    if (fromBase) estimadas += e.quantidade; else medidas += e.quantidade;
  }
  return { valor, medidas, estimadas, sem, foraDaSoma, emReais: inReais };
}

export type Subtotal = ReturnType<typeof groupSubtotal>;

export function subtotalText(s: Subtotal) {
  if (!s.valor) return "";
  return s.emReais ? "R$ " + formatBRL(s.valor) : "US$ " + s.valor.toFixed(2);
}

export function subtotalTitle(s: Subtotal) {
  const parts: string[] = [];
  if (s.medidas) parts.push(`${s.medidas} cotada(s) na loja`);
  if (s.estimadas) parts.push(`${s.estimadas} pelo preço da base, convertido`);
  if (s.sem) parts.push(`${s.sem} sem preço conhecido, fora da soma`);
  if (s.foraDaSoma) parts.push(`${s.foraDaSoma} em real, fora da soma até o câmbio chegar`);
  return parts.join(" · ");
}

/* O preço de uma linha, como dados (o desenho é `ui/CardBits.tsx`). */
export function priceView(entry: Entry) {
  const p = unitPrice(entry.carta);
  // Carta que ninguém sabe quanto custa não vira "R$ 0,00": zero é um preço,
  // e este é o caso de não saber. O travessão diz isso em um caractere.
  if (!p) {
    return { classe: "valor desconhecido", texto: "—", titulo: "Nem a loja nem a base local têm preço desta carta." };
  }
  const measured = p.fonte === "cotacao";
  const unit = entry.quantidade > 1 ? `${entry.quantidade} × ${priceText(p)}` : priceText(p);
  return {
    classe: `valor ${isPricey(p) ? "caro" : ""} ${measured ? "" : "estimado"}`,
    texto: priceText(p, entry.quantidade),
    titulo: [
      unit,
      measured
        ? `${p.rotulo}${p.loja ? " · " + p.loja : ""} — cotado agora, sem frete.`
        : "Preço da base local, do dia da última sincronização. " + exchangeNote(),
    ].join("\n"),
  };
}

/* O preço de uma linha como NÚMERO, pra ordenar a lista por ele.

   É o mesmo valor que a linha ESCREVE — com a quantidade dentro, porque é o
   que está na tela: quem ordena por "mais cara primeiro" está olhando uma
   coluna de valores e espera que ela desça. E é reduzido a uma moeda só pelo
   mesmo caminho do subtotal: com câmbio, tudo em real; sem câmbio, o que só
   tem preço em real fica fora da comparação — não há régua pra convertê-lo.

   `null` é "ninguém sabe o preço desta carta", e quem ordena a resolve pro
   fim da lista nos dois sentidos: não saber não é ser barato nem ser cara. */
export function sortablePrice(entry: Entry) {
  const p = unitPrice(entry.carta);
  if (!p) return null;
  const rate = exchangeRate();
  if (!rate && p.moeda === "BRL") return null;
  const unit = (rate && p.moeda === "USD") ? p.valor * rate : p.valor;
  return unit * entry.quantidade;
}

/* O total do deck, pelo mesmo critério do Commander 500 que a cotação usa
   (`cotacao.filtrar_cotaveis`): comandante e terreno básico ficam de fora.

   O maybeboard NÃO entra aqui, e isso é a razão de ele existir: quem põe
   uma carta em dúvida quer saber quanto o deck custa SEM ela. O sideboard
   entra — é carta que a pessoa quer ter. É a mesma divisão do servidor
   (`decks.para_cotacao`), e as duas precisam concordar, senão a prévia e a
   cotação dão números diferentes pro mesmo deck. */
export function localBudget() {
  let total = 0, semPreco = 0, fora = 0, cartas = 0;
  for (const entry of state.cards) {
    const c = entry.carta;
    if (!c) continue;
    if (c.basico) { fora += entry.quantidade; continue; }
    cartas += entry.quantidade;
    if (!c.preco_usd) { semPreco += entry.quantidade; continue; }
    total += entryPrice(entry);
  }
  fora += state.commanders.length;
  return { total, semPreco, fora, cartas };
}

/* ------------------------------------------------------- cotação automática

   A cotação persegue o deck sozinha, sem ninguém apertar nada — e sozinha de
   um jeito que não vira uma raspagem por carta adicionada:

   * espera o deck ficar QUIETO (quem adiciona trinta florestas faz trinta
     mudanças em vinte segundos, e isso é uma cotação, não trinta);
   * só sai se a lista cotável mudou de verdade — trocar o nome do deck ou
     mexer no maybeboard não muda preço nenhum;
   * nunca começa uma segunda enquanto a primeira não voltou. */
const QUOTE_DELAY = 4000;
let scheduled: ReturnType<typeof setTimeout> | undefined;
let polling: ReturnType<typeof setTimeout> | undefined;

export function quoteSignature() {
  // O que a cotação cobre (`decks.para_cotacao`): as 99 e o sideboard, sem
  // comandante e sem básico. O maybeboard fica fora — é a razão de ele
  // existir.
  return JSON.stringify(state.cards
    .filter((e) => e.carta && !e.carta.basico)
    .map((e) => [e.carta.nome, e.quantidade]).sort());
}

export function scheduleQuote() {
  clearTimeout(scheduled);
  if (!state.id || state.quoteLoading) return;
  if (quoteSignature() === state.quotedSignature) return;
  if (!localBudget().cartas) return;   // só básico e comandante: nada a cotar
  scheduled = setTimeout(runQuote, QUOTE_DELAY);
}

export async function runQuote() {
  if (state.quoteLoading) return;
  if (!state.id) await saveNow();
  if (!state.id) return;
  // A assinatura é gravada ANTES da resposta: se o deck mudar durante a
  // cotação, `scheduleQuote` vê a diferença e marca outra pra depois desta.
  state.quotedSignature = quoteSignature();
  state.quoteLoading = true;
  state.quoteError = null;
  touch();
  try {
    const start = await api(`/decks/${state.id}/cotacao`, { method: "POST" });
    followQuote(start.job_id);
  } catch (e) {
    finishQuote(null, (e as Error).message);
  }
}

/* Fim de cotação, com sucesso ou não, num lugar só: são quatro caminhos de
   saída (erro ao começar, erro no meio, erro do servidor, pronto) e cada um
   precisa desligar o giro, guardar o resultado e redesenhar — a lista
   inclusive, porque cada carta que a loja achou troca o preço estimado da
   base pelo medido. */
function finishQuote(result: unknown, error: string | null) {
  clearTimeout(polling);
  state.quoteLoading = false;
  state.quoteError = error || null;
  if (result) state.quote = result;
  touch();
  // O deck pode ter mudado enquanto o servidor cotava: se mudou, esta
  // resposta já nasce velha e a próxima é marcada agora.
  scheduleQuote();
}

/* Uma pergunta de cada vez, 2s depois da resposta anterior — e não de 2 em
   2s cravados. Cada pergunta faz a cotação andar um pedaço no servidor e
   pode levar alguns segundos pra voltar; com intervalo fixo elas se
   empilhariam. */
function followQuote(jobId: string) {
  clearTimeout(polling);
  const step = async () => {
    try {
      const r = await api(`/cotacao/${jobId}`);
      if (r.estado === "cotando") {
        polling = setTimeout(step, 2000);
        return;
      }
      if (r.estado === "erro") finishQuote(null, r.detalhe);
      else finishQuote(r.resultado, null);
    } catch (e) {
      finishQuote(null, (e as Error).message);
    }
  };
  step();
}

/* ------------------------------------------------- popover da cotação */

/* Aberto, guarda onde o ⌄ que o abriu está: a caixa se põe embaixo dele. */
export const quoteBox = signal<DOMRect | null>(null);

export function toggleQuote(anchor: Element) {
  quoteBox.value = quoteBox.value ? null : anchor.getBoundingClientRect();
}

export function closeQuote() {
  quoteBox.value = null;
}
