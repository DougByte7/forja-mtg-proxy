/* ----------------------------------------------------------------- combos

   Uma consulta só ao Commander Spellbook, e só no clique: o deck muda a cada
   carta adicionada, e buscar sozinho viraria uma requisição por clique num
   serviço gratuito. Por isso a tela guarda a assinatura do deck de quando a
   busca rodou e, quando ela deixa de bater, avisa em vez de rebuscar. */

import {$, escapar} from "../comum/dom.js";
import {ganchosDaPrevia} from "./carta.js";
import {adicionar} from "./edicao.js";
import {estado} from "./estado.js";
import {moeda, notaDoCambio} from "./preco.js";
import {api, salvarAgora} from "./salvar.js";
import {cartasContadas, ico, manaEmTexto, toast} from "./utilidades.js";

/* O deck como o servidor o viu quando a busca rodou. Só o que conta: mexer
   no maybeboard ou no sideboard não muda combo nem bracket, e avisar "o deck
   mudou" por causa disso ensinaria a ignorar o aviso. */
let combosRodando = false;

export function assinaturaDoDeck(){
  return JSON.stringify([
    estado.comandantes.map(c => c.nome).sort(),
    cartasContadas().map(e => [e.carta.nome, e.quantidade]).sort(),
  ]);
}

