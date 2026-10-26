/* Os três passos do pedido: o XML (ou o deck do deckbuilder), o nome e a
   laminação — mais o erro ou a dica do que falta. No deck com cartas foil, o
   passo 3 vira dois blocos: o do resto, que se escolhe aqui, e o do foil,
   que já veio escolhido do deckbuilder. */
import { useQuery } from "@tanstack/preact-query";
import { useEffect, useState } from "preact/hooks";
import { deckOrderQuery, type DeckOrder } from "./queries";
import { reason } from "./Summary";
import {
  commander, customerName, deckId, deckVersion, failXml, foilPart, ignoreFoil, lamination, loadFoilPart,
  loadXml, prices, summary, wholeXml,
} from "./store";
import { brl, cardsPerPage, LAMINATION_LABELS, type Lamination } from "./totals";

export function OrderForm() {
  const s = summary.value;
  return (
    <>
      <div class="step">
        <span class="step-label">Passo 1</span>
        <h3>{deckId.value ? "Seu deck" : "Selecione o XML do MPC Fill"}</h3>
        {deckId.value ? <DeckFromBuilder id={deckId.value} version={deckVersion.value} /> : <XmlUpload />}
      </div>

      <div class="step">
        <span class="step-label">Passo 2</span>
        <h3>Seu nome</h3>
        <input type="text" maxLength={30} placeholder="Como você quer se identificar no pedido"
               aria-label="Seu nome" value={customerName.value}
               onInput={(e) => { customerName.value = e.currentTarget.value; }}
               style={{ width: "100%", background: "var(--surface-2)", border: "1px solid var(--border)",
                        borderRadius: "8px", color: "var(--text)", padding: "11px 12px",
                        fontFamily: "'Inter',sans-serif", fontSize: "14px" }} />
      </div>

      <div class="step">
        <span class="step-label">Passo 3</span>
        <h3>Tipo de laminação</h3>
        {foilPart.value ? <MixedLamination /> : <LaminationOptions options={["single", "double", "foil"]} />}
        {ignoreFoil.value && (
          <p class="lam-nota">As marcas de foil do deckbuilder estão sendo ignoradas.{" "}
            <button type="button" class="link-btn" onClick={() => { ignoreFoil.value = false; }}>
              Voltar a separar o foil</button></p>
        )}
      </div>

      <div class={"error" + (s.kind === "error" ? " show" : "")} role={s.kind === "error" ? "alert" : undefined}>
        {s.kind === "error" ? s.message : ""}</div>
      <div class={"hint" + (s.kind === "hint" ? "" : " hide")}>{s.kind === "hint" ? s.message : ""}</div>
    </>
  );
}

function LaminationOptions({ options }: { options: Lamination[] }) {
  return (
    <div class="lam-options">
      {options.map((lam) => (
        <label class={"lam-opt" + (lamination.value === lam ? " active" : "")}>
          <input type="radio" name="lam" value={lam} checked={lamination.value === lam}
                 onChange={() => { lamination.value = lam; }} />
          <div class="t">{LAMINATION_LABELS[lam]}</div>
          <div class="p">R$ {brl(prices.value[lam])} / pág · {cardsPerPage(lam)} cartas</div>
        </label>
      ))}
    </div>
  );
}

/* O pedido misto: o resto escolhe entre um e dois lados — foil ele não é,
   senão seria um pedido só —, e o foil aparece como está, com o caminho de
   volta pro deckbuilder pra quem quer mudar quais cartas são. */
function MixedLamination() {
  const fp = foilPart.value!;
  const s = summary.value;
  const standard = s.kind === "ok" ? s.qty : null;
  return (
    <div class="lam-misto">
      <div class="lam-bloco">
        <div class="lam-bloco-tit">Cartas padrão{standard != null && <> · <b>{standard}</b></>}</div>
        <LaminationOptions options={["double", "single"]} />
      </div>
      <div class="lam-bloco foil">
        <div class="lam-bloco-tit"><span class="foil-cor">✦</span> Cartas foil · <b>{fp.qty}</b></div>
        <p class="lam-bloco-txt">Foil · {cardsPerPage("foil")} cartas deitadas por folha ·
          R$ {brl(prices.value.foil)} / pág</p>
        <p class="lam-bloco-txt sub">Escolhidas no deckbuilder.{" "}
          <a href={`/deckbuilder?deck=${encodeURIComponent(deckId.value)}`}>Alterar</a></p>
      </div>
      <p class="lam-nota">A laminação é da folha inteira, então o foil sai num pedido à parte —
        pago no mesmo Pix.{" "}
        <button type="button" class="link-btn" onClick={() => { ignoreFoil.value = true; }}>
          Imprimir tudo no padrão</button></p>
    </div>
  );
}

function XmlUpload() {
  const [fileName, setFileName] = useState("Nenhum arquivo selecionado");
  function pick(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    // Lê uma vez por arquivo — o recálculo a cada tecla usa o que já leu.
    reader.onload = () => loadXml(String(reader.result || "").trim());
    reader.onerror = () => failXml("Não consegui ler esse arquivo. Tenta selecionar de novo.");
    reader.readAsText(file);
  }
  return (
    <div class="file-row">
      <label class="filebtn" for="fileInput">Selecionar arquivo .xml</label>
      <input type="file" id="fileInput" accept=".xml,text/xml" onChange={pick} />
      <span class="file-name">{fileName}</span>
    </div>
  );
}

