/* As sugestões do EDHREC (a lógica é `suggestions.ts`).

   A aba responde a DUAS perguntas com a mesma lista. A padrão é a do
   comandante ("o que combina com ele?"); a estrela de cada linha do deck
   troca pra outra ("já que o deck tem esta carta, o que mais entra?"). São
   listas parecidas o bastante pra se confundirem, e nenhuma carta listada
   denuncia de qual das duas veio — por isso o cabeçalho diz por extenso. */
import { cardPrice } from "../price";
import {
  addSuggestion, averageDeck, importAverageDeck, loadSuggestions, setAverageDeck, type Suggestion, type SuggestionsResponse,
} from "../suggestions";
import { ImportNotice } from "./ImportNotice";
import { ManaCost } from "./Mana";
import { previewProps } from "./preview";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* A partir de quanto a sinergia é notável — e não é o mesmo número nas duas
   listas. O comandante compara contra os OUTROS comandantes, um universo
   estreito, e 25 pontos ali já é muito. A carta compara contra o formato
   inteiro, e ali aparecer três vezes mais que a média é rotina. */
function Synergy({ item, fromCard, target }: { item: Suggestion; fromCard: boolean; target: string }) {
  const sin = item.sinergia;
  if (sin === null || sin === undefined) return null;
  const high = fromCard ? 100 : 25;
  const title = `Aparece ${sin > 0 ? sin + " pontos a mais" : Math.abs(sin) + " pontos a menos"} ` +
    (fromCard ? `junto de ${target} do que num deck qualquer` : "com este comandante do que com os outros") +
    (item.porcento ? ` · está em ${item.porcento}% ` + (fromCard ? "dos decks que a jogam" : "dos decks dele") : "");
  return <span class={"sinergia" + (sin >= high ? " alta" : "")} title={title}>{sin > 0 ? "+" : ""}{sin}%</span>;
}

export function SuggestionsPanel() {
  const state = useDeck();
  if (state.suggestionsLoading) return <div class="nota">Perguntando ao EDHREC sobre {state.suggestionsTarget}…</div>;
  if (state.suggestionsError) return <div class="aponta erro"><span>{state.suggestionsError}</span></div>;
  const s: SuggestionsResponse | null = state.suggestions;
  if (!s) return null;

  const fromCard = s.alvo?.tipo === "carta";
  // O nome do comandante sai do estado, e não do `alvo` que veio junto: com
  // uma dupla de parceiros o servidor manda os dois separados por vírgula, e
  // "Muldrotha, the Gravetide" já tem vírgula dentro. A tela junta com "e".
  const target = fromCard ? (s.alvo!.nome || "") : state.commanders.map((c) => c.nome).join(" e ");
  return (
    <>
      <div class="sug-alvo">
        <SpriteIcon name="sparkle" />
        <span class="quem">{fromCard ? "A partir da carta" : "Para o comandante"} <b>{target}</b></span>
        {/* Voltar ao comandante é refazer a pergunta padrão, sem tema: o tema
            que existia antes da carta é escolha de outro momento. */}
        {fromCard && (
          <button class="voltar" title="Voltar a sugerir a partir do comandante" onClick={() => loadSuggestions()}>
            <SpriteIcon name="arrow-counter-clockwise" />Comandante</button>
        )}
      </div>
      {!!s.temas?.length && (
        <div class="temas">
          <button class={"chip" + (!state.suggestionsTheme ? " ativo" : "")} onClick={() => loadSuggestions({ theme: "" })}>Tudo</button>
          {s.temas.slice(0, 14).map((t) => (
            <button class={"chip" + (state.suggestionsTheme === t.slug ? " ativo" : "")}
                    title={t.decks ? `${t.decks} decks` : ""} onClick={() => loadSuggestions({ theme: t.slug })}>{t.nome}</button>
          ))}
        </div>
      )}
      {!s.listas.length && (
        <div class="vazio">O EDHREC não trouxe nada que este deck ainda não tenha
          {fromCard ? " e que caiba na identidade de cor dele" : ""}. Se ele está quase completo, isso é bom sinal.</div>
      )}
      {s.listas.map((list) => (
        <div class="lista-sug">
          <h3>{list.titulo}</h3>
          {/* Preço na mesma posição da linha da busca: as duas abas mostram
              carta pra adicionar, e "quanto custa" é parte da escolha. */}
          {list.cartas.map((item) => (
            <button class="achado" {...previewProps(item.carta)} onClick={() => addSuggestion(item.carta)}>
              <span class="nome"><b>{item.carta.nome}</b><small>{item.carta.tipo}</small></span>
              <ManaCost cost={item.carta.mana_cost} />
              <span class="preco">{cardPrice(item.carta)}</span>
              <Synergy item={item} fromCard={fromCard} target={target} />
            </button>
          ))}
        </div>
      ))}
      <div class="fonte-edhrec">Dados da <a href={s.link} target="_blank" rel="noopener">página{" "}
        {fromCard ? "de " + target : "do comandante"} no EDHREC</a>{s.cache ? ", de uma consulta recente" : ""}.
        São números de decks registrados lá — não são regra, são o que a maioria faz.</div>
    </>
  );
}

