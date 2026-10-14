/* O recado de uma importação (ver `importSummary`): o que veio, e o que
   precisa ser dito sobre o que NÃO veio. Mora na gaveta de importar e no
   bloco do deck médio. */
import { importSummary, type ImportNotice as Notice } from "../importExport";

export function ImportNotice({ notice, children }: { notice: Notice; children?: preact.ComponentChildren }) {
  if (!notice) return null;
  if ("note" in notice) return <div class="nota">{notice.note}</div>;
  if ("error" in notice) return <div class="aponta erro"><span>{notice.error}</span></div>;
  const s = importSummary(notice.imported);
  return (
    <>
      <div class="aponta ok">
        <span><b>{s.total} carta(s)</b> vieram do {s.source}{s.commanders && ` — comandante: ${s.commanders}`}.</span>
      </div>
      {/* O que foi pro maybeboard e pro sideboard precisa ser dito: são
          cartas que não vão aparecer na contagem das 100, e sem esse aviso
          a pessoa confere o contador e acha que a importação perdeu 20. */}
      {(s.maybe > 0 || s.side > 0) && (
        <div class="aponta aviso" style={{ marginTop: "6px" }}>
          <span>
            {s.maybe > 0 && <><b>{s.maybe}</b> no maybeboard</>}
            {s.maybe > 0 && s.side > 0 && " e "}
            {s.side > 0 && <><b>{s.side}</b> no sideboard</>}
            {" "}— fora da contagem das 100. O maybeboard também fica fora da cotação; o sideboard, não.
          </span>
        </div>
      )}
      {/* Carta que a base local não conhece não pode sumir calada: quem
          importa 100 cartas e recebe 97 precisa saber QUAIS três ficaram de
          fora, senão descobre na hora de imprimir. */}
      {s.missing.length > 0 && (
        <div class="aponta aviso" style={{ marginTop: "6px" }}>
          <span><b>{s.missing.length} não estão na base local</b> e ficaram de fora: {s.missing.join(", ")}.<br />
            Costuma ser carta nova com a base atrasada — dá pra adicionar na mão pela busca depois que ela
            sincronizar.</span>
        </div>
      )}
      {s.noCommander && (
        <div class="aponta aviso" style={{ marginTop: "6px" }}>
          <span>A lista não dizia quem é o comandante. Escolha ele na tela — é ele que define a identidade de cor
            de tudo.</span>
        </div>
      )}
      {children}
    </>
  );
}
