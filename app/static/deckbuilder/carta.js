"use strict";

/* ------------------------------------------------------- a carta inteira

   Clique numa linha do deck ou do maybeboard. A lista responde "o que está no
   deck"; uma hora a pergunta vira "o que esta carta faz, mesmo?" — e aí é
   oracle inteiro, ambientação, edição e as notas de regras.

   A modal abre NA HORA com o que a base local já tem (a carta chega completa
   da busca, ver `cartas.py`) e completa depois com o que só a API da Scryfall
   sabe. Esperar a rede pra mostrar uma carta que já está na tela seria fazer
   o clique parecer travado por causa da metade menos urgente da informação. */

let cartaAberta = null;         // nome da carta na modal, ou null
// Por sessão: reabrir a mesma carta é comum (comparar duas, voltar pra
// conferir um ruling) e a segunda vez não pode custar rede de novo.
const detalhesVistos = new Map();

const RARIDADE = {common: "Comum", uncommon: "Incomum", rare: "Rara",
                  mythic: "Mítica", special: "Especial", bonus: "Bônus"};

/* Recebe a CARTA, não o nome: quem abre a modal são três lugares que guardam
   a carta em listas diferentes (deck, maybeboard e a zona de comando), e
   procurar o nome aqui dentro obrigaria esta função a conhecer as três. */
function abrirCarta(carta){
  if (!carta) return;
  cartaAberta = carta.nome;
  // A prévia do hover fica presa embaixo da modal se ela não for dispensada
  // aqui: o clique não move o mouse, e é movimento que a apaga.
  $("previa").classList.remove("mostra");
  const fundo = $("carta-fundo");
  fundo.hidden = false;
  requestAnimationFrame(() => fundo.classList.add("aberta"));
  desenharCarta(carta, detalhesVistos.get(carta.nome) ?? null);
  $("btn-fechar-carta").focus();
  if (!detalhesVistos.has(carta.nome)) buscarDetalhe(carta);
}

function fecharCarta(){
  if (!cartaAberta) return;
  cartaAberta = null;
  const fundo = $("carta-fundo");
  fundo.classList.remove("aberta");
  // `hidden` só depois da transição, como nas gavetas: na hora, a modal
  // sumiria sem o desvanecer.
  setTimeout(() => {
    if (!fundo.classList.contains("aberta")) fundo.hidden = true;
  }, 200);
}

/* `false` no lugar do detalhe é "a Scryfall não respondeu" — diferente de
   `null`, que é "ainda estou buscando". A modal fala as duas coisas, e
   nenhuma delas é erro: o que a base local sabe continua na tela. */
async function buscarDetalhe(carta){
  const nome = carta.nome;
  let dados = false;
  try {
    dados = await api("/cartas/detalhe?nome=" + encodeURIComponent(nome));
    detalhesVistos.set(nome, dados);
  } catch (e){ /* a própria modal avisa; não vale um toast por cima dela */ }
  if (cartaAberta === nome) desenharCarta(carta, dados);
}

/* As artes, sem repetição. Carta partida e aventura têm duas faces de TEXTO
   numa imagem só, e as duas faces devolvem a mesma URL — desenhá-la duas
   vezes mostraria a mesma carta empilhada em si mesma. */
function artesDaCarta(local, d){
  const urls = (d ? (d.faces || []).map(f => f.imagem) : [])
    .concat([local.imagem, local.imagem_verso]);
  return [...new Set(urls.filter(Boolean))];
}

/* A carta local no formato de face que a modal desenha. É o que fica na tela
   enquanto a Scryfall não responde — e o que fica pra sempre se ela não
   responder. O texto de carta de duas faces vem da base emendado por
   "\n//\n", que é como a lista do deck já o mostra. */
function faceLocal(carta){
  return {nome: carta.nome, mana_cost: carta.mana_cost, tipo: carta.tipo,
          texto: carta.texto, sabor: "", poder: null, resistencia: null,
          lealdade: null, defesa: null};
}

function faceHTML(f, comCabeca){
  const pt = f.poder != null && f.resistencia != null
    ? `${f.poder}/${f.resistencia}`
    : f.lealdade != null ? `Lealdade ${f.lealdade}`
    : f.defesa != null ? `Defesa ${f.defesa}` : "";
  return `<div class="carta-face">
    ${comCabeca ? `<div class="cabeca">
        <b>${escapar(f.nome)}</b>${manaHTML(f.mana_cost)}
        <span class="tipo">${escapar(f.tipo)}</span>
      </div>` : ""}
    ${f.texto ? `<p class="carta-oracle">${manaEmTexto(f.texto)}</p>` : ""}
    ${f.sabor ? `<p class="carta-sabor">${escapar(f.sabor)}</p>` : ""}
    ${pt ? `<div class="carta-pt">${escapar(pt)}</div>` : ""}
  </div>`;
}

