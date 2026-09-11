/* ------------------------------------------------------------------ eventos */

import {$} from "../comum/dom.js";
import {ligarArrastar} from "./arrastar.js";
import {abrirEscolhaDeArte, fecharArte} from "./artes.js";
import {adicionarPeloDestino, agendarBusca, agendarBuscaComandante,
        atualizarCategoriasDoDestino, buscarComandante, escolherDestino,
        ligarTecladoDaBusca, ultimosResultados} from "./busca.js";
import {abrirCarta, cartaAberta, fecharCarta, ligarPrevia} from "./carta.js";
import {adicionarPeca} from "./combos.js";
import {alternarCotacao, fecharCotacao} from "./cotacao.js";
import {acharEntrada, adicionar, criarCategoria, definirQuantidade, desfazer,
        escolherComandante, tirar, tirarComandante} from "./edicao.js";
import {estado} from "./estado.js";
import {abrirGaveta, desenharBarraFiltros, fecharGaveta, gavetaAberta,
        lerGavetaFiltros, limparFiltros, montarGavetaFiltros,
        preencherGavetaFiltros, tirarFiltro} from "./filtros.js";
import {desfazerMesa, fecharModalGf, modalGfAberto} from "./goldfish-acoes.js";
import {exportar, fazerImportar} from "./importar-exportar.js";
import {adicionarQuantidade, analisarManabase, chamarManabase,
        desenharManabase, fixadoresPlanos} from "./manabase.js";
import {abrirMenu, fecharMenu, menuAberto, menuDaCarta,
        menuDoGrupo} from "./menus.js";
import {abrirFolha, fecharFolha, folhaAberta, recolherTalvez, trocarAba,
        trocarRail} from "./paineis.js";
import {agendarSalvar, lidos, salvando, salvarJa,
        salvarTimer} from "./salvar.js";
import {buscarSugestoes, desenharSugestoes, importarDeckMedio,
        sugerirPelaCarta, sugestoesPlanas} from "./sugestoes.js";
import {toast} from "./utilidades.js";

