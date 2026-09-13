/* ----------------------------------------------------------------- versões

   Todo deck nasce WIP e só sai disso pela mão de quem monta: concluir
   fotografa a lista como a v0, e dali em diante cada conclusão é a versão
   seguinte (ver `decks.py`, "VERSÕES SÃO FOTOGRAFIAS"). A pílula ao lado do
   nome é o estado e a porta: diz em que versão o deck está, se a lista já
   mudou desde ela, e abre o menu que conclui a próxima.

   Quem decide é o servidor — WIP inválido e lista igual voltam 409 com o
   motivo. A tela só deixa de oferecer o clique que ele recusaria, usando a
   mesma validação instantânea do contador. */

import {$, escapar} from "../comum/dom.js";
import {ganchosDaPrevia} from "./carta.js";
import {estado} from "./estado.js";
import {abrirMenu} from "./menus.js";
import {trocarAba} from "./paineis.js";
import {api, salvando, salvarJa, salvarTimer,
        validacaoAtual} from "./salvar.js";
import {ico, toast} from "./utilidades.js";

function ehWip(){
  return estado.versao?.atual == null;
}

/* Deck com dono só o dono e o admin alteram — a mesma regra do autosave, e
   concluir versão é alterar o deck. */
function podeConcluir(){
  if (!estado.dono) return true;
  const u = estado.usuario;
  return !!u && (u.id === estado.dono || u.perfil === "admin");
}

function dataCurta(ts){
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("pt-BR",
    {day: "2-digit", month: "short", year: "numeric"});
}

/* Por que o clique de concluir não está disponível agora, ou "" se está.

   Com uma gravação esperando o autosave, a lista da tela ainda não é a do
   servidor: o `mudou` que ele contou pode estar velho, então o clique fica
   liberado e quem responde é o servidor, depois de gravar. */
function bloqueioDeConcluir(){
  if (!podeConcluir()) return "Só quem é dono do deck conclui versões.";
  if (ehWip()){
    const v = validacaoAtual();
    if (v.ok) return "";
    const tamanho = v.apontamentos.find(a => a.tipo === "faltam" || a.tipo === "sobram");
    const graves = v.apontamentos.filter(a => a.nivel === "erro" && a !== tamanho);
    if (graves.length) return `${graves.length} problema(s) na lista — veja a aba Análise.`;
    return tamanho ? tamanho.mensagem : "A lista ainda não é válida.";
  }
  if (!estado.versao.mudou && !salvarTimer && !salvando){
    return `A lista está igual à v${estado.versao.atual}.`;
  }
  return "";
}

export function desenharVersao(){
  const v = estado.versao;
  const wip = ehWip();
  const mudou = !wip && v.mudou;
  const pilula = $("btn-versao");
  pilula.textContent = wip ? "WIP" : `v${v.atual}`;
  pilula.className = "versao-pilula" + (wip ? " wip" : "") + (mudou ? " mudou" : "");
  pilula.title = wip ? "Trabalho em progresso"
    : mudou ? `Versão ${v.atual} — a lista mudou desde então`
            : `Versão ${v.atual}`;
  pilula.setAttribute("aria-label", pilula.title);

  // A partir da v1: com uma versão só não há duas listas pra comparar.
  const temHistorico = !wip && v.atual >= 1;
  $("aba-historico").hidden = !temHistorico;
  if (!temHistorico && estado.aba === "historico") trocarAba("deck");
}

export function menuDaVersao(){
  const v = estado.versao;
  const wip = ehWip();
  const bloqueio = bloqueioDeConcluir();
  const itens = [];
  if (wip){
    itens.push({titulo: "Trabalho em progresso"});
    itens.push({nota: bloqueio || "A lista está pronta pra virar a v0."});
  } else {
    // Por extenso: o título do menu é em caixa alta, e "V1" não é a pílula.
    itens.push({titulo: `Versão ${v.atual} · ${dataCurta(v.concluida_em)}`});
    const nota = bloqueio || (v.mudou
      ? `Desde a v${v.atual}: ${v.entraram} entraram, ${v.sairam} saíram.` : "");
    if (nota) itens.push({nota});
  }
  itens.push({rotulo: `Concluir v${wip ? 0 : v.atual + 1}`, marca: ico("check"),
              desabilitado: !!bloqueio, aoClicar: concluirVersao});
  if (!wip && v.atual >= 1){
    itens.push("risco");
    itens.push({rotulo: "Ver histórico", marca: ico("arrow-counter-clockwise"),
                aoClicar: () => trocarAba("historico")});
  }
  abrirMenu($("btn-versao"), itens);
}