function dadosHTML(d){
  const artistas = [...new Set((d.faces || []).map(f => f.artista)
                                              .filter(Boolean))].join(", ");
  const itens = [];
  if (d.edicao) itens.push(["Edição", `${d.edicao}${d.numero ? ` · nº ${d.numero}` : ""}`]);
  if (d.raridade) itens.push(["Raridade", RARIDADE[d.raridade] || d.raridade]);
  if (artistas) itens.push(["Ilustração", artistas]);
  if (d.lancamento) itens.push(["Lançamento", d.lancamento.split("-").reverse().join("/")]);
  // Posição no EDHREC = "quão jogada em Commander". Quanto menor, mais
  // jogada — daí o "#", que é o que a própria Scryfall mostra.
  if (d.edhrec) itens.push(["EDHREC", "#" + d.edhrec.toLocaleString("pt-BR")]);
  if (d.reservada) itens.push(["Lista reservada", "Sim — nunca será reimpressa"]);
  if (!itens.length) return "";
  return `<div class="carta-dados">${itens.map(([rot, val]) =>
    `<div><span class="rot">${escapar(rot)}</span>
       <span class="val">${escapar(val)}</span></div>`).join("")}</div>`;
}

/* Preço de referência, e só: são os do mercado americano/europeu, não os de
   comprar no Brasil. Quem responde "quanto custa" é o botão de cotar.

   Único lugar da tela que NÃO passa pela régua do câmbio, de propósito: são
   quatro moedas de quatro mercados (dólar, dólar foil, euro e tix, que nem
   dinheiro é), cruas da Scryfall. Passar euro e tix por uma taxa de dólar
   inventaria um real que não existe em nenhum dos dois, e o rótulo de cada
   chip já diz em que moeda o número está. */
function precosHTML(d){
  const p = d.precos || {};
  const chips = [["usd", "US$", p.usd], ["usd_foil", "US$ foil", p.usd_foil],
                 ["eur", "€", p.eur], ["tix", "tix", p.tix]]
    .filter(([, , v]) => v)
    .map(([, rot, v]) => `<span class="carta-chip">${escapar(rot)}
       <b>${escapar(v)}</b></span>`);
  if (!chips.length) return "";
  return `<div><h2 class="secao">Preço de referência</h2>
    <div class="carta-chips">${chips.join("")}</div></div>`;
}

/* "Notes and Rules Information" é como a Scryfall chama isto na página da
   carta. São os rulings — as respostas oficiais sobre como a carta funciona,
   e a razão principal de esta modal existir: é a informação que não cabe na
   linha do deck e que ninguém decora. */
function regrasHTML(d){
  const regras = d.regras || [];
  if (!regras.length) return "";
  return `<div><h2 class="secao">Notas e regras (${regras.length})</h2>
    ${regras.map(r => `<div class="regra">
      <span class="quando">${escapar((r.data || "").split("-").reverse().join("/"))}</span>
      <p>${manaEmTexto(r.texto)}</p></div>`).join("")}</div>`;
}

function desenharCarta(local, d){
  const artes = artesDaCarta(local, d);
  const arte = $("carta-arte");
  arte.classList.toggle("deitada", !!local.deitada);
  // Só reescreve a arte quando ela muda: o detalhe chega depois e costuma
  // trazer as MESMAS URLs, e reescrever o `img` faria a carta piscar.
  const html = artes.map(u =>
    `<img src="${escapar(u)}" alt="${escapar(local.nome)}">`).join("");
  if (arte.dataset.artes !== html){
    arte.innerHTML = html;
    arte.dataset.artes = html;
  }

  const faces = (d && d.faces && d.faces.length) ? d.faces : [faceLocal(local)];
  const tipo = d ? faces.map(f => f.tipo).filter(Boolean).join(" // ")
                 : (local.tipo || "");
  const partes = [`<div class="carta-topo">
      <h2 id="carta-titulo">${escapar(local.nome)}${manaHTML(local.mana_cost)}</h2>
      <p class="tipo">${escapar(tipo)}</p>
      ${d && d.edicao ? `<p class="edicao">${escapar(d.edicao_sigla)} ·
        ${escapar(d.edicao)}</p>` : ""}
    </div>`];

  // Cabeça por face só quando são duas: numa carta de face única ela repetiria
  // o nome e o tipo que estão logo acima.
  partes.push(`<div>${faces.map(f => faceHTML(f, faces.length > 1)).join("")}</div>`);

  if (d){
    // As notas de regras vêm logo depois do oracle porque são a continuação
    // dele — o que a carta faz, e o que ela faz nos casos em que ninguém
    // concorda. Edição, ilustração e preço são ficha técnica e podem esperar.
    partes.push(regrasHTML(d), dadosHTML(d), precosHTML(d));
    const links = [];
    if (d.scryfall || local.scryfall){
      links.push(`<a href="${escapar(d.scryfall || local.scryfall)}"
        target="_blank" rel="noopener">Ver na Scryfall ${ico("arrow-square-out")}</a>`);
    }
    if (d.gatherer){
      links.push(`<a href="${escapar(d.gatherer)}" target="_blank"
        rel="noopener">Gatherer ${ico("arrow-square-out")}</a>`);
    }
    if (links.length) partes.push(`<div class="carta-links">${links.join("")}</div>`);
  } else if (d === null){
    partes.push(`<div class="carta-nota">Buscando edição, ambientação e
      notas de regras na Scryfall…</div>`);
  } else {
    partes.push(`<div class="carta-nota">A Scryfall não respondeu agora —
      o que está aí em cima é o que a base local guarda. Fechar e abrir de
      novo tenta outra vez.</div>`);
  }
  const corpo = $("carta-corpo");
  corpo.innerHTML = partes.filter(Boolean).join("");
  // O topo só na primeira pintura desta carta: o detalhe chega depois e
  // repinta, e rolar de volta ali jogaria fora o oracle que a pessoa já
  // estava lendo.
  if (corpo.dataset.carta !== local.nome){
    corpo.dataset.carta = local.nome;
    corpo.scrollTop = 0;
  }
}

