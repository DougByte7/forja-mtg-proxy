import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useState } from "preact/hooks";
import { canOrder, useCurrentUser } from "../../shared/account";
import { AccountButton } from "../../shared/AccountButton";
import { api, apiText } from "../../shared/api";
import { Icon } from "../../shared/Icon";
import { forgetLocalDeck, readLocalDecks, rememberLocalDeck } from "../../shared/localDecks";
import { Toast, toast } from "../../shared/toast";
import { deckLinkSource } from "../deckbuilder/text";
import { DeckCard } from "./DeckCard";
import { deckIdFromText, deckListQuery, fetchSummary, type DeckList, type DeckSummary } from "./data";

async function copy(text: string, note: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(note);
  } catch {
    toast("O navegador não deixou copiar. Copie da barra de endereço.");
  }
}

const deckUrl = (id: string) => `/decks/${encodeURIComponent(id)}`;

export function DecksPage() {
  const queryClient = useQueryClient();
  const userQ = useCurrentUser();
  const user = userQ.data ?? null;
  // Sem conta legível (erro no `/conta`), a lista é a do navegador.
  const userReady = !userQ.isPending;
  const listQ = useQuery({ ...deckListQuery(user), enabled: userReady });
  const listKey = deckListQuery(user).queryKey;

  const [armed, setArmed] = useState<string | null>(null);
  const [adoptText, setAdoptText] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["decks"] });

  const duplicate = useMutation({
    mutationFn: (id: string) =>
      api<{ deck: DeckSummary }>(`${deckUrl(id)}/duplicar`, { method: "POST", noStore: true, errorText: true }),
    onSuccess: ({ deck }) => {
      rememberLocalDeck(deck.id, deck.nome, deck.comandantes?.[0] || "");
      toast("Deck duplicado.");
      refresh();
    },
    onError: (e) => toast("Não consegui duplicar: " + e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(deckUrl(id), { method: "DELETE", noStore: true, errorText: true }),
    onSuccess: (_, id) => {
      forgetLocalDeck(id);
      toast("Deck apagado.");
      refresh();
    },
    onError: (e) => toast("Não consegui apagar: " + e.message),
  });

  const adopt = useMutation({
    mutationFn: async (id: string) => (await fetchSummary([id])).decks?.[0],
    onSuccess: (found) => {
      if (!found) {
        toast("Não existe deck com esse id.");
        return;
      }
      rememberLocalDeck(found.id, found.nome, found.comandantes?.[0] || "");
      setAdoptText("");
      toast("Deck acrescentado à lista.");
      refresh();
    },
    onError: (e) => toast("Não consegui conferir esse id: " + e.message),
  });

  function submitAdopt() {
    /* Link do Archidekt ou do Moxfield não é deck daqui: é deck a importar.
       Quem importa é o deckbuilder (ver `importExport.ts`) — ele cria o deck
       novo e diz o que não veio, e repetir isso nesta tela seria ter duas
       importações pra manter. */
    if (deckLinkSource(adoptText)) {
      location.href = "/deckbuilder?importar=" + encodeURIComponent(adoptText.trim());
      return;
    }
    const id = deckIdFromText(adoptText);
    if (!id) {
      return toast("Não reconheci esse link. Vale um link de deck da Forja, do Archidekt ou do Moxfield.");
    }
    if (readLocalDecks().some((d) => d.id === id)) return toast("Esse deck já está na lista.");
    adopt.mutate(id);
  }

  async function copyList(id: string) {
    try {
      await copy(await apiText(`${deckUrl(id)}/lista`, { noStore: true }),
                 "Decklist copiada — cole no MPC Fill.");
    } catch (e) {
      toast("Não consegui pegar a lista: " + (e as Error).message);
    }
  }

  /* Apagar em dois cliques, e não num `confirm()`: o primeiro clique arma o
     botão e o texto muda pra "Apagar mesmo?". A pergunta fica no lugar onde
     a mão já está, em vez de numa caixa que se fecha no reflexo. */
  function clickDelete(id: string) {
    if (armed !== id) return setArmed(id);
    setArmed(null);
    remove.mutate(id);
  }

  // Clicar em qualquer outro lugar (ou Esc) desarma: um botão que fica
  // esperando "sim" pra sempre acaba recebendo um sim distraído.
  useEffect(() => {
    if (!armed) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.("[data-apagar]")) setArmed(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setArmed(null); };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [armed]);

  /* Id que o navegador tem e o servidor não conhece. Não some sozinho da
     lista de propósito: apagar em silêncio o que pode ser um servidor fora
     do ar seria perder o id — que aqui é a única chave do deck. */
  function dismissMissing(id: string) {
    forgetLocalDeck(id);
    queryClient.setQueryData<DeckList>(listKey, (old) =>
      old && { ...old, missing: old.missing.filter((m) => m !== id) });
  }

  const loading = !userReady || listQ.isPending;
  const missing = listQ.data?.missing ?? [];
  const decks = listQ.data?.decks ?? [];

  return (
    <>
      <header class="topo">
        <div class="topo-in">
          <div class="rune"><span>⌘</span></div>
          <span class="marca">Forja de Proxies</span>
          <span class="espaco" />
          {canOrder(user) && (
            <a class="btn" href="/pedido"><Icon name="printer" /> Imprimir proxies</a>
          )}
          <AccountButton returnTo="/" />
          <a class="btn ouro" href="/deckbuilder"><Icon name="plus" /> Deck novo</a>
        </div>
      </header>

      <main class="corpo">
        <h1>Meus decks</h1>
        <p class="sub">{!userReady ? "Carregando…" : user
          ? "Os baralhos da sua conta, de qualquer aparelho — mais os que este "
            + "navegador conhece e ainda não têm dono."
          : "Os baralhos que este navegador conhece. Eles ficam no servidor; o que "
            + "fica aqui é só a lista de quais são os seus, então abrir em outro "
            + "aparelho pede o link do deck."}</p>

        {listQ.error && (
          <div class="aviso erro">Não consegui falar com o servidor:{" "}
            {listQ.error.message}. Seus decks continuam lá — é esta tela que não
            está conseguindo ler.</div>
        )}

        {missing.length > 0 && (
          <div class="aviso">
            {missing.length} deck(s) desta lista não existem mais no servidor.
            Isso acontece quando alguém apaga o deck em outro aparelho.{" "}
            {missing.map((id) => (
              <button class="btn mini" onClick={() => dismissMissing(id)}>
                <Icon name="x" /> tirar {id}
              </button>
            ))}
          </div>
        )}

        <div class="aviso">Tem o link de um deck? Cole aqui. Link da Forja entra nesta lista;
          link do <b>Archidekt</b> ou do <b>Moxfield</b> vira um deck novo aqui, com comandante, as 99 e
          o maybeboard.
          <div class="adotar">
            <input class="campo" placeholder="link da Forja, archidekt.com/decks/…  ou  moxfield.com/decks/…"
                   autocomplete="off"
                   spellcheck={false} aria-label="Link ou id do deck" value={adoptText}
                   onInput={(e) => setAdoptText(e.currentTarget.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") submitAdopt(); }} />
            <button class="btn" onClick={submitAdopt} disabled={adopt.isPending}>
              <Icon name="plus" /> {deckLinkSource(adoptText) ? "Importar" : "Acrescentar"}
            </button>
          </div>
        </div>

        {loading ? (
          <div class="vazio">Carregando…</div>
        ) : !decks.length ? (
          <div class="vazio">
            <p style={{ margin: "0 0 12px" }}>Nenhum deck neste navegador ainda.</p>
            <a class="btn ouro" href="/deckbuilder"><Icon name="plus" /> Montar o primeiro</a>
          </div>
        ) : (
          <div class="grade">
            {decks.map((d) => (
              <DeckCard key={d.id} deck={d} loggedIn={!!user} armed={armed === d.id}
                onCopyLink={() => copy(`${location.origin}/deckbuilder?deck=${encodeURIComponent(d.id)}`,
                                       "Link copiado.")}
                onCopyList={() => copyList(d.id)}
                onDuplicate={() => duplicate.mutate(d.id)}
                onDelete={() => clickDelete(d.id)} />
            ))}
          </div>
        )}
      </main>
      <Toast />
    </>
  );
}
