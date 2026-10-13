"""
Roda a cotação aos poucos e guarda o andamento pra tela acompanhar.

A cotação de um deck grande leva minutos — a LigaMagic é uma requisição por
carta com intervalo mínimo entre elas —, e nenhum servidor espera isso dentro
de UMA requisição HTTP: o túnel da Cloudflare cortava em ~100s, e na Vercel o
processo pode nem existir mais depois de responder. Thread de fundo também
não serve lá: ela morre junto com o processo.

POR ISSO O TRABALHO ANDA NAS CONSULTAS. A tela já pergunta o andamento a
cada 2s (`GET /cotacao/{id}`). Cada pergunta cota as cartas que faltam por
até `FATIA_SEGUNDOS` e responde quanto já andou; quando toda carta tem
resposta, a mesma pergunta monta o resultado e devolve. É o mesmo código no
homelab e na Vercel.

O que torna isso possível é o cache por carta (`cache_precos`, no banco): a
carta cotada fica lá, então o progresso de uma fatia não depende de memória
nenhuma do processo. O job (no banco também) guarda só a lista, as falhas e o
resultado. Fechar a página no meio não perde nada: cotar de novo recomeça de
onde parou, porque as cartas já cotadas estão no cache.

Duas perguntas ao mesmo tempo (duas abas, ou a anterior ainda trabalhando)
não trabalham as duas: a fatia é reservada no banco (`ocupado_ate`), e quem
não pegou a reserva só responde o andamento.

O disparo é sempre um clique explícito na tela, nunca automático ao subir o
XML. Isso é de propósito: cada cotação bate dezenas de vezes num site que
pede pra gente não fazer isso (veja `ligamagic.py`), e não faz sentido gastar
esse tranco em quem só queria orçar a impressão.
"""
import hashlib
import json
import os
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor

from . import cache_precos, calc, cambio, cotacao, db, ligamagic, log, scryfall

# Teto de cartas distintas POR COTAR (depois de tirar básicas e comandante).
# Um Commander tem 99, dos quais ~35 são terreno básico; 200 dá folga e ainda
# impede alguém de mandar uma lista gigante e deixar o backend batendo na
# LigaMagic por meia hora.
MAX_CARTAS = int(os.environ.get("COTACAO_MAX_CARTAS", "200"))
# Condições aceitas por padrão. Fora daqui ficam HP e Danificada, que são as
# mais baratas e justamente as que ninguém quer num deck.
CONDICOES = [c.strip().upper() for c in
             os.environ.get("COTACAO_CONDICOES", "M,NM,SP,MP").split(",")
             if c.strip()]
USAR_LIGAMAGIC = os.environ.get("COTACAO_LIGAMAGIC", "1") == "1"
USAR_SCRYFALL = os.environ.get("COTACAO_SCRYFALL", "1") == "1"
# Troca o `<query>` do XML pelo nome real da carta antes de perguntar preço.
# Vale pras DUAS fontes e é independente de mostrar a coluna da Scryfall: aqui
# ela é usada como dicionário de nomes, não como fonte de preço. Ver
# `scryfall.resolver_nomes` — sem isto, a LigaMagic devolve zero oferta pra
# toda carta com vírgula, apóstrofo, hífen, "!" ou artigo no nome.
RESOLVER_NOMES = os.environ.get("COTACAO_RESOLVER_NOMES", "1") == "1"
# Quanto cada pergunta da tela trabalha antes de responder. Curto o bastante
# pra resposta voltar bem antes de qualquer teto de requisição; longo o
# bastante pra fazer várias cartas da LigaMagic por vez.
FATIA_SEGUNDOS = float(os.environ.get("COTACAO_FATIA_SEGUNDOS", "15"))
# Quantas vezes tentar uma carta cuja BUSCA falhou (rede, 429) antes de dar
# como faltando. "A fonte não tem" não conta: isso fica no cache e não se
# pergunta de novo. Ver `cotacao.cotar`, que fazia o mesmo com a repescagem.
TENTATIVAS = int(os.environ.get("COTACAO_TENTATIVAS", "2"))
# Job "cotando" sem ninguém mexer há mais que isto foi abandonado: um clique
# novo recomeça em vez de entrar nele.
ABANDONADO_SEGUNDOS = 3600
# Mesma casa do cache: o banco de cartas, o descartável.
DB_PATH = os.environ.get("CARTAS_DB_PATH", "/app/data/cartas.db")


