/* ------------------------------------------------------------------ eventos */

import {$} from "../../shared/dom.js";
import {ligarArrastar} from "./arrastar.js";
import {artState, openArtPicker, closeArtPicker} from "./art";
import {bindSearchKeys, clearCommanderResults, scheduleCommanderSearch,
        scheduleSearch, searchCommander} from "./search";
import {abrirCarta, cartaAberta, fecharCarta, ligarPrevia} from "./carta.js";
import {linkDeConta} from "./conta.js";
import {fecharCotacao} from "./cotacao.js";
import {alternarGrupo, ordenarLista, procurarNaLista} from "./desenho.js";
import {commanderPick, createCategory, findEntry, removeCard,
        removeCommander, setQuantity, undo} from "./editing";
import {closeDrawer, openDrawer, openDrawerId} from "./drawers";
import {clearFilters} from "./filters";
import {closeTableModal, fullscreen, isTableModalOpen, setFullscreen, tableShortcut, undoTable} from "./table";
import {exportar, fazerImportar} from "./importar-exportar.js";
import {callManabase} from "./manabase";
import {abrirMenu, fecharMenu, menuAberto, menuDaCarta, menuDoGrupo} from "./menus.js";
import {abrirFolha, fecharFolha, folhaAberta, recolherTalvez, trocarAba,
        trocarRail} from "./paineis.js";
import {agendarSalvar, lidos} from "./salvar.js";
import {state, touch} from "./state";
import {importAverageDeck, suggestFromCard} from "./suggestions";
import {deckLinkSource} from "./text";
import {toast} from "./utilidades.js";