export async function procurarCombos(){
  if (!estado.comandantes.length && !estado.cartas.length){
    toast("Monte alguma coisa antes de procurar combos.");
    return;
  }
  if (!estado.id) await salvarAgora();
  if (!estado.id){ toast("Não consegui salvar o deck antes de buscar."); return; }

  // As duas abas de combo podem pedir a mesma consulta quase junto (abrir uma
  // e a outra em seguida): a segunda desiste em vez de repetir a chamada.
  if (combosRodando) return;
  combosRodando = true;
  // A consulta é uma só e alimenta os dois lugares (o do deck e a lista de
  // compras): os dois esperam juntos.
  const esperando = `<div class="nota">Perguntando ao Spellbook…</div>`;
  $("combos-resultado").innerHTML = esperando;
  $("combos-rail-resultado").innerHTML = esperando;
  try {
    estado.combos = await api(`/decks/${estado.id}/combos`, {method: "POST"});
    estado.combosAssinatura = assinaturaDoDeck();
    estado.combosMexidos = 0;   // a resposta nova já sabe de tudo
  } catch (e){
    // "Não sei" nunca pode virar "não tem combo": são opostos que parecem
    // iguais numa lista vazia.
    const erro = `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    $("combos-resultado").innerHTML = erro;
    $("combos-rail-resultado").innerHTML = erro;
    return;
  } finally {
    combosRodando = false;
  }
  desenharCombos();
}

/* Os combos moram em DOIS lugares, e a divisão não é arbitrária: são duas
   perguntas diferentes que a mesma resposta do Spellbook atende.

   * O que JÁ FECHA no deck é uma leitura da lista — "o que este deck faz" —
     e fica na aba de combos, junto das outras leituras do deck.
   * O que fica a UMA CARTA de fechar é uma lista de compras: cada linha tem
     um botão que põe carta no deck. Isso é a mesma coisa que a busca faz, e
     por isso mora no painel de adicionar, do outro lado da tela.

   Eram os dois na mesma coluna, um embaixo do outro, e a segunda lista (a
   longa, a de doze itens) empurrava a primeira pra fora da vista. */
export function desenharCombos(){
  const dados = estado.combos;
  const noDeck = dados?.no_deck || [];
  const faltando = dados?.faltando_uma || [];

  $("aba-combos-n").textContent = dados ? noDeck.length : "";
  $("rail-combos-n").textContent = dados ? faltando.length : "";

  desenharCombosNoDeck(noDeck, dados);
  desenharCombosFaltando(faltando, dados);
}

/* O aviso de "esta resposta é sobre um deck que não existe mais". Vale pras
   duas listas, e por isso é uma função. */
function avisoDeCombosVelhos(){
  return estado.combosAssinatura !== assinaturaDoDeck()
    ? `<div class="combo-desatualizado">O deck mudou desde esta busca —
       procure de novo pra atualizar.</div>` : "";
}

function desenharCombosNoDeck(noDeck, dados){
  const caixa = $("combos-resultado");
  if (!dados){ caixa.innerHTML = ""; return; }

  const velho = avisoDeCombosVelhos();
  let html = velho;
  // O que a tela fechou sozinha, e o que ela não tem como saber: a carta que
  // entrou pode ter deixado OUTROS combos a uma peça de fechar, e isso só o
  // Spellbook responde. Não vale a pena dizer isso quando a resposta inteira
  // já está marcada como velha — seriam dois avisos sobre a mesma coisa.
  if (estado.combosMexidos && !velho){
    html += `<div class="combo-mexido">${ico("check")} ${estado.combosMexidos} combo(s)
      fecharam aqui na tela com as cartas que você adicionou. Procure de novo
      pra ver os combos <b>novos</b> que essas cartas abriram — essa parte só
      o Spellbook sabe.</div>`;
  }

  html += noDeck.length
    ? noDeck.map(c => comboHTML(c, false)).join("")
    : `<div class="nota">Nenhum combo fechado ainda. Os que estão a uma carta
       de fechar ficam na aba <b>Combos</b> do painel de adicionar.</div>`;

  if (dados.cache){
    html += `<div class="nota" style="margin-top:10px">Resposta guardada de uma
      busca recente com este mesmo deck.</div>`;
  }
  caixa.innerHTML = html;
}

function desenharCombosFaltando(faltando, dados){
  const caixa = $("combos-rail-resultado");
  if (!dados){ caixa.innerHTML = ""; return; }

  let html = avisoDeCombosVelhos();
  if (!faltando.length){
    caixa.innerHTML = html + `<div class="nota">Nenhum combo a uma carta de
      fechar — pelo menos entre os que o Spellbook conhece.</div>`;
    return;
  }
  // Só os primeiros: a lista de "quase lá" de um deck grande passa de 100 e
  // viraria rolagem infinita numa coluna estreita.
  html += faltando.slice(0, 12).map(c => comboHTML(c, true)).join("");
  if (faltando.length > 12){
    html += `<div class="nota">E mais ${faltando.length - 12} — as mais
      populares aparecem primeiro.</div>`;
  }
  caixa.innerHTML = html;
}

function comboHTML(combo, ehSugestao){
  // Os mesmos ganchos que a busca e a lista do deck já usam: a prévia de arte
  // é uma função só pra tela inteira (ver `ligarPrevia`), e a peça do combo
  // entra nela só por carregar os atributos.
  const pecas = combo.pecas.map(p => {
    const arte = ganchosDaPrevia(p);
    const preco = p.preco_usd ? ` — ${moeda(p.preco_usd)}` : "";
    const titulo = p.tipo ? `${escapar(p.tipo)}${escapar(preco)}` : "";
    return `<span class="peca ${p.no_deck ? "tem" : "falta"} ${p.comandante ? "comandante" : ""}"
      ${arte}${titulo ? ` title="${titulo}"` : ""}>${escapar(p.nome)}</span>`;
  }).join('<span class="mais"> + </span>');

  const genericas = combo.requer.length
    ? `<span class="mais"> + </span>` + combo.requer.map(r =>
        `<span class="peca generica"
          title="Critério, não carta: qualquer carta do deck que se encaixe serve."
         >${escapar(r)}</span>`).join('<span class="mais"> + </span>')
    : "";

  const produz = combo.produz.length
    ? `<div class="produz"><b>Resulta em:</b> ${escapar(combo.produz.join(", "))}</div>`
    : "";

  // O que o combo pede antes de funcionar — mana disponível, permanente já
  // desvirado, oponente com criatura em jogo. Sem isto a lista dizia o que o
  // combo FAZ e escondia o que ele CUSTA pra acontecer, que é metade da
  // decisão de colocá-lo no deck.
  const precisa = [];
  if (combo.mana) precisa.push(`<b>Mana:</b> ${manaEmTexto(combo.mana)}`);
  if (combo.prerequisitos) precisa.push(escapar(combo.prerequisitos));
  const prereq = precisa.length
    ? `<div class="precisa">${precisa.join("<br>")}</div>` : "";

  // O botão só aparece pra peça que é CARTA. Peça genérica ("uma criatura com
  // vigilância") não tem o que adicionar com um clique — é critério, não carta.
  const faltante = combo.pecas.find(p => !p.no_deck);
  const podeAdicionar = ehSugestao && combo.faltam.length === 1 && faltante;
  const botao = podeAdicionar
    ? (faltante.na_base === false
        ? `<button class="add-peca" disabled
            title="A base local não conhece esta carta — ela pode ser nova demais.
Sincronize a base e tente de novo.">${ico("plus")} ${escapar(faltante.nome)}</button>`
        : `<button class="add-peca" data-add-peca="${escapar(faltante.nome)}"
            >${ico("plus")} ${escapar(faltante.nome)}${faltante.preco_usd
              ? ` · ${moeda(faltante.preco_usd)}` : ""}</button>`)
    : "";

  const bracket = combo.bracket_rotulo
    ? `<span class="bracket ${escapar(combo.bracket)}"
        title="${escapar(combo.bracket_explicacao)}">${escapar(combo.bracket_rotulo)}</span>`
    : "";

  return `<div class="combo ${ehSugestao ? "falta" : ""}">
    <div class="topo-combo"><div class="pecas">${pecas}${genericas}</div></div>
    ${produz}
    ${prereq}
    <div class="rodape">
      ${bracket}
      ${custoHTML(combo, ehSugestao)}
      <a href="${escapar(combo.link)}" target="_blank" rel="noopener">ver no Spellbook ${ico("arrow-square-out")}</a>
      ${botao}
    </div>
  </div>`;
}

