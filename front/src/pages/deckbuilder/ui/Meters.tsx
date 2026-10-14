/* Os medidores do cabeçalho: quantas cartas e quanto custa.

   O que vai na tela sai de `counterView` e `totalView`, funções puras (os
   testes as conferem); o componente só desenha. */
import { exportar } from "../importar-exportar.js";
import { alternarCotacao } from "../cotacao.js";
import { totalCards } from "../deck";
import { assinaturaDeCotacao, orcamentoLocal } from "../orcamento.js";
import { exchangeNote, money } from "../price";
import { validacaoAtual } from "../salvar.js";
import { state } from "../state";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* O ponto colorido carrega a validação inteira num pixel: verde é deck
   legal, vermelho é erro de verdade (carta fora da identidade, singleton
   quebrado, banida), cinza é "ainda montando" — que não é erro nenhum e por
   isso não é vermelho. O título diz o que o ponto resume, pra quem quiser a
   frase. */
export function counterView() {
  const total = totalCards();
  const v = validacaoAtual();
  const serious = (v.apontamentos || []).filter(
    (a: any) => a.nivel === "erro" && a.tipo !== "faltam" && a.tipo !== "sobram");
  const status = serious.length ? "erro" : total === 100 && v.ok ? "completo" : total > 100 ? "passou" : "";
  const title = serious.length
    ? `${serious.length} problema(s) — veja a aba Análise`
    : total === 100 && v.ok
      ? "Deck legal: 100 cartas, singleton respeitado e tudo na identidade"
      : total > 100
        ? `${total - 100} carta(s) além das 100`
        : `Faltam ${100 - total} carta(s) pras 100`;
  return { total, status, title };
}

/* O total do deck. Cotado, o número já vem na moeda da fonte e NÃO passa por
   `money()`: o total da LigaMagic é real de verdade, e o da Scryfall pode já
   ter vindo convertido pelo `USD_BRL` do .env. Converter aqui converteria
   duas vezes. Não cotado, é a base local em dólar, e aí sim a régua se
   aplica. */
export function totalView() {
  const hasDeck = !!(state.comandantes.length || state.cartas.length);
  const o = orcamentoLocal();
  const maybe = state.maybe.reduce((n, e) => n + e.quantidade, 0);
  const parts = [];
  if (o.cartas) parts.push(`${o.cartas} carta(s) contadas`);
  if (o.fora) parts.push(`${o.fora} fora do total (comandante e básicos)`);
  if (o.semPreco) parts.push(`${o.semPreco} sem preço na base`);
  if (maybe) parts.push(`${maybe} no maybeboard, fora da conta`);

  const source = (state.cotacao?.fontes || [])[0];
  const quoted = source && source.cartas_cotadas;
  const text = quoted
    ? `${source.moeda === "BRL" ? "R$" : "US$"} ` + Number(source.total).toFixed(2).replace(".", ",")
    : money(o.total);
  // Entre mexer no deck e a cotação nova voltar existe uma janela em que o
  // número mostrado é de OUTRO deck. O giro cobre essa janela inteira — a
  // espera e a consulta — em vez de só a consulta.
  const waiting = !!(state.cotacaoRodando ||
    (state.id && assinaturaDeCotacao() !== state.cotacaoAssinatura && o.cartas));
  return {
    hasDeck,
    showQuoteToggle: hasDeck && !!(state.cotacao || state.cotacaoErro),
    text,
    label: quoted ? source.rotulo : "prévia",
    waiting,
    title: [
      quoted ? `Preço de comprar em ${source.rotulo}, cotado agora.`
             : "Soma da base local — a cotação de verdade chega em alguns segundos.",
      quoted ? "" : exchangeNote(),
      parts.join(" · "),
      "Clique pra copiar a lista do deck.",
    ].filter(Boolean).join("\n"),
  };
}

export function Meters() {
  useDeck();
  const c = counterView();
  const t = totalView();
  return (
    <>
      <span class={"medidor" + (c.status ? " " + c.status : "")} id="contador" title={c.title}>
        <span class="ponto" id="contador-ponto" />
        <b id="contador-n">{c.total}</b><span class="de">/100</span>
      </span>
      {/* Clicar no total copia a lista do deck: a ação mora no número que
          ela exporta. O ⌄ ao lado abre o detalhe da cotação, que é alto
          demais pra caber num tooltip. */}
      <button class={"medidor" + (t.waiting ? " cotando" : "")} id="btn-total" type="button"
              hidden={!t.hasDeck} title={t.title} onClick={() => exportar()}>
        <b id="total-n">{t.text}</b><span class="de" id="total-de">{t.label}</span>
      </button>
      <button class="btn redondo" id="btn-cotacao" type="button" hidden={!t.showQuoteToggle}
              aria-controls="cotacao-caixa" title="Detalhe da cotação" aria-label="Detalhe da cotação"
              onClick={() => alternarCotacao()}>
        <SpriteIcon name="caret-down" />
      </button>
    </>
  );
}
