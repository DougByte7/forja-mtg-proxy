"""
Cotação de preço de uma decklist: dada a lista de cartas e uma função que
sabe buscar ofertas de UMA carta, escolhe a oferta mais barata de cada uma e
soma o total.

De propósito não sabe de onde vêm os preços. Quem busca é a função
`buscar_ofertas` que chega por parâmetro — assim esta parte é testável sem
rede e não precisa mudar se a fonte de preço mudar (veja `SCRAPING_NOTES.md`
pra situação da LigaMagic, que é o motivo de este módulo já nascer separado
de qualquer cliente).

LIMITAÇÃO CONHECIDA: o "menor total" daqui é a soma da oferta mais barata de
cada carta, **ignorando frete**. Como cada carta pode sair de uma loja
diferente, o custo real de comprar pode ser bem maior — cada loja cobra seu
próprio frete. Consolidar numa loja só costuma sair mais barato mesmo pagando
um pouco mais por carta, e essa comparação não está feita aqui.
"""
import re
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from . import log


@dataclass(frozen=True)
class Oferta:
    """Uma carta à venda numa loja. `preco` é o unitário, em reais."""
    loja: str
    preco: float
    condicao: str = ""      # M, NM, SP, MP, HP, D
    idioma: str = ""
    edicao: str = ""
    quantidade: int = 0     # estoque; 0 = a fonte não informou
    link: str = ""
    extras: str = ""        # Foil, Alterada, ...


class CartaNaoEncontrada(Exception):
    """A fonte respondeu, mas não tem essa carta."""


class _Contador:
    """Conta cartas já buscadas e avisa quem quiser acompanhar.

    Existe porque a busca roda em várias threads: sem a trava, duas cartas
    terminando juntas perdem uma contagem e a barra de progresso trava
    faltando um pouco pro fim.
    """

    def __init__(self, on_progress, total: int):
        self._on_progress, self._total = on_progress, total
        self._feitas, self._trava = 0, threading.Lock()

    def passo(self):
        if not self._on_progress:
            return
        with self._trava:
            self._feitas += 1
            feitas = self._feitas
        try:
            self._on_progress(feitas, self._total)
        except Exception:
            pass  # progresso é enfeite; nunca pode derrubar a cotação


# --------------------------------------------------------------------------
# O que fica de fora da cotação
# --------------------------------------------------------------------------
# Terreno básico e comandante ficam de fora porque é ASSIM QUE A REGRA DO
# COMMANDER 500 CONTA: o teto de preço do formato vale só para o resto do
# deck. Não é uma escolha de gosto nossa — é o que faz o total daqui bater
# com o número que decide se a lista é legal no formato. Mexer nisso quebra
# a comparação com o teto.
#
# (Sai de graça um efeito colateral bom: são ~35 terrenos a menos por deck
# de Commander, ou seja, ~35 requisições a menos na LigaMagic.)
#
# Nomes em inglês e português porque o `<query>` do MPC Fill é o que a pessoa
# digitou lá, e isso varia.
BASICAS = frozenset({
    # inglês
    "plains", "island", "swamp", "mountain", "forest", "wastes",
    "snow-covered plains", "snow-covered island", "snow-covered swamp",
    "snow-covered mountain", "snow-covered forest", "snow-covered wastes",
    # português (já sem acento: a comparação passa por `normalizar_nome`)
    "planicie", "ilha", "pantano", "montanha", "floresta", "terra devastada",
    "planicie nevada", "ilha nevada", "pantano nevado",
    "montanha nevada", "floresta nevada",
})


def normalizar_nome(nome: str) -> str:
    """Nome comparável: sem acento, sem caixa, sem sufixo entre parênteses.

    O `<query>` do MPC Fill é texto livre — vem "Sol Ring", "sol ring" e às
    vezes "Sol Ring (C17)". Sem essa normalização, escolher o comandante na
    tela não casaria com a carta no XML por causa de um acento ou de um
    sufixo de edição.
    """
    limpo = " ".join(str(nome or "").split()).lower()
    limpo = re.sub(r"\s*\([^)]*\)\s*$", "", limpo)
    sem_acento = unicodedata.normalize("NFKD", limpo)
    return "".join(c for c in sem_acento if not unicodedata.combining(c)).strip()


def e_basica(nome: str) -> bool:
    return normalizar_nome(nome) in BASICAS


