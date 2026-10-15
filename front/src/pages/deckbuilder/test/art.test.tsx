/* A aba Artes: a galeria, a escolha por cópia e o "Gerar pedido", que só
   leva à tela de orçamento com TODAS as artes escolhidas. */
import { render, type ComponentType } from "preact";
import { act } from "preact/test-utils";
import { cleanup, type Page } from "./harness";
import { DELVER, ELVES, page, ROOM, SOL_RING } from "./sampleDeck";

afterEach(cleanup);

/** O componente desenhado num contêiner solto, do jeito que está agora. */
function drawn(Component: ComponentType) {
  const host = document.createElement("div");
  act(() => render(<Component />, host));
  return host;
}

const galleryHtml = (p: Page) => drawn(p.Gallery).innerHTML;
const frames = (html: string) =>
  [...html.matchAll(/data-arte-carta="([^"]+)" data-arte-face="(\w+)"/g)].map((m) => [m[1], m[2]]);
const shortcutHidden = (p: Page) => drawn(p.DefaultArtsButton).querySelector("button")!.hidden;

/** Quem pode pedir (ver `canOrder`). */
const AMIGO = { login: "ana", nome: "Ana", perfil: "amigo" };

/** O link do "Gerar pedido": escondido?, destino e o porquê. */
function orderLink(p: Page) {
  const l = drawn(p.OrderLink).querySelector("a")!;
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
    p.artState.choices["sol ring"] = { frente: { arte_id: "id-sol" } };
    p.artState.choices["delver of secrets insectile aberration"] = { verso: { arte_id: "id-inseto" } };
    expect(p.previewProps(SOL_RING)["data-arte"]).toContain("thumbnail?id=id-sol");
    expect(p.previewProps(ELVES)["data-arte"]).toBe("http://arte/Llanowar Elves");
    const delver = p.previewProps(DELVER);
    expect(delver["data-arte"]).toMatch(/^http:\/\/arte\/Delver/);
    expect(delver["data-arte-verso"]).toContain("thumbnail?id=id-inseto");
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
    p.state.cards.push({ carta: DELVER, quantidade: 1, categoria: "" },
                         { carta: ROOM, quantidade: 1, categoria: "" });
    p.artState.choices["sol ring"] = { frente: { arte_id: "id-sol" } };
    const html = galleryHtml(p);
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
    p.state.user = AMIGO;
    p.state.id = "abc123";
    p.state.cards = [{ carta: SOL_RING, quantidade: 4, categoria: "" },
                       { carta: DELVER, quantidade: 1, categoria: "" }];
    expect(orderLink(p)).toEqual([false, null, "Faltam 4 arte(s) — escolha na aba Artes"]);
    p.artState.choices["atraxa"] = { frente: { arte_id: "a" } };
    p.artState.choices["sol ring"] = { frente: { arte_id: "s" } };
    p.artState.choices["delver of secrets insectile aberration"] = { frente: { arte_id: "d" } };
    expect(orderLink(p).slice(1)).toEqual([null, "Faltam 1 arte(s) — escolha na aba Artes"]);
    p.artState.choices["delver of secrets insectile aberration"].verso = { arte_id: "i" };
    expect(orderLink(p).slice(0, 2)).toEqual([false, "/pedido?deck=abc123"]);
    p.state.id = null;
    expect(orderLink(p).slice(0, 2)).toEqual([true, null]);
  });

  it("some pra quem não pode pedir: anônimo e conta que não é de amigo", async () => {
    const p = await page();
    p.state.id = "abc123";
    p.state.user = null;
    expect(orderLink(p)[0]).toBe(true);
    p.state.user = { login: "beto", nome: "Beto", perfil: "cliente" };
    expect(orderLink(p)[0]).toBe(true);
    p.state.user = { login: "chefe", nome: "Chefe", perfil: "admin" };
    expect(orderLink(p)[0]).toBe(false);
  });

  it("as fichas vão pro papel: quadro na galeria e conta no pedido", async () => {
    // A mesma Wurm de deathtouch criada por duas cartas, e a de lifelink, de
    // mesmo nome, por uma.
    const wurm = (texto: string, chave: string) => ({
      nome: "Wurm", tipo: "Token Artifact Creature — Wurm", texto, poder: "3", resistencia: "3",
      imagem: "http://arte/" + chave, chave_arte: chave });
    const p = await page();
    p.state.user = AMIGO;
    p.state.id = "abc123";
    p.state.tokens = { total: 3, grupos: [
      { carta: "Motor de Wurm", tokens: [wurm("Deathtouch", "t:Wurm aaaa1111"), wurm("Lifelink", "t:Wurm bbbb2222")] },
      { carta: "Sol Ring", tokens: [wurm("Deathtouch", "t:Wurm aaaa1111")] }] };
    p.state.cards = [{ carta: SOL_RING, quantidade: 1, categoria: "" }];
    p.artState.choices["atraxa"] = { frente: { arte_id: "a" } };
    p.artState.choices["sol ring"] = { frente: { arte_id: "s" } };
    p.artState.choices["t wurm aaaa1111"] = { frente: { arte_id: "w" } };
    const f = p.deckTokens();
    const before = orderLink(p)[2];
    p.artState.choices["t wurm bbbb2222"] = { frente: { arte_id: "v" } };
    const after = orderLink(p)[1];

    expect(f).toHaveLength(2);
    expect(p.searchNameFor(f[0], "frente")).toBe("t:Wurm");
    expect(p.findArtCard("t:Wurm bbbb2222").texto).toBe("Lifelink");
    const html = galleryHtml(p);
    expect([...html.matchAll(/data-arte-carta="([^"]+)"/g)].map((m) => m[1]).slice(-2))
      .toEqual(["t:Wurm aaaa1111", "t:Wurm bbbb2222"]);
    expect(html).toContain("<h3>Tokens</h3>");
    expect(html).toMatch(/class="galeria-carta tem-arte\s*"\s+data-arte-carta="t:Wurm aaaa1111"/);
    expect(html).toContain("Wurm 3/3 (Lifelink)");
    expect(before).toBe("Faltam 1 arte(s) — escolha na aba Artes");
    expect(after).toBe("/pedido?deck=abc123");
  });

  it("arte por cópia: as dez Florestas, a 2 e a 4 numa arte e o resto na de todas", async () => {
    const p = await page();
    p.state.user = AMIGO;
    p.state.id = "abc123";
    const forest = p.state.cards[2].carta;
    p.artState.choices = {
      "atraxa": { frente: { arte_id: "a" } }, "sol ring": { frente: { arte_id: "s" } },
      "ashnods altar": { frente: { arte_id: "t" } }, "llanowar elves": { frente: { arte_id: "e" } },
      "swords to plowshares": { frente: { arte_id: "p" } },
      "forest": { frente: { arte_id: "todas" },
                  copias: { 2: { frente: { arte_id: "outra" } }, 4: { frente: { arte_id: "outra" } } } },
    };
    const html = galleryHtml(p);
    const order = orderLink(p)[1];
    const shortcut = shortcutHidden(p);
    expect([...html.matchAll(/data-arte-carta="Forest" data-arte-face="frente" data-arte-copia="(\d+)"/g)]
      .map((m) => m[1])).toEqual(["1", "2"]);
    expect(html).toContain("8×");
    expect(html).toContain("cópias 1, 3, 5–10");
    expect(html).toContain("2×");
    expect(html).toContain("cópias 2, 4");
    expect([p.chosenArt(forest, "frente", null, 2).arte_id,
            p.chosenArt(forest, "frente", null, 3).arte_id]).toEqual(["outra", "todas"]);
    expect([order, shortcut]).toEqual(["/pedido?deck=abc123", true]);

    delete p.artState.choices.forest.frente;
    expect([orderLink(p)[2], shortcutHidden(p)])
      .toEqual(["Faltam 1 arte(s) — escolha na aba Artes", false]);
    // A linha do deck mostra a arte da primeira cópia que tem.
    expect(p.chosenArt(forest).arte_id).toBe("outra");
  });
});

