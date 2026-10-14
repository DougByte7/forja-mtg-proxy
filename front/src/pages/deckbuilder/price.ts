/* ------------------------------------------------------------------- preço

   O `preco_usd` que a base local guarda é o do dia da última sincronização e
   serve pra ORDEM DE GRANDEZA — "essa carta é cara?". Quem responde "quanto
   custa comprar" continua sendo o botão de cotar, que vai à LigaMagic e à
   Scryfall na hora (ver `cartas.py`, "O QUE ISTO NÃO É").

   Por isso tudo aqui é conta local, instantânea e sem rede: acompanha cada
   carta adicionada, do mesmo jeito que a curva de mana. E por isso a prévia
   se chama prévia na tela, com o "cotar" logo abaixo dela.

   MOEDA. A base é dólar e quem monta deck aqui pensa em real, então a tela
   mostra real. A regra que sustenta isso: TODO NÚMERO INTERNO CONTINUA EM
   DÓLAR e a conversão acontece na borda, dentro de `money()`. Converter cedo
   — guardar real em `entryPrice`, em `localBudget`, no `data-teto` —
   espalharia a taxa por contas que não são dela e faria o mesmo deck mudar de
   número conforme o dólar do dia sem ninguém ter mexido nele.

   A taxa vem de `GET /cambio` uma vez, ao abrir (ver `abrir`). É aproximação
   e a tela diz isso: todo valor convertido carrega `exchangeNote()` no title,
   com o valor da taxa e se ela veio do câmbio do dia ou do padrão fixo. */

import { redrawAll } from "./redraw";
import { api } from "./save";
import { state } from "./state";
import type { Card } from "./types";

/* Acima disto a carta é "cara" e o valor fica em destaque. Dois números, um
   por mercado, INDEPENDENTES de propósito: US$ 20 lá fora e R$ 100 aqui não
   são a mesma carta convertida — carta que aqui custa desproporcionalmente
   mais é justamente o que o ▲ da cotação existe pra apontar. Amarrar um ao
   outro pela taxa do dia faria o destaque acender e apagar sozinho, sem
   ninguém ter mexido no deck. */
export const PRICEY_USD = 20;
export const PRICEY_BRL = 100;

export function exchangeRate() {
  return state.cambio && state.cambio.valor > 0 ? state.cambio.valor : 0;
}

/* Um valor em dólar, escrito do jeito que a tela mostra.

   Sem taxa (a rota ainda não voltou, ou voltou torta) volta pra dólar em vez
   de multiplicar por zero: "R$ 0,00" em toda carta seria a mesma mentira que
   o `—` de `priceView` existe pra não contar. Dólar é o número honesto que a
   tela tem enquanto não tem o outro. */
export function money(usd: number | null | undefined) {
  const t = exchangeRate();
  const n = Number(usd || 0);
  if (!t) return "US$ " + n.toFixed(2);
  return "R$ " + formatBRL(n * t);
}

/* Um número no formato de dinheiro daqui: ponto no milhar, vírgula no
   centavo. Escrito à mão, e não com `toLocaleString("pt-BR")`, de propósito:
   aquele depende do Intl do interpretador, e onde o Intl não existe ele não
   levanta — devolve "108.6" calado, com o ponto no lugar da vírgula. Foi o
   que o teste do câmbio (hoje `test/prices.test.ts`) pegou. Formato de dinheiro é regra da
   tela, e regra da tela tem que dar pra testar. */
export function formatBRL(n: number) {
  const partes = Math.abs(n).toFixed(2).split(".");
  const milhar = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (n < 0 ? "-" : "") + milhar + "," + partes[1];
}

/* A nota que acompanha todo valor convertido, no title. É ela que faz a
   diferença entre aproximação honesta e número inventado. */
export function exchangeNote() {
  const c = state.cambio;
  if (!c || !(c.valor > 0)) return "Preço em dólar: o câmbio ainda não chegou.";
  return `Convertido a R$ ${c.valor.toFixed(2).replace(".", ",")} por dólar (`
    + (c.fonte === "fixa" ? "taxa padrão do servidor" : "câmbio do dia") + ").";
}

/* O símbolo sozinho, pros lugares que escrevem o número por conta própria.
   Nome comprido porque `desenharCotacao` tem um `const simbolo` local, com
   outro sentido: lá é a moeda DA FONTE cotada, aqui é a moeda da tela. */
export function screenCurrency() {
  return exchangeRate() ? "R$" : "US$";
}

/* O filtro de preço é DIGITADO na moeda da tela e VIAJA em dólar, que é o que
   `cartas.buscar` filtra do outro lado. O rótulo (`#rot-preco-moeda`) e esta
   divisão mudam juntos, sempre: se um dos dois esquecer a taxa, o teto passa a
   valer cinco vezes mais ou menos do que a pessoa pediu, sem nada na tela
   denunciando. Guardamos o que foi digitado, não o convertido, pra o campo
   mostrar de volta o número que a pessoa escreveu. */
export function maxPriceInUsd(typed: number | string) {
  const t = exchangeRate();
  const n = Number(typed);
  return t ? (n / t) : n;
}

/* A taxa, pra tela poder mostrar real. Chamada de dentro de `abrir()`, e não
   na carga do módulo, de propósito: os testes de JS rodam estes módulos sem
   rede e cortam em `abrir();`, então buscar na carga quebraria os testes. E o
   deckbuilder tem que abrir mesmo sem esta rota — sem taxa, tudo cai pra
   dólar e nada mais muda. */
export async function loadExchangeRate() {
  try {
    state.cambio = await api("/cambio");
  } catch {
    return;   // silêncio de propósito: isto é a régua, não o serviço
  }
  redrawAll();
}

/* O preço de uma carta na moeda da tela, ou nada quando a base não tem. */
export function cardPrice(card: Card) {
  return card.preco_usd ? money(card.preco_usd) : "";
}
