"use strict";

/* ------------------------------------------------------------- mana base */

async function analisarManabase(){
  if (!estado.comandantes.length){
    toast("Escolha o comandante primeiro: é a identidade dele que define as cores.");
    return;
  }
  if (!estado.id) await salvarAgora();
  if (!estado.id){ toast("Não consegui salvar o deck antes de analisar."); return; }
  // Só avisa que está calculando quando ainda não há resposta na tela. Nos
  // recálculos do autosave, apagar a conta anterior faria o painel piscar a
  // cada carta digitada.
  if (!estado.manabase){
    $("mb-nota").hidden = false;
    $("mb-resultado").innerHTML = `<div class="nota">Calculando…</div>`;
  }
  try {
    const params = estado.manabaseTeto !== null ? `?teto=${estado.manabaseTeto}` : "";
    estado.manabase = await api(`/decks/${estado.id}/manabase${params}`);
  } catch (e){
    $("mb-nota").hidden = false;
    $("mb-resultado").innerHTML =
      `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    return;
  }
  desenharManabase();
}

function desenharManabase(){
  const caixa = $("mb-resultado");
  const m = estado.manabase;
  if (!m){ $("mb-nota").hidden = false; caixa.innerHTML = ""; return; }
  // A conta está na tela: a explicação do que o painel faz vira ruído acima
  // dela.
  $("mb-nota").hidden = true;
  const t = m.terrenos;
  const classe = t.diferenca === 0 ? "ok" : t.diferenca < 0 ? "falta" : "";
  // Coluna da esquerda: o retrato do deck que já existe — a conta de
  // terrenos, a curva que a justifica, as fontes de cada cor e os básicos que
  // fecham o buraco.
  let html = `<div class="mb-duo"><div>
    <div class="mb-terrenos"><span>Terrenos</span>
      <span><b class="${classe}">${t.tem}</b> / ${t.recomendado} recomendados</span></div>
    <div class="nota">Curva média ${m.cmc_media.toFixed(2)} em ${m.magias} magia(s)${
      m.rampas_baratas ? `, com ${m.rampas_baratas} rampa(s) barata(s) valendo meio terreno cada` : ""}.</div>`;

  html += `<h2 class="secao" style="margin-top:12px">Fontes por cor</h2>`;
  const maior = Math.max(1, ...m.cores.map(c => Math.max(c.fontes, c.pedidas)));
  html += m.cores.map(c => `
    <div class="mb-cor" title="${escapar(c.nome)}: ${c.pips} símbolo(s) de mana (${Math.round(c.parte*100)}% do deck)${
        c.fora_do_terreno ? " · mais " + c.fora_do_terreno + " fonte(s) em rocks/dorks" : ""}">
      <span class="pip ${c.cor}"></span>
      <span>${escapar(c.nome)}</span>
      <span class="trilho">
        <span class="cheio" style="width:${(c.fontes/maior)*100}%;background:var(--mana-${c.cor})"></span>
        <span class="marca" style="left:clamp(0px, calc(${(c.pedidas/maior)*100}% - 2px), calc(100% - 2px))"></span>
      </span>
      <span class="num ${c.faltam ? "falta" : ""}">${c.fontes}/${c.pedidas}${
        c.faltam ? " · faltam " + c.faltam : ""}</span>
    </div>`).join("");
  html += `<div class="nota" style="margin-top:4px">A marca é o que o deck pede;
    a barra, o que tem. Terreno de duas cores conta pras duas.</div>`;

  if (m.basicos.length){
    html += `<h2 class="secao" style="margin-top:12px">Básicos que fecham a conta</h2>`;
    html += m.basicos.map((b, i) => `
      <div class="mb-basico"><span><span class="pip ${b.cor}"></span>
        &nbsp;${b.quantidade}× ${escapar(b.nome)}</span>
        ${b.carta ? `<button class="add-peca" data-basico="${i}">${ico("plus")} ${b.quantidade}</button>`
                  : `<span class="nota">não está na base local</span>`}
      </div>`).join("");
  } else if (t.diferenca < 0){
    html += `<div class="nota" style="margin-top:10px">Faltam ${-t.diferenca}
      terreno(s), mas nenhuma cor está descoberta — qualquer básico da
      identidade serve.</div>`;
  }

  html += `</div><div>`;

  if (!m.monocolor){
    // O `data-teto` fica em DÓLAR: é o que `manabase.py` filtra do outro lado,
    // e o rótulo é a única parte que a régua toca. Converter o valor mandado
    // faria o teto mudar de significado conforme o dólar do dia.
    const chips = [1, 3, 10, 999].map(v => `
      <button class="chip ${m.teto_usd === v || (v === 999 && m.teto_usd >= 999) ? "ativo" : ""}"
        data-teto="${v}"${v >= 999 ? "" : ` title="${escapar(notaDoCambio())}"`
        }>${v >= 999 ? "Sem teto" : "até " + moeda(v)}</button>`).join("");
    html += `<h2 class="secao">Terrenos que fixam</h2>
      <div class="temas" style="margin-top:0">${chips}</div>`;
    // Uma lista só, do mais barato ao mais caro, cinco por vez. O teto de
    // preço acima já é o controle de orçamento; separar os caros numa segunda
    // seção dizia a mesma coisa duas vezes e dobrava a altura do painel.
    fixadoresPlanos = (m.fixadores.baratos || []).concat(m.fixadores.caros || []);
    if (!fixadoresPlanos.length){
      html += `<div class="nota">Nenhum terreno de duas ou mais cores da
        identidade que o deck ainda não tenha.</div>`;
    } else {
      const porPagina = 5;
      const paginas = Math.ceil(fixadoresPlanos.length / porPagina);
      // O teto de preço encurta a lista, e a página em que se estava pode não
      // existir mais.
      if (estado.mbPagina >= paginas) estado.mbPagina = 0;
      const inicio = estado.mbPagina * porPagina;
      html += fixadoresPlanos.slice(inicio, inicio + porPagina).map((terreno, k) => `
        <button class="achado" data-fix="${inicio + k}"${ganchosDaPrevia(terreno)}>
          <span class="nome"><b>${escapar(terreno.nome)}</b>
            <small>${escapar(terreno.tipo)}</small></span>
          <span class="mana">${terreno.produz.split("").map(c =>
            `<span class="pip ${c}" title="${NOME_COR[c]}"></span>`).join("")}</span>
          <span class="preco">${preco(terreno)}</span>
        </button>`).join("");
      if (paginas > 1){
        html += `<div class="paginador">
          <button class="mini" data-mb-pag="-1" title="Página anterior"
            aria-label="Página anterior"${
              estado.mbPagina === 0 ? " disabled" : ""}>${ico("caret-left")}</button>
          <span>${estado.mbPagina + 1} / ${paginas}</span>
          <button class="mini" data-mb-pag="1" title="Próxima página"
            aria-label="Próxima página"${
              estado.mbPagina >= paginas - 1 ? " disabled" : ""}>${ico("caret-right")}</button>
        </div>`;
      }
    }
  } else {
    html += `<h2 class="secao">Terrenos que fixam</h2>
      <div class="nota">Deck de uma cor: básico resolve, fixação não faz
      falta.</div>`;
  }
  html += `</div></div>`;

  html += `<div class="rodape-conta">
    <b>Como a conta é feita.</b> Parte de 36 terrenos numa curva média de
    3,20: um terreno a mais a cada 0,25 de curva acima disso, um a menos a
    cada 0,25 abaixo. Cada rampa barata — rock ou dork de custo até 2 — vale
    meio terreno a menos, no máximo quatro. O resultado fica preso entre 32 e
    40. As fontes pedidas de cada cor são proporcionais aos símbolos de mana
    que o deck pede daquela cor, com piso de 8 fontes pra um respingo (menos
    de 12% dos símbolos) e 12 pra uma cor de verdade — e fonte é o que
    <i>produz</i> a cor, então um terreno de duas cores conta pras duas. É
    regra de mesa, feita pra conferir de cabeça, não a simulação de Frank
    Karsten: ela aponta o buraco, não fecha a lista.</div>`;

  caixa.innerHTML = html;
}

let fixadoresPlanos = [];

/* Põe N cópias de uma vez — é o que "+3 Forest" faz. Uma entrada só de
   desfazer, senão Ctrl+Z tiraria uma floresta por vez. */
function adicionarQuantidade(carta, n){
  guardarDesfazer();
  const entrada = acharEntrada(carta.nome);
  if (entrada) entrada.quantidade += n;
  else estado.cartas.push({carta, quantidade: n, categoria: ""});
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();
}

/* O atalho no cabeçalho de Terrenos. Ele não abre painel nenhum: rola até o
   que já existe embaixo do deck e o faz piscar, porque duas mana bases na
   mesma tela seriam duas respostas pra mesma pergunta. */
function chamarManabase(){
  trocarAba("manabase");
  const painel = $("painel-manabase");
  painel.scrollIntoView({behavior: "smooth", block: "nearest"});
  painel.classList.remove("chamado");
  void painel.offsetWidth;          // reinicia a animação se já tiver rodado
  painel.classList.add("chamado");
  if (!estado.manabase) analisarManabase();
}
