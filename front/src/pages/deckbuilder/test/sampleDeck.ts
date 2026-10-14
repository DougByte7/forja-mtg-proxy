/* O deck de exemplo dos testes de regra, arte, busca e versões. */
import { carta, entrada } from "./fixtures";
import { clone, freshPage } from "./harness";

export const ATRAXA = carta("Atraxa", "Legendary Creature — Angel", "WUBG", "{3}{W}{U}{B}{G}", 7.0, 20.0);
export const SOL_RING = carta("Sol Ring", "Artifact", "", "{1}", 1.0, 2.0);
export const ALTAR = carta("Ashnod's Altar", "Artifact", "", "{3}", 3.0, 8.0);
export const FOREST = carta("Forest", "Basic Land — Forest", "", "", 0.0, 0.1, true);
export const ELVES = carta("Llanowar Elves", "Creature — Elf Druid", "G", "{G}", 1.0, 0.5);
export const SWORDS = carta("Swords to Plowshares", "Instant", "W", "{W}", 1.0, 3.0);
export const BOLT = carta("Lightning Bolt", "Instant", "R", "{R}", 1.0, 2.0);
export const RHYSTIC = carta("Rhystic Study", "Enchantment", "U", "{2}{U}", 3.0, 30.0);
// As duas cartas que chegam `legal: false` por motivos opostos: uma ainda não
// saiu (e sai), a outra é banida.
export const INEDITA = { ...carta("Dragão Que Vem Aí", "Creature — Dragon", "", "{4}{R}", 5.0, 1.0),
                  legal: false, inedita: true, sai_em: "2026-11-13" };
export const LOTUS = { ...carta("Black Lotus", "Artifact", "", "{0}", 0.0, 1.0), legal: false };

export const DECK = [
  entrada(SOL_RING, 1, "Combo principal"),
  entrada(ALTAR, 1, "Sac outlet"),
  entrada(FOREST, 10),
  entrada(ELVES),
  entrada(SWORDS, 1, "Sideboard"),
];
export const MAYBE = [entrada(RHYSTIC, 1, "Combo principal"), entrada(BOLT)];
export const AUTO_CATEGORIES = ["Combo principal", "Sac outlet", "Ainda vazia"];

export type Setup = { deck?: unknown[]; maybe?: unknown[]; categorias?: string[] };

/** A página com o deck de exemplo (ou o que o teste pedir). */
export async function page({ deck = DECK, maybe = MAYBE, categorias = AUTO_CATEGORIES }: Setup = {}) {
  const p = await freshPage();
  p.state.commanders = clone([ATRAXA]);
  p.state.cards = clone(deck);
  p.state.maybe = clone(maybe);
  p.state.categories = clone(categorias);
  return p;
}


export const DELVER = { ...carta("Delver of Secrets // Insectile Aberration",
                                 "Creature — Human Wizard // Creature — Human Insect", "U"),
                        imagem_verso: "http://arte/Insectile Aberration" };
export const ROOM = { ...carta("Porta // Sala", "Enchantment — Room // Enchantment — Room"), deitada: 1 };
