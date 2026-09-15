/* ----------------------------------------------------------------- galeria

   O deck como ele vai sair do papel: uma imagem por arte a imprimir, com o
   que já foi escolhido separado, de relance, do que continua no padrão.
   A lista responde "o que está no deck"; esta aba responde "como ele vai
   ficar" — e é daqui que se escolhe arte carta por carta sem caçar o botão
   em cada linha.

   UM QUADRO POR ARTE, NÃO POR CARTA. Carta de duas faces vira dois quadros,
   frente e verso lado a lado, porque são dois arquivos no papel e duas
   escolhas separadas (ver `artes.js`) — um quadro só esconderia o verso que
   ficou no padrão. As 30 Florestas com a mesma arte aparecem uma vez, com o
   30×; com arte por cópia (ver `artes.py`), aparecem uma vez por arte
   diferente — dez de uma e vinte de outra são dois quadros, 10× e 20×.

   O maybeboard fica de fora — não vai pro papel. O sideboard entra: é carta
   que a pessoa quer ter, e entra na lista de impressão.

   As fichas entram no fim, uma de cada (ver `fichasDoDeck`): vão pro papel
   junto com o deck, e são a parte que se esquece de escolher. */

import {$, escapar} from "../comum/dom.js";
import {arteEscolhida, imagemDaFace, ladoPronto, nomeDaArte, quadroHTML,
        temArtePorCopia, temVerso} from "./artes.js";
import {estado} from "./estado.js";
import {fichasDoDeck, rotuloDaFicha} from "./tokens.js";
import {categoriaDe, ico, ordemDasCategorias} from "./utilidades.js";

// O HTML da última pintura. O autosave redesenha a tela a cada carta, e
// reescrever cem <img> iguais faria a galeria piscar inteira a cada clique.
let galeriaDesenhada = "";

/* "1–3, 5": as cópias de um quadro, com as seguidas juntas. */
function copiasEmTexto(copias){
  const faixas = [];
  for (const n of copias){
    const ultima = faixas[faixas.length - 1];
    if (ultima && n === ultima[1] + 1) ultima[1] = n;
    else faixas.push([n, n]);
  }
  return faixas.map(([a, b]) => a === b ? `${a}` : `${a}–${b}`).join(", ");
}

/* `copias` é a lista de cópias que o quadro representa, na carta com arte
   por cópia; sem ela, o quadro é o da arte de todas. */
function quadroDaGaleria(carta, face, quantidade, copias){
  const copia = copias ? copias[0] : 0;
  const escolha = arteEscolhida(carta, face, null, copia);
  // Ficha leva o corpo e o texto: as duas Wurm do Wurmcoil são dois quadros
  // de mesmo nome, e o texto é o que diz qual é qual.
  const nome = escapar(carta.ficha
    ? rotuloDaFicha(carta) + (carta.texto ? ` (${carta.texto})` : "")
    : carta.nome);
  const verso = face === "verso";
  const src = imagemDaFace(carta, face, 400, null, copia);
  const quais = copias
    ? ` · ${copias.length > 1 ? "cópias" : "cópia"} ${copiasEmTexto(copias)}` : "";
  const situacao = escolha
    ? "arte escolhida: " + (escolha.arquivo || escolha.arte_id)
    : "arte padrão — clique pra escolher";
  // A prévia do hover mostra ESTE lado, e não a carta inteira como na lista:
  // cada quadro já é um lado, e o outro está no quadro ao lado.
  const previa = src ? ` data-arte="${escapar(imagemDaFace(carta, face, 500, null, copia))}"${
    carta.deitada ? ' data-deitada="1"' : ""}` : "";
  return `<button class="galeria-carta ${escolha ? "tem-arte" : ""} ${
      carta.deitada ? "deitada" : ""}"
    data-arte-carta="${escapar(nomeDaArte(carta))}" data-arte-face="${face}"${
      copia ? ` data-arte-copia="${copia}"` : ""}${previa}
    title="${verso ? "Verso de " : ""}${nome}${escapar(quais)} — ${escapar(situacao)}"
    aria-label="${verso ? "Verso de " : ""}${nome}${escapar(quais)}: ${escapar(situacao)}">
    ${quadroHTML(src, carta.deitada,
      (escolha ? `<span class="galeria-marca">${ico("check")}</span>` : "") +
      (quantidade > 1 ? `<span class="galeria-qtd">${quantidade}×</span>` : ""))}
    <span class="galeria-selo">${escolha ? "Escolhida" : "Padrão"}${
      verso ? " · verso" : temVerso(carta) ? " · frente" : ""}${escapar(quais)}</span>
  </button>`;
}

/* As cópias de uma carta com arte por cópia, juntas pela arte que imprimem.
   Frente e verso contam juntos: duas cópias só dividem quadro se os dois
   lados saem iguais. */