/* O pedido do deck na tela. Com cartas foil, o que se revisa e cobra como
   "o pedido" é o padrão, e o foil vai à parte (`foilPart`); com tudo no
   foil, é um pedido só, em foil. `ignore` é o "imprimir tudo no padrão". */
export function loadDeckOrder(data: DeckOrder, ignore: boolean) {
  const split = !ignore && !!data.xml_foil;
  if (split && data.xml_padrao) {
    loadXml(data.xml_padrao);
    loadFoilPart(data.xml_foil!);
    wholeXml.value = data.xml!;
    if (lamination.value === "foil") lamination.value = "double";
  } else if (split) {
    loadXml(data.xml_foil!);
    loadFoilPart(null);
    wholeXml.value = "";
    lamination.value = "foil";
  } else {
    loadXml(data.xml!);
    loadFoilPart(null);
    wholeXml.value = "";
    // Voltar do "tudo foil" pro padrão não pode deixar o foil escolhido.
    if (ignore && lamination.value === "foil") lamination.value = "double";
  }
}

/* O verso aparece como verso: numa carta de duas faces a frente pode estar
   escolhida e ele não. E o token como token, que ele não é carta do deck. */
export function missingArts(missing: DeckOrder["faltando"]) {
  const SHOW = 5;
  const names = missing.map((f) => f.nome + [f.ficha ? "token" : "", f.face === "verso" ? "verso" : ""]
    .filter(Boolean).map((x) => ` (${x})`).join(""));
  return names.length > SHOW
    ? names.slice(0, SHOW).join(", ") + ` e mais ${names.length - SHOW}`
    : names.join(", ");
}

/* O "Gerar pedido" do deckbuilder chega aqui com `?deck=<id>`. O servidor
   monta o XML com as artes escolhidas lá, e ele entra no MESMO lugar do XML
   subido: revisão, cobrança e cotação seguem sem saber de onde ele veio.

   O deckbuilder só oferece o link com todas as artes escolhidas. A
   conferência daqui é a garantia: o deck pode ter mudado noutra aba, ou o
   link ter sido colado à mão. Faltando arte o servidor não devolve XML.

   Com `version` (o "Gerar pedido" de uma versão do histórico), o XML leva
   só as cartas que entraram naquela versão — quem já imprimiu a anterior
   não paga de novo pelo resto. */
function DeckFromBuilder({ id, version }: { id: string; version: string }) {
  const q = useQuery(deckOrderQuery(id, version));

  useEffect(() => {
    if (q.error) {
      failXml(reason(q.error) || "Não consegui abrir esse deck agora. Tente de novo em instantes.");
    } else if (q.data && !q.data.xml) {
      failXml(`${version ? `As cartas da v${version} ainda não viram` : "Este deck ainda não vira"} pedido: faltam ${q.data.faltando.length} arte(s) — `
        + `${missingArts(q.data.faltando)}. A arte padrão não vai pro papel; escolha as que `
        + `faltam na aba Artes do deckbuilder.`);
    } else if (q.data?.xml) {
      loadDeckOrder(q.data, ignoreFoil.value);
      // A cotação já sabe quem é o comandante: é o do deck.
      const cmd = q.data.deck.comandantes?.[0];
      if (cmd) commander.value = cmd;
    }
  }, [q.data, q.error, ignoreFoil.value]);

  // A saída pro upload fica sempre à vista: quem chegou pelo link e prefere
  // o XML do MPC Fill não pode ficar preso aqui.
  const links = (label: string) => (
    <div class="deck-links">
      <a href={`/deckbuilder?deck=${encodeURIComponent(id)}`}>{label}</a>
      {version && <a href={`/pedido?deck=${encodeURIComponent(id)}`}>Pedir o deck inteiro</a>}
      <a href="/pedido">Enviar um XML em vez disso</a>
    </div>
  );

  if (q.isPending) return <div class="deck-pedido"><p class="deck-nota">Carregando o deck…</p></div>;
  if (q.error) return <div class="deck-pedido">{links("Abrir no deckbuilder")}</div>;
  const d = q.data!.deck;
  return (
    <div class="deck-pedido">
      <div class="deck-cartao">
        <div class="deck-capa">
          {d.arte
            ? <img src={d.arte} alt="" loading="lazy" referrerpolicy="no-referrer" />
            : <span class="semarte">{d.comandantes.length ? "arte não está na base local" : "sem comandante escolhido"}</span>}
        </div>
        <div class="deck-miolo">
          <h4>{d.nome}</h4>
          <div class="deck-cmd">{d.comandantes.length ? d.comandantes.join(" + ") : "Sem comandante"}</div>
          <div class="deck-info">
            <span class="deck-cores">{(d.identidade || "C").split("").map((c) => <span class={`deck-pip ${c}`} />)}</span>
            <span class="n">{d.total}/100</span>
          </div>
          {q.data!.versao != null && (
            <p class="deck-nota">Só o que entrou na v{q.data!.versao}: {q.data!.cartas} carta(s).</p>
          )}
          {!!q.data!.cartas_foil && !ignoreFoil.value && (
            <p class="deck-nota deck-divisao"><b>{q.data!.cartas_padrao}</b> padrão ·{" "}
              <b class="foil-cor">✦ {q.data!.cartas_foil}</b> foil</p>
          )}
        </div>
      </div>
      {links(q.data!.xml ? "Abrir no deckbuilder" : "Escolher as artes no deckbuilder")}
    </div>
  );
}
