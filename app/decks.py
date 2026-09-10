"""
Decks de Commander: as regras do formato e onde eles ficam guardados.

SEM LOGIN, COMO O RESTO DO SISTEMA. Não existe conta de usuário aqui (ver o
README, "Meus Pedidos"), e inventar uma só pro deckbuilder seria a maior
mudança do projeto por causa da menor tela dele. Então vale a mesma regra dos
pedidos: **quem tem o id, mexe**. O navegador guarda a lista de decks daquela
pessoa no `localStorage`; o servidor guarda os decks e não sabe de quem são.

A diferença pro pedido é o tamanho do id: 12 dígitos hex em vez de 8. Um
pedido chutado por sorte só pode ser cancelado (e isso fica no histórico);
um deck chutado por sorte pode ser REESCRITO, e o estrago aí é o trabalho de
montar o deck. 12 dígitos custam nada e tiram a força bruta da mesa.

DOIS TABULEIROS E UMA GAVETA DE CATEGORIAS. O deck tem `cartas` (o que se
joga) e `maybeboard` (o que ainda está em dúvida). São listas separadas no
banco, e não uma marca dentro da mesma lista, porque a diferença entre elas é
justamente NÃO participar: o maybeboard fica de fora da contagem das 100, da
validação, de toda análise e — o que a pessoa mais nota — da cotação. Lista
separada é a única forma de isso não depender de ninguém lembrar de filtrar.

A categoria de cada carta é organização de quem monta ("combo principal",
"sac outlet") e mora na própria entrada; quando está vazia, a tela cai na
categoria que sai do tipo da carta. `categorias` guarda os nomes criados à
mão, na ordem escolhida — inclusive os vazios, senão uma categoria recém
criada sumiria antes de receber a primeira carta.

`Sideboard` é a única categoria embutida que muda a conta: ela fica fora das
100 (um deck com sideboard não pode viver acusando "5 cartas além das 100"),
mas continua dentro da cotação e da lista de impressão — é carta que a pessoa
quer ter. É o que separa o sideboard do maybeboard, e é a única regra a mais
que as categorias trazem.

A VALIDAÇÃO NÃO IMPEDE DE SALVAR. Deck pela metade é o estado normal de quem
está montando: um deck de 40 cartas não é um erro, é terça-feira. Por isso
`validar` DESCREVE o que está fora da regra, e é a tela que decide o tom —
"faltam 43 cartas" é barra de progresso, não mensagem de erro. Quem chama
nunca é impedido de gravar.
"""
import json
import os
import sqlite3
import time
import uuid

from . import cartas as base_cartas
from . import log

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")

# Um Commander tem 100 cartas. O teto aqui é o dobro com folga: existe pra
# impedir que alguém grave uma lista de 50 mil linhas no banco, não pra
# policiar quem está montando.
MAX_ENTRADAS = 400
MAX_COPIAS = 99
TAMANHO_DECK = 100

# Categorias feitas à mão. O teto existe pelo mesmo motivo do MAX_ENTRADAS:
# impedir que alguém grave uma lista sem fim no banco, não policiar quem
# organiza o próprio deck.
MAX_CATEGORIAS = 40
TAMANHO_CATEGORIA = 40

# A categoria embutida que fica fora das 100. Está num conjunto, e não num
# `== "Sideboard"` espalhado, porque quem for acrescentar outra (uma
# "Considerando" que também não conte, por exemplo) precisa mexer num lugar
# só — e porque a tela lê esta mesma regra do outro lado.
CATEGORIA_SIDEBOARD = "Sideboard"
CATEGORIAS_FORA_DA_CONTA = {CATEGORIA_SIDEBOARD}


