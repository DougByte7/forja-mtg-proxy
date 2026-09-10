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
   os ids de todas as cartas de uma vez e é cara; os metadados vêm por página
   de miniaturas, só do que está à vista. Sol Ring tem 713 artes — pedir os
   metadados de todas seria buscar o que ninguém vai olhar.

   `loading="lazy"` e 24 por página não são detalhe: as miniaturas vêm do
   Google Drive, e uma grade que carrega 700 imagens de uma vez toma 429 e
   deixa de mostrar qualquer coisa.
   ========================================================================= */

const ARTES_POR_PAGINA = 24;

const arte = {
  carta: null,        // a carta aberta agora
  ids: [],            // todos os ids de arte dela, na ordem das fontes
  meta: {},           // id -> metadados, preenchido por página
  pagina: 0,
  // `impressao` = {sigla, artista} da impressão clicada na vitrine, ou null.
  filtro: {texto: "", fonte: "", dpi: 0, impressao: null},
  impressoes: null,   // null = buscando, false = não deu, array = ok
  escolhas: {},       // nome achatado -> {frente:{...}, verso:{...}}
  fontes: [],
  // Os ids de arte do deck inteiro, buscados de uma vez na primeira abertura.
  // `null` = ainda não busquei nada.
  porNome: null,
};

/* O nome achatado, do MESMO jeito que o `cartas.normalizar` do servidor.
   Aqui não dá pra chamar o Python, então a regra mora duas vezes — e a que
   importa é a do servidor, que é quem grava. Esta serve só pra a tela saber
   se uma carta já tem arte escolhida. */
function chaveDaArte(nome){
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function arteEscolhida(carta){
  if (!carta) return null;
  return (arte.escolhas[chaveDaArte(carta.nome)] || {}).frente || null;
}

/* O botão na linha do deck. Mostra a miniatura quando há arte escolhida, e o
   ícone quando está no padrão: ver de relance o que já foi customizado é
   metade do valor. */
function botaoDeArte(carta){
  const escolha = arteEscolhida(carta);
  const nome = escapar(carta.nome);
  const fundo = escolha
    ? ` style="background-image:url('https://drive.google.com/thumbnail?id=${
        escapar(escolha.drive_id)}&sz=w40')"` : "";
  return `<button class="mini ${escolha ? "tem-arte" : ""}"
    data-arte-carta="${nome}"${fundo}
    title="${escolha ? "Arte escolhida: " + escapar(escolha.arquivo || escolha.drive_id)
                     : "Escolher a arte de " + nome}"
    aria-label="Escolher arte de ${nome}">${escolha ? "" : ico("image")}</button>`;
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
  desenharDeck();
}

async function abrirEscolhaDeArte(nome){
  const carta = (estado.cartas.find(e => e.carta && e.carta.nome === nome)
    || estado.comandantes.map(c => ({carta: c})).find(e => e.carta.nome === nome) || {}).carta;
  if (!carta) return;
  if (!estado.id) return toast("Salve o deck antes de escolher artes.");

  arte.carta = carta;
  arte.ids = [];
  arte.meta = {};
  arte.pagina = 0;
  arte.filtro = {texto: "", fonte: "", dpi: 0, impressao: null};
  arte.impressoes = null;
  $("arte-titulo").textContent = carta.nome;
  $("arte-busca").value = "";
  $("arte-fundo").hidden = false;
  $("arte-filtros").hidden = true;
  $("arte-conta").textContent = "Procurando as artes…";
  $("arte-grade").innerHTML = "";
  desenharVitrine();

  // As duas viajam juntas: a vitrine é da Scryfall e a grade é do MPC Fill,
  // e nenhuma das duas precisa esperar a outra.
  buscarImpressoes(carta.nome);
  buscarArtesDaCarta(carta.nome);
}

async function buscarImpressoes(nome){
  try {
    const r = await api(`/cartas/impressoes?nome=${encodeURIComponent(nome)}`);
    if (arte.carta && arte.carta.nome !== nome) return;   // trocou de carta
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

   O resultado fica em `arte.porNome` pela sessão da página. Se a pessoa
   acrescentar uma carta depois, ela não estará ali, e aí sim busca só ela. */
async function buscarArtesDaCarta(nome){
  if (arte.porNome && arte.porNome[nome]){
    aplicarIds(nome, arte.porNome[nome]);
    return;
  }
  const soEsta = !!arte.porNome;   // já busquei o deck; esta carta é nova
  try {
    const r = await api(`/decks/${estado.id}/artes/buscar`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(soEsta ? {nomes: [nome]} : {}),
    });
    arte.porNome = Object.assign(arte.porNome || {}, r.por_nome || {});
    arte.fontes = r.fontes || arte.fontes;
    if (arte.carta && arte.carta.nome !== nome) return;   // trocou de carta
    aplicarIds(nome, arte.porNome[nome] || []);
  } catch (e){
    $("arte-conta").textContent = e.message;
    $("arte-grade").innerHTML = "";
  }
}

function aplicarIds(nome, ids){
  arte.ids = ids;
  montarFiltroDeFonte();
  $("arte-filtros").hidden = !ids.length;
  desenharGrade();
  carregarMetadados(nome, ids);
}

/* Os metadados de TODAS as artes desta carta, numa requisição só.

   Medido: os 713 ids de Sol Ring voltam completos em 0,6 s. Carregar por
   página parecia mais econômico e é o que a primeira versão fazia — mas
   deixava o filtro enxergando 24 arquivos de 713, e filtrar por "Kaladesh"
   não achava quase nada, sem nada na tela dizendo por quê.

   É uma requisição por carta ABERTA, não por deck, e o servidor guarda o
   resultado por uma semana. */
async function carregarMetadados(nome, ids){
  const faltando = ids.filter(id => !arte.meta[id]);
  if (!faltando.length) return;
  try {
    const r = await api("/artes/metadados", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ids: faltando}),
    });
    if (arte.carta && arte.carta.nome !== nome) return;   // trocou de carta
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
}