function gruposDeCopias(carta, quantidade, faces){
  const grupos = new Map();
  for (let n = 1; n <= quantidade; n++){
    const chave = faces.map(f =>
      (arteEscolhida(carta, f, null, n) || {}).arte_id || "").join("|");
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(n);
  }
  return Array.from(grupos.values());
}

function quadrosDaCarta(carta, quantidade){
  const faces = temVerso(carta) ? ["frente", "verso"] : ["frente"];
  if (quantidade > 1 && temArtePorCopia(carta)){
    return gruposDeCopias(carta, quantidade, faces).map(copias =>
      faces.map(f => quadroDaGaleria(carta, f, copias.length, copias)).join("")
    ).join("");
  }
  return faces.map(f => quadroDaGaleria(carta, f, quantidade)).join("");
}

/* O que falta escolher, contado por ARTE: carta de duas faces conta duas,
   que é o que vai pro papel. Ficha conta como carta. Um lado só conta como
   escolhido com todas as cópias dele cobertas. */
function contaDaGaleria(){
  const entradas = estado.comandantes.map(c => [c, 1]).concat(
    estado.cartas.map(e => [e.carta, e.quantidade]),
    fichasDoDeck().map(f => [f, 1]));
  let total = 0, escolhidas = 0;
  for (const [c, quantidade] of entradas){
    for (const face of temVerso(c) ? ["frente", "verso"] : ["frente"]){
      total++;
      if (ladoPronto(c, face, quantidade)) escolhidas++;
    }
  }
  return {total, escolhidas};
}

/* O "Gerar pedido" do cabeçalho: um link pra tela de orçamento com o id do
   deck, que lá vira pedido com as artes escolhidas aqui (ver `artes.pedido`).
   Só ganha `href` com TODAS as artes escolhidas, pela mesma conta desta aba:
   a arte padrão da tela é só a miniatura da base, e o PDF imprime o que foi
   escolhido. Sem id não há deck no servidor pra levar, e ele some junto com
   o Compartilhar. */
export function atualizarBotaoPedido(){
  const link = $("btn-pedido");
  link.hidden = !estado.id;
  const {total, escolhidas} = contaDaGaleria();
  const pronto = !!estado.id && total > 0 && escolhidas === total;
  if (pronto) link.href = `/?deck=${encodeURIComponent(estado.id)}`;
  else link.removeAttribute("href");
  link.setAttribute("aria-disabled", String(!pronto));
  link.title = pronto ? "Levar este deck pra tela de orçamento"
    : total ? `Faltam ${total - escolhidas} arte(s) — escolha na aba Artes`
    : "O deck ainda não tem carta";
}

export function desenharGaleria(){
  const caixa = $("galeria-resultado");
  if (!estado.comandantes.length){
    $("btn-artes-padrao").hidden = true;
    galeriaDesenhada = caixa.innerHTML = "";
    return;
  }
  const {total, escolhidas} = contaDaGaleria();
  // O atalho só aparece quando há o que aplicar, e num deck já salvo.
  $("btn-artes-padrao").hidden = !estado.id || escolhidas === total;
  const pct = total ? (escolhidas / total) * 100 : 0;
  let html = `<div class="progresso">
      <div class="texto"><span>${escolhidas === total
        ? "Todas as artes escolhidas" : "Artes escolhidas"}</span>
        <b>${escolhidas}/${total}</b></div>
      <span class="trilho"><span class="cheio" style="width:${pct}%"></span></span>
    </div>`;

  html += `<div class="galeria-grupo"><h3>${estado.comandantes.length > 1
      ? "Comandantes" : "Comandante"}</h3><div class="galeria-grade">${
    estado.comandantes.map(c => quadrosDaCarta(c, 1)).join("")}</div></div>`;

  // Os mesmos grupos, na mesma ordem e com o mesmo desempate da lista: a
  // pessoa acha a carta aqui onde ela já sabe que a carta mora lá.
  const porCategoria = new Map();
  for (const e of estado.cartas){
    const cat = categoriaDe(e);
    if (!porCategoria.has(cat)) porCategoria.set(cat, []);
    porCategoria.get(cat).push(e);
  }
  for (const cat of ordemDasCategorias(estado.cartas)){
    const itens = porCategoria.get(cat);
    if (!itens) continue;
    itens.sort((a, b) => (a.carta.cmc - b.carta.cmc) ||
                          a.carta.nome.localeCompare(b.carta.nome));
    html += `<div class="galeria-grupo"><h3>${escapar(cat)}</h3>
      <div class="galeria-grade">${itens.map(e =>
        quadrosDaCarta(e.carta, e.quantidade)).join("")}</div></div>`;
  }

  const fichas = fichasDoDeck();
  if (fichas.length){
    html += `<div class="galeria-grupo"><h3>Tokens</h3>
      <div class="galeria-grade">${fichas.map(f =>
        quadrosDaCarta(f, 1)).join("")}</div></div>`;
  }

  if (html === galeriaDesenhada) return;
  galeriaDesenhada = caixa.innerHTML = html;
}
