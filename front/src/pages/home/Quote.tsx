/* A cotação de preços das cartas.

   Fica atrás de um botão, e nunca dispara sozinha ao subir o XML, porque
   cada cotação faz uma requisição por carta na LigaMagic — um deck grande
   vira dezenas de acessos. Quem só quer orçar a impressão não paga esse
   custo, e o site não leva tranco de quem nem pediu cotação. */
import { useMutation, useQuery } from "@tanstack/preact-query";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiError } from "../../shared/api";
import { copyText } from "../../shared/clipboard";
import { quoteView, VISIBLE, DISCREPANCY, type QuoteResult, type Row } from "./quote";
import { quoteJobQuery, type QuoteJob } from "./queries";
import {
  commander, commanderOptions, effectiveCommander, loadedSignature, quote, quoteCurrent, xmlText,
} from "./store";
import { useFlash } from "./useFlash";

const LABEL = "Cotar preços das cartas";
const detailOf = (e: unknown) => e instanceof ApiError ? e.detail : (e as Error)?.message || "";

function form(xml: string, cmd: string) {
  const f = new FormData();
  f.append("xml_file", new Blob([xml], { type: "text/xml" }), "deck.xml");
  f.append("commander", cmd);
  return f;
}

/** O seletor do comandante e o botão, que moram junto das ações do pedido. */
export function QuoteControls({ start }: { start: ReturnType<typeof useStartQuote> }) {
  const busy = start.isPending || (!!quoteCurrent.value?.jobId && !quoteCurrent.value.result && !quoteCurrent.value.error);
  return (
    <>
      <div class="cot-cmd">
        <label for="cmdSelect">Comandante (opcional — não conta no teto do Commander 500)</label>
        {/* Trocar o comandante muda o que entra na conta, então a cotação que
            está na tela deixa de valer na hora. */}
        <select id="cmdSelect" value={effectiveCommander.value}
                onChange={(e) => { commander.value = e.currentTarget.value; }}>
          <option value="">— nenhum —</option>
          {commanderOptions.value.map((n) => <option value={n}>{n}</option>)}
        </select>
      </div>
      <button class="cot-btn" disabled={busy} onClick={() => start.mutate()}>
        {busy ? "Cotando…" : LABEL}
      </button>
    </>
  );
}

export function useStartQuote() {
  return useMutation({
    mutationFn: async () => {
      const signature = loadedSignature.value, cmd = effectiveCommander.value;
      quote.value = { signature, commander: cmd };
      try {
        const data = await api<QuoteJob>("/cotacao", { body: form(xmlText.value, cmd) });
        // Um resultado ainda fresco volta pronto na hora: o backend reaproveita
        // a cotação do mesmo deck em vez de varrer tudo de novo.
        quote.value = data.estado === "pronto"
          ? { signature, commander: cmd, result: data.resultado }
          : { signature, commander: cmd, jobId: data.job_id };
      } catch (e) {
        const d = detailOf(e);
        quote.value = { signature, commander: cmd, error: `Não consegui começar a cotação${d ? ": " + d : ""}.` };
      }
    },
  });
}

/** O status, a barra e o resultado, embaixo das ações. */
export function QuoteBox({ starting }: { starting: boolean }) {
  const q = quoteCurrent.value;
  const polling = !!q?.jobId && !q.result && !q.error;
  const job = useQuery({ ...quoteJobQuery(q?.jobId ?? ""), enabled: polling });

  useEffect(() => {
    if (!polling || !q) return;
    if (job.data?.estado === "pronto") {
      quote.value = { ...q, result: job.data.resultado };
    } else if (job.data?.estado === "erro") {
      quote.value = { ...q, error: `Não consegui cotar: ${job.data.detalhe ?? ""}` };
    } else if (job.error) {
      const d = detailOf(job.error);
      quote.value = { ...q, error: `Perdi o contato com a cotação${d ? ": " + d : ""}. Tente de novo.` };
    }
  }, [job.data, job.error]);

  if (!q && !starting) return <div id="cotBox" />;
  const progress = job.data?.estado === "cotando" ? job.data : null;
  const pct = progress?.total ? Math.round(100 * (progress.feitas ?? 0) / progress.total) : 0;

  return (
    <div id="cotBox" class="show">
      <div class="cot-status">
        {q?.error ? <span class="aviso">{q.error}</span>
          : progress ? `Consultando ${progress.cartas} carta(s)… ${progress.feitas} de ${progress.total} `
                       + `consultas (${progress.decorrido}s). Pode deixar a página aberta.`
          : (starting || polling) ? "Começando…" : ""}
      </div>
      {(starting || polling) && <div class="cot-bar"><i style={{ width: pct + "%" }} /></div>}
      {q?.result != null && <QuoteResultView result={q.result as QuoteResult} />}
    </div>
  );
}