export function ligarEventos(){
  $("busca").addEventListener("input", agendarBusca);
  $("busca-cmd").addEventListener("input", agendarBuscaComandante);

  ligarTecladoDaBusca($("busca"), $("res"));
  ligarTecladoDaBusca($("busca-cmd"), $("res-cmd"));

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
    if (e.key === "Escape" && gavetaAberta){
      e.preventDefault();
      return fecharGaveta();
    }
    if (e.key === "Escape" && modalGfAberto()){
      e.preventDefault();
      return fecharModalGf();
    }
    if (e.key === "Escape" && !$("cotacao-caixa").hidden){
      e.preventDefault();
      return fecharCotacao();
    }
    if (e.key === "Escape" && folhaAberta()){
      e.preventDefault();
      return fecharFolha();
    }
    if (gavetaAberta) return;   // dentro da gaveta, o teclado é dela
    if (cartaAberta) return;    // e dentro da modal, dela
    if (e.key === "/" && !digitando){
      e.preventDefault();
      (estado.comandantes.length ? $("busca") : $("busca-cmd")).focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !digitando){
      e.preventDefault();
      // Na aba do goldfish, Ctrl+Z desfaz a JOGADA, não a edição do deck.
      // São duas pilhas separadas de propósito: desfazer uma jogada não pode
      // tirar uma carta do deck, e vice-versa.
      if (estado.aba === "goldfish" && estado.mesa) desfazerMesa();
      else desfazer();
    }
    if (e.key === "Escape" && !$("arte-fundo").hidden){
      fecharArte();
      return;   // fecha uma coisa por Esc: a modal, não a tela cheia atrás dela
    }
    // Sair da tela cheia pelo Esc, que é onde a mão vai primeiro.
    if (e.key === "Escape" && document.body.classList.contains("gf-cheia")){
      document.body.classList.remove("gf-cheia");
      $("gf-tela").textContent = "Tela cheia";
    }
  });

  montarGavetaFiltros();
  preencherGavetaFiltros();
  desenharBarraFiltros();

  $("btn-gaveta-filtros").addEventListener("click", () => {
    preencherGavetaFiltros();
    abrirGaveta("gaveta-filtros");
  });
  $("btn-fazer-importar").addEventListener("click", fazerImportar);
  $("btn-limpar-filtros").addEventListener("click", limparFiltros);
  $("gaveta-fundo").addEventListener("click", fecharGaveta);
  $("btn-fechar-carta").addEventListener("click", fecharCarta);
  // Só o fundo fecha: clique dentro da modal (selecionar um trecho de ruling,
  // por exemplo) não pode fechá-la.
  $("carta-fundo").addEventListener("click", (e) => {
    if (e.target === $("carta-fundo")) fecharCarta();
  });

  // Os controles da gaveta buscam sozinhos ao mudar: obrigar a apertar
  // "aplicar" pra ver o efeito de marcar "verde" transformaria uma
  // exploração de dois segundos em três cliques.
  $("gaveta-filtros").addEventListener("input", lerGavetaFiltros);
  $("gaveta-filtros").addEventListener("change", lerGavetaFiltros);
  $("f-cores").addEventListener("click", (e) => {
    const botao = e.target.closest("[data-cor]");
    if (!botao) return;
    const ligada = !botao.classList.contains("ativo");
    botao.classList.toggle("ativo", ligada);
    botao.setAttribute("aria-pressed", ligada ? "true" : "false");
    lerGavetaFiltros();
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
    if (e.target.closest("[data-fecha-gaveta]")) return fecharGaveta();
    const tira = e.target.closest("[data-tira-filtro]");
    if (tira) return tirarFiltro(tira.dataset.tiraFiltro);
    // Sugestão do EDHREC: a carta completa já veio junto, então adicionar é
    // o mesmo clique da busca — sem consulta nenhuma.
    const sugerida = e.target.closest("[data-sug]");
    if (sugerida){
      const carta = sugestoesPlanas[Number(sugerida.dataset.sug)];
      if (carta){
        // Mesmo destino da busca: as duas abas do painel respondem a mesma
        // pergunta, e obedecer o segmentado só numa delas seria armadilha.
        adicionarPeloDestino(carta);
        // Sai da lista: já está no deck, e continuar sugerindo o que a pessoa
        // acabou de adicionar é o jeito mais rápido de a lista parecer burra.
        for (const lista of (estado.sugestoes?.listas || [])){
          lista.cartas = lista.cartas.filter(c => c.carta.nome !== carta.nome);
        }
        desenharSugestoes();
      }
      return;
    }
    const tema = e.target.closest("[data-tema]");
    if (tema) return buscarSugestoes({tema: tema.dataset.tema});
    // Voltar ao comandante é refazer a pergunta padrão, não desfazer a lista
    // atual: sem tema, porque o tema que existia antes da carta é escolha de
    // outro momento (ver `buscarSugestoes`).
    if (e.target.closest("[data-sug-comandante]")) return buscarSugestoes();

    // Mana base: básicos em lote, fixadores um a um, e o teto de preço.
    const basico = e.target.closest("[data-basico]");
    if (basico){
      const b = estado.manabase?.basicos[Number(basico.dataset.basico)];
      if (b?.carta){
        adicionarQuantidade(b.carta, b.quantidade);
        toast(`${b.quantidade}× ${b.carta.nome} no deck.`);
      }
      return;
    }
    const fix = e.target.closest("[data-fix]");
    if (fix){
      const terreno = fixadoresPlanos[Number(fix.dataset.fix)];
      if (terreno){ adicionar(terreno); toast(`${terreno.nome} entrou no deck.`); }
      return;
    }
    const teto = e.target.closest("[data-teto]");
    if (teto){
      estado.manabaseTeto = Number(teto.dataset.teto);
      estado.mbPagina = 0;
      return analisarManabase();
    }
    const pag = e.target.closest("[data-mb-pag]");
    if (pag){
      estado.mbPagina += Number(pag.dataset.mbPag);
      return desenharManabase();
    }

    const achado = e.target.closest(".achado");
    if (achado){
      const caixa = achado.closest(".resultados");
      const carta = ultimosResultados[Number(achado.dataset.i)];
      if (carta && caixa.aoClicar) caixa.aoClicar(carta);
      return;
    }
    // Os botões da linha herdam o tabuleiro dela: o mesmo ✕ serve o deck e
    // o maybeboard, e sem isto o ✕ de uma carta em dúvida tiraria a cópia
    // do deck — na lista errada, calado.
    const doTabuleiro = (alvo) =>
      alvo.closest("[data-tabuleiro]")?.dataset.tabuleiro || "deck";
    // Clicar no número é ir editá-lo, não abrir a carta.
    if (e.target.closest("[data-qtd]")) return;
    const sai = e.target.closest("[data-tirar]");
    if (sai) return tirar(sai.dataset.tirar, doTabuleiro(sai));
    const sugCarta = e.target.closest("[data-sug-carta]");
    if (sugCarta) return sugerirPelaCarta(sugCarta.dataset.sugCarta);
    // O quadro de verso da galeria abre a modal já no verso; o botão da
    // linha não diz lado nenhum e abre na frente.
    const arteCarta = e.target.closest("[data-arte-carta]");
    if (arteCarta) return abrirEscolhaDeArte(arteCarta.dataset.arteCarta,
                                             arteCarta.dataset.arteFace);
    // O ⋯ da linha, que só aparece no celular: é lá que o menu da carta não
    // tem clique direito pra abrir.
    const menuCarta = e.target.closest("[data-menu-carta]");
    if (menuCarta) return menuDaCarta(menuCarta, menuCarta.dataset.menuCarta,
                                      doTabuleiro(menuCarta));
    const menuGrupo = e.target.closest("[data-menu-grupo]");
    if (menuGrupo) return menuDoGrupo(menuGrupo, menuGrupo.dataset.menuGrupo);
    // A linha inteira abre a carta — depois dos botões dela, que já
    // devolveram acima. Clicar no nome é o gesto óbvio pra "me conta mais
    // sobre esta carta", e o "Ver a carta" do menu é o caminho do teclado.
    const linhaCarta = e.target.closest(".linha[data-nome]");
    if (linhaCarta) return abrirCarta(
      acharEntrada(linhaCarta.dataset.nome, doTabuleiro(linhaCarta))?.carta);
    // O "···" do cabeçalho abre daqui, e não de um listener próprio no botão:
    // a linha lá em cima que fecha o menu ao clicar fora roda na bolha, isto
    // é, DEPOIS de um listener do próprio botão — o menu abriria e sumiria no
    // mesmo clique. Aberto daqui, o fechar-e-abrir acontece em ordem.
    if (e.target.closest("#btn-mais")){
      return abrirMenu($("btn-mais"), menuDoCabecalho());
    }
    if (e.target.closest("[data-abrir-manabase]")) return chamarManabase();
    const verCmd = e.target.closest("[data-ver-cmd]");
    if (verCmd) return abrirCarta(estado.comandantes[Number(verCmd.dataset.verCmd)]);
    const saiCmd = e.target.closest("[data-tirar-cmd]");
    if (saiCmd) return tirarComandante(Number(saiCmd.dataset.tirarCmd));
    const peca = e.target.closest("[data-add-peca]");
    if (peca) return adicionarPeca(peca.dataset.addPeca, peca);
    if (e.target.closest("#btn-parceiro")){
      escolherComandante.parceiro = true;
      $("heroi").hidden = false;
      $("busca-cmd").value = "";
      $("busca-cmd").focus();
      buscarComandante();
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
      campo.value = acharEntrada(nome, tabuleiro)?.quantidade ?? "";
      return;
    }
    // Ainda em foco é Enter ou seta: a lista se redesenha por baixo, e o
    // foco volta pro número novo pra a próxima seta continuar contando.
    const emFoco = document.activeElement === campo;
    // Escrito de volta porque, quando a conta não muda (150 num deck que já
    // tem 99, 2,5 onde já há 2), nada se redesenha e o campo ficaria mentindo.
    campo.value = Math.min(99, n);
    definirQuantidade(nome, Math.min(99, n), tabuleiro);
    if (!emFoco) return;
    const novo = [...document.querySelectorAll("[data-qtd]")].find(el =>
      el.dataset.qtd === nome && el.closest(".linha").dataset.tabuleiro === tabuleiro);
    novo?.focus();
  });

  $("nome-deck").addEventListener("input", () => {
    estado.nome = $("nome-deck").value.trim() || "Deck sem nome";
    agendarSalvar();
  });

  $("btn-compartilhar").addEventListener("click", async () => {
    const url = location.origin + location.pathname + "?deck=" + estado.id;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copiado. Quem abrir vê e edita este mesmo deck.");
    } catch(e){ prompt("Link do deck:", url); }
  });

  // O link segue sozinho quando o servidor já tem o deck da tela. Com uma
  // gravação pendente, grava antes: senão o pedido sairia sem a última carta.
  $("btn-pedido").addEventListener("click", async (e) => {
    const link = e.currentTarget;
    if (!link.hasAttribute("href") || (!salvarTimer && !salvando)) return;
    e.preventDefault();
    if (await salvarJa()) location.href = link.href;
    else toast("Não consegui salvar o deck — o pedido fica pra depois.");
  });

  // Copiar a lista é a ação que se faz olhando pro total, então ela mora no
  // próprio número em vez de num botão separado.
  $("btn-total").addEventListener("click", exportar);
  $("btn-cotacao").addEventListener("click", alternarCotacao);
  $("btn-fechar-cotacao").addEventListener("click", fecharCotacao);

  $("btn-nova-categoria").addEventListener("click", () => {
    const nome = prompt("Nome da nova categoria:\n\n" +
      "Ex.: Combo principal, Sac outlet, Proteção do comandante");
    if (nome) criarCategoria(nome);
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
  $("seg-destino").addEventListener("click", (e) => {
    const b = e.target.closest("[data-destino]");
    if (b) escolherDestino(b.dataset.destino);
  });
  $("sel-categoria").addEventListener("change", (e) => {
    estado.destinoCategoria = e.target.value;
  });
  // Criar daqui não mexe em carta nenhuma: cria a categoria vazia e já a deixa
  // escolhida, pra que as próximas cartas da busca caiam nela.
  $("btn-nova-cat").addEventListener("click", () => {
    const nome = prompt("Nome da nova categoria:\n\n" +
      "Ex.: Combo principal, Sac outlet, Proteção do comandante");
    if (!nome) return;
    estado.destinoCategoria = criarCategoria(nome) || "";
    atualizarCategoriasDoDestino();
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
  $("btn-deck-medio").addEventListener("click", importarDeckMedio);

  // ---- a folha de baixo do celular ----
  $("btn-abrir-busca").addEventListener("click", abrirFolha);
  $("folha-fundo").addEventListener("click", fecharFolha);
  $("puxador").addEventListener("click", fecharFolha);
  $("btn-subir").addEventListener("click", () =>
    window.scrollTo({top: 0, behavior: "smooth"}));

  ligarPrevia();
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
  itens.push({rotulo: "Importar lista", aoClicar: () => abrirGaveta("gaveta-importar")});
  itens.push({rotulo: "Exportar lista (copiar)", aoClicar: exportar});
  itens.push("risco");
  itens.push({rotulo: "Novo deck", href: location.pathname, aoClicar: comecarNovo});
  itens.push({rotulo: "Imprimir proxies", href: "/"});
  return itens;
}

/* O clique no "Novo deck", que é link pro deckbuilder sem `?deck=`. A
   pergunta vale só pro clique que troca ESTA aba: o Ctrl+clique abre o deck
   novo noutra aba e deixa este onde está. */
function comecarNovo(e){
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (estado.cartas.length && !confirm("Começar um deck novo? O atual fica " +
      "salvo e continua em Meus decks.")) e.preventDefault();
}
