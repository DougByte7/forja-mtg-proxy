/* ------------------------------------------------------- validação instantânea

   Mesmas regras do `decks.validar` no servidor, na versão que roda a cada
   clique. Ela é substituída pela do servidor assim que o autosave responde;
   existe porque esperar a rede pra dizer "essa carta é de outra cor" tornaria
   a tela lenta justamente no momento em que a informação importa. */

import {$} from "../comum/dom.js";
import {desenharAnalise, desenharContador} from "./desenho.js";
import {estado} from "./estado.js";
import {atualizarBotaoPedido} from "./galeria.js";
import {analisarManabase} from "./manabase.js";
import {agendarCotacao} from "./orcamento.js";
import {buscarTokens} from "./tokens.js";
import {identidadeDoDeck, totalCartas} from "./utilidades.js";
function validarLocal(){
  const identidade = identidadeDoDeck();
  const apontamentos = [];
  const total = totalCartas();

  if (!estado.comandantes.length){
    apontamentos.push({nivel:"erro", tipo:"sem-comandante",
      mensagem:"Todo deck de Commander começa por um comandante."});
  }
  if (total < 100){
    apontamentos.push({nivel:"erro", tipo:"faltam",
      mensagem:`Faltam ${100 - total} carta(s) pras 100 do formato.`});
  } else if (total > 100){
    apontamentos.push({nivel:"erro", tipo:"sobram",
      mensagem:`São ${total - 100} carta(s) além das 100 do formato.`});
  }

  // O maybeboard não passa por aqui: é rascunho, e acusar identidade de cor
  // numa carta que a pessoa ainda está pensando se usa seria alarme sobre
  // uma decisão que ela nem tomou. O sideboard passa — fora da CONTA não é
  // fora das REGRAS, e uma carta guardada pra trocar depois precisa caber no
  // deck em que vai entrar. Mesma divisão do `decks.validar`.
  for (const {carta, quantidade} of estado.cartas){
    if (!carta) continue;
    if (quantidade > 1 && !carta.basico && !carta.ilimitada){
      apontamentos.push({nivel:"erro", tipo:"singleton", carta:carta.nome,
        mensagem:`${carta.nome}: ${quantidade} cópias. Commander é singleton.`});
    }
    if (!carta.legal){
      apontamentos.push({nivel:"erro", tipo:"banida", carta:carta.nome,
        mensagem:`${carta.nome} não é legal em Commander.`});
    }
    const fora = (carta.identidade||"").split("").filter(c => !identidade.includes(c));
    if (fora.length){
      apontamentos.push({nivel:"erro", tipo:"identidade", carta:carta.nome,
        mensagem:`${carta.nome} tem ${fora.join("")} na identidade de cor, que o comandante não tem.`});
    }
  }
  const erros = apontamentos.filter(a => a.nivel === "erro").length;
  return {ok: !erros, identidade, total, apontamentos, erros,
          avisos: apontamentos.length - erros};
}

export function validacaoAtual(){
  return estado.validacao || validarLocal();
}

/* ------------------------------------------------------------------ servidor */

export async function api(caminho, opcoes){
  const r = await fetch(caminho, opcoes);
  if (!r.ok){
    let detalhe = r.statusText;
    try { detalhe = (await r.json()).detail || detalhe; } catch(e){}
    throw new Error(detalhe);
  }
  return r.status === 204 ? null : r.json();
}

function corpoDoDeck(){
  const linha = (e) => ({nome: e.carta.nome, quantidade: e.quantidade,
                         categoria: e.categoria || ""});
  return {
    nome: estado.nome,
    comandantes: estado.comandantes.map(c => c.nome),
    cartas: estado.cartas.map(linha),
    maybeboard: estado.maybe.map(linha),
    // Vão inteiras, inclusive as vazias: uma categoria recém-criada some
    // antes de receber a primeira carta se ela só existir nas entradas.
    categorias: estado.categorias,
  };
}

export let salvarTimer = null, salvando = false;
let salvarDeNovo = false;

export function marcarEstado(texto, classe){
  const el = $("estado-salvo");
  el.textContent = texto;
  el.className = "estado-salvo" + (classe ? " " + classe : "");
}

/* Autosave: agenda uma gravação pra 900 ms depois da última mudança. Um clique
   em "+" não pode virar uma requisição — quem ajusta quantidade clica várias
   vezes seguidas. */