def _conn():
    pasta = os.path.dirname(DB_PATH)
    if pasta:
        os.makedirs(pasta, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = _conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS decks (
                id TEXT PRIMARY KEY,
                nome TEXT,
                comandantes TEXT,
                cartas TEXT,
                maybeboard TEXT,
                categorias TEXT,
                criado_em REAL,
                atualizado_em REAL
            )
        """)
        # Banco criado antes do maybeboard não tem as duas colunas novas, e
        # `CREATE TABLE IF NOT EXISTS` não as acrescenta. Ler o PRAGMA e
        # emendar o que falta é o que faz um deck salvo mês passado continuar
        # abrindo — sem isso o deploy quebra em cima dos decks que já existem.
        colunas = {l["name"] for l in conn.execute("PRAGMA table_info(decks)")}
        for coluna in ("maybeboard", "categorias", "dono"):
            if coluna not in colunas:
                conn.execute(f"ALTER TABLE decks ADD COLUMN {coluna} TEXT")
        # `dono` nasce NULL em todo deck que já existe, e é isso mesmo: todos
        # eles são órfãos até alguém reclamar. O índice serve à única consulta
        # que filtra por dono ("os meus"), que roda a cada abertura da lista.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_decks_dono ON decks(dono)")
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------------


def limpar_categoria(bruta) -> str:
    """O nome de categoria como ele vai pro banco: aparado e com teto.

    Vazio é um valor legítimo e o mais comum: quer dizer "sem categoria à
    mão", e aí quem agrupa a carta é o tipo dela.
    """
    return str(bruta or "").strip()[:TAMANHO_CATEGORIA]


def limpar_cartas(cartas) -> list[dict]:
    """Normaliza a lista que veio da tela e junta repetições.

    Levanta `ValueError` no que não dá pra consertar sozinho. Duas cartas com
    o mesmo nome viram uma linha com a soma — a tela não deveria mandar
    assim, mas se mandar, o deck salvo continua fazendo sentido. Quando as
    duas trazem categoria, vale a da primeira: juntar "combo principal" com
    "sac outlet" num nome só inventaria uma categoria que ninguém criou.
    """
    if not isinstance(cartas, list):
        raise ValueError("A lista de cartas precisa ser uma lista.")
    if len(cartas) > MAX_ENTRADAS:
        raise ValueError(f"Deck com mais de {MAX_ENTRADAS} linhas distintas — "
                         f"isso não é um Commander.")

    juntas: dict[str, dict] = {}
    for item in cartas:
        if not isinstance(item, dict):
            raise ValueError("Cada carta precisa ser um objeto com nome e "
                             "quantidade.")
        nome = str(item.get("nome") or "").strip()
        if not nome:
            continue
        bruta = item.get("quantidade")
        # `bruta or 1` estaria errado: zero é uma quantidade que a tela manda
        # de propósito (a carta que acabou de ser zerada), e o `or` a
        # transformaria em 1 — devolvendo pro deck a carta que saiu dele.
        if bruta is None or bruta == "":
            bruta = 1
        try:
            quantidade = int(bruta)
        except (TypeError, ValueError):
            raise ValueError(f"Quantidade inválida em {nome!r}.")
        if quantidade <= 0:
            continue
        if quantidade > MAX_COPIAS:
            raise ValueError(f"{nome}: {quantidade} cópias é mais do que "
                             f"cabe num deck.")
        categoria = limpar_categoria(item.get("categoria"))
        chave = base_cartas.normalizar(nome)
        if chave in juntas:
            juntas[chave]["quantidade"] += quantidade
            if categoria and not juntas[chave]["categoria"]:
                juntas[chave]["categoria"] = categoria
        else:
            juntas[chave] = {"nome": nome, "quantidade": quantidade,
                             "categoria": categoria}
    return list(juntas.values())


def limpar_categorias(categorias, cartas=None, maybeboard=None) -> list[str]:
    """Os nomes de categoria criados à mão, sem repetição e na ordem que vieram.

    As categorias que as cartas usam entram mesmo que a tela tenha esquecido
    de mandá-las na lista: uma categoria referida por uma carta e ausente
    daqui viraria um grupo órfão na tela, com cartas dentro e sem jeito de
    renomear ou apagar. Aqui isso se conserta calado, que é o único lugar
    onde as duas informações se encontram.

    `Sideboard` fica de fora: ela é embutida, aparece sozinha e não é da
    pessoa pra renomear ou apagar.
    """
    if categorias is None:
        categorias = []
    if isinstance(categorias, str):
        categorias = [categorias]
    if not isinstance(categorias, list):
        raise ValueError("As categorias precisam vir numa lista.")

    usadas = [c.get("categoria") for lista in (cartas or [], maybeboard or [])
              for c in lista if isinstance(c, dict)]
    limpas: list[str] = []
    vistas: set[str] = set()
    for nome in list(categorias) + usadas:
        nome = limpar_categoria(nome)
        if not nome or nome in CATEGORIAS_FORA_DA_CONTA:
            continue
        chave = base_cartas.normalizar(nome)
        if chave in vistas:
            continue
        vistas.add(chave)
        limpas.append(nome)
        if len(limpas) >= MAX_CATEGORIAS:
            break
    return limpas


def cartas_contadas(deck: dict) -> list[dict]:
    """As cartas do deck que valem pras 100 — sem o sideboard.

    É o que toda análise consome (curva, mana base, bracket, combos): o
    sideboard é carta que a pessoa quer ter, não carta que ela vai jogar, e
    contá-la na curva descreveria um deck que não existe. Quem quer TUDO o
    que se compra usa `deck["cartas"]` direto, como faz a cotação.
    """
    return [c for c in deck.get("cartas") or []
            if (c.get("categoria") or "") not in CATEGORIAS_FORA_DA_CONTA]


def limpar_comandantes(comandantes) -> list[str]:
    if comandantes is None:
        return []
    if isinstance(comandantes, str):
        comandantes = [comandantes]
    if not isinstance(comandantes, list):
        raise ValueError("Os comandantes precisam vir numa lista.")
    limpos = []
    for nome in comandantes:
        nome = str(nome or "").strip()
        if nome and nome not in limpos:
            limpos.append(nome)
    if len(limpos) > 2:
        raise ValueError("Um deck tem no máximo dois comandantes (parceiros).")
    return limpos


# ---------------------------------------------------------------------------
# Persistência
# ---------------------------------------------------------------------------


def _tem_coluna(conn, nome: str) -> bool:
    """Se a tabela `decks` já passou pela migração que traz esta coluna.

    Existe porque o banco de um deploy antigo é lido pelo código novo antes de
    o `init_db` rodar (um teste que chama `criar` direto, por exemplo), e uma
    consulta que cita coluna inexistente não avisa: derruba a rota inteira com
    `no such column`.
    """
    return nome in {l["name"] for l in conn.execute("PRAGMA table_info(decks)")}


def _linha_para_deck(linha: sqlite3.Row) -> dict:
    # `linha.keys()` e não acesso direto: um banco que ainda não passou pela
    # migração do `init_db` (um teste que chama `criar` antes dela, por
    # exemplo) não tem as colunas novas, e um KeyError aqui derrubaria a
    # leitura de decks que estão perfeitamente legíveis sem elas.
    tem = set(linha.keys())
    return {
        "id": linha["id"],
        "nome": linha["nome"] or "Deck sem nome",
        "comandantes": json.loads(linha["comandantes"] or "[]"),
        "cartas": json.loads(linha["cartas"] or "[]"),
        "maybeboard": json.loads(
            (linha["maybeboard"] if "maybeboard" in tem else None) or "[]"),
        "categorias": json.loads(
            (linha["categorias"] if "categorias" in tem else None) or "[]"),
        "criado_em": linha["criado_em"],
        "atualizado_em": linha["atualizado_em"],
        # A coluna só nasce com o login. Enquanto não existe, todo deck é
        # órfão — que é a verdade sobre eles, não um campo faltando.
        "dono": (linha["dono"] if "dono" in tem else None),
    }


def _guardaveis(cartas, maybeboard, categorias) -> tuple[list, list, list]:
    """As três listas normalizadas juntas — sempre juntas.

    `limpar_categorias` precisa ver as cartas já limpas pra recolher a
    categoria que alguma delas use e a lista não traga; separar isso deixaria
    o `criar` e o `salvar` com duas versões da mesma costura.
    """
    limpas = limpar_cartas(cartas or [])
    talvez = limpar_cartas(maybeboard or [])
    return limpas, talvez, limpar_categorias(categorias, limpas, talvez)


def criar(nome: str = "", comandantes=None, cartas=None, maybeboard=None,
          categorias=None, dono: str | None = None) -> dict:
    """Cria um deck. `dono` é opcional e vem de quem está logado, se houver.

    Anônimo cria deck órfão, e órfão é um estado normal, não um defeito: é
    como todo deck deste sistema existiu até o login aparecer, e continua
    sendo o que acontece pra quem prefere não ter conta.
    """
    deck_id = uuid.uuid4().hex[:12]
    agora = time.time()
    limpas, talvez, cats = _guardaveis(cartas, maybeboard, categorias)
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO decks (id, nome, comandantes, cartas, maybeboard, "
            "categorias, criado_em, atualizado_em, dono) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (deck_id, (nome or "").strip() or "Deck sem nome",
             json.dumps(limpar_comandantes(comandantes)),
             json.dumps(limpas), json.dumps(talvez), json.dumps(cats),
             agora, agora, dono or None))
        conn.commit()
    finally:
        conn.close()
    return obter(deck_id)


def obter(deck_id: str) -> dict | None:
    conn = _conn()
    try:
        linha = conn.execute("SELECT * FROM decks WHERE id=?",
                             (deck_id,)).fetchone()
        return _linha_para_deck(linha) if linha else None
    finally:
        conn.close()


def salvar(deck_id: str, nome: str, comandantes, cartas, maybeboard=None,
           categorias=None) -> dict | None:
    """Grava o deck inteiro por cima do que estava. `None` se não existe."""
    limpas, talvez, cats = _guardaveis(cartas, maybeboard, categorias)
    conn = _conn()
    try:
        mudou = conn.execute(
            "UPDATE decks SET nome=?, comandantes=?, cartas=?, maybeboard=?, "
            "categorias=?, atualizado_em=? WHERE id=?",
            ((nome or "").strip() or "Deck sem nome",
             json.dumps(limpar_comandantes(comandantes)),
             json.dumps(limpas), json.dumps(talvez), json.dumps(cats),
             time.time(), deck_id)).rowcount
        conn.commit()
    finally:
        conn.close()
    return obter(deck_id) if mudou else None


def duplicar(deck_id: str) -> dict | None:
    """Cópia com id novo — é o "fork" de quem quer variar um deck sem perder
    o original, e o único jeito de "salvar como" num sistema sem login.

    As artes escolhidas vão junto: escolher arte é o trabalho mais chato de um
    deck, e quem duplica quer a cópia igual — inclusive nisso.
    """
    original = obter(deck_id)
    if not original:
        return None
    copia = criar(f"{original['nome']} (cópia)", original["comandantes"],
                  original["cartas"], original.get("maybeboard"),
                  original.get("categorias"))
    # Import local: `decks` é o módulo de baixo, e `artes` já importa `cartas`
    # como ele. No topo, os dois se enxergariam num ciclo.
    from . import artes
    artes.copiar(deck_id, copia["id"])
    return obter(copia["id"])


def apagar(deck_id: str) -> bool:
    conn = _conn()
    try:
        apagados = conn.execute("DELETE FROM decks WHERE id=?",
                                (deck_id,)).rowcount
        conn.commit()
    finally:
        conn.close()
    if apagados:
        # Senão a tabela de artes cresce pra sempre com linhas de decks que
        # ninguém consegue mais abrir.
        from . import artes
        artes.apagar_do_deck(deck_id)
    return bool(apagados)


# ---------------------------------------------------------------------------
# As regras do formato
# ---------------------------------------------------------------------------


def identidade_de(comandantes: list[dict]) -> str:
    """A identidade de cor do deck: a união da dos comandantes."""
    cores = set()
    for carta in comandantes:
        cores.update(c for c in (carta.get("identidade") or "")
                     if c in base_cartas.CORES)
    return "".join(c for c in base_cartas.CORES if c in cores)


def _cabe_na_identidade(carta: dict, identidade: str) -> bool:
    return all(c in identidade for c in (carta.get("identidade") or ""))


def validar(comandantes: list[str], cartas: list[dict]) -> dict:
    """Confere o deck contra as regras do Commander.

    Devolve tudo o que a tela precisa desenhar de uma vez: a identidade de
    cor resultante, a contagem, e a lista de apontamentos. Cada apontamento
    tem `nivel` — `"erro"` é o que torna o deck ilegal, `"aviso"` é o que
    merece atenção mas não impede (carta que a base local não conhece, por
    exemplo, que pode ser só uma base desatualizada).

    O maybeboard não passa por aqui: ele é rascunho, e acusar identidade de
    cor numa carta que a pessoa ainda está pensando se usa seria alarme sobre
    decisão que ela nem tomou. O sideboard passa — só não conta pras 100.

    Nada aqui impede de salvar: ver o cabeçalho do módulo.
    """
    comandantes = limpar_comandantes(comandantes)
    cartas = limpar_cartas(cartas)

    nomes = list(comandantes) + [c["nome"] for c in cartas]
    conhecidas = base_cartas.por_nomes(nomes)

    apontamentos: list[dict] = []
    def apontar(nivel, tipo, mensagem, carta=None):
        apontamentos.append({"nivel": nivel, "tipo": tipo,
                             "mensagem": mensagem, "carta": carta})

    # --- comandante(s) ---
    cartas_comandantes = []
    for nome in comandantes:
        carta = conhecidas.get(nome)
        if carta is None:
            apontar("aviso", "desconhecida",
                    f"Não achei {nome} na base local de cartas.", nome)
            continue
        cartas_comandantes.append(carta)
        if not carta["comandante"]:
            apontar("erro", "comandante-invalido",
                    f"{carta['nome']} não pode ser comandante — só criatura "
                    f"lendária, ou carta que diga que pode.", carta["nome"])

    if not comandantes:
        apontar("erro", "sem-comandante",
                "Todo deck de Commander começa por um comandante.")
    elif len(cartas_comandantes) == 2:
        # Dois comandantes só existem com Partner, Background e afins. A
        # marca vem de heurística de texto (ver `cartas._PARCEIRO_RE`), então
        # o apontamento explica o motivo em vez de só recusar.
        sem_parceria = [c["nome"] for c in cartas_comandantes
                        if not c["parceiro"]]
        if sem_parceria:
            apontar("erro", "parceria",
                    "Dois comandantes só com Partner, Doctor's companion ou "
                    "Background — e " + " e ".join(sem_parceria) +
                    " não tem nada disso no texto.")

    identidade = identidade_de(cartas_comandantes)

    # --- tamanho ---
    # O sideboard sai da conta e SÓ da conta: singleton, identidade de cor e
    # legalidade continuam valendo pra ele logo abaixo, porque uma carta
    # guardada pra trocar depois precisa caber no deck em que vai entrar.
    total = len(comandantes) + sum(
        c["quantidade"] for c in cartas
        if (c.get("categoria") or "") not in CATEGORIAS_FORA_DA_CONTA)
    if total < TAMANHO_DECK:
        apontar("erro", "faltam",
                f"Faltam {TAMANHO_DECK - total} carta(s) pras 100 do formato.")
    elif total > TAMANHO_DECK:
        apontar("erro", "sobram",
                f"São {total - TAMANHO_DECK} carta(s) além das 100 do formato.")

    # --- carta a carta ---
    nomes_comandantes = {base_cartas.normalizar(n) for n in comandantes}
    for entrada in cartas:
        nome, quantidade = entrada["nome"], entrada["quantidade"]
        carta = conhecidas.get(nome)
        if carta is None:
            apontar("aviso", "desconhecida",
                    f"Não achei {nome} na base local — confira o nome, ou "
                    f"sincronize a base se a carta for nova.", nome)
            continue

        if base_cartas.normalizar(nome) in nomes_comandantes:
            apontar("erro", "comandante-repetido",
                    f"{carta['nome']} já é o comandante: ele não entra "
                    f"de novo nas 99.", carta["nome"])

        if quantidade > 1 and not (carta["basico"] or carta["ilimitada"]):
            apontar("erro", "singleton",
                    f"{carta['nome']}: {quantidade} cópias. Commander é "
                    f"singleton — só terreno básico (e as poucas cartas que "
                    f"dizem o contrário) repetem.", carta["nome"])

        if not carta["legal"]:
            apontar("erro", "banida",
                    f"{carta['nome']} não é legal em Commander.", carta["nome"])

        if identidade is not None and not _cabe_na_identidade(carta, identidade):
            fora = "".join(c for c in carta["identidade"] if c not in identidade)
            apontar("erro", "identidade",
                    f"{carta['nome']} tem {fora} na identidade de cor, que o "
                    f"comandante não tem.", carta["nome"])

    erros = [a for a in apontamentos if a["nivel"] == "erro"]
    return {
        "ok": not erros,
        "identidade": identidade,
        "total": total,
        "faltam": max(0, TAMANHO_DECK - total),
        "apontamentos": apontamentos,
        "erros": len(erros),
        "avisos": len(apontamentos) - len(erros),
    }


def com_cartas(deck: dict) -> dict:
    """O deck com os dados completos de cada carta anexados.

    A tela precisa de tipo, custo, cor e imagem pra desenhar a lista, a curva
    de mana e os filtros — e o deck salvo guarda só nome e quantidade, que é
    o que não envelhece quando a base de cartas é resincronizada.
    """
    nomes = list(deck.get("comandantes") or []) + \
            [c["nome"] for c in deck.get("cartas") or []] + \
            [c["nome"] for c in deck.get("maybeboard") or []]
    conhecidas = base_cartas.por_nomes(nomes)
    return {
        **deck,
        "cartas_completas": [
            {**entrada, "carta": conhecidas.get(entrada["nome"])}
            for entrada in deck.get("cartas") or []
        ],
        "maybeboard_completo": [
            {**entrada, "carta": conhecidas.get(entrada["nome"])}
            for entrada in deck.get("maybeboard") or []
        ],
        "comandantes_completos": [
            conhecidas.get(nome) for nome in deck.get("comandantes") or []
        ],
    }


# ---------------------------------------------------------------------------
# Resumo (a página de decks)
# ---------------------------------------------------------------------------

# A tela guarda 20 decks no navegador. O teto aqui é com folga, e existe pra
# impedir uma lista sem fim numa consulta só — não pra policiar quem tem
# muitos decks.
MAX_RESUMO = 60


def resumo(ids: list[str]) -> list[dict]:
    """Os metadados de vários decks de uma vez, pra tela de listagem.

    NÃO é `obter` em laço: o deck inteiro carrega as 100 linhas de cartas e a
    lista não desenha nenhuma delas. Aqui sai só o que cabe num cartão — nome,
    comandantes, quantas das 100, quando mexeu, a arte do comandante —, e a
    arte de TODOS os decks sai de uma consulta só à base local.

    A ORDEM DE SAÍDA É A DE ENTRADA, e id que não existe simplesmente não
    volta. Quem chama é a lista do navegador, que pode ter deck apagado no
    meio: devolver erro faria um deck apagado esconder os outros dezenove.
    Quem precisa saber o que sumiu compara o que pediu com o que voltou.

    A contagem usa a MESMA regra do `validar` — comandantes mais as cartas
    fora do sideboard. Duas contas diferentes pro mesmo deck em duas telas
    seriam pior do que número nenhum, e é o tipo de divergência que ninguém
    percebe até alguém conferir na mão.

    NÃO FILTRA POR DONO, porque nesta altura o dono não existe: quem chama já
    tem os ids, e ter o id é a credencial do sistema inteiro (ver o cabeçalho
    do módulo). Por isso nenhum caminho daqui pode significar "todos" — uma
    lista vazia devolve lista vazia.
    """
    ids = [str(i) for i in ids if i]
    if not ids:
        return []

    marcas = ",".join("?" * len(ids))
    conn = _conn()
    try:
        linhas = conn.execute(
            f"SELECT * FROM decks WHERE id IN ({marcas})", ids).fetchall()
    finally:
        conn.close()

    achados = {linha["id"]: _linha_para_deck(linha) for linha in linhas}
    # A ordem de entrada, não a do banco. Id que não existe simplesmente
    # não entra.
    return _cartoes([achados[i] for i in ids if i in achados])


def _cartoes(lista: list[dict]) -> list[dict]:
    """Vários decks no formato de cartão, na ordem em que vieram.

    Um lugar só, porque são DUAS telas com o mesmo cartão — a lista de quem
    monta (`resumo`) e a do admin (`listar`) — e cada uma com a sua versão da
    contagem seria a divergência que ninguém percebe até conferir na mão.

    A arte de todos os comandantes de todos os decks sai de UMA consulta:
    vinte decks fariam vinte se cada cartão resolvesse a sua.
    """
    nomes = [nome for deck in lista for nome in deck.get("comandantes") or []]
    conhecidas = base_cartas.por_nomes(nomes) if nomes else {}

    saida = []
    for deck in lista:
        contadas = cartas_contadas(deck)
        # A MESMA conta do `validar`: comandantes mais o que não é sideboard.
        total = len(deck["comandantes"]) + sum(c["quantidade"] for c in contadas)
        comandantes = [conhecidas.get(nome) for nome in deck["comandantes"]]
        saida.append({
            "id": deck["id"],
            "nome": deck["nome"],
            "comandantes": deck["comandantes"],
            "arte": next((c.get("imagem") for c in comandantes if c), ""),
            "identidade": identidade_de([c for c in comandantes if c]),
            "total": total,
            "faltam": max(0, TAMANHO_DECK - total),
            "distintas": len(deck["cartas"]),
            "talvez": sum(c["quantidade"] for c in deck["maybeboard"]),
            "criado_em": deck["criado_em"],
            "atualizado_em": deck["atualizado_em"],
            # Ainda não existe coluna de dono no banco; ela chega com o login.
            # O campo já sai daqui, sempre, pra a tela do admin não precisar
            # aprender um formato novo no dia em que ele passar a ter valor —
            # e pra "sem dono" ser um estado visível desde já, que é o que
            # todo deck de hoje é.
            "dono": deck.get("dono"),
        })
    return saida


# ---------------------------------------------------------------------------
# Listagem do admin
# ---------------------------------------------------------------------------

def listar(busca: str | None = None, limite: int = 200) -> list[dict]:
    """TODOS os decks, do mais mexido pro mais parado. Só pro admin.

    É a única leitura do projeto que enumera o banco de decks, e por isso ela
    existe atrás do `_check_admin` e em função separada do `resumo`: aquele é
    público e responde só sobre ids que quem chamou já tinha; este responde
    "o que existe aí dentro", que é uma pergunta de dono de sistema.

    `busca` casa com id, nome do deck, nome do comandante ou dono — é o que
    se tem na mão quando alguém chama perguntando do baralho dele. O
    comandante mora dentro de um JSON, então o `LIKE` vai no texto cru da
    coluna: é busca de operador numa base de dezenas de decks, não índice.

    Ordena por `atualizado_em` e não por `criado_em` (como os pedidos fazem):
    um pedido acontece uma vez, um deck vive sendo mexido, e o que interessa
    aqui é o que está vivo.
    """
    conn = _conn()
    try:
        where, params = [], []
        if busca and busca.strip():
            alvo = f"%{busca.strip().lower()}%"
            campos = ["LOWER(id)", "LOWER(nome)", "LOWER(comandantes)"]
            # Só cita `dono` se ele existe: antes do login, citar derrubaria a
            # busca inteira com `no such column`.
            if _tem_coluna(conn, "dono"):
                campos.append("LOWER(IFNULL(dono,''))")
            where.append("(" + " OR ".join(f"{c} LIKE ?" for c in campos) + ")")
            params += [alvo] * len(campos)
        sql = (f"SELECT * FROM decks "
               f"{'WHERE ' + ' AND '.join(where) if where else ''} "
               f"ORDER BY atualizado_em DESC LIMIT ?")
        params.append(max(1, min(int(limite), 500)))
        linhas = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return _cartoes([_linha_para_deck(l) for l in linhas])


def reclamar(deck_id: str, dono: str) -> dict | None:
    """Põe dono num deck que ainda não tem. Devolve o deck, ou None.

    Levanta `PermissionError` quando o deck JÁ tem dono — que é diferente de
    "não existe", e a tela precisa saber a diferença pra dizer "esse deck já
    é de alguém" em vez de "esse deck não existe".

    Primeiro-a-chegar, e sem problema: reclamar um órfão não tira de ninguém
    nada que a pessoa tivesse. Antes da reclamação qualquer um com o id já
    podia reescrever o deck; depois, só o dono e o admin. A reclamação REDUZ
    o conjunto de quem edita — ver o cabeçalho do `usuarios.py`.
    """
    if not dono:
        return None
    conn = _conn()
    try:
        linha = conn.execute("SELECT dono FROM decks WHERE id=?",
                             (deck_id,)).fetchone()
        if linha is None:
            return None
        if linha["dono"]:
            raise PermissionError("Este deck já tem dono.")
        conn.execute("UPDATE decks SET dono=? WHERE id=?", (dono, deck_id))
        conn.commit()
    finally:
        conn.close()
    log.evento("deck", "reclamou", deck=deck_id, por=dono)
    return obter(deck_id)


def definir_dono(deck_id: str, dono: str | None) -> bool:
    """Carimba o dono, sem perguntar quem estava lá antes.

    Diferente do `reclamar`: aquele é a operação do usuário e recusa deck que
    já tem dono; este é a mecânica interna, usada por quem já decidiu (o
    `duplicar`, que acabou de criar a cópia).
    """
    conn = _conn()
    try:
        cur = conn.execute("UPDATE decks SET dono=? WHERE id=?",
                           (dono or None, deck_id))
        conn.commit()
    finally:
        conn.close()
    return bool(cur.rowcount)


def soltar_de(dono: str) -> int:
    """Devolve à orfandade os decks de alguém. Usado quando a conta é apagada.

    O deck NÃO é apagado junto: perder o acesso de uma pessoa e destruir o
    trabalho dela são coisas diferentes, e órfão é um estado que este sistema
    trata desde antes de existir conta.
    """
    conn = _conn()
    try:
        cur = conn.execute("UPDATE decks SET dono=NULL WHERE dono=?", (dono,))
        conn.commit()
    finally:
        conn.close()
    return cur.rowcount


def dono_de(deck_id: str) -> tuple[bool, str | None]:
    """`(existe, dono)`. Duas perguntas numa consulta porque quem autoriza
    precisa das duas, e fazê-las separadas seria ler a linha duas vezes."""
    conn = _conn()
    try:
        linha = conn.execute("SELECT dono FROM decks WHERE id=?",
                             (deck_id,)).fetchone()
    finally:
        conn.close()
    return (linha is not None, linha["dono"] if linha is not None else None)


def de(dono: str, limite: int = 200) -> list[dict]:
    """Os decks de uma pessoa, do mais mexido pro mais parado."""
    if not dono:
        return []
    conn = _conn()
    try:
        linhas = conn.execute(
            "SELECT * FROM decks WHERE dono=? ORDER BY atualizado_em DESC "
            "LIMIT ?", (dono, max(1, min(int(limite), 500)))).fetchall()
    finally:
        conn.close()
    return _cartoes([_linha_para_deck(l) for l in linhas])


def contar() -> dict:
    """Quantos decks existem, e quantos ainda estão sem dono.

    O segundo número é o que responde "quanto do acervo é de antes do login" —
    e, depois dele, quanto ainda não foi reclamado por ninguém.
    """
    conn = _conn()
    try:
        total = conn.execute("SELECT COUNT(*) FROM decks").fetchone()[0]
        sem_dono = conn.execute(
            "SELECT COUNT(*) FROM decks WHERE dono IS NULL OR dono=''"
        ).fetchone()[0] if _tem_coluna(conn, "dono") else total
    finally:
        conn.close()
    return {"total": total, "sem_dono": sem_dono}


def para_cotacao(deck: dict) -> list[dict]:
    """A decklist no formato que o cotador já consome.

    O comandante entra na lista: quem decide tirá-lo do total é o
    `cotacao.filtrar_cotaveis`, pelo critério do Commander 500, e essa
    decisão fica lá, num lugar só.

    O sideboard entra (é carta que a pessoa quer comprar) e o maybeboard
    NÃO: cotar o que ainda está em dúvida inflaria o preço do deck com
    cartas que talvez nunca entrem, que é justamente o oposto do que a
    pessoa põe ali pra descobrir.
    """
    lista = [{"nome": nome, "quantidade": 1}
             for nome in deck.get("comandantes") or []]
    lista += [{"nome": c["nome"], "quantidade": c["quantidade"]}
              for c in deck.get("cartas") or []]
    return lista


def sugestoes_uteis(deck: dict, listas: list[dict],
                    por_lista: int = 12) -> list[dict]:
    """As sugestões do EDHREC que este deck ainda pode usar.

    Três filtros, nesta ordem, e cada um por um motivo diferente:

    1. **Já está no deck** — sugerir o que a pessoa acabou de adicionar é o
       jeito mais rápido de a lista parecer burra.
    2. **Não existe na base local** — sem a carta completa não dá pra
       adicionar num clique nem desenhar custo e tipo. Costuma ser carta
       nova, com a base local atrasada.
    3. **Não cabe na identidade de cor** — o EDHREC já devolve a página do
       comandante, então isso quase nunca acontece; quando acontece (página
       de tema com dupla de parceiros, por exemplo), é carta que o deck não
       poderia jogar.

    A carta completa vai junto de cada sugestão, pra tela poder adicionar sem
    uma segunda consulta.
    """
    ja_tem = {base_cartas.normalizar(n) for n in deck.get("comandantes") or []}
    ja_tem |= {base_cartas.normalizar(c["nome"])
               for c in deck.get("cartas") or []}
    # O maybeboard conta como "já tem" pra este filtro: a carta já está na
    # tela, e sugerir o que a pessoa acabou de pôr em dúvida é a mesma
    # burrice de sugerir o que ela acabou de adicionar.
    ja_tem |= {base_cartas.normalizar(c["nome"])
               for c in deck.get("maybeboard") or []}

    comandantes = base_cartas.por_nomes(deck.get("comandantes") or [])
    identidade = identidade_de([c for c in comandantes.values() if c])

    # Uma consulta ao banco pra todos os nomes de todas as listas, em vez de
    # uma por carta: são centenas de sugestões numa página de comandante.
    nomes = [c["nome"] for lista in listas for c in lista["cartas"]]
    conhecidas = base_cartas.por_nomes(nomes)

    saida = []
    for lista in listas:
        cartas_uteis = []
        for sugestao in lista["cartas"]:
            if base_cartas.normalizar(sugestao["nome"]) in ja_tem:
                continue
            carta = conhecidas.get(sugestao["nome"])
            if carta is None or not carta["legal"]:
                continue
            if not _cabe_na_identidade(carta, identidade):
                continue
            cartas_uteis.append({**sugestao, "carta": carta})
            if len(cartas_uteis) >= por_lista:
                break
        if cartas_uteis:
            saida.append({**lista, "cartas": cartas_uteis})
    return saida


def combos_com_cartas(achado: dict) -> dict:
    """Os combos do Spellbook com a carta local grudada em cada peça.

    O Spellbook devolve o NOME de cada peça e mais nada — o que basta pra
    listar, e não basta pra tela fazer as três coisas que a lista de combos
    pedia: mostrar a arte ao passar o mouse, somar quanto custa fechar o
    combo, e dizer se a peça que falta sequer existe na base local (se não
    existe, o botão de adicionar não teria o que adicionar).

    Uma consulta ao banco pra TODAS as peças de TODOS os combos: um deck
    montado volta com dezenas de combos de duas a quatro peças, e resolver
    nome a nome seriam centenas de idas ao SQLite por clique.

    O `custo_usd` é a soma do que o combo pede, e o `custo_faltando` é a
    parte dela que ainda não está no deck — que é o número que responde
    "quanto me custa fechar isto". Preço de carta que a base não conhece
    entra como zero e é contado em `sem_preco`, pra tela poder dizer que o
    total está incompleto em vez de mentir um número baixo.
    """
    listas = [achado.get("no_deck") or [], achado.get("faltando_uma") or []]
    nomes = [peca["nome"] for lista in listas for combo in lista
             for peca in combo.get("pecas") or []]
    conhecidas = base_cartas.por_nomes(nomes)

    for lista in listas:
        for combo in lista:
            _custear_combo(combo, conhecidas)
    return achado


def _custear_combo(combo: dict, conhecidas: dict) -> None:
    """Anexa carta e preço às peças de um combo, e soma os totais. No lugar.

    As peças sem preço são contadas DUAS vezes, uma pra cada total: um combo
    de três peças onde só a que falta é desconhecida tem total confiável e
    custo-pra-fechar que não se sabe. Uma contagem só não distinguiria os
    dois casos, e "fechar por US$ 0,00" leria como carta de graça.
    """
    custo = custo_faltando = 0.0
    sem_preco = sem_preco_faltando = 0
    for peca in combo.get("pecas") or []:
        carta = conhecidas.get(peca["nome"])
        # Só o que a tela usa. A carta inteira multiplicaria por quatro o
        # tamanho da resposta de combos com texto de oracle que ninguém lê ali.
        peca["imagem"] = (carta or {}).get("imagem") or ""
        # O verso e o giro andam junto com a imagem: sem eles a prévia da peça
        # de combo mostraria metade de um transform e deitaria nada.
        peca["imagem_verso"] = (carta or {}).get("imagem_verso") or ""
        peca["deitada"] = (carta or {}).get("deitada") or 0
        peca["mana_cost"] = (carta or {}).get("mana_cost") or ""
        peca["tipo"] = (carta or {}).get("tipo") or ""
        peca["preco_usd"] = (carta or {}).get("preco_usd")
        peca["na_base"] = carta is not None
        preco = peca["preco_usd"] or 0.0
        falta = not peca.get("no_deck")
        if not preco:
            sem_preco += 1
            if falta:
                sem_preco_faltando += 1
        custo += preco
        if falta:
            custo_faltando += preco
    combo["custo_usd"] = round(custo, 2)
    combo["custo_faltando_usd"] = round(custo_faltando, 2)
    combo["pecas_sem_preco"] = sem_preco
    combo["pecas_faltando_sem_preco"] = sem_preco_faltando


def importado_para_deck(trazido: dict) -> dict:
    """A lista importada virando o que a tela monta, com o que não resolveu.

    Nome que a base local não conhece NÃO é descartado calado: ele volta em
    `nao_encontradas` pra tela poder dizer quantas cartas ficaram de fora e
    quais. Costuma ser carta nova com a base atrasada, ou carta caseira num
    deck de cube — e as duas coisas a pessoa precisa saber antes de mandar
    imprimir.

    Comandante que não resolve é um caso à parte e mais grave: sem ele o deck
    não tem identidade de cor, e a tela abriria na pergunta "quem é o
    comandante?" como se nada tivesse sido importado.

    O maybeboard do site de origem vem junto, no `maybeboard_completo` — é o
    mesmo rascunho, e trazer só as 100 obrigaria a pessoa a copiar à mão a
    parte da lista que ela ainda estava decidindo.
    """
    comandantes = list(trazido.get("comandantes") or [])
    cartas = limpar_cartas(trazido.get("cartas") or [])
    talvez = limpar_cartas(trazido.get("maybeboard") or [])
    conhecidas = base_cartas.por_nomes(
        comandantes + [c["nome"] for c in cartas] +
        [c["nome"] for c in talvez])

    nao_encontradas = []
    completas, talvez_completas, comandantes_completos = [], [], []
    for nome in comandantes:
        carta = conhecidas.get(nome)
        if carta is None:
            nao_encontradas.append({"nome": nome, "quantidade": 1,
                                    "comandante": True})
        else:
            comandantes_completos.append(carta)
    for entrada in cartas:
        carta = conhecidas.get(entrada["nome"])
        if carta is None:
            nao_encontradas.append({**entrada, "comandante": False})
        else:
            completas.append({**entrada, "carta": carta})
    for entrada in talvez:
        carta = conhecidas.get(entrada["nome"])
        if carta is None:
            nao_encontradas.append({**entrada, "comandante": False})
        else:
            talvez_completas.append({**entrada, "carta": carta})

    return {
        "nome": (trazido.get("nome") or "").strip()[:80],
        "fonte": trazido.get("fonte") or "",
        "link": trazido.get("link") or "",
        "comandantes_completos": comandantes_completos,
        "cartas_completas": completas,
        "maybeboard_completo": talvez_completas,
        "categorias": limpar_categorias(trazido.get("categorias"),
                                        cartas, talvez),
        "nao_encontradas": nao_encontradas,
    }


def lista_texto(deck: dict) -> str:
    """A decklist em texto, uma carta por linha, comandante primeiro.

    É o formato que o MPC Fill aceita colado na caixa dele: monta aqui, cola
    lá pra escolher as artes, e sobe o XML que sai de lá no orçamento de
    sempre. O outro caminho é escolher as artes no próprio deckbuilder, e aí
    o XML sai daqui mesmo (ver `artes.pedido`).

    O sideboard entra e o maybeboard não, pelo mesmo critério da cotação: a
    lista é o que vai pra impressão, e o que a pessoa ainda está decidindo
    não vai pra impressão.
    """
    linhas = [f"1 {nome}" for nome in deck.get("comandantes") or []]
    linhas += [f"{c['quantidade']} {c['nome']}"
               for c in deck.get("cartas") or []]
    return "\n".join(linhas)
