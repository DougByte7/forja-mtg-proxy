# Forja de Proxies — backend

Recebe o XML do MPC Fill, gera a cobrança Pix (QR + copia-e-cola) com a sua
própria chave, recebe o aviso de pagamento do próprio cliente por e-mail e,
com um clique seu no link **Imprimir** desse e-mail, gera o PDF A4 buscando
as imagens no Google Drive e manda direto pra fila da impressora na rede.

O front-end (`app/static/index.html`) é servido pelo próprio backend —
não precisa de outro container nem configurar URL nenhuma. Ao abrir
`http://IP-DO-SERVIDOR:8000/` (ou o domínio do seu Cloudflare Tunnel) já
cai direto na "Forja de Proxies" chamando a API na mesma origem.

## Isto não é uma loja

A página tem preço, botão de pagar e QR code de Pix — parece uma loja e não
é. É ferramenta privada, para o dono do sistema e o grupo de jogo dele
imprimirem proxies de playtest.

Por isso a tela tem duas travas, nessa ordem:

1. Um **banner vermelho no topo**, antes de qualquer outra coisa: "isto NÃO é
   uma loja; se você não me conhece, não gere uma cobrança".
2. Um **checkbox obrigatório** logo acima do botão de cobrança — "Declaro que
   conheço o dono do sistema" —, sem o qual o botão nasce e continua
   desabilitado.

**As duas são travas de TELA.** A rota `POST /orders` continua aberta pra
quem chamar direto por `curl`. Elas não existem pra barrar quem quer burlar;
existem pro caso real, que é alguém achar o link, entender que é loja, e
pagar um Pix esperando receber carta em casa.

Se um dia isso precisar virar trava de verdade, o caminho é pôr a criação de
pedido atrás de autenticação — não endurecer o front-end.

## Como o pagamento é confirmado

Sem passar por um provedor de pagamento (Mercado Pago, Asaas, EFI etc.), não
existe uma API que confirme "foi pago" — e o banco não notifica nada. Então
**quem avisa é o próprio cliente, e quem confirma é você**:

1. O cliente monta o pedido, **revisa a folha** (ver a seção abaixo) e gera a
   cobrança Pix.
2. Ele paga no app do banco dele e clica em **"Pagamento realizado, enviar
   notificação"**. Esse clique já dispara a montagem do PDF em segundo plano,
   pra folha estar pronta quando você for conferir.
3. Você recebe um e-mail com o resumo do pedido (nome, código do deck,
   cartas, páginas, laminação, valor) e dois botões: **Ver PDF** e
   **Imprimir**.
4. **Ver PDF** abre a folha montada direto no navegador (ou no visualizador
   do celular) pra você conferir antes de gastar papel. Só olhar não marca
   nada como pago nem imprime.
5. Você confere no app do banco se o Pix caiu mesmo e **só então** clica em
   **Imprimir**. Esse clique marca o pedido como pago e manda pra fila da
   impressora — reaproveitando exatamente o PDF que você acabou de olhar.

O PDF vai como **link, não como anexo**: um pedido grande passaria fácil do
limite de 25 MB do Gmail. Como o arquivo abre no celular, dá pra imprimir
por ali também, pelo app da impressora, em vez de usar o botão Imprimir.

Os dois links são assinados com HMAC da `ADMIN_TOKEN`, com **tokens
diferentes** pra cada um: quem tem o link de conferir não consegue disparar
sua impressora. Eles não expiram — dá pra reabrir e reimprimir, o que é útil
quando enrosca papel. Se vazar, troque a `ADMIN_TOKEN` e todos os links
antigos deixam de valer de uma vez.

O PDF fica em cache no disco (`PDF_OUTPUT_DIR`), pra não baixar tudo do Drive
de novo entre conferir e imprimir. A exceção é quando alguma imagem falha no
download: aí a folha sai com um quadro vermelho **"FALHA NO DOWNLOAD"** no
lugar da carta, o arquivo não é reaproveitado, e o link *"Gerar o PDF de
novo"* no rodapé do e-mail tenta baixar outra vez (falha de taxa do Drive
costuma ser temporária).

Precisa disparar na mão? Dá pra chamar as mesmas rotas com o header do admin:

```
curl -H "X-Admin-Token: SEU_TOKEN" https://SEU-BACKEND/orders/ID/pdf -o folha.pdf
curl -H "X-Admin-Token: SEU_TOKEN" https://SEU-BACKEND/orders/ID/print
```

E `GET /admin/orders` (mesmo header) lista os pedidos ainda não impressos,
com `status` `pending` (ninguém avisou nada) ou `notified` (o cliente disse
que pagou).