export function ligarEventos(){
  $("busca").addEventListener("input", scheduleSearch);
  $("busca-cmd").addEventListener("input", scheduleCommanderSearch);

  // Achar no que já está montado. Sem atraso, ao contrário da busca da
  // esquerda: aqui não há rede nenhuma — é filtrar uma lista de 100 que já
  // está na memória, e esperar 200ms pra isso só faria a tela parecer lenta.
  $("busca-deck").addEventListener("input", (e) =>
    procurarNaLista("deck", e.target.value));
  $("busca-talvez").addEventListener("input", (e) =>
    procurarNaLista("talvez", e.target.value));
  $("ordem-lista").addEventListener("change", (e) => ordenarLista(e.target.value));

  // Esc num campo cheio limpa o campo, e só isso: sem o `stopPropagation` o
  // mesmo Esc chegaria ao documento e fecharia a gaveta ou a modal atrás —
  // duas coisas num toque, e a que a pessoa queria era a de perto.
  for (const [id, tabuleiro] of [["busca-deck", "deck"], ["busca-talvez", "talvez"]]){
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !e.target.value) return;
      e.stopPropagation();
      procurarNaLista(tabuleiro, "");
    });
  }

  bindSearchKeys($("busca"), "main");
  bindSearchKeys($("busca-cmd"), "cmd");

  // Enter sobre um link vale o mesmo que o botão: quem colou e apertou Enter
  // pediu a mesma coisa que quem colou e clicou. Registrado depois do teclado
  // da busca de propósito — lá o Enter sem resultado não faz nada, e link
  // nenhum deixa resultado na lista (ver `oferecerImportar`).
  $("busca-cmd").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !deckLinkSource($("busca-cmd").value)) return;
    e.preventDefault();
    importarLinkColado();
  });

  document.addEventListener("keydown", (e) => {
    const digitando = ["INPUT","TEXTAREA"].includes(document.activeElement?.tagName);
    // O menu fecha antes da gaveta: quando os dois estão abertos, o de cima
    // é o menu, e Esc fechar a gaveta por baixo dele seria fechar o que a
    // pessoa não está olhando.
    if (e.key === "Escape" && menuAberto){
      e.preventDefault();
      return fecharMenu();
    }
    // A modal da carta vem antes da gaveta pelo mesmo motivo do menu: ela
    // está por cima, e é nela que a pessoa está olhando.
    if (e.key === "Escape" && cartaAberta){
      e.preventDefault();
      return fecharCarta();
    }
    if (e.key === "Escape" && openDrawerId){
      e.preventDefault();
      return closeDrawer();
    }
    if (e.key === "Escape" && isTableModalOpen()){
      e.preventDefault();
      return closeTableModal();
    }
    if (e.key === "Escape" && !$("cotacao-caixa").hidden){
      e.preventDefault();
      return fecharCotacao();
    }
    if (e.key === "Escape" && folhaAberta()){
      e.preventDefault();
      return fecharFolha();
    }
    if (openDrawerId) return;   // dentro da gaveta, o teclado é dela
    if (cartaAberta) return;    // e dentro da modal, dela
    // D e Espaço só valem com a mesa à vista e nada por cima dela.
    if (state.aba === "goldfish" && !digitando && !isTableModalOpen() &&
        tableShortcut(e)) return;
    if (e.key === "/" && !digitando){
      e.preventDefault();
      (state.comandantes.length ? $("busca") : $("busca-cmd")).focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !digitando){
      e.preventDefault();
      // Na aba do goldfish, Ctrl+Z desfaz a JOGADA, não a edição do deck.
      // São duas pilhas separadas de propósito: desfazer uma jogada não pode
      // tirar uma carta do deck, e vice-versa.
      if (state.aba === "goldfish" && state.mesa) undoTable();
      else undo();
    }
    if (e.key === "Escape" && artState.carta){
      closeArtPicker();
      return;   // fecha uma coisa por Esc: a modal, não a tela cheia atrás dela
    }
    // Sair da tela cheia pelo Esc, que é onde a mão vai primeiro.
    if (e.key === "Escape" && fullscreen.value) setFullscreen(false);
  });

  $("btn-fazer-importar").addEventListener("click", fazerImportar);
  $("btn-limpar-filtros").addEventListener("click", clearFilters);
  $("gaveta-fundo").addEventListener("click", closeDrawer);
  $("btn-fechar-carta").addEventListener("click", fecharCarta);
  // Só o fundo fecha: clique dentro da modal (selecionar um trecho de ruling,
  // por exemplo) não pode fechá-la.
  $("carta-fundo").addEventListener("click", (e) => {
    if (e.target === $("carta-fundo")) fecharCarta();
  });


  // Clique nos resultados (os dois painéis) e nos controles do deck.
  document.addEventListener("click", (e) => {
    // Clique fora fecha o menu aberto — inclusive quando o clique é num
    // botão que abre OUTRO menu, que o `abrirMenu` fecha de novo sozinho.
    if (menuAberto && !menuAberto.contains(e.target)) fecharMenu();
    // O popover da cotação fecha no clique de fora, como o menu — menos o
    // clique no próprio ⌄, que é quem o alterna.
    const caixaCot = $("cotacao-caixa");
    if (!caixaCot.hidden && !caixaCot.contains(e.target) &&
        !e.target.closest("#btn-cotacao")) fecharCotacao();
    if (e.target.closest("[data-fecha-gaveta]")) return closeDrawer();
    // Os botões da linha herdam o tabuleiro dela: o mesmo ✕ serve o deck e
    // o maybeboard, e sem isto o ✕ de uma carta em dúvida tiraria a cópia
    // do deck — na lista errada, calado.
    const doTabuleiro = (alvo) =>
      alvo.closest("[data-tabuleiro]")?.dataset.tabuleiro || "deck";
    // Clicar no número é ir editá-lo, não abrir a carta.
    if (e.target.closest("[data-qtd]")) return;
    const sai = e.target.closest("[data-tirar]");
    if (sai) return removeCard(sai.dataset.tirar, doTabuleiro(sai));
    const sugCarta = e.target.closest("[data-sug-carta]");
    if (sugCarta) return suggestFromCard(sugCarta.dataset.sugCarta);
    // O quadro de verso da galeria abre a modal já no verso, e o de uma
    // cópia já nela; o botão da linha não diz lado nenhum e abre na frente.
    const arteCarta = e.target.closest("[data-arte-carta]");
    if (arteCarta) return openArtPicker(arteCarta.dataset.arteCarta,
                                             arteCarta.dataset.arteFace,
                                             arteCarta.dataset.arteCopia);
    // O ⋯ da linha, que só aparece no celular: é lá que o menu da carta não
    // tem clique direito pra abrir.
    const menuCarta = e.target.closest("[data-menu-carta]");
    if (menuCarta) return menuDaCarta(menuCarta, menuCarta.dataset.menuCarta,
                                      doTabuleiro(menuCarta));
    const menuGrupo = e.target.closest("[data-menu-grupo]");
    if (menuGrupo) return menuDoGrupo(menuGrupo, menuGrupo.dataset.menuGrupo);
    // O título do grupo é o botão de recolher: é o alvo grande, e recolher é
    // o que se faz num cabeçalho de lista.
    const recolhe = e.target.closest("[data-recolher-grupo]");
    if (recolhe) return alternarGrupo(recolhe.dataset.recolherGrupo,
                                      doTabuleiro(recolhe));
    // A linha inteira abre a carta — depois dos botões dela, que já
    // devolveram acima. Clicar no nome é o gesto óbvio pra "me conta mais
    // sobre esta carta", e o "Ver a carta" do menu é o caminho do teclado.
    const linhaCarta = e.target.closest(".linha[data-nome]");
    if (linhaCarta) return abrirCarta(
      findEntry(linhaCarta.dataset.nome, doTabuleiro(linhaCarta))?.carta);
    // O "···" do cabeçalho abre daqui, e não de um listener próprio no botão:
    // a linha lá em cima que fecha o menu ao clicar fora roda na bolha, isto
    // é, DEPOIS de um listener do próprio botão — o menu abriria e sumiria no
    // mesmo clique. Aberto daqui, o fechar-e-abrir acontece em ordem.
    if (e.target.closest("#btn-mais")){
      return abrirMenu($("btn-mais"), menuDoCabecalho());
    }
    // A pílula da versão abre daqui pelo mesmo motivo do "···".
    if (e.target.closest("[data-abrir-manabase]")) return callManabase();
    const verCmd = e.target.closest("[data-ver-cmd]");
    if (verCmd) return abrirCarta(state.comandantes[Number(verCmd.dataset.verCmd)]);
    const saiCmd = e.target.closest("[data-tirar-cmd]");
    if (saiCmd) return removeCommander(Number(saiCmd.dataset.tirarCmd));
    if (e.target.closest("#btn-parceiro")){
      commanderPick.partner = true;
      $("heroi").hidden = false;
      $("busca-cmd").value = "";
      $("busca-cmd").focus();
      searchCommander();
    }
  });

  // O menu da carta abre no clique direito da linha (no celular, pelo ⋯
  // dela, logo acima). Pelo teclado, a tecla
  // de menu (ou Shift+F10) com o número da quantidade em foco chega aqui do
  // mesmo jeito — o número é a parte da linha que recebe foco.
  document.addEventListener("contextmenu", (e) => {
    if (menuAberto && !menuAberto.contains(e.target)) fecharMenu();
    const linha = e.target.closest?.(".linha[data-nome]");
    if (!linha) return;
    e.preventDefault();
    // A prévia da arte segue o mouse, que está parado em cima do nome: sem
    // isto ela ficaria aberta por baixo do menu.
    $("previa").classList.remove("mostra");
    // Vindo do teclado não há ponteiro, e o evento chega em (0, 0): aí o
    // menu ancora na própria linha.
    const ancora = e.clientX || e.clientY
      ? new DOMRect(e.clientX, e.clientY, 0, 0) : linha;
    menuDaCarta(ancora, linha.dataset.nome, linha.dataset.tabuleiro);
  });

  // A quantidade vale no Enter, nas setas e ao sair do campo. Vazio ou
  // lixo volta pro número de antes em vez de virar zero — zero tira a
  // carta, e apagar o campo pra digitar outro número não é pedir isso.
  document.addEventListener("change", (e) => {
    const campo = e.target.closest?.("[data-qtd]");
    if (!campo) return;
    const nome = campo.dataset.qtd;
    const tabuleiro = campo.closest(".linha").dataset.tabuleiro;
    const n = Math.floor(Number(campo.value));
    if (campo.value.trim() === "" || !Number.isFinite(n)){
      campo.value = findEntry(nome, tabuleiro)?.quantidade ?? "";
      return;
    }
    // Ainda em foco é Enter ou seta: a lista se redesenha por baixo, e o
    // foco volta pro número novo pra a próxima seta continuar contando.
    const emFoco = document.activeElement === campo;
    // Escrito de volta porque, quando a conta não muda (150 num deck que já
    // tem 99, 2,5 onde já há 2), nada se redesenha e o campo ficaria mentindo.
    campo.value = Math.min(99, n);
    setQuantity(nome, Math.min(99, n), tabuleiro);
    if (!emFoco) return;
    const novo = [...document.querySelectorAll("[data-qtd]")].find(el =>
      el.dataset.qtd === nome && el.closest(".linha").dataset.tabuleiro === tabuleiro);
    novo?.focus();
  });


  $("nome-deck").addEventListener("input", () => {
    state.nome = $("nome-deck").value.trim() || "Deck sem nome";
    agendarSalvar();
  });

  $("btn-compartilhar").addEventListener("click", async () => {
    const url = location.origin + location.pathname + "?deck=" + state.id;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copiado. Quem abrir vê e edita este mesmo deck.");
    } catch(e){ prompt("Link do deck:", url); }
  });

  // Copiar a lista é a ação que se faz olhando pro total, então ela mora no
  // próprio número em vez de num botão separado.
  $("btn-fechar-cotacao").addEventListener("click", fecharCotacao);

  $("btn-nova-categoria").addEventListener("click", () => {
    const nome = prompt("Nome da nova categoria:\n\n" +
      "Ex.: Combo principal, Sac outlet, Proteção do comandante");
    if (nome) createCategory(nome);
  });

  $("btn-recolher-talvez").addEventListener("click", () => recolherTalvez());
  $("btn-ver-analise").addEventListener("click", () => {
    trocarAba("analise");
    $("painel-analise").scrollIntoView({behavior: "smooth", block: "nearest"});
  });

  ligarArrastar();

  // ---- as duas fitas de abas ----
  $("abas-deck").addEventListener("click", (e) => {
    const b = e.target.closest("[data-painel]");
    if (b) trocarAba(b.dataset.painel);
  });
  $("abas-rail").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rail]");
    if (b) trocarRail(b.dataset.rail);
  });

  // ---- destino da carta que entra ----
  // Criar daqui não mexe em carta nenhuma: cria a categoria vazia e já a deixa
  // escolhida, pra que as próximas cartas da busca caiam nela.
  $("btn-nova-cat").addEventListener("click", () => {
    const nome = prompt("Nome da nova categoria:\n\n" +
      "Ex.: Combo principal, Sac outlet, Proteção do comandante");
    if (!nome) return;
    state.destinoCategoria = createCategory(nome) || "";
    touch();
  });

  // ---- deck médio do EDHREC ----
  // O orçamento escolhido mora na classe do botão: só é lido no clique de
  // importar, e não há mais ninguém na tela que precise dele.
  $("seg-orcamento-medio").addEventListener("click", (e) => {
    const b = e.target.closest("[data-orcamento]");
    if (!b) return;
    for (const irmao of b.parentElement.children){
      irmao.classList.toggle("ativa", irmao === b);
    }
  });
  $("btn-deck-medio").addEventListener("click", importAverageDeck);

  // ---- a folha de baixo do celular ----
  $("btn-abrir-busca").addEventListener("click", abrirFolha);
  $("folha-fundo").addEventListener("click", fecharFolha);
  $("puxador").addEventListener("click", fecharFolha);
  $("btn-subir").addEventListener("click", () =>
    window.scrollTo({top: 0, behavior: "smooth"}));

  ligarPrevia();
}

