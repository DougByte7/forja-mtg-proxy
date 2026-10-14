import { useQuery } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { useCurrentUser } from "../../shared/account";
import { api } from "../../shared/api";
import { readLocalDecks } from "../../shared/localDecks";
import { readOrders } from "./myOrders";
import { inkQuery } from "./queries";
import { ordersOpen, ordersVersion } from "./store";

export function Header() {
  const ink = useQuery(inkQuery).data;
  // A pastilha só aparece quando alguém sabe responder. Impressora de tanque
  // costuma não contar o nível (ver `app/tinta.py`), e aí a página fica como
  // sempre foi: pastilha nenhuma é melhor que um "tinta ok" chutado.
  const showInk = ink && (ink.estado === "ok" || ink.estado === "baixo");
  const hasLevel = typeof ink?.nivel === "number";
  // O número de cada suprimento fica no title: interessa a quem cuida da
  // impressora, e não vale gastar a linha do título com quatro números.
  const inkDetail = (ink?.marcadores || []).filter((m) => typeof m.nivel === "number")
    .map((m) => `${m.nome || "suprimento"}: ${m.nivel}%`).join(" · ");

  // Aqui só se LÊ a lista de decks: esta tela nunca escreve nela, pra não
  // ter uma terceira dona de um formato que já mora em dois lugares.
  const decks = readLocalDecks().length;
  ordersVersion.value;   // relê a lista guardada quando ela muda
  const orders = readOrders().length;

  return (
    <>
      <header>
        <div class="brand">
          <div class="rune"><span>⛨</span></div>
          <div>
            <div class="titulo">
              <h1>Forja de Proxies</h1>
              {showInk && (
                <span class={"tinta " + ink!.estado} title={inkDetail || undefined}>
                  <span class="bolha" />
                  {ink!.estado === "baixo"
                    ? (hasLevel ? `Tinta baixa · ${ink!.nivel}%` : "Tinta baixa")
                    : (hasLevel ? `Tinta ${ink!.nivel}%` : "Tinta ok")}
                </span>
              )}
            </div>
            <p>Orçamento na hora, pagamento por Pix</p>
          </div>
        </div>
        <nav class="acoes">
          {/* O deckbuilder é o passo ANTES desta tela: monta o deck, escolhe
              as artes e volta pra cá pelo "Gerar pedido". */}
          <a class="sec-btn meus-btn" href="/deckbuilder" style={{ textDecoration: "none" }}>Montar deck</a>
          {/* Só pra quem já tem deck salvo: um "Meus decks" vazio no
              cabeçalho de quem nunca montou nenhum só sabe decepcionar. */}
          {decks > 0 && (
            <a class="sec-btn meus-btn" href="/meus-decks" style={{ textDecoration: "none" }}>
              Meus decks <span class="n">{decks}</span></a>
          )}
          <AccountLink />
          {orders > 0 && (
            <button class="sec-btn meus-btn" onClick={() => { ordersOpen.value = true; }}>
              Meus Pedidos <span class="n">{orders}</span></button>
          )}
        </nav>
      </header>

      {/* Fica no topo, antes de tudo, porque a página parece uma loja: tem
          preço, botão de pagar e QR code de Pix. Quem cair aqui de fora
          precisa ler isto ANTES de chegar no botão. */}
      <div class="banner-privado" role="alert">
        <b>ATENÇÃO: isto NÃO é uma loja.</b>
        {" "}Se você não me conhece, não gere uma cobrança. Este sistema é para uso
        exclusivo meu e do meu grupo, para facilitar nossos playtestes.
      </div>

      {/* O aviso de prazo é o ponto de tudo isto: a pastilha diz o número,
          ele diz o que o número significa pra quem está pensando em pagar. */}
      {ink?.estado === "baixo" && (
        <div class="banner-tinta" role="status">
          <b>A tinta da impressora está acabando.</b>
          {" "}Enquanto o reabastecimento não chega, a produção das proxies pode levar{" "}
          <b class="prazo">1 a 2 semanas</b>.
        </div>
      )}
    </>
  );
}

/* O login é OPCIONAL: esta home funciona igual sem ele, e por isso tudo aqui
   falha em silêncio. O que ele acrescenta é dono — e, com dono, os pedidos
   aparecem em qualquer aparelho.

   A reclamação é AUTOMÁTICA aqui (e não um botão, como nos decks) porque a
   prova de posse já está na mão: os ids que este navegador guardou. O
   servidor só carimba o que está órfão, então isso nunca tira pedido de
   ninguém — ver `storage.reclamar`. */
function AccountLink() {
  const { data: user, isSuccess } = useCurrentUser();

  useEffect(() => {
    if (!user) return;
    const ids = readOrders().map((p) => p.id).filter(Boolean);
    if (ids.length) api("/pedidos/reclamar", { body: { ids } }).catch(() => {});
  }, [user?.login]);

  // Nasce escondido: um botão que pisca de "Entrar" pra "Fulano" a cada
  // carregamento é pior que um que chega pronto.
  if (!isSuccess) return null;
  return user
    ? <a class="sec-btn meus-btn conta-btn" href="/meus-decks" title={`Entrou como ${user.login}`}
         style={{ textDecoration: "none" }}>{user.nome}</a>
    : <a class="sec-btn meus-btn conta-btn" href={"/entrar?voltar=" + encodeURIComponent(location.pathname)}
         style={{ textDecoration: "none" }}>Entrar</a>;
}
