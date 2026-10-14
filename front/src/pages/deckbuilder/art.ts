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
   busca vai como "t:Nome" (`searchNameFor`), e a escolha é guardada pela
   chave da ficha, não pelo nome (`artName`).

   Aqui fica o estado da modal e a conversa com o servidor; o desenho é
   `ui/ArtPicker.tsx` (a modal) e `ui/Gallery.tsx` (a aba Artes).
   ========================================================================= */
import { api } from "./save";
import { state, touch } from "./state";
import { foldAccents } from "./text";
import { deckTokens, tokenLabel } from "./tokens";
import type { Card } from "./types";
import { toast } from "./ui/toast";

export const ARTS_PER_PAGE = 24;
// Guardado no navegador pelo mesmo motivo da coluna do maybeboard: é jeito de
// trabalhar, e quem prefere a modal fechando sozinha prefere sempre.
const CLOSE_ON_PICK_KEY = "forja.deck.arte-fecha";
// O PNG da Scryfall tem 745 px de largura, e a carta 2,48 pol (ver
// `artes.DPI_SCRYFALL`).
const SCRYFALL_DPI = 300;
// O `image_status` da Scryfall sem imagem que se imprima (ver
// `artes.STATUS_SEM_IMAGEM`).
export const NO_IMAGE_STATUS = ["missing", "placeholder"];
const LOW_RES_WARNING = "em baixa resolução: pode sair borrada no papel";

export type Face = "frente" | "verso";
export type Origin = "mpcfill" | "scryfall" | "enviar";
export type Choice = {
  arte_id: string; arquivo?: string; fonte?: string; dpi?: number; baixa_resolucao?: boolean;
};
export type CardChoices = Partial<Record<Face, Choice>> & { copias?: Record<number, Partial<Record<Face, Choice>>> };
export type Printing = {
  id?: string; sigla: string; numero?: string; edicao: string; artista?: string; lancamento?: string;
  imagem?: string; imagem_verso?: string; status_imagem?: string;
};
export type ArtMeta = { arquivo?: string; fonte?: string; dpi?: number; miniatura?: string };
export type ScryfallOption = {
  id: string; imagem: string; status: string; titulo?: string; legenda: string; arquivo: string;
};

export const artState = {
  card: null as Card | null,   // a carta aberta agora; null = modal fechada
  face: "frente" as Face,       // o lado que a grade está escolhendo
  // O segmento aberto. Fica de uma carta pra outra: quem escolhe pela
  // Scryfall costuma seguir nela.
  origin: "mpcfill" as Origin,
  copy: 0,                     // 0 = todas as cópias; n = a n-ésima (ver `artes.py`)
  perCopy: false,              // o "Uma arte por cópia" desta carta
  query: "",                    // o nome que se pergunta ao MPC Fill por esse lado
  ids: [] as string[],          // todos os ids de arte dele, na ordem das fontes
  loadingIds: false,
  idsError: "",
  meta: {} as Record<string, ArtMeta>,   // id -> metadados, preenchido por carta aberta
  noDetails: false,           // os metadados não vieram: a grade fica sem nome e DPI
  page: 0,
  // `impressao` = {k, sigla, artista} da impressão clicada na vitrine, ou
  // null. `k` é a posição dela na tira, pra a tira saber qual acender.
  filter: { text: "", source: "", dpi: 0, printing: null as { k: number; sigla: string; artista: string } | null },
  printings: null as Printing[] | null | false,   // null = buscando, false = não deu, array = ok
  choices: {} as Record<string, CardChoices>,      // nome achatado -> escolhas
  sources: [] as { nome: string }[],
  // Os ids de arte já buscados, pelo nome que foi perguntado. `null` = ainda
  // não busquei nada; `buscandoDeck` segura a busca do deck inteiro em voo,
  // pra duas cartas abertas em seguida não pedirem o deck duas vezes.
  byName: null as Record<string, string[]> | null,
  deckSearch: null as Promise<void> | null,
  uploading: false,
  applyingDefaults: false,       // o "Usar a arte padrão nas que faltam" em voo
  // Sobe a cada abertura: a modal se remonta, e os filtros digitados na carta
  // anterior não ficam nos campos.
  opens: 0,
  uploadStatus: "",              // o que o envio de arquivo está fazendo, ou o erro dele
  closeOnPick: false,
};