function desenharVitrine(){
  const caixa = $("arte-vitrine");
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

  caixa.innerHTML = `<span class="arte-nota" style="max-width:120px">Estas são
    as artes oficiais. Servem pra achar — o que imprime é o arquivo abaixo.</span>`
    + arte.impressoes.slice(0, 24).map((i, k) => `
      <button class="arte-impressao" data-impressao="${k}"
        title="${escapar(i.edicao)}${i.artista ? " · " + escapar(i.artista) : ""}">
        ${i.imagem ? `<img src="${escapar(i.imagem)}" alt="" loading="lazy"
          referrerpolicy="no-referrer">` : ""}
        <small>${escapar(i.sigla)}${i.lancamento
          ? " · " + escapar(i.lancamento.slice(0, 4)) : ""}</small>
      </button>`).join("");
}

/* Os ids que sobram depois dos filtros. Os três olham os metadados, que
   `carregarMetadados` traz de todas as artes da carta de uma vez — então o
   filtro vê o conjunto inteiro, não só a página à vista. */
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

function desenharGrade(){
  const ids = idsFiltrados();
  const total = ids.length;
  if (!total){
    const imp = arte.filtro.impressao;
    $("arte-conta").textContent = !arte.ids.length
      ? "O MPC Fill não tem arte pra esta carta."
      : imp
        ? `Nenhum arquivo do MPC Fill identificado como ${imp.sigla}${
            imp.artista ? " ou de " + imp.artista : ""} — clique de novo na ` +
          "impressão pra ver todas."
        : "Nenhuma arte com esses filtros.";
    $("arte-grade").innerHTML = "";
    return;
  }
  const paginas = Math.ceil(total / ARTES_POR_PAGINA);
  if (arte.pagina >= paginas) arte.pagina = 0;
  const inicio = arte.pagina * ARTES_POR_PAGINA;
  const daPagina = ids.slice(inicio, inicio + ARTES_POR_PAGINA);

  $("arte-conta").textContent =
    `${total} arte(s) — mostrando ${inicio + 1}–${inicio + daPagina.length}`;
  $("arte-anterior").disabled = arte.pagina === 0;
  $("arte-proxima").disabled = arte.pagina >= paginas - 1;

  const escolhida = arteEscolhida(arte.carta);
  const marcado = escolhida ? escolhida.drive_id : "";
  $("arte-grade").innerHTML = daPagina.map(id => {
    const m = arte.meta[id] || {};
    return `<button class="arte-op ${id === marcado ? "ativa" : ""}" data-arte-id="${escapar(id)}">
      <img src="${escapar(m.miniatura
        || "https://drive.google.com/thumbnail?id=" + id + "&sz=w400")}"
        alt="" loading="lazy" referrerpolicy="no-referrer">
      <small>${escapar(m.arquivo || "…")}${m.dpi ? ` · ${m.dpi} DPI` : ""}</small>
    </button>`;
  }).join("");

}

async function usarArte(id){
  const m = arte.meta[id] || {};
  try {
    await api(`/decks/${estado.id}/artes`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({nome: arte.carta.nome, drive_id: id,
                            arquivo: m.arquivo || "", fonte: m.fonte || "",
                            dpi: m.dpi || 0}),
    });
  } catch (e){
    return toast("Não consegui guardar: " + e.message);
  }
  arte.escolhas[chaveDaArte(arte.carta.nome)] = {
    frente: {drive_id: id, arquivo: m.arquivo || "", fonte: m.fonte || "",
             dpi: m.dpi || 0}};
  desenharGrade();
  desenharDeck();
  toast("Arte escolhida.");
}

async function voltarAoPadrao(){
  if (!arte.carta) return;
  try {
    await api(`/decks/${estado.id}/artes?nome=${
      encodeURIComponent(arte.carta.nome)}&face=frente`, {method: "DELETE"});
  } catch (e){
    return toast("Não consegui: " + e.message);
  }
  delete arte.escolhas[chaveDaArte(arte.carta.nome)];
  desenharGrade();
  desenharDeck();
  toast("Voltou pra arte padrão.");
}

function fecharArte(){
  $("arte-fundo").hidden = true;
  arte.carta = null;
}

function ligarArte(){
  $("arte-fechar").addEventListener("click", fecharArte);
  $("arte-fundo").addEventListener("click", (e) => {
    if (e.target.id === "arte-fundo") fecharArte();
  });

  $("arte-vitrine").addEventListener("click", (e) => {
    const b = e.target.closest("[data-impressao]");
    if (!b) return;
    // Clicar numa impressão NÃO escolhe nada: ela é da Scryfall, e o que
    // imprime é o arquivo do MPC Fill. O que ela faz é filtrar a grade pelos
    // arquivos daquela impressão (ver `casaImpressao`) — é assim que se acha
    // "a de Kaladesh" entre setecentas. Clicar de novo na mesma tira o filtro.
    const i = arte.impressoes[Number(b.dataset.impressao)];
    if (!i) return;
    const ligar = !b.classList.contains("ativa");
    arte.filtro.impressao = ligar ? {sigla: i.sigla || "", artista: i.artista || ""} : null;
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
  $("arte-anterior").addEventListener("click", () => {
    arte.pagina = Math.max(0, arte.pagina - 1); desenharGrade();
  });
  $("arte-proxima").addEventListener("click", () => {
    arte.pagina++; desenharGrade();
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
