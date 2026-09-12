/* ------------------------------------------------------ chances de comprar

   A conta da urna, hipergeométrica: a biblioteca tem N cartas, K delas são da
   categoria, e a pergunta é quantas aparecem nas primeiras compras. O
   comandante não entra na conta — ele começa na zona de comando, não no
   baralho.

   Todas as janelas assumem quem JOGA PRIMEIRO, que é o lado sem a compra do
   turno 1: é o caso pior, e é sobre o caso pior que se decide quantos terrenos
   o deck leva. */

import {$, escapar} from "../comum/dom.js";
import {estado} from "./estado.js";
import {cartasContadas, categoriaAutomatica, categoriaDe,
        ehPropria} from "./utilidades.js";

const VISTAS_MAO = 7;   // a mão inicial
const VISTAS_T3 = 9;    // a mão mais as compras dos turnos 2 e 3
const VISTAS_T4 = 10;   // idem, até o turno 4

/* Fatorial em logaritmo, e não fatorial direto: C(99,10) já passa de 10^13, e
   a divisão de dois números desses perde dígito. Em log tudo vira soma. */
const _logFatorial = [0];
function logFatorial(n){
  for (let i = _logFatorial.length; i <= n; i++){
    _logFatorial[i] = _logFatorial[i - 1] + Math.log(i);
  }
  return _logFatorial[n];
}

function logCombinacoes(n, k){
  if (k < 0 || k > n) return -Infinity;
  return logFatorial(n) - logFatorial(k) - logFatorial(n - k);
}

/* Chance de sair EXATAMENTE `k` cartas da categoria em `n` compras. */
function hipergeometrica(N, K, n, k){
  if (k < 0 || k > K || n - k < 0 || n - k > N - K) return 0;
  return Math.exp(logCombinacoes(K, k) + logCombinacoes(N - K, n - k)
                  - logCombinacoes(N, n));
}

function chanceAoMenos(N, K, n, minimo){
  let soma = 0;
  for (let k = minimo; k <= Math.min(n, K); k++) soma += hipergeometrica(N, K, n, k);
  return soma;
}

function chanceAteh(N, K, n, maximo){
  let soma = 0;
  for (let k = 0; k <= Math.min(maximo, n, K); k++) soma += hipergeometrica(N, K, n, k);
  return soma;
}

/* O primeiro mulligan do Commander é de graça: a mão inteira volta pro
   baralho, você embaralha, compra sete de novo e FICA com as sete — nenhuma
   carta vai pro fundo. São duas mãos de sete tiradas do mesmo baralho
   embaralhado, independentes uma da outra, então a chance de nenhuma das duas
   trazer a carta é a de uma ao quadrado. É a conta de quem dá o mulligan
   justamente quando a primeira mão não traz nada da categoria. */
function chanceComMulligan(N, K, minimo){
  const vazia = 1 - chanceAoMenos(N, K, VISTAS_MAO, minimo);
  return 1 - vazia * vazia;
}

function porcento(p){ return Math.round(p * 100) + "%"; }

/* Os dois riscos da mana base viram um estado escrito, não só uma cor: numa
   base de 36 terrenos em 99 os dois ficam perto de 10%, e é dos dois lados
   dessa marca que a régua foi tirada. */
const ESTADO_DO_RISCO = [
  [0.12, "ok",      "dentro do normal"],
  [0.18, "atencao", "no limite"],
  [1.01, "alto",    "alto"],
];

function riscoDaMana(p){
  return ESTADO_DO_RISCO.find(([teto]) => p <= teto);
}

