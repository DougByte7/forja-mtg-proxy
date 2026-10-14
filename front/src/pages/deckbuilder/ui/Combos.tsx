/* Os combos moram em DOIS lugares, e a divisão não é arbitrária: são duas
   perguntas diferentes que a mesma resposta do Spellbook atende.

   * O que JÁ FECHA no deck é uma leitura da lista — "o que este deck faz" —
     e fica na aba de combos, junto das outras leituras do deck.
   * O que fica a UMA CARTA de fechar é uma lista de compras: cada linha tem
     um botão que põe carta no deck. Isso é a mesma coisa que a busca faz, e
     por isso mora no painel de adicionar, do outro lado da tela. */
import { useState } from "preact/hooks";
import { addComboPiece, deckSignature, type CombosResponse, type SpellbookCombo } from "../combos";
import { exchangeNote, money } from "../price";
import { ManaText } from "./Mana";
import { previewProps } from "./preview";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

const Plus = () => <span class="mais"> + </span>;

/* Quanto custa o combo, em dólar da base local. Num combo que o deck JÁ
   tem, a pergunta é "quanto desse deck é este combo" — o total das peças.
   Num que falta uma carta, é "quanto me custa fechar" — só o que ainda não
   está lá, que é o número que decide o clique. Peça sem preço conhecido faz
   o total virar "a partir de". */
function Cost({ combo, suggestion }: { combo: SpellbookCombo; suggestion: boolean }) {
  const toClose = suggestion && combo.faltam.length >= 1;
  const value = toClose ? combo.custo_faltando_usd : combo.custo_usd;
  const noPrice = toClose ? combo.pecas_faltando_sem_preco : combo.pecas_sem_preco;
  if (!value && !noPrice) return null;
  const title = toClose ? "Preço das peças que faltam, pela base local."
    : `Preço das ${combo.pecas.length} peças, pela base local.`;
  // Soma zero COM peça sem preço não é "de graça", é "não sei".
  if (!value) {
    return <span class="custo" title={title + " A base local não tem preço de nenhuma delas — costuma ser carta nova, com a base atrasada."}>preço ?</span>;
  }
  const caveat = noPrice ? ` ${noPrice} peça(s) sem preço conhecido ficam de fora da soma.`
    : " Não é cotação: é o preço do dia da última sincronização.";
  return (
    <span class={"custo" + (toClose ? " fechar" : "")} title={title + caveat + " " + exchangeNote()}>
      {toClose ? "fechar por " : ""}{(noPrice ? "a partir de " : "") + money(value)}
    </span>
  );
}

/* O botão só aparece pra peça que é CARTA. Peça genérica ("uma criatura com
   vigilância") não tem o que adicionar com um clique — é critério, não carta. */
function AddPiece({ combo }: { combo: SpellbookCombo }) {
  const [busy, setBusy] = useState(false);
  const missing = combo.pecas.find((p) => !p.no_deck);
  if (combo.faltam.length !== 1 || !missing) return null;
  if (missing.na_base === false) {
    return <button class="add-peca" disabled title={"A base local não conhece esta carta — ela pode ser nova demais.\nSincronize a base e tente de novo."}>
      <SpriteIcon name="plus" /> {missing.nome}</button>;
  }
  return (
    <button class="add-peca" disabled={busy} onClick={async () => {
      setBusy(true);
      if (!(await addComboPiece(missing.nome))) setBusy(false);
    }}>
      <SpriteIcon name="plus" /> {missing.nome}{missing.preco_usd ? ` · ${money(missing.preco_usd)}` : ""}
    </button>
  );
}