/* A fotografia é do que o servidor tem gravado, então o que estiver
   esperando o autosave vai antes — senão a versão sairia sem a última
   carta. */
export async function concluirVersao(){
  if (!(await salvarJa())){
    toast("Não consegui salvar o deck — a versão fica pra depois.");
    return;
  }
  if (!estado.id) return;
  try {
    const r = await api(`/decks/${estado.id}/versoes`, {method: "POST"});
    estado.versao = r.versao;
    estado.historico = r.historico;
    desenharVersao();
    if (estado.aba === "historico") desenharHistorico();
    toast(`v${r.versao.atual} concluída.`);
  } catch (e){
    toast(e.message);
  }
}

/* Um contador de pedidos: a aba se abre e o autosave também pede, e a
   resposta que chega por último não é necessariamente a do pedido mais
   novo. */
let pedidoDeHistorico = 0;

export async function buscarHistorico(){
  if (!estado.id) return;
  const pedido = ++pedidoDeHistorico;
  if (!estado.historico) desenharHistorico();
  try {
    const r = await api(`/decks/${estado.id}/versoes`);
    if (pedido !== pedidoDeHistorico) return;
    estado.historico = r;
    desenharHistorico();
  } catch (e){
    if (pedido !== pedidoDeHistorico) return;
    $("historico-resultado").innerHTML = `<div class="vazio">Não consegui
      abrir o histórico: ${escapar(e.message)}</div>`;
  }
}

function desenharHistorico(){
  const h = estado.historico;
  const caixa = $("historico-resultado");
  if (!h){
    caixa.innerHTML = `<div class="vazio">Carregando…</div>`;
    return;
  }
  let html = "";
  if (h.pendente && h.atual != null){
    html += `<section class="hist-bloco pendente">
      <div class="hist-cab">
        <b>Desde a v${h.atual}</b>
        ${saldoHTML(h.pendente)}
        <span class="espaco"></span>
        <button class="btn ouro" type="button" data-concluir-versao
          ${podeConcluir() ? "" : "disabled"}>Concluir v${h.atual + 1}</button>
      </div>
      ${diferencaHTML(h.pendente)}
    </section>`;
  }
  html += `<ol class="hist-linha">${h.versoes.map(versaoHTML).join("")}</ol>`;
  caixa.innerHTML = html;
}

function versaoHTML(v){
  return `<li class="hist-bloco">
    <div class="hist-cab">
      <span class="versao-pilula">v${v.numero}</span>
      <span class="hist-quando">${escapar(dataCurta(v.criado_em))}</span>
      ${v.diferenca ? saldoHTML(v.diferenca)
        : `<span class="hist-saldo">primeira versão · ${v.total} cartas</span>`}
    </div>
    ${v.diferenca ? diferencaHTML(v.diferenca) : ""}
  </li>`;
}

function saldoHTML(d){
  return `<span class="hist-saldo" title="${d.n_entraram} entraram, ${d.n_sairam} saíram">
    <span class="entrou">+${d.n_entraram}</span> <span class="saiu">−${d.n_sairam}</span></span>`;
}

function diferencaHTML(d){
  const coluna = (titulo, linhas, classe, sinal) => `
    <div class="hist-coluna ${classe}">
      <h4>${titulo}</h4>
      ${linhas.length
        ? `<ul>${linhas.map(c => linhaDaDiferenca(c, sinal)).join("")}</ul>`
        : `<p class="nota">Nenhuma.</p>`}
    </div>`;
  return `<div class="hist-diferenca">
    ${coluna("Entraram", d.entraram, "entrou", "+")}
    ${coluna("Saíram", d.sairam, "saiu", "−")}
  </div>`;
}

// O deck não leva etiqueta: é onde a carta está quando nada é dito.
const ROTULO_DA_ZONA = {comandantes: "comandante", side: "sideboard"};

function linhaDaDiferenca(c, sinal){
  const zona = ROTULO_DA_ZONA[c.zona];
  return `<li${ganchosDaPrevia(c.carta)}>
    <span class="q">${sinal}${c.quantidade}</span>
    <span class="nome">${escapar(c.nome)}</span>
    ${zona ? `<span class="zona">${zona}</span>` : ""}</li>`;
}