def filtrar_cotaveis(cartas, comandante: str | None = None):
    """Separa a decklist em `(cotaveis, excluidas)`, seguindo o Commander 500.

    Ficam de fora o terreno básico e, se apontado, o comandante. Esse é o
    critério do formato, não uma preferência nossa: no Commander 500 o teto
    de preço se aplica ao deck SEM eles. Por isso o total que sai daqui é o
    número que se compara com o teto.

    As excluídas são DEVOLVIDAS, não descartadas em silêncio: quem olha um
    orçamento precisa ver o que não entrou na conta, senão o total parece
    menor do que é sem explicação.
    """
    alvo = normalizar_nome(comandante) if comandante else None
    cotaveis, excluidas = [], []
    for carta in cartas:
        norma = normalizar_nome(carta["nome"])
        if alvo and norma == alvo:
            excluidas.append({**carta, "motivo": "comandante"})
        elif norma in BASICAS:
            excluidas.append({**carta, "motivo": "terreno básico"})
        else:
            cotaveis.append(carta)
    return cotaveis, excluidas


def escolher_oferta(ofertas, quantidade: int = 1,
                    condicoes_aceitas=None) -> Oferta | None:
    """A oferta mais barata que serve, ou None se nenhuma servir.

    "Que serve" é, em ordem de importância:

    1. Estar numa condição aceita, se `condicoes_aceitas` foi passado. Quem
       vai jogar com a carta normalmente não quer HP nem Danificada, e essas
       são justamente as mais baratas — sem esse filtro a cotação inteira
       enche de carta destruída.
    2. Ter estoque pra quantidade pedida. Adianta pouco a loja mais barata do
       Brasil se ela tem 1 cópia e você precisa de 4.

    O estoque é uma preferência, não um corte: se NENHUMA oferta tem estoque
    suficiente, volta a mais barata mesmo assim, porque comprar 3 de uma loja
    e 1 de outra continua sendo possível — só não é o que esta v1 calcula. A
    condição, essa sim, é corte de verdade: carta em estado que não serve não
    vira compra.

    Estoque 0 significa "a fonte não informou", então conta como suficiente —
    senão uma fonte que não expõe estoque perderia todas as ofertas boas.
    """
    candidatas = list(ofertas)
    if condicoes_aceitas is not None:
        aceitas = {c.upper() for c in condicoes_aceitas}
        candidatas = [o for o in candidatas if o.condicao.upper() in aceitas]
    if not candidatas:
        return None

    com_estoque = [o for o in candidatas
                   if o.quantidade == 0 or o.quantidade >= quantidade]
    return min(com_estoque or candidatas, key=lambda o: o.preco)