const BRACKETS: [string, string][] = [
  ["", "Qualquer"], ["exhibition", "1 · Exibição"], ["core", "2 · Núcleo"], ["upgraded", "3 · Turbinado"],
  ["optimized", "4 · Otimizado"], ["cedh", "5 · cEDH"],
];
const BUDGETS: [string, string][] = [["", "Qualquer"], ["budget", "Econômico"], ["expensive", "Caro"]];

/* O deck médio fica acima da lista porque é o gesto de quem ainda não tem
   deck, e é quem mais abre esta aba com o deck vazio. Veste a caixa do "Vai
   para": são escolhas feitas uma vez antes do clique, do mesmo jeito. */
export function AverageDeck() {
  const a = averageDeck.value;
  const imported = a.notice && "imported" in a.notice ? a.notice.imported : null;
  return (
    <div class="destino deck-medio">
      <div class="destino-linha">
        <span class="deck-medio-titulo">Deck médio do EDHREC</span>
        <button type="button" class="btn ouro" id="btn-deck-medio" disabled={a.running} onClick={importAverageDeck}
                title="Trocar as cartas do deck pela média dos decks registrados no EDHREC com este comandante">
          Importar</button>
      </div>
      <div class="destino-linha">
        <span class="destino-rot">Bracket</span>
        <select class="campo" id="dm-bracket" aria-label="Bracket dos decks que entram na média" value={a.bracket}
                onChange={(e) => setAverageDeck({ bracket: e.currentTarget.value })}>
          {BRACKETS.map(([v, label]) => <option value={v}>{label}</option>)}
        </select>
      </div>
      <div class="destino-linha">
        <span class="destino-rot">Orçamento</span>
        <div class="segmento" id="seg-orcamento-medio">
          {BUDGETS.map(([v, label]) => (
            <button type="button" data-orcamento={v} class={a.budget === v ? "ativa" : undefined}
                    onClick={() => setAverageDeck({ budget: v })}>{label}</button>
          ))}
        </div>
      </div>
      <div id="dm-resultado">
        <ImportNotice notice={a.notice}>
          {/* Quantos decks entraram na média muda como ler a lista: a de doze
              decks é o gosto de doze pessoas, a de quarenta mil é o formato
              falando. */}
          {imported && (
            <div class="fonte-edhrec">Média de {imported.decks
              ? <b>{imported.decks.toLocaleString("pt-BR")}</b> : "todos os"} decks registrados na{" "}
              <a href={imported.link} target="_blank" rel="noopener">página do deck médio no EDHREC</a>.</div>
          )}
        </ImportNotice>
      </div>
    </div>
  );
}