try { artState.closeOnPick = localStorage.getItem(CLOSE_ON_PICK_KEY) === "1"; }
catch { /* navegador privado: a modal fica aberta, que é o padrão */ }

export function setCloseOnPick(on: boolean) {
  artState.closeOnPick = on;
  try { localStorage.setItem(CLOSE_ON_PICK_KEY, on ? "1" : "0"); }
  catch { /* vale só pra esta visita */ }
  touch();
}

/* O nome achatado, do MESMO jeito que o `cartas.normalizar` do servidor:
   ligaduras abertas, sem acento, sem caixa, apóstrofo some e o resto da
   pontuação vira espaço. Aqui não dá pra chamar o Python, então a regra mora
   duas vezes — e a que importa é a do servidor, que é quem grava. Esta serve
   pra a tela achar a escolha que ele devolveu: um passo a menos aqui e
   "Atraxa, Praetors' Voice" aparece no padrão com a arte escolhida, e o
   "Gerar pedido" nunca liga. */
const LIGATURES: Record<string, string> = { "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ø": "o", "Ø": "o", "ß": "ss", "đ": "d" };

export function artKey(name: string | null | undefined) {
  return String(name || "")
    .replace(/[æÆœŒøØßđ]/g, (c) => LIGATURES[c])
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/['’ʼ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/* O nome sob o qual a arte é guardada no servidor. A carta é o próprio nome;
   a ficha é a `chave_arte` que o servidor devolve com ela, porque nome não
   identifica ficha (ver `artes.chave_da_ficha`). */
export function artName(card: Card) {
  return card.chaveArte || card.nome;
}

/* `choices` é o mapa de outro deck — o segundo deck do goldfish, que tem as
   artes dele. Sem ele, valem as do deck aberto. */
function cardChoices(card: Card, choices?: Record<string, CardChoices> | null): CardChoices {
  return (choices || artState.choices)[artKey(artName(card))] || {};
}

/* Com `copy`, a arte daquela cópia: a dela, ou a de todas. Sem `copy`, a de
   todas — ou, na carta que só tem escolha por cópia, a da primeira cópia que
   tem, que é o que a linha do deck e a prévia do hover mostram. */
export function chosenArt(card: Card | null | undefined, face?: Face | string | null,
                          choices?: Record<string, CardChoices> | null, copy?: number): Choice | null {
  if (!card) return null;
  const own = cardChoices(card, choices);
  const side = (face || "frente") as Face;
  const copies = own.copias || {};
  if (copy) return (copies[copy] || {})[side] || own[side] || null;
  if (own[side]) return own[side]!;
  const first = Object.keys(copies).map(Number).sort((a, b) => a - b).find((n) => copies[n][side]);
  return first ? copies[first][side]! : null;
}

/* Se a carta tem escolha por cópia: é o que liga o "Uma arte por cópia" ao
   abrir a modal, e o que faz a galeria separar as cópias. */
export function hasPerCopyArt(card: Card) {
  return Object.keys(cardChoices(card).copias || {}).length > 0;
}

/* Se toda cópia de um lado tem arte pra imprimir — a conta do `artes.pedido`. */
export function sideReady(card: Card, face: Face, quantity: number) {
  for (let n = 1; n <= (quantity || 1); n++) {
    if (!chosenArt(card, face, null, n)) return false;
  }
  return true;
}

/* Quantas cópias da carta vão pro papel. Comandante e ficha são uma. */
export function paperQuantity(card: Card | null) {
  if (!card || card.ficha) return 1;
  const entry = state.cards.find((e) => e.carta && e.carta.nome === card.nome);
  return entry ? entry.quantidade : 1;
}

/* Duas faces DE PAPEL, e não de texto: carta partida e aventura têm duas
   metades numa imagem só, e a base local já devolve o verso vazio pra elas
   (ver `cartas._imagem_verso`). */
export function hasBack(card: Card | null | undefined) {
  return !!(card && card.imagem_verso);
}

/* Como a tela do MPC Fill escreve uma busca de ficha: "t:Treasure". O
   servidor desfaz o prefixo na hora de perguntar (ver `mpcfill._consulta`). */
const TOKEN_PREFIX = "t:";

/* O nome de um lado só: "Delver of Secrets" ou "Insectile Aberration". */
function sideName(card: Card, face: Face) {
  const parts = card.nome.split(" // ");
  return ((face === "verso" ? parts[1] : parts[0]) || card.nome).trim();
}

/* O que se pergunta ao MPC Fill por um lado da carta. A frente vai com o nome
   inteiro, que o servidor corta no " // " (ver `mpcfill._consulta`); o verso
   vai só com o nome dele, porque a biblioteca deles indexa cada face pelo
   próprio nome. Ficha vai com o prefixo de ficha. */
export function searchNameFor(card: Card, face: Face | string) {
  const name = face !== "verso" ? card.nome : sideName(card, "verso");
  return card.ficha ? TOKEN_PREFIX + name : name;
}

/* A forma dos ids de arte e das URLs de imagem da Scryfall, as mesmas do
   `arte_id.py`. */
const SCRYFALL_ID = /^scryfall:([0-9a-f]{8}-[0-9a-f-]{27}):(front|back)$/;
export const UPLOADED_ID = /^enviada:([0-9a-f]{64})$/;
const SCRYFALL_URL = /\/(front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f]{8}-[0-9a-f-]{27})\./;

/* A miniatura de uma arte guardada, de onde o id disser. A da Scryfall vem
   no tamanho mais próximo do pedido: `small`, `normal` e `large` têm 146, 488
   e 672 px de largura. */
export function artThumbnail(id: string, width: number) {
  const scryfall = SCRYFALL_ID.exec(id || "");
  if (scryfall) {
    const printing = scryfall[1];
    const size = width > 488 ? "large" : width > 146 ? "normal" : "small";
    return `https://cards.scryfall.io/${size}/${scryfall[2]}/${printing[0]}/${printing[1]}/${printing}.jpg`;
  }
  const uploaded = UPLOADED_ID.exec(id || "");
  if (uploaded) return `/artes/enviadas/${uploaded[1]}/miniatura`;
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`;
}

/* O id da Scryfall tirado de uma URL de imagem dela. É assim que a ficha,
   que não tem lista de impressões, oferece a própria imagem. */
export function scryfallIdFromImage(url: string | null | undefined) {
  const found = SCRYFALL_URL.exec(url || "");
  return found ? `scryfall:${found[2]}:${found[1]}` : "";
}

export function choiceLabel(choice: Choice) {
  return [choice.arquivo || choice.arte_id, choice.fonte].filter(Boolean).join(" · ");
}

/* Um lado da carta do jeito que ele vai sair: a arte escolhida quando há, e
   a arte padrão da Scryfall quando não. É o que a prévia do hover e a
   galeria mostram — ver a arte oficial no lugar da que se escolheu faria a
   escolha parecer não ter pegado. */
export function faceImage(card: Card, face: Face | string, width?: number,
                          choices?: Record<string, CardChoices> | null, copy?: number) {
  const choice = chosenArt(card, face, choices, copy);
  if (choice) return artThumbnail(choice.arte_id, width || 500);
  return (face === "verso" ? card.imagem_verso : card.imagem) || "";
}

/* O botão na linha do deck, como dados (o desenho é `ui/CardBits.tsx`). É o
   botão da FRENTE; o verso se escolhe dentro da modal, ou pelo quadro dele
   na aba Artes. */
export function artButtonView(card: Card) {
  const choice = chosenArt(card);
  return {
    escolhida: !!choice,
    miniatura: choice ? artThumbnail(choice.arte_id, 40) : "",
    titulo: choice ? "Arte escolhida: " + choiceLabel(choice) : "Escolher a arte de " + card.nome,
  };
}

/* As escolhas do deck inteiro, uma vez, ao abrir. Sem rede por linha: a lista
   desenha 100 botões e uma consulta por botão seria 100 requisições. */
export async function loadArts() {
  if (!state.id) return;
  try {
    const r = await api(`/decks/${state.id}/artes`);
    artState.choices = r.escolhas || {};
  } catch {
    return;   // sem isto a lista mostra todos no padrão, que é o que eles são
  }
  touch();
}

/* `name` é o que o quadro carrega em `data-arte-carta`: o nome da carta, ou a
   chave da ficha (ver `artName`). */
export function findArtCard(name: string): Card | null {
  const inDeck = state.cards.find((e) => e.carta && e.carta.nome === name);
  if (inDeck) return inDeck.carta;
  return state.commanders.find((c) => c.nome === name) || deckTokens().find((f) => f.chaveArte === name) || null;
}

/* A página atrás não rola com a modal aberta: a roda do mouse que passa do
   fim da grade continuaria rolando o deck por baixo. A barra de rolagem some
   junto, e a página pularia pro lado pela largura dela — `com-barra` guarda o
   lugar, só onde havia barra. */
function lockScroll(on: boolean) {
  const root = document.documentElement;
  root.classList.toggle("com-barra", on && window.innerWidth > root.clientWidth);
  root.classList.toggle("sem-rolar", on);
}

/* `copy` vem do quadro de uma cópia na galeria; sem ela, a modal abre na
   arte de todas — ou na primeira cópia, se a carta já tem arte por cópia. */
export async function openArtPicker(name: string, face?: string, copy?: string | number) {
  const card = findArtCard(name);
  if (!card) return;
  if (!state.id) return toast("Salve o deck antes de escolher artes.");

  artState.card = card;
  artState.opens++;
  artState.meta = {};
  artState.noDetails = false;
  artState.uploadStatus = "";
  artState.filter = { text: "", source: "", dpi: 0, printing: null };
  // Ficha não tem impressões: a Scryfall responde pelo nome, e "Soldier"
  // seria a tira de todos os Soldier já impressos. O que ajuda é ver a ficha
  // que o deck cria, e é ela que o segmento Scryfall oferece.
  artState.printings = card.ficha ? [] : null;
  const quantity = paperQuantity(card);
  artState.copy = Math.min(Number(copy) || 0, quantity);
  artState.perCopy = quantity > 1 && (artState.copy > 0 || hasPerCopyArt(card));
  artState.copy = artState.perCopy ? artState.copy || 1 : 0;
  // A prévia do hover fica presa embaixo da modal se não for dispensada: o
  // clique não move o mouse, e é movimento que a apaga.
  document.getElementById("previa")?.classList.remove("mostra");
  lockScroll(true);

  // As duas viajam juntas: as impressões são da Scryfall e a grade é do MPC
  // Fill, e nenhuma das duas precisa esperar a outra.
  if (!card.ficha) loadPrintings(card.nome);
  showFace(face === "verso" && hasBack(card) ? "verso" : "frente");
}

/* Troca o lado que a grade escolhe. O filtro de impressão FICA: quem achou a
   frente "de Kaladesh" quer o verso da mesma impressão. */
export function showFace(face: Face) {
  artState.face = face;
  artState.query = searchNameFor(artState.card!, face);
  artState.ids = [];
  artState.loadingIds = true;
  artState.idsError = "";
  artState.page = 0;
  touch();
  loadCardArts(artState.query);
}

export function setOrigin(origin: Origin) {
  if (!artState.card || origin === artState.origin) return;
  artState.origin = origin;
  artState.page = 0;
  touch();
}

export function setCopy(copy: number) {
  artState.copy = copy || 1;
  touch();
}

async function loadPrintings(name: string) {
  try {
    const r = await api(`/cartas/impressoes?nome=${encodeURIComponent(name)}`);
    if (!artState.card || artState.card.ficha || artState.card.nome !== name) return;   // trocou de carta
    artState.printings = r.impressoes || [];
  } catch {
    // `false` e não `[]`: "não consegui perguntar" e "essa carta só saiu uma
    // vez" são coisas diferentes, e a tela diz as duas de formas diferentes.
    artState.printings = false;
  }
  touch();
}

/* A busca cobre o DECK INTEIRO na primeira vez, não a carta aberta.

   É a forma que a API deles permite (uma requisição aceita a lista toda) e é
   o que torna escolher arte de 100 cartas suportável: abrir a segunda carta
   não custa requisição nenhuma.

   O resultado fica em `artState.porNome` pela sessão da página. O que não
   veio nele — carta acrescentada depois, e o VERSO das cartas de duas faces,
   que a busca do deck não pergunta — é buscado sozinho, na hora em que abre.
   As fichas também ficam fora da busca do deck, e vão TODAS juntas na
   primeira que se abre: quem abre uma costuma abrir as outras em seguida. */
async function loadCardArts(search: string) {
  try {
    if (!artState.byName) {
      artState.deckSearch = artState.deckSearch || requestArts(null);
      try { await artState.deckSearch; } finally { artState.deckSearch = null; }
    }
    if (!(search in artState.byName!)) {
      const ask = [search];
      // Duas fichas de mesmo nome (as Wurm do Wurmcoil) são a mesma busca.
      for (const f of artState.card?.ficha ? deckTokens() : []) {
        const s = searchNameFor(f, "frente");
        if (!(s in artState.byName!) && !ask.includes(s)) ask.push(s);
      }
      await requestArts(ask);
    }
  } catch (e) {
    if (artState.query !== search) return;
    artState.loadingIds = false;
    artState.idsError = (e as Error).message;
    touch();
    return;
  }
  if (artState.query !== search) return;   // trocou de carta ou de lado
  const ids = artState.byName![search] || [];
  artState.ids = ids;
  artState.loadingIds = false;
  touch();
  loadMetadata(search, ids);
}

/* `names` null = o deck inteiro, que é o que o servidor busca sem lista. */
async function requestArts(names: string[] | null) {
  const r = await api(`/decks/${state.id}/artes/buscar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(names ? { nomes: names } : {}),
  });
  artState.byName = Object.assign(artState.byName || {}, r.por_nome || {});
  artState.sources = r.fontes || artState.sources;
}

