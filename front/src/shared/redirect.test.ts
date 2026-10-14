import { returnPath } from "./redirect";

describe("returnPath", () => {
  it.each([
    ["?voltar=/deckbuilder", "/deckbuilder"],
    ["?voltar=/decks%3Fx%3D1", "/decks?x=1"],
    ["", "/"],
    ["?voltar=", "/"],
    ["?voltar=https://outro.site", "/"],
    ["?voltar=//outro.site", "/"],
    ["?voltar=/%5Coutro.site", "/"],
    ["?voltar=deckbuilder", "/"],
  ])("%s → %s", (search, expected) => {
    expect(returnPath(search)).toBe(expected);
  });
});
