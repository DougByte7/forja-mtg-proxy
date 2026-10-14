/* ---------------------------------------------------------------- abertura */

import {$} from "../../shared/dom.js";
import {loadArts, bindArtPicker} from "./artes.js";
import {search, searchCommander, chooseDestination} from "./search";
import {lerConta, ligarConvite, ligarOrfao, receberConta} from "./conta.js";
import {desenharTudo} from "./desenho.js";
import {ligarEventos} from "./eventos.js";
import {mountIslands} from "./islands";
import {ligarGoldfish} from "./goldfish-acoes.js";
import {CHAVE_TALVEZ, recolherTalvez, trocarAba, trocarRail} from "./paineis.js";
import {loadExchangeRate} from "./price";
import {api, atualizarBotaoMeus, lembrarDeck, marcarEstado} from "./salvar.js";
import {state} from "./state";
import {loadTokens} from "./tokens";
import {toast} from "./utilidades.js";

async function conferirBase(){
  try {
    const base = await api("/cartas/estado");
    if (base.cartas > 0 && !base.erro) return;
    const aviso = $("aviso-base");
    aviso.hidden = false;
    aviso.innerHTML = base.rodando
      ? `<b>Montando a base de cartas</b> — ${base.lidas.toLocaleString("pt-BR")}
         cartas lidas até agora. A busca fica vazia até isso terminar; leva
         alguns minutos e só acontece na primeira vez.`
      : `<b>A base de cartas está vazia.</b> Ela se monta sozinha a partir do
         bulk data da Scryfall, mas ainda não rodou aqui — se isso não se
         resolver em alguns minutos, veja o log por
         <code>grep cartas</code>.`;
    if (base.rodando) setTimeout(conferirBase, 5000);
  } catch (e){ /* a busca vai avisar sozinha se estiver fora do ar */ }
}

async function abrir(){
  // As ilhas antes dos eventos: o que ainda se liga por id precisa achar os
  // elementos que elas desenham.
  mountIslands();
  ligarEventos();
  ligarOrfao();
  ligarConvite();
  ligarGoldfish();
  bindArtPicker();
  atualizarBotaoMeus();
  conferirBase();
  // Sem `await`: a taxa é a régua do preço, não o deck. Ela redesenha sozinha
  // quando chega, e enquanto não chega a tela mostra dólar em vez de esperar.
  loadExchangeRate();
  trocarAba("deck");
  trocarRail("buscar");
  chooseDestination("deck");
  try {
    if (localStorage.getItem(CHAVE_TALVEZ) === "0") recolherTalvez(true);
  } catch(e){ /* navegador privado: a coluna abre, que é o padrão */ }

  // Junto do deck, e não depois dele: o autosave pergunta se há conta, e a
  // primeira carta pode entrar antes de um `/conta` que viesse em seguida.
  const lendoConta = lerConta();

  const id = new URLSearchParams(location.search).get("deck");
  if (id){
    try {
      const r = await api(`/decks/${id}`);
      state.id = r.deck.id;
      state.nome = r.deck.nome;
      state.validacao = r.validacao;
      state.versao = r.versao;
      state.comandantes = (r.deck.comandantes_completos || []).filter(Boolean);
      const entrada = (e) => ({carta: e.carta, quantidade: e.quantidade,
                               categoria: e.categoria || ""});
      state.cartas = (r.deck.cartas_completas || []).filter(e => e.carta)
        .map(entrada);
      state.maybe = (r.deck.maybeboard_completo || []).filter(e => e.carta)
        .map(entrada);
      state.categorias = r.deck.categorias || [];
      state.dono = r.deck.dono || null;
      $("nome-deck").value = state.nome;
      $("btn-compartilhar").hidden = false;
      lembrarDeck();
      marcarEstado("salvo", "ok");
    } catch (e){
      toast("Não achei esse deck: " + e.message);
      history.replaceState(null, "", location.pathname);
    }
  }

  desenharTudo();
  // Depois do deck, de propósito: a oferta de reclamar precisa saber se este
  // deck tem dono, e o convite, se há deck aberto.
  lendoConta.then(receberConta);
  // As artes escolhidas, uma vez: a lista desenha 100 botões e uma consulta
  // por botão seria 100 requisições.
  loadArts();
  // As fichas vão pro papel com o deck: sem elas, a aba Artes e o "Gerar
  // pedido" contariam só as cartas até a aba Tokens ser aberta.
  if (state.id) loadTokens();
  if (state.comandantes.length){ search(); }
  else { searchCommander(); $("busca-cmd").focus(); }
  // O foco na busca só faz sentido onde ela está sempre à vista: no celular
  // ela é uma folha fechada, e focar dentro dela abriria o teclado sobre uma
  // superfície invisível.
  if (state.comandantes.length && window.innerWidth > 900) $("busca").focus();
}

abrir();