export function desenharChances(){
  const caixa = $("chances");
  const entradas = cartasContadas();
  const N = entradas.reduce((n, e) => n + e.quantidade, 0);
  if (N < VISTAS_T4){
    caixa.innerHTML = `<div class="vazio" style="padding:8px 0;">Com menos de
      ${VISTAS_T4} cartas na lista ainda não há compra pra calcular.</div>`;
    return;
  }

  // A lista é contada duas vezes, e a tabela mostra os dois recortes.
  //
  // Pela categoria AUTOMÁTICA, a mesma da distribuição de tipos: a pergunta é
  // "quando é que eu vejo uma criatura?", e um deck cujas criaturas estão
  // guardadas em "combo principal" responderia nunca.
  //
  // E pelas categorias PRÓPRIAS, porque "quando é que eu vejo um sac outlet?"
  // é a pergunta que quem montou o deck faz de verdade, e nenhum type_line
  // responde a ela. As duas contagens se sobrepõem de propósito: a mesma carta
  // é um sac outlet E uma criatura, e são duas perguntas sobre ela.
  const porTipo = new Map();
  const porPropria = new Map();
  for (const entrada of entradas){
    const auto = categoriaAutomatica(entrada.carta);
    porTipo.set(auto, (porTipo.get(auto) || 0) + entrada.quantidade);
    const cat = categoriaDe(entrada);
    if (ehPropria(cat)){
      porPropria.set(cat, (porPropria.get(cat) || 0) + entrada.quantidade);
    }
  }

  // As próprias em cima e na ordem em que a pessoa as pôs, como na lista: é a
  // organização dela, e ela vem antes do que a carta é. Os tipos seguem
  // ordenados por tamanho, que é a ordem que ninguém escolheu.
  const proprias = estado.categorias.filter(c => porPropria.has(c))
    .map(c => [c, porPropria.get(c), true]);
  const tipos = [...porTipo.entries()].sort((a, b) => b[1] - a[1])
    .map(([cat, K]) => [cat, K, false]);

  const linhas = [...proprias, ...tipos].map(([cat, K, propria]) => `
    <tr${propria ? ' class="propria"' : ""}>
      <td>${escapar(cat)} <span class="qt">${K}</span></td>
      <td>${porcento(chanceAoMenos(N, K, VISTAS_MAO, 1))}</td>
      <td>${porcento(chanceComMulligan(N, K, 1))}</td>
      <td>${porcento(chanceAoMenos(N, K, VISTAS_T3, 1))}</td>
    </tr>`).join("");

  let html = `<table class="chances">
    <thead><tr>
      <th>Chance de ver 1</th>
      <th title="Na mão inicial de 7 cartas">Mão de 7</th>
      <th title="Na primeira mão ou na do primeiro mulligan, que no Commander é de graça: sete cartas novas, sem devolver nenhuma pro fundo">Com mulligan</th>
      <th title="Nas 9 cartas vistas até o turno 3, jogando primeiro">Até o T3</th>
    </tr></thead>
    <tbody>${linhas}</tbody></table>`;

  const terrenos = porTipo.get("Terrenos") || 0;
  const falta = chanceAteh(N, terrenos, VISTAS_T3, 1);
  const excesso = chanceAoMenos(N, terrenos, VISTAS_T4, 6);
  const [, classeFalta, ditoFalta] = riscoDaMana(falta);
  const [, classeExcesso, ditoExcesso] = riscoDaMana(excesso);
  html += `<div class="risco-duo">
    <div class="risco ${classeFalta}">
      <span class="rot">Falta de mana</span>
      <span class="val">${porcento(falta)}</span>
      <span class="porque"><span class="estado">${ditoFalta}</span> — chegar ao
        turno 3 com um terreno ou nenhum, dois drops perdidos.</span>
    </div>
    <div class="risco ${classeExcesso}">
      <span class="rot">Excesso de mana</span>
      <span class="val">${porcento(excesso)}</span>
      <span class="porque"><span class="estado">${ditoExcesso}</span> — ver 6
        terrenos ou mais até o turno 4, mana que virou carta morta.</span>
    </div>
  </div>`;

  html += `<div class="rodape-conta">
    <b>Como a conta é feita.</b> Distribuição hipergeométrica sobre as ${N}
    cartas da lista — o comandante fica de fora porque começa na zona de
    comando. Tudo jogando primeiro, sem a compra do turno 1, que é o lado pior:
    <b>Mão de 7</b> é a mão inicial, <b>com mulligan</b> é ver a carta na
    primeira mão ou na do primeiro mulligan — que no Commander é grátis, você
    devolve as sete, compra sete outras e fica com elas — e <b>até o T3</b> são
    9 cartas (a mão mais as compras dos turnos 2 e 3); o excesso de mana olha
    10, até o turno 4. As suas categorias vêm em cima, e a mesma carta conta na
    sua categoria e no tipo dela: as linhas não somam 100 porque cada uma
    responde a uma pergunta diferente. Enquanto a lista não fechar em 99, os
    números saem inflados: menos carta no baralho é menos carta pra
    atrapalhar.</div>`;

  caixa.innerHTML = html;
}
