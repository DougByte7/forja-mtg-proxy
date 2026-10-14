/* Papel e plástico, com a baixa que os pedidos fazem sozinhos, e o custo de
   material de UMA folha em cada acabamento, ao lado do preço cobrado por
   página. As contas são do backend (`estoque.resumo`); aqui é só desenho. */
import type { useAdminActions } from "./actions";
import { decimal, fineMoney, int, when } from "./format";
import { stockNote } from "./store";
import type { SheetCost, Stock } from "./types";

const REASONS: Record<string, string> = {
  pedido: "Pedido",
  estorno: "Devolvido pelo pedido",
  combinado: "Sobra da folha combinada",
  entrada: "Entrada",
  contagem: "Contagem",
};

export function StockTab({ stock, actions }: { stock: Stock; actions: ReturnType<typeof useAdminActions> }) {
  const act = (action: string, item?: string) => () => actions.stockAction(stock, action, item);
  const finishes = (["single", "double", "foil"] as const).map((l) => stock.custo_folha[l]);
  const cfg = stock.config;
  const row = (label: string, field: keyof SheetCost, cls = "") => (
    <tr class={cls}>
      <td>{label}</td>
      {finishes.map((c) => <td class={c[field] < 0 ? "negativo" : ""}>{fineMoney(c[field])}</td>)}
    </tr>
  );
  const mlTotal = stock.tintas.reduce((n, t) => n + t.ml_por_folha, 0);
  const inkTotal = stock.tintas.reduce((n, t) => n + t.custo_folha, 0);
  const names = Object.fromEntries(stock.itens.map((i) => [i.id, i.nome]));
  const note = stockNote.value;

  return (
    <>
      {note && <div class={"p-nota " + note.kind} style={{ margin: "0 0 10px" }}>{note.text}</div>}

      <div class="estoque-itens">
        {stock.itens.map((item) => (
          <div class={"item-estoque" + (item.baixo ? " baixo" : "")} key={item.id}>
            <div class="nome">{item.nome}</div>
            <div class="saldo">{int(item.quantidade)}<small>{item.unidade}</small></div>
            <div class="detalhe">{item.baixo ? "abaixo do mínimo · " : ""}
              {[item.minimo ? `aviso em ${int(item.minimo)}` : "sem mínimo",
                item.custo_unitario ? `${fineMoney(item.custo_unitario)} cada` : "sem preço"].join(" · ")}
            </div>
            <div class="p-acoes">
              <button class="btn-sec" onClick={act("entrada", item.id)}>Entrada</button>
              <button class="btn-sec" onClick={act("contagem", item.id)}>Contagem</button>
              <button class="btn-sec" onClick={act("ajustes", item.id)}>Mínimo e preço</button>
            </div>
          </div>
        ))}
      </div>

      <div class="bloco-estoque">
        <div class="topo">
          <span class="rotulo">Custo de uma folha</span>
          <button class="btn-sec" onClick={act("custos")}>Preço e plástico</button>
        </div>
        <div class="rolagem"><table class="custo-folha">
          <thead><tr><th></th><th>Um lado</th><th>Dois lados</th><th>Foil</th></tr></thead>
          <tbody>
            {row("Papel", "papel")}
            {row("Plástico", "plastico")}
            {row("Tinta", "tinta")}
            {row("Material", "total", "total")}
            {row("Cobrado", "cobrado")}
            {row("Sobra", "margem")}
          </tbody>
        </table></div>
        <div class="nota-bloco">1 plástico a cada {int(cfg.folhas_por_plastico_um_lado)} folha(s)
          no um lado, a cada {int(cfg.folhas_por_plastico_dois_lados)} no dois lados e a
          cada {int(cfg.folhas_por_plastico_foil)} no foil. O foil sai no papel foil.</div>
      </div>

      <div class="bloco-estoque">
        <div class="topo">
          <span class="rotulo">Tinta 504</span>
          <button class="btn-sec" onClick={act("tinta-precos")}>Garrafas</button>
          <button class="btn-sec" onClick={act("tinta-consumo")}>Consumo</button>
        </div>
        <div class="rolagem"><table class="custo-folha">
          <thead><tr><th>Cor</th><th>Garrafa</th><th>ml</th><th>ml por folha</th><th>Por folha</th></tr></thead>
          <tbody>
            {stock.tintas.map((t) => (
              <tr key={t.cor}>
                <td>{t.nome}</td>
                <td>{t.preco_garrafa ? fineMoney(t.preco_garrafa) : "—"}</td>
                <td>{decimal(t.ml_garrafa)}</td>
                <td>{decimal(t.ml_por_folha)}</td>
                <td>{fineMoney(t.custo_folha)}</td>
              </tr>
            ))}
            <tr class="total"><td>Total</td><td></td><td></td>
              <td>{decimal(mlTotal)}</td><td>{fineMoney(inkTotal)}</td></tr>
          </tbody>
        </table></div>
        <div class="nota-bloco">Folha A4 de cartas em alta qualidade, papel fotográfico brilhante</div>
      </div>

      <div class="bloco-estoque">
        <div class="topo"><span class="rotulo">Movimentos</span></div>
        {!stock.movimentos.length && <div class="vazio">Nenhum movimento ainda.</div>}
        {stock.movimentos.map((m) => (
          <div class="movimento">
            <span>{when(m.criado_em).split(" (")[0]}</span>
            <span class="oque">{names[m.item] || m.item} · {REASONS[m.motivo] || m.motivo}
              {m.referencia && <> <b>#{m.referencia}</b></>}</span>
            <span class={"delta " + (m.delta < 0 ? "sai" : "entra")}>
              {m.delta > 0 ? "+" : "−"}{int(Math.abs(m.delta))}</span>
            <span>= {int(m.saldo)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
