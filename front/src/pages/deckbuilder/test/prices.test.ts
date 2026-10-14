/* -------------------------------------------------------------------------
   A régua do câmbio: como a tela escreve, em real, um preço que a base
   local guarda em dólar.

   MOTIVO DE EXISTIR. A conversão é de APRESENTAÇÃO, e a única coisa que
   separa "aproximação honesta" de "número inventado" é a disciplina de onde
   ela acontece. Quatro maneiras de errar, e são as quatro perseguidas aqui:

   1. Converter cedo: se a taxa entrar em `precoDaEntrada` ou em
      `orcamentoLocal`, o mesmo deck passa a valer números diferentes
      conforme o dólar do dia, e o teto que viaja pro `manabase.py` deixa de
      casar com o que o servidor filtra.
   2. Taxa ausente virando zero: `0 × preço` dá "R$ 0,00" em toda carta.
   3. O limiar de "caro" virando real: ele é um julgamento sobre a CARTA.
   4. O filtro de preço convertendo de um lado só.
   ------------------------------------------------------------------------- */
import { carta, entrada } from "./fixtures";
import { cleanup, clone, freshPage, type Page } from "./harness";

const ATRAXA = carta("Atraxa", "Legendary Creature — Angel", "WUBG", "{3}{W}{U}{B}{G}", 7.0, 20.0);
const SOL_RING = carta("Sol Ring", "Artifact", "", "{1}", 1.0, 2.0);
const RHYSTIC = carta("Rhystic Study", "Enchantment", "U", "{2}{U}", 3.0, 30.0);
const NO_PRICE = carta("Carta Nova", "Artifact", "", "{2}", 2.0, null);
const FOREST = carta("Forest", "Basic Land — Forest", "", "", 0.0, 0.1, true);
const DECK = [entrada(SOL_RING, 3), entrada(RHYSTIC), entrada(NO_PRICE), entrada(FOREST, 10)];

// 5.43 é uma taxa plausível e com casas que denunciam arredondamento torto.
const RATE = 5.43;
const daily = { valor: RATE, fonte: "awesomeapi" };
const fixed = (valor = RATE) => ({ valor, fonte: "fixa" });

/** `cambio` ausente é o estado real da tela antes de `GET /cambio` responder. */
async function page(cambio: unknown = null): Promise<Page> {
  const p = await freshPage();
  p.estado.comandantes = clone([ATRAXA]);
  p.estado.cartas = clone(DECK);
  p.estado.cambio = cambio;
  return p;
}

// A loja tem o Sol Ring e não tem o Rhystic (volta com erro: cai na base).
const QUOTE = {
  fontes: [{ id: "ligamagic", rotulo: "LigaMagic", moeda: "BRL", total: 120.0, cartas_cotadas: 2 }],
  linhas: [
    { nome: "Sol Ring", quantidade: 3, precos: { ligamagic: { preco_unitario: 7.5, loja: "Loja X" } } },
    { nome: "Rhystic Study", quantidade: 1, precos: { ligamagic: { erro: "sem resultado" } } },
  ],
};
async function quoted(cambio: unknown = fixed()) {
  const p = await page(cambio);
  p.estado.cotacao = clone(QUOTE);
  return p;
}

const headerTotal = (p: Page) => {
  p.desenharPreviaOrcamento();
  return document.getElementById("total-n")!.textContent;
};

afterEach(cleanup);

describe("moeda(): o único ponto de conversão", () => {
  it("sem taxa, dólar; com taxa, real com vírgula", async () => {
    expect((await page()).moeda(20)).toBe("US$ 20.00");
    expect((await page(daily)).moeda(20)).toBe("R$ 108,60");
  });

  it("taxa zero cai pra dólar, não vira R$ 0,00; valor zero continua zero", async () => {
    expect((await page(fixed(0))).moeda(20)).toBe("US$ 20.00");
    expect((await page(daily)).moeda(0)).toBe("R$ 0,00");
    expect((await page(fixed(5))).moeda(1000)).toBe("R$ 5.000,00");
  });

  it("a nota diz a taxa e de onde ela veio", async () => {
    expect((await page(daily)).notaDoCambio()).toBe("Convertido a R$ 5,43 por dólar (câmbio do dia).");
    expect((await page(fixed())).notaDoCambio()).toBe("Convertido a R$ 5,43 por dólar (taxa padrão do servidor).");
    expect((await page()).notaDoCambio()).toContain("dólar");
  });
});

describe("o que NÃO pode converter", () => {
  it("precoDaEntrada e orcamentoLocal continuam em dólar, com ou sem taxa", async () => {
    const p = await page(fixed());
    expect(p.precoDaEntrada(p.estado.cartas[0])).toBe(6.0);
    expect(p.orcamentoLocal().total).toBe(36.0);
    expect((await page()).orcamentoLocal().total).toBe(36.0);
  });

  it("o filtro de preço viaja em dólar quando digitado em real", async () => {
    const p = await page(fixed());
    expect(p.precoMaxEmUsd(16)).toBeCloseTo(16 / RATE, 4);
    expect(p.simboloDaTela()).toBe("R$");
    const noRate = await page();
    expect(noRate.precoMaxEmUsd(16)).toBe(16);
    expect(noRate.simboloDaTela()).toBe("US$");
  });
});

