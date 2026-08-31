# Cotador LigaMagic — notas da investigação (Fase 1)

Spike feito em 31/08/2026 contra `www.ligamagic.com.br`. Nada aqui virou
código ainda: o objetivo era descobrir se dá pra ler preço por loja de forma
automatizada e, principalmente, **a que custo**.

Resumo em uma linha: os dados estão todos lá, sem login, mas a LigaMagic
embaralha os preços de propósito a cada requisição, e o `robots.txt` pede 6
minutos entre requisições. Os dois pontos estão detalhados no fim, em
[Veredito](#veredito).

---

## 1. Onde estão os dados

URL da carta (a mesma que o site usa):

```
https://www.ligamagic.com.br/?view=cards/card&card=Sol+Ring
```

- `HTTP 200`, ~707 KB de HTML, **sem login e sem paywall**.
- `?view=cards/card` **não** está bloqueado no `robots.txt`.
- Não tem AJAX: a listagem inteira de ofertas já vem no HTML da primeira
  resposta, dentro de blocos `<script>`. Uma requisição por carta resolve.
- Só o `Sol Ring` traz **1233 ofertas** e **168 lojas** numa única página.

### Variáveis JS que interessam

| Variável | O que é |
|---|---|
| `var cards_stock = [...]` | as ofertas, uma por loja/edição/qualidade |
| `var cards_stores = {...}` | as lojas, indexadas por `lj_id` |
| `var cards_editions = [...]` | as edições da carta (nome, código, raridade, imagem) |
| `var dataQuality = [...]` | `1=M, 2=NM, 3=SP, 4=MP, 5=HP, 6=D` |
| `var dataLanguage = [...]` | idiomas (`id` → label + sigla) |
| `var dataExtras = [...]` | `2=Foil`, `31=Foil Etched`, `29=Alterada`, ... |

Todas casam com o regex `var NOME = (...);\n`.

### Uma oferta (`cards_stock`)

```json
{
  "id": 31673586,
  "idEdicao": "480968",
  "num": "212",
  "qualid": "2",
  "idioma": "2",
  "extras": 0,
  "lj_id": 840739,
  "lj_uf": "SP",
  "sellType": 1,
  "quantFilter": 30,
  "precoCss": "zZpMe pNuDn vWsDf;V;dQnEq vWsDf pNuDn;sBgVo vWsDf pNuDn",
  "quantCss": "bPrLn qGuTeZ eFoXm",
  "is_graded": 0
}
```

Repare: **não existe campo `preco`**. E `quantFilter` não é o estoque — é a
faixa do filtro da interface (essa oferta tem `quantFilter: 30` e estoque
real 4).

### Uma loja (`cards_stores`, chave = `lj_id` como string)

```json
{
  "lj_name": "Moinho Games",
  "lj_cidade": "São Paulo",
  "lj_uf": "SP",
  "lj_selo": 2,
  "lj_recesso": 0,
  "lj_ref": "5",
  "lj_ref_qtd": 3
}
```

---

## 2. Como o preço é escondido

Preço e quantidade **não são texto**. São desenhados como sprite de CSS:
cada dígito é uma janelinha de 7x15 px recortada de um PNG de 600x84 com
dígitos espalhados.

O `precoCss` é a lista de classes, um grupo por dígito, separados por `;`,
com `V` no lugar da vírgula:

```
"zZpMe pNuDn vWsDf" ; "V" ; "dQnEq vWsDf pNuDn" ; "sBgVo vWsDf pNuDn"
      7                ,            8                     1              → R$ 7,81
```

Dentro de cada grupo as três classes têm papéis diferentes, e é isso que dá
pra generalizar:

| Papel | Como reconhecer | Exemplo |
|---|---|---|
| Caixa do dígito | `{width:7px;float:left;height:15px;}` | `vWsDf` (preço), `bPrLn` (qtd) |
| Qual sprite usar | `{background-image:url(...)}` | `pNuDn` → `.../imgnum/...` (preço)<br>`eFoXm` → `.../imgunid/...` (quantidade) |
| **Qual dígito** | `{background-position:-200px -23px;}` | `zZpMe` → `7` |

As regras ficam num `<style>` inline (~1,3 KB) no próprio HTML. São exatamente
20 regras de `background-position`: 10 dígitos do sprite de preço e 10 do de
quantidade, sem sobreposição entre os dois conjuntos.

Ou seja: pra ler o preço é preciso **baixar o PNG do sprite e reconhecer qual
dígito está em cada posição** — não tem tabela pronta em lugar nenhum da
página.

## 3. E tudo isso roda a cada requisição

Baixei a **mesma URL do Sol Ring duas vezes** e comparei:

| | 1ª carga | 2ª carga |
|---|---|---|
| Sprite de preço | `260422pH68yyw66g4vh0f57y95239i5vx4cj.jpg` | `260422pO48l5i09b0d4an9jitq16d1k44psf.jpg` |
| Nomes das classes | `zZpMe`, `dQnEq`, `sBgVo`... | `hUaFi`, `tMqDl`, `zJuFx`... |
| Posições no sprite | `-200 -23`, `-56 -23`, ... | `-112 -23`, `-64 -23`, ... |
| Conjuntos coincidem? | **não** | **não** |

Nome do arquivo, nomes das classes **e** as coordenadas dentro do sprite:
muda tudo, toda vez. Não dá pra decorar mapeamento nenhum — cada requisição
exigiria baixar o sprite novo e fazer OCR dos 10 dígitos antes de conseguir
ler qualquer preço.

Decodifiquei as duas cargas na mão pra confirmar que o esquema é esse mesmo:
**959 ofertas decodificadas nas duas, preço idêntico em todas as 959,
divergência zero.** O mecanismo está entendido e os números batem:

```
R$   7,81  NM  Moinho Games          Marvel Super Heroes Commander
R$   7,82  NM  MTG Brasil            Marvel Super Heroes Commander
R$   7,90  NM  Overrun Geek Store    Marvel Super Heroes Commander
...
R$ 949,90      LANZA TCG             Revised Edition (BB)
```

### A ofuscação é PARCIAL — parte das ofertas vem com preço em texto

Esta foi a descoberta mais útil da implementação, e ela não apareceu na
primeira leitura porque eu só estava procurando `precoCss`. Contando as
ofertas de loja (`sellType: 1`) na página do Sol Ring:

| Campo | Ofertas | Como ler |
|---|---:|---|
| `precoCss` | 959 | sprite, precisa de OCR |
| `precoFinal` | 217 | **texto puro** (`"precoFinal":"1080.00"`) |

E não é só uma amostra pequena: em carta menos anunciada a proporção vira.
`Underground Sea` veio com as 33 ofertas em `precoFinal`, **nenhuma**
ofuscada. Quando os dois campos aparecem juntos, `preco` é o valor cheio
riscado na tela e `precoFinal` é o com desconto — quem compra paga o
`precoFinal`.

Consequência prática: `ligamagic.py` usa o texto quando ele está lá e só cai
no OCR quando não está. Isso ampliou a cobertura de 958 para 1175 ofertas no
Sol Ring, e **derrubou o preço mínimo encontrado** em várias cartas (o
`Sensei's Divining Top` passou de R$ 152,98 pra R$ 140,25) — ou seja, ler só
o `precoCss` estava perdendo justamente ofertas boas.

A quantidade em estoque (`quantCss`) continua sempre ofuscada.

### `sellType: 2` também vem em texto puro — mas é leilão

Existe um terceiro grupo, com um campo `price` limpo:

```json
{"sellType":2,"id":5614641,"title":"[SLD362] 1x Anel Solar / Sol Ring",
 "price":"83.90","priceInc":"1.00","bids":0,
 "dtEnd":"2026-08-31 12:24:02","owner":"Kopke","lj_uf":"RJ"}
```

Os campos entregam o que é: `bids`, `priceInc` (incremento do lance) e
`dtEnd` (fim). É o **bazar/leilão**, não loja — o preço ali é lance de um
usuário, não oferta firme, e sobe até o encerramento. Fica de fora da
cotação, e ainda por cima `?view=bzr/` está no `Disallow` do `robots.txt`.

## 4. `robots.txt`

```
User-agent: *
Crawl-delay: 360
Disallow: /index.php
Disallow: /*?view=cards/pricehistory
...
```

- `?view=cards/card` **é permitido**. `?view=cards/pricehistory` não é.
- **`Crawl-delay: 360` = 6 minutos entre requisições.** Como é uma requisição
  por carta, um deck de 20 cartas distintas levaria **2 horas** respeitando o
  pedido. Um Commander de 99 levaria ~10 horas.
- Não tem `Sitemap`. O arquivo inteiro tem 37 linhas.

---

## Decisão tomada

Foi decidido seguir com o scraping, com OCR do sprite e **sem** respeitar o
`Crawl-delay: 360`, e somar a Scryfall como segunda fonte. O que está no
código, e por quê:

| | |
|---|---|
| `LIGAMAGIC_DELAY_SEGUNDOS` | 3 s por padrão, não 360. Divergência consciente do que o site pede. |
| `LIGAMAGIC_USER_AGENT` | identifica o projeto e um e-mail de contato tirado do `SMTP_USER`/`NOTIFY_TO` do `.env` (nunca escrito no código) — se eles quiserem falar, ou bloquear, que seja pelo caminho fácil |
| Cache de 12 h em disco | carta já cotada não é rebuscada |
| Deduplicação por deck | dois cliques no mesmo deck caem no mesmo job; nada é varrido duas vezes |
| Disparo só por clique | subir o XML não cota nada; quem só quer orçar impressão não gera acesso nenhum |
| Teto de 200 cartas | impede uma lista gigante virar meia hora de acessos |
| Sai de fininho no 429 | se eles pedirem pra ir devagar, o retry espera 5x mais |

Os riscos continuam de pé e estão no README: isso não é API, contraria o
`robots.txt` deles, e **quebra sem aviso** quando o site mudar. Por isso o
`ligamagic.py` levanta exceção com mensagem explícita em vez de devolver
preço aproximado — cotação que falhou é recuperável, preço errado calado não.

### O que a Scryfall resolve e o que não resolve

Resolve: é API oficial, sem trava nenhuma, responde em milissegundos e serve
de conferência — se a LigaMagic começar a devolver número estranho, a coluna
do lado denuncia. Também pega carta que a Liga não tem.

Não resolve: os preços são TCGplayer/Cardmarket, em dólar, do mercado
americano. **Não são o custo de comprar no Brasil** e não dá pra somar com o
total da Liga. `USD_BRL` no `.env` converte pra real só pra facilitar a
leitura lado a lado; é taxa fixa que você põe na mão, não inclui imposto,
frete nem IOF, e não busca câmbio em lugar nenhum.

### Perguntas da Fase 1 que a implementação respondeu

- **Dupla face**: busca pelo nome da frente funciona. `Delver of Secrets`
  devolveu 363 ofertas normalmente.
- **Acento e entidade HTML**: os textos vêm com entidade dentro do JSON
  (`Campe&otilde;es de Kamigawa`); `ligamagic.py` passa `html.unescape`.
- **Carta inexistente**: HTTP 200 com a página de busca vazia (~34 KB), sem
  NENHUMA das variáveis. `var param` existe em toda página de carta e em
  nenhuma página de busca — é ela que separa "não existe" de "layout mudou".
- **Carta que existe mas ninguém vende** (`Ancestral Recall` na maior parte
  do tempo): a página não traz o `<style>` dos dígitos, porque não tem preço
  pra mostrar. Tem que sair antes de procurar o sprite, senão vira erro falso.
- **Preço de 4+ dígitos**: os caros que vi vieram todos em `precoFinal`, em
  texto. O caminho do OCR com milhar está coberto por teste sintético
  (`tests/test_ligamagic.py`), não por carta real.

### Se um dia isso quebrar

O sintoma vai ser `LigaMagicError` com uma destas mensagens:

| Mensagem | O que mudou | O que fazer |
|---|---|---|
| "não reconheci o dígito ... distância N" | trocaram a fonte dos números | refazer os bitmaps de `_TEMPLATES` a partir do sprite novo |
| "não achei as regras de sprite no `<style>`" | mudaram o jeito de esconder | reler a seção 2 daqui contra a página nova |
| "não achei `var cards_stock`" | renomearam as variáveis | achar o nome novo |
| "grupo de dígito inesperado" | mudaram a estrutura do `precoCss` | reler a seção 2 |

## Reprodução

Os artefatos do spike (HTML das duas cargas, sprites, filmstrips dos dígitos)
ficaram fora do repositório — foram gerados em `/tmp`. Pra refazer:

```sh
curl -A "Mozilla/5.0 ..." "https://www.ligamagic.com.br/?view=cards/card&card=Sol+Ring" -o carta.html
grep -o 'var cards_stock = .\{0,300\}' carta.html
grep -o '<style>.*</style>' carta.html
```
