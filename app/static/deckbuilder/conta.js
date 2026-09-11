/* ------------------------------------------------------------------- conta

   O login é OPCIONAL. Nada nesta tela depende dele: quem não entra monta,
   salva e compartilha exatamente como antes de existir conta neste projeto.
   O que ele acrescenta é dono — e, com dono, "os meus" em qualquer aparelho.

   `estado.usuario` é null pra anônimo, e null NÃO é erro aqui. */

import {$} from "../comum/dom.js";
import {estado} from "./estado.js";
import {api} from "./salvar.js";
import {toast} from "./utilidades.js";

export async function carregarConta(){
  try {
    estado.usuario = (await api("/conta")).usuario || null;
  } catch (e){
    return;   // sem conta legível, a tela é a de sempre
  }
  if (estado.usuario) oferecerReclamar();
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
