/* ------------------------------------------------------------- sugestões

   As cartas vêm do EDHREC já filtradas pelo servidor (sem o que o deck tem,
   sem o que a base local não conhece, sem o que não cabe na identidade), e
   com a carta completa junto — então adicionar é o mesmo clique da busca,
   sem uma segunda consulta.

   A aba responde a DUAS perguntas com a mesma lista. A padrão é a do
   comandante ("o que combina com ele?"); a estrela no hover de cada linha do
   deck troca pra outra ("já que o deck tem esta carta, o que mais entra?"),
   que é a pergunta que aparece quando o comandante já foi esgotado e o deck
   está meio montado. São listas parecidas o bastante pra se confundirem, e
   nenhuma carta listada denuncia de qual das duas veio — por isso a resposta
   traz `alvo` e o cabeçalho o diz por extenso. */

import {$, escapar} from "../comum/dom.js";
import {ganchosDaPrevia} from "./carta.js";
import {estado} from "./estado.js";
import {aplicarImportado,
        mostrarResultadoImportacao} from "./importar-exportar.js";
import {abrirFolha, folhaAberta, trocarRail} from "./paineis.js";
import {api, salvarAgora, salvarJa} from "./salvar.js";
import {ico, manaHTML, preco, toast} from "./utilidades.js";

// As cartas das sugestões, achatadas numa lista só — é o que o clique usa
// pra adicionar, igual ao `ultimosResultados` da busca.
export let sugestoesPlanas = [];

