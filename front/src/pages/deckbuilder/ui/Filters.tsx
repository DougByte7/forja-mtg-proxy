/* Os filtros da busca: o botão com a contagem, a fita do que está ligado e
   os controles da gaveta. Tudo desenha de `state.filters` (ver `filters.ts`),
   então a gaveta, a fita e o interruptor da abertura nunca discordam. */
import { openDrawer } from "../drawers";
import {
  activeFilters, cleanNumber, FILTER_COLORS, removeFilter, setUnreleasedFromHero, toggleColor, updateFilters,
} from "../filters";
import { screenCurrency } from "../price";
import { TYPE_OPTIONS } from "../state";
import { GuardedInput } from "./GuardedInput";
import { SpriteIcon } from "./SpriteIcon";
import { useDeck } from "./useDeck";

/* A cor mostra a mesma coisa que o número, pra quem não repara em bolinha. */
export function FiltersButton() {
  useDeck();
  const n = activeFilters().length;
  return (
    <button class={"btn btn-filtros" + (n ? " ouro" : "")} id="btn-gaveta-filtros" aria-haspopup="dialog"
            aria-controls="gaveta-filtros" onClick={() => openDrawer("gaveta-filtros")}>
      <span>Filtros</span><span class="conta" id="conta-filtros" hidden={!n}>{n || ""}</span>
    </button>
  );
}

export function FilterTape() {
  useDeck();
  return (
    <>
      {activeFilters().map((f) => (
        <span class="ligado"><b>{f.label}</b>{f.icon && <SpriteIcon name={f.icon} label={f.direction} />}
          <button title="Tirar este filtro" aria-label={`Tirar o filtro ${f.label}${f.direction ? ", " + f.direction : ""}`}
                  onClick={() => removeFilter(f.key)}><SpriteIcon name="x" /></button>
        </span>
      ))}
    </>
  );
}

const ORDERS: [string, string][] = [
  ["nome", "Nome"], ["cmc", "Custo — menor primeiro"], ["cmc_desc", "Custo — maior primeiro"],
  ["preco", "Preço — mais barata primeiro"], ["preco_desc", "Preço — mais cara primeiro"],
];

export function FilterFields() {
  const state = useDeck();
  const f = state.filters;
  const number = (key: "cmcMin" | "cmcMax" | "maxPrice") =>
    (e: Event) => updateFilters({ [key]: cleanNumber((e.currentTarget as HTMLInputElement).value) });
  return (
    <>
      <div class="campo-grupo">
        <label for="f-texto">Efeito da carta</label>
        <GuardedInput class="campo" id="f-texto" autocomplete="off" spellcheck={false}
                      placeholder="ex.: draw a card, sacrifice a creature" value={f.text}
                      onInput={(e: Event) => updateFilters({ text: (e.currentTarget as HTMLInputElement).value.trim() })} />
        <p class="ajuda">Cada palavra tem que aparecer no texto da carta, em qualquer ordem. O texto é o{" "}
          <b>oracle em inglês</b>: "voar" não acha <i>Flying</i>.</p>
      </div>

      <div class="campo-grupo">
        <label for="f-tipo">Tipo</label>
        <select class="campo" id="f-tipo" value={f.type} onChange={(e) => updateFilters({ type: e.currentTarget.value })}>
          {TYPE_OPTIONS.map(([value, label]) => <option value={value}>{label}</option>)}
        </select>
      </div>

      <div class="campo-grupo">
        <label>Cor da carta</label>
        <div class="cores-btn" id="f-cores">
          {FILTER_COLORS.map(([c, name]) => {
            const on = f.colors.includes(c);
            return (
              <button class={"cor-btn" + (on ? " ativo" : "")} data-cor={c} title={name} aria-label={name}
                      aria-pressed={on ? "true" : "false"} onClick={() => toggleColor(c)}>
                <span class={`pip ${c}`} /></button>
            );
          })}
        </div>
        <p class="ajuda">Mostra o que tem <b>alguma</b> das cores marcadas — pra achar "o que eu tenho de
          verde".</p>
      </div>

      <div class="campo-grupo">
        <label>Custo de mana convertido</label>
        <div class="par">
          <GuardedInput class="campo" id="f-cmc-min" type="number" min="0" max="20" step="1" placeholder="de"
                        inputMode="numeric" value={f.cmcMin} onInput={number("cmcMin")} />
          <span>até</span>
          <GuardedInput class="campo" id="f-cmc-max" type="number" min="0" max="20" step="1" placeholder="até"
                        inputMode="numeric" value={f.cmcMax} onInput={number("cmcMax")} />
        </div>
      </div>

      <div class="campo-grupo">
        {/* O filtro é DIGITADO na moeda da tela e VIAJA em dólar (ver
            `maxPriceInUsd`): o rótulo e a divisão mudam juntos, sempre. */}
        <label for="f-preco">Preço máximo (<span id="rot-preco-moeda">{screenCurrency()}</span>)</label>
        <GuardedInput class="campo" id="f-preco" type="number" min="0" step="0.5" placeholder="sem teto"
                      inputMode="decimal" value={f.maxPrice} onInput={number("maxPrice")} />
        <p class="ajuda">Preço aproximado, convertido pelo câmbio — serve pra dar ordem de grandeza. Quem
          responde "quanto custa comprar" continua sendo o botão de cotar. Carta sem preço conhecido{" "}
          <b>passa</b> no teto em vez de sumir.</p>
      </div>

      <div class="campo-grupo">
        <label for="f-ordem">Ordenar por</label>
        <select class="campo" id="f-ordem" value={f.order} onChange={(e) => updateFilters({ order: e.currentTarget.value })}>
          {ORDERS.map(([value, label]) => <option value={value}>{label}</option>)}
        </select>
        <p class="ajuda">Vale quando a caixa de busca está vazia. Com nome digitado, quem manda é a
          relevância.</p>
      </div>

      <div class="campo-grupo">
        <label class="interruptor">
          <input type="checkbox" id="f-ineditas" checked={f.unreleased}
                 onChange={(e) => updateFilters({ unreleased: e.currentTarget.checked })} />
          <span class="trilho-int" aria-hidden="true" />
          Incluir cartas inéditas
        </label>
        <p class="ajuda">Cartas das coleções já anunciadas e ainda não lançadas. Elas vêm marcadas como{" "}
          <b>não legais</b> até o dia do lançamento, e por isso ficam fora da busca — ligado, aparecem com a
          etiqueta <b>inédita</b> na lista. Carta <b>banida</b> continua de fora.</p>
      </div>
    </>
  );
}

/* O mesmo filtro das inéditas, na tela de abertura: lá a gaveta ainda não
   está na tela — sem comandante não há painel de busca. Os dois mostram o
   mesmo estado, senão um deles mentiria assim que o outro fosse tocado. */
export function HeroUnreleasedSwitch() {
  const state = useDeck();
  return (
    <label class="interruptor" title="Cartas de coleção anunciada, que ainda não está nas lojas">
      <input type="checkbox" id="cmd-ineditas" checked={state.filters.unreleased}
             onChange={(e) => setUnreleasedFromHero(e.currentTarget.checked)} />
      <span class="trilho-int" aria-hidden="true" />
      Incluir cartas inéditas
    </label>
  );
}
