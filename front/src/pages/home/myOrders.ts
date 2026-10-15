/* -------------------------------------------------------------------------
   "Meus Pedidos" — o que este navegador já pediu.

   O backend guarda os pedidos, mas a lista de "meus pedidos" de quem não
   entrou na conta mora no localStorage, e a chave de tudo é o `order_id` — é
   ele que abre o andamento, o aviso de pagamento e o cancelamento. Quem
   limpar o navegador perde a LISTA, não o pedido.

   O XML vai junto de propósito: é o que deixa remontar as cartas na tela
   depois, sem pedir nada ao servidor (que nem entrega o XML de volta). A
   chave e o formato são os da página antiga: quem já tem pedido guardado
   continua vendo.
   ------------------------------------------------------------------------- */
import { api, ApiError } from "../../shared/api";
import type { Lamination } from "./totals";

export type SavedOrder = {
  id: string;
  deck_hash: string;
  nome: string;
  valor: number;
  qty: number;
  backs: number;
  pages: number;
  blanks: number;
  lam: Lamination;
  lamLabel: string;
  xml: string;
  pix: string;
  qr: string;
  status: string;
  criado_em: number;
};

const KEY = "forja.pedidos.v1";
const MAX = 12;      // XML + QR de cada pedido pesam alguns KB

export function readOrders(): SavedOrder[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((p) => p && p.id) : [];
  } catch {
    return [];   // localStorage bloqueado ou conteúdo estragado
  }
}

function write(list: SavedOrder[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;   // sem espaço, ou navegador em modo que não deixa gravar
  }
}

export function saveOrder(order: SavedOrder) {
  let list = [order, ...readOrders().filter((p) => p.id !== order.id)].slice(0, MAX);
  // Estourou a cota: vai largando o pedido mais velho até caber. Se nem um
  // couber, a lista antiga fica como estava — melhor perder o pedido novo da
  // lista (ele existe no servidor) do que zerar o histórico inteiro.
  while (list.length && !write(list)) list = list.slice(0, -1);
}

export function setOrderStatus(id: string, status: string) {
  const list = readOrders();
  const order = list.find((p) => p.id === id);
  if (!order) return;
  order.status = status;
  write(list);
}

export function forgetOrder(id: string) {
  const list = readOrders().filter((p) => p.id !== id);
  write(list);
  return list;
}

/** Pergunta o andamento de cada pedido ao servidor e guarda. Sem contato,
    fica valendo o que estava guardado; 404 é pedido limpo do servidor. */
export async function refreshStatuses(ids: string[]) {
  const list = readOrders();
  await Promise.all(ids.map(async (id) => {
    const order = list.find((p) => p.id === id);
    if (!order) return;
    try {
      // Pelo `api`, que leva o token: o pedido só abre pra quem é dono.
      const data = await api<{ status?: string }>("/orders/" + encodeURIComponent(id));
      if (data?.status) order.status = data.status;
    } catch (e) {
      // 404 é pedido limpo do servidor (ou de outra conta); o resto — sem
      // contato, sem conta — deixa valendo o que estava guardado.
      if (e instanceof ApiError && e.status === 404) order.status = "sumiu";
    }
  }));
  write(list);
}

/* Os estados são os do `app/storage.py`. 'sumiu' e 'offline' não existem
   lá: são o que a tela sabe quando o servidor não responde o esperado. */
type StateInfo = { label: string; cls: string; message: string };
const PAID_QUEUE = { label: "Na fila de impressão", cls: "pago",
                     message: "Pagamento conferido: o pedido está na fila da impressora." };
export const ORDER_STATES: Record<string, StateInfo> = {
  pending: { label: "Aguardando pagamento", cls: "esperando",
             message: 'Pague o Pix e clique em "Pagamento realizado" — é esse clique que me avisa.' },
  notified: { label: "Aviso enviado", cls: "avisado",
              message: "Já fui avisado. Assim que eu conferir o Pix no banco, o pedido vai pra impressão." },
  // Da fila em diante o Pix está conferido. O erro da impressora é problema
  // meu, não do cliente: pra ele o pedido continua na fila.
  a_imprimir: PAID_QUEUE,
  imprimindo: { label: "Imprimindo", cls: "pago",
                message: "Pagamento conferido: o pedido está sendo impresso agora." },
  erro_impressao: PAID_QUEUE,
  impresso: { label: "Impresso", cls: "pago", message: "Pagamento conferido e pedido impresso." },
  // O nome antigo de "impresso": pode estar guardado no navegador de quem
  // pediu antes da fila existir, até o servidor responder.
  paid: { label: "Confirmado", cls: "pago",
          message: "Pagamento conferido: esse pedido já foi pra impressão." },
  cancelado: { label: "Cancelado", cls: "morto",
               message: "Esse pedido foi cancelado. Nada foi impresso e nada mais vai acontecer com ele." },
  sumiu: { label: "Não encontrado", cls: "morto",
           message: "O servidor não conhece mais esse pedido — pedidos velhos são limpados de tempos em tempos. Dá pra tirar da lista pelo ✕." },
  offline: { label: "Sem contato", cls: "",
             message: "Não consegui falar com o servidor pra saber o andamento. O que está aqui é o que ficou guardado da última vez." },
};

export const stateInfo = (status: string) => ORDER_STATES[status] || ORDER_STATES.offline;

export function readableDate(ms: number) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}
