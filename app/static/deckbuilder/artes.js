"use strict";

/* =========================================================================
   ESCOLHER A ARTE

   A frase que sustenta o desenho inteiro: SCRYFALL É O CATÁLOGO DO QUE
   EXISTE; MPC FILL É O ARQUIVO QUE IMPRIME. A tira de cima mostra as
   impressões oficiais — edição, ano, artista — e serve pra pessoa RECONHECER
   a arte que quer; clicar nela não escolhe nada, só semeia o filtro da grade.
   O que fica guardado é sempre um arquivo do MPC Fill, porque é dele que o
   `pdf_generator` baixa desde sempre.

   DUAS REQUISIÇÕES POR DECK, E SÓ NO CLIQUE. A busca (`/artes/buscar`) traz
   os ids de todas as cartas de uma vez e é cara; os metadados vêm por carta
   aberta, só do que está à vista. Sol Ring tem 713 artes — pedir os
   metadados do deck inteiro seria buscar o que ninguém vai olhar.

   `loading="lazy"` e 24 por página não são detalhe: as miniaturas vêm do
   Google Drive, e uma grade que carrega 700 imagens de uma vez toma 429 e
   deixa de mostrar qualquer coisa.

   CARTA DE DUAS FACES TEM DUAS ESCOLHAS. Frente e verso são dois arquivos
   no papel, e o MPC Fill indexa cada face pelo próprio nome — então cada lado
   tem a sua busca, a sua grade e a sua linha no servidor (`artes.FACES`).

   FICHA SE ESCOLHE AQUI TAMBÉM. As fichas que o deck cria vão pro pedido
   junto com as cartas e passam pela mesma modal, com duas diferenças: a
   busca vai como "t:Nome" (`nomeDaBusca`), e a escolha é guardada pela chave
   da ficha, não pelo nome (`nomeDaArte`).
   ========================================================================= */

const ARTES_POR_PAGINA = 24;
// Guardado no navegador pelo mesmo motivo da coluna do maybeboard: é jeito de
// trabalhar, e quem prefere a modal fechando sozinha prefere sempre.
const CHAVE_FECHA_ARTE = "forja.deck.arte-fecha";

const arte = {
  carta: null,        // a carta aberta agora
  face: "frente",     // "frente" | "verso": o lado que a grade está escolhendo
  busca: "",          // o nome que se pergunta ao MPC Fill por esse lado
  ids: [],            // todos os ids de arte dele, na ordem das fontes
  meta: {},           // id -> metadados, preenchido por carta aberta
  pagina: 0,
  // `impressao` = {k, sigla, artista} da impressão clicada na vitrine, ou
  // null. `k` é a posição dela na tira, pra a tira saber qual acender.
  filtro: {texto: "", fonte: "", dpi: 0, impressao: null},
  impressoes: null,   // null = buscando, false = não deu, array = ok
  escolhas: {},       // nome achatado -> {frente:{...}, verso:{...}}
  fontes: [],
  // Os ids de arte já buscados, pelo nome que foi perguntado. `null` = ainda
  // não busquei nada; `buscandoDeck` segura a busca do deck inteiro em voo,
  // pra duas cartas abertas em seguida não pedirem o deck duas vezes.
  porNome: null,
  buscandoDeck: null,
};

/* O nome achatado, do MESMO jeito que o `cartas.normalizar` do servidor:
   ligaduras abertas, sem acento, sem caixa, apóstrofo some e o resto da
   pontuação vira espaço. Aqui não dá pra chamar o Python, então a regra mora
   duas vezes — e a que importa é a do servidor, que é quem grava. Esta serve
   pra a tela achar a escolha que ele devolveu: um passo a menos aqui e
   "Atraxa, Praetors' Voice" aparece no padrão com a arte escolhida, e o
   "Gerar pedido" nunca liga. */
const LIGATURAS_ARTE = {"æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe",
                        "ø": "o", "Ø": "o", "ß": "ss", "đ": "d"};