export async function buscarSugestoes({tema = null, carta = null} = {}){
  if (!estado.comandantes.length){
    toast("Escolha o comandante primeiro: é ele que define o que combina.");
    return;
  }
  // Antes do primeiro `await`: quem chama daqui de dentro da tela troca de aba
  // na linha seguinte, e um deck ainda sem id (que passa pelo salvamento
  // abaixo) abriria a janela em que `rodarAoAbrir` não veria pedido nenhum em
  // voo e pediria a página do comandante por cima desta.
  estado.sugestoesRodando = true;
  $("sug-resultado").innerHTML = `<div class="nota">Perguntando ao EDHREC sobre
    ${escapar(carta || estado.comandantes.map(c => c.nome).join(" e "))}…</div>`;
  try {
    if (!estado.id) await salvarAgora();
    if (!estado.id){
      $("sug-resultado").innerHTML = `<div class="aponta erro"><span>Não
        consegui salvar o deck antes de sugerir.</span></div>`;
      return;
    }
    estado.sugestoes = await api(`/decks/${estado.id}/sugestoes`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({tema: carta ? null : (tema || null),
                            carta: carta || null}),
    });
    // O tema é do comandante: a página de uma carta não tem nenhum, e deixar
    // o anterior guardado faria o "voltar ao comandante" cair num tema que a
    // pessoa escolheu duas listas atrás.
    estado.sugestoesTema = carta ? null : (tema || null);
  } catch (e){
    $("sug-resultado").innerHTML =
      `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    return;
  } finally {
    estado.sugestoesRodando = false;
  }
  desenharSugestoes();
}

/* A estrela de uma linha do deck. Pede a lista ANTES de trocar de aba, e não
   depois, porque `trocarRail` também busca sugestão quando a aba chega vazia:
   com o pedido já em voo ele vê a bandeira e não pergunta a mesma coisa duas
   vezes pra dois alvos diferentes. */
export function sugerirPelaCarta(nome){
  buscarSugestoes({carta: nome});
  trocarRail("sugestoes");
  if (window.innerWidth <= 900 && !folhaAberta()) abrirFolha();
}

export function desenharSugestoes(){
  const caixa = $("sug-resultado");
  const s = estado.sugestoes;
  if (!s){ caixa.innerHTML = ""; return; }

  let html = "";

  // Quem respondeu, dito antes da primeira sugestão. Vale pros dois alvos e
  // não só pra carta: "para o comandante Atraxa" é o que faz a pessoa
  // entender, ao ver a linha mudar depois de clicar numa estrela, que existem
  // dois modos — e o botão de voltar só faz sentido pra quem sabe de onde
  // veio.
  const daCarta = s.alvo?.tipo === "carta";
  // O nome do comandante sai daqui, e não do `alvo` que veio junto: com uma
  // dupla de parceiros o servidor manda os dois separados por vírgula, e
  // "Muldrotha, the Gravetide" já tem vírgula dentro — a lista de dois viraria
  // uma lista de quatro. A tela junta com "e", que é como ela escreve dupla em
  // todo o resto.
  const alvo = daCarta ? (s.alvo.nome || "")
                       : estado.comandantes.map(c => c.nome).join(" e ");
  html += `<div class="sug-alvo">
    ${ico("sparkle")}
    <span class="quem">${daCarta ? "A partir da carta" : "Para o comandante"}
      <b>${escapar(alvo)}</b></span>
    ${daCarta ? `<button class="voltar" data-sug-comandante
      title="Voltar a sugerir a partir do comandante">${
        ico("arrow-counter-clockwise")}Comandante</button>` : ""}
  </div>`;

  if (s.temas && s.temas.length){
    html += `<div class="temas">
      <button class="chip ${!estado.sugestoesTema ? "ativo" : ""}"
              data-tema="">Tudo</button>` +
      s.temas.slice(0, 14).map(t => `
        <button class="chip ${estado.sugestoesTema === t.slug ? "ativo" : ""}"
                data-tema="${escapar(t.slug)}"
                title="${t.decks ? escapar(t.decks) + " decks" : ""}"
          >${escapar(t.nome)}</button>`).join("") + `</div>`;
  }

  if (!s.listas.length){
    html += `<div class="vazio">O EDHREC não trouxe nada que este deck ainda
      não tenha${daCarta ? " e que caiba na identidade de cor dele" : ""}. Se
      ele está quase completo, isso é bom sinal.</div>`;
  }

  // A partir de quanto a sinergia é notável — e não é o mesmo número nas duas
  // listas. O comandante compara contra os OUTROS comandantes, um universo
  // estreito, e 25 pontos ali já é muito: o topo de uma página de comandante
  // fica na casa dos 50. A carta compara contra o formato inteiro, e ali
  // aparecer três vezes mais que a média é rotina — pintar de verde tudo que
  // passa de 25 seria pintar metade da lista e não destacar ninguém.
  const alta = daCarta ? 100 : 25;

  // As sugestões guardam a carta completa; `sugestoesPlanas` é o que o clique
  // usa pra adicionar, do mesmo jeito que `ultimosResultados` na busca.
  sugestoesPlanas = [];
  for (const lista of s.listas){
    html += `<div class="lista-sug"><h3>${escapar(lista.titulo)}</h3>`;
    html += lista.cartas.map(item => {
      const i = sugestoesPlanas.push(item.carta) - 1;
      const sin = item.sinergia;
      const chip = sin === null || sin === undefined ? "" :
        `<span class="sinergia ${sin >= alta ? "alta" : ""}"
          title="Aparece ${sin > 0 ? sin + " pontos a mais" : Math.abs(sin) + " pontos a menos"} ${
            daCarta ? "junto de " + escapar(alvo) + " do que num deck qualquer"
                    : "com este comandante do que com os outros"}${
            item.porcento ? " · está em " + item.porcento + "% "
                            + (daCarta ? "dos decks que a jogam" : "dos decks dele") : ""}"
         >${sin > 0 ? "+" : ""}${sin}%</span>`;
      // Preço na mesma posição da linha da busca: as duas abas mostram carta
      // pra adicionar, e "quanto custa" é parte da escolha nas duas.
      return `
        <button class="achado" data-sug="${i}"${ganchosDaPrevia(item.carta)}>
          <span class="nome">
            <b>${escapar(item.carta.nome)}</b>
            <small>${escapar(item.carta.tipo)}</small>
          </span>
          ${manaHTML(item.carta.mana_cost)}
          <span class="preco">${preco(item.carta)}</span>
          ${chip}
        </button>`;
    }).join("");
    html += `</div>`;
  }

  html += `<div class="fonte-edhrec">Dados da
    <a href="${escapar(s.link)}" target="_blank" rel="noopener">página ${
      daCarta ? "de " + escapar(alvo) : "do comandante"} no EDHREC</a>${
      s.cache ? ", de uma consulta recente" : ""}. São números de decks
    registrados lá — não são regra, são o que a maioria faz.</div>`;

  caixa.innerHTML = html;
}

/* ------------------------------------------------------------ deck médio

   A outra pergunta que o EDHREC responde nesta aba: não "que carta entra
   agora?", e sim "por onde eu começo?". O deck médio é a lista das cartas
   mais jogadas nos decks registrados com o comandante, estreitada por
   bracket e orçamento. Vem do servidor no formato do importar e entra pelo
   mesmo `aplicarImportado`.

   Deck só com o comandante recebe a lista nele mesmo: não há carta pra
   perder. Com carta no deck, vale a regra do importar — pergunta antes, e o
   resultado vira um deck novo, com o de agora intacto em Meus decks. */
export async function importarDeckMedio(){
  if (!estado.comandantes.length){
    toast("Escolha o comandante primeiro: o deck médio é dele.");
    return;
  }
  const caixa = $("dm-resultado");
  const botao = $("btn-deck-medio");
  botao.disabled = true;
  caixa.innerHTML = `<div class="nota">Pedindo o deck médio ao EDHREC…</div>`;
  let trazido;
  try {
    trazido = await api("/decks/deck-medio", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        comandantes: estado.comandantes.map(c => c.nome),
        bracket: $("dm-bracket").value,
        orcamento: $("seg-orcamento-medio").querySelector(".ativa")
                     ?.dataset.orcamento || "",
      }),
    });
  } catch (e){
    caixa.innerHTML =
      `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    return;
  } finally {
    botao.disabled = false;
  }

  const temCarta = estado.cartas.length || estado.maybe.length;
  if (temCarta && !confirm(`Trocar as cartas do deck pelo deck médio do ` +
      `EDHREC?\n\nO deck de agora continua salvo e na lista de Meus decks — ` +
      `mas esta janela passa a mostrar o deck médio.`)){
    caixa.innerHTML = `<div class="nota">Importação cancelada.</div>`;
    return;
  }

  aplicarImportado(trazido, {mesmoDeck: !temCarta});
  mostrarResultadoImportacao(trazido, caixa);
  // Quantos decks entraram na média muda como ler a lista: a de doze decks
  // é o gosto de doze pessoas, a de quarenta mil é o formato falando.
  caixa.insertAdjacentHTML("beforeend", `<div class="fonte-edhrec">Média de
    ${trazido.decks ? `<b>${trazido.decks.toLocaleString("pt-BR")}</b>`
                    : "todos os"} decks registrados na
    <a href="${escapar(trazido.link)}" target="_blank" rel="noopener">página
    do deck médio no EDHREC</a>.</div>`);

  // As sugestões foram zeradas junto com o deck antigo, e esta é a aba que
  // está à vista: pede de novo, contra o deck que acabou de entrar. Grava
  // antes, porque é o deck do SERVIDOR que filtra o que já está nele.
  if (await salvarJa()) buscarSugestoes({tema: estado.sugestoesTema});
}
