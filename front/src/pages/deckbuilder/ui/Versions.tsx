/* A pílula da versão (ao lado do nome do deck) e a aba de histórico. A
   lógica é `versions.ts`. */
import { canComplete, completeVersion, openVersionMenu, shortDate, versionOrderHref, versionPillView } from "../versions";
import { previewProps } from "./preview";
import { useDeck } from "./useDeck";

export function VersionPill() {
  useDeck();
  const v = versionPillView();
  return (
    <button class={v.className} id="btn-versao" type="button" aria-haspopup="menu"
            title={v.title} aria-label={v.title} onClick={(e) => openVersionMenu(e.currentTarget)}>{v.text}</button>
  );
}

type Change = { nome: string; zona?: string; quantidade: number; carta?: any };
type Diff = { entraram: Change[]; sairam: Change[]; n_entraram: number; n_sairam: number };

function Balance({ diff: d }: { diff: Diff }) {
  return (
    <span class="hist-saldo" title={`${d.n_entraram} entraram, ${d.n_sairam} saíram`}>
      <span class="entrou">+{d.n_entraram}</span> <span class="saiu">−{d.n_sairam}</span>
    </span>
  );
}

// O deck não leva etiqueta: é onde a carta está quando nada é dito.
const ZONE_LABELS: Record<string, string> = { comandantes: "comandante", side: "sideboard" };

function DiffColumns({ diff: d }: { diff: Diff }) {
  const column = (title: string, lines: Change[], cls: string, sign: string) => (
    <div class={`hist-coluna ${cls}`}>
      <h4>{title}</h4>
      {lines.length ? (
        <ul>{lines.map((c) => (
          <li {...previewProps(c.carta)}>
            <span class="q">{sign}{c.quantidade}</span>
            <span class="nome">{c.nome}</span>
            {ZONE_LABELS[c.zona || ""] && <span class="zona">{ZONE_LABELS[c.zona || ""]}</span>}
          </li>))}</ul>
      ) : <p class="nota">Nenhuma.</p>}
    </div>
  );
  return (
    <div class="hist-diferenca">
      {column("Entraram", d.entraram, "entrou", "+")}
      {column("Saíram", d.sairam, "saiu", "−")}
    </div>
  );
}

/* O pedido de uma versão leva só as cartas que entraram nela (a v0 leva a
   lista inteira). Versão que só tirou carta não tem o que imprimir. */
function VersionOrderLink({ numero, diff }: { numero: number; diff: Diff | null }) {
  const href = versionOrderHref(numero);
  if (!href || (diff && !diff.n_entraram)) return null;
  return (
    <a class="btn" href={href}
       title={diff ? `Pedido só com as ${diff.n_entraram} carta(s) que entraram na v${numero}`
         : `Pedido com a lista inteira da v${numero}`}>Gerar pedido</a>
  );
}

export function History() {
  const state = useDeck();
  const h = state.history;
  if (state.historyError) {
    return <div class="vazio">Não consegui abrir o histórico: {state.historyError}</div>;
  }
  if (!h) return <div class="vazio">Carregando…</div>;
  return (
    <>
      {h.pendente && h.atual != null && (
        <section class="hist-bloco pendente">
          <div class="hist-cab">
            <b>Desde a v{h.atual}</b>
            <Balance diff={h.pendente} />
            <span class="espaco" />
            <button class="btn ouro" type="button" disabled={!canComplete()}
                    onClick={() => completeVersion()}>Concluir v{h.atual + 1}</button>
          </div>
          <DiffColumns diff={h.pendente} />
        </section>
      )}
      <ol class="hist-linha">
        {h.versoes.map((v: any) => (
          <li class="hist-bloco">
            <div class="hist-cab">
              <span class="versao-pilula">v{v.numero}</span>
              <span class="hist-quando">{shortDate(v.criado_em)}</span>
              {v.diferenca ? <Balance diff={v.diferenca} />
                : <span class="hist-saldo">primeira versão · {v.total} cartas</span>}
              <span class="espaco" />
              <VersionOrderLink numero={v.numero} diff={v.diferenca} />
            </div>
            {v.diferenca && <DiffColumns diff={v.diferenca} />}
          </li>
        ))}
      </ol>
    </>
  );
}
