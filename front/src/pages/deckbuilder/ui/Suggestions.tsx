/* As sugestões do EDHREC (a lógica é `suggestions.ts`).

   A aba responde a DUAS perguntas com a mesma lista. A padrão é a do
   comandante ("o que combina com ele?"); a estrela de cada linha do deck
   troca pra outra ("já que o deck tem esta carta, o que mais entra?"). São
   listas parecidas o bastante pra se confundirem, e nenhuma carta listada
   denuncia de qual das duas veio — por isso o cabeçalho diz por extenso. */
import { cardPrice } from "../price";
import { addSuggestion, loadSuggestions, type Suggestion, type SuggestionsResponse } from "../suggestions";
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
  if (state.sugestoesRodando) return <div class="nota">Perguntando ao EDHREC sobre {state.sugestoesAlvo}…</div>;
  if (state.sugestoesErro) return <div class="aponta erro"><span>{state.sugestoesErro}</span></div>;
  const s: SuggestionsResponse | null = state.sugestoes;
  if (!s) return null;

  const fromCard = s.alvo?.tipo === "carta";
  // O nome do comandante sai do estado, e não do `alvo` que veio junto: com
  // uma dupla de parceiros o servidor manda os dois separados por vírgula, e
  // "Muldrotha, the Gravetide" já tem vírgula dentro. A tela junta com "e".
  const target = fromCard ? (s.alvo!.nome || "") : state.comandantes.map((c) => c.nome).join(" e ");
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
          <button class={"chip" + (!state.sugestoesTema ? " ativo" : "")} onClick={() => loadSuggestions({ theme: "" })}>Tudo</button>
          {s.temas.slice(0, 14).map((t) => (
            <button class={"chip" + (state.sugestoesTema === t.slug ? " ativo" : "")}
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
