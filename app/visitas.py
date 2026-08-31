"""
Log de visitas: quem chegou no sistema, quando, e se parece gente ou robô.

O que se quer saber olhando isto é "tem alguém usando agora?" — e essa
pergunta não é respondida por uma linha por requisição. Uma pessoa abrindo a
página gera dezenas de requisições (HTML, CSS, fonte, ícone, os polls da
cotação); um crawler gera uma e some. Contar requisição faria o crawler
parecer movimento e a pessoa parecer uma multidão.

Então aqui existe o conceito de VISITA: mesmo IP + mesmo User-Agent dentro de
`JANELA_MINUTOS` são a mesma visita. Ela é anunciada uma vez quando começa
("chegou") e resumida uma vez quando esfria ("saiu", com o que a pessoa fez e
quanto tempo ficou). No meio, só as ações que interessam.

SOBRE "pessoa ou bot": isto é PALPITE, e o log diz em qual sinal se baseou,
justamente pra ninguém tratar como fato. Um bot pode copiar os cabeçalhos de
um Chrome e passar por gente; é assim mesmo, não tem conserto do lado do
servidor. O que dá pra fazer com honestidade é separar três casos:

  * `bot-conhecido` — se identifica como robô no User-Agent (Googlebot, GPTBot,
    curl, python-requests). Alta confiança: ninguém mente pra PARECER robô.
  * `pessoa` — mandou os cabeçalhos que só navegador de verdade manda
    (`Sec-Fetch-*`, `Accept-Language`, `sec-ch-ua`). Boa confiança.
  * `suspeito` — diz ser navegador mas não manda o que navegador manda.
    É o caso do bot tentando se disfarçar, e também o do navegador muito
    antigo ou de um proxy que raspa cabeçalho. Fica marcado, não bloqueado.

Nada aqui BLOQUEIA nada. É log, e o objetivo é enxergar o movimento.

PRIVACIDADE: o IP é guardado inteiro no arquivo de visitas porque é o que
permite reconhecer visita repetida e abuso. Se isso for demais pro seu caso,
`VISITA_ANONIMIZAR_IP=1` corta o último octeto (`189.4.22.x`), o que mantém
a noção de "é o mesmo visitante" e perde a identificação individual.
"""
import hashlib
import os
import re
import threading
import time

from . import log

JANELA_MINUTOS = float(os.environ.get("VISITA_JANELA_MINUTOS", "30"))
ANONIMIZAR_IP = os.environ.get("VISITA_ANONIMIZAR_IP", "0") == "1"
# Caminhos que não contam como "atividade" pra decidir se a visita é de
# gente: são o que o navegador busca sozinho.
_ESTATICO = re.compile(r"\.(css|js|png|jpe?g|svg|ico|woff2?|ttf|map|webp)$", re.I)

# Robôs que se identificam. A lista não precisa ser completa — o `_GENERICO`
# abaixo pega o resto — mas ter o nome certo no log ajuda a distinguir
# "o Google indexou" de "alguém está raspando".
_CONHECIDOS = [
    ("googlebot", "Googlebot"), ("bingbot", "Bingbot"),
    ("duckduckbot", "DuckDuckBot"), ("yandexbot", "YandexBot"),
    ("baiduspider", "Baiduspider"), ("applebot", "Applebot"),
    ("facebookexternalhit", "Facebook"), ("twitterbot", "Twitterbot"),
    ("slackbot", "Slackbot"), ("discordbot", "Discordbot"),
    ("telegrambot", "TelegramBot"), ("whatsapp", "WhatsApp"),
    ("gptbot", "GPTBot"), ("oai-searchbot", "OAI-SearchBot"),
    ("chatgpt-user", "ChatGPT-User"), ("claudebot", "ClaudeBot"),
    ("claude-web", "Claude-Web"), ("perplexitybot", "PerplexityBot"),
    ("ccbot", "CCBot"), ("bytespider", "Bytespider"),
    ("ahrefsbot", "AhrefsBot"), ("semrushbot", "SemrushBot"),
    ("mj12bot", "MJ12bot"), ("dotbot", "DotBot"), ("petalbot", "PetalBot"),
    ("uptimerobot", "UptimeRobot"), ("pingdom", "Pingdom"),
    ("curl/", "curl"), ("wget/", "wget"), ("python-requests", "python-requests"),
    ("python-urllib", "python-urllib"), ("httpx/", "httpx"),
    ("go-http-client", "Go http"), ("okhttp", "OkHttp"), ("java/", "Java"),
    ("scrapy", "Scrapy"), ("postmanruntime", "Postman"),
    ("insomnia", "Insomnia"), ("libwww-perl", "libwww-perl"),
    ("headlesschrome", "HeadlessChrome"), ("phantomjs", "PhantomJS"),
    ("puppeteer", "Puppeteer"), ("playwright", "Playwright"),
    ("selenium", "Selenium"),
]
# Sem `\b` no fim de propósito: "SomeNewCrawler" e "MeuBot/1.0" precisam
# casar, e a fronteira de palavra não enxerga o camelCase. Nenhum destes
# pedaços aparece em User-Agent de navegador de verdade, então a folga não
# custa falso positivo.
_GENERICO = re.compile(
    r"(bot\b|bot[/ ;)]|crawler|crawl\b|spider|scraper|fetcher|"
    r"monitor|checker|indexer|archiver)", re.I)


