/* =========================================================================
   ESCOLHER A ARTE

   TRÊS ORIGENS, UM SEGMENTO PRA CADA. O que fica guardado é sempre um id que
   o `pdf_generator` sabe imprimir (ver `arte_id.py`), e cada origem chega a
   ele de um jeito:

   * MPC FILL — a biblioteca de arquivos de impressão. A tira de cima mostra
     as impressões oficiais da Scryfall — edição, ano, artista — e serve pra
     RECONHECER a arte que se quer: clicar nela não escolhe nada, só filtra a
     grade pelos arquivos daquela impressão.
   * SCRYFALL — a imagem oficial de cada impressão, em resolução menor que a
     do MPC Fill. Scan pequeno vem marcado como baixa resolução.
   * ENVIAR — um arquivo do computador de quem monta, conferido pelo servidor
     (ver `artes_enviadas.py`).

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

   CÓPIA TEM ESCOLHA PRÓPRIA QUANDO SE QUER. Com "Uma arte por cópia" ligado,
   o que se escolhe vale pra cópia do seletor; a cópia sem escolha própria usa
   a arte de todas (ver `artes.py`).

   FICHA SE ESCOLHE AQUI TAMBÉM. As fichas que o deck cria vão pro pedido
   junto com as cartas e passam pela mesma modal, com duas diferenças: a
   busca vai como "t:Nome" (`nomeDaBusca`), e a escolha é guardada pela chave
   da ficha, não pelo nome (`nomeDaArte`).
   ========================================================================= */

import {$, escapar} from "../comum/dom.js";
import {desenharDeck, desenharMaybe} from "./desenho.js";
import {estado} from "./estado.js";
import {atualizarBotaoPedido, desenharGaleria} from "./galeria.js";
import {api} from "./salvar.js";
import {fichasDoDeck, rotuloDaFicha} from "./tokens.js";
import {ico, semAcento, toast} from "./utilidades.js";

const ARTES_POR_PAGINA = 24;
// Guardado no navegador pelo mesmo motivo da coluna do maybeboard: é jeito de
// trabalhar, e quem prefere a modal fechando sozinha prefere sempre.
const CHAVE_FECHA_ARTE = "forja.deck.arte-fecha";
// O PNG da Scryfall tem 745 px de largura, e a carta 2,48 pol (ver
// `artes.DPI_SCRYFALL`).
const DPI_SCRYFALL = 300;
// O `image_status` da Scryfall sem imagem que se imprima (ver
// `artes.STATUS_SEM_IMAGEM`).
const STATUS_SEM_IMAGEM = ["missing", "placeholder"];
const AVISO_BAIXA = "em baixa resolução: pode sair borrada no papel";

