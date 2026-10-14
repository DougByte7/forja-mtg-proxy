/* ------------------------------------------------------- validação instantânea

   Mesmas regras do `decks.validar` no servidor, na versão que roda a cada
   clique. Ela é substituída pela do servidor assim que o autosave responde;
   existe porque esperar a rede pra dizer "essa carta é de outra cor" tornaria
   a tela lenta justamente no momento em que a informação importa. */

import {$} from "../../shared/dom.js";
import {deckIdentity, totalCards} from "./deck";
import {desenharAnalise, desenharContador} from "./desenho.js";
import {atualizarBotaoPedido} from "./galeria.js";
import {analisarManabase} from "./manabase.js";
import {agendarCotacao} from "./orcamento.js";
import {state} from "./state";
import {brDate} from "./text";
import {buscarTokens} from "./tokens.js";
import {buscarHistorico, desenharVersao} from "./versoes.js";
export function validarLocal(){
  const identidade = deckIdentity();
  const apontamentos = [];
  const total = totalCards();

  if (!state.comandantes.length){
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
  for (const {carta, quantidade} of state.cartas){
    if (!carta) continue;
    if (quantidade > 1 && !carta.basico && !carta.ilimitada){
      apontamentos.push({nivel:"erro", tipo:"singleton", carta:carta.nome,
        mensagem:`${carta.nome}: ${quantidade} cópias. Commander é singleton.`});
    }
    // Ainda não lançada é AVISO, não erro: a carta vira legal sozinha no dia
    // do lançamento, e um deck montado com a coleção nova na mão não é um
    // deck quebrado. Mesma regra do `decks.validar` — quando a resposta do
    // servidor chega, ela tem que dizer a mesma coisa que esta.
    if (carta.inedita){
      apontamentos.push({nivel:"aviso", tipo:"inedita", carta:carta.nome,
        mensagem:`${carta.nome} ainda não foi lançada — vale em mesa a partir de ${
          brDate(carta.sai_em)}.`});
    } else if (!carta.legal){
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
  return state.validacao || validarLocal();
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

export function corpoDoDeck(){
  const linha = (e) => ({nome: e.carta.nome, quantidade: e.quantidade,
                         categoria: e.categoria || ""});
  return {
    nome: state.nome,
    comandantes: state.comandantes.map(c => c.nome),
    cartas: state.cartas.map(linha),
    maybeboard: state.maybe.map(linha),
    // Vão inteiras, inclusive as vazias: uma categoria recém-criada some
    // antes de receber a primeira carta se ela só existir nas entradas.
    categorias: state.categorias,
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
  if (!state.comandantes.length && !state.cartas.length) return;
  if (!state.usuario){
    marcarEstado("entre na sua conta pra salvar", "erro");
    return;
  }
  salvando = true;
  marcarEstado("salvando…");
  try {
    const corpo = {method: state.id ? "PUT" : "POST",
                   headers: {"Content-Type": "application/json"},
                   body: JSON.stringify(corpoDoDeck())};
    const resposta = await api(state.id ? `/decks/${state.id}` : "/decks", corpo);
    const novo = !state.id;
    state.id = resposta.deck.id;
    state.validacao = resposta.validacao;
    state.versao = resposta.versao;
    if (novo){
      state.dono = resposta.deck.dono || null;
      history.replaceState(null, "", `?deck=${state.id}`);
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
    // A pílula da versão ganha o ponto de "a lista mudou" quando o servidor
    // confirma a mudança, e o histórico aberto acompanha a lista gravada.
    desenharVersao();
    if (state.aba === "historico") buscarHistorico();
    // O primeiro salvamento é o instante em que o deck ganha id — e é só com
    // id que dá pra cotar. Sem esta chamada, um deck de uma carta só nunca
    // seria cotado: a cotação esperaria uma segunda mudança que não vem.
    agendarCotacao();
    // A mana base é conta local, sem custo de fora: depois de aberta uma
    // vez, acompanha cada autosave em vez de envelhecer com aviso.
    if (state.manabase) analisarManabase();
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

   Os decks abertos neste navegador, inclusive os que outra pessoa
   compartilhou — que não são da conta de quem abriu e por isso não saem no
   `/decks/meus`. A tela "Meus decks" junta as duas listas. */
const CHAVE = "forja.decks";

export function lidos(){
  try { return JSON.parse(localStorage.getItem(CHAVE) || "[]"); }
  catch(e){ return []; }
}

export function lembrarDeck(){
  if (!state.id) return;
  try {
    const lista = lidos().filter(d => d.id !== state.id);
    lista.unshift({id: state.id, nome: state.nome, quando: Date.now(),
                   comandante: state.comandantes[0]?.nome || ""});
    localStorage.setItem(CHAVE, JSON.stringify(lista.slice(0, 20)));
  } catch(e){ /* cota cheia ou navegador privado: a lista é conveniência */ }
  atualizarBotaoMeus();
}

/* "Meus decks" é item do menu do cabeçalho, e o menu se monta no clique: não
   há botão com contagem pra manter em dia. A função continua existindo como
   ponto único caso o cabeçalho volte a mostrar esse número. */
export function atualizarBotaoMeus(){ /* nada a fazer: o menu se monta ao abrir */ }