/* Os metadados de TODAS as artes deste lado da carta, numa requisição só.
   Medido: os 713 ids de Sol Ring voltam completos em 0,6 s. Carregar por
   página deixaria o filtro enxergando 24 arquivos de 713. É uma requisição
   por carta ABERTA, não por deck, e o servidor guarda o resultado por uma
   semana. */
async function loadMetadata(search: string, ids: string[]) {
  const missing = ids.filter((id) => !artState.meta[id]);
  if (!missing.length) return;
  try {
    const r = await api("/artes/metadados", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: missing }),
    });
    if (artState.query !== search) return;   // trocou de carta ou de lado
    Object.assign(artState.meta, r.artes || {});
  } catch {
    // A grade já está desenhada com as miniaturas: sem metadados ela perde o
    // nome do arquivo e o DPI, e continua servindo pra escolher pela ARTE,
    // que é o que a pessoa veio fazer. O filtro é que fica sem serventia.
    artState.noDetails = true;
  }
  touch();
}

/* Os ids que sobram depois dos filtros. Os três olham os metadados, que
   `loadMetadata` traz de todas as artes do lado aberto de uma vez — então o
   filtro vê o conjunto inteiro, não só a página à vista. */
export function filteredIds() {
  const f = artState.filter;
  if (!f.text && !f.source && !f.dpi && !f.printing) return artState.ids;
  return artState.ids.filter((id) => {
    const m = artState.meta[id];
    // Sem metadado ainda (a requisição está em voo): não esconde o que não
    // conhece — a alternativa seria a grade encolher e voltar a crescer
    // sozinha enquanto a pessoa olha.
    if (!m) return true;
    if (f.source && m.fonte !== f.source) return false;
    if (f.dpi && (m.dpi || 0) < f.dpi) return false;
    if (f.text && !(m.arquivo || "").toLowerCase().includes(f.text)) return false;
    if (f.printing && !matchesPrinting(m.arquivo, f.printing)) return false;
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
export function matchesPrinting(file: string | undefined, printing: { sigla: string; artista: string }) {
  const name = foldAccents(file);
  const code = foldAccents(printing.sigla).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (code && new RegExp(`(^|[^a-z0-9])${code}(\\d{4}\\)|[^a-z0-9]|$)`).test(name)) return true;
  return !!printing.artista && name.includes(foldAccents(printing.artista));
}

/* Clicar numa impressão da vitrine NÃO escolhe nada: a imagem oficial se
   escolhe no segmento Scryfall. O que ela faz é filtrar a grade pelos
   arquivos daquela impressão — é assim que se acha "a de Kaladesh" entre
   setecentas. Clicar de novo na mesma tira o filtro. */
export function togglePrintingFilter(k: number) {
  const printing = Array.isArray(artState.printings) ? artState.printings[k] : null;
  if (!printing) return;
  const on = artState.filter.printing?.k !== k;
  artState.filter.printing = on ? { k, sigla: printing.sigla || "", artista: printing.artista || "" } : null;
  artState.page = 0;
  touch();
}

export function setArtFilter(change: Partial<{ texto: string; fonte: string; dpi: number }>) {
  Object.assign(artState.filter, change);
  artState.page = 0;
  touch();
}

/* As páginas que o paginador mostra: a primeira, a última e duas de cada lado
   da atual, com "…" no vão — `1 … 3 4 5 6 7 … 10`. Cinco no meio SEMPRE,
   inclusive perto das pontas: com a janela encolhendo ali, os números
   trocariam de lugar debaixo do mouse a cada clique. Até sete páginas cabem
   todas e não há vão nenhum. Recebe e devolve páginas contadas do zero. */
export function visiblePages(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const start = Math.min(Math.max(1, current - 2), total - 6);
  const end = start + 4;
  const out: (number | "…")[] = [0];
  if (start > 1) out.push("…");
  for (let p = start; p <= end; p++) out.push(p);
  if (end < total - 2) out.push("…");
  out.push(total - 1);
  return out;
}

/* A página à vista de uma lista. */
export function pageOf<T>(list: T[]) {
  const pages = Math.ceil(list.length / ARTS_PER_PAGE);
  const page = artState.page < pages ? artState.page : 0;
  const start = page * ARTS_PER_PAGE;
  return { pages, page, start, items: list.slice(start, start + ARTS_PER_PAGE) };
}

export function goToPage(page: number) {
  artState.page = page;
  touch();
}

/* O que o segmento Scryfall oferece pro lado aberto: cada impressão oficial
   com imagem desse lado. A ficha oferece a imagem dela mesma, a que o deck
   cria. */
export function scryfallOptions(): ScryfallOption[] {
  const card = artState.card!, back = artState.face === "verso";
  if (card.ficha) {
    const image = (back ? card.imagem_verso : card.imagem) || "";
    const id = scryfallIdFromImage(image);
    return id ? [{ id, imagem: image, status: "", legenda: "A ficha que o deck cria", arquivo: tokenLabel(card) }] : [];
  }
  return (Array.isArray(artState.printings) ? artState.printings : []).map((i) => {
    const image = back ? i.imagem_verso : i.imagem;
    if (!i.id || !image) return null;
    return {
      id: `scryfall:${i.id}:${back ? "back" : "front"}`,
      imagem: image, status: i.status_imagem || "", titulo: i.edicao,
      legenda: [i.sigla, (i.lancamento || "").slice(0, 4), i.artista].filter(Boolean).join(" · "),
      // Do jeito que os arquivos do MPC Fill costumam vir nomeados, "Sol Ring
      // [MSC] {214}": é o nome que aparece no pedido e na revisão da folha.
      arquivo: `${sideName(card, artState.face)} [${i.sigla}] {${i.numero}}`,
    };
  }).filter(Boolean) as ScryfallOption[];
}

/* A escolha na memória da tela, do jeito que o `artes.do_deck` a devolveria. */
function saveLocal(card: Card, face: Face, copy: number, choice: Choice) {
  const key = artKey(artName(card));
  const own: CardChoices = { ...artState.choices[key] };
  if (copy) {
    const copies = { ...own.copias };
    copies[copy] = { ...copies[copy], [face]: choice };
    own.copias = copies;
  } else {
    own[face] = choice;
  }
  artState.choices[key] = own;
}

/* `face` null tira todas as escolhas por cópia da carta, dos dois lados. */
function removeLocal(card: Card, face: Face | null, copy: number) {
  const key = artKey(artName(card));
  const own: CardChoices = { ...artState.choices[key] };
  if (face === null) {
    delete own.copias;
  } else if (copy) {
    const copies = { ...own.copias };
    const sides = { ...copies[copy] };
    delete sides[face];
    if (Object.keys(sides).length) copies[copy] = sides;
    else delete copies[copy];
    if (Object.keys(copies).length) own.copias = copies;
    else delete own.copias;
  } else {
    delete own[face];
  }
  if (Object.keys(own).length) artState.choices[key] = own;
  else delete artState.choices[key];
}

/* Grava no servidor o que um clique na grade escolheu. */
async function storeChoice(choice: Choice) {
  // Guardados antes da rede: a modal pode fechar ou trocar de lado enquanto
  // o servidor responde, e a escolha é da carta e do lado que foram clicados.
  const card = artState.card!, face = artState.face, copy = artState.copy;
  let r;
  try {
    r = await api(`/decks/${state.id}/artes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: artName(card), face, copia: copy, ...choice }),
    });
  } catch (e) {
    return toast("Não consegui guardar: " + (e as Error).message);
  }
  finishChoice(card, face, copy, r.escolha, "escolhida");
}

function finishChoice(card: Card, face: Face, copy: number, choice: Choice, verb: string) {
  saveLocal(card, face, copy, choice);
  const which = copy ? `da cópia ${copy}` : face === "verso" ? "do verso" : "";
  toast(["Arte", which, verb].filter(Boolean).join(" ") + (choice.baixa_resolucao ? `, ${LOW_RES_WARNING}.` : "."));
  if (artState.closeOnPick) return closeArtPicker();
  touch();
}

export function pickMpcArt(id: string) {
  const m = artState.meta[id] || {};
  storeChoice({ arte_id: id, arquivo: m.arquivo || "", fonte: m.fonte || "", dpi: m.dpi || 0 });
}

export function pickScryfallArt(option: ScryfallOption) {
  if (NO_IMAGE_STATUS.includes(option.status)) return;
  const low = option.status === "lowres";
  storeChoice({ arte_id: option.id, arquivo: option.arquivo, fonte: "Scryfall",
                dpi: low ? 0 : SCRYFALL_DPI, baixa_resolucao: low });
}

/* Sobe o arquivo direto pro Vercel Blob, com o token que o site assinou pra
   este caminho só (ver `app/blob.py`). Uma função da Vercel não aceita corpo
   maior que 4,5 MB, e a arte do MPC passa disso — por isso o arquivo não
   atravessa o site. Devolve o endereço público do arquivo. */
async function uploadToBlob(file: File, upload: any) {
  const store = upload.token.split("_")[3];
  const resp = await fetch(`${upload.api}/?pathname=${encodeURIComponent(upload.pathname)}`, {
    method: "PUT",
    body: file,
    headers: {
      "authorization": `Bearer ${upload.token}`,
      "x-api-version": upload.api_version,
      "x-vercel-blob-store-id": store,
      "x-vercel-blob-access": "public",
      "x-content-type": file.type || "application/octet-stream",
      "x-content-length": String(file.size),
      "x-add-random-suffix": "0",
    },
  });
  if (!resp.ok) {
    throw new Error(resp.status === 400 || resp.status === 403
      ? "O armazenamento recusou o arquivo (tamanho ou formato)."
      : `O armazenamento não aceitou o envio (${resp.status}).`);
  }
  return (await resp.json()).url;
}

function setUploadStatus(text: string) {
  artState.uploadStatus = text;
  touch();
}

export async function uploadArtFile(file: File | null | undefined) {
  if (!file || !artState.card || artState.uploading) return;
  const card = artState.card, face = artState.face, copy = artState.copy;
  artState.uploading = true;
  setUploadStatus("Enviando…");
  let r;
  try {
    // O site diz como subir: direto pra ele (disco, no homelab) ou pro Blob.
    const upload = await api(`/decks/${state.id}/artes/enviar/inicio`, { method: "POST" });
    if (upload.modo === "blob") {
      if (file.size > upload.maximo_bytes) {
        throw new Error(`O arquivo passa de ${Math.round(upload.maximo_bytes / 1048576)} MB.`);
      }
      const url = await uploadToBlob(file, upload);
      setUploadStatus("Conferindo a imagem…");
      r = await api(`/decks/${state.id}/artes/enviar/blob`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, nome: artName(card), face, copia: copy, arquivo: file.name || "" }),
      });
    } else {
      const body = new FormData();
      body.append("arquivo", file);
      body.append("nome", artName(card));
      body.append("face", face);
      body.append("copia", String(copy));
      r = await api(`/decks/${state.id}/artes/enviar`, { method: "POST", body });
    }
  } catch (e) {
    if (artState.card === card) setUploadStatus((e as Error).message);
    return;
  } finally {
    artState.uploading = false;
  }
  artState.uploadStatus = "";
  finishChoice(card, face, copy, r.escolha, "enviada");
}

export async function revertToDefault() {
  if (!artState.card) return;
  const card = artState.card, face = artState.face, copy = artState.copy;
  try {
    await api(`/decks/${state.id}/artes?nome=${encodeURIComponent(artName(card))}&face=${face}&copia=${copy}`,
              { method: "DELETE" });
  } catch (e) {
    return toast("Não consegui: " + (e as Error).message);
  }
  removeLocal(card, face, copy);
  toast(copy ? `A cópia ${copy} voltou pra arte das outras.`
    : face === "verso" ? "O verso voltou pra arte padrão." : "Voltou pra arte padrão.");
  touch();
}

/* Desligar com cópias já escolhidas descarta essas escolhas — pergunta antes,
   porque é trabalho que não volta. Devolve se o interruptor ficou como a
   pessoa pediu. */
export async function setPerCopy(on: boolean) {
  const card = artState.card;
  if (!card) return;
  if (on) {
    artState.perCopy = true;
    artState.copy = 1;
    return touch();
  }
  if (hasPerCopyArt(card)) {
    if (!confirm("As artes escolhidas pra cada cópia vão ser descartadas, e " +
                 "todas as cópias passam a usar a mesma arte. Continuar?")) return touch();
    try {
      await api(`/decks/${state.id}/artes/copias?nome=${encodeURIComponent(artName(card))}`, { method: "DELETE" });
    } catch (e) {
      toast("Não consegui: " + (e as Error).message);
      return touch();
    }
    removeLocal(card, null, 0);
    if (artState.card !== card) return touch();
  }
  artState.perCopy = false;
  artState.copy = 0;
  touch();
}

/* O "Usar a arte padrão nas que faltam" da aba Artes (ver
   `artes.aplicar_padrao`). */
export async function applyDefaultsToMissing() {
  if (!state.id) return;
  artState.applyingDefaults = true;
  touch();
  let r;
  try {
    r = await api(`/decks/${state.id}/artes/padrao`, { method: "POST" });
  } catch (e) {
    return toast("Não consegui: " + (e as Error).message);
  } finally {
    artState.applyingDefaults = false;
    touch();
  }
  artState.choices = r.escolhas || artState.choices;
  const parts = [r.aplicadas ? `${r.aplicadas} arte(s) padrão aplicada(s).` : "Nenhuma arte padrão aplicada."];
  if (r.baixa_resolucao.length) parts.push(`Em baixa resolução: ${r.baixa_resolucao.join(", ")}.`);
  if (r.sem_imagem.length) parts.push(`Sem imagem da Scryfall: ${r.sem_imagem.join(", ")}.`);
  toast(parts.join(" "));
  touch();
}

export function closeArtPicker() {
  artState.card = null;
  artState.query = "";
  lockScroll(false);
  touch();
}