Pra não depender do e-mail nem do curl, tem a tela **[Pedidos](#tela-de-pedidos-admin)**
em `/admin`, com a mesma coisa em botão.

Se um dia quiser confirmação automática de verdade, migrar pra um provedor
como o Asaas (cadastro simples de pessoa física, tem webhook) resolve esse
ponto sem mexer no resto — o `pix.py` viraria uma chamada de API em vez de
gerar o BR Code na mão.

## Revisar o pedido antes de pagar

Antes de gerar a cobrança, o botão **"Revisar o pedido antes de pagar"** abre um
editor que roda **inteiro no navegador** — nenhuma chamada ao backend, nenhum
pedido criado ainda:

- **Prévia página a página** da folha A4, com as cartas na mesma grade 3x3, as
  marcas de corte nas margens e as cruzes verdes nos cantos. É a mesma
  geometria que o `pdf_generator.py` desenha, então o que aparece na tela é o
  que sai no papel.
- **Mais cópias, menos cópias, tirar a carta** — pelos botões `+` / `−` da
  lista lateral ou passando o mouse por cima da carta na prévia.
- **Frente e verso contam separado.** Numa carta dupla-face, o verso tem a
  própria linha na lista (e os próprios `+` / `−` na prévia): dá pra ficar com
  4 frentes e só 2 versos, ou nenhum, sem mexer nas cópias da frente. Serve pra
  quem já tem o verso impresso, ou pra quem vai usar o verso genérico da folha
  em vez do verso próprio.
- **Desfazer** a última ação (ou `Ctrl+Z`), quantas vezes precisar.
- O rodapé mostra, ao vivo, quantas páginas, quantos **espaços livres** sobram
  na última página e quanto vai custar — que é justamente o que faz o cliente
  decidir se completa a folha com mais uma cópia de alguma coisa.

Ao clicar em **Confirmar revisão**, o XML é reescrito no navegador: os slots
são renumerados sem buracos, o `<quantity>` (e o `<bracket>`) acompanham, e
tudo o que a gente não mexe — `stock`, `foil`, `cardback` — passa intacto, então
o arquivo continua sendo um XML do MPC Fill válido. É esse XML revisado que vai
pro `POST /orders` e que vira o PDF de impressão depois. **Cancelar** joga as
alterações fora.

Se o cliente já tinha gerado uma cobrança, ela some da tela ao confirmar a
revisão: aquele QR era do pedido anterior, com outro valor.

As miniaturas vêm das URLs de thumbnail do Google Drive, com os mesmos ids que
já estão no XML — mesma ressalva do download lá do backend, não é API oficial.
Quando uma miniatura não carrega, o nome da carta aparece no lugar da arte e a
prévia continua servindo pra conferir as quantidades.

Sobre cartas dupla-face (MDFC), as regras que o editor segue:

- O verso nunca passa do número de cópias da frente — ele é recortado e colado
  numa carta, então sem carta ele não vai pra lugar nenhum. Pra caber mais um
  verso, adicione mais uma cópia da frente.
- Tirar uma cópia da frente tira primeiro uma **sem** verso próprio, pra não
  levar junto um verso que você quis manter. Quando todas as cópias têm verso,
  aí sai a frente com o verso dela, e o rodapé avisa.
- Zerar os versos não some com a linha deles na lista: ela fica com contador 0
  pra você poder colocar de volta sem precisar desfazer.
- Uma cópia nova só herda o verso quando **todas** as cópias de agora têm o
  mesmo verso. Se você já separou frente e verso na mão, a cópia nova sai sem
  verso, em vez de desfazer a sua escolha.

## Passo a passo

1. **Preencha o `.env`** a partir do `.env.example`:
   - `PIX_KEY`, `MERCHANT_NAME`, `MERCHANT_CITY` — dados da sua cobrança Pix.
   - `SMTP_*` e `NOTIFY_TO` — a conta que manda e pra onde vai o e-mail de
     aviso de pagamento (senha de app se for Gmail/Outlook).
   - `PUBLIC_BASE_URL` — **importante**: a URL pública do backend, usada pra
     montar o link Imprimir. Tem que ser um endereço que você consiga abrir
     do celular (o domínio do Cloudflare Tunnel). Se ficar em `localhost`, o
     link só funciona na máquina onde o serviço roda.
   - `LOCAL_BASE_URL` — opcional, o endereço do backend **na rede local**
     (`http://192.168.x.y:8000`). Liga um link extra "Ver PDF (rede local)"
     no e-mail e na tela do admin, pra conferir a folha de dentro de casa sem
     mandar o arquivo pro túnel e trazer de volta. Veja *Como o PDF volta pro
     navegador*.
   - `CUPS_HOST` e `PRINTER_QUEUE` — endereço do CUPS na rede
     (`IP-DO-SERVIDOR:631`, ou vazio pra falar pelo socket local) e o nome da
     fila da sua impressora.
   - `TINTA_ESTADO` — opcional, `baixo` liga na mão o aviso de que a
     impressão vai demorar (veja *Aviso de tinta baixa*).
   - `ADMIN_TOKEN` — uma senha longa e aleatória só sua: ela assina o link
     Imprimir e libera as rotas `/admin`. Sem ela o botão do cliente falha.

2. **Suba o serviço** (pra teste local, tem um `docker-compose.yml` pronto na
   própria pasta — `podman compose up -d --build` já funciona). Pra colocar
   no servidor de vez, use `docker-compose.snippet.yml` (cole o serviço
   dentro do compose que já roda lá).

3. **Abra `http://localhost:8000/`** (ou o IP/domínio de onde estiver
   rodando) — é a Forja de Proxies completa, já falando com essa API.

4. **Exponha na rede/Cloudflare Tunnel** quando for pro servidor de verdade,
   apontando pra `forja-backend:8000`, do jeito que os outros serviços já
   são expostos.

5. **Teste antes de usar de verdade**: marque o "Declaro que conheço o dono
   do sistema" (sem ele o botão de cobrança fica desabilitado), gere um
   pedido de teste, escaneie o QR com seu próprio celular (ou com um segundo
   app bancário) e confirme que o valor e a chave batem antes de mandar pra
   qualquer pessoa do grupo.

## Estrutura

- `app/static/index.html` — o front-end (a Forja de Proxies), servido pelo
  próprio FastAPI.
- `app/static/admin.html` — a tela de pedidos do operador, em `/admin`. Ver
  *Tela de pedidos (admin)*.
- `app/pix.py` — monta o BR Code (QR Pix) na mão, sem provedor.
- `app/calc.py` — mesma lógica de páginas/custo do artifact, em Python.
- `app/storage.py` — pedidos em SQLite, com nome de quem pediu e hash do deck
  (`status`: `pending` → `notified` → `paid`, mais `cancelado` pro que o
  operador desistiu na tela de pedidos).
- `app/pdf_generator.py` — baixa as imagens do Drive e monta o PDF A4 3x3. Os
  versos de carta dupla-face saem **um por cópia**, igual ao que o `calc.py`
  cobra e ao que a prévia mostra.
- `app/fulfillment.py` — assina os links do e-mail, faz cache do PDF e roda
  o job de impressão.
- `app/notify.py` — manda o e-mail de aviso com o resumo e os links.
- `app/printer.py` — envia o PDF pra fila CUPS.
- `app/tinta.py` — pergunta o nível de tinta ao CUPS por IPP, pra tela avisar
  quando a impressão vai demorar. Ver *Aviso de tinta baixa*.
- `app/cleanup.py` — apaga os PDFs antigos do disco de tempos em tempos.
- `app/main.py` — API que costura tudo.
- `deploy/atualizar.sh` — puxa o código novo, reconstrói o container e desfaz
  se a página não voltar. Ver *Publicação automática*.
- `.github/workflows/publicar.yml` — dispara esse script no homelab a cada push
  na main, por um runner self-hosted.
- `app/cotacao.py` — escolhe a oferta mais barata de cada carta e soma o
  total. Não sabe de onde vem o preço: a função de busca chega por parâmetro.
- `app/ligamagic.py` — lê as ofertas das lojas brasileiras na LigaMagic.
  **Leia o aviso no topo do arquivo antes de mexer.**
- `app/scryfall.py` — segunda fonte, via API oficial (preços em dólar). Busca
  o deck inteiro em lote (`preparar`) antes da varredura carta a carta.
- `app/cotacao_job.py` — roda a cotação em segundo plano e guarda o andamento.
- `app/cache_precos.py` — cache em disco das ofertas, **por carta**,
  compartilhado pelas duas fontes.
- `app/identidade.py` — monta o `User-Agent` das consultas de preço a partir
  do `SMTP_USER`/`NOTIFY_TO`, pra não ter e-mail escrito no código.
- `app/log.py` — log central: stdout + arquivo rotativo, formato `chave=valor`.
- `app/ritmo.py` — intervalo entre requisições **e a pausa global após 429**,
  compartilhados por todas as threads de uma mesma fonte.
- `app/visitas.py` — quem está no sistema, e o palpite de pessoa ou bot.
- `tests/test_bleed.py` — confere o recorte da sangria e o tamanho da carta no
  PDF (63 × 88 mm). Roda sem rede e sem pytest: `python tests/test_bleed.py`.
- `tests/test_cotacao.py` — leitura da decklist do XML e a matemática da
  cotação: `python tests/test_cotacao.py`.
- `tests/test_ligamagic.py` — decodificação do preço da LigaMagic contra uma
  página sintética: `python tests/test_ligamagic.py`.
- `tests/test_cache_precos.py` — o cache de ofertas por carta:
  `python tests/test_cache_precos.py`.
- `tests/test_tinta.py` — o pedido IPP byte a byte e a leitura da resposta,
  contra uma impressora de mentira: `python tests/test_tinta.py`.
- `tests/test_deploy.sh` — o script de publicação, com git de verdade e docker
  de mentira (inclusive o desfazer): `bash tests/test_deploy.sh`.
- `tests/test_identidade.py` — o `User-Agent` sai do `.env` e não do código:
  `python tests/test_identidade.py`.
- `tests/test_retry_log.py` — a repescagem recupera um bloco de cartas perdido
  numa rajada barrada, e um 429 segura todas as threads:
  `python tests/test_retry_log.py`.
- `tests/test_visitas.py` — classificação pessoa/bot e agrupamento de visitas:
  `python tests/test_visitas.py`.
- `tests/test_scryfall_lote.py` — o `<query>` do MPC casando com o nome
  canônico, dupla-face inclusive: `python tests/test_scryfall_lote.py`.
- `tests/test_admin_pedidos.py` — a tela de pedidos: cada rota `/admin/pedidos`
  barrando quem não tem token, o XML do deck não vazando na listagem, e o que
  cancelar / reabrir / apagar fazem de fato. Precisa do fastapi instalado:
  `python tests/test_admin_pedidos.py`.

### Rotas

| Rota | Quem chama | O que faz |
|---|---|---|
| `POST /orders` | front | cria o pedido e devolve QR + copia-e-cola |
| `GET /orders/{id}` | front | status do pedido |
| `POST /orders/{id}/notify-payment` | botão do cliente | manda o e-mail de aviso e já começa a montar o PDF (não imprime) |
| `GET /orders/{id}/pdf?token=…` | botão **Ver PDF** | monta e devolve a folha inline pra conferir (`&fresh=1` regera) |
| `GET /orders/{id}/print?token=…` | botão **Imprimir** | marca pago e manda pra fila da impressora |
| `GET /admin` | você, no navegador | a tela de pedidos (é só HTML: os dados vêm das rotas abaixo, todas com token) |
| `GET /admin/sessao` | tela de pedidos | diz se o token vale, pra tela saber se mostra a lista ou o formulário de entrada |
| `GET /admin/pedidos` | tela de pedidos | todos os pedidos, do mais novo pro mais antigo, com contagem por estado. Aceita `status=` e `busca=` |
| `GET /admin/pedidos/{id}` | tela de pedidos | um pedido só |
| `POST /admin/pedidos/{id}/status` | tela de pedidos | muda o estado na mão (`pending`, `notified`, `paid`, `cancelado`) |
| `POST /admin/pedidos/{id}/pdf` | tela de pedidos | manda montar a folha (ou diz como vai a montagem). `?fresh=true` remonta do zero |
| `POST /admin/pedidos/{id}/imprimir` | tela de pedidos | mesmo efeito do link **Imprimir** do e-mail: marca pago e manda pra fila |
| `DELETE /admin/pedidos/{id}` | tela de pedidos | apaga o pedido e o PDF de vez |
| `GET /admin/orders` | você (`X-Admin-Token`) | pedidos ainda não impressos |
| `GET /admin/printers` | você (`X-Admin-Token`) | filas que o CUPS conhece, pra descobrir o `PRINTER_QUEUE` certo |
| `POST /admin/cleanup` | você (`X-Admin-Token`) | roda a faxina dos PDFs antigos na hora |
| `GET /admin/visitas` | você (`X-Admin-Token`) | quem está no sistema agora, separado em pessoas / bots / suspeitos |
| `POST /cotacao` | botão **Cotar preços das cartas** | começa a cotar o XML e devolve o `job_id` (não cria pedido nem cobra nada). Campo opcional `commander` tira essa carta da conta |
| `GET /cotacao/{job_id}` | front | andamento ou resultado da cotação |
| `GET /impressora/tinta` | front | nível de tinta da impressora, pra pastilha do cabeçalho e o aviso de prazo (público, em cache, sem endereço nem nome de fila na resposta) |
| `GET /admin/tinta` | você (`X-Admin-Token`) | o que a impressora respondeu sobre tinta, cru — é aqui que se descobre se ela informa o nível |

## Tela de pedidos (admin)

`https://SEU-BACKEND/admin` — a mesma coisa que os links do e-mail fazem, só
que numa lista, sem depender de achar o e-mail certo na caixa de entrada. É o
que se abre no celular quando alguém manda mensagem perguntando do pedido.

### Como entra

Ela pede o `ADMIN_TOKEN` do `.env` na primeira vez e guarda no navegador
(no `sessionStorage`, que some quando a aba fecha; marcando *"Lembrar neste
navegador"*, no `localStorage`, que fica). O botão **Sair** apaga os dois.

**Onde mora a proteção:** o arquivo `admin.html` é servido como qualquer
outro estático — quem digitar o endereço vê a tela. O que ele **não** vê é
pedido nenhum: a página nasce vazia e todo dado vem das rotas `/admin/...`,
que exigem o header `X-Admin-Token`. Sem o token, a tela é uma caixa de texto
pedindo o token, e é isso. É o mesmo modelo dos links do e-mail: o que se
protege é o dado, não o layout.

Trocou a `ADMIN_TOKEN` no `.env`? A tela cai sozinha na entrada no primeiro
clique — e os links dos e-mails antigos param de valer junto.

### O que dá pra fazer

Cada pedido é um cartão com nome, valor, id, código do deck, quantidade de
cartas, páginas, laminação e quando foi criado/avisado. Os que **avisaram
pagamento** vêm com a borda dourada: é a fila do dia. Em cima, filtros por
estado e uma busca que casa com nome, id do pedido ou código do deck.

| Botão | O que faz |
|---|---|
| **Ver PDF** | abre a folha montada numa aba nova (mesmo link assinado do e-mail) |
| **Ver PDF (rede local)** | a mesma folha pelo IP do homelab, sem passar pelo túnel. Só aparece com `LOCAL_BASE_URL` no `.env` — ver *Como o PDF volta pro navegador* |
| **Montar PDF** | manda montar antes da hora e mostra o progresso ali mesmo (`12 de 60 imagens baixadas`) |
| **Refazer PDF** | remonta do zero — é o que se usa depois de arrumar uma arte no Drive |
| **Imprimir** | marca como pago e manda pra fila do CUPS. Pede confirmação |
| **Marcar pago** | confirma o Pix **sem** imprimir (pro Pix que caiu sem o cliente avisar) |
| **Cancelar** | tira da fila sem apagar nada; continua no histórico |
| **Reabrir** / **Voltar pra pendente** | desfaz um clique errado. Voltar pra pendente limpa o aviso do cliente, então ele consegue avisar de novo |
| **Apagar** | apaga o pedido, o XML do deck e o PDF. Não tem volta, e por isso pede o id digitado |

Conferir o Pix no app do banco continua sendo com você — a tela não fala com
banco nenhum, pelo mesmo motivo de sempre (ver *Como o pagamento é
confirmado*).

A lista se atualiza sozinha a cada 30 s, mas só com a aba à vista e nenhuma
confirmação aberta: redesenhar a lista embaixo de um clique é a melhor forma
de imprimir o pedido errado.

Sem `PRINTER_QUEUE` configurada, aparece um aviso no topo — ali o botão
**Imprimir** confirma o pagamento e deixa o PDF pronto, mas não manda nada
pra impressora nenhuma.

## Cotação de preços das cartas

Além de orçar a **impressão**, a tela cota quanto custaria **comprar** as
cartas de verdade. É o que responde "vale a pena proxiar?".

Aparece um botão **Cotar preços das cartas** no resumo do pedido. Ele mostra,
por carta, o menor preço em duas fontes lado a lado, e o total de cada uma.

### Como usar

1. Suba o XML do MPC Fill normalmente.
2. Se for um Commander, escolha o comandante no select. É opcional; quando
   escolhido, ele **sai da conta**, porque é assim que o **Commander 500**
   conta — o teto de preço do formato vale para o deck sem ele.
3. Clique em **Cotar preços das cartas**. Só o clique dispara a consulta —
   subir o XML sozinho não faz acesso nenhum.
4. Deck grande leva minutos (uma requisição por carta, com intervalo entre
   elas). A página mostra o andamento e pode ficar aberta.

A tabela mostra as **10 cartas mais caras** e esconde o resto atrás de um
"ver mais" — um Commander cotado inteiro passa de 60 linhas e empurraria o
total pra fora da tela.

### O que fica de fora do total (regra do Commander 500)

- **Terreno básico, sempre.** Reconhece os nomes em inglês e em português,
  com e sem "Snow-Covered" / "nevado".
- **O comandante, se você escolher um.**

Isso não é escolha de gosto: é o critério do **Commander 500**, cujo teto de
preço se aplica ao deck sem o comandante e sem os terrenos básicos. É o que
faz o total daqui ser o número que se compara com o teto — mexer nesse filtro
quebra essa comparação.

As duas coisas aparecem listadas embaixo da tabela, com o motivo. Elas não
somem caladas: um total que não cobre o deck inteiro precisa dizer por quê.

### Cache

As ofertas ficam em cache **por carta**, compartilhado pelas
duas fontes, por 12 h. Isso significa que trocar uma carta da lista só custa
aquela carta, e que dois decks parecidos aproveitam um o cache do outro —
importante porque cada carta nova é um acesso a mais na LigaMagic.

Clicar em cotar de novo refaz a conta, mas passa inteiro pelo cache e volta
em segundos, sem tocar na rede. Na prática, num deck de 12 cartas: 31 s na
primeira vez, 2 s nas seguintes — inclusive depois de trocar o comandante.

### As duas fontes

| Fonte | Mercado | Moeda | Observação |
|---|---|---|---|
| **LigaMagic** | lojas brasileiras | R$ | é o preço que interessa pra comprar aqui |
| **Scryfall / TCGplayer** | EUA | US$ | serve de comparação e de conferência |

Os dois totais **não se somam**: são mercados e moedas diferentes. A segunda
coluna está ali pra dar ordem de grandeza, pegar carta que a Liga não tem, e
denunciar se a LigaMagic começar a devolver número estranho. `USD_BRL` no
`.env` converte a coluna da Scryfall pra real só pra facilitar a leitura — é
taxa fixa que você põe na mão, sem imposto, frete nem IOF.

### Riscos conhecidos — leia antes de depender disso

**A LigaMagic não tem API e não quer ser lida por robô.** Isto não é
integração: é scraping, e contra duas travas explícitas.

1. **O `robots.txt` deles pede `Crawl-delay: 360`** — seis minutos entre
   requisições. Como é uma requisição por carta, respeitar isso ao pé da
   letra faria um deck de 20 cartas levar 2 horas. O padrão aqui é
   `LIGAMAGIC_DELAY_SEGUNDOS=3`. **Isso é uma divergência consciente do que o
   site pede**, não descuido — a decisão é de quem toca o projeto, e está
   registrada em `SCRAPING_NOTES.md`. Se for rodar isso com frequência ou
   abrir pra muita gente, converse com eles antes.
2. **O preço não vem como texto.** Vem desenhado num sprite de CSS, com a
   imagem, os nomes das classes e as coordenadas sorteados a cada requisição.
   Ler exige reconhecer os dígitos na imagem. É uma trava feita sob medida
   contra exatamente este uso.

Daí decorre o resto:

- **Vai quebrar sem aviso** quando eles mudarem qualquer coisa. Por isso o
  `ligamagic.py` levanta exceção com mensagem explicando o quê, em vez de
  devolver preço aproximado: cotação que falhou é recuperável, preço errado
  calado não. `SCRAPING_NOTES.md` tem a tabela de "que mensagem quer dizer o
  quê" e como consertar.
- **O `User-Agent` identifica o projeto e um e-mail de contato.** O endereço
  sai do `SMTP_USER` (ou, na falta dele, do `NOTIFY_TO`) que você já preenche
  pro e-mail de aviso — não tem e-mail escrito no código, então quem clonar
  o projeto não sai batendo lá com o endereço de outra pessoa. Com o `.env`
  vazio o cabeçalho ainda diz o que é, só sem contato, e o backend avisa isso
  no log. `LIGAMAGIC_USER_AGENT`/`SCRYFALL_USER_AGENT` sobrescrevem tudo.
- Se voltar `HTTP 429`, **todas** as threads daquela fonte param junto, pelo
  tempo que o `Retry-After` pedir. Ver "Quando uma carta volta sem preço".
  Se isso virar rotina, suba o `LIGAMAGIC_DELAY_SEGUNDOS` em vez de insistir.

**O total não inclui frete.** Ele é a soma da oferta mais barata de cada
carta, e cada carta pode vir de uma loja diferente — cada uma com o seu
frete. Numa cotação de 30 cartas espalhadas por 12 lojas, o custo real de
comprar é bem maior que o número mostrado. Consolidar em menos lojas costuma
sair mais barato mesmo pagando um pouco mais por carta; essa comparação ainda
não está feita.

Outras limitações menores:

- A escolha ignora HP e Danificada por padrão (`COTACAO_CONDICOES`) — sem
  isso a cotação enche de carta destruída, que é sempre a mais barata.
- O estoque é preferência, não corte: se ninguém tem as 4 cópias, ele mostra
  a mais barata mesmo assim e marca com `!` na tabela.
- A Scryfall não sabe estoque de ninguém, então a coluna dela nunca marca.

Pra desligar tudo isso, `COTACAO_LIGAMAGIC=0` (só Scryfall) ou
`COTACAO_SCRYFALL=0` (só LigaMagic).

### Quando uma carta volta sem preço

Vale distinguir dois casos, porque só um deles é problema:

- **A fonte não tem a carta.** Normal, e definitivo. Proxy de Marvel não
  existe na LigaMagic; carta nova pode não ter preço publicado ainda. Sai no
  log como `sem-oferta` / `sem-preco` e não adianta tentar de novo.
- **Não deu pra perguntar.** 429, timeout, conexão caída. É transitório, e
  era daqui que vinha o buraco grande: numa cotação de 75 cartas, **53
  voltaram vazias em blocos contíguos** — todas respondiam normalmente quando
  pedidas de novo, devagar.

O que causava aquilo eram duas coisas somadas, as duas corrigidas:

1. Cada worker descobria o 429 sozinho e recuava sozinho. Com 4 workers e 3
   tentativas de backoff curto, os quatro queimavam tudo nos mesmos segundos
   e o bloco inteiro se perdia. Agora o `Freio` (`app/ritmo.py`) é
   compartilhado: um 429 segura a fonte inteira, pelo tempo que o
   `Retry-After` pedir.
2. Não havia segunda chance. Agora `cotar` faz uma **repescagem** em série,
   depois da passada principal, só nas cartas cuja BUSCA falhou — a essa
   altura a rajada já passou. Carta que a fonte respondeu "não tenho" não
   entra, que seria bater à toa.

Medindo contra a Scryfall de verdade, o 429 vem com `Retry-After: 60`, e o
corte **não parece ser por taxa instantânea**: com o IP castigado, a conta
fecha em ~20 requisições por minuto, aconteça o que acontecer com o intervalo
entre elas. Aí `SCRYFALL_DELAY_SEGUNDOS` quase não muda nada — o que segura a
cotação de pé é o freio + repescagem, não o intervalo.

Cuidado ao repetir essa medição: **um IP que acabou de apanhar mede diferente
de um IP descansado**. O número acima saiu de uma sessão de testes que bateu
muito na API em poucos minutos, então é o pior caso, não o dia a dia. Não
calibre o `.env` por uma medição feita logo depois de uma bateria de testes.

Só que a melhor forma de sobreviver ao 429 é não provocá-lo. Ver a seção
seguinte: a Scryfall passou a resolver o deck inteiro em lote, e com ~13
requisições em vez de ~150 o limite deixou de ser alcançado.

Medição de ponta a ponta, no deck de 75 cartas que originou este conserto:

| Scryfall | antes | freio + repescagem | + busca em lote |
|---|---|---|---|
| cartas com preço | 22 de 75 | 75 de 75 | **75 de 75** |
| requisições | ~150 | ~150 | **13** |
| eventos de 429 | perdiam a carta | 11, absorvidos | **0** |
| tempo | ~20 s | 6 min 48 s | **14 s** |

E a LigaMagic, no mesmo deck de 76 cartas, depois da troca de nomes:
**75 de 76** (antes: 63), R$ 493,49, em 230 s. A que faltava era a única
carta de duas partes do deck — ver logo abaixo.

O freio e a repescagem continuam valendo: são eles que seguram as duas cartas
que ainda caem no caminho carta a carta, e a LigaMagic inteira, que não tem
busca em lote nenhuma.

A segunda cotação do mesmo deck é instantânea — o `cache_precos` guarda por
carta, com 12h de validade.

### O nome que o MPC Fill escreve não é o nome que a LigaMagic aceita

A busca da Liga é por nome **exato** (`?view=cards/card&card=...`). Medido:

```
'natures lore'   ->   0 ofertas
"Nature's Lore"  -> 245 ofertas
```

Como o `<query>` do MPC Fill derruba vírgula, apóstrofo, hífen, "!" e artigo,
**toda** carta cujo nome tenha um desses sumia da coluna da Liga em silêncio —
eram 13 num deck de 76, e nenhuma delas por falta de estoque: a Liga tinha
todas.

O conserto é usar a Scryfall como **dicionário de nomes**, não como fonte de
preço: `/cards/collection` resolve 75 nomes numa requisição, e a busca difusa
pega o resto. O `cotacao_job` troca o `<query>` pelo nome real UMA vez, antes
de qualquer fonte rodar, e daí pra frente tudo usa o nome certo:

```
'shang chi master of kung fu'  ->  'Shang-Chi, Master of Kung Fu'   0 -> 123 ofertas
'hulk smash'                   ->  'HULK SMASH!'                    0 -> 377 ofertas
'natures lore'                 ->  "Nature's Lore"                  0 -> 245 ofertas
```

Três coisas ganham junto: as duas buscas, o cache por carta (dois decks que
escrevem o mesmo nome diferente passam a dividir a entrada) e a tabela na
tela, que passa a mostrar "Nature's Lore" em vez de "natures lore".

Nome que não resolver fica como estava no XML, e se a resolução inteira
falhar a cotação segue com os nomes do XML — é melhoria pura, nunca piora o
que já funcionava. `COTACAO_RESOLVER_NOMES=0` desliga.

Repare que isso vale mesmo com `COTACAO_SCRYFALL=0`: são coisas diferentes.
Uma é mostrar a coluna de preço em dólar; a outra é saber como a carta se
chama, e essa a LigaMagic precisa tanto quanto.

#### Carta de duas partes ("A // B")

Aqui cada site faz de um jeito, e não dá pra decidir olhando só o nome:

| nome procurado | Scryfall `/cards/collection` | LigaMagic |
|---|---|---|
| `Fire // Ice` (split) | não acha | **388 ofertas** |
| `Fire` | acha | 0 |
| `Bruce Banner // The Incredible Hulk` (transformar) | não acha | 0 |
| `Bruce Banner` | acha | **164 ofertas** |

Ou seja: a Scryfall só aceita a face da frente nos dois casos, e a Liga quer
o nome inteiro na split e só a frente na de transformar. Por isso o
`/cards/collection` sempre recebe a frente (`cotacao.face_da_frente`), e a
LigaMagic tenta o nome inteiro e, se não achar nada, tenta a frente — uma
requisição a mais, só pras cartas com `//`, que são poucas. Quando isso
acontece o log diz com que nome a carta foi achada:

```
ok carta="Bruce Banner // The Incredible Hulk" achada_como="Bruce Banner" ofertas=164
```

### A busca em lote da Scryfall

O `<query>` do MPC Fill é **quase** o nome exato da carta: ele derruba caixa,
vírgula, hífen, apóstrofo e o "!" final. Acontece que o endpoint
`/cards/collection` da Scryfall ignora exatamente essas coisas — e aceita 75
identificadores por requisição. Medindo com o XML real, **73 dos 75 `<query>`
casam direto**:

```
'shang chi master of kung fu'  ->  'Shang-Chi, Master of Kung Fu'
'natures lore'                 ->  "Nature's Lore"
'go nuts'                      ->  'Go Nuts!'
```

Os dois que não casam são aqueles a que o MPC Fill tirou um artigo
(`enter unknown` para "Enter **the** Unknown"). Nenhuma normalização resolve
isso sem correr o risco de casar carta errada, então eles caem no caminho
antigo, carta a carta, onde a busca difusa do `/cards/named` acerta.

As edições saem do mesmo jeito, com um filtro só: `!"A" or !"B" or ...`. Uma
página traz 175 impressões independentemente de quantas cartas o filtro tenha,
então as ~2500 impressões de um Commander saem em ~10 páginas em vez de 75
buscas.

O lote é **atalho, não caminho**. Ele não devolve resultado: enche o
`cache_precos`, e a varredura normal carta a carta encontra tudo pronto. Se
ele falhar por qualquer motivo, a cotação segue como antes — mais lenta, mas
inteira. Por isso `scryfall.preparar` nunca levanta exceção, e
`cotacao.comparar` engole o erro e continua.

Dois detalhes que custaram teste (ver `tests/test_scryfall_lote.py`):

- **Dupla-face.** O nome canônico é `Bruce Banner // The Incredible Hulk`, mas
  o `<query>` traz só a frente. Sem indexar a face da frente separada, toda
  carta dupla-face escaparia do lote sem motivo.
- **Preço que "muda" entre requisições.** Comparando duas cotações do mesmo
  deck, o total variou US$ 0,08. Não é o lote: a mesma consulta repetida
  durante uma atualização de preços da Scryfall também diverge, e até
  `(!"Command Tower")` diverge de `!"Command Tower"` nessa janela. Se for
  comparar resultados, compare os dois na mesma janela, senão você vai caçar
  um bug que é deles.

Se preferir o caminho antigo, tire o `preparar` da fonte em
`cotacao_job.fontes_ativas()` — nada mais depende dele.

O motivo de cada falha vai pro log com o nome da carta:

```sh
grep "desisti\|nome-desconhecido\|layout-mudou\|repescando" /app/data/logs/forja.log
```

## Publicação automática (push na main → homelab)

Push na `main` publica sozinho: o GitHub avisa o homelab, ele puxa o código,
reconstrói o container e confere se a página voltou. **Se não voltar, desfaz
e volta pro commit anterior** — a página no ar vale mais que a versão nova,
ainda mais quando quem publicou já foi dormir.

```
push na main
   │
   ▼
GitHub  ──(o runner do homelab puxa o job; nada entra de fora)──►  homelab
                                                                      │
                                                deploy/atualizar.sh ──┤
                                                  git pull --ff-only  │
                                                  compose up --build  │
                                                  a página responde?  │
                                                    sim → pronto      │
                                                    não → desfaz ─────┘
```

O runner **sai** pra buscar trabalho, então nada precisa ser aberto na rede:
funciona atrás do NAT e do Cloudflare Tunnel do jeito que já está.

### Instalar o runner no homelab (uma vez)

1. No GitHub: **Settings → Actions → Runners → New self-hosted runner**,
   Linux x64. A página mostra os comandos com o token já preenchido; rode-os
   no homelab, num usuário sem sudo. Na hora do `./config.sh`, dê a etiqueta
   **`homelab`** — o workflow pede exatamente ela (`runs-on: [self-hosted,
   homelab]`), então sem a etiqueta o job fica esperando pra sempre:

   ```sh
   ./config.sh --url https://github.com/DougByte7/forja-mtg-proxy \
               --token TOKEN_DA_PÁGINA --labels homelab
   ```

2. **Diga onde o projeto mora.** Crie um `.env` na pasta do runner (não é o
   `.env` da Forja — é outro arquivo, na pasta do `actions-runner`). O runner
   injeta isso em todo job, e é o que mantém o caminho do seu servidor fora
   de um repositório público.

   **Caminho absoluto**, sempre: o job não roda no seu home, e sim em
   `_work/<repo>/<repo>`. Um `../forja-backend` que parece certo quando você
   está no terminal aponta pra outro lugar lá dentro. O workflow recusa
   caminho relativo dizendo isso, mas é melhor não esbarrar.

   ```
   FORJA_DIR=/home/SEU_USUARIO/forja-backend
   # Opcionais, quando a Forja é um serviço do compose grande do servidor:
   # FORJA_COMPOSE=/home/SEU_USUARIO/docker-compose.yml
   # FORJA_HEALTH_URL=http://localhost:8000/
   ```

   O runner lê esse `.env` **quando o serviço sobe**. Depois de editar:
   `sudo ./svc.sh stop && sudo ./svc.sh start`.

3. **Suba como serviço**, pra voltar sozinho quando a máquina reiniciar:

   ```sh
   sudo ./svc.sh install $USER
   sudo ./svc.sh start
   ```

   Com **podman rootless**, ainda falta um passo — sem ele os containers
   morrem quando você desloga e o deploy sobe num vazio:

   ```sh
   loginctl enable-linger $USER
   ```

4. **Confira o clone do servidor**: o `FORJA_DIR` tem que ser um clone git
   desta origem, com o `.env` da Forja no lugar e o `deploy/atualizar.sh`
   executável. É esse clone que o deploy atualiza — o runner nunca faz
   checkout por conta própria, justamente pra não duplicar o `.env` nem os
   volumes.

   **O remoto tem que ser HTTPS, não SSH.** O repositório é público, então
   HTTPS puxa sem chave nenhuma; SSH funcionaria quando você mesmo roda o
   comando (sua sessão tem agente de chave), mas o runner roda como serviço,
   sem agente — e falha com `Permission denied (publickey)`. Se o clone já
   existe com remoto SSH:

   ```sh
   git -C ~/forja-backend remote set-url origin \
       https://github.com/DougByte7/forja-mtg-proxy.git
   ```

   O script diz isso, com o comando pronto, se esbarrar no caso.

Depois disso, `git push` na main e acompanhe em **Actions**. O resumo do job
diz o commit que ficou em produção.

### Repositório público + runner em casa: o cuidado que isso exige

O GitHub desaconselha runner self-hosted em repositório público, e o motivo é
concreto: workflow disparado por `pull_request` roda o código do PR — código
de desconhecido — dentro da sua máquina. O
`.github/workflows/publicar.yml` **não tem gatilho de PR** (só `push` na main
e o botão manual), então PR nenhum executa nada no homelab. Duas coisas
seguram isso de pé:

- **Nunca adicione um gatilho `pull_request` a esse arquivo.** Está escrito lá
  em cima também.
- **Desligue workflow de PR de fork**: Settings → Actions → General → *Fork
  pull request workflows* → desmarque **Run workflows from fork pull
  requests**. Sem isso, um PR que ACRESCENTE um gatilho `pull_request` roda no
  homelab se alguém apertar "Approve and run" na aba Actions. Enquanto estiver
  ligado, a regra é: **não aprove PR que mexa em `.github/`**.
- O runner roda como usuário comum, **sem sudo**. Ele não precisa de root pra
  nada aqui — com podman rootless, nem pra subir o container.

### Publicar na mão

O mesmo script, sem GitHub nenhum no meio (é o caminho quando a Actions está
fora do ar, ou quando você já está no servidor):

```sh
cd /caminho/no/homelab/forja-backend
./deploy/atualizar.sh
```

Ele recusa se houver arquivo mexido na mão na pasta — o `git pull` falharia no
meio do caminho, e é melhor parar antes de mexer no container. Os parafusos
(`FORJA_COMPOSE`, `FORJA_SERVICE`, `FORJA_HEALTH_URL`, `FORJA_HEALTH_TIMEOUT`,
`FORJA_ROLLBACK`, `FORJA_PRUNE`) estão explicados no cabeçalho do próprio
script.

Um detalhe do caminho automático: quem executa é a cópia do script que **já
estava** no servidor, porque é ela quem faz o `git pull`. Mudança no
`atualizar.sh` vale a partir da publicação seguinte, nunca na mesma.

### Limpeza das imagens

Cada rebuild deixa a imagem anterior sem tag, e num servidor de casa isso
vira dezenas de GB em alguns meses. O script limpa as sobras no fim de cada
publicação bem-sucedida, filtrando por `label=app=forja-backend` (a etiqueta
está no `Dockerfile`) — as imagens dos outros serviços da máquina não são
tocadas. `FORJA_PRUNE=0` desliga.

## Logs

Duas saídas: o `stdout` (que é o `docker logs -f forja-backend`) e arquivos
rotativos em `LOG_DIR`, que por padrão é `/app/data/logs` — dentro do volume,
pra sobreviver ao restart do container. Se o diretório não puder ser criado,
fica só o stdout: log que não grava não derruba o backend.

Dois arquivos, porque as visitas são muitas e repetitivas e afogariam o log
de erro se ficassem juntas:

| Arquivo | O que tem |
|---|---|
| `forja.log` | tudo — cotação, preços, falhas, visitas |
| `visitas.log` | só quem chegou e quem saiu |

O formato é `chave=valor`, pra ser lido com `grep` no terminal:

```
14:43:59 WARNING forja.scryfall  freio segundos=60.0 motivo="HTTP 429" carta="shang chi"
14:45:01 INFO    forja.scryfall  ok carta="natures lore" canonico="Nature's Lore" ofertas=22 ms=721
14:45:01 INFO    forja.cotacao/scryfall fim cartas=75 cotadas=75 faltando=0 segundos=64
```

Perguntas que isso responde:

```sh
# por que faltou preço na última cotação?
grep " fim \| job-fonte " /app/data/logs/forja.log | tail -20
# quais cartas a fonte não conseguiu ler, e por quê?
grep "desisti\|nome-desconhecido\|layout-mudou" /app/data/logs/forja.log
# estamos apanhando de rate limit?
grep "freio" /app/data/logs/forja.log | tail
# quem esteve no site hoje, sem contar robô?
grep "classe=pessoa" /app/data/logs/visitas.log
```

`LOG_NIVEL=DEBUG` acrescenta cada requisição HTTP e cada acerto de cache.
Serve pra caçar problema; é barulhento demais pro dia a dia.

### Visitas: pessoa ou bot

Uma pessoa abrindo a página gera dezenas de requisições (HTML, CSS, fonte,
os polls da cotação); um crawler gera uma e some. Por isso o log não conta
requisição, conta **visita**: mesmo IP + mesmo User-Agent dentro de
`VISITA_JANELA_MINUTOS` são a mesma pessoa, anunciada uma vez (`chegou`) e
resumida uma vez quando esfria (`saiu`, com o que ela fez e quanto ficou).

O IP real vem do `CF-Connecting-IP` — `request.client.host` seria o IP do
túnel da Cloudflare, igual pra todo mundo, e faria todas as visitas virarem
uma só. `VISITA_ANONIMIZAR_IP=1` corta o último octeto se você preferir.

A classificação é **palpite**, e o log diz em que sinal se baseou justamente
pra ninguém tratar como fato:

| Classe | Como decide | Confiança |
|---|---|---|
| `bot-conhecido` | se identifica no User-Agent (Googlebot, GPTBot, curl, python-requests, HeadlessChrome…) | alta — ninguém mente pra *parecer* robô |
| `pessoa` | mandou os cabeçalhos que só navegador manda (`Sec-Fetch-*`, `Accept-Language`, `sec-ch-ua`) | boa |
| `suspeito` | diz ser navegador mas não manda o que navegador manda | é o bot disfarçado — e também o navegador muito antigo |

Nada aqui bloqueia nada; é só pra enxergar o movimento. Um bot que copie os
cabeçalhos de um Chrome passa por gente, e isso não tem conserto do lado do
servidor.

Pra ver quem está online agora sem abrir terminal:

```sh
curl -H "X-Admin-Token: SEU_TOKEN" http://localhost:8000/admin/visitas
```

## Quando a impressão falha

Se o `lp` recusar o trabalho, o link Imprimir devolve **502** com o erro do
CUPS na tela e uma dica do que fazer — ele nunca diz "enviado pra impressora"
sem ter enviado. O pedido continua marcado como **pago** (clicar em Imprimir
significa "conferi o Pix", e isso não deixa de ser verdade porque a
impressora caiu) e o PDF continua pronto no disco: resolva a impressora e
abra o mesmo link de novo, ou imprima pelo celular usando o link "Ver PDF".

Pra diagnosticar, de dentro do container:

```
curl -H "X-Admin-Token: SEU_TOKEN" https://SEU-BACKEND/admin/printers
```

Ele devolve `filas` (os nomes que o CUPS conhece), `configurada_existe`
(se o `PRINTER_QUEUE` do `.env` bate com algum) e uma `dica` quando o
lpstat reclama.

**`Scheduler is not running`** não é problema de nome de fila — é o CUPS não
atendendo no endereço configurado. No servidor do CUPS:

```
systemctl status cups        # o cupsd está no ar?
ss -lntp | grep 631          # em que endereço ele escuta?
```

Se aparecer só `127.0.0.1:631`, o cupsd está no padrão: **só aceita conexão
local**. Dois caminhos:

1. **O forja-backend roda na mesma máquina do CUPS** (mais simples, e não
   expõe o cupsd na rede): monte o socket no container e deixe `CUPS_HOST`
   **vazio** no `.env`. Tem a linha pronta, comentada, no
   `docker-compose.snippet.yml`:
   ```yaml
   volumes:
     - /run/cups/cups.sock:/run/cups/cups.sock
   ```
2. **Rodam em máquinas diferentes**: aí o cupsd precisa escutar na rede. Em
   `/etc/cups/cupsd.conf`, troque `Listen localhost:631` por `Port 631` e
   libere as redes que vão imprimir (a sua LAN e a do container):
   ```
   <Location />
     Order allow,deny
     Allow from 192.168.0.0/24
     Allow from 172.18.0.0/16
   </Location>
   ```
   Depois `systemctl restart cups` e compartilhe a fila com
   `lpadmin -p NOME_DA_FILA -o printer-is-shared=true`.

## Aviso de tinta baixa

Ao lado do título da página aparece uma pastilha com o nível de tinta, e
quando ele está no fim entra um aviso avisando que **a produção pode levar 1
a 2 semanas** — antes do orçamento, pra quem vai pagar ler antes de pagar.

Quem sabe o nível é o CUPS, nos atributos `marker-*` da fila (são eles que
desenham a barrinha de tinta na interface web dele). O `lpstat` não mostra
isso: a pergunta é IPP, e o `app/tinta.py` monta esse pedido na mão pra não
precisar do `ipptool`, que não vem no `cups-client`. A resposta fica em cache
(`TINTA_CACHE_SEGUNDOS`, 24 h) porque a rota é pública — cada visita não
pode virar uma pergunta nova pra impressora, e nível de tinta não muda de
hora em hora. O cache mora na memória: reiniciar o container zera na hora,
que é o que se faz depois de reabastecer de qualquer jeito.

**Nem toda impressora responde**, e a L4260 é justamente do tipo que
costuma não responder: impressora de tanque não tem chip no tanque pra medir
nada, então ela estima por contador de página ou devolve "não sei". Quando
ninguém sabe, a pastilha **não aparece** e a página fica como sempre foi —
mostrar "tinta ok" sem ter medido seria pior que não mostrar nada.

Pra saber de que lado a sua está:

```
curl -H "X-Admin-Token: SEU_TOKEN" https://SEU-BACKEND/admin/tinta
```

`informa_nivel: true` e a página se vira sozinha. Se vier `false` (ou
`atributos` sem nenhum `marker-*`), o caminho é a mão — quem enche o tanque
olha e escreve no `.env`:

```
TINTA_ESTADO=baixo     # liga o aviso; "ok" cala; vazio = automático
```

Ele ganha da impressora sempre: quem olhou o tanque viu melhor que o
contador de páginas. Não esqueça de tirar depois de reabastecer — é a única
parte disto que não se corrige sozinha.

Os outros parafusos, todos opcionais: `TINTA_LIMITE` (padrão 20, o % abaixo
do qual a tinta conta como baixa, usado só quando a impressora não informa o
limite dela), `TINTA_CACHE_SEGUNDOS` e `TINTA_TIMEOUT_SEGUNDOS` (padrão 4 —
curto de propósito: impressora dormindo não pode segurar o carregamento da
página).

## Qualidade de impressão

Duas metades independentes:

**No PDF** — as imagens entram como JPEG `JPEG_QUALITY` (95) com subamostragem
de cor desligada (4:4:4). Subamostragem é o que borra borda fina e texto pequeno
de carta, por isso fica desligada. O teto de nitidez é a imagem de origem: uma
de 800 px de largura dá ~323 DPI em 63 mm, que é o padrão de foto. Impressora
nenhuma inventa detalhe acima disso.

`PRINT_DPI` reamostra pra um teto antes de montar, e o `.env` vem com **600**.
As artes do MPC Fill chegam com ~3264 px de largura, que viram ~2976 px depois
de tirada a sangria — ~1200 DPI em 63 mm, 4x além do que a impressora resolve;
os outros 3/4 só engordam o arquivo. Medido com as artes reais: **3,6 MB por
carta em resolução original, 1,1 MB em 600 DPI**. Num pedido grande é a
diferença entre um PDF de ~200 MB e um de ~60 MB subindo pelo link de casa, com
o papel idêntico. `PRINT_DPI=0` desliga e mantém a resolução do Drive.

O gerador também desliga o **ASCII85** do reportlab (`rl_config.useA85 = 0`).
Os JPEGs já entram sem recompressão (o stream sai como `DCTDecode`, a imagem
passa intacta), mas por padrão o reportlab embrulha cada stream em ASCII85 —
que é texto, e infla os bytes em exatamente 1,25x. Num arquivo que é quase só
imagem, isso era 25% de peso morto sem um pixel de qualidade em troca, e ainda
custava tempo de montagem (codificar em A85 é a parte cara do `drawImage`).
Stream binário é PDF válido e todo leitor entende.

### A sangria do MPC Fill (por que a carta saía menor)

A arte que o MPC Fill guarda no Drive **não é a carta**: é o gabarito de
impressão da MakePlayingCards, 2,72 × 3,70 pol (69,1 × 94,0 mm), com **3,05 mm
de sangria em cada borda**. Na fábrica esse contorno vai embora no refile e
sobram os 2,48 × 3,46 pol (63 × 88 mm) do meio.

Enfiar essa arte inteira no slot de 63 × 88 mm imprime a sangria junto e
encolhe a carta: o desenho sai com **57,5 × 82,4 mm**, e ainda espremido,
porque a sangria come 4,4% da largura contra 3,2% da altura. Era exatamente o
sintoma de "carta pequena" — e nenhum ajuste de impressora conserta, porque o
erro já está dentro do PDF.

Então cada imagem tem a sangria recortada antes de entrar no PDF, **uma a uma,
na escala dela** (as artes chegam em resoluções diferentes, então o corte é uma
fração das dimensões da imagem, nunca um número fixo de pixels). A decisão é
por imagem, pela proporção:

| Proporção da imagem | O que acontece |
|---|---|
| ~0,735 (gabarito 2,72 × 3,70) | recorta 4,41% da largura e 3,24% da altura em cada borda |
| ~0,717 (carta 2,48 × 3,46) | passa intacta — já veio cortada, recortar de novo comeria a arte |
| qualquer outra | passa intacta e avisa no log; é arte de fora do MPC Fill |

| Variável | Padrão | O que faz |
|---|---|---|
| `CROP_BLEED` | `1` | `0` desliga o recorte e volta a carta pequena; só serve pra comparar |
| `BLEED_RATIO_TOL` | `0.01` | folga na proporção pra imagem ainda contar como gabarito |

Pra conferir no papel: depois de recortada, uma carta impressa tem que medir
**63 × 88 mm** na régua, igual a uma carta de verdade.

Pra conferir sem gastar papel, `tests/test_bleed.py` monta um PDF com artes
sintéticas e lê de volta o tamanho com que cada carta foi desenhada:

```
python tests/test_bleed.py
```

Não precisa de rede (o download é substituído) nem de pytest; só do Pillow e
do reportlab que já estão no `requirements.txt`. Sai com código 1 se alguma
checagem falhar.

### Download das imagens

Cada arte é baixada do Drive **uma vez por pedido**, mesmo aparecendo em vários
slots (playset de 4, verso repetido na folha inteira), e as imagens do pedido
baixam em paralelo (`DRIVE_WORKERS`, 4). Falha de rede é retentada com espera
crescente (`DRIVE_RETRIES`/`DRIVE_BACKOFF`); id inexistente ou arquivo sem
compartilhamento público falha na hora, sem insistir.

### O link "Ver PDF" não espera a montagem

Pedido grande leva minutos pra montar, e o edge da Cloudflare corta a
requisição em ~100s — era o `context canceled` no log do `cloudflared`. Então
`GET /orders/{id}/pdf` **não** monta o PDF dentro da requisição: ele dispara a
montagem numa thread e responde na hora com uma página que se atualiza sozinha
a cada 5s, mostrando quantas imagens já baixaram. Quando o arquivo fica pronto,
a mesma URL passa a servir o PDF.

O refresh dessa página aponta pra URL **sem** o `fresh=1`, senão cada
atualização pediria uma remontagem e o pedido nunca terminaria.

Na prática você quase nunca vê essa página de espera: a montagem já começou no
`notify-payment`, enquanto o e-mail saía e você conferia o Pix no banco. É a
mesma montagem — quando o link "Ver PDF" chega, ele acompanha a que está
rodando ou serve o arquivo já pronto, sem baixar nada do Drive de novo.

Duas requisições pro mesmo pedido **não** montam o PDF em paralelo: a segunda
espera a primeira e reaproveita o arquivo dela. Sem isso, abrir o link duas
vezes (ou o navegador tentando de novo porque demorou) dobrava as conexões com
o Drive e ainda deixava dois `canvas.save()` escrevendo no mesmo arquivo.

Imagem que não baixou vira uma carta "FALHA NO DOWNLOAD" bem visível no PDF.
Pra tentar de novo, use o link **"montar de novo"** (`fresh=1`) do e-mail — a
página de auto-refresh não pode remontar sozinha, senão entraria em loop num
pedido que sempre falha.

#### Quando der `Read timed out`

`DRIVE_READ_TIMEOUT` conta por trecho recebido, não pelo download inteiro: é
um detector de conexão **morta**, não um orçamento de lentidão. Download lento
nunca esbarra nele, então **aumentar o valor não resolve** — se estourou, a
conexão parou de entregar byte por um minuto inteiro, e o problema é a rede da
máquina, não o Drive nem o gerador. Sinal que confirma: o `cloudflared` da
mesma máquina reclamando junto (`no recent network activity`).

Pra achar onde trava, rode o diagnóstico de dentro do container:

```
docker compose exec -T forja-backend python - < diag_rede.py
```

Ele mede MTU, DNS (IPv4 x IPv6) e baixa as imagens sozinha e em paralelo,
mostrando a maior pausa sem receber byte. A saída explica como ler o resultado.
Se só o paralelo travar, o link está saturando: baixe `DRIVE_WORKERS` pra 2.

**Na impressora** — via `LP_OPTIONS`. Os nomes são os do **PPD da sua fila**,
não os nomes IPP genéricos. Descubra os seus com:

```
lpoptions -p forja-mtg-proxy -l
```

**Opção com nome errado é ignorada em silêncio** — a folha sai, só que
errada, e nada no log avisa. Os valores abaixo são os da EPSON L4260 criada
com `-m everywhere`:

| Opção | Pra quê |
|---|---|
| `print-scaling=none` | **não mexa** — sem ela a impressora encolhe a folha ~4% e as cartas saem fora de medida. Não é do PPD: é atributo do CUPS |
| `PageSize=A4` | o padrão da L4260 é **Letter**; sem isso a folha sai reposicionada |
| `MediaType=Photographic` | papel fotográfico comum. Também aceita `PhotographicGlossy`, `PhotographicHighGloss`, `PhotographicSemiGloss`, `PhotographicMatte` |
| `cupsPrintQuality=High` | `Draft` / `Normal` / `High` |
| `ColorModel=RGB` | o outro valor é `Gray` |

⚠️ **Nunca use `A4.Borderless`.** Impressão sem margem amplia a imagem 2–3%
pra garantir sangria — exatamente o que tira a carta dos 63×88 mm. A folha
já tem 10,5 mm de margem lateral de propósito.

### Como o PDF volta pro navegador

O arquivo é grande e sobe por um link doméstico, então a entrega importa tanto
quanto a montagem. `GET /orders/{id}/pdf` faz três coisas que o `FileResponse`
do Starlette 0.38 não faz sozinho:

**Range.** A resposta anuncia `Accept-Ranges: bytes` e atende pedido de faixa
com `206`. Sem isso o visualizador não consegue ler o índice do fim do arquivo
pra desenhar a primeira página antes do resto: ele baixa **tudo** e só então
mostra alguma coisa — e conexão que cai no meio recomeça do zero em vez de
retomar. Faixa fora do arquivo devolve `416`; várias faixas de uma vez caem pro
arquivo inteiro, que é resposta legítima e poupa o `multipart/byteranges`.

**Revalidação.** O `Cache-Control` era `no-store`, e cada reabertura da mesma
folha pagava o download inteiro de novo. Agora é `private, max-age=0,
must-revalidate` com ETag (mtime + tamanho do arquivo): reabrir custa um `304`
de uns poucos bytes enquanto nada mudou, e o "Refazer PDF" troca o ETag
sozinho, então não há como o navegador mostrar uma folha velha. O `If-Range`
também é conferido — retomar um download pela metade só vale se for o mesmo
arquivo, senão sairia um PDF emendado de duas montagens diferentes.

**Link da rede local.** Com `LOCAL_BASE_URL` no `.env`, o e-mail de aviso e a
tela do admin ganham um botão **"Ver PDF (rede local)"** ao lado do "Ver PDF"
normal. É a mesma folha, com o mesmo token assinado, mas pelo IP do homelab: o
link público manda o arquivo até a Cloudflare e traz de volta, ou seja, gasta a
subida doméstica duas vezes pra chegar numa máquina que está do lado. Fora de
casa esse botão não abre — o de fora continua sendo o "Ver PDF" normal.

`tests/test_pdf_range.py` trava esse comportamento (faixas, 416, 304,
`If-Range`, e a porta continuar exigindo token). Roda sem rede:

```
python tests/test_pdf_range.py
```

## Limpeza automática dos PDFs

Os PDFs ficam em cache em `PDF_OUTPUT_DIR` (`/app/data`, o mesmo volume do
banco) pra que "Ver PDF" e "Imprimir" usem exatamente o mesmo arquivo. Uma
faxina roda no start e depois a cada `CLEANUP_INTERVAL_HOURS`, apagando todo
PDF gerado há mais de `PDF_KEEP_DAYS` dias.

**Apagar é sempre reversível**: o XML do pedido continua guardado no banco
pra sempre, então abrir o link "Ver PDF" ou "Imprimir" de um pedido antigo
remonta a folha na hora — o único custo é baixar as imagens do Drive de novo.
Por isso a regra é por idade do arquivo, sem se importar com o status do
pedido.

| Variável | Padrão | O que faz |
|---|---|---|
| `PDF_KEEP_DAYS` | `30` | dias que o PDF fica no disco; `0` desliga a limpeza |
| `CLEANUP_INTERVAL_HOURS` | `24` | de quanto em quanto tempo a faxina roda |

A faxina só toca em arquivos `pedido-*.pdf` (e nos marcadores
`.incompleto`). O `orders.db` mora na mesma pasta e nunca é tocado. Pra
rodar na hora, sem esperar o ciclo:

```
curl -X POST -H "X-Admin-Token: SEU_TOKEN" https://SEU-BACKEND/admin/cleanup
```

## Guias de corte

A folha sai com dois tipos de marca, na mesma ideia do
[proxyprint](https://proxyprint.taxiera.net/):

1. **Marcas nas margens**, alinhadas com cada divisa da grade 3×3. Você
   encosta a régua (ou o refile) em duas marcas opostas e corta a folha
   inteira de uma vez. Ficam fora das cartas, sem tinta na arte.
2. **Cruz-guia verde em cada canto de carta** (os 16 cruzamentos da grade),
   essa sim por cima da arte. Ela marca o ponto exato onde os dois cortes se
   encontram — ajuda a perceber se a folha entrou enviesada na impressora, e
   some junto com a sobra depois do corte.

Dá pra ajustar tudo pelo `.env`, sem mexer no código:

| Variável | Padrão | O que faz |
|---|---|---|
| `GUIDE_LENGTH_MM` | `0` | comprimento da marca de margem; `0` estende até a borda do papel, `5` deixa marca curta de canto |
| `GUIDE_THICKNESS_MM` | `0.2` | espessura da linha de margem |
| `GUIDE_GRAY` | `0` | `0` preto, `1` branco |
| `CORNER_CROSSES` | `1` | `0` desliga as cruzes nos cantos |
| `CROSS_COLOR` | `#8aff0c` | cor das cruzes |
| `CROSS_ARM_MM` | `3` | tamanho de cada braço do `+` (6 mm de ponta a ponta) |
| `CROSS_THICKNESS_MM` | `0.2` | espessura das cruzes |
| `CARD_OUTLINE` | `0` | `1` volta a moldura em volta de cada carta (não recomendado) |

**Na hora de imprimir, desligue "ajustar à página" e use "tamanho real"
(100%)** — tanto no CUPS quanto no app do celular. É o erro mais comum:
o ajuste automático encolhe a folha uns 4% e as cartas saem fora de medida.

Se a carta sair menor mesmo com "tamanho real", o problema não é a impressora:
é a sangria do MPC Fill dentro do PDF — veja
[A sangria do MPC Fill](#a-sangria-do-mpc-fill-por-que-a-carta-saía-menor).

## Limitação conhecida do download de imagens

O `pdf_generator.py` baixa as imagens direto do Google Drive pelo ID que já
vem no XML. Isso não é uma API oficial — funciona bem na maioria dos casos,
mas pode falhar por limite de taxa do Google ou pela tela de aviso de vírus
em arquivos grandes. Se isso virar problema com pedidos maiores, o caminho
mais robusto é trocar por uma service account da API oficial do Google
Drive.
