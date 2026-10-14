/* ------------------------------------------------------- validação instantânea

   Mesmas regras do `decks.validar` no servidor, na versão que roda a cada
   clique. Ela é substituída pela do servidor assim que o autosave responde;
   existe porque esperar a rede pra dizer "essa carta é de outra cor" tornaria
   a tela lenta justamente no momento em que a informação importa. */
import { signal } from "@preact/signals";
import { rememberLocalDeck } from "../../shared/localDecks";
import { analyzeManabase } from "./manabase";
import { scheduleQuote } from "./budget";
import { deckIdentity, totalCards } from "./deck";
import { state, touch } from "./state";
import { brDate } from "./text";
import { loadTokens } from "./tokens";
import { loadHistory, syncVersion } from "./versions";

export type Issue = { nivel: "erro" | "aviso"; tipo: string; carta?: string; mensagem: string };

export function validateLocally() {
  const identity = deckIdentity();
  const issues: Issue[] = [];
  const total = totalCards();

  if (!state.comandantes.length) {
    issues.push({ nivel: "erro", tipo: "sem-comandante", mensagem: "Todo deck de Commander começa por um comandante." });
  }
  if (total < 100) {
    issues.push({ nivel: "erro", tipo: "faltam", mensagem: `Faltam ${100 - total} carta(s) pras 100 do formato.` });
  } else if (total > 100) {
    issues.push({ nivel: "erro", tipo: "sobram", mensagem: `São ${total - 100} carta(s) além das 100 do formato.` });
  }

  // O maybeboard não passa por aqui: é rascunho, e acusar identidade de cor
  // numa carta que a pessoa ainda está pensando se usa seria alarme sobre
  // uma decisão que ela nem tomou. O sideboard passa — fora da CONTA não é
  // fora das REGRAS, e uma carta guardada pra trocar depois precisa caber no
  // deck em que vai entrar. Mesma divisão do `decks.validar`.
  for (const { carta, quantidade } of state.cartas) {
    if (!carta) continue;
    if (quantidade > 1 && !carta.basico && !carta.ilimitada) {
      issues.push({ nivel: "erro", tipo: "singleton", carta: carta.nome,
                    mensagem: `${carta.nome}: ${quantidade} cópias. Commander é singleton.` });
    }
    // Ainda não lançada é AVISO, não erro: a carta vira legal sozinha no dia
    // do lançamento, e um deck montado com a coleção nova na mão não é um
    // deck quebrado. Mesma regra do `decks.validar` — quando a resposta do
    // servidor chega, ela tem que dizer a mesma coisa que esta.
    if (carta.inedita) {
      issues.push({ nivel: "aviso", tipo: "inedita", carta: carta.nome,
                    mensagem: `${carta.nome} ainda não foi lançada — vale em mesa a partir de ${brDate(carta.sai_em)}.` });
    } else if (!carta.legal) {
      issues.push({ nivel: "erro", tipo: "banida", carta: carta.nome, mensagem: `${carta.nome} não é legal em Commander.` });
    }
    const outside = (carta.identidade || "").split("").filter((c) => !identity.includes(c as never));
    if (outside.length) {
      issues.push({ nivel: "erro", tipo: "identidade", carta: carta.nome,
                    mensagem: `${carta.nome} tem ${outside.join("")} na identidade de cor, que o comandante não tem.` });
    }
  }
  const errors = issues.filter((a) => a.nivel === "erro").length;
  return { ok: !errors, identidade: identity, total, apontamentos: issues, erros: errors, avisos: issues.length - errors };
}

export function currentValidation() {
  return state.validacao || validateLocally();
}

/* ------------------------------------------------------------------ servidor */

export async function api(path: string, options?: RequestInit) {
  const r = await fetch(path, options);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch { /* sem corpo JSON */ }
    throw new Error(detail);
  }
  return r.status === 204 ? null : r.json();
}

export function deckBody() {
  const line = (e: { carta: { nome: string }; quantidade: number; categoria?: string }) =>
    ({ nome: e.carta.nome, quantidade: e.quantidade, categoria: e.categoria || "" });
  return {
    nome: state.nome,
    comandantes: state.comandantes.map((c) => c.nome),
    cartas: state.cartas.map(line),
    maybeboard: state.maybe.map(line),
    // Vão inteiras, inclusive as vazias: uma categoria recém-criada some
    // antes de receber a primeira carta se ela só existir nas entradas.
    categorias: state.categorias,
  };
}