const arte = {
  carta: null,        // a carta aberta agora
  face: "frente",     // "frente" | "verso": o lado que a grade está escolhendo
  // O segmento aberto. Fica de uma carta pra outra: quem escolhe pela
  // Scryfall costuma seguir nela.
  origem: "mpcfill",  // "mpcfill" | "scryfall" | "enviar"
  copia: 0,           // 0 = todas as cópias; n = a n-ésima (ver `artes.py`)
  porCopia: false,    // o "Uma arte por cópia" desta carta
  busca: "",          // o nome que se pergunta ao MPC Fill por esse lado
  ids: [],            // todos os ids de arte dele, na ordem das fontes
  carregandoIds: false,
  erroIds: "",
  meta: {},           // id -> metadados, preenchido por carta aberta
  pagina: 0,
  // `impressao` = {k, sigla, artista} da impressão clicada na vitrine, ou
  // null. `k` é a posição dela na tira, pra a tira saber qual acender.
  filtro: {texto: "", fonte: "", dpi: 0, impressao: null},
  impressoes: null,   // null = buscando, false = não deu, array = ok
  // As opções da grade da Scryfall como foram desenhadas: o clique acha a
  // escolhida pela posição nesta lista.
  opcoesScryfall: [],
  escolhas: {},       // nome achatado -> {frente, verso, copias: {n: {frente, verso}}}
  fontes: [],
  // Os ids de arte já buscados, pelo nome que foi perguntado. `null` = ainda
  // não busquei nada; `buscandoDeck` segura a busca do deck inteiro em voo,
  // pra duas cartas abertas em seguida não pedirem o deck duas vezes.
  porNome: null,
  buscandoDeck: null,
  enviando: false,
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
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/['’ʼ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/* O nome sob o qual a arte é guardada no servidor. A carta é o próprio nome;
   a ficha é a `chave_arte` que o servidor devolve com ela, porque nome não
   identifica ficha (ver `artes.chave_da_ficha`). */
export function nomeDaArte(carta){
  return carta.chaveArte || carta.nome;
}

/* `escolhas` é o mapa de outro deck — o segundo deck do goldfish, que tem as
   artes dele. Sem ela, valem as do deck aberto. */
function escolhasDaCarta(carta, escolhas){
  return (escolhas || arte.escolhas)[chaveDaArte(nomeDaArte(carta))] || {};
}

/* Com `copia`, a arte daquela cópia: a dela, ou a de todas. Sem `copia`, a
   de todas — ou, na carta que só tem escolha por cópia, a da primeira cópia
   que tem, que é o que a linha do deck e a prévia do hover mostram. */
export function arteEscolhida(carta, face, escolhas, copia){
  if (!carta) return null;
  const daCarta = escolhasDaCarta(carta, escolhas);
  const lado = face || "frente";
  const copias = daCarta.copias || {};
  if (copia) return (copias[copia] || {})[lado] || daCarta[lado] || null;
  if (daCarta[lado]) return daCarta[lado];
  const primeira = Object.keys(copias).map(Number).sort((a, b) => a - b)
    .find(n => copias[n][lado]);
  return primeira ? copias[primeira][lado] : null;
}

/* Se a carta tem escolha por cópia: é o que liga o "Uma arte por cópia" ao
   abrir a modal, e o que faz a galeria separar as cópias. */
export function temArtePorCopia(carta){
  return Object.keys(escolhasDaCarta(carta).copias || {}).length > 0;
}

/* Se toda cópia de um lado tem arte pra imprimir — a conta do `artes.pedido`. */
export function ladoPronto(carta, face, quantidade){
  for (let n = 1; n <= (quantidade || 1); n++){
    if (!arteEscolhida(carta, face, null, n)) return false;
  }
  return true;
}

/* Quantas cópias da carta vão pro papel. Comandante e ficha são uma. */
function quantidadeNoPapel(carta){
  if (!carta || carta.ficha) return 1;
  const entrada = estado.cartas.find(e => e.carta && e.carta.nome === carta.nome);
  return entrada ? entrada.quantidade : 1;
}

/* Duas faces DE PAPEL, e não de texto: carta partida e aventura têm duas
   metades numa imagem só, e a base local já devolve o verso vazio pra elas
   (ver `cartas._imagem_verso`). */
export function temVerso(carta){
  return !!(carta && carta.imagem_verso);
}

/* Como a tela do MPC Fill escreve uma busca de ficha: "t:Treasure". O
   servidor desfaz o prefixo na hora de perguntar (ver `mpcfill._consulta`). */
const PREFIXO_FICHA = "t:";

/* O nome de um lado só: "Delver of Secrets" ou "Insectile Aberration". */
function nomeDoLado(carta, face){
  const partes = carta.nome.split(" // ");
  return ((face === "verso" ? partes[1] : partes[0]) || carta.nome).trim();
}

/* O que se pergunta ao MPC Fill por um lado da carta. A frente vai com o nome
   inteiro, que o servidor corta no " // " (ver `mpcfill._consulta`); o verso
   vai só com o nome dele, porque a biblioteca deles indexa cada face pelo
   próprio nome. Ficha vai com o prefixo de ficha. */
function nomeDaBusca(carta, face){
  const nome = face !== "verso" ? carta.nome : nomeDoLado(carta, face);
  return carta.ficha ? PREFIXO_FICHA + nome : nome;
}

/* A forma dos ids de arte e das URLs de imagem da Scryfall, as mesmas do
   `arte_id.py`. */
const ID_SCRYFALL = /^scryfall:([0-9a-f]{8}-[0-9a-f-]{27}):(front|back)$/;
const ID_ENVIADA = /^enviada:([0-9a-f]{64})$/;
const URL_SCRYFALL = /\/(front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f]{8}-[0-9a-f-]{27})\./;

/* A miniatura de uma arte guardada, de onde o id disser. A da Scryfall vem
   no tamanho mais próximo do pedido: `small`, `normal` e `large` têm 146, 488
   e 672 px de largura. */
function miniaturaDaArte(id, largura){
  const scryfall = ID_SCRYFALL.exec(id || "");
  if (scryfall){
    const impressao = scryfall[1];
    const tamanho = largura > 488 ? "large" : largura > 146 ? "normal" : "small";
    return `https://cards.scryfall.io/${tamanho}/${scryfall[2]}/${impressao[0]}/${
      impressao[1]}/${impressao}.jpg`;
  }
  const enviada = ID_ENVIADA.exec(id || "");
  if (enviada) return `/artes/enviadas/${enviada[1]}/miniatura`;
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${largura}`;
}

/* O id da Scryfall tirado de uma URL de imagem dela. É assim que a ficha,
   que não tem lista de impressões, oferece a própria imagem. */
function idDaImagemDaScryfall(url){
  const achado = URL_SCRYFALL.exec(url || "");
  return achado ? `scryfall:${achado[2]}:${achado[1]}` : "";
}

function rotuloDaEscolha(escolha){
  return [escolha.arquivo || escolha.arte_id, escolha.fonte].filter(Boolean).join(" · ");
}

/* Um lado da carta do jeito que ele vai sair: a arte escolhida quando há, e
   a arte padrão da Scryfall quando não. É o que a prévia do hover e a
   galeria mostram — ver a arte oficial no lugar da que se escolheu faria a
   escolha parecer não ter pegado. */
export function imagemDaFace(carta, face, largura, escolhas, copia){
  const escolha = arteEscolhida(carta, face, escolhas, copia);
  if (escolha) return miniaturaDaArte(escolha.arte_id, largura || 500);
  return (face === "verso" ? carta.imagem_verso : carta.imagem) || "";
}

/* O botão na linha do deck. Mostra a miniatura quando há arte escolhida, e o
   ícone quando está no padrão: ver de relance o que já foi customizado é
   metade do valor. É o botão da FRENTE; o verso se escolhe dentro da modal,
   ou pelo quadro dele na aba Artes. */
export function botaoDeArte(carta){
  const escolha = arteEscolhida(carta);
  const nome = escapar(carta.nome);
  const fundo = escolha
    ? ` style="background-image:url('${escapar(miniaturaDaArte(escolha.arte_id, 40))}')"` : "";
  return `<button class="mini ${escolha ? "tem-arte" : ""}"
    data-arte-carta="${nome}"${fundo}
    title="${escolha ? "Arte escolhida: " + escapar(rotuloDaEscolha(escolha))
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
export async function carregarArtes(){
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

/* `copia` vem do quadro de uma cópia na galeria; sem ela, a modal abre na
   arte de todas — ou na primeira cópia, se a carta já tem arte por cópia. */
export async function abrirEscolhaDeArte(nome, face, copia){
  const carta = acharCartaDaArte(nome);
  if (!carta) return;
  if (!estado.id) return toast("Salve o deck antes de escolher artes.");

  arte.carta = carta;
  arte.meta = {};
  arte.filtro = {texto: "", fonte: "", dpi: 0, impressao: null};
  // Ficha não tem impressões: a Scryfall responde pelo nome, e "Soldier"
  // seria a tira de todos os Soldier já impressos, de toda cor e corpo. O
  // que ajuda é ver a ficha que o deck cria (`desenharVitrine`), e é ela que
  // o segmento Scryfall oferece (`opcoesDaScryfall`).
  arte.impressoes = carta.ficha ? [] : null;
  const quantidade = quantidadeNoPapel(carta);
  arte.copia = Math.min(Number(copia) || 0, quantidade);
  arte.porCopia = quantidade > 1 && (arte.copia > 0 || temArtePorCopia(carta));
  arte.copia = arte.porCopia ? arte.copia || 1 : 0;
  $("arte-titulo").textContent = carta.ficha ? rotuloDaFicha(carta) : carta.nome;
  $("arte-busca").value = "";
  $("arte-fonte").value = "";
  $("arte-dpi").value = "0";
  $("arte-envio-estado").textContent = "";
  // A prévia do hover fica presa embaixo da modal se não for dispensada: o
  // clique não move o mouse, e é movimento que a apaga.
  $("previa").classList.remove("mostra");
  $("arte-fundo").hidden = false;
  travarRolagem(true);

  // As duas viajam juntas: as impressões são da Scryfall e a grade é do MPC
  // Fill, e nenhuma das duas precisa esperar a outra.
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
  arte.carregandoIds = true;
  arte.erroIds = "";
  arte.pagina = 0;
  desenharLado();
  buscarArtesDaCarta(arte.busca);
}

/* O que depende do lado e da cópia abertos: os dois seletores e o segmento.
   Trocar de cópia passa só por aqui — a grade é a mesma, e muda qual opção
   está marcada. */
function desenharLado(){
  desenharFaces();
  desenharCopias();
  desenharOrigem();
}

/* O seletor de lado, só em carta de duas faces. O ✓ diz qual lado já tem
   arte escolhida — sem ele, escolher a frente e fechar deixaria o verso no
   padrão sem nada na tela contando. */
function desenharFaces(){
  const seg = $("arte-faces");
  seg.hidden = !temVerso(arte.carta);
  if (seg.hidden) return;
  for (const b of seg.querySelectorAll("[data-face]")){
    const f = b.dataset.face;
    const ativa = f === arte.face;
    b.classList.toggle("ativa", ativa);
    b.setAttribute("aria-pressed", String(ativa));
    const feita = !!arteEscolhida(arte.carta, f, null, arte.copia);
    b.title = feita ? "Arte escolhida pra este lado" : "Este lado está na arte padrão";
    b.innerHTML = (f === "verso" ? "Verso" : "Frente") + (feita ? " " + ico("check") : "");
  }
}

/* "Uma arte por cópia" e o seletor de cópia, só com mais de uma cópia no
   deck. O ✓ no seletor marca a cópia com arte própria neste lado; a sem ✓
   sai com a arte das outras. */
function desenharCopias(){
  const quantidade = arte.carta ? quantidadeNoPapel(arte.carta) : 1;
  const caixa = $("arte-copias");
  caixa.hidden = quantidade <= 1;
  $("arte-padrao").textContent = arte.copia ? "Igual às outras cópias" : "Voltar ao padrão";
  if (caixa.hidden) return;
  $("arte-por-copia").checked = arte.porCopia;
  const seletor = $("arte-copia");
  seletor.hidden = !arte.porCopia;
  if (!arte.porCopia) return;
  const copias = escolhasDaCarta(arte.carta).copias || {};
  seletor.innerHTML = Array.from({length: quantidade}, (_, i) => {
    const propria = (copias[i + 1] || {})[arte.face];
    return `<option value="${i + 1}">Cópia ${i + 1}${propria ? " ✓" : ""}</option>`;
  }).join("");
  seletor.value = String(arte.copia);
}

/* O segmento aberto. As três origens dividem a contagem, a grade e o
   paginador; a tira de impressões e os filtros são só do MPC Fill, e o envio
   tem só a caixa dele. */
function desenharOrigem(){
  const origem = arte.origem;
  for (const b of $("arte-origens").querySelectorAll("[data-origem]")){
    const ativa = b.dataset.origem === origem;
    b.classList.toggle("ativa", ativa);
    b.setAttribute("aria-pressed", String(ativa));
  }
  const envio = origem === "enviar";
  $("arte-vitrine").hidden = origem !== "mpcfill";
  $("arte-filtros").hidden = origem !== "mpcfill" || !arte.ids.length;
  $("arte-envio").hidden = !envio;
  $("arte-conta").hidden = envio;
  $("arte-grade").hidden = envio;
  $("arte-paginas").hidden = envio;
  if (origem === "mpcfill"){
    desenharVitrine();
    desenharGrade();
  } else if (origem === "scryfall"){
    desenharGradeScryfall();
  } else {
    desenharEnvio();
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
  if (arte.origem === "mpcfill") desenharVitrine();
  if (arte.origem === "scryfall") desenharGradeScryfall();
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
   primeira que se abre: quem abre uma costuma abrir as outras em seguida.

   Roda com qualquer segmento aberto: é barata depois da primeira vez, e o
   segmento do MPC Fill fica pronto pra quando a pessoa passar por ele. */
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
    arte.carregandoIds = false;
    arte.erroIds = e.message;
    if (arte.origem === "mpcfill") desenharGrade();
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
  arte.carregandoIds = false;
  montarFiltroDeFonte();
  if (arte.origem === "mpcfill"){
    $("arte-filtros").hidden = !ids.length;
    desenharGrade();
  }
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
    if (arte.origem === "mpcfill") desenharGrade();
  } catch (e){
    // A grade já está desenhada com as miniaturas: sem metadados ela perde o
    // nome do arquivo e o DPI, e continua servindo pra escolher pela ARTE,
    // que é o que a pessoa veio fazer. O filtro é que fica sem serventia.
    if (arte.origem === "mpcfill"){
      $("arte-conta").textContent += " — sem os detalhes (nome do arquivo e DPI)";
    }
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
export function quadroHTML(src, deitada, extra){
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
    as artes oficiais. Clique numa pra ver só os arquivos dela.</span>`
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

/* A página à vista de uma lista, e a contagem que diz qual pedaço é. */
function paginar(lista, rotulo){
  const paginas = Math.ceil(lista.length / ARTES_POR_PAGINA);
  if (arte.pagina >= paginas) arte.pagina = 0;
  const inicio = arte.pagina * ARTES_POR_PAGINA;
  const daPagina = lista.slice(inicio, inicio + ARTES_POR_PAGINA);
  $("arte-conta").textContent =
    `${lista.length} ${rotulo} — mostrando ${inicio + 1}–${inicio + daPagina.length}`;
  desenharPaginas(paginas);
  return {inicio, daPagina};
}

function desenharGrade(){
  const grade = $("arte-grade");
  grade.classList.toggle("deitada", !!(arte.carta && arte.carta.deitada));
  if (arte.carregandoIds || arte.erroIds){
    $("arte-conta").textContent = arte.erroIds || "Procurando as artes…";
    grade.innerHTML = "";
    desenharPaginas(0);
    return;
  }
  const ids = idsFiltrados();
  if (!ids.length){
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
  const {daPagina} = paginar(ids, "arte(s)");
  const escolhida = arteEscolhida(arte.carta, arte.face, null, arte.copia);
  const marcado = escolhida ? escolhida.arte_id : "";
  const deitada = !!arte.carta.deitada;
  grade.innerHTML = daPagina.map(id => {
    const m = arte.meta[id] || {};
    return `<button class="arte-op ${id === marcado ? "ativa" : ""}" data-arte-id="${escapar(id)}">
      ${quadroHTML(m.miniatura || miniaturaDaArte(id, 400), deitada)}
      <small>${escapar(m.arquivo || "…")}${m.dpi ? ` · ${m.dpi} DPI` : ""}</small>
    </button>`;
  }).join("");
}

/* O que o segmento Scryfall oferece pro lado aberto: cada impressão oficial
   com imagem desse lado. A ficha oferece a imagem dela mesma, a que o deck
   cria (ver `abrirEscolhaDeArte`). */
function opcoesDaScryfall(){
  const carta = arte.carta, verso = arte.face === "verso";
  if (carta.ficha){
    const imagem = verso ? carta.imagem_verso : carta.imagem;
    const id = idDaImagemDaScryfall(imagem);
    return id ? [{id, imagem, status: "", legenda: "A ficha que o deck cria",
                  arquivo: rotuloDaFicha(carta)}] : [];
  }
  return (Array.isArray(arte.impressoes) ? arte.impressoes : []).map(i => {
    const imagem = verso ? i.imagem_verso : i.imagem;
    if (!i.id || !imagem) return null;
    return {
      id: `scryfall:${i.id}:${verso ? "back" : "front"}`,
      imagem, status: i.status_imagem || "", titulo: i.edicao,
      legenda: [i.sigla, (i.lancamento || "").slice(0, 4), i.artista]
        .filter(Boolean).join(" · "),
      // Do jeito que os arquivos do MPC Fill costumam vir nomeados, "Sol Ring
      // [MSC] {214}": é o nome que aparece no pedido e na revisão da folha.
      arquivo: `${nomeDoLado(carta, arte.face)} [${i.sigla}] {${i.numero}}`,
    };
  }).filter(Boolean);
}

function desenharGradeScryfall(){
  const grade = $("arte-grade");
  const carta = arte.carta;
  grade.classList.toggle("deitada", !!carta.deitada);
  arte.opcoesScryfall = opcoesDaScryfall();
  const vazio = arte.impressoes === null ? "Carregando as impressões oficiais…"
    : arte.impressoes === false ? "Não consegui falar com a Scryfall agora."
    : !arte.opcoesScryfall.length
      ? `A Scryfall não tem imagem pra ${arte.face === "verso" ? "o verso desta" : "esta"} ${
          carta.ficha ? "ficha" : "carta"}.`
      : "";
  if (vazio){
    $("arte-conta").textContent = vazio;
    grade.innerHTML = "";
    desenharPaginas(0);
    return;
  }
  const {inicio, daPagina} = paginar(arte.opcoesScryfall, "impressão(ões) oficial(is)");
  const escolhida = arteEscolhida(carta, arte.face, null, arte.copia);
  const marcado = escolhida ? escolhida.arte_id : "";
  grade.innerHTML = daPagina.map((o, k) => {
    const semImagem = STATUS_SEM_IMAGEM.includes(o.status);
    const selo = o.status === "lowres"
      ? `<span class="arte-selo">Baixa resolução</span>` : "";
    return `<button class="arte-op ${o.id === marcado ? "ativa" : ""}"
      data-scryfall="${inicio + k}" ${semImagem ? "disabled" : ""}
      title="${escapar(o.titulo || o.legenda)}">
      ${quadroHTML(o.imagem, !!carta.deitada, selo)}
      <small>${escapar(o.legenda)}${semImagem ? " · sem imagem" : ""}</small>
    </button>`;
  }).join("");
}

/* O segmento de envio: a arte enviada que este lado já usa, quando é o caso,
   e a caixa pra mandar outra. */
function desenharEnvio(){
  const escolha = arteEscolhida(arte.carta, arte.face, null, arte.copia);
  const atual = $("arte-envio-atual");
  if (!escolha || !ID_ENVIADA.test(escolha.arte_id)){
    atual.innerHTML = "";
    return;
  }
  atual.innerHTML = `<span class="arte-envio-quadro">${quadroHTML(
      miniaturaDaArte(escolha.arte_id, 500), !!arte.carta.deitada)}</span>
    <span class="arte-nota">Em uso: <b>${escapar(escolha.arquivo || "arquivo enviado")}</b>${
      escolha.dpi ? ` · ${escolha.dpi} DPI` : ""}${escolha.baixa_resolucao
      ? `<br><span class="arte-alerta">Baixa resolução: pode sair borrada no papel.</span>`
      : ""}</span>`;
}

function irParaPagina(p){
  arte.pagina = p;
  if (arte.origem === "scryfall") desenharGradeScryfall();
  else desenharGrade();
  // A página nova começa do começo: trocar de página com a grade rolada até o
  // fim mostraria o fim da página seguinte.
  $("arte-grade").scrollTop = 0;
}

/* A escolha na memória da tela, do jeito que o `artes.do_deck` a devolveria. */
function gravarLocal(carta, face, copia, escolha){
  const chave = chaveDaArte(nomeDaArte(carta));
  const daCarta = Object.assign({}, arte.escolhas[chave]);
  if (copia){
    const copias = Object.assign({}, daCarta.copias);
    copias[copia] = Object.assign({}, copias[copia], {[face]: escolha});
    daCarta.copias = copias;
  } else {
    daCarta[face] = escolha;
  }
  arte.escolhas[chave] = daCarta;
}

/* `face` null tira todas as escolhas por cópia da carta, dos dois lados. */
function apagarLocal(carta, face, copia){
  const chave = chaveDaArte(nomeDaArte(carta));
  const daCarta = Object.assign({}, arte.escolhas[chave]);
  if (face === null){
    delete daCarta.copias;
  } else if (copia){
    const copias = Object.assign({}, daCarta.copias);
    const lados = Object.assign({}, copias[copia]);
    delete lados[face];
    if (Object.keys(lados).length) copias[copia] = lados;
    else delete copias[copia];
    if (Object.keys(copias).length) daCarta.copias = copias;
    else delete daCarta.copias;
  } else {
    delete daCarta[face];
  }
  if (Object.keys(daCarta).length) arte.escolhas[chave] = daCarta;
  else delete arte.escolhas[chave];
}

/* Grava no servidor o que um clique na grade escolheu. */
async function guardarEscolha(escolha){
  // Guardados antes da rede: a modal pode fechar ou trocar de lado enquanto
  // o servidor responde, e a escolha é da carta e do lado que foram clicados.
  const carta = arte.carta, face = arte.face, copia = arte.copia;
  let r;
  try {
    r = await api(`/decks/${estado.id}/artes`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(Object.assign({nome: nomeDaArte(carta), face, copia}, escolha)),
    });
  } catch (e){
    return toast("Não consegui guardar: " + e.message);
  }
  concluirEscolha(carta, face, copia, r.escolha, "escolhida");
}

function concluirEscolha(carta, face, copia, escolha, verbo){
  gravarLocal(carta, face, copia, escolha);
  redesenharArtes();
  const qual = copia ? `da cópia ${copia}` : face === "verso" ? "do verso" : "";
  toast(["Arte", qual, verbo].filter(Boolean).join(" ") +
        (escolha.baixa_resolucao ? `, ${AVISO_BAIXA}.` : "."));
  if ($("arte-fecha").checked) return fecharArte();
  if (arte.carta !== carta || arte.face !== face || arte.copia !== copia) return;
  desenharLado();
}

function usarArte(id){
  const m = arte.meta[id] || {};
  guardarEscolha({arte_id: id, arquivo: m.arquivo || "", fonte: m.fonte || "",
                  dpi: m.dpi || 0});
}

function usarScryfall(k){
  const o = arte.opcoesScryfall[k];
  if (!o || STATUS_SEM_IMAGEM.includes(o.status)) return;
  const baixa = o.status === "lowres";
  guardarEscolha({arte_id: o.id, arquivo: o.arquivo, fonte: "Scryfall",
                  dpi: baixa ? 0 : DPI_SCRYFALL, baixa_resolucao: baixa});
}

async function enviarArquivo(arquivo){
  if (!arquivo || !arte.carta || arte.enviando) return;
  const carta = arte.carta, face = arte.face, copia = arte.copia;
  const corpo = new FormData();
  corpo.append("arquivo", arquivo);
  corpo.append("nome", nomeDaArte(carta));
  corpo.append("face", face);
  corpo.append("copia", String(copia));
  arte.enviando = true;
  $("arte-envio-estado").textContent = "Enviando…";
  let r;
  try {
    r = await api(`/decks/${estado.id}/artes/enviar`, {method: "POST", body: corpo});
  } catch (e){
    if (arte.carta === carta) $("arte-envio-estado").textContent = e.message;
    return;
  } finally {
    arte.enviando = false;
  }
  $("arte-envio-estado").textContent = "";
  concluirEscolha(carta, face, copia, r.escolha, "enviada");
}

async function voltarAoPadrao(){
  if (!arte.carta) return;
  const carta = arte.carta, face = arte.face, copia = arte.copia;
  try {
    await api(`/decks/${estado.id}/artes?nome=${
      encodeURIComponent(nomeDaArte(carta))}&face=${face}&copia=${copia}`, {method: "DELETE"});
  } catch (e){
    return toast("Não consegui: " + e.message);
  }
  apagarLocal(carta, face, copia);
  redesenharArtes();
  toast(copia ? `A cópia ${copia} voltou pra arte das outras.`
    : face === "verso" ? "O verso voltou pra arte padrão." : "Voltou pra arte padrão.");
  if (arte.carta !== carta || arte.face !== face || arte.copia !== copia) return;
  desenharLado();
}

/* Desligar com cópias já escolhidas descarta essas escolhas — pergunta antes,
   porque é trabalho que não volta. */
async function mudarPorCopia(interruptor){
  const carta = arte.carta;
  if (!carta) return;
  if (interruptor.checked){
    arte.porCopia = true;
    arte.copia = 1;
    return desenharLado();
  }
  if (temArtePorCopia(carta)){
    if (!confirm("As artes escolhidas pra cada cópia vão ser descartadas, e " +
                 "todas as cópias passam a usar a mesma arte. Continuar?")){
      interruptor.checked = true;
      return;
    }
    try {
      await api(`/decks/${estado.id}/artes/copias?nome=${
        encodeURIComponent(nomeDaArte(carta))}`, {method: "DELETE"});
    } catch (e){
      interruptor.checked = true;
      return toast("Não consegui: " + e.message);
    }
    apagarLocal(carta, null, 0);
    redesenharArtes();
    if (arte.carta !== carta) return;
  }
  arte.porCopia = false;
  arte.copia = 0;
  desenharLado();
}

/* O "Usar a arte padrão nas que faltam" da aba Artes (ver
   `artes.aplicar_padrao`). */
async function aplicarPadraoNasQueFaltam(){
  if (!estado.id) return;
  const botao = $("btn-artes-padrao");
  botao.disabled = true;
  let r;
  try {
    r = await api(`/decks/${estado.id}/artes/padrao`, {method: "POST"});
  } catch (e){
    return toast("Não consegui: " + e.message);
  } finally {
    botao.disabled = false;
  }
  arte.escolhas = r.escolhas || arte.escolhas;
  redesenharArtes();
  const partes = [r.aplicadas ? `${r.aplicadas} arte(s) padrão aplicada(s).`
                              : "Nenhuma arte padrão aplicada."];
  if (r.baixa_resolucao.length){
    partes.push(`Em baixa resolução: ${r.baixa_resolucao.join(", ")}.`);
  }
  if (r.sem_imagem.length){
    partes.push(`Sem imagem da Scryfall: ${r.sem_imagem.join(", ")}.`);
  }
  toast(partes.join(" "));
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

export function fecharArte(){
  $("arte-fundo").hidden = true;
  arte.carta = null;
  arte.busca = "";
  travarRolagem(false);
}

export function ligarArte(){
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

  $("arte-origens").addEventListener("click", (e) => {
    const b = e.target.closest("[data-origem]");
    if (!b || !arte.carta || b.dataset.origem === arte.origem) return;
    arte.origem = b.dataset.origem;
    arte.pagina = 0;
    desenharOrigem();
  });

  $("arte-por-copia").addEventListener("change", (e) => mudarPorCopia(e.target));
  $("arte-copia").addEventListener("change", (e) => {
    arte.copia = Number(e.target.value) || 1;
    desenharLado();
  });

  $("arte-vitrine").addEventListener("click", (e) => {
    const b = e.target.closest("[data-impressao]");
    if (!b) return;
    // Clicar numa impressão aqui NÃO escolhe nada: a imagem oficial se
    // escolhe no segmento Scryfall. O que ela faz é filtrar a grade pelos
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
    const doMpc = e.target.closest("[data-arte-id]");
    if (doMpc) return usarArte(doMpc.dataset.arteId);
    const daScryfall = e.target.closest("[data-scryfall]");
    if (daScryfall) usarScryfall(Number(daScryfall.dataset.scryfall));
  });

  $("arte-arquivo").addEventListener("change", (e) => {
    enviarArquivo(e.target.files[0]);
    e.target.value = "";   // o mesmo arquivo de novo tem que disparar outra vez
  });
  const soltar = $("arte-soltar");
  soltar.addEventListener("dragover", (e) => {
    e.preventDefault();
    soltar.classList.add("sobre");
  });
  soltar.addEventListener("dragleave", () => soltar.classList.remove("sobre"));
  soltar.addEventListener("drop", (e) => {
    e.preventDefault();
    soltar.classList.remove("sobre");
    enviarArquivo(e.dataTransfer.files[0]);
  });

  $("arte-padrao").addEventListener("click", voltarAoPadrao);
  $("btn-artes-padrao").addEventListener("click", aplicarPadraoNasQueFaltam);
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
