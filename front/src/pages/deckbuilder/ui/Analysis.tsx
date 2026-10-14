/* A aba de análise e os avisos que ela empresta pra lista e pra lateral.
   As contas moram em `analysis.ts`, `odds.ts` e `power.ts`. */
import { colorDemand, groupIssues, isCountIssue, manaCurve, typeCounts, type Issue } from "../analysis";
import { assinaturaDoDeck } from "../combos.js";
import { deckIdentity, totalCards } from "../deck";
import { oddsView, percent, SEEN_BY_T4 } from "../odds";
import { BRACKETS, estimatePower, type PowerResult } from "../power";
import { validacaoAtual } from "../salvar.js";
import { COLOR_NAMES } from "../state";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

const Empty = ({ children }: { children: preact.ComponentChildren }) =>
  <div class="vazio" style={{ padding: "8px 0" }}>{children}</div>;

/** As bolinhas de uma identidade de cor ("WUBG"). */
export function ManaPips({ identity }: { identity: string }) {
  return (
    <span class="mana" title={identity.split("").map((c) => COLOR_NAMES[c]).join(", ")}>
      {identity.split("").map((c) => <span class={`pip ${c}`} />)}
    </span>
  );
}

function IssueLine({ issue, cls, style }: { issue: ReturnType<typeof groupIssues>[number]; cls: string; style?: string }) {
  return (
    <div class={`aponta ${cls}`} style={style}>
      <span>{issue.title && <><b>{issue.title}</b> — </>}{issue.text}</span>
    </div>
  );
}

/* Os erros de verdade, em cima da lista. Agrupado por tipo, como na aba: um
   erro por carta vira ruído numa lista de 99. O "faltam N" não entra: é o
   estado normal de quem está montando, e mora na aba. */
export function DeckAlerts() {
  useDeck();
  const issues: Issue[] = validacaoAtual().apontamentos || [];
  const serious = issues.filter((a) => a.nivel === "erro" && !isCountIssue(a));
  return <>{groupIssues(serious).map((g) => <IssueLine issue={g} cls="erro" style="margin-bottom:8px" />)}</>;
}

export function Issues() {
  const state = useDeck();
  const v = validacaoAtual();
  if (!state.comandantes.length) return <Empty>Escolha o comandante pra análise começar.</Empty>;
  if (v.ok) {
    return (
      <div class="aponta ok"><SpriteIcon name="check" /> Deck legal: 100 cartas, singleton respeitado e tudo
        dentro da identidade {v.identidade ? <ManaPips identity={v.identidade} /> : "incolor"}.</div>
    );
  }
  // "Faltam 43 cartas" sai da lista de erros e vira barra de progresso: é o
  // estado normal de quem está montando, e pintá-lo de vermelho junto com
  // uma carta banida ensinaria a ignorar os dois.
  const issues: Issue[] = v.apontamentos || [];
  const counting = issues.some(isCountIssue);
  return (
    <>
      {counting && (
        <div class="progresso">
          <div class="texto"><span>{v.total > 100 ? "Passou das 100" : "Montando o deck"}</span>
            <b>{v.total}/100</b></div>
          <span class="trilho"><span class="cheio" style={{ width: `${Math.min(100, v.total)}%` }} /></span>
        </div>
      )}
      {groupIssues(issues.filter((a) => !isCountIssue(a))).map((g) => <IssueLine issue={g} cls={g.level} />)}
    </>
  );
}

/** A curva de mana, de 0 a 7+ (na lateral do maybeboard). */
export function Curve() {
  useDeck();
  const counts = manaCurve();
  const max = Math.max(1, ...counts);
  return (
    <>
      {counts.map((n, cmc) => {
        const label = `${cmc}${cmc === 7 ? "+" : ""}`;
        return (
          <div class="barra" title={`${n} carta(s) com custo ${label}`}>
            <span class="qt">{n || ""}</span>
            <div class="haste" style={{ height: `${(n / max) * 100}%` }} />
            <span class="cmc">{label}</span>
          </div>
        );
      })}
    </>
  );
}

export function ColorDistribution() {
  useDeck();
  const rows = colorDemand();
  if (!rows.length) return <Empty>Sem cartas ainda.</Empty>;
  return (
    <>
      {rows.map((r) => (
        <div class="item">
          <span class={`pip ${r.color}`} />
          <span style={{ width: "56px" }}>{COLOR_NAMES[r.color]}</span>
          <span class="trilho"><span class="cheio" style={{ width: `${r.share * 100}%`, background: `var(--mana-${r.color})` }} /></span>
          <span class="num">{r.count}</span>
        </div>
      ))}
    </>
  );
}

export function TypeDistribution() {
  useDeck();
  const rows = typeCounts();
  if (!rows.length) return <Empty>Sem cartas ainda.</Empty>;
  return (
    <>
      {rows.map((r) => (
        <div class="item">
          <span style={{ width: "70px" }}>{r.category}</span>
          <span class="trilho"><span class="cheio" style={{ width: `${r.share * 100}%`, background: "var(--purple)" }} /></span>
          <span class="num">{r.count}</span>
        </div>
      ))}
    </>
  );
}

