"use strict";

/* --------------------------------------------------------- nível de poder */

const BRACKETS = [
  [1, "Exibição",  "Deck de mesa leve: sem combo, sem game changer."],
  [2, "Núcleo",    "Nível de precon de fábrica — a régua da maioria das mesas."],
  [3, "Turbinado", "Precon melhorado: até três game changers."],
  [4, "Otimizado", "Sem freio: o deck joga pra ganhar o quanto antes."],
  [5, "cEDH",      "Não dá pra calcular: cEDH é definido pelo metagame e pela " +
                   "intenção de quem monta, não pela lista de cartas."],
];

async function estimarPoder(){
  if (!estado.comandantes.length && !estado.cartas.length){
    toast("Monte alguma coisa antes de estimar o nível.");
    return;
  }
  if (!estado.id) await salvarAgora();
  if (!estado.id){ toast("Não consegui salvar o deck antes de estimar."); return; }

  $("poder-resultado").innerHTML = `<div class="nota">Classificando…</div>`;
  try {
    estado.poder = await api(`/decks/${estado.id}/poder`, {method: "POST"});
    estado.poderAssinatura = assinaturaDoDeck();
  } catch (e){
    $("poder-resultado").innerHTML =
      `<div class="aponta erro"><span>${escapar(e.message)}</span></div>`;
    return;
  }
  desenharPoder();
}

function desenharPoder(){
  const caixa = $("poder-resultado");
  const p = estado.poder;
  if (!p){ caixa.innerHTML = ""; return; }

  let html = "";
  if (estado.poderAssinatura !== assinaturaDoDeck()){
    html += `<div class="combo-desatualizado">O deck mudou desde esta
      estimativa.<button class="refazer" data-repoder>Atualizar</button></div>`;
  }
  // Deck pela metade não tem nível: a estimativa só descreve as cartas que
  // existem, e dizer "bracket 1" pra um deck de 20 cartas seria mentira por
  // omissão.
  const total = totalCartas();
  if (total < 100){
    html += `<div class="combo-desatualizado">O deck tem ${total} de 100
      cartas — esta estimativa vale só pelo que já está montado.</div>`;
  }

  html += `<div class="escala">` + BRACKETS.map(([n, nome, explica]) => `
    <div class="degrau ${p.bracket === n ? "aqui" : ""} ${n === 5 ? "fora" : ""}"
         title="${escapar(nome)} — ${escapar(explica)}">
      <span class="n">${n}</span><span class="rot">${escapar(nome)}</span>
    </div>`).join("") + `</div>`;

  if (p.bracket){
    html += `<div class="poder-nome">Bracket ${p.bracket} — ${escapar(p.nome)}</div>
             <div class="poder-explica">${escapar(p.explicacao)}</div>`;
  } else {
    html += `<div class="poder-nome">Fora do formato</div>
      <div class="poder-explica">Com carta banida o deck não está em bracket
        nenhum.</div>`;
  }

  html += p.motivos.length
    ? p.motivos.map(m => `
        <div class="motivo ${m.nivel === "erro" ? "erro" : ""}">
          <b>${escapar(m.titulo)}</b>
          <div class="porque">${escapar(m.detalhe)}</div>
          ${m.cartas.length ? `<div class="quais">` +
            m.cartas.map(c => `<span>${escapar(c)}</span>`).join("") +
            `</div>` : ""}
        </div>`).join("")
    : `<div class="nota">Nada no deck puxa a nota pra cima: sem game changer,
       sem combo de duas cartas, sem negação de terreno em massa e sem turno
       extra.</div>`;

  if (p.cache){
    html += `<div class="nota" style="margin-top:10px">Resposta guardada de uma
      estimativa recente com este mesmo deck.</div>`;
  }
  caixa.innerHTML = html;
  const refazer = caixa.querySelector("[data-repoder]");
  if (refazer) refazer.addEventListener("click", estimarPoder);
}