/* Quanto custa o combo, em dólar da base local.

   São dois números diferentes e a tela mostra o que responde a pergunta de
   cada lista. Num combo que o deck JÁ tem, a pergunta é "quanto desse deck é
   este combo" — o total das peças. Num que falta uma carta, é "quanto me
   custa fechar" — só o que ainda não está lá, que costuma ser bem menos e é
   o número que decide o clique.

   Peça sem preço conhecido faz o total virar "a partir de": um combo que
   depende de uma carta cujo preço a base não tem não custa menos por isso. */
function custoHTML(combo, ehSugestao){
  const fechar = ehSugestao && combo.faltam.length >= 1;
  const valor = fechar ? combo.custo_faltando_usd : combo.custo_usd;
  const semPreco = fechar ? combo.pecas_faltando_sem_preco : combo.pecas_sem_preco;
  if (!valor && !semPreco) return "";

  const titulo = fechar
    ? "Preço das peças que faltam, pela base local."
    : `Preço das ${combo.pecas.length} peças, pela base local.`;

  // Soma zero COM peça sem preço não é "de graça", é "não sei": todas as
  // peças que entrariam na conta são justamente as desconhecidas. Mostrar
  // "US$ 0,00" aí seria a mentira mais cara que esta tela saberia contar.
  if (!valor){
    return `<span class="custo" title="${escapar(titulo + " A base local não tem " +
      "preço de nenhuma delas — costuma ser carta nova, com a base atrasada.")}"
      >preço ?</span>`;
  }
  const rotulo = (semPreco ? "a partir de " : "") + moeda(valor);
  const ressalva = semPreco
    ? ` ${semPreco} peça(s) sem preço conhecido ficam de fora da soma.`
    : " Não é cotação: é o preço do dia da última sincronização.";
  return `<span class="custo ${fechar ? "fechar" : ""}"
    title="${escapar(titulo + ressalva + " " + notaDoCambio())}"
    >${fechar ? "fechar por " : ""}${rotulo}</span>`;
}

