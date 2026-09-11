/* ------------------------------------------------------------------ tokens

   A aba responde uma pergunta que só aparece no fim da montagem: "o que eu
   preciso levar ALÉM das 100 cartas?". Ficha não vai dentro do deck — é
   material separado, e por isso é a parte que se esquece em casa.

   Sem botão de buscar, ao contrário dos combos: a base local já guarda, carta
   por carta, quais fichas ela cria, então a resposta não custa rede e pode
   acompanhar o deck como a mana base acompanha.

   Agrupado por carta que cria, e não numa lista única: a mesma ficha pedida
   por duas cartas continua sendo duas linhas da conta, porque tirar uma das
   duas do deck não tira a ficha da caixa. */

import {$, escapar} from "../comum/dom.js";
import {ganchosDaPrevia} from "./carta.js";
import {assinaturaDoDeck} from "./combos.js";
import {estado} from "./estado.js";
import {atualizarBotaoPedido, desenharGaleria} from "./galeria.js";
import {api, salvarAgora} from "./salvar.js";
import {toast} from "./utilidades.js";
export async function buscarTokens(){
  if (!estado.comandantes.length) return;
  if (!estado.id) await salvarAgora();
  if (!estado.id){
    toast("Não consegui salvar o deck antes de listar as fichas.");
    return;
  }
  // Só avisa que está procurando quando ainda não há lista na tela. Nos
  // recálculos do autosave, apagar a grade faria as artes piscarem a cada
  // carta adicionada.
  if (!estado.tokens){
    $("tokens-resultado").innerHTML = `<div class="nota">Procurando…</div>`;
  }
  try {
    estado.tokens = await api(`/decks/${estado.id}/tokens`);
    estado.tokensAssinatura = assinaturaDoDeck();
  } catch (e){
    $("tokens-nota").hidden = false;
    $("tokens-resultado").innerHTML =
      `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    return;
  }
  desenharTokens();
  // As fichas também vão pro papel: a aba Artes tem um quadro por ficha, e o
  // "Gerar pedido" conta as artes delas.
  desenharGaleria();
  atualizarBotaoPedido();
}

/* As fichas como coisa a imprimir: UMA DE CADA, pela `chave_arte` que o
   servidor manda com cada uma. A aba Tokens lista por carta que cria; o papel
   leva a mesma Treasure uma vez só, peça quantas cartas pedirem (ver
   `artes.pedido`).

   Cada uma vira um objeto com a forma de carta que a modal de arte e a
   galeria já sabem desenhar — `ficha` e `chaveArte` são o que as separa de
   uma carta (ver `nomeDaArte` e `nomeDaBusca`). Montado uma vez por
   resposta do servidor: a galeria e a conta do "Gerar pedido" pedem a lista
   a cada desenho, e o autosave redesenha a cada carta. */
const fichasMontadas = {de: null, lista: []};

export function fichasDoDeck(){
  const dados = estado.tokens;
  if (dados && fichasMontadas.de === dados) return fichasMontadas.lista;
  const vistas = new Map();
  for (const g of (dados && dados.grupos) || []){
    for (const t of g.tokens){
      if (!t.chave_arte || vistas.has(t.chave_arte)) continue;
      vistas.set(t.chave_arte, {
        nome: t.nome, chaveArte: t.chave_arte, ficha: true,
        tipo: t.tipo || "", texto: t.texto || "",
        poder: t.poder || "", resistencia: t.resistencia || "",
        imagem: t.imagem || "", imagem_verso: t.imagem_verso || "",
      });
    }
  }
  fichasMontadas.de = dados;
  fichasMontadas.lista = Array.from(vistas.values());
  return fichasMontadas.lista;
}

/* "Wurm 3/3": o nome sozinho não distingue ficha, e o corpo é o que se
   reconhece de relance. O resto (tipo, texto) mora no título do quadro e na
   vitrine da modal. */
export function rotuloDaFicha(f){
  return f.nome + (f.poder && f.resistencia ? ` ${f.poder}/${f.resistencia}` : "");
}

/* Uma ficha vira uma imagem por FACE. Ficha de duas faces existe (o lobisomem
   que nasce Humano e vira Lobo é uma carta só, com dois lados) e quem vai
   imprimir ou procurar na caixa precisa dos dois — mostrar só a frente
   esconderia metade do que tem que ser levado. */
function fichaHTML(t){
  const nome = [t.nome, t.tipo].filter(Boolean).join(" — ");
  // Ficha sem corpo é ficha que não é criatura (Treasure, Clue, Food): sem
  // isto elas apareceriam como "/" no título, que parece dado faltando.
  const corpo = t.poder && t.resistencia ? ` ${t.poder}/${t.resistencia}` : "";
  return [t.imagem, t.imagem_verso].filter(Boolean).map(url =>
    `<img class="token" loading="lazy" src="${escapar(url)}"
          alt="${escapar(nome)}" title="${escapar(nome + corpo)}">`).join("");
}

function desenharTokens(){
  const dados = estado.tokens;
  const grupos = dados?.grupos || [];
  // Vazio, e não "0": deck que não cria ficha nenhuma não tem contagem pra
  // mostrar, do mesmo jeito que a aba de combos antes da primeira busca.
  $("aba-tokens-n").textContent = dados && dados.total ? dados.total : "";

  const caixa = $("tokens-resultado");
  if (!dados){ caixa.innerHTML = ""; return; }
  // A lista está na tela: a explicação do que a aba faz vira ruído acima dela.
  $("tokens-nota").hidden = grupos.length > 0;
  if (!grupos.length){
    caixa.innerHTML = `<div class="nota">Nenhuma carta deste deck cria ficha —
      não há nada a levar além das cartas.</div>`;
    return;
  }
  caixa.innerHTML = grupos.map(g => `
    <div class="token-grupo">
      <h3><span class="peca"${ganchosDaPrevia(g)}>${escapar(g.carta)}</span>
          <span class="quantas">${g.tokens.length}</span></h3>
      <div class="token-grade">${g.tokens.map(fichaHTML).join("")}</div>
    </div>`).join("");
}