export function Odds() {
  useDeck();
  const o = oddsView();
  if (!o.rows) return <Empty>Com menos de {SEEN_BY_T4} cartas na lista ainda não há compra pra calcular.</Empty>;
  const risk = (name: string, r: NonNullable<typeof o.shortage>, why: string) => (
    <div class={`risco ${r.level}`}>
      <span class="rot">{name}</span>
      <span class="val">{percent(r.value)}</span>
      <span class="porque"><span class="estado">{r.label}</span> — {why}</span>
    </div>
  );
  return (
    <>
      <table class="chances">
        <thead><tr>
          <th>Chance de ver 1</th>
          <th title="Na mão inicial de 7 cartas">Mão de 7</th>
          <th title="Na primeira mão ou na do primeiro mulligan, que no Commander é de graça: sete cartas novas, sem devolver nenhuma pro fundo">Com mulligan</th>
          <th title="Nas 9 cartas vistas até o turno 3, jogando primeiro">Até o T3</th>
        </tr></thead>
        <tbody>
          {o.rows.map((r) => (
            <tr class={r.isCustom ? "propria" : undefined}>
              <td>{r.category} <span class="qt">{r.K}</span></td>
              <td>{percent(r.hand)}</td>
              <td>{percent(r.mulligan)}</td>
              <td>{percent(r.byT3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="risco-duo">
        {risk("Falta de mana", o.shortage!, "chegar ao turno 3 com um terreno ou nenhum, dois drops perdidos.")}
        {risk("Excesso de mana", o.flood!, "ver 6 terrenos ou mais até o turno 4, mana que virou carta morta.")}
      </div>
      <div class="rodape-conta">
        <b>Como a conta é feita.</b> Distribuição hipergeométrica sobre as {o.N} cartas da lista — o
        comandante fica de fora porque começa na zona de comando. Tudo jogando primeiro, sem a compra do
        turno 1, que é o lado pior: <b>Mão de 7</b> é a mão inicial, <b>com mulligan</b> é ver a carta na
        primeira mão ou na do primeiro mulligan — que no Commander é grátis, você devolve as sete, compra
        sete outras e fica com elas — e <b>até o T3</b> são 9 cartas (a mão mais as compras dos turnos 2 e
        3); o excesso de mana olha 10, até o turno 4. As suas categorias vêm em cima, e a mesma carta conta
        na sua categoria e no tipo dela: as linhas não somam 100 porque cada uma responde a uma pergunta
        diferente. Enquanto a lista não fechar em 99, os números saem inflados: menos carta no baralho é
        menos carta pra atrapalhar.
      </div>
    </>
  );
}

/** A nota da busca: o que ela mostra é só o que cabe na identidade. */
export function IdentityNote() {
  const state = useDeck();
  const identity = deckIdentity();
  return (
    <div class="nota" id="nota-identidade" hidden={!state.comandantes.length}>
      {identity
        ? <>Mostrando só o que cabe na identidade <ManaPips identity={identity} /> do comandante.</>
        : "Comandante incolor: só cartas sem cor aparecem na busca."}
    </div>
  );
}

export function Power() {
  const state = useDeck();
  if (state.poderRodando) return <div class="nota">Classificando…</div>;
  if (state.poderErro) return <div class="aponta erro"><span>{state.poderErro}</span></div>;
  const p: PowerResult | null = state.poder;
  if (!p) return null;
  const total = totalCards();
  return (
    <>
      {state.poderAssinatura !== assinaturaDoDeck() && (
        <div class="combo-desatualizado">O deck mudou desde esta estimativa.
          <button class="refazer" onClick={() => estimatePower()}>Atualizar</button></div>
      )}
      {/* Deck pela metade não tem nível: a estimativa só descreve as cartas
          que existem, e dizer "bracket 1" pra um deck de 20 cartas seria
          mentira por omissão. */}
      {total < 100 && (
        <div class="combo-desatualizado">O deck tem {total} de 100 cartas — esta estimativa vale só pelo
          que já está montado.</div>
      )}
      <div class="escala">
        {BRACKETS.map(([n, name, why]) => (
          <div class={`degrau ${p.bracket === n ? "aqui" : ""} ${n === 5 ? "fora" : ""}`} title={`${name} — ${why}`}>
            <span class="n">{n}</span><span class="rot">{name}</span>
          </div>
        ))}
      </div>
      {p.bracket ? (
        <>
          <div class="poder-nome">Bracket {p.bracket} — {p.nome}</div>
          <div class="poder-explica">{p.explicacao}</div>
        </>
      ) : (
        <>
          <div class="poder-nome">Fora do formato</div>
          <div class="poder-explica">Com carta banida o deck não está em bracket nenhum.</div>
        </>
      )}
      {p.motivos.length ? p.motivos.map((m) => (
        <div class={`motivo ${m.nivel === "erro" ? "erro" : ""}`}>
          <b>{m.titulo}</b>
          <div class="porque">{m.detalhe}</div>
          {m.cartas.length > 0 && <div class="quais">{m.cartas.map((c) => <span>{c}</span>)}</div>}
        </div>
      )) : (
        <div class="nota">Nada no deck puxa a nota pra cima: sem game changer, sem combo de duas cartas, sem
          negação de terreno em massa e sem turno extra.</div>
      )}
      {p.cache && <div class="nota" style={{ marginTop: "10px" }}>Resposta guardada de uma estimativa recente
        com este mesmo deck.</div>}
    </>
  );
}