/* Prévia da arte ao passar o mouse. Só no mouse: em toque ela roubaria o
   clique, e a lista já mostra tipo e custo.

   Uma função só pra tela inteira — a lista do deck, a busca, as sugestões, os
   terrenos que fixam e as peças de combo entram nela só por carregarem os
   atributos que `ganchosDaPrevia` escreve. */
const PREVIA_LARGA = 250;    // largura da carta em pé
const PREVIA_ALTA = 349;     // altura dela, na proporção 488x680 da Scryfall
const PREVIA_DEITADA = 487;  // largura da carta girada (a altura vira largura)
const PREVIA_VAO = 8;        // o `gap` do CSS entre frente e verso

/* Os atributos que ligam um elemento à prévia. Passar a carta inteira em vez
   de só a URL é o que faz a carta de duas faces aparecer inteira: sem o
   verso, hover num transform mostra metade da carta e cala sobre a outra. */
function ganchosDaPrevia(c){
  if (!c || !c.imagem) return "";
  let attrs = ` data-arte="${escapar(c.imagem)}"`;
  if (c.imagem_verso) attrs += ` data-arte-verso="${escapar(c.imagem_verso)}"`;
  if (c.deitada) attrs += ' data-deitada="1"';
  return attrs;
}

function ligarPrevia(){
  const previa = $("previa");
  const frente = $("previa-frente");
  const verso = $("previa-verso");
  // Arte que não carrega deixaria uma caixa vazia com borda seguindo o mouse,
  // que parece defeito da página e não carta sem imagem. Se só o verso falha,
  // a frente continua valendo.
  frente.addEventListener("error", () => previa.classList.remove("mostra"));
  verso.addEventListener("error", () => verso.classList.add("vazia"));

  // Guardada porque o mousemove precisa dela a cada quadro e medir o elemento
  // ali dentro forçaria um reflow por movimento do mouse.
  let largura = PREVIA_LARGA;

  document.addEventListener("mouseover", (e) => {
    const alvo = e.target.closest("[data-arte]");
    const arte = alvo?.dataset.arte;
    if (!arte){ previa.classList.remove("mostra"); return; }
    // Carta partida tem uma face física só: o verso e o giro nunca convivem.
    const deitada = alvo.dataset.deitada === "1";
    const atras = deitada ? "" : (alvo.dataset.arteVerso || "");
    frente.src = arte;
    verso.classList.toggle("vazia", !atras);
    if (atras) verso.src = atras;
    previa.classList.toggle("deitada", deitada);
    previa.classList.add("mostra");
    largura = deitada ? PREVIA_DEITADA
            : atras ? PREVIA_LARGA * 2 + PREVIA_VAO
            : PREVIA_LARGA;
  });

  document.addEventListener("mousemove", (e) => {
    if (!previa.classList.contains("mostra")) return;
    // Cai pro outro lado do cursor quando não cabe à direita, e sobe quando
    // não cabe embaixo: prévia cortada pela borda da janela não mostra a
    // carta, que é a única coisa que ela existe pra fazer.
    const y = Math.min(e.clientY + 14, window.innerHeight - PREVIA_ALTA - 8);
    const x = e.clientX + 18 + largura > window.innerWidth - 8
            ? e.clientX - 18 - largura
            : e.clientX + 18;
    previa.style.left = Math.max(8, x) + "px";
    previa.style.top = Math.max(8, y) + "px";
  });
}