function CopyListButton({ list }: { list: string }) {
  // O rótulo vira o aviso por um instante e volta: é o único retorno que
  // existe pro Ctrl+V que ainda não aconteceu.
  const [text, flash] = useFlash("Copiar lista");
  return (
    <button class="cot-copiar" onClick={async () => {
      const n = list ? list.split("\n").length : 0;
      flash(!list ? "Nada pra copiar" : (await copyText(list)) ? `Copiado! ${n} carta(s)` : "Não deu pra copiar");
    }}>{text}</button>
  );
}

function QuoteRow({ row }: { row: Row }) {
  return (
    <tr class={row.found ? "" : "faltou"}>
      <td class="carta">{row.name}</td>
      <td class="num">{row.qty}x</td>
      {row.cells.map((c) => c.error
        ? <td class="num"><span class="aviso">—</span></td>
        : (
          // Mostra o unitário: o que interessa comparar entre as fontes é o
          // preço da carta, não o produto.
          <td class="num">{c.price}
            {c.lowStock && <> <span class="aviso" title="a loja não tem todas as cópias">!</span></>}
            {c.pricey && <> <span class="caro" title={c.pricey.title}>▲ {c.pricey.pct}%</span></>}
            <span class="loja">{c.store}</span>
          </td>
        ))}
    </tr>
  );
}

function QuoteResultView({ result }: { result: QuoteResult }) {
  const v = useMemo(() => quoteView(result), [result]);
  // Fechada e aberta são listas com ORDENS diferentes (preço puro x agrupada
  // por tipo), não a mesma lista com um pedaço escondido.
  const [open, setOpen] = useState(false);
  const columns = 2 + v.sourceLabels.length;

  return (
    <div>
      <div class="cot-fontes">
        {v.boxes.map((b) => (
          <div class={"cot-fonte" + (b.theoretical ? " teorico" : "")}>
            <h4>{b.title}</h4>
            <div class="v">{b.total}</div>
            <div class="obs">{b.note}</div>
            <CopyListButton list={b.list} />
          </div>
        ))}
      </div>
      <div class="cot-tabela-wrap">
        <table class="cot">
          <thead><tr><th>Carta</th><th>Qtd</th>{v.sourceLabels.map((l) => <th>{l}</th>)}</tr></thead>
          <tbody>
            {!open ? v.top.map((r) => <QuoteRow row={r} />)
              : v.groups ? v.groups.map((g) => (
                  <>
                    <tr class="grupo"><td colSpan={columns}>{g.name}{" "}
                      <span class="qtd">· {g.cards} carta(s), {g.copies} cópia(s)</span></td></tr>
                    {g.rows.map((r) => <QuoteRow row={r} />)}
                  </>
                ))
              : v.all!.map((r) => <QuoteRow row={r} />)}
          </tbody>
        </table>
      </div>
      {v.hidden > 0 && (
        <button class="cot-mais" onClick={() => setOpen(!open)}>
          {open ? `Ver só as ${VISIBLE} mais caras`
            : v.groups ? `Ver as ${v.total} cartas agrupadas por tipo` : `Ver mais ${v.hidden} carta(s)`}
        </button>
      )}
      {v.excluded && (
        <div class="cot-fora"><b>Fora da cotação:</b> {v.excluded.parts.join(" e ")}. É como o
          Commander 500 conta: o teto de preço vale para o deck sem o comandante e sem
          os terrenos básicos.{v.excluded.hasToken && " Token vai pro papel, mas não é carta que se compra."}</div>
      )}
      {v.priceyNote && (
        <p class="note">
          O <span class="caro">▲</span> marca a carta que está mais de {Math.round(DISCREPANCY * 100)}% acima
          do preço da {v.priceyNote.refLabel}{v.priceyNote.conversion}. Serve pra comparar ordem de
          grandeza: o preço de fora não inclui frete, imposto nem IOF.
        </p>
      )}
      <p class="note">
        Cada total é a soma da oferta mais barata de cada carta na fonte correspondente
        e <b>não inclui frete</b> — as cartas podem vir de lojas diferentes, cada uma com
        o seu. Os totais das fontes são de mercados e moedas diferentes: dá pra comparar
        e ter uma ideia geral. Já o menor custo teórico não é um total que dê pra pagar
        em lugar nenhum: ele mistura as duas pontas, carta a carta, pra mostrar o piso
        da lista. O botão de cada caixa copia a lista com o preço daquela caixa, uma
        carta por linha.
      </p>
    </div>
  );
}
