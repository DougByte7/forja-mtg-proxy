"""
Roda a cotação em segundo plano e guarda o andamento pra tela acompanhar.

Mesmo motivo do PDF (ver `fulfillment.request_pdf`): a cotação de um deck
grande leva minutos — a LigaMagic é uma requisição por carta com intervalo
mínimo entre elas — e esperar isso DENTRO da requisição HTTP estoura o teto
do túnel da Cloudflare. Então quem pede não espera: dispara a thread e vai
perguntando como está.

O disparo é sempre um clique explícito na tela, nunca automático ao subir o
XML. Isso é de propósito: cada cotação bate dezenas de vezes num site que
pede pra gente não fazer isso (veja `ligamagic.py`), e não faz sentido gastar
esse tranco em quem só queria orçar a impressão.
"""
import hashlib
import json
import os
import threading
import time

from . import calc, cotacao, ligamagic, log, scryfall

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
    try:
        canonico_de = scryfall.resolver_nomes([c["nome"] for c in cartas])
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
        if real and real != carta["nome"]:
            trocadas += 1
            log.debug("cotacao", "nome-real", de=carta["nome"], para=real)
            saida.append({**carta, "nome": real, "nome_xml": carta["nome"]})
        else:
            saida.append(carta)
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

    Não serve mais de cache: quem guarda resultado é o `cache_precos`, carta
    por carta. Clicar de novo depois de pronto refaz o job, mas ele passa
    inteiro pelo cache e volta em segundos, sem tocar na rede.
    """
    cru = json.dumps(sorted((c["nome"].lower(), c["quantidade"]) for c in cartas))
    return hashlib.sha256(cru.encode()).hexdigest()[:16]


_trava = threading.Lock()
_jobs: dict[str, dict] = {}


def _progresso(job_id: str):
    def cb(feitas: int, total: int):
        with _trava:
            job = _jobs.get(job_id)
            if job and job["estado"] == "cotando":
                job["feitas"], job["total"] = feitas, total
    return cb


def _rodar(job_id: str, cartas, excluidas):
    inicio = time.time()
    try:
        # Antes de qualquer fonte: troca o `<query>` do MPC pelo nome real.
        # Fica aqui dentro, e não no `iniciar`, porque custa uma requisição —
        # e o `iniciar` responde dentro do HTTP, que não pode esperar rede.
        cartas = _com_nome_real(cartas)
        resultado = cotacao.comparar(cartas, fontes_ativas(),
                                     condicoes_aceitas=CONDICOES,
                                     on_progress=_progresso(job_id))
        # As cartas que ficaram de fora viajam junto do resultado: a tela
        # precisa dizer POR QUE o total não cobre o deck inteiro.
        resultado["excluidas"] = excluidas
        # Uma linha por fonte com o placar. É o que se olha primeiro quando
        # alguém diz "faltou preço em muita carta": diz de imediato se o
        # buraco foi de uma fonte só ou das duas.
        for f in resultado["fontes"]:
            log.evento("cotacao", "job-fonte", job=job_id, fonte=f["id"],
                       total=f["total"], moeda=f["moeda"],
                       cotadas=f["cartas_cotadas"],
                       faltando=f["cartas_faltando"],
                       lojas=f["lojas_distintas"])
        log.evento("cotacao", "job-pronto", job=job_id, cartas=len(cartas),
                   segundos=int(time.time() - inicio))
        final = {"estado": "pronto", "resultado": resultado,
                 "quando": time.time()}
    except Exception as e:
        log.erro("cotacao", "job-falhou", job=job_id,
                 motivo=f"{type(e).__name__}: {e}")
        final = {"estado": "erro", "detalhe": str(e), "quando": time.time()}
    with _trava:
        job = _jobs.get(job_id, {})
        job.update(final)
        _jobs[job_id] = job


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

    cartas, excluidas = cotacao.filtrar_cotaveis(todas, comandante)
    if not cartas:
        raise ValueError(
            "Depois de tirar terrenos básicos e o comandante não sobrou carta "
            "nenhuma pra cotar.")
    if len(cartas) > MAX_CARTAS:
        raise ValueError(
            f"Esse XML tem {len(cartas)} cartas distintas pra cotar e o limite "
            f"é {MAX_CARTAS}. Cotar uma lista desse tamanho levaria muito tempo.")

    # A chave sai da lista JÁ FILTRADA, não da original: cotar o mesmo deck
    # com e sem comandante são dois trabalhos diferentes e não podem cair no
    # mesmo job.
    job_id = _chave(cartas)
    with _trava:
        job = _jobs.get(job_id)
        # Só o job EM ANDAMENTO é reaproveitado, pra dois cliques não virarem
        # duas varreduras. Job já terminado roda de novo — e passa inteiro
        # pelo cache por carta, então volta em segundos sem tocar na rede.
        if job and job["estado"] == "cotando":
            return _resumo(job_id, job)
        _jobs[job_id] = {"estado": "cotando", "feitas": 0,
                         "total": len(cartas) * len(fontes_ativas()),
                         "inicio": time.time(), "cartas": len(cartas)}

    log.evento("cotacao", "job-comecou", job=job_id, cartas=len(cartas),
               excluidas=len(excluidas),
               fontes=", ".join(f["id"] for f in fontes_ativas()) or "nenhuma")
    threading.Thread(target=_rodar, args=(job_id, cartas, excluidas),
                     daemon=True).start()
    with _trava:
        return _resumo(job_id, _jobs[job_id])


def estado(job_id: str) -> dict | None:
    with _trava:
        job = _jobs.get(job_id)
        return _resumo(job_id, job) if job else None


def _resumo(job_id: str, job: dict) -> dict:
    fora = {"job_id": job_id, "estado": job["estado"]}
    if job["estado"] == "cotando":
        fora.update(feitas=job.get("feitas", 0), total=job.get("total", 0),
                    cartas=job.get("cartas", 0),
                    decorrido=int(time.time() - job.get("inicio", time.time())))
    elif job["estado"] == "pronto":
        fora["resultado"] = job["resultado"]
    else:
        fora["detalhe"] = job.get("detalhe", "erro desconhecido")
    return fora
