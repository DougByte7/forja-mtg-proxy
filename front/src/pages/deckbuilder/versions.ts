/* ----------------------------------------------------------------- versões

   Todo deck nasce WIP e só sai disso pela mão de quem monta: concluir
   fotografa a lista como a v0, e dali em diante cada conclusão é a versão
   seguinte (ver `decks.py`, "VERSÕES SÃO FOTOGRAFIAS"). A pílula ao lado do
   nome é o estado e a porta: diz em que versão o deck está, se a lista já
   mudou desde ela, e abre o menu que conclui a próxima.

   Quem decide é o servidor — WIP inválido e lista igual voltam 409 com o
   motivo. A tela só deixa de oferecer o clique que ele recusaria, usando a
   mesma validação instantânea do contador. O desenho é `ui/Versions.tsx`. */
import { switchTab } from "./layout";
import { openMenu, type MenuItem } from "./popupMenu";
import { api, currentValidation, flushSave, isSavePending } from "./save";
import { state, touch } from "./state";
import { toast } from "./ui/toast";

export const isWip = () => state.versao?.atual == null;

/* Concluir versão é alterar o deck, então vale a regra do autosave: pede
   conta, e deck com dono só o dono e o admin alteram. */
export function canComplete() {
  const u = state.usuario;
  if (!u) return false;
  if (!state.dono) return true;
  return u.id === state.dono || u.perfil === "admin";
}

export function shortDate(ts: number | null | undefined) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

/* Por que o clique de concluir não está disponível agora, ou "" se está.

   Com uma gravação esperando o autosave, a lista da tela ainda não é a do
   servidor: o `mudou` que ele contou pode estar velho, então o clique fica
   liberado e quem responde é o servidor, depois de gravar. */
export function completionBlocker() {
  if (!state.usuario) return "Entre na sua conta pra concluir versões.";
  if (!canComplete()) return "Só quem é dono do deck conclui versões.";
  if (isWip()) {
    const v = currentValidation();
    if (v.ok) return "";
    const size = v.apontamentos.find((a: any) => a.tipo === "faltam" || a.tipo === "sobram");
    const serious = v.apontamentos.filter((a: any) => a.nivel === "erro" && a !== size);
    if (serious.length) return `${serious.length} problema(s) na lista — veja a aba Análise.`;
    return size ? size.mensagem : "A lista ainda não é válida.";
  }
  if (!state.versao.mudou && !isSavePending()) return `A lista está igual à v${state.versao.atual}.`;
  return "";
}

/** O que a pílula ao lado do nome mostra. */
export function versionPillView() {
  const v = state.versao;
  const wip = isWip();
  const changed = !wip && v.mudou;
  return {
    text: wip ? "WIP" : `v${v.atual}`,
    className: "versao-pilula" + (wip ? " wip" : "") + (changed ? " mudou" : ""),
    title: wip ? "Trabalho em progresso"
      : changed ? `Versão ${v.atual} — a lista mudou desde então` : `Versão ${v.atual}`,
    // A partir da v1: com uma versão só não há duas listas pra comparar.
    hasHistory: !wip && v.atual >= 1,
  };
}

/* A aba de histórico só existe com o que comparar: sem ela, quem estava
   nela volta pro deck. */
export function syncVersion() {
  if (!versionPillView().hasHistory && state.aba === "historico") switchTab("deck");
  touch();
}

export function openVersionMenu(anchor: Element) {
  const v = state.versao;
  const wip = isWip();
  const blocker = completionBlocker();
  const items: MenuItem[] = [];
  if (wip) {
    items.push({ title: "Trabalho em progresso" });
    items.push({ note: blocker || "A lista está pronta pra virar a v0." });
  } else {
    // Por extenso: o título do menu é em caixa alta, e "V1" não é a pílula.
    items.push({ title: `Versão ${v.atual} · ${shortDate(v.concluida_em)}` });
    const note = blocker || (v.mudou ? `Desde a v${v.atual}: ${v.entraram} entraram, ${v.sairam} saíram.` : "");
    if (note) items.push({ note });
  }
  items.push({ label: `Concluir v${wip ? 0 : v.atual + 1}`, icon: "check",
               disabled: !!blocker, onClick: completeVersion });
  if (!wip && v.atual >= 1) {
    items.push("sep");
    items.push({ label: "Ver histórico", icon: "arrow-counter-clockwise", onClick: () => switchTab("historico") });
  }
  openMenu(anchor, items);
}

/* A fotografia é do que o servidor tem gravado, então o que estiver
   esperando o autosave vai antes — senão a versão sairia sem a última
   carta. */
export async function completeVersion() {
  if (!(await flushSave())) {
    toast("Não consegui salvar o deck — a versão fica pra depois.");
    return;
  }
  if (!state.id) return;
  try {
    const r = await api(`/decks/${state.id}/versoes`, { method: "POST" });
    state.versao = r.versao;
    state.historico = r.historico;
    state.historicoErro = null;
    syncVersion();
    toast(`v${r.versao.atual} concluída.`);
  } catch (e) {
    toast((e as Error).message);
  }
}

/* Um contador de pedidos: a aba se abre e o autosave também pede, e a
   resposta que chega por último não é necessariamente a do pedido mais
   novo. */
let historyRequest = 0;

export async function loadHistory() {
  if (!state.id) return;
  const request = ++historyRequest;
  try {
    const r = await api(`/decks/${state.id}/versoes`);
    if (request !== historyRequest) return;
    state.historico = r;
    state.historicoErro = null;
  } catch (e) {
    if (request !== historyRequest) return;
    state.historicoErro = (e as Error).message;
  }
  touch();
}