def cotar(cartas, buscar_ofertas, condicoes_aceitas=None, workers: int = 1,
          on_progress=None, repescagem: int = 1, rotulo: str = "") -> dict:
    """Cota uma decklist inteira.

    `cartas`: lista de `{"nome", "quantidade"}` — exatamente o que o
    `calc.parse_card_list` devolve a partir do XML do MPC Fill.

    `buscar_ofertas`: função `nome -> list[Oferta]`. Pode levantar exceção ou
    devolver lista vazia; nos dois casos a carta cai em `nao_encontradas` e a
    cotação SEGUE com as outras. Uma carta que a fonte não conhece não pode
    derrubar o orçamento inteiro — quem pediu 40 cartas prefere ver 39
    cotadas e uma marcada como faltando.

    `workers` só paraleliza a BUSCA; a escolha da oferta e a ordem da saída
    continuam determinísticas. Quem controla o ritmo de verdade é cada
    cliente (a LigaMagic tem um intervalo mínimo global entre requisições),
    então subir isto não atropela ninguém — só deixa uma fonte lenta e uma
    rápida andarem juntas.

    `repescagem` é quantas passadas EXTRA fazer só nas cartas cuja busca
    falhou. Existe porque a falha típica de fonte pública não é permanente:
    é uma rajada barrada (429) ou um timeout, e ela derruba um BLOCO de
    cartas seguidas — as que estavam em voo naquele minuto. Numa cotação
    real de 75 cartas, 53 voltaram sem preço em três blocos contíguos, e
    todas respondiam normalmente quando pedidas de novo, devagar.

    A repescagem roda em série (um worker) e só depois da passada principal:
    a essa altura a rajada já passou e a fonte já liberou. Carta que a fonte
    respondeu "não tenho" NÃO entra — repescar isso seria bater de novo à toa.
    Só entra falha de BUSCA, que é a que pode ser transitória.

    Os itens saem ordenados do subtotal maior pro menor. O que interessa
    olhando um orçamento é onde o dinheiro está indo, e isso é o subtotal
    (4x R$ 10 pesa mais que 1x R$ 30), não o preço unitário — que vai junto
    na resposta pra quem quiser reordenar.
    """
    cartas = list(cartas)
    total_cartas = len(cartas)
    feitas = _Contador(on_progress, total_cartas)
    canal = f"cotacao/{rotulo}" if rotulo else "cotacao"
    inicio = time.monotonic()

    def buscar(carta, contar: bool = True):
        try:
            return list(buscar_ofertas(carta["nome"])), None
        except Exception as e:
            # A mensagem carrega o TIPO da exceção. Sem isso, "falha na
            # busca: " com uma exceção de mensagem vazia (acontece) virava
            # uma linha sem informação nenhuma na tela e no log.
            return None, f"falha na busca: {type(e).__name__}: {e}"
        finally:
            if contar:
                feitas.passo()

    if workers > 1 and total_cartas > 1:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            resultados = list(pool.map(buscar, cartas))
    else:
        resultados = [buscar(c) for c in cartas]

    # ---- repescagem: só o que falhou na BUSCA, em série ----
    for rodada in range(1, max(0, repescagem) + 1):
        pendentes = [i for i, (_, erro) in enumerate(resultados)
                     if erro is not None]
        if not pendentes:
            break
        log.aviso(canal, "repescando", rodada=rodada, cartas=len(pendentes),
                  de=total_cartas)
        recuperadas = 0
        for i in pendentes:
            ofertas, erro = buscar(cartas[i], contar=False)
            if erro is None:
                resultados[i] = (ofertas, None)
                recuperadas += 1
            else:
                # Guarda o erro NOVO, não o antigo: se a primeira falha foi
                # 429 e a segunda foi "não existe", quem lê o log precisa da
                # segunda.
                resultados[i] = (None, erro)
        log.evento(canal, "repescagem-fim", rodada=rodada,
                   recuperadas=recuperadas, ainda_falhando=len(pendentes) - recuperadas)

    itens, nao_encontradas = [], []
    for carta, (ofertas, erro) in zip(cartas, resultados):
        nome = carta["nome"]
        quantidade = int(carta.get("quantidade", 1))
        if erro is not None:
            nao_encontradas.append({"nome": nome, "quantidade": quantidade,
                                    "motivo": erro})
            continue

        melhor = escolher_oferta(ofertas, quantidade, condicoes_aceitas)
        if melhor is None:
            motivo = ("nenhuma oferta na condição pedida"
                      if ofertas else "sem oferta encontrada")
            nao_encontradas.append({"nome": nome, "quantidade": quantidade,
                                    "motivo": motivo})
            continue

        itens.append({
            "nome": nome,
            "quantidade": quantidade,
            "preco_unitario": round(melhor.preco, 2),
            "subtotal": round(melhor.preco * quantidade, 2),
            "loja": melhor.loja,
            "condicao": melhor.condicao,
            "idioma": melhor.idioma,
            "edicao": melhor.edicao,
            "extras": melhor.extras,
            "link": melhor.link,
            "estoque_suficiente": (melhor.quantidade == 0
                                   or melhor.quantidade >= quantidade),
            "ofertas_consideradas": len(ofertas),
        })

    itens.sort(key=lambda i: (-i["subtotal"], -i["preco_unitario"], i["nome"]))

    # Um resumo por fonte, com os motivos AGRUPADOS. É a linha que responde
    # "por que faltou preço?" sem precisar ler 75 linhas de detalhe.
    motivos: dict[str, int] = {}
    for c in nao_encontradas:
        chave = c["motivo"].split(":")[0].strip()
        motivos[chave] = motivos.get(chave, 0) + 1
    log.evento(canal, "fim", cartas=total_cartas, cotadas=len(itens),
               faltando=len(nao_encontradas),
               motivos=", ".join(f"{k} x{v}" for k, v in
                                 sorted(motivos.items(), key=lambda kv: -kv[1]))
                       or None,
               segundos=int(time.monotonic() - inicio))

    return {
        "itens": itens,
        "nao_encontradas": nao_encontradas,
        "total": round(sum(i["subtotal"] for i in itens), 2),
        "cartas_cotadas": sum(i["quantidade"] for i in itens),
        "cartas_faltando": sum(c["quantidade"] for c in nao_encontradas),
        "lojas_distintas": len({i["loja"] for i in itens}),
        # Deixa explícito na resposta o que o total NÃO inclui, pra quem
        # consumir a API não somar frete por engano em cima disso.
        "inclui_frete": False,
    }


