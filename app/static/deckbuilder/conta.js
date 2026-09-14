/* ------------------------------------------------------------------- conta

   Criar e alterar baralho pede conta; abrir um, não. O link compartilhado
   abre pra qualquer um, e quem chega sem conta recebe o convite de entrar ou
   criar uma. Com conta vem dono — e, com dono, "os meus" em qualquer
   aparelho.

   `estado.usuario` é null pra anônimo. Não é erro: é quem está só olhando. */

import {$} from "../comum/dom.js";
import {estado} from "./estado.js";
import {api} from "./salvar.js";
import {toast} from "./utilidades.js";

/* Sem conta legível (rede fora), a tela trata como anônimo: o servidor
   recusaria a gravação do mesmo jeito, e o convite ao menos diz por quê. */
export async function lerConta(){
  try {
    estado.usuario = (await api("/conta")).usuario || null;
  } catch (e){
    estado.usuario = null;
  }
}

/* Chamada com o deck já em mãos: o reclamar precisa saber se ele tem dono,
   e o convite muda de texto quando há um deck aberto. */
export function receberConta(){
  if (estado.usuario) oferecerReclamar();
  else convidarAEntrar();
}

/* O caminho pra entrar ou criar conta, voltando pra esta mesma tela — com o
   deck aberto, se houver um. */
export function linkDeConta(pagina){
  return `/${pagina}?voltar=${encodeURIComponent(location.pathname + location.search)}`;
}

function convidarAEntrar(){
  if (estado.id){
    $("convite-titulo").textContent = "Você está vendo este baralho";
    $("convite-texto").textContent = "Pra editar ou montar o seu, entre " +
      "na sua conta ou crie uma.";
  } else {
    $("convite-titulo").textContent = "Entre pra montar seu baralho";
    $("convite-texto").textContent = "Criar um baralho pede uma conta. Sem " +
      "entrar, você ainda abre os baralhos que compartilharem com você.";
  }
  $("convite-entrar").href = linkDeConta("entrar");
  $("convite-cadastro").href = linkDeConta("cadastro");
  $("convite-fundo").hidden = false;
}

export function ligarConvite(){
  $("convite-olhar").addEventListener("click", () => {
    $("convite-fundo").hidden = true;
  });
}

/* Quem recusou, fica recusado. Sem isto, quem deixa um deck órfão de
   propósito (pra outra pessoa reclamar) leva a mesma pergunta em toda
   recarga — e pergunta que sempre volta é pergunta que se aprende a
   fechar sem ler. */
const CHAVE_DISPENSADOS = "forja.orfaos.dispensados";

function dispensados(){
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_DISPENSADOS) || "[]");
    return Array.isArray(bruto) ? bruto : [];
  } catch(e){ return []; }
}

function dispensar(id){
  try {
    localStorage.setItem(CHAVE_DISPENSADOS,
      JSON.stringify([id, ...dispensados().filter(x => x !== id)].slice(0, 40)));
  } catch(e){ /* navegador privado: a pergunta volta, e tudo bem */ }
}

/* Oferece pra QUALQUER órfão que a pessoa abra, não só os deste navegador:
   quem montou no celular precisa poder reclamar no computador, e é
   justamente esse o caso que o login existe pra resolver. */
function oferecerReclamar(){
  if (!estado.usuario || !estado.id) return;
  if (estado.dono) return;                       // já é de alguém
  if (dispensados().includes(estado.id)) return;
  $("orfao-fundo").hidden = false;
}

async function reclamarDeck(){
  $("orfao-fundo").hidden = true;
  try {
    const r = await api(`/decks/${estado.id}/reclamar`, {method: "POST"});
    estado.dono = r.deck.dono;
    toast("Pronto, o baralho é seu.");
  } catch (e){
    toast("Não consegui: " + e.message);
  }
}

export function ligarOrfao(){
  $("orfao-sim").addEventListener("click", reclamarDeck);
  $("orfao-nao").addEventListener("click", () => {
    $("orfao-fundo").hidden = true;
    dispensar(estado.id);
  });
}
