"use strict";

/* ----------------------------------------------------------------- galeria

   O deck como ele vai sair do papel: uma imagem por arte a imprimir, com o
   que já foi escolhido separado, de relance, do que continua no padrão.
   A lista responde "o que está no deck"; esta aba responde "como ele vai
   ficar" — e é daqui que se escolhe arte carta por carta sem caçar o botão
   em cada linha.

   UM QUADRO POR ARTE, NÃO POR CARTA. Carta de duas faces vira dois quadros,
   frente e verso lado a lado, porque são dois arquivos no papel e duas
   escolhas separadas (ver `artes.js`) — um quadro só esconderia o verso que
   ficou no padrão. E um quadro por NOME, não por cópia: as 30 Florestas
   saem com a mesma arte (ver `artes.py`), então aparecem uma vez, com o 30×.

   O maybeboard fica de fora — não vai pro papel. O sideboard entra: é carta
   que a pessoa quer ter, e entra na lista de impressão. */

// O HTML da última pintura. O autosave redesenha a tela a cada carta, e
// reescrever cem <img> iguais faria a galeria piscar inteira a cada clique.
let galeriaDesenhada = "";

function quadroDaGaleria(carta, face, quantidade){
  const escolha = arteEscolhida(carta, face);
  const nome = escapar(carta.nome);
  const verso = face === "verso";
  const src = imagemDaFace(carta, face, 400);
  const situacao = escolha
    ? "arte escolhida: " + (escolha.arquivo || escolha.drive_id)
    : "arte padrão — clique pra escolher";
  // A prévia do hover mostra ESTE lado, e não a carta inteira como na lista:
  // cada quadro já é um lado, e o outro está no quadro ao lado.
  const previa = src ? ` data-arte="${escapar(imagemDaFace(carta, face, 500))}"${
    carta.deitada ? ' data-deitada="1"' : ""}` : "";
  return `<button class="galeria-carta ${escolha ? "tem-arte" : ""} ${
      carta.deitada ? "deitada" : ""}"
    data-arte-carta="${nome}" data-arte-face="${face}"${previa}
    title="${verso ? "Verso de " : ""}${nome} — ${escapar(situacao)}"
    aria-label="${verso ? "Verso de " : ""}${nome}: ${escapar(situacao)}">
    ${quadroHTML(src, carta.deitada,
      (escolha ? `<span class="galeria-marca">${ico("check")}</span>` : "") +
      (quantidade > 1 ? `<span class="galeria-qtd">${quantidade}×</span>` : ""))}
    <span class="galeria-selo">${escolha ? "Escolhida" : "Padrão"}${
      verso ? " · verso" : temVerso(carta) ? " · frente" : ""}</span>
  </button>`;
}

function quadrosDaCarta(carta, quantidade){
  return quadroDaGaleria(carta, "frente", quantidade) +
    (temVerso(carta) ? quadroDaGaleria(carta, "verso", quantidade) : "");
}

/* O que falta escolher, contado por ARTE: carta de duas faces conta duas,
   que é o que vai pro papel. */
function contaDaGaleria(){
  const cartas = estado.comandantes.concat(estado.cartas.map(e => e.carta));
  let total = 0, escolhidas = 0;
  for (const c of cartas){
    for (const face of temVerso(c) ? ["frente", "verso"] : ["frente"]){
      total++;
      if (arteEscolhida(c, face)) escolhidas++;
    }
  }
  return {total, escolhidas};
}

function desenharGaleria(){
  const caixa = $("galeria-resultado");
  if (!estado.comandantes.length){
    galeriaDesenhada = caixa.innerHTML = "";
    return;
  }
  const {total, escolhidas} = contaDaGaleria();
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

  if (html === galeriaDesenhada) return;
  galeriaDesenhada = caixa.innerHTML = html;
}