def _com_nome_real(cartas: list[dict]) -> list[dict]:
    """A mesma lista, com o nome canônico no lugar do `<query>` do MPC Fill.

    Carta que não resolver fica com o nome do XML — o comportamento antigo.
    Isso mantém a troca como melhoria pura: nunca piora o que já funcionava.

    A substituição acontece aqui, num lugar só, e não dentro de cada cliente,
    porque o nome certo serve pra tudo o que vem depois: as duas buscas, o
    cache por carta (dois decks que escrevem o mesmo nome diferente passam a
    dividir a entrada) e a tabela na tela, que passa a mostrar "Nature's Lore"
    em vez de "natures lore".
    """
    if not RESOLVER_NOMES:
        return cartas
    # O tipo da carta ("Legendary Creature — Elf Druid") vem na MESMA resposta
    # que resolve o nome, então pedi-lo aqui não custa requisição nenhuma. Ele
    # não muda preço nem busca: serve pra tela agrupar a tabela por tipo
    # quando o usuário expande a cotação.
    tipos: dict[str, str] = {}
    try:
        canonico_de = scryfall.resolver_nomes([c["nome"] for c in cartas], tipos)
    except Exception as e:
        # `resolver_nomes` já engole os erros dele, mas a cotação não pode
        # depender disso: o nome canônico é um luxo que melhora o resultado,
        # nunca uma dependência que possa derrubar o orçamento inteiro.
        log.aviso("cotacao", "resolver-nomes-falhou",
                  motivo=f"{type(e).__name__}: {e}",
                  nota="segue com os nomes do XML")
        return cartas
    if not canonico_de:
        return cartas

    trocadas, saida = 0, []
    for carta in cartas:
        real = canonico_de.get(carta["nome"])
        # Carta sem tipo (nome que não resolveu, ou Scryfall fora do ar) segue
        # normalmente e a tela a joga numa gaveta de "outras" — o tipo é
        # enfeite da tabela, nunca condição pra cotar.
        tipo = tipos.get(real or carta["nome"], "")
        extra = {"tipo": tipo} if tipo else {}
        if real and real != carta["nome"]:
            trocadas += 1
            log.debug("cotacao", "nome-real", de=carta["nome"], para=real)
            saida.append({**carta, "nome": real, "nome_xml": carta["nome"],
                          **extra})
        else:
            saida.append({**carta, **extra} if extra else carta)
    log.evento("cotacao", "nomes-resolvidos", cartas=len(cartas),
               trocados=trocadas,
               nao_resolvidos=len(cartas) - len(canonico_de) or None)
    return saida


def fontes_ativas() -> list[dict]:
    """As fontes ligadas no .env, na ordem em que aparecem na tela. A
    primeira é a principal: é o total dela que ordena a tabela."""
    fontes = []
    if USAR_LIGAMAGIC:
        fontes.append({
            "id": "ligamagic",
            "rotulo": "LigaMagic",
            "moeda": "BRL",
            "observacao": "lojas brasileiras; menor oferta por carta, sem frete",
            "workers": ligamagic.WORKERS,
            "buscar": ligamagic.buscar_carta,
        })
    if USAR_SCRYFALL:
        fontes.append({
            "id": "scryfall",
            "rotulo": "Scryfall / TCGplayer",
            "moeda": scryfall.MOEDA,
            "observacao": ("preço do mercado americano, para comparação — "
                           "não é o custo de comprar no Brasil"),
            "workers": scryfall.WORKERS,
            "buscar": scryfall.buscar_carta,
            # Resolve e precifica o deck inteiro em ~20 requisições antes da
            # varredura, em vez de 2+ por carta. Ver `scryfall.preparar`.
            "preparar": scryfall.preparar,
        })
    return fontes