export function agendarSalvar(){
  marcarEstado("alterações não salvas");
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(salvarAgora, 900);
}

export async function salvarAgora(){
  // Zerado aqui, e não só no `clearTimeout`: é por ele que o `salvarJa`
  // sabe se ainda há gravação esperando a vez.
  salvarTimer = null;
  if (salvando){ salvarDeNovo = true; return; }
  // Deck sem comandante e sem carta não vira registro no servidor: senão cada
  // pessoa que só abriu a página deixaria um deck vazio pra trás.
  if (!estado.comandantes.length && !estado.cartas.length) return;
  salvando = true;
  marcarEstado("salvando…");
  try {
    const corpo = {method: estado.id ? "PUT" : "POST",
                   headers: {"Content-Type": "application/json"},
                   body: JSON.stringify(corpoDoDeck())};
    const resposta = await api(estado.id ? `/decks/${estado.id}` : "/decks", corpo);
    const novo = !estado.id;
    estado.id = resposta.deck.id;
    estado.validacao = resposta.validacao;
    if (novo){
      estado.dono = resposta.deck.dono || null;
      history.replaceState(null, "", `?deck=${estado.id}`);
      $("btn-compartilhar").hidden = false;
      atualizarBotaoPedido();
    }
    lembrarDeck();
    marcarEstado("salvo " + new Date().toLocaleTimeString("pt-BR",
      {hour:"2-digit", minute:"2-digit"}), "ok");
    desenharAnalise();
    // A validação que chega do servidor substitui a local, e o ponto do
    // cabeçalho é desenhado a partir dela: sem isto o ponto ficaria contando
    // a versão instantânea até a próxima carta entrar.
    desenharContador();
    // O primeiro salvamento é o instante em que o deck ganha id — e é só com
    // id que dá pra cotar. Sem esta chamada, um deck de uma carta só nunca
    // seria cotado: a cotação esperaria uma segunda mudança que não vem.
    agendarCotacao();
    // A mana base é conta local, sem custo de fora: depois de aberta uma
    // vez, acompanha cada autosave em vez de envelhecer com aviso.
    if (estado.manabase) analisarManabase();
    // Fichas sempre, aberta a aba ou não: elas vão pro papel, e a aba Artes
    // e o "Gerar pedido" contam as artes delas. A resposta sai da base
    // local, sem rede de fora.
    buscarTokens();
  } catch (e){
    marcarEstado("não consegui salvar: " + e.message, "erro");
  } finally {
    salvando = false;
    if (salvarDeNovo){ salvarDeNovo = false; agendarSalvar(); }
  }
}

/* Grava agora o que estiver esperando o autosave, e diz se o servidor ficou
   com a versão da tela. É pra quem sai da página levando o deck — o pedido
   é montado com o que o SERVIDOR tem, e os 900 ms de espera cabem folgados
   entre a última carta e o clique no link. */
export async function salvarJa(){
  if (!salvarTimer && !salvando) return true;
  while (salvando) await new Promise(r => setTimeout(r, 100));
  clearTimeout(salvarTimer);
  await salvarAgora();
  return $("estado-salvo").classList.contains("ok");
}

/* ------------------------------------------------- meus decks (localStorage)

   Mesma escolha da tela "Meus Pedidos": não existe login, então a lista de
   quem montou o quê mora no navegador de quem montou. O servidor guarda os
   decks e não sabe de quem são. */
const CHAVE = "forja.decks";

export function lidos(){
  try { return JSON.parse(localStorage.getItem(CHAVE) || "[]"); }
  catch(e){ return []; }
}

export function lembrarDeck(){
  if (!estado.id) return;
  try {
    const lista = lidos().filter(d => d.id !== estado.id);
    lista.unshift({id: estado.id, nome: estado.nome, quando: Date.now(),
                   comandante: estado.comandantes[0]?.nome || ""});
    localStorage.setItem(CHAVE, JSON.stringify(lista.slice(0, 20)));
  } catch(e){ /* cota cheia ou navegador privado: a lista é conveniência */ }
  atualizarBotaoMeus();
}

/* "Meus decks" é item do menu do cabeçalho, e o menu se monta no clique: não
   há botão com contagem pra manter em dia. A função continua existindo como
   ponto único caso o cabeçalho volte a mostrar esse número. */
export function atualizarBotaoMeus(){ /* nada a fazer: o menu se monta ao abrir */ }
