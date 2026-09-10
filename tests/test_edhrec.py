"""
Confere as sugestões do EDHREC e o filtro que decide o que vale mostrar.

Motivo de existir. Este é o módulo mais frágil do projeto depois da
LigaMagic: `json.edhrec.com` é o endpoint que o front-end deles usa, sem
contrato nenhum, e pode mudar de forma sem aviso. Duas coisas precisam estar
garantidas:

1. **Quando o formato mudar, tem que GRITAR.** Uma resposta sem `cardlists`
   não pode virar "nenhuma sugestão" — na tela isso se lê como "esse
   comandante não combina com nada", que é o oposto de "eu não sei".
2. **O slug tem que estar certo.** Ele é montado por nós a partir do nome da
   carta, e um slug errado vira 404. Apóstrofo e vírgula somem, acento é
   achatado, o resto vira hífen — e com dois comandantes os dois slugs entram
   em ordem alfabética.

E o filtro do que mostrar (`decks.sugestoes_uteis`) tem que tirar o que já
está no deck: sugerir a carta que a pessoa acabou de adicionar é o jeito mais
rápido de a lista parecer burra.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_edhrec.py

Sai com código 1 se qualquer checagem falhar.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-edhrec-")
os.environ["EDHREC_CACHE_DIR"] = os.path.join(TMP, "cache")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["EDHREC_BACKOFF"] = "0"
os.environ["EDHREC_DELAY_SEGUNDOS"] = "0"
os.environ["EDHREC_TENTATIVAS"] = "2"

from app import cartas, decks, edhrec  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def cardview(nome, sinergia=None, inclusao=None, potencial=None):
    return {"name": nome, "sanitized": nome.lower().replace(" ", "-"),
            "synergy": sinergia, "inclusion": inclusao,
            "potential_decks": potencial, "num_decks": potencial}


def pagina(listas, temas=()):
    return {
        "container": {"json_dict": {"cardlists": [
            {"tag": tag, "header": cabecalho, "cardviews": cartas_}
            for tag, cabecalho, cartas_ in listas]}},
        "panels": {"taglinks": [{"value": n, "slug": s, "count": c}
                                for n, s, c in temas]},
    }


class RespostaFalsa:
    def __init__(self, corpo, status=200, texto=None, headers=None):
        self.status_code = status
        self._corpo = corpo
        self.text = texto if texto is not None else json.dumps(corpo)
        self.headers = headers or {}

    def json(self):
        if self._corpo is None:
            raise ValueError("não é json")
        return self._corpo


class SessaoFalsa:
    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.chamadas = []
        self.headers = {}

    def get(self, url, **kwargs):
        self.chamadas.append(url)
        resposta = self.respostas.pop(0)
        if isinstance(resposta, Exception):
            raise resposta
        return resposta


def com_sessao(*respostas):
    sessao = SessaoFalsa(respostas)
    edhrec._sessao = lambda: sessao
    return sessao


PAGINA = pagina(
    listas=[
        ("topcards", "Top Cards", [cardview("Sol Ring", 0.02, 900, 1000),
                                   cardview("Arcane Signet", 0.05, 800, 1000)]),
        ("highsynergycards", "High Synergy Cards",
         [cardview("Deadly Rollick", 0.42, 400, 1000),
          cardview("Carta Que A Base Nao Tem", 0.38, 300, 1000),
          cardview("Lightning Bolt", 0.30, 200, 1000)]),
        ("creatures", "Creatures", [cardview("Eternal Witness", -0.10, 100, 1000)]),
        ("vazia", "Nada", []),
    ],
    temas=[("Aristocratas", "aristocrats", 1200),
           ("Superfriends", "superfriends", 800)],
)

try:
    # ------------------------------------------------------------------ slug
    print("\n--- o slug da página ---")

    eq("apóstrofo e vírgula somem",
       edhrec.slug("Atraxa, Praetors' Voice"), "atraxa-praetors-voice")
    eq("apóstrofo tipográfico também",
       edhrec.slug("Atraxa, Praetors’ Voice"), "atraxa-praetors-voice")
    eq("acento é achatado, não vira hífen",
       edhrec.slug("Jötun Grunt"), "jotun-grunt")
    eq("hífen do nome vira hífen só",
       edhrec.slug("Shang-Chi, Master of Kung Fu"),
       "shang-chi-master-of-kung-fu")
    eq("pontuação virando um hífen só",
       edhrec.slug("Kongming, \"Sleeping Dragon\""), "kongming-sleeping-dragon")
    # Carta de duas faces entra pela frente. O deck guarda o nome canônico
    # inteiro; o EDHREC só conhece a página da frente, e o slug com as duas
    # faces era exatamente o que fazia comandante de face dupla dar erro.
    eq("nome com // entra pela frente",
       edhrec.slug("Ojer Taq, Deepest Foundation // Temple of Civilization"),
       "ojer-taq-deepest-foundation")
    eq("e o slug do deck também",
       edhrec.slug_do_deck(["Esika, God of the Tree // The Prismatic Bridge"]),
       "esika-god-of-the-tree")

    eq("um comandante", edhrec.slug_do_deck(["Muldrotha, the Gravetide"]),
       "muldrotha-the-gravetide")
    # Dois comandantes entram em ordem alfabética, não na ordem que a tela
    # mandou — senão a mesma dupla teria duas páginas diferentes.
    dupla = ["Tymna the Weaver", "Thrasios, Triton Hero"]
    eq("dois comandantes saem em ordem alfabética",
       edhrec.slug_do_deck(dupla), "thrasios-triton-hero-tymna-the-weaver")
    eq("e a ordem inversa dá o mesmo slug",
       edhrec.slug_do_deck(list(reversed(dupla))),
       edhrec.slug_do_deck(dupla))

    try:
        edhrec.slug_do_deck([])
        check("sem comandante levanta", False, "(passou)")
    except edhrec.EDHRECError:
        check("sem comandante levanta", True)

    # -------------------------------------------------------- leitura da página
    print("\n--- o que a gente entende da página ---")

    sessao = com_sessao(RespostaFalsa(PAGINA))
    achado = edhrec.sugerir(["Muldrotha, the Gravetide"])
    eq("bate na URL do comandante", sessao.chamadas[0],
       f"{edhrec.BASE}/commanders/muldrotha-the-gravetide.json")

    eq("lista vazia não entra",
       [l["tag"] for l in achado["listas"]],
       ["highsynergycards", "topcards", "creatures"])
    check("alta sinergia vem antes das mais jogadas",
          achado["listas"][0]["tag"] == "highsynergycards")
    eq("categoria conhecida ganha nome em português",
       achado["listas"][0]["titulo"], "Alta sinergia")

    carta = achado["listas"][0]["cartas"][0]
    eq("nome da carta", carta["nome"], "Deadly Rollick")
    # A sinergia vem como fração e vira pontos inteiros: 0.42 -> 42.
    eq("sinergia vira porcentagem inteira", carta["sinergia"], 42)
    eq("e a inclusão vira porcentagem", carta["porcento"], 40)

    negativa = achado["listas"][2]["cartas"][0]
    eq("sinergia negativa é preservada", negativa["sinergia"], -10)

    eq("os temas saem dos taglinks",
       [(t["nome"], t["slug"]) for t in achado["temas"]],
       [("Aristocratas", "aristocrats"), ("Superfriends", "superfriends")])

    sessao = com_sessao(RespostaFalsa(PAGINA))
    com_tema = edhrec.sugerir(["Muldrotha, the Gravetide"], "Aristocratas")
    eq("tema entra no caminho da URL", sessao.chamadas[0],
       f"{edhrec.BASE}/commanders/muldrotha-the-gravetide/aristocratas.json")

    # ------------------------------------------------- a página de uma carta
    print("\n--- a página de uma carta ---")

    # A página de uma CARTA fala outra língua: `lift` (razão) no lugar de
    # `synergy` (diferença), e mais duas listas de COMANDANTE que não são
    # resposta pra "que carta entra agora?".
    pagina_carta = pagina(listas=[
        ("topcommanders", "Top Commanders", [cardview("Muldrotha, the Gravetide")]),
        ("newcommanders", "New Commanders", [cardview("Comandante Novo")]),
        ("topcards", "Top Cards", [{"name": "Deadly Rollick", "lift": 1.42,
                                    "num_decks": 400, "potential_decks": 1000}]),
        ("creatures", "Creatures", [{"name": "Eternal Witness", "lift": 0.9,
                                     "num_decks": 100, "potential_decks": 1000}]),
    ])

    sessao = com_sessao(RespostaFalsa(pagina_carta))
    daCarta = edhrec.sugerir_por_carta("Ashnod's Altar")
    eq("bate na URL da carta", sessao.chamadas[0],
       f"{edhrec.BASE}/cards/ashnods-altar.json")
    eq("as listas de comandante ficam de fora",
       [l["tag"] for l in daCarta["listas"]], ["topcards", "creatures"])
    # 1.42 é "42% mais provável junto dela"; menos 1 põe na mesma escala que
    # a `synergy` da página de comandante, e a tela mostra um número só.
    eq("lift vira a mesma sinergia em pontos",
       daCarta["listas"][0]["cartas"][0]["sinergia"], 42)
    eq("lift abaixo de 1 vira sinergia negativa",
       daCarta["listas"][1]["cartas"][0]["sinergia"], -10)
    eq("o título que falava do comandante muda",
       daCarta["listas"][0]["titulo"], "Mais jogadas junto")
    eq("o alvo diz que a lista é de uma carta",
       daCarta["alvo"], {"tipo": "carta", "nome": "Ashnod's Altar"})
    eq("e a página de carta não tem tema", (daCarta["tema"], daCarta["temas"]),
       (None, []))
    eq("o link aponta pra página da carta no site",
       daCarta["link"], f"{edhrec.SITE}/cards/ashnods-altar")

    sessao = com_sessao(RespostaFalsa(PAGINA))
    doCmd = edhrec.sugerir(["Muldrotha, the Gravetide"])
    eq("o alvo do comandante também vem dito",
       doCmd["alvo"], {"tipo": "comandante", "nome": "Muldrotha, the Gravetide"})

    espera = "carta sem nome não vira pedido"
    try:
        com_sessao()   # se pedir, explode
        edhrec.sugerir_por_carta("   ")
        check(espera, False, "(não levantou)")
    except edhrec.EDHRECError:
        check(espera, True)

    # ------------------------------------------------------------------ cache
    print("\n--- cache ---")

    sessao = com_sessao()   # se pedir, explode
    de_novo = edhrec.sugerir(["Muldrotha, the Gravetide"])
    eq("a mesma página volta do cache, sem rede",
       (de_novo["cache"], len(sessao.chamadas)), (True, 0))
    eq("e o conteúdo é o mesmo",
       len(de_novo["listas"]), len(achado["listas"]))

    # ----------------------------------------------------------------- falhas
    print("\n--- quando dá errado ---")

    def espera_erro(nome, *respostas, comandante="Comandante Unico"):
        com_sessao(*respostas)
        try:
            edhrec.sugerir([comandante])
            check(nome, False, "(não levantou)")
        except edhrec.EDHRECError as e:
            check(nome, True, f"({str(e)[:58]}…)")

    # A que mais importa: formato mudado NÃO pode virar lista vazia.
    espera_erro("resposta sem 'container' levanta",
                RespostaFalsa({"outra": "coisa"}), comandante="Sem Container")
    espera_erro("resposta sem 'cardlists' levanta",
                RespostaFalsa({"container": {"json_dict": {}}}),
                comandante="Sem Cardlists")
    espera_erro("resposta que não é JSON levanta",
                RespostaFalsa(None, texto="<html>bloqueado</html>"),
                comandante="Nao Json")
    espera_erro("404 diz que a página não existe",
                RespostaFalsa({}, status=404), comandante="Nao Existe")
    espera_erro("rede caída depois das tentativas",
                *[__import__("requests").ConnectionError("sem rota")] * 2,
                comandante="Sem Rede")

    # 404 não é insistido: a página não existe, repetir não vai criá-la.
    sessao = com_sessao(RespostaFalsa({}, status=404))
    try:
        edhrec.sugerir(["Outro Que Nao Existe"])
    except edhrec.EDHRECError:
        pass
    eq("404 não é tentado de novo", len(sessao.chamadas), 1)

    # O 403 de bucket vazio: `json.edhrec.com` é S3 atrás do CloudFront e
    # responde AccessDenied, não 404, quando a página não está lá. Se isso
    # virar "status inesperado", a pessoa recebe "não consegui ler o EDHREC
    # (HTTP 403)" — que manda caçar problema de rede que não existe.
    ACESSO_NEGADO = ('<?xml version="1.0" encoding="UTF-8"?>'
                     "<Error><Code>AccessDenied</Code>"
                     "<Message>Access Denied</Message></Error>")
    sessao = com_sessao(RespostaFalsa(None, status=403, texto=ACESSO_NEGADO))
    try:
        edhrec.sugerir(["Pagina Que Nao Existe"])
        check("403 de página inexistente levanta", False, "(não levantou)")
    except edhrec.EDHRECError as e:
        check("403 de página inexistente diz que não existe",
              "não tem página" in str(e), f"({str(e)[:58]}…)")
    eq("e não é tentado de novo", len(sessao.chamadas), 1)

    # 403 SEM esse XML é outra coisa — bloqueio, WAF, IP barrado — e aí
    # tentar de novo continua fazendo sentido.
    sessao = com_sessao(RespostaFalsa(None, status=403, texto="<html>WAF</html>"),
                        RespostaFalsa(PAGINA))
    bloqueado = edhrec.sugerir(["Comandante Barrado"])
    eq("403 que não é do S3 é tentado de novo",
       (len(sessao.chamadas), len(bloqueado["listas"])), (2, 3))

    # 500 é transitório: tenta de novo.
    sessao = com_sessao(RespostaFalsa({}, status=500), RespostaFalsa(PAGINA))
    tentou = edhrec.sugerir(["Comandante Do Cinco Zero Zero"])
    eq("erro de servidor é tentado de novo",
       (len(sessao.chamadas), len(tentou["listas"])), (2, 3))

    edhrec.LIGADO = False
    try:
        edhrec.sugerir(["Muldrotha, the Gravetide"])
        check("desligado no .env levanta em vez de dar lista vazia", False)
    except edhrec.EDHRECError:
        check("desligado no .env levanta em vez de dar lista vazia", True)
    edhrec.LIGADO = True

    # ------------------------------------------------------------ deck médio
    print("\n--- o deck médio ---")

    def pagina_media(cartas_por_tipo, num_decks=329):
        return {"deck": {"commander": ["Ojer Taq, Deepest Foundation"],
                         "cards": cartas_por_tipo},
                "container": {"json_dict": {"cardlists": [],
                                            "card": {"num_decks": num_decks}}}}

    MEDIA = pagina_media({
        "Artifact": [["Sol Ring", 1], ["Arcane Signet", 1]],
        "Land": [["Command Tower", 1], ["Plains", 12]],
        "Creature": [["Esquisita", "um"], ["Zerada", 0], ["Sem Par"]],
    })

    OJER = "Ojer Taq, Deepest Foundation // Temple of Civilization"
    sessao = com_sessao(RespostaFalsa(MEDIA))
    medio = edhrec.deck_medio([OJER], "core", "budget")
    eq("o caminho leva bracket e orçamento, nessa ordem",
       sessao.chamadas[0].rsplit("/pages/", 1)[1],
       "average-decks/ojer-taq-deepest-foundation/core/budget.json")
    eq("as cartas saem com quantidade, e básico somado",
       sorted((c["nome"], c["quantidade"]) for c in medio["cartas"]),
       [("Arcane Signet", 1), ("Command Tower", 1), ("Plains", 12),
        ("Sol Ring", 1)])
    eq("o comandante que volta é o pedido, não o da página",
       medio["comandantes"], [OJER])
    eq("o nome diz os filtros em português",
       medio["nome"], f"Deck médio de {OJER} (Núcleo, econômico)")
    eq("quantos decks entraram na média", medio["decks"], 329)
    eq("e o link é da página filtrada", medio["link"],
       f"{edhrec.SITE}/average-decks/ojer-taq-deepest-foundation/core/budget")

    sessao = com_sessao(RespostaFalsa(MEDIA))
    edhrec.deck_medio(["Muldrotha, the Gravetide"], orcamento="expensive")
    eq("só orçamento, sem bracket",
       sessao.chamadas[0].rsplit("/pages/", 1)[1],
       "average-decks/muldrotha-the-gravetide/expensive.json")

    for nome, args in (("bracket desconhecido", ("bracket-6", None)),
                       ("orçamento desconhecido", (None, "middle"))):
        com_sessao()   # se pedir, explode
        try:
            edhrec.deck_medio(["Muldrotha, the Gravetide"], *args)
            check(f"{nome} levanta ValueError", False, "(não levantou)")
        except ValueError:
            check(f"{nome} levanta ValueError", True)

    # Com filtro, a página que falta quase sempre é "poucos decks assim" — e o
    # recado tem que dizer isso, não mandar procurar erro de parceria.
    com_sessao(RespostaFalsa(None, status=403, texto=ACESSO_NEGADO))
    try:
        edhrec.deck_medio(["Comandante Raro"], "cedh", "budget")
        check("combinação sem página levanta", False, "(não levantou)")
    except edhrec.PaginaInexistente as e:
        check("combinação sem página sugere filtro mais largo",
              "filtro mais largo" in str(e), f"({str(e)[:58]}…)")

    com_sessao(RespostaFalsa({"container": {"json_dict": {}}}))
    try:
        edhrec.deck_medio(["Deck Medio Sem Deck"])
        check("página sem 'deck' levanta", False, "(não levantou)")
    except edhrec.EDHRECError as e:
        check("página sem 'deck' levanta", "formato" in str(e),
              f"({str(e)[:58]}…)")

    com_sessao(RespostaFalsa(pagina_media({"Land": []})))
    try:
        edhrec.deck_medio(["Deck Medio Vazio"])
        check("deck médio vazio levanta em vez de lista vazia", False)
    except edhrec.EDHRECError:
        check("deck médio vazio levanta em vez de lista vazia", True)

    # ------------------------------------------- o filtro do que vale mostrar
    print("\n--- o filtro contra o deck ---")

    cartas.init_db()
    def base(nome, tipo="Creature — Elf", ident="G", legal="legal"):
        return {"oracle_id": nome.lower(), "name": nome, "type_line": tipo,
                "oracle_text": "", "cmc": 2.0, "mana_cost": "{1}{G}",
                "colors": list(ident), "color_identity": list(ident),
                "legalities": {"commander": legal}, "prices": {"usd": "1"},
                "layout": "normal", "image_uris": {"normal": "http://x"}}

    conn = cartas._conn()
    conn.executemany(
        f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
        f"VALUES ({cartas._INTERROGACOES})",
        [cartas._linha(c) for c in [
            base("Muldrotha, the Gravetide",
                 tipo="Legendary Creature — Avatar", ident="BGU"),
            base("Sol Ring", tipo="Artifact", ident=""),
            base("Arcane Signet", tipo="Artifact", ident=""),
            base("Deadly Rollick", tipo="Instant", ident="B"),
            base("Eternal Witness", ident="G"),
            base("Lightning Bolt", tipo="Instant", ident="R"),
        ]])
    conn.commit()
    conn.close()

    deck = {"comandantes": ["Muldrotha, the Gravetide"],
            "cartas": [{"nome": "Sol Ring", "quantidade": 1}]}

    uteis = decks.sugestoes_uteis(deck, achado["listas"])
    nomes = [c["carta"]["nome"] for l in uteis for c in l["cartas"]]

    check("o que já está no deck não é sugerido",
          "Sol Ring" not in nomes, f"({nomes})")
    check("o que a base local não conhece não é sugerido",
          "Carta Que A Base Nao Tem" not in nomes, f"({nomes})")
    check("o que não cabe na identidade não é sugerido",
          "Lightning Bolt" not in nomes, f"({nomes})")
    check("o que sobra é sugerido",
          {"Deadly Rollick", "Arcane Signet", "Eternal Witness"} == set(nomes),
          f"({nomes})")

    primeira = uteis[0]["cartas"][0]
    check("a carta completa vai junto, pra adicionar num clique",
          primeira["carta"]["tipo"] == "Instant" and primeira["sinergia"] == 42,
          f"({primeira['carta']['nome']})")

    # O comandante também conta como "já está no deck".
    deck_cmd = {"comandantes": ["Deadly Rollick"], "cartas": []}
    nomes_cmd = [c["carta"]["nome"]
                 for l in decks.sugestoes_uteis(deck_cmd, achado["listas"])
                 for c in l["cartas"]]
    check("o próprio comandante não é sugerido",
          "Deadly Rollick" not in nomes_cmd, f"({nomes_cmd})")

    # Teto por lista, pra uma página de comandante não despejar 100 linhas.
    muitas = [{"tag": "topcards", "titulo": "Mais jogadas com ele",
               "cartas": [{"nome": "Arcane Signet", "sinergia": 1},
                          {"nome": "Deadly Rollick", "sinergia": 2},
                          {"nome": "Eternal Witness", "sinergia": 3}]}]
    eq("o teto por lista é respeitado",
       len(decks.sugestoes_uteis(deck, muitas, por_lista=2)[0]["cartas"]), 2)

    eq("lista que fica vazia depois do filtro some",
       decks.sugestoes_uteis(
           deck, [{"tag": "topcards", "titulo": "x",
                   "cartas": [{"nome": "Sol Ring", "sinergia": 1}]}]),
       [])

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
