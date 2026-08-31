# Forja de Proxies — backend

Recebe o XML do MPC Fill, gera a cobrança Pix (QR + copia-e-cola) com a sua
própria chave, recebe o aviso de pagamento do próprio cliente por e-mail e,
com um clique seu no link **Imprimir** desse e-mail, gera o PDF A4 buscando
as imagens no Google Drive e manda direto pra fila da impressora na rede.

O front-end (`app/static/index.html`) é servido pelo próprio backend —
não precisa de outro container nem configurar URL nenhuma. Ao abrir
`http://IP-DO-SERVIDOR:8000/` (ou o domínio do seu Cloudflare Tunnel) já
cai direto na "Forja de Proxies" chamando a API na mesma origem.

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

O clique do cliente não imprime nada nem marca nada como pago — é só um
aviso. Alguém clicar no botão sem ter pago não te custa papel nenhum.

Como é só pra você e seus amigos, o valor da cobrança **não é mexido** — fica
exatamente o preço calculado (o que quer dizer que pedidos diferentes vão
colidir no mesmo valor com frequência, já que o preço só depende do número de
páginas). Por isso cada pedido carrega o **nome** de quem pediu e um **hash
curto do deck** (baseado nos nomes das cartas do XML): é assim que você sabe
qual Pix da sua lista corresponde a qual e-mail.

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
   - `CUPS_HOST` e `PRINTER_QUEUE` — endereço do CUPS na rede
     (`IP-DO-SERVIDOR:631`, ou vazio pra falar pelo socket local) e o nome da
     fila da sua impressora.
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

5. **Teste antes de usar de verdade**: gere um pedido de teste, escaneie o QR
   com seu próprio celular (ou com um segundo app bancário) e confirme que
   o valor e a chave batem antes de mandar pra qualquer cliente.

## Estrutura

- `app/static/index.html` — o front-end (a Forja de Proxies), servido pelo
  próprio FastAPI.
- `app/pix.py` — monta o BR Code (QR Pix) na mão, sem provedor.
- `app/calc.py` — mesma lógica de páginas/custo do artifact, em Python.
- `app/storage.py` — pedidos em SQLite, com nome de quem pediu e hash do deck
  (`status`: `pending` → `notified` → `paid`).
- `app/pdf_generator.py` — baixa as imagens do Drive e monta o PDF A4 3x3. Os
  versos de carta dupla-face saem **um por cópia**, igual ao que o `calc.py`
  cobra e ao que a prévia mostra.
- `app/fulfillment.py` — assina os links do e-mail, faz cache do PDF e roda
  o job de impressão.
- `app/notify.py` — manda o e-mail de aviso com o resumo e os links.
- `app/printer.py` — envia o PDF pra fila CUPS.
- `app/cleanup.py` — apaga os PDFs antigos do disco de tempos em tempos.
- `app/main.py` — API que costura tudo.
- `tests/test_bleed.py` — confere o recorte da sangria e o tamanho da carta no
  PDF (63 × 88 mm). Roda sem rede e sem pytest: `python tests/test_bleed.py`.

### Rotas

| Rota | Quem chama | O que faz |
|---|---|---|
| `POST /orders` | front | cria o pedido e devolve QR + copia-e-cola |
| `GET /orders/{id}` | front | status do pedido |
| `POST /orders/{id}/notify-payment` | botão do cliente | manda o e-mail de aviso e já começa a montar o PDF (não imprime) |
| `GET /orders/{id}/pdf?token=…` | botão **Ver PDF** | monta e devolve a folha inline pra conferir (`&fresh=1` regera) |
| `GET /orders/{id}/print?token=…` | botão **Imprimir** | marca pago e manda pra fila da impressora |
| `GET /admin/orders` | você (`X-Admin-Token`) | pedidos ainda não impressos |
| `GET /admin/printers` | você (`X-Admin-Token`) | filas que o CUPS conhece, pra descobrir o `PRINTER_QUEUE` certo |
| `POST /admin/cleanup` | você (`X-Admin-Token`) | roda a faxina dos PDFs antigos na hora |

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

## Qualidade de impressão

Duas metades independentes:

**No PDF** — as imagens entram como JPEG `JPEG_QUALITY` (95) com subamostragem
de cor desligada (4:4:4), por padrão na resolução original do Drive (`PRINT_DPI=0`).
Subamostragem é o que borra borda fina e texto pequeno de carta, por isso fica
desligada. O teto de nitidez é a imagem de origem: uma de 800 px de largura dá
~323 DPI em 63 mm, que é o padrão de foto. Impressora nenhuma inventa detalhe
acima disso.

`PRINT_DPI` reamostra pra um teto antes de montar. As artes do MPC Fill vêm com
~3264 px de largura, que viram ~2976 px depois de tirada a sangria — ~1200 DPI
em 63 mm, 4x além do que a impressora resolve. Medido com as artes reais: **3,6 MB por carta com `PRINT_DPI=0`, 1,1 MB
com `PRINT_DPI=600`**. Num pedido grande é a diferença entre um PDF de ~200 MB e
um de ~60 MB atravessando o túnel, e o papel fica igual.

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