export function ComboCard({ combo, suggestion }: { combo: SpellbookCombo; suggestion: boolean }) {
  const pieces = combo.pecas.map((p, i) => {
    const title = p.tipo ? `${p.tipo}${p.preco_usd ? ` — ${money(p.preco_usd)}` : ""}` : undefined;
    return (
      <>
        {i > 0 && <Plus />}
        <span class={`peca ${p.no_deck ? "tem" : "falta"} ${p.comandante ? "comandante" : ""}`}
              {...previewProps(p)} title={title}>{p.nome}</span>
      </>
    );
  });
  // O que o combo pede antes de funcionar — mana disponível, permanente já
  // desvirado, oponente com criatura em jogo. É metade da decisão de
  // colocá-lo no deck.
  const needs = combo.mana || combo.prerequisitos;
  return (
    <div class={"combo" + (suggestion ? " falta" : "")}>
      <div class="topo-combo"><div class="pecas">
        {pieces}
        {combo.requer.map((r) => (
          <><Plus /><span class="peca generica" title="Critério, não carta: qualquer carta do deck que se encaixe serve.">{r}</span></>
        ))}
      </div></div>
      {combo.produz.length > 0 && <div class="produz"><b>Resulta em:</b> {combo.produz.join(", ")}</div>}
      {needs && (
        <div class="precisa">
          {combo.mana && <><b>Mana:</b> <ManaText text={combo.mana} /></>}
          {combo.mana && combo.prerequisitos && <br />}
          {combo.prerequisitos}
        </div>
      )}
      <div class="rodape">
        {combo.bracket_rotulo && <span class={`bracket ${combo.bracket}`} title={combo.bracket_explicacao}>{combo.bracket_rotulo}</span>}
        <Cost combo={combo} suggestion={suggestion} />
        <a href={combo.link} target="_blank" rel="noopener">ver no Spellbook <SpriteIcon name="arrow-square-out" /></a>
        {suggestion && <AddPiece combo={combo} />}
      </div>
    </div>
  );
}

/** O aviso de "esta resposta é sobre um deck que não existe mais". */
const Stale = () => <div class="combo-desatualizado">O deck mudou desde esta busca — procure de novo pra atualizar.</div>;

/** Esperando, ou o erro: os dois lugares mostram o mesmo. */
function Waiting() {
  const state = useDeck();
  if (state.combosRodando) return <div class="nota">Perguntando ao Spellbook…</div>;
  if (state.combosErro) return <div class="aponta erro"><span>{state.combosErro}</span></div>;
  return null;
}

export function DeckCombos() {
  const state = useDeck();
  const data: CombosResponse | null = state.combos as any;
  if (state.combosRodando || state.combosErro) return <Waiting />;
  if (!data) return null;
  const stale = state.combosAssinatura !== deckSignature();
  const inDeck = data.no_deck || [];
  return (
    <>
      {stale && <Stale />}
      {/* O que a tela fechou sozinha, e o que ela não tem como saber: a carta
          que entrou pode ter deixado OUTROS combos a uma peça de fechar, e
          isso só o Spellbook responde. Com a resposta inteira já marcada
          como velha, seriam dois avisos sobre a mesma coisa. */}
      {state.combosMexidos > 0 && !stale && (
        <div class="combo-mexido"><SpriteIcon name="check" /> {state.combosMexidos} combo(s) fecharam aqui na
          tela com as cartas que você adicionou. Procure de novo pra ver os combos <b>novos</b> que essas
          cartas abriram — essa parte só o Spellbook sabe.</div>
      )}
      {inDeck.length ? inDeck.map((c) => <ComboCard combo={c} suggestion={false} />)
        : <div class="nota">Nenhum combo fechado ainda. Os que estão a uma carta de fechar ficam na aba{" "}
            <b>Combos</b> do painel de adicionar.</div>}
      {data.cache && <div class="nota" style={{ marginTop: "10px" }}>Resposta guardada de uma busca recente com
        este mesmo deck.</div>}
    </>
  );
}

export const NEAR_COMBOS_SHOWN = 12;

export function NearCombos() {
  const state = useDeck();
  const data: CombosResponse | null = state.combos as any;
  if (state.combosRodando || state.combosErro) return <Waiting />;
  if (!data) return null;
  const near = data.faltando_uma || [];
  return (
    <>
      {state.combosAssinatura !== deckSignature() && <Stale />}
      {!near.length ? (
        <div class="nota">Nenhum combo a uma carta de fechar — pelo menos entre os que o Spellbook conhece.</div>
      ) : (
        <>
          {/* Só os primeiros: a lista de "quase lá" de um deck grande passa de
              100 e viraria rolagem infinita numa coluna estreita. */}
          {near.slice(0, NEAR_COMBOS_SHOWN).map((c) => <ComboCard combo={c} suggestion />)}
          {near.length > NEAR_COMBOS_SHOWN && (
            <div class="nota">E mais {near.length - NEAR_COMBOS_SHOWN} — as mais populares aparecem primeiro.</div>
          )}
        </>
      )}
    </>
  );
}

/** Os números nas abas: vazio antes da primeira busca. */
export function CombosTabCount({ list }: { list: "no_deck" | "faltando_uma" }) {
  const state = useDeck();
  const data: CombosResponse | null = state.combos as any;
  return <>{data ? (data[list] || []).length : ""}</>;
}
