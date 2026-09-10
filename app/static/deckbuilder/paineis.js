"use strict";

/* ------------------------------------------------------------------- abas

   Duas fitas de abas, e as duas funcionam do mesmo jeito: a que está ativa
   ganha a classe, os painéis irmãos somem. Trocar de aba não recalcula nada —
   os painéis do centro são desenhados a cada mudança do deck, estejam à
   vista ou não, senão abrir "Análise" mostraria o deck de dois minutos atrás
   por um quadro. */
/* Abrir a aba é o pedido: quem clica em "Análise" quer a análise inteira,
   nível de poder incluído, não um botão que promete o nível. A conta só sai se
   ainda não houver resposta ou se o deck tiver mudado desde a última — trocar
   de aba ida e volta não repete consulta. */
function rodarAoAbrir(nome){
  if (!estado.comandantes.length) return;
  if (nome === "manabase" && !estado.manabase) return analisarManabase();
  // As sugestões dependem do comandante, não da lista: refazê-las a cada
  // carta adicionada seria uma consulta por clique pra receber quase a mesma
  // resposta. Busca uma vez; o botão do painel refaz quando a pessoa quiser.
  if (nome === "sugestoes" && !estado.sugestoes && !estado.sugestoesRodando){
    return buscarSugestoes({tema: estado.sugestoesTema});
  }
  const assinatura = assinaturaDoDeck();
  if (nome === "analise" && estado.poderAssinatura !== assinatura){
    return estimarPoder();
  }
  if (nome === "combos" && estado.combosAssinatura !== assinatura){
    return procurarCombos();
  }
  if (nome === "tokens" && estado.tokensAssinatura !== assinatura){
    return buscarTokens();
  }
  // O goldfish NÃO embaralha sozinho ao abrir a aba, ao contrário das outras:
  // as demais recalculam algo sobre o deck, e recalcular é de graça; aqui
  // "recalcular" seria jogar fora a mesa que a pessoa está jogando.
  if (nome === "goldfish") return desenharMesa();
}

function trocarAba(nome){
  estado.aba = nome;
  const fita = $("abas-deck");
  for (const b of fita.children){
    const ativa = b.dataset.painel === nome;
    b.classList.toggle("ativa", ativa);
    b.setAttribute("aria-selected", String(ativa));
  }
  for (const painel of document.querySelectorAll("#area-deck > [data-painel]")){
    painel.hidden = painel.dataset.painel !== nome;
  }
  rodarAoAbrir(nome);
}

function trocarRail(nome){
  estado.rail = nome;
  const fita = $("abas-rail");
  for (const b of fita.children){
    const ativa = b.dataset.rail === nome;
    b.classList.toggle("ativa", ativa);
    b.setAttribute("aria-selected", String(ativa));
  }
  for (const bloco of document.querySelectorAll(".rail-conteudo")){
    bloco.hidden = bloco.dataset.rail !== nome;
  }
  // No computador a busca está sempre à vista e receber o foco ao trocar de
  // aba é o que se espera. No celular ela é uma folha: quem abre a folha é
  // `abrirFolha`, e é ele quem foca — depois da animação.
  if (nome === "buscar" && window.innerWidth > 900) $("busca").focus();
  if (nome === "combos" || nome === "sugestoes") rodarAoAbrir(nome);
}

/* ------------------------------------------------- folha de baixo (celular)

   A busca não é uma coluna no telefone: é uma tarefa que se abre por cima do
   deck, se usa e se fecha. O `inert` do resto da página não é enfeite — sem
   ele o Tab sai da folha e vai parar na lista do deck por baixo dela. */
function abrirFolha(){
  $("lateral").classList.add("aberta");
  $("folha-fundo").classList.add("aberta");
  trocarRail(estado.rail);
  setTimeout(() => $("busca").focus(), 220);
}

function fecharFolha(){
  $("lateral").classList.remove("aberta");
  $("folha-fundo").classList.remove("aberta");
}

function folhaAberta(){
  return $("lateral").classList.contains("aberta");
}

/* ---------------------------------------------------- coluna do maybeboard

   Recolher fica guardado no navegador: quem não usa maybeboard recolhe uma
   vez e recupera a coluna pra sempre, e quem usa não recolhe nunca. Refazer
   essa escolha a cada visita seria cobrar por uma decisão já tomada. */
const CHAVE_TALVEZ = "forja.deck.talvez-aberto";

function recolherTalvez(forcar){
  const corpo = $("corpo");
  const fechado = forcar !== undefined ? forcar
    : !corpo.classList.contains("talvez-fechado");
  // Recolhe a coluna inteira — curva e maybeboard — pra devolver a largura
  // pro deck.
  corpo.classList.toggle("talvez-fechado", fechado);
  const botao = $("btn-recolher-talvez");
  botao.innerHTML = ico(fechado ? "caret-left" : "caret-right");
  botao.title = fechado ? "Abrir a coluna" : "Recolher a coluna";
  botao.setAttribute("aria-expanded", String(!fechado));
  try { localStorage.setItem(CHAVE_TALVEZ, fechado ? "0" : "1"); } catch(e){}
}
