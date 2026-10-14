/* A aba Tokens: as fichas que o deck cria, por carta que cria. Agrupado, e
   não numa lista única: a mesma ficha pedida por duas cartas continua sendo
   duas linhas da conta, porque tirar uma das duas do deck não tira a ficha
   da caixa. */
import type { Token, TokensResponse } from "../tokens";
import { previewProps } from "./preview";
import { useDeck } from "./useDeck";

/* Uma ficha vira uma imagem por FACE. Ficha de duas faces existe (o
   lobisomem que nasce Humano e vira Lobo) e quem vai imprimir ou procurar na
   caixa precisa dos dois lados. Ficha sem corpo (Treasure, Clue, Food) não
   ganha "/" no título, que pareceria dado faltando. */
function TokenImages({ token: t }: { token: Token }) {
  const name = [t.nome, t.tipo].filter(Boolean).join(" — ");
  const body = t.poder && t.resistencia ? ` ${t.poder}/${t.resistencia}` : "";
  return <>{[t.imagem, t.imagem_verso].filter(Boolean).map((url) =>
    <img class="token" loading="lazy" src={url} alt={name} title={name + body} />)}</>;
}

export function TokensPanel() {
  const state = useDeck();
  const data: TokensResponse | null = state.tokens;
  const groups = data?.grupos || [];
  return (
    <>
      {/* A lista está na tela: a explicação do que a aba faz vira ruído
          acima dela. */}
      <p class="nota" id="tokens-nota" hidden={groups.length > 0 && !state.tokensErro}>As fichas que as
        cartas do deck criam, agrupadas por quem as cria.</p>
      <div id="tokens-resultado" style={{ marginTop: "12px" }}>
      {state.tokensErro ? <div class="aponta erro"><span>{state.tokensErro}</span></div>
        : state.tokensRodando ? <div class="nota">Procurando…</div>
        : !data ? null
        : !groups.length ? <div class="nota">Nenhuma carta deste deck cria ficha — não há nada a levar além das cartas.</div>
        : groups.map((g) => (
          <div class="token-grupo">
            <h3><span class="peca" {...previewProps(g as any)}>{g.carta}</span>
              <span class="quantas">{g.tokens.length}</span></h3>
            <div class="token-grade">{g.tokens.map((t) => <TokenImages token={t} />)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

/** O número na aba. Vazio, e não "0": deck que não cria ficha nenhuma não
    tem contagem pra mostrar. */
export function TokensTabCount() {
  const state = useDeck();
  return <>{state.tokens?.total || ""}</>;
}