def classificar(user_agent: str, cabecalhos) -> tuple[str, str]:
    """`(classe, sinal)` — a aposta e o motivo dela.

    O motivo viaja junto no log de propósito: seis meses depois, olhando uma
    linha `classe=suspeito`, a pergunta seguinte é sempre "por quê?".
    """
    ua = (user_agent or "").strip()
    if not ua:
        return "bot", "sem User-Agent"

    baixo = ua.lower()
    for marca, nome in _CONHECIDOS:
        if marca in baixo:
            return "bot-conhecido", nome
    if _GENERICO.search(baixo):
        return "bot-conhecido", "diz ser bot no User-Agent"

    # Cabeçalhos que navegador de verdade manda e biblioteca de HTTP quase
    # nunca se lembra de forjar.
    tem = lambda h: bool(cabecalhos.get(h))  # noqa: E731
    sinais = []
    if tem("sec-fetch-site") or tem("sec-fetch-mode"):
        sinais.append("Sec-Fetch")
    if tem("accept-language"):
        sinais.append("Accept-Language")
    if tem("sec-ch-ua"):
        sinais.append("sec-ch-ua")
    if "mozilla/" in baixo and ("gecko" in baixo or "webkit" in baixo):
        sinais.append("UA de navegador")

    if len(sinais) >= 2:
        return "pessoa", "+".join(sinais)
    if sinais:
        return "suspeito", f"só {sinais[0]}"
    return "suspeito", "sem cabeçalho de navegador"


def ip_do_pedido(request) -> str:
    """O IP real do visitante, atrás do túnel da Cloudflare.

    `request.client.host` seria o IP do túnel — o mesmo pra todo mundo, o que
    faria todas as visitas virarem uma só. O `CF-Connecting-IP` é posto pela
    Cloudflare e é o único confiável AQUI, porque este backend só é alcançado
    através dela. Num outro deploy, esse cabeçalho seria forjável.
    """
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        ip = cf.strip()
    else:
        encaminhado = request.headers.get("x-forwarded-for", "")
        ip = (encaminhado.split(",")[0].strip()
              or (request.client.host if request.client else "?"))
    if ANONIMIZAR_IP:
        if ":" in ip:                      # IPv6: guarda só o prefixo da rede
            ip = ":".join(ip.split(":")[:3]) + "::x"
        else:
            ip = ".".join(ip.split(".")[:3] + ["x"])
    return ip


class _Visitas:
    """As visitas vivas, na memória do processo.

    Na memória e não no banco porque isto é sinal operacional, não registro:
    o que precisa durar já está no arquivo de log. Reiniciar o backend zera a
    contagem e não perde nada.
    """

    def __init__(self):
        self._trava = threading.Lock()
        self._ativas: dict[str, dict] = {}

    def registrar(self, ip: str, ua: str, caminho: str, classe: str,
                  sinal: str, pais: str = "") -> dict:
        """Registra a requisição e devolve uma FOTO da visita.

        Foto, e não a visita viva, porque duas requisições simultâneas do
        mesmo visitante (o navegador abre várias conexões de uma vez) pegam o
        mesmo dict: a segunda apagaria o `nova` da primeira antes de quem
        chamou conseguir ler, e o "chegou" nunca sairia no log.
        """
        chave = hashlib.sha256(f"{ip}|{ua}".encode()).hexdigest()[:12]
        agora = time.time()
        self._expirar(agora)
        with self._trava:
            visita = self._ativas.get(chave)
            nova = visita is None
            if nova:
                visita = {"id": chave, "ip": ip, "ua": ua, "classe": classe,
                          "sinal": sinal, "pais": pais, "inicio": agora,
                          "pedidos": 0, "acoes": []}
                self._ativas[chave] = visita
            visita["visto"] = agora
            visita["pedidos"] += 1
            if not _ESTATICO.search(caminho):
                visita["ultimo"] = caminho
            return {**visita, "acoes": list(visita["acoes"]), "nova": nova}

    def anotar(self, chave: str, acao: str):
        """Marca uma ação de verdade (pediu orçamento, cotou, avisou Pix).

        É o que separa "alguém passou pela página" de "alguém USOU o sistema",
        e é isso que sai no resumo quando a visita esfria.
        """
        with self._trava:
            visita = self._ativas.get(chave)
            if visita is not None and acao not in visita["acoes"]:
                visita["acoes"].append(acao)

    def _expirar(self, agora: float):
        limite = JANELA_MINUTOS * 60
        with self._trava:
            vencidas = [k for k, v in self._ativas.items()
                        if agora - v["visto"] > limite]
            saindo = [self._ativas.pop(k) for k in vencidas]
        for v in saindo:
            log.evento("visita", "saiu", id=v["id"], ip=v["ip"],
                       classe=v["classe"], pedidos=v["pedidos"],
                       minutos=round((v["visto"] - v["inicio"]) / 60, 1),
                       acoes=", ".join(v["acoes"]) or None)

    def ativas(self) -> list[dict]:
        self._expirar(time.time())
        agora = time.time()
        with self._trava:
            return sorted(
                ({"id": v["id"], "ip": v["ip"], "classe": v["classe"],
                  "sinal": v["sinal"], "pais": v["pais"],
                  "user_agent": v["ua"][:160],
                  "ha_segundos": int(agora - v["visto"]),
                  "duracao_segundos": int(v["visto"] - v["inicio"]),
                  "pedidos": v["pedidos"], "ultimo": v.get("ultimo", ""),
                  "acoes": list(v["acoes"])}
                 for v in self._ativas.values()),
                key=lambda v: v["ha_segundos"])


registro = _Visitas()