/* Adiciona a carta que falta pra fechar um combo. O nome vem do Spellbook,
   que usa o nome canônico da Scryfall — o mesmo que a base local guarda —,
   então a resolução é por nome exato e não por busca difusa. */
export async function adicionarPeca(nome, botao){
  botao.disabled = true;
  try {
    const r = await api("/cartas/busca?" + new URLSearchParams({q: nome, limite: "5"}));
    const alvo = (r.cartas || []).find(c => c.nome.toLowerCase() === nome.toLowerCase())
              || (r.cartas || [])[0];
    if (!alvo){
      toast(`Não achei "${nome}" na base local — talvez ela precise sincronizar.`);
      botao.disabled = false;
      return;
    }
    adicionar(alvo);
    const fechados = fecharCombosCom(alvo.nome);
    toast(fechados
      ? `${alvo.nome} entrou no deck e fechou ${fechados} combo(s).`
      : `${alvo.nome} entrou no deck.`);
    desenharCombos();
  } catch (e){
    toast("Não consegui adicionar: " + e.message);
    botao.disabled = false;
  }
}

/* A carta entrou no deck: os combos que a esperavam passam pra "no deck".

   A conta é local e exata — sabemos qual carta entrou e quais combos a citam
   — e evita gastar uma requisição num serviço gratuito só pra confirmar o que
   a própria tela acabou de fazer.

   O que NÃO dá pra saber daqui é o contrário — que combos NOVOS essa carta
   deixou a uma peça de fechar. Por isso a assinatura é atualizada (o aviso de
   "o deck mudou" seria mentira, já que a lista está em dia com o deck) e no
   lugar dele fica um recado dizendo o que ainda vale rebuscar.

   Devolve quantos combos fecharam, pra quem chamou saber o que dizer. */
function fecharCombosCom(nome){
  const dados = estado.combos;
  if (!dados) return 0;
  const alvo = nome.toLowerCase();
  const fecharam = [];

  // Marca a peça em TODOS os combos das duas listas: a mesma carta pode ser
  // peça de vários, e marcar só no combo clicado deixaria os outros mentindo.
  for (const lista of [dados.no_deck || [], dados.faltando_uma || []]){
    for (const combo of lista){
      for (const peca of combo.pecas || []){
        if (peca.nome.toLowerCase() === alvo) peca.no_deck = true;
      }
      const faltantes = (combo.pecas || []).filter(p => !p.no_deck);
      combo.faltam = faltantes.map(p => p.nome);
      combo.custo_faltando_usd = Number(faltantes
        .reduce((soma, p) => soma + (p.preco_usd || 0), 0).toFixed(2));
      combo.pecas_faltando_sem_preco = faltantes.filter(p => !p.preco_usd).length;
    }
  }

  // Combo sem peça faltando muda de lista. `requer` (peça genérica: "uma
  // criatura com vigilância") NÃO impede: o Spellbook já contava o combo como
  // "a uma carta" com esse requisito em aberto, então quem decide se ele está
  // fechado é a lista de cartas, do mesmo jeito que lá.
  dados.faltando_uma = (dados.faltando_uma || []).filter(combo => {
    if (combo.faltam.length) return true;
    fecharam.push(combo);
    return false;
  });
  dados.no_deck = fecharam.concat(dados.no_deck || []);

  if (fecharam.length){
    estado.combosMexidos += fecharam.length;
    // A lista voltou a bater com o deck: o aviso de "procure de novo" seria
    // falso agora. O recado do `combosMexidos` toma o lugar dele.
    estado.combosAssinatura = assinaturaDoDeck();
  }
  return fecharam.length;
}