describe("valorHTML: o travessão e o vermelho", () => {
  it("carta sem preço mostra o travessão, nunca R$ 0,00", async () => {
    const p = await page(fixed());
    expect(p.valorHTML(p.estado.cartas[2])).toContain("—");
    expect(p.valorHTML(p.estado.cartas[2])).not.toContain("0,00");
    const noRate = await page();
    expect(noRate.valorHTML(noRate.estado.cartas[2])).toContain("—");
  });

  it("'caro' é julgamento sobre a carta: não muda com a taxa", async () => {
    // CARO_USD é 20 e o Rhystic custa 30; o Sol Ring, 2.
    for (const t of [1, 5.43, 50]) {
      const p = await page(fixed(t));
      expect(p.valorHTML(p.estado.cartas[1])).toContain("caro");
      expect(p.valorHTML(p.estado.cartas[0])).not.toContain("caro");
    }
  });

  it("o valor convertido carrega a nota do câmbio no title", async () => {
    const p = await page(daily);
    expect(p.valorHTML(p.estado.cartas[0])).toContain("5,43");
  });
});

describe("a prévia do orçamento no cabeçalho", () => {
  it("sem cotação, a soma local convertida (ou em dólar, sem 'US$ $')", async () => {
    expect(headerTotal(await page(fixed()))).toBe("R$ 195,48");
    expect(headerTotal(await page())).toBe("US$ 36.00");
  });

  it("cotado, o total da fonte passa intacto, em BRL ou USD", async () => {
    // Passar pela régua converteria duas vezes o que a loja já entregou.
    const brl = await page(fixed());
    brl.estado.cotacao = { fontes: [{ rotulo: "LigaMagic", moeda: "BRL", total: 250.5, cartas_cotadas: 4 }] };
    expect(headerTotal(brl)).toBe("R$ 250,50");
    const usd = await page(fixed());
    usd.estado.cotacao = { fontes: [{ rotulo: "Scryfall", moeda: "USD", total: 40.0, cartas_cotadas: 4 }] };
    expect(headerTotal(usd)).toBe("US$ 40,00");
  });
});

describe("o preço da loja ganha do preço convertido", () => {
  it("carta cotada usa a loja; a que a loja não achou, comandante e básico caem na base", async () => {
    const p = await quoted();
    const c = p.estado.cartas;
    expect(p.precoUnitario(c[0].carta).valor).toBe(7.5);
    expect(p.precoUnitario(c[0].carta).fonte).toBe("cotacao");
    expect(p.precoUnitario(c[1].carta).fonte).toBe("base");
    expect(p.precoUnitario(c[3].carta).fonte).toBe("base");
  });

  it("o preço da loja não passa pela régua; o da base passa", async () => {
    const p = await quoted();
    const c = p.estado.cartas;
    expect(p.precoTexto(p.precoUnitario(c[0].carta))).toBe("R$ 7,50");
    expect(p.precoTexto(p.precoUnitario(c[0].carta), 3)).toBe("R$ 22,50");
    expect(p.precoTexto(p.precoUnitario(c[1].carta))).toBe("R$ 162,90");
  });

  it("estimativa leva o tracejado; cotado nomeia a loja; cada mercado com o seu 'caro'", async () => {
    const p = await quoted();
    const c = p.estado.cartas;
    expect(p.valorHTML(c[0])).not.toContain("estimado");
    expect(p.valorHTML(c[1])).toContain("estimado");
    expect(p.valorHTML(c[0])).toContain("Loja X");
    expect(p.valorHTML(c[0])).not.toContain("caro");   // R$ 7,50 na loja
    expect(p.valorHTML(c[1])).toContain("caro");       // US$ 30 na base
  });
});

describe("o subtotal do grupo não soma moedas diferentes", () => {
  it("com câmbio, tudo em real, contando medidas e estimativas", async () => {
    const p = await quoted();
    const s = p.subtotalDoGrupo([p.estado.cartas[0], p.estado.cartas[1]]);
    expect(p.subtotalTexto(s)).toBe("R$ 185,40");
    expect([s.medidas, s.estimadas].join("/")).toBe("3/1");
  });

  it("sem câmbio, o que está em real fica fora da soma, e o title avisa", async () => {
    const p = await quoted(null);
    const s = p.subtotalDoGrupo([p.estado.cartas[0], p.estado.cartas[1]]);
    expect([p.subtotalTexto(s), s.foraDaSoma].join(" | ")).toBe("US$ 30.00 | 3");
    expect(p.subtotalTitulo(s)).toContain("fora da soma");
  });

  it("carta sem preço nenhum é contada, não somada", async () => {
    const p = await quoted();
    expect(p.subtotalDoGrupo([p.estado.cartas[2]]).sem).toBe(1);
  });
});

it("os preços de referência da modal não são convertidos", async () => {
  // Uma taxa de dólar não fala por euro nem por tix.
  const p = await page(fixed());
  const html = p.precosHTML({ precos: { usd: "2.50", eur: "1.80", tix: "0.03" } });
  expect(html).toContain("2.50");
  expect(html).toContain("1.80");
  expect(html).not.toContain("R$");
});
