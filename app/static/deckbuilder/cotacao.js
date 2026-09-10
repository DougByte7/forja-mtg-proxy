"use strict";

/* --------------------------------------------------------------- orçamento */

let cotacaoTimer = null;

async function cotar(){
  if (estado.cotacaoRodando) return;
  if (!estado.id) await salvarAgora();
  if (!estado.id) return;
  // A assinatura é gravada ANTES da resposta: se o deck mudar durante a
  // cotação, `agendarCotacao` vê a diferença e marca outra pra depois desta.
  estado.cotacaoAssinatura = assinaturaDeCotacao();
  estado.cotacaoRodando = true;
  estado.cotacaoErro = null;
  desenharPreviaOrcamento();
  try {
    const inicio = await api(`/decks/${estado.id}/cotacao`, {method: "POST"});
    acompanharCotacao(inicio.job_id);
  } catch (e){
    terminarCotacao(null, e.message);
  }
}

/* Fim de cotação, com sucesso ou não, num lugar só: são quatro caminhos de
   saída (erro ao começar, erro no meio, erro do servidor, pronto) e cada um
   precisa desligar o giro, guardar o resultado e redesenhar. */
function terminarCotacao(resultado, erro){
  clearInterval(cotacaoTimer);
  estado.cotacaoRodando = false;
  estado.cotacaoErro = erro || null;
  if (resultado) estado.cotacao = resultado;
  desenharCotacao();
  desenharPreviaOrcamento();
  // A lista também muda: cada carta que a loja achou troca o preço estimado
  // da base pelo medido. Sem isto os preços novos só apareceriam na próxima
  // vez que alguém encostasse no deck.
  if (resultado) desenharDeck();
  // O deck pode ter mudado enquanto o servidor cotava: se mudou, esta
  // resposta já nasce velha e a próxima é marcada agora.
  agendarCotacao();
}

function acompanharCotacao(jobId){
  clearInterval(cotacaoTimer);
  const passo = async () => {
    try {
      const r = await api(`/cotacao/${jobId}`);
      if (r.estado === "cotando") return;
      if (r.estado === "erro") terminarCotacao(null, r.detalhe);
      else terminarCotacao(r.resultado, null);
    } catch (e){
      terminarCotacao(null, e.message);
    }
  };
  passo();
  cotacaoTimer = setInterval(passo, 2000);
}

/* O detalhe da cotação, no painel que abre embaixo do número. Só o que não
   cabe no cabeçalho: as duas fontes, onde está o dinheiro, o que ficou de
   fora. */
function desenharCotacao(){
  const caixa = $("orc-resultado");
  if (estado.cotacaoErro){
    caixa.innerHTML = `<div class="aponta erro" style="grid-column:1/-1">
      <span>${escapar(estado.cotacaoErro)}</span></div>`;
    return;
  }
  const resultado = estado.cotacao;
  if (!resultado){ caixa.innerHTML = ""; return; }

  // Total que não cobre o deck inteiro precisa dizer isso NO LUGAR do número,
  // não embaixo dele: uma fonte fora do ar devolve zero carta cotada, e
  // "US$ 0,00" lido como total é pior do que não ter cotado.
  const fontes = (resultado.fontes || []).map(f => {
    const pedidas = f.cartas_cotadas + f.cartas_faltando;
    const simbolo = f.moeda === "BRL" ? "R$" : "US$";
    if (!f.cartas_cotadas){
      return `<div class="aponta aviso" style="margin-top:6px">
        <span><b>${escapar(f.rotulo)}</b> não devolveu preço de nenhuma das
        ${pedidas} cartas. Fonte fora do ar ou bloqueando a consulta — não é
        que o deck seja de graça.</span></div>`;
    }
    return `
    <div class="fonte">
      <span class="rot">${escapar(f.rotulo)}<br>
        <small style="color:${f.cartas_faltando ? "var(--gold-light)" : "var(--text-muted)"}">
          ${f.cartas_cotadas} de ${pedidas} cartas${
            f.cartas_faltando ? " — total incompleto" : ""}</small></span>
      <span class="tot">${simbolo} ${Number(f.total).toFixed(2)}</span>
    </div>`;
  }).join("");

  // As mais caras primeiro: é o que responde "onde está o dinheiro do deck",
  // que é a pergunta de quem cota antes de proxiar.
  const principal = (resultado.fontes || [])[0];
  const caras = (resultado.cartas || [])
    .filter(c => c.fontes && c.fontes[principal?.id]?.preco)
    .sort((a,b) => b.fontes[principal.id].preco - a.fontes[principal.id].preco)
    .slice(0, 8)
    .map(c => `<div class="cara"><b>${escapar(c.nome)}</b>
       <span>${principal.moeda === "BRL" ? "R$" : "US$"}
       ${Number(c.fontes[principal.id].preco).toFixed(2)}</span></div>`).join("");

  const excluidas = (resultado.excluidas || []).length;
  const talvez = estado.maybe.reduce((n, e) => n + e.quantidade, 0);
  caixa.innerHTML =
    `<div>${fontes}</div>` +
    (caras ? `<div class="caras"><h2 class="secao">Onde está o dinheiro</h2>${caras}</div>` : "") +
    `<div>${excluidas ? `<p class="nota">${excluidas} carta(s) fora do total:
       comandante e terrenos básicos, pelo critério do Commander 500.</p>` : ""}
     ${talvez ? `<p class="nota" style="margin-top:8px">${talvez} carta(s) no
       maybeboard não foram cotadas — é pra isso que ele serve.</p>` : ""}</div>`;
}

/* ------------------------------------------------- popover da cotação */

function alternarCotacao(){
  const caixa = $("cotacao-caixa");
  if (!caixa.hidden) return fecharCotacao();
  caixa.hidden = false;
  const ancora = $("btn-cotacao").getBoundingClientRect();
  const m = caixa.getBoundingClientRect();
  caixa.style.left = Math.max(8,
    Math.min(ancora.left - m.width + ancora.width,
             window.innerWidth - m.width - 8)) + "px";
  caixa.style.top = (ancora.bottom + 6) + "px";
  $("btn-cotacao").setAttribute("aria-expanded", "true");
}

function fecharCotacao(){
  $("cotacao-caixa").hidden = true;
  $("btn-cotacao").setAttribute("aria-expanded", "false");
}