function chaveDaArte(nome){
  return String(nome || "")
    .replace(/[æÆœŒøØßđ]/g, (c) => LIGATURAS_ARTE[c])
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/['’ʼ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/* O nome sob o qual a arte é guardada no servidor. A carta é o próprio nome;
   a ficha é a `chave_arte` que o servidor devolve com ela, porque nome não
   identifica ficha (ver `artes.chave_da_ficha`). */
function nomeDaArte(carta){
  return carta.chaveArte || carta.nome;
}

function arteEscolhida(carta, face){
  if (!carta) return null;
  return (arte.escolhas[chaveDaArte(nomeDaArte(carta))] || {})[face || "frente"] || null;
}

/* Duas faces DE PAPEL, e não de texto: carta partida e aventura têm duas
   metades numa imagem só, e a base local já devolve o verso vazio pra elas
   (ver `cartas._imagem_verso`). */
function temVerso(carta){
  return !!(carta && carta.imagem_verso);
}

/* Como a tela do MPC Fill escreve uma busca de ficha: "t:Treasure". O
   servidor desfaz o prefixo na hora de perguntar (ver `mpcfill._consulta`). */
const PREFIXO_FICHA = "t:";

/* O que se pergunta ao MPC Fill por um lado da carta. A frente vai com o nome
   inteiro, que o servidor corta no " // " (ver `mpcfill._consulta`); o verso
   vai só com o nome dele, porque a biblioteca deles indexa cada face pelo
   próprio nome. Ficha vai com o prefixo de ficha. */
function nomeDaBusca(carta, face){
  const nome = face !== "verso" ? carta.nome
    : (carta.nome.split(" // ")[1] || "").trim() || carta.nome;
  return carta.ficha ? PREFIXO_FICHA + nome : nome;
}

function miniaturaDoDrive(id, largura){
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${largura}`;
}

/* Um lado da carta do jeito que ele vai sair: o arquivo escolhido quando há,
   e a arte padrão da Scryfall quando não. É o que a prévia do hover e a
   galeria mostram — ver a arte oficial no lugar da que se escolheu faria a
   escolha parecer não ter pegado. */
function imagemDaFace(carta, face, largura){
  const escolha = arteEscolhida(carta, face);
  if (escolha) return miniaturaDoDrive(escolha.drive_id, largura || 500);
  return (face === "verso" ? carta.imagem_verso : carta.imagem) || "";
}

/* O botão na linha do deck. Mostra a miniatura quando há arte escolhida, e o
   ícone quando está no padrão: ver de relance o que já foi customizado é
   metade do valor. É o botão da FRENTE; o verso se escolhe dentro da modal,
   ou pelo quadro dele na aba Artes. */
function botaoDeArte(carta){
  const escolha = arteEscolhida(carta);
  const nome = escapar(carta.nome);
  const fundo = escolha
    ? ` style="background-image:url('${escapar(miniaturaDoDrive(escolha.drive_id, 40))}')"` : "";
  return `<button class="mini ${escolha ? "tem-arte" : ""}"
    data-arte-carta="${nome}"${fundo}
    title="${escolha ? "Arte escolhida: " + escapar(escolha.arquivo || escolha.drive_id)
                     : "Escolher a arte de " + nome}"
    aria-label="Escolher arte de ${nome}">${escolha ? "" : ico("image")}</button>`;
}

/* Tudo o que mostra arte escolhida, de uma vez: a linha do deck (o botão), o
   maybeboard, a galeria (a prévia do hover sai dos atributos que eles
   escrevem) e o "Gerar pedido", que só vale com todas escolhidas. */
function redesenharArtes(){
  desenharDeck();
  desenharMaybe();
  desenharGaleria();
  atualizarBotaoPedido();
}

/* As escolhas do deck inteiro, uma vez, ao abrir. Sem rede por linha: a lista
   desenha 100 botões e uma consulta por botão seria 100 requisições. */
async function carregarArtes(){
  if (!estado.id) return;
  try {
    const r = await api(`/decks/${estado.id}/artes`);
    arte.escolhas = r.escolhas || {};
  } catch (e){
    return;   // sem isto a lista mostra todos no padrão, que é o que eles são
  }
  redesenharArtes();
}

/* `nome` é o que o quadro carrega em `data-arte-carta`: o nome da carta, ou a
   chave da ficha (ver `nomeDaArte`). */
function acharCartaDaArte(nome){
  const noDeck = estado.cartas.find(e => e.carta && e.carta.nome === nome);
  if (noDeck) return noDeck.carta;
  return estado.comandantes.find(c => c.nome === nome) ||
    fichasDoDeck().find(f => f.chaveArte === nome) || null;
}

async function abrirEscolhaDeArte(nome, face){
  const carta = acharCartaDaArte(nome);
  if (!carta) return;
  if (!estado.id) return toast("Salve o deck antes de escolher artes.");

  arte.carta = carta;
  arte.meta = {};
  arte.filtro = {texto: "", fonte: "", dpi: 0, impressao: null};
  // Ficha não tem vitrine de impressões: a Scryfall responde pelo nome, e
  // "Soldier" seria a tira de todos os Soldier já impressos, de toda cor e
  // corpo. O que ajuda é ver a ficha que o deck cria (`desenharVitrine`).
  arte.impressoes = carta.ficha ? [] : null;
  $("arte-titulo").textContent = carta.ficha ? rotuloDaFicha(carta) : carta.nome;
  $("arte-busca").value = "";
  $("arte-fonte").value = "";
  $("arte-dpi").value = "0";
  // A prévia do hover fica presa embaixo da modal se não for dispensada: o
  // clique não move o mouse, e é movimento que a apaga.
  $("previa").classList.remove("mostra");
  $("arte-fundo").hidden = false;
  travarRolagem(true);

  // As duas viajam juntas: a vitrine é da Scryfall e a grade é do MPC Fill,
  // e nenhuma das duas precisa esperar a outra.
  if (!carta.ficha) buscarImpressoes(carta.nome);
  mostrarFace(face === "verso" && temVerso(carta) ? "verso" : "frente");
}

/* Troca o lado que a grade escolhe. O filtro de impressão FICA: quem achou a
   frente "de Kaladesh" quer o verso da mesma impressão, e é exatamente o que
   o filtro já está dizendo. */
function mostrarFace(face){
  arte.face = face;
  arte.busca = nomeDaBusca(arte.carta, face);
  arte.ids = [];
  arte.pagina = 0;
  $("arte-filtros").hidden = true;
  $("arte-conta").textContent = "Procurando as artes…";
  $("arte-grade").innerHTML = "";
  $("arte-paginas").innerHTML = "";
  desenharFaces();
  desenharVitrine();
  buscarArtesDaCarta(arte.busca);
}

/* O seletor de lado, só em carta de duas faces. O ✓ diz qual lado já tem
   arquivo escolhido — sem ele, escolher a frente e fechar deixaria o verso
   no padrão sem nada na tela contando. */
function desenharFaces(){
  const seg = $("arte-faces");
  seg.hidden = !temVerso(arte.carta);
  if (seg.hidden) return;
  for (const b of seg.querySelectorAll("[data-face]")){
    const f = b.dataset.face;
    const ativa = f === arte.face;
    b.classList.toggle("ativa", ativa);
    b.setAttribute("aria-pressed", String(ativa));
    const feita = !!arteEscolhida(arte.carta, f);
    b.title = feita ? "Arte escolhida pra este lado" : "Este lado está na arte padrão";
    b.innerHTML = (f === "verso" ? "Verso" : "Frente") + (feita ? " " + ico("check") : "");
  }
}

async function buscarImpressoes(nome){
  try {
    const r = await api(`/cartas/impressoes?nome=${encodeURIComponent(nome)}`);
    if (!arte.carta || arte.carta.ficha || arte.carta.nome !== nome) return;   // trocou de carta
    arte.impressoes = r.impressoes || [];
  } catch (e){
    // `false` e não `[]`: "não consegui perguntar" e "essa carta só saiu uma
    // vez" são coisas diferentes, e a tela diz as duas de formas diferentes.
    arte.impressoes = false;
  }
  desenharVitrine();
}

/* A busca cobre o DECK INTEIRO na primeira vez, não a carta aberta.

   É a forma que a API deles permite (uma requisição aceita a lista toda) e é
   o que torna escolher arte de 100 cartas suportável: abrir a segunda carta
   não custa requisição nenhuma. Buscar por carta seria uma ida ao servidor
   deles por clique — que é exatamente o que o cache e o freio deste módulo
   existem pra evitar.

   O resultado fica em `arte.porNome` pela sessão da página. O que não veio
   nele — carta acrescentada depois, e o VERSO das cartas de duas faces, que
   a busca do deck não pergunta — é buscado sozinho, na hora em que abre.

   As fichas também ficam fora da busca do deck, e vão TODAS juntas na
   primeira que se abre: quem abre uma costuma abrir as outras em seguida. */
async function buscarArtesDaCarta(busca){
  try {
    if (!arte.porNome){
      arte.buscandoDeck = arte.buscandoDeck || pedirArtes(null);
      try { await arte.buscandoDeck; } finally { arte.buscandoDeck = null; }
    }
    if (!(busca in arte.porNome)){
      const pedir = [busca];
      // Duas fichas de mesmo nome (as Wurm do Wurmcoil) são a mesma busca.
      for (const f of arte.carta && arte.carta.ficha ? fichasDoDeck() : []){
        const b = nomeDaBusca(f, "frente");
        if (!(b in arte.porNome) && !pedir.includes(b)) pedir.push(b);
      }
      await pedirArtes(pedir);
    }
  } catch (e){
    if (arte.busca !== busca) return;
    $("arte-conta").textContent = e.message;
    $("arte-grade").innerHTML = "";
    return;
  }
  if (arte.busca !== busca) return;   // trocou de carta ou de lado
  aplicarIds(busca, arte.porNome[busca] || []);
}

/* `nomes` null = o deck inteiro, que é o que o servidor busca sem lista. */
async function pedirArtes(nomes){
  const r = await api(`/decks/${estado.id}/artes/buscar`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(nomes ? {nomes} : {}),
  });
  arte.porNome = Object.assign(arte.porNome || {}, r.por_nome || {});
  arte.fontes = r.fontes || arte.fontes;
}

function aplicarIds(busca, ids){
  arte.ids = ids;
  montarFiltroDeFonte();
  $("arte-filtros").hidden = !ids.length;
  desenharGrade();
  carregarMetadados(busca, ids);
}

/* Os metadados de TODAS as artes deste lado da carta, numa requisição só.

   Medido: os 713 ids de Sol Ring voltam completos em 0,6 s. Carregar por
   página deixaria o filtro enxergando 24 arquivos de 713, e filtrar por
   "Kaladesh" não acharia quase nada, sem nada na tela dizendo por quê.

   É uma requisição por carta ABERTA, não por deck, e o servidor guarda o
   resultado por uma semana. */
async function carregarMetadados(busca, ids){
  const faltando = ids.filter(id => !arte.meta[id]);
  if (!faltando.length) return;
  try {
    const r = await api("/artes/metadados", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ids: faltando}),
    });
    if (arte.busca !== busca) return;   // trocou de carta ou de lado
    Object.assign(arte.meta, r.artes || {});
    desenharGrade();
  } catch (e){
    // A grade já está desenhada com as miniaturas: sem metadados ela perde o
    // nome do arquivo e o DPI, e continua servindo pra escolher pela ARTE,
    // que é o que a pessoa veio fazer. O filtro é que fica sem serventia.
    $("arte-conta").textContent += " — sem os detalhes (nome do arquivo e DPI)";
  }
}

function montarFiltroDeFonte(){
  const sel = $("arte-fonte");
  sel.innerHTML = `<option value="">todas as fontes</option>` +
    arte.fontes.map(f =>
      `<option value="${escapar(f.nome)}">${escapar(f.nome)}</option>`).join("");
  sel.value = arte.filtro.fonte;
}

/* A imagem dentro de uma moldura que sabe deitar. Carta partida (os Rooms,
   Fire // Ice) é impressa de lado e a imagem vem em pé, com o texto de lado:
   a moldura toma a proporção da carta DEITADA e a imagem gira dentro dela —
   o mesmo giro da prévia e da modal da carta. */
function quadroHTML(src, deitada, extra){
  return `<span class="quadro ${deitada ? "deitada" : ""}">${src
    ? `<img src="${escapar(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : ""}${extra || ""}</span>`;
}

/* No lugar da tira de impressões, a ficha que o deck cria, com o que está
   escrito nela. É o que separa um arquivo certo de um quase certo: a grade de
   "Wurm" tem "Wurm (Deathtouch)" e "Wurm (Lifelink)", e só o texto diz qual
   das duas esta é. */
function vitrineDaFicha(f){
  const verso = arte.face === "verso";
  const corpo = f.poder && f.resistencia ? ` · ${f.poder}/${f.resistencia}` : "";
  return `<span class="arte-ficha">${quadroHTML(
      (verso && f.imagem_verso) || f.imagem, false)}</span>
    <span class="arte-nota" style="max-width:260px">É esta a ficha que o deck
      cria: <b>${escapar(f.tipo || f.nome)}${escapar(corpo)}</b>${f.texto
        ? ` — ${escapar(f.texto)}` : ""}. Escolha abaixo um arquivo que diga o
      mesmo.</span>`;
}

function desenharVitrine(){
  const caixa = $("arte-vitrine");
  if (arte.carta && arte.carta.ficha){
    caixa.innerHTML = vitrineDaFicha(arte.carta);
    return;
  }
  if (arte.impressoes === null){
    caixa.innerHTML = `<span class="arte-nota">Carregando as impressões oficiais…</span>`;
    return;
  }
  if (arte.impressoes === false){
    caixa.innerHTML = `<span class="arte-nota">Não consegui falar com a
      Scryfall — a grade abaixo continua funcionando.</span>`;
    return;
  }
  if (!arte.impressoes.length){ caixa.innerHTML = ""; return; }

  const verso = arte.face === "verso";
  const deitada = !!(arte.carta && arte.carta.deitada);
  const acesa = arte.filtro.impressao ? arte.filtro.impressao.k : -1;
  caixa.innerHTML = `<span class="arte-nota" style="max-width:120px">Estas são
    as artes oficiais. Servem pra achar — o que imprime é o arquivo abaixo.</span>`
    + arte.impressoes.slice(0, 24).map((i, k) => `
      <button class="arte-impressao ${deitada ? "deitada" : ""} ${k === acesa ? "ativa" : ""}"
        data-impressao="${k}"
        title="${escapar(i.edicao)}${i.artista ? " · " + escapar(i.artista) : ""}">
        ${quadroHTML((verso && i.imagem_verso) || i.imagem, deitada)}
        <small>${escapar(i.sigla)}${i.lancamento
          ? " · " + escapar(i.lancamento.slice(0, 4)) : ""}</small>
      </button>`).join("");
}

/* Os ids que sobram depois dos filtros. Os três olham os metadados, que
   `carregarMetadados` traz de todas as artes do lado aberto de uma vez —
   então o filtro vê o conjunto inteiro, não só a página à vista. */
function idsFiltrados(){
  const f = arte.filtro;
  if (!f.texto && !f.fonte && !f.dpi && !f.impressao) return arte.ids;
  return arte.ids.filter(id => {
    const m = arte.meta[id];
    // Sem metadado ainda (a requisição está em voo): não esconde o que não
    // conhece — a alternativa seria a grade encolher e voltar a crescer
    // sozinha enquanto a pessoa olha.
    if (!m) return true;
    if (f.fonte && m.fonte !== f.fonte) return false;
    if (f.dpi && (m.dpi || 0) < f.dpi) return false;
    if (f.texto && !(m.arquivo || "").toLowerCase().includes(f.texto)) return false;
    if (f.impressao && !casaImpressao(m.arquivo, f.impressao)) return false;
    return true;
  });
}

function semAcento(s){
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* Se um arquivo do MPC Fill é daquela impressão oficial. Não há campo de
   edição nos metadados deles — só o nome do arquivo, escrito à mão por quem
   subiu —, então isto lê as convenções que aparecem de fato:

     "Sol Ring [MSC] {214}.png"      sigla entre colchetes, número em chaves
     "Sol Ring (SLD1696).png"        sigla colada ao número de 4 dígitos
     "Sol Ring (ECC, Lorwyn).png"    sigla solta entre separadores
     "Sol Ring (Mark Tedin 1).png"   o artista, sem edição nenhuma

   A sigla só casa como palavra inteira: "SOC" não pode achar "Social", e
   "CC" não pode achar "(CC10007)", que é CC1 nº 0007. O artista cobre as
   edições antigas, cujos scans quase nunca levam sigla. */
function casaImpressao(arquivo, imp){
  const nome = semAcento(arquivo);
  const sigla = semAcento(imp.sigla).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (sigla && new RegExp(`(^|[^a-z0-9])${sigla}(\\d{4}\\)|[^a-z0-9]|$)`).test(nome))
    return true;
  return !!imp.artista && nome.includes(semAcento(imp.artista));
}

/* As páginas que o paginador mostra: a primeira, a última e duas de cada lado
   da atual, com "…" no vão — `1 … 3 4 5 6 7 … 10`. Cinco no meio SEMPRE,
   inclusive perto das pontas: com a janela encolhendo ali, os números
   trocariam de lugar debaixo do mouse a cada clique. Até sete páginas cabem
   todas e não há vão nenhum. Recebe e devolve páginas contadas do zero. */
function paginasVisiveis(atual, total){
  if (total <= 7) return Array.from({length: total}, (_, i) => i);
  const ini = Math.min(Math.max(1, atual - 2), total - 6);
  const fim = ini + 4;
  const saida = [0];
  if (ini > 1) saida.push("…");
  for (let p = ini; p <= fim; p++) saida.push(p);
  if (fim < total - 2) saida.push("…");
  saida.push(total - 1);
  return saida;
}

function desenharPaginas(paginas){
  const nav = $("arte-paginas");
  if (paginas <= 1){ nav.innerHTML = ""; return; }
  const atual = arte.pagina;
  const seta = (alvo, desligada, rotulo, icone) =>
    `<button class="pag" data-pagina="${alvo}" ${desligada ? "disabled" : ""}
       title="${rotulo}" aria-label="${rotulo}">${ico(icone)}</button>`;
  nav.innerHTML = seta(atual - 1, atual === 0, "Página anterior", "caret-left") +
    paginasVisiveis(atual, paginas).map(p => p === "…"
      ? `<span class="pag-vao" aria-hidden="true">…</span>`
      : `<button class="pag ${p === atual ? "ativa" : ""}" data-pagina="${p}"
           ${p === atual ? 'aria-current="page"' : ""}
           aria-label="Página ${p + 1}">${p + 1}</button>`).join("") +
    seta(atual + 1, atual >= paginas - 1, "Próxima página", "caret-right");
}

function desenharGrade(){
  const ids = idsFiltrados();
  const total = ids.length;
  const grade = $("arte-grade");
  grade.classList.toggle("deitada", !!(arte.carta && arte.carta.deitada));
  if (!total){
    const imp = arte.filtro.impressao;
    $("arte-conta").textContent = !arte.ids.length
      ? `O MPC Fill não tem arte pra ${arte.face === "verso" ? "o verso desta" : "esta"} ${
          arte.carta.ficha ? "ficha" : "carta"}.`
      : imp
        ? `Nenhum arquivo do MPC Fill identificado como ${imp.sigla}${
            imp.artista ? " ou de " + imp.artista : ""} — clique de novo na ` +
          "impressão pra ver todas."
        : "Nenhuma arte com esses filtros.";
    grade.innerHTML = "";
    desenharPaginas(0);
    return;
  }
  const paginas = Math.ceil(total / ARTES_POR_PAGINA);
  if (arte.pagina >= paginas) arte.pagina = 0;
  const inicio = arte.pagina * ARTES_POR_PAGINA;
  const daPagina = ids.slice(inicio, inicio + ARTES_POR_PAGINA);

  $("arte-conta").textContent =
    `${total} arte(s) — mostrando ${inicio + 1}–${inicio + daPagina.length}`;
  desenharPaginas(paginas);

  const escolhida = arteEscolhida(arte.carta, arte.face);
  const marcado = escolhida ? escolhida.drive_id : "";
  const deitada = !!arte.carta.deitada;
  grade.innerHTML = daPagina.map(id => {
    const m = arte.meta[id] || {};
    return `<button class="arte-op ${id === marcado ? "ativa" : ""}" data-arte-id="${escapar(id)}">
      ${quadroHTML(m.miniatura || miniaturaDoDrive(id, 400), deitada)}
      <small>${escapar(m.arquivo || "…")}${m.dpi ? ` · ${m.dpi} DPI` : ""}</small>
    </button>`;
  }).join("");
}

function irParaPagina(p){
  arte.pagina = p;
  desenharGrade();
  // A página nova começa do começo: trocar de página com a grade rolada até o
  // fim mostraria o fim da página seguinte.
  $("arte-grade").scrollTop = 0;
}

async function usarArte(id){
  // Guardados antes da rede: a modal pode fechar ou trocar de lado enquanto
  // o servidor responde, e a escolha é da carta e do lado que foram clicados.
  const carta = arte.carta, face = arte.face;
  const m = arte.meta[id] || {};
  const escolha = {drive_id: id, arquivo: m.arquivo || "", fonte: m.fonte || "",
                   dpi: m.dpi || 0};
  try {
    await api(`/decks/${estado.id}/artes`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(Object.assign({nome: nomeDaArte(carta), face}, escolha)),
    });
  } catch (e){
    return toast("Não consegui guardar: " + e.message);
  }
  const chave = chaveDaArte(nomeDaArte(carta));
  arte.escolhas[chave] = Object.assign({}, arte.escolhas[chave], {[face]: escolha});
  redesenharArtes();
  toast(face === "verso" ? "Arte do verso escolhida." : "Arte escolhida.");
  if ($("arte-fecha").checked) return fecharArte();
  if (arte.carta !== carta || arte.face !== face) return;
  desenharGrade();
  desenharFaces();
}

async function voltarAoPadrao(){
  if (!arte.carta) return;
  const carta = arte.carta, face = arte.face;
  try {
    await api(`/decks/${estado.id}/artes?nome=${
      encodeURIComponent(nomeDaArte(carta))}&face=${face}`, {method: "DELETE"});
  } catch (e){
    return toast("Não consegui: " + e.message);
  }
  const chave = chaveDaArte(nomeDaArte(carta));
  const faces = Object.assign({}, arte.escolhas[chave]);
  delete faces[face];
  if (Object.keys(faces).length) arte.escolhas[chave] = faces;
  else delete arte.escolhas[chave];
  redesenharArtes();
  toast(face === "verso" ? "O verso voltou pra arte padrão." : "Voltou pra arte padrão.");
  if (arte.carta !== carta || arte.face !== face) return;
  desenharGrade();
  desenharFaces();
}

/* A página atrás não rola com a modal aberta: a roda do mouse que passa do
   fim da grade continuaria rolando o deck por baixo, e ao fechar a pessoa
   estaria noutro lugar da lista. A barra de rolagem some junto, e a página
   pularia pro lado pela largura dela — `com-barra` guarda o lugar, só onde
   havia barra (no toque ela flutua sobre o conteúdo e não ocupa nada). */
function travarRolagem(ligar){
  const raiz = document.documentElement;
  raiz.classList.toggle("com-barra", ligar && window.innerWidth > raiz.clientWidth);
  raiz.classList.toggle("sem-rolar", ligar);
}

function fecharArte(){
  $("arte-fundo").hidden = true;
  arte.carta = null;
  arte.busca = "";
  travarRolagem(false);
}

function ligarArte(){
  $("arte-fechar").addEventListener("click", fecharArte);
  $("arte-fundo").addEventListener("click", (e) => {
    if (e.target.id === "arte-fundo") fecharArte();
  });

  try { $("arte-fecha").checked = localStorage.getItem(CHAVE_FECHA_ARTE) === "1"; }
  catch (e){ /* navegador privado: a modal fica aberta, que é o padrão */ }
  $("arte-fecha").addEventListener("change", (e) => {
    try { localStorage.setItem(CHAVE_FECHA_ARTE, e.target.checked ? "1" : "0"); }
    catch (erro){ /* vale só pra esta visita */ }
  });

  $("arte-faces").addEventListener("click", (e) => {
    const b = e.target.closest("[data-face]");
    if (b && arte.carta && b.dataset.face !== arte.face) mostrarFace(b.dataset.face);
  });

  $("arte-vitrine").addEventListener("click", (e) => {
    const b = e.target.closest("[data-impressao]");
    if (!b) return;
    // Clicar numa impressão NÃO escolhe nada: ela é da Scryfall, e o que
    // imprime é o arquivo do MPC Fill. O que ela faz é filtrar a grade pelos
    // arquivos daquela impressão (ver `casaImpressao`) — é assim que se acha
    // "a de Kaladesh" entre setecentas. Clicar de novo na mesma tira o filtro.
    const k = Number(b.dataset.impressao);
    const i = arte.impressoes[k];
    if (!i) return;
    const ligar = !b.classList.contains("ativa");
    arte.filtro.impressao = ligar ? {k, sigla: i.sigla || "", artista: i.artista || ""} : null;
    arte.pagina = 0;
    for (const outro of $("arte-vitrine").querySelectorAll("[data-impressao]")){
      outro.classList.toggle("ativa", ligar && outro === b);
    }
    desenharGrade();
  });

  $("arte-grade").addEventListener("click", (e) => {
    const b = e.target.closest("[data-arte-id]");
    if (b) usarArte(b.dataset.arteId);
  });

  $("arte-padrao").addEventListener("click", voltarAoPadrao);
  $("arte-paginas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pagina]");
    if (b && !b.disabled) irParaPagina(Number(b.dataset.pagina));
  });

  let atraso = 0;
  $("arte-busca").addEventListener("input", (e) => {
    clearTimeout(atraso);
    const v = e.target.value.trim().toLowerCase();
    atraso = setTimeout(() => {
      arte.filtro.texto = v; arte.pagina = 0; desenharGrade();
    }, 250);
  });
  $("arte-fonte").addEventListener("change", (e) => {
    arte.filtro.fonte = e.target.value; arte.pagina = 0; desenharGrade();
  });
  $("arte-dpi").addEventListener("change", (e) => {
    arte.filtro.dpi = Number(e.target.value) || 0; arte.pagina = 0; desenharGrade();
  });
}