def comparar(cartas, fontes, condicoes_aceitas=None, on_progress=None) -> dict:
    """Cota a mesma decklist em várias fontes e devolve uma linha por carta
    com o preço de cada uma lado a lado.

    `fontes`: lista de dicts com `id`, `rotulo`, `moeda`, `buscar` (a função
    `nome -> list[Oferta]`) e, opcional, `workers`, `observacao` e
    `preparar`.

    `preparar` é uma função `lista de nomes -> None` que a fonte pode oferecer
    pra adiantar o trabalho em lote antes da varredura carta a carta (a
    Scryfall resolve 75 nomes numa requisição só). Ela NÃO devolve resultado:
    enche o cache da fonte, e a varredura normal encontra tudo pronto. Assim o
    lote é otimização pura — se falhar, a cotação segue igual, só mais lenta.

    As fontes rodam em paralelo entre si. Isso importa na prática: a
    LigaMagic tem intervalo mínimo obrigatório entre requisições e leva
    minutos num deck grande, enquanto a Scryfall responde em milissegundos —
    esperar uma pra começar a outra só faria o usuário olhar pra tela por
    mais tempo.

    NÃO SOME OS TOTAIS DE FONTES DIFERENTES. Cada uma tem sua moeda e seu
    mercado; o total de cada uma vem separado, com a moeda junto, de
    propósito.
    """
    fontes = list(fontes)
    cartas = list(cartas)
    contador = _Contador(on_progress, len(cartas) * len(fontes))

    def rodar(fonte):
        preparar = fonte.get("preparar")
        if preparar:
            try:
                preparar([c["nome"] for c in cartas])
            except Exception as e:
                # Nunca derruba a cotação: o lote é atalho, não o caminho.
                log.aviso(f"cotacao/{fonte['id']}", "preparar-falhou",
                          motivo=f"{type(e).__name__}: {e}")
        return cotar(cartas, fonte["buscar"], condicoes_aceitas,
                     workers=fonte.get("workers", 1),
                     on_progress=lambda *_: contador.passo(),
                     repescagem=fonte.get("repescagem", 1),
                     rotulo=fonte["id"])

    if len(fontes) > 1:
        with ThreadPoolExecutor(max_workers=len(fontes)) as pool:
            resultados = list(pool.map(rodar, fontes))
    else:
        resultados = [rodar(f) for f in fontes]

    por_fonte = {f["id"]: r for f, r in zip(fontes, resultados)}

    # Uma linha por carta, na ordem da decklist original, com o que cada
    # fonte achou (ou o motivo de não ter achado).
    linhas = []
    for carta in cartas:
        nome = carta["nome"]
        linha = {"nome": nome, "quantidade": int(carta.get("quantidade", 1)),
                 "precos": {}}
        for fonte in fontes:
            r = por_fonte[fonte["id"]]
            achado = next((i for i in r["itens"] if i["nome"] == nome), None)
            if achado:
                linha["precos"][fonte["id"]] = achado
            else:
                falha = next((c for c in r["nao_encontradas"]
                              if c["nome"] == nome), None)
                linha["precos"][fonte["id"]] = {
                    "erro": falha["motivo"] if falha else "sem resultado"}
        linhas.append(linha)

    # Ordena pelo subtotal na PRIMEIRA fonte (a principal). Carta que só a
    # segunda achou vai pro fim em vez de sumir — quem olha o orçamento
    # precisa ver que ela existe e que a fonte principal não a tem.
    principal = fontes[0]["id"] if fontes else None

    def peso(linha):
        p = linha["precos"].get(principal) or {}
        return -(p.get("subtotal") or 0)

    linhas.sort(key=lambda l: (peso(l), l["nome"]))

    return {
        "fontes": [{
            "id": f["id"],
            "rotulo": f["rotulo"],
            "moeda": f.get("moeda", "BRL"),
            "observacao": f.get("observacao", ""),
            "total": por_fonte[f["id"]]["total"],
            "cartas_cotadas": por_fonte[f["id"]]["cartas_cotadas"],
            "cartas_faltando": por_fonte[f["id"]]["cartas_faltando"],
            "lojas_distintas": por_fonte[f["id"]]["lojas_distintas"],
            "nao_encontradas": por_fonte[f["id"]]["nao_encontradas"],
        } for f in fontes],
        "linhas": linhas,
        "cartas_distintas": len(cartas),
        "copias_total": sum(int(c.get("quantidade", 1)) for c in cartas),
        "inclui_frete": False,
    }
