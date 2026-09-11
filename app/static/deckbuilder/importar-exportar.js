/* --------------------------------------------------------------- importar

   Quem chega aqui quase nunca chega do zero: chega com um deck que já mantém
   em outro lugar. O servidor traz a lista e resolve os nomes na base local
   (ver `importar.py` e `decks.importado_para_deck`); esta parte só põe o
   resultado na tela.

   O deck importado NÃO substitui o atual em silêncio. Se já há carta na
   mesa, pergunta — perder duas horas de montagem por um clique errado num
   botão de importar seria o pior estrago que esta tela sabe fazer. */

import {$, escapar} from "../comum/dom.js";
import {buscar} from "./busca.js";
import {desenharTudo} from "./desenho.js";
import {guardarDesfazer} from "./edicao.js";
import {CATEGORIA_SIDEBOARD, estado} from "./estado.js";
import {agendarSalvar, api} from "./salvar.js";
import {toast} from "./utilidades.js";

export async function fazerImportar(){
  const url = $("i-url").value.trim();
  const texto = $("i-texto").value.trim();
  if (!url && !texto){
    $("i-resultado").innerHTML = `<div class="aponta aviso"><span>Cole o link
      do deck ou a lista em texto.</span></div>`;
    return;
  }

  const botao = $("btn-fazer-importar");
  botao.disabled = true;
  $("i-resultado").innerHTML = `<div class="nota">Trazendo a lista…</div>`;
  let trazido;
  try {
    trazido = await api("/decks/importar", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(url ? {url} : {texto, nome: estado.nome}),
    });
  } catch (e){
    $("i-resultado").innerHTML =
      `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    return;
  } finally {
    botao.disabled = false;
  }

  const quantas = trazido.cartas_completas.reduce((n, e) => n + e.quantidade, 0)
                + trazido.comandantes_completos.length
                + (trazido.maybeboard_completo || [])
                    .reduce((n, e) => n + e.quantidade, 0);
  if (estado.cartas.length || estado.comandantes.length){
    if (!confirm(`Trocar o deck atual pelas ${quantas} cartas importadas?\n\n` +
                 `O deck de agora continua salvo e na lista de Meus decks — ` +
                 `mas esta janela passa a mostrar o importado.`)){
      $("i-resultado").innerHTML = `<div class="nota">Importação cancelada.</div>`;
      return;
    }
  }

  aplicarImportado(trazido);
  mostrarResultadoImportacao(trazido);
}

/* O deck importado vira um deck NOVO, com id novo.

   Escrever por cima do deck aberto apagaria do servidor o que alguém pode ter
   compartilhado por link. Um id novo custa uma linha no banco e não destrói
   nada — é a mesma escolha do botão "duplicar".

   `mesmoDeck` é a exceção, pra quem chama sabendo que o deck aberto não tem
   o que perder: só o comandante, nenhuma carta (ver `importarDeckMedio`). Aí
   o id novo é que faria estrago — deixaria em Meus decks um deck vazio. */
export function aplicarImportado(trazido, {mesmoDeck = false} = {}){
  guardarDesfazer();
  if (!mesmoDeck) estado.id = null;
  estado.validacao = null;
  estado.comandantes = trazido.comandantes_completos;
  const entrada = (e) => ({carta: e.carta, quantidade: e.quantidade,
                           categoria: e.categoria || ""});
  estado.cartas = trazido.cartas_completas.map(entrada);
  // O maybeboard do site de origem vem junto: é o mesmo rascunho, e trazer
  // só as 100 obrigaria a copiar à mão a parte da lista que a pessoa ainda
  // estava decidindo (ver `importar.py`).
  estado.maybe = (trazido.maybeboard_completo || []).map(entrada);
  estado.categorias = trazido.categorias || [];
  // As análises são do deck que acabou de ser substituído. Deixá-las na
  // tela mostraria a curva de um deck e os combos de outro.
  estado.combos = estado.poder = estado.sugestoes = estado.manabase = null;
  estado.combosMexidos = 0;
  $("combos-resultado").innerHTML = "";
  $("poder-resultado").innerHTML = "";
  $("sug-resultado").innerHTML = "";
  $("mb-resultado").innerHTML = "";
  $("orc-resultado").innerHTML = "";

  // No mesmo deck, o nome que a pessoa deu fica: ele é dela, e o que mudou
  // foram as cartas. Só o nome de fábrica cede lugar ao que veio.
  if (trazido.nome && (!mesmoDeck || estado.nome === "Deck sem nome")){
    estado.nome = trazido.nome;
    $("nome-deck").value = estado.nome;
  }
  if (!mesmoDeck){
    history.replaceState(null, "", location.pathname);
    $("btn-compartilhar").hidden = true;
  }
  desenharTudo();
  buscar();
  agendarSalvar();
}

/* `caixa` é onde o recado aparece: a gaveta de importar, ou o bloco do deck
   médio na aba de sugestões. */
export function mostrarResultadoImportacao(trazido, caixa = $("i-resultado")){
  const total = trazido.cartas_completas.reduce((n, e) => n + e.quantidade, 0)
              + trazido.comandantes_completos.length;
  const talvez = (trazido.maybeboard_completo || [])
    .reduce((n, e) => n + e.quantidade, 0);
  const side = trazido.cartas_completas
    .filter(e => e.categoria === CATEGORIA_SIDEBOARD)
    .reduce((n, e) => n + e.quantidade, 0);
  const faltando = trazido.nao_encontradas || [];
  let html = `<div class="aponta ok"><span><b>${total} carta(s)</b> vieram do
    ${escapar(trazido.fonte)}${trazido.comandantes_completos.length
      ? ` — comandante: ${escapar(trazido.comandantes_completos.map(c => c.nome).join(" + "))}`
      : ""}.</span></div>`;
  // O que foi pro maybeboard e pro sideboard precisa ser dito: são cartas
  // que não vão aparecer na contagem das 100, e sem esse aviso a pessoa
  // confere o contador e acha que a importação perdeu 20 cartas.
  if (talvez || side){
    const partes = [];
    if (talvez) partes.push(`<b>${talvez}</b> no maybeboard`);
    if (side) partes.push(`<b>${side}</b> no sideboard`);
    html += `<div class="aponta aviso" style="margin-top:6px"><span>
      ${partes.join(" e ")} — fora da contagem das 100. O maybeboard também
      fica fora da cotação; o sideboard, não.</span></div>`;
  }

  // Carta que a base local não conhece não pode sumir calada: quem importa
  // 100 cartas e recebe 97 precisa saber QUAIS três ficaram de fora, senão
  // descobre na hora de imprimir.
  if (faltando.length){
    const nomes = faltando.map(c => escapar(c.nome)).join(", ");
    html += `<div class="aponta aviso" style="margin-top:6px"><span>
      <b>${faltando.length} não estão na base local</b> e ficaram de fora:
      ${nomes}.<br>Costuma ser carta nova com a base atrasada — dá pra
      adicionar na mão pela busca depois que ela sincronizar.</span></div>`;
  }
  if (!trazido.comandantes_completos.length){
    html += `<div class="aponta aviso" style="margin-top:6px"><span>A lista não
      dizia quem é o comandante. Escolha ele na tela — é ele que define a
      identidade de cor de tudo.</span></div>`;
  }
  caixa.innerHTML = html;
}

/* --------------------------------------------------------------- exportar */

/* O sideboard entra e o maybeboard não, pelo mesmo critério da cotação: esta
   lista é o que vai pra impressão, e o que ainda está sendo decidido não vai
   pra impressão. Igual ao `decks.lista_texto` do servidor. */
function listaTexto(){
  const linhas = estado.comandantes.map(c => `1 ${c.nome}`);
  for (const e of estado.cartas) linhas.push(`${e.quantidade} ${e.carta.nome}`);
  return linhas.join("\n");
}

export async function exportar(){
  const texto = listaTexto();
  if (!texto){ toast("Deck vazio."); return; }
  try {
    await navigator.clipboard.writeText(texto);
    toast("Lista copiada — cole no MPC Fill pra escolher as artes.");
  } catch (e){
    // Navegador sem permissão de área de transferência (ou http sem TLS):
    // mostra o texto pra copiar na mão em vez de falhar calado.
    const janela = window.open("", "_blank");
    if (janela){
      janela.document.write("<pre>" + escapar(texto) + "</pre>");
      janela.document.close();
    } else {
      toast("Não consegui copiar. Use o link de baixar a lista.");
    }
  }
}
