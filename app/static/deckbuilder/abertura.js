"use strict";

/* ---------------------------------------------------------------- abertura */

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
  ligarEventos();
  ligarOrfao();
  ligarGoldfish();
  ligarArte();
  atualizarBotaoMeus();
  conferirBase();
  // Sem `await`: a taxa é a régua do preço, não o deck. Ela redesenha sozinha
  // quando chega, e enquanto não chega a tela mostra dólar em vez de esperar.
  carregarCambio();
  trocarAba("deck");
  trocarRail("buscar");
  escolherDestino("deck");
  try {
    if (localStorage.getItem(CHAVE_TALVEZ) === "0") recolherTalvez(true);
  } catch(e){ /* navegador privado: a coluna abre, que é o padrão */ }

  const id = new URLSearchParams(location.search).get("deck");
  if (id){
    try {
      const r = await api(`/decks/${id}`);
      estado.id = r.deck.id;
      estado.nome = r.deck.nome;
      estado.validacao = r.validacao;
      estado.comandantes = (r.deck.comandantes_completos || []).filter(Boolean);
      const entrada = (e) => ({carta: e.carta, quantidade: e.quantidade,
                               categoria: e.categoria || ""});
      estado.cartas = (r.deck.cartas_completas || []).filter(e => e.carta)
        .map(entrada);
      estado.maybe = (r.deck.maybeboard_completo || []).filter(e => e.carta)
        .map(entrada);
      estado.categorias = r.deck.categorias || [];
      estado.dono = r.deck.dono || null;
      $("nome-deck").value = estado.nome;
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
  // deck tem dono, e isso só se sabe com o deck em mãos.
  carregarConta();
  // As artes escolhidas, uma vez: a lista desenha 100 botões e uma consulta
  // por botão seria 100 requisições.
  carregarArtes();
  // As fichas vão pro papel com o deck: sem elas, a aba Artes e o "Gerar
  // pedido" contariam só as cartas até a aba Tokens ser aberta.
  if (estado.id) buscarTokens();
  if (estado.comandantes.length){ buscar(); }
  else { buscarComandante(); $("busca-cmd").focus(); }
  // O foco na busca só faz sentido onde ela está sempre à vista: no celular
  // ela é uma folha fechada, e focar dentro dela abriria o teclado sobre uma
  // superfície invisível.
  if (estado.comandantes.length && window.innerWidth > 900) $("busca").focus();
}

abrir();
