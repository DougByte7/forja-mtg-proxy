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

DB_PATH = os.environ.get("DB_PATH", "/app/data/orders.db")

# Um Commander tem 100 cartas. O teto aqui é o dobro com folga: existe pra
# impedir que alguém grave uma lista de 50 mil linhas no banco, não pra
# policiar quem está montando.
MAX_ENTRADAS = 400
MAX_COPIAS = 99
TAMANHO_DECK = 100


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
                criado_em REAL,
                atualizado_em REAL
            )
        """)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------------


def limpar_cartas(cartas) -> list[dict]:
    """Normaliza a lista que veio da tela e junta repetições.

    Levanta `ValueError` no que não dá pra consertar sozinho. Duas cartas com
    o mesmo nome viram uma linha com a soma — a tela não deveria mandar
    assim, mas se mandar, o deck salvo continua fazendo sentido.
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
        chave = base_cartas.normalizar(nome)
        if chave in juntas:
            juntas[chave]["quantidade"] += quantidade
        else:
            juntas[chave] = {"nome": nome, "quantidade": quantidade}
    return list(juntas.values())


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


def _linha_para_deck(linha: sqlite3.Row) -> dict:
    return {
        "id": linha["id"],
        "nome": linha["nome"] or "Deck sem nome",
        "comandantes": json.loads(linha["comandantes"] or "[]"),
        "cartas": json.loads(linha["cartas"] or "[]"),
        "criado_em": linha["criado_em"],
        "atualizado_em": linha["atualizado_em"],
    }


def criar(nome: str = "", comandantes=None, cartas=None) -> dict:
    deck_id = uuid.uuid4().hex[:12]
    agora = time.time()
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO decks (id, nome, comandantes, cartas, criado_em, "
            "atualizado_em) VALUES (?,?,?,?,?,?)",
            (deck_id, (nome or "").strip() or "Deck sem nome",
             json.dumps(limpar_comandantes(comandantes)),
             json.dumps(limpar_cartas(cartas or [])), agora, agora))
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


def salvar(deck_id: str, nome: str, comandantes, cartas) -> dict | None:
    """Grava o deck inteiro por cima do que estava. `None` se não existe."""
    conn = _conn()
    try:
        mudou = conn.execute(
            "UPDATE decks SET nome=?, comandantes=?, cartas=?, atualizado_em=? "
            "WHERE id=?",
            ((nome or "").strip() or "Deck sem nome",
             json.dumps(limpar_comandantes(comandantes)),
             json.dumps(limpar_cartas(cartas or [])), time.time(),
             deck_id)).rowcount
        conn.commit()
    finally:
        conn.close()
    return obter(deck_id) if mudou else None


def duplicar(deck_id: str) -> dict | None:
    """Cópia com id novo — é o "fork" de quem quer variar um deck sem perder
    o original, e o único jeito de "salvar como" num sistema sem login."""
    original = obter(deck_id)
    if not original:
        return None
    return criar(f"{original['nome']} (cópia)", original["comandantes"],
                 original["cartas"])


def apagar(deck_id: str) -> bool:
    conn = _conn()
    try:
        apagados = conn.execute("DELETE FROM decks WHERE id=?",
                                (deck_id,)).rowcount
        conn.commit()
        return bool(apagados)
    finally:
        conn.close()


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
    total = len(comandantes) + sum(c["quantidade"] for c in cartas)
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
            [c["nome"] for c in deck.get("cartas") or []]
    conhecidas = base_cartas.por_nomes(nomes)
    return {
        **deck,
        "cartas_completas": [
            {**entrada, "carta": conhecidas.get(entrada["nome"])}
            for entrada in deck.get("cartas") or []
        ],
        "comandantes_completos": [
            conhecidas.get(nome) for nome in deck.get("comandantes") or []
        ],
    }


def para_cotacao(deck: dict) -> list[dict]:
    """A decklist no formato que o cotador já consome.

    O comandante entra na lista: quem decide tirá-lo do total é o
    `cotacao.filtrar_cotaveis`, pelo critério do Commander 500, e essa
    decisão fica lá, num lugar só.
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
    """
    comandantes = list(trazido.get("comandantes") or [])
    cartas = limpar_cartas(trazido.get("cartas") or [])
    conhecidas = base_cartas.por_nomes(comandantes +
                                       [c["nome"] for c in cartas])

    nao_encontradas = []
    completas, comandantes_completos = [], []
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

    return {
        "nome": (trazido.get("nome") or "").strip()[:80],
        "fonte": trazido.get("fonte") or "",
        "link": trazido.get("link") or "",
        "comandantes_completos": comandantes_completos,
        "cartas_completas": completas,
        "nao_encontradas": nao_encontradas,
    }


def lista_texto(deck: dict) -> str:
    """A decklist em texto, uma carta por linha, comandante primeiro.

    É o formato que o MPC Fill aceita colado na caixa dele — e é assim que
    este deckbuilder se liga ao fluxo de impressão que já existe: monta aqui,
    cola lá pra escolher as artes, e sobe o XML que sai de lá no orçamento
    de sempre. Este backend não tem biblioteca de arte nenhuma pra gerar esse
    XML sozinho (ver `pdf_generator.py`: cada carta é um id de arquivo no
    Drive).
    """
    linhas = [f"1 {nome}" for nome in deck.get("comandantes") or []]
    linhas += [f"{c['quantidade']} {c['nome']}"
               for c in deck.get("cartas") or []]
    return "\n".join(linhas)