def _chave(cartas) -> str:
    """Identidade da cotação: as cartas e as quantidades, nada mais.

    Serve de id do job e pra não deixar DOIS jobs iguais rodando ao mesmo
    tempo — dois cliques no botão entram no mesmo job em vez de disparar
    duas varreduras idênticas.

    Não serve de cache: quem guarda resultado é o `cache_precos`, carta por
    carta. Clicar de novo depois de pronto refaz o job, mas ele passa inteiro
    pelo cache e volta em segundos, sem tocar na rede.
    """
    cru = json.dumps(sorted((c["nome"].lower(), c["quantidade"]) for c in cartas))
    return hashlib.sha256(cru.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# O job no banco
# ---------------------------------------------------------------------------

_CAMPOS = ("id", "estado", "cartas", "excluidas", "total", "inicio",
           "preparado", "falhas", "resultado", "detalhe", "quando",
           "ocupado_ate")
_JSON = ("cartas", "excluidas", "falhas", "resultado")


def _conn():
    return db.cartas(DB_PATH)


def criar_tabela(conn=None) -> None:
    proprio = conn is None
    conn = conn or _conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cotacao_jobs (
                id TEXT PRIMARY KEY,
                estado TEXT NOT NULL,
                cartas TEXT,
                excluidas TEXT,
                total INTEGER,
                inicio REAL,
                preparado INTEGER DEFAULT 0,
                falhas TEXT,
                resultado TEXT,
                detalhe TEXT,
                quando REAL,
                ocupado_ate REAL
            )""")
        conn.commit()
    finally:
        if proprio:
            conn.close()


def _com_tabela(fazer):
    conn = _conn()
    try:
        try:
            return fazer(conn)
        except sqlite3.OperationalError as e:
            if "no such table" not in str(e):
                raise
            criar_tabela(conn)
            return fazer(conn)
    finally:
        conn.close()


def _ler(job_id: str) -> dict | None:
    linha = _com_tabela(lambda conn: conn.execute(
        f"SELECT {','.join(_CAMPOS)} FROM cotacao_jobs WHERE id=?",
        (job_id,)).fetchone())
    if not linha:
        return None
    job = dict(zip(_CAMPOS, linha))
    for campo in _JSON:
        job[campo] = json.loads(job[campo]) if job[campo] else None
    job["falhas"] = job["falhas"] or {}
    return job


def _gravar(job_id: str, **campos) -> None:
    for campo in _JSON:
        if campo in campos:
            campos[campo] = json.dumps(campos[campo], ensure_ascii=False)
    sets = ", ".join(f"{c}=?" for c in campos)

    def fazer(conn):
        conn.execute(f"UPDATE cotacao_jobs SET {sets} WHERE id=?",
                     (*campos.values(), job_id))
        conn.commit()
    _com_tabela(fazer)


def _reservar(job_id: str) -> bool:
    """Pega a fatia deste job pra si. False = outra pergunta está nela."""
    agora = time.time()

    def fazer(conn):
        cur = conn.execute(
            "UPDATE cotacao_jobs SET ocupado_ate=? WHERE id=? AND "
            "estado='cotando' AND (ocupado_ate IS NULL OR ocupado_ate < ?)",
            (agora + FATIA_SEGUNDOS + 60, job_id, agora))
        conn.commit()
        return cur.rowcount > 0
    return _com_tabela(fazer)


def podar() -> int:
    """Apaga job velho. Chamado pela faxina diária: o resultado já foi
    entregue, e as cartas continuam no cache."""
    def fazer(conn):
        cur = conn.execute("DELETE FROM cotacao_jobs WHERE inicio < ?",
                           (time.time() - 86400,))
        conn.commit()
        return cur.rowcount
    return _com_tabela(fazer)


# ---------------------------------------------------------------------------
# Começar
# ---------------------------------------------------------------------------


def iniciar(xml_text: str, comandante: str | None = None) -> dict:
    """Começa a cotação do XML e devolve o estado atual.

    `comandante`, se vier, sai da conta, e terreno básico sai sempre: é o
    critério do Commander 500, cujo teto de preço vale para o deck sem eles.
    Ver `cotacao.filtrar_cotaveis`.

    Levanta `ValueError` quando o XML não serve — XML quebrado, sem carta
    nenhuma, ou lista maior que `MAX_CARTAS` DEPOIS do filtro (o limite é de
    cartas que vão virar requisição; 40 terrenos básicos não contam).
    """
    todas = calc.parse_card_list(xml_text)
    if not todas:
        raise ValueError("Não achei carta nenhuma nesse XML.")
    return iniciar_lista(todas, comandante)


def iniciar_lista(todas: list[dict],
                  comandante: "str | list | None" = None) -> dict:
    """O mesmo, a partir de uma decklist já pronta (`[{"nome","quantidade"}]`).

    Existe porque o XML do MPC Fill deixou de ser a única origem de uma lista
    de cartas: o deckbuilder monta o deck aqui dentro e quer o mesmo
    orçamento, sem ter que fabricar um XML de mentira só pra passar por uma
    porta que espera arquivo.

    Daqui pra baixo os dois caminhos são o mesmo — inclusive a chave do job,
    então orçar o deck montado na tela e orçar o XML dele cai no mesmo
    trabalho em vez de varrer as mesmas cartas duas vezes.

    Não cota nada: só grava o job e responde. Quem anda é `estado`.
    """
    if not todas:
        raise ValueError("Não achei carta nenhuma nessa lista.")

    cartas, excluidas = cotacao.filtrar_cotaveis(todas, comandante)
    if not cartas:
        raise ValueError(
            "Depois de tirar terrenos básicos e o comandante não sobrou carta "
            "nenhuma pra cotar.")
    if len(cartas) > MAX_CARTAS:
        raise ValueError(
            f"Essa lista tem {len(cartas)} cartas distintas pra cotar e o "
            f"limite é {MAX_CARTAS}. Cotar uma lista desse tamanho levaria "
            f"muito tempo.")

    # A chave sai da lista JÁ FILTRADA, não da original: cotar o mesmo deck
    # com e sem comandante são dois trabalhos diferentes e não podem cair no
    # mesmo job.
    job_id = _chave(cartas)
    agora = time.time()
    atual = _ler(job_id)
    # Só o job EM ANDAMENTO é reaproveitado, pra dois cliques não virarem
    # duas varreduras. Job já terminado roda de novo — e passa inteiro pelo
    # cache por carta, então volta em segundos sem tocar na rede.
    if atual and atual["estado"] == "cotando" and \
            agora - (atual["quando"] or 0) < ABANDONADO_SEGUNDOS:
        return _resumo(atual)

    novo = {"estado": "cotando", "cartas": cartas, "excluidas": excluidas,
            "total": len(cartas) * len(fontes_ativas()), "inicio": agora,
            "preparado": 0, "falhas": {}, "resultado": None, "detalhe": None,
            "quando": agora, "ocupado_ate": None}
    linha = dict(novo)
    for campo in _JSON:
        linha[campo] = json.dumps(linha[campo], ensure_ascii=False)

    def fazer(conn):
        conn.execute(
            f"INSERT INTO cotacao_jobs (id, {','.join(linha)}) "
            f"VALUES (?, {','.join('?' * len(linha))}) "
            f"ON CONFLICT(id) DO UPDATE SET "
            + ", ".join(f"{c}=excluded.{c}" for c in linha),
            (job_id, *linha.values()))
        conn.commit()
    _com_tabela(fazer)

    log.evento("cotacao", "job-comecou", job=job_id, cartas=len(cartas),
               excluidas=len(excluidas),
               fontes=", ".join(f["id"] for f in fontes_ativas()) or "nenhuma")
    return _resumo({"id": job_id, **novo})


# ---------------------------------------------------------------------------
# Andar
# ---------------------------------------------------------------------------


def _pendentes(job: dict, fontes: list[dict]) -> dict[str, list[str]]:
    """Por fonte, as cartas que ainda não têm resposta: nem no cache, nem
    com as tentativas esgotadas."""
    nomes = [c["nome"] for c in job["cartas"]]
    saida = {}
    for fonte in fontes:
        prontas = cache_precos.ler_varios(fonte["id"], nomes)
        saida[fonte["id"]] = [
            n for n in dict.fromkeys(nomes)
            if n not in prontas
            and job["falhas"].get(f"{fonte['id']}|{n}", [0])[0] < TENTATIVAS]
    return saida


def _feitas(job: dict, pendentes: dict[str, list[str]]) -> int:
    distintas = len({c["nome"] for c in job["cartas"]})
    return sum(distintas - len(p) for p in pendentes.values())


def _trabalhar(job: dict, fontes: list[dict]) -> None:
    """Uma fatia: cota o que der em `FATIA_SEGUNDOS` e grava o andamento."""
    prazo = time.monotonic() + FATIA_SEGUNDOS
    job_id = job["id"]

    if not job["preparado"]:
        # Antes de qualquer fonte: troca o `<query>` do MPC pelo nome real, e
        # deixa a Scryfall resolver o deck inteiro em lote. As duas coisas
        # custam poucas requisições e mudam o que vem depois.
        job["cartas"] = _com_nome_real(job["cartas"])
        for fonte in fontes:
            preparar = fonte.get("preparar")
            if preparar:
                try:
                    preparar([c["nome"] for c in job["cartas"]])
                except Exception as e:
                    # Nunca derruba a cotação: o lote é atalho, não o caminho.
                    log.aviso(f"cotacao/{fonte['id']}", "preparar-falhou",
                              motivo=f"{type(e).__name__}: {e}")
        job["preparado"] = 1
        _gravar(job_id, cartas=job["cartas"], preparado=1, quando=time.time())

    pendentes = _pendentes(job, fontes)
    falhas = job["falhas"]

    def cotar_fonte(fonte):
        def uma(nome):
            if time.monotonic() >= prazo:
                return  # fica pra próxima fatia
            try:
                # A própria busca grava no cache — inclusive o "não tem".
                fonte["buscar"](nome)
            except Exception as e:
                chave = f"{fonte['id']}|{nome}"
                anteriores = falhas.get(chave, [0])[0]
                falhas[chave] = [anteriores + 1,
                                 f"falha na busca: {type(e).__name__}: {e}"]
        lista = pendentes[fonte["id"]]
        if not lista:
            return
        with ThreadPoolExecutor(max_workers=max(1, fonte.get("workers", 1))) as pool:
            list(pool.map(uma, lista))

    # As fontes andam em paralelo: a Scryfall termina em segundos e não pode
    # ficar esperando a LigaMagic, que tem intervalo mínimo entre requisições.
    with ThreadPoolExecutor(max_workers=max(1, len(fontes))) as pool:
        list(pool.map(cotar_fonte, fontes))
    _gravar(job_id, falhas=falhas, quando=time.time())


def _fontes_do_cache(job: dict, fontes: list[dict]) -> list[dict]:
    """As mesmas fontes, mas lendo só do cache: é com isto que o resultado
    final é montado, sem tocar na rede. Carta sem resposta no cache levanta
    o erro que a busca deu — e o `cotacao.cotar` a lista como faltando."""
    nomes = [c["nome"] for c in job["cartas"]]
    saida = []
    for fonte in fontes:
        prontas = cache_precos.ler_varios(fonte["id"], nomes)

        def buscar(nome, _prontas=prontas, _fonte=fonte["id"]):
            if nome in _prontas:
                return _prontas[nome]
            falha = job["falhas"].get(f"{_fonte}|{nome}")
            raise RuntimeError((falha[1] if falha else "sem resultado")
                               .removeprefix("falha na busca: "))

        saida.append({**fonte, "buscar": buscar, "preparar": None,
                      "workers": 1, "repescagem": 0})
    return saida


def _terminar(job: dict, fontes: list[dict]) -> None:
    resultado = cotacao.comparar(job["cartas"], _fontes_do_cache(job, fontes),
                                 condicoes_aceitas=CONDICOES)
    # As cartas que ficaram de fora viajam junto do resultado: a tela
    # precisa dizer POR QUE o total não cobre o deck inteiro.
    resultado["excluidas"] = job["excluidas"]
    # O câmbio viaja junto pra tela poder marcar a carta que está muito
    # mais cara aqui do que lá fora. É comparação, não conversão: não
    # entra em total nenhum. Ver `cambio.py` — nunca levanta.
    resultado["cambio"] = cambio.taxa()
    # Uma linha por fonte com o placar. É o que se olha primeiro quando
    # alguém diz "faltou preço em muita carta": diz de imediato se o
    # buraco foi de uma fonte só ou das duas.
    for f in resultado["fontes"]:
        log.evento("cotacao", "job-fonte", job=job["id"], fonte=f["id"],
                   total=f["total"], moeda=f["moeda"],
                   cotadas=f["cartas_cotadas"],
                   faltando=f["cartas_faltando"],
                   lojas=f["lojas_distintas"])
    log.evento("cotacao", "job-pronto", job=job["id"],
               cartas=len(job["cartas"]),
               segundos=int(time.time() - (job["inicio"] or time.time())))
    job.update(estado="pronto", resultado=resultado, quando=time.time())
    _gravar(job["id"], estado="pronto", resultado=resultado,
            quando=job["quando"], ocupado_ate=None)


def estado(job_id: str) -> dict | None:
    """Andamento ou resultado — e, se o job está cotando e ninguém está nele,
    uma fatia de trabalho antes de responder. Ver o topo do módulo."""
    job = _ler(job_id)
    if not job:
        return None
    if job["estado"] != "cotando" or not _reservar(job_id):
        return _resumo(job)

    fontes = fontes_ativas()
    try:
        _trabalhar(job, fontes)
        if not any(_pendentes(job, fontes).values()):
            _terminar(job, fontes)
    except Exception as e:
        log.erro("cotacao", "job-falhou", job=job_id,
                 motivo=f"{type(e).__name__}: {e}")
        job.update(estado="erro", detalhe=str(e), quando=time.time())
        _gravar(job_id, estado="erro", detalhe=str(e), quando=job["quando"],
                ocupado_ate=None)
        return _resumo(job)
    if job["estado"] == "cotando":
        _gravar(job_id, ocupado_ate=None)
    return _resumo(job)


def _resumo(job: dict) -> dict:
    fora = {"job_id": job["id"], "estado": job["estado"]}
    if job["estado"] == "cotando":
        fontes = fontes_ativas()
        pendentes = _pendentes(job, fontes) if job.get("cartas") else {}
        distintas = len({c["nome"] for c in job["cartas"]})
        fora.update(feitas=_feitas(job, pendentes),
                    total=distintas * len(fontes),
                    cartas=distintas,
                    decorrido=int(time.time() - (job.get("inicio") or time.time())))
    elif job["estado"] == "pronto":
        fora["resultado"] = job["resultado"]
    else:
        fora["detalhe"] = job.get("detalhe") or "erro desconhecido"
    return fora