/* O que o cabeçalho diz sobre a gravação ("salvo 14:02", "salvando…"), e a
   classe que pinta: "ok" ou "erro". */
export const saveStatus = signal<{ text: string; cls: string }>({ text: "", cls: "" });

export function setSaveStatus(text: string, cls = "") {
  saveStatus.value = { text, cls };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let saveAgain = false;

/* Se há gravação esperando a vez ou em voo. */
export function isSavePending() {
  return !!saveTimer || saving;
}

/* Autosave: agenda uma gravação pra 900 ms depois da última mudança. Um clique
   em "+" não pode virar uma requisição — quem ajusta quantidade clica várias
   vezes seguidas. */
export function scheduleSave() {
  setSaveStatus("alterações não salvas");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}

export async function saveNow() {
  // Zerado aqui, e não só no `clearTimeout`: é por ele que o `flushSave`
  // sabe se ainda há gravação esperando a vez.
  saveTimer = null;
  if (saving) { saveAgain = true; return; }
  // Deck sem comandante e sem carta não vira registro no servidor: senão cada
  // pessoa que só abriu a página deixaria um deck vazio pra trás.
  if (!state.comandantes.length && !state.cartas.length) return;
  if (!state.usuario) {
    setSaveStatus("entre na sua conta pra salvar", "erro");
    return;
  }
  saving = true;
  setSaveStatus("salvando…");
  try {
    const body = { method: state.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
                   body: JSON.stringify(deckBody()) };
    const response = await api(state.id ? `/decks/${state.id}` : "/decks", body);
    const isNew = !state.id;
    state.id = response.deck.id;
    state.validacao = response.validacao;
    state.versao = response.versao;
    if (isNew) {
      state.dono = response.deck.dono || null;
      history.replaceState(null, "", `?deck=${state.id}`);
    }
    rememberDeck();
    setSaveStatus("salvo " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), "ok");
    // A validação que chega do servidor substitui a local, e o ponto do
    // cabeçalho é desenhado a partir dela: sem o redesenho o ponto ficaria
    // contando a versão instantânea até a próxima carta entrar.
    touch();
    // A pílula da versão ganha o ponto de "a lista mudou" quando o servidor
    // confirma a mudança, e o histórico aberto acompanha a lista gravada.
    syncVersion();
    if (state.aba === "historico") loadHistory();
    // O primeiro salvamento é o instante em que o deck ganha id — e é só com
    // id que dá pra cotar. Sem esta chamada, um deck de uma carta só nunca
    // seria cotado: a cotação esperaria uma segunda mudança que não vem.
    scheduleQuote();
    // A mana base é conta local, sem custo de fora: depois de aberta uma
    // vez, acompanha cada autosave em vez de envelhecer com aviso.
    if (state.manabase) analyzeManabase();
    // Fichas sempre, aberta a aba ou não: elas vão pro papel, e a aba Artes
    // e o "Gerar pedido" contam as artes delas. A resposta sai da base
    // local, sem rede de fora.
    loadTokens();
  } catch (e) {
    setSaveStatus("não consegui salvar: " + (e as Error).message, "erro");
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; scheduleSave(); }
  }
}

/* Grava agora o que estiver esperando o autosave, e diz se o servidor ficou
   com a versão da tela. É pra quem sai da página levando o deck — o pedido
   é montado com o que o SERVIDOR tem, e os 900 ms de espera cabem folgados
   entre a última carta e o clique no link. */
export async function flushSave() {
  if (!isSavePending()) return true;
  while (saving) await new Promise((r) => setTimeout(r, 100));
  if (saveTimer) clearTimeout(saveTimer);
  await saveNow();
  return saveStatus.value.cls === "ok";
}

/* O nome que se digitou no cabeçalho. Vazio volta ao nome de fábrica. */
export function renameDeck(name: string) {
  state.nome = name.trim() || "Deck sem nome";
  scheduleSave();
}

/* Os decks abertos neste navegador, inclusive os que outra pessoa
   compartilhou — que não são da conta de quem abriu e por isso não saem no
   `/decks/meus`. A tela "Meus decks" junta as duas listas (ver
   `shared/localDecks.ts`). */
export function rememberDeck() {
  if (state.id) rememberLocalDeck(state.id, state.nome, state.comandantes[0]?.nome);
}
