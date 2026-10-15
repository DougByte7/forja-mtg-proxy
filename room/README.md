# A sala da mesa compartilhada

O goldfish com mais de uma pessoa. É um Worker da Cloudflare com um
Durable Object por mesa. O objeto guarda a partida, aplica as jogadas com as
mesmas regras da tela (`front/src/pages/deckbuilder/tableRules.ts`) e manda a
cada jogador só o que ele pode ver.

Ela fica fora da Vercel porque as funções de lá não seguram WebSocket. Também
não fala com o homelab: só busca decks no site (`GET /decks/{id}`), que é
público.

## Como ela funciona

- **Entrar:** `wss://<worker>/rooms/<id>?token=<token de sessão do Clerk>`.
  O id da sala é a URL, e quem tem o link entra. A sala nasce com o primeiro
  que entra e some sozinha um dia depois da última jogada.
- **Sentar:** `{type: "sit", deckId}`. A sala busca o deck no site. Ela não
  aceita cartas vindas do navegador, porque a imagem de uma carta é
  desenhada no navegador dos outros. São até 4 jogadores. Quem não sentou
  assiste.
- **Jogar:** `{type: "act", action}`, com as ações de `tableRules.ts`. A sala
  barra o que a mesa de papel também barra: mexer no baralho ou na mão dos
  outros, passar a vez de quem está jogando, tocar carta que você não está
  vendo.
- **Olhar o próprio baralho:** `{type: "look"}`. A busca termina num
  embaralhamento, seja pela jogada `shuffle`, seja quando a pessoa cai.
- **Desfazer:** `{type: "undo"}`. Só desfaz a própria última jogada, e só se
  ninguém jogou depois. Comprar e embaralhar não se desfazem.
- **Recomeçar:** `{type: "restart"}`. Busca os decks de novo.

Detalhes em `src/room.ts` (o que pode), `src/view.ts` (o que cada um vê) e
`src/protocol.ts` (as mensagens).

## Configuração

São as mesmas chaves do site (`app/clerk.py`):

| | |
|---|---|
| `CLERK_JWT_KEY` (segredo) | a chave pública da instância do Clerk, a mesma do site |
| `CLERK_ORIGENS` | as telas que podem abrir a sala, separadas por vírgula (ex.: `https://forja.exemplo`) |
| `SITE_URL` | o site, de onde vêm os decks |

As duas últimas ficam em `vars`, no `wrangler.jsonc`.

## Rodar e publicar

Tudo de DENTRO de `room/`: é lá que está o `wrangler.jsonc`, e sem ele o
wrangler não sabe qual Worker é ("Required Worker name missing"). E sempre
pelo `pnpm exec`, que usa o wrangler fixado no `package.json`. Um `npx
wrangler` solto baixa a versão mais nova da rede.

```sh
cd room
npx pnpm@12.8.1 install
npx pnpm@12.8.1 test        # regras da sala e conferência do token
npx pnpm@12.8.1 typecheck
npx pnpm@12.8.1 check       # empacota sem publicar

# local, com uma chave de teste
npx pnpm@12.8.1 exec wrangler dev --var CLERK_JWT_KEY:<miolo base64> --var SITE_URL:http://localhost:8000

# na conta Cloudflare (antes: SITE_URL e CLERK_ORIGENS no wrangler.jsonc)
npx pnpm@12.8.1 exec wrangler login
npx pnpm@12.8.1 exec wrangler secret put CLERK_JWT_KEY
npx pnpm@12.8.1 deploy
```
