/* A aba Artes: a galeria, a escolha por cópia e o "Gerar pedido", que só
   leva à tela de orçamento com TODAS as artes escolhidas. */
import { cleanup, type Page } from "./harness";
import { DELVER, ELVES, page, ROOM, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

const galleryHtml = () => document.getElementById("galeria-resultado")!.innerHTML;
const frames = (html: string) =>
  [...html.matchAll(/data-arte-carta="([^"]+)" data-arte-face="(\w+)"/g)].map((m) => [m[1], m[2]]);

/** O link do "Gerar pedido": escondido?, destino e o porquê. */
function orderLink(p: Page) {
  p.updateOrderLink();
  const l = document.getElementById("btn-pedido") as HTMLAnchorElement;
  return [l.hidden, l.getAttribute("href") || null, l.title];
}

describe("paginador da galeria", () => {
  it("a primeira, a última e duas de cada lado da atual", async () => {
    const p = await page();
    // Cinco no meio sempre, inclusive nas pontas — senão os números trocam
    // de lugar debaixo do mouse a cada clique.
    expect(p.visiblePages(4, 10)).toEqual([0, "…", 2, 3, 4, 5, 6, "…", 9]);
    expect(p.visiblePages(0, 10)).toEqual([0, 1, 2, 3, 4, 5, "…", 9]);
    expect(p.visiblePages(9, 10)).toEqual([0, "…", 4, 5, 6, 7, 8, 9]);
    expect(p.visiblePages(2, 5)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < 30; i++) {
      expect(p.visiblePages(i, 30).filter((x: unknown) => x !== "…")).toHaveLength(7);
    }
  });
});

describe("nomes e chaves", () => {
  it("o verso se busca pelo nome dele; a frente vai inteira", async () => {
    // O MPC Fill indexa cada face pelo próprio nome.
    const p = await page();
    expect([p.searchNameFor(DELVER, "verso"), p.searchNameFor(DELVER, "frente")])
      .toEqual(["Insectile Aberration", "Delver of Secrets // Insectile Aberration"]);
  });

  it("a chave da arte é o nome achatado do servidor (`cartas.normalizar`)", async () => {
    const p = await page();
    expect(["Atraxa, Praetors' Voice", "Delver of Secrets // Insectile Aberration",
            "Lim-Dûl's Vault", "Ærathi Berserker", "  Jötun   Grunt ", "t:Wurm e76e0314"]
      .map(p.artKey))
      .toEqual(["atraxa praetors voice", "delver of secrets insectile aberration",
                "lim duls vault", "aerathi berserker", "jotun grunt", "t wurm e76e0314"]);
  });

  it("a prévia do hover mostra o arquivo escolhido, cada face pela sua", async () => {
    const p = await page();
    p.artState.escolhas["sol ring"] = { frente: { arte_id: "id-sol" } };
    p.artState.escolhas["delver of secrets insectile aberration"] = { verso: { arte_id: "id-inseto" } };
    expect(p.ganchosDaPrevia(SOL_RING)).toContain("thumbnail?id=id-sol");
    expect(p.ganchosDaPrevia(ELVES)).toContain('data-arte="http://arte/Llanowar Elves"');
    const delver = p.ganchosDaPrevia(DELVER);
    expect(delver).toContain('data-arte="http://arte/Delver');
    expect(delver).toContain("thumbnail?id=id-inseto");
  });

  it("cada origem com a sua miniatura, e a URL da Scryfall virando id", async () => {
    const p = await page();
    const imp = "6904ea20-e504-47da-95a0-08739fdde260";
    expect([
      p.artThumbnail("1AbC", 400),
      p.artThumbnail(`scryfall:${imp}:back`, 400),
      p.artThumbnail(`scryfall:${imp}:front`, 40),
      p.artThumbnail("enviada:" + "a".repeat(64), 400),
      p.scryfallIdFromImage(`https://cards.scryfall.io/normal/front/6/9/${imp}.jpg?1`),
    ]).toEqual([
      "https://drive.google.com/thumbnail?id=1AbC&sz=w400",
      `https://cards.scryfall.io/normal/back/6/9/${imp}.jpg`,
      `https://cards.scryfall.io/small/front/6/9/${imp}.jpg`,
      "/artes/enviadas/" + "a".repeat(64) + "/miniatura",
      `scryfall:${imp}:front`,
    ]);
  });
});

describe("a galeria", () => {
  it("um quadro por arte, só do que vai pro papel, comandante primeiro", async () => {
    const p = await page();
    p.state.cartas.push({ carta: DELVER, quantidade: 1, categoria: "" },
                         { carta: ROOM, quantidade: 1, categoria: "" });
    p.artState.escolhas["sol ring"] = { frente: { arte_id: "id-sol" } };
    p.drawGallery();
    const html = galleryHtml();
    const q = frames(html);
    expect(q.filter(([n]) => n.startsWith("Delver")).map(([, f]) => f)).toEqual(["frente", "verso"]);
    // O maybeboard não vai pro papel; o sideboard vai.
    expect(q.some(([n]) => n === "Rhystic Study" || n === "Lightning Bolt")).toBe(false);
    expect(q.some(([n]) => n === "Swords to Plowshares")).toBe(true);
    expect(q[0][0]).toBe("Atraxa");
    expect(html).toMatch(/class="galeria-carta\s+deitada"\s+data-arte-carta="Porta/);
    expect(html).toMatch(/class="galeria-carta tem-arte\s*"\s+data-arte-carta="Sol Ring"/);
    // Atraxa, 5 cartas do deck, Delver (2 artes) e o Room: 9 artes, 1 escolhida.
    expect(html).toContain("<b>1/9</b>");
  });
});

describe('o "Gerar pedido"', () => {
  it("só com todas as artes, verso incluído, e só com deck salvo", async () => {
    const p = await page();
    p.state.id = "abc123";
    p.state.cartas = [{ carta: SOL_RING, quantidade: 4, categoria: "" },
                       { carta: DELVER, quantidade: 1, categoria: "" }];
    expect(orderLink(p)).toEqual([false, null, "Faltam 4 arte(s) — escolha na aba Artes"]);
    p.artState.escolhas["atraxa"] = { frente: { arte_id: "a" } };
    p.artState.escolhas["sol ring"] = { frente: { arte_id: "s" } };
    p.artState.escolhas["delver of secrets insectile aberration"] = { frente: { arte_id: "d" } };
    expect(orderLink(p).slice(1)).toEqual([null, "Faltam 1 arte(s) — escolha na aba Artes"]);
    p.artState.escolhas["delver of secrets insectile aberration"].verso = { arte_id: "i" };
    expect(orderLink(p).slice(0, 2)).toEqual([false, "/?deck=abc123"]);
    p.state.id = null;
    expect(orderLink(p).slice(0, 2)).toEqual([true, null]);
  });

  it("as fichas vão pro papel: quadro na galeria e conta no pedido", async () => {
    // A mesma Wurm de deathtouch criada por duas cartas, e a de lifelink, de
    // mesmo nome, por uma.
    const wurm = (texto: string, chave: string) => ({
      nome: "Wurm", tipo: "Token Artifact Creature — Wurm", texto, poder: "3", resistencia: "3",
      imagem: "http://arte/" + chave, chave_arte: chave });
    const p = await page();
    p.state.id = "abc123";
    p.state.tokens = { total: 3, grupos: [
      { carta: "Motor de Wurm", tokens: [wurm("Deathtouch", "t:Wurm aaaa1111"), wurm("Lifelink", "t:Wurm bbbb2222")] },
      { carta: "Sol Ring", tokens: [wurm("Deathtouch", "t:Wurm aaaa1111")] }] };
    p.state.cartas = [{ carta: SOL_RING, quantidade: 1, categoria: "" }];
    p.artState.escolhas["atraxa"] = { frente: { arte_id: "a" } };
    p.artState.escolhas["sol ring"] = { frente: { arte_id: "s" } };
    p.artState.escolhas["t wurm aaaa1111"] = { frente: { arte_id: "w" } };
    const f = p.deckTokens();
    p.drawGallery();
    const before = orderLink(p)[2];
    p.artState.escolhas["t wurm bbbb2222"] = { frente: { arte_id: "v" } };
    const after = orderLink(p)[1];

    expect(f).toHaveLength(2);
    expect(p.searchNameFor(f[0], "frente")).toBe("t:Wurm");
    expect(p.findArtCard("t:Wurm bbbb2222").texto).toBe("Lifelink");
    const html = galleryHtml();
    expect([...html.matchAll(/data-arte-carta="([^"]+)"/g)].map((m) => m[1]).slice(-2))
      .toEqual(["t:Wurm aaaa1111", "t:Wurm bbbb2222"]);
    expect(html).toContain("<h3>Tokens</h3>");
    expect(html).toMatch(/class="galeria-carta tem-arte\s*"\s+data-arte-carta="t:Wurm aaaa1111"/);
    expect(html).toContain("Wurm 3/3 (Lifelink)");
    expect(before).toBe("Faltam 1 arte(s) — escolha na aba Artes");
    expect(after).toBe("/?deck=abc123");
  });

  it("arte por cópia: as dez Florestas, a 2 e a 4 numa arte e o resto na de todas", async () => {
    const p = await page();
    p.state.id = "abc123";
    const forest = p.state.cartas[2].carta;
    p.artState.escolhas = {
      "atraxa": { frente: { arte_id: "a" } }, "sol ring": { frente: { arte_id: "s" } },
      "ashnods altar": { frente: { arte_id: "t" } }, "llanowar elves": { frente: { arte_id: "e" } },
      "swords to plowshares": { frente: { arte_id: "p" } },
      "forest": { frente: { arte_id: "todas" },
                  copias: { 2: { frente: { arte_id: "outra" } }, 4: { frente: { arte_id: "outra" } } } },
    };
    p.drawGallery();
    const html = galleryHtml();
    const order = orderLink(p)[1];
    const shortcutHidden = (document.getElementById("btn-artes-padrao") as HTMLElement).hidden;
    expect([...html.matchAll(/data-arte-carta="Forest" data-arte-face="frente" data-arte-copia="(\d+)"/g)]
      .map((m) => m[1])).toEqual(["1", "2"]);
    expect(html).toContain("8×");
    expect(html).toContain("cópias 1, 3, 5–10");
    expect(html).toContain("2×");
    expect(html).toContain("cópias 2, 4");
    expect([p.chosenArt(forest, "frente", null, 2).arte_id,
            p.chosenArt(forest, "frente", null, 3).arte_id]).toEqual(["outra", "todas"]);
    expect([order, shortcutHidden]).toEqual(["/?deck=abc123", true]);

    delete p.artState.escolhas.forest.frente;
    p.drawGallery();
    expect([orderLink(p)[2], (document.getElementById("btn-artes-padrao") as HTMLElement).hidden])
      .toEqual(["Faltam 1 arte(s) — escolha na aba Artes", false]);
    // A linha do deck mostra a arte da primeira cópia que tem.
    expect(p.chosenArt(forest).arte_id).toBe("outra");
  });
});
