/* Cartas no formato que a busca devolve pra tela. */

export type Card = Record<string, unknown> & { nome: string };

export function carta(nome: string, tipo: string, ident = "", custo = "{1}", cmc = 1.0,
                      preco: number | null = 1.0, basico = false): Card {
  return { nome, tipo, identidade: ident, mana_cost: custo, cmc, preco_usd: preco,
           imagem: "http://arte/" + nome, legal: true, basico, ilimitada: false,
           comandante: false, parceiro: false };
}

export const entrada = (c: Card | null, quantidade = 1, categoria = "") => ({ carta: c, quantidade, categoria });