describe("a modal de escolher a arte", () => {
  it("abre na carta, troca de origem e some ao fechar", async () => {
    const p = await page();
    p.state.id = "abc123";
    const host = drawn(p.ArtPicker);
    expect(host.innerHTML).toBe("");

    await act(() => p.openArtPicker("Sol Ring"));
    expect(host.querySelector("#arte-titulo")!.textContent).toBe("Sol Ring");
    expect((host.querySelector("#arte-faces") as HTMLElement).hidden).toBe(true);
    expect(host.querySelector("#arte-conta")!.textContent).toBe("Procurando as artes…");
    expect(document.documentElement.classList.contains("sem-rolar")).toBe(true);

    act(() => p.setOrigin("enviar"));
    expect([(host.querySelector("#arte-grade") as HTMLElement).hidden,
            (host.querySelector("#arte-envio") as HTMLElement).hidden]).toEqual([true, false]);

    act(() => (host.querySelector("#arte-fechar") as HTMLElement).click());
    expect([host.innerHTML, document.documentElement.classList.contains("sem-rolar")]).toEqual(["", false]);
  });

  it("carta de duas faces: o seletor de lado marca o que já tem arte", async () => {
    const p = await page();
    p.state.id = "abc123";
    p.state.cards.push({ carta: DELVER, quantidade: 1, categoria: "" });
    p.artState.choices["delver of secrets insectile aberration"] = { verso: { arte_id: "i" } };
    const host = drawn(p.ArtPicker);
    await act(() => p.openArtPicker(DELVER.nome, "verso"));
    const sides = [...host.querySelectorAll<HTMLElement>("#arte-faces [data-face]")]
      .map((b) => [b.dataset.face, b.classList.contains("ativa"), b.title]);
    expect(sides).toEqual([
      ["frente", false, "Este lado está na arte padrão"],
      ["verso", true, "Arte escolhida pra este lado"],
    ]);
  });

  it("sem deck salvo não abre", async () => {
    const p = await page();
    const host = drawn(p.ArtPicker);
    await act(() => p.openArtPicker("Sol Ring"));
    expect(host.innerHTML).toBe("");
  });
});