/* Importar o link que foi colado na busca de comandante.

   O trabalho é o mesmo da gaveta, e é pra lá que este atalho leva: o recado
   do que veio — o que foi pro maybeboard, as cartas que a base local não
   conhece — precisa de uma superfície que continue na tela, e a tela do
   comandante desaparece no instante em que o deck importado traz um. */
export function importarLinkColado(){
  const url = $("busca-cmd").value.trim();
  if (!deckLinkSource(url)) return;
  $("i-url").value = url;
  // A lista em texto que tenha sobrado de uma importação anterior não vale
  // aqui: quem colou um link pediu o link.
  $("i-texto").value = "";
  $("busca-cmd").value = "";
  clearCommanderResults();
  openDrawer("gaveta-importar");
  fazerImportar();
}

/* O menu do "···". Ele guarda o que se faz uma vez por deck; o cabeçalho
   guarda o que se faz sempre. O que leva a outra página é link (`href`); o
   que age aqui mesmo é botão. */
function menuDoCabecalho(){
  const itens = [];
  const meus = lidos();
  if (meus.length){
    itens.push({rotulo: `Meus decks (${meus.length})`, href: "/meus-decks"});
  }
  itens.push({rotulo: "Importar lista", aoClicar: () => openDrawer("gaveta-importar")});
  itens.push({rotulo: "Exportar lista (copiar)", aoClicar: exportar});
  itens.push("risco");
  itens.push({rotulo: "Novo deck", href: location.pathname, aoClicar: comecarNovo});
  itens.push({rotulo: "Imprimir proxies", href: "/"});
  if (!state.usuario){
    itens.push("risco");
    itens.push({rotulo: "Entrar", href: linkDeConta("entrar")});
    itens.push({rotulo: "Criar conta", href: linkDeConta("cadastro")});
  }
  return itens;
}

/* O clique no "Novo deck", que é link pro deckbuilder sem `?deck=`. A
   pergunta vale só pro clique que troca ESTA aba: o Ctrl+clique abre o deck
   novo noutra aba e deixa este onde está. */
function comecarNovo(e){
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (state.cartas.length && !confirm("Começar um deck novo? O atual fica " +
      "salvo e continua em Meus decks.")) e.preventDefault();
}
