"""
Confere a base local de cartas: a leitura do bulk data e a busca.

Motivo de existir. Duas coisas aqui quebram calado se ninguém olhar:

1. **A leitura em streaming.** O bulk da Scryfall passa de 100 MB e é
   consumido em pedaços, com o objeto JSON podendo terminar no meio de um
   pedaço — e o pedaço podendo cortar um caractere UTF-8 ao meio (o "û" de
   Nazgûl). Um bug aí não dá erro: dá uma base com menos cartas do que
   deveria, e ninguém percebe até procurar uma carta que sumiu.

2. **O filtro de identidade de cor.** Ele é escrito ao contrário (proíbe as
   cores que ficaram de fora, em vez de exigir as de dentro), porque SQLite
   não tem operação de conjunto. Se ele errar, o deckbuilder deixa montar
   deck ilegal — que é justamente o que ele existe pra evitar.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_cartas.py

Sai com código 1 se qualquer checagem falhar.
"""
import gzip
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# O caminho do banco é lido na importação do módulo.
TMP = tempfile.mkdtemp(prefix="teste-cartas-")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")

from app import cartas  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


def carta(nome, tipo="Creature — Elf", texto="", cmc=1.0, custo="{G}",
          cores="G", ident="G", **extra):
    """Uma carta no formato que o bulk data entrega."""
    base = {
        "oracle_id": nome.lower(), "name": nome, "type_line": tipo,
        "oracle_text": texto, "cmc": cmc, "mana_cost": custo,
        "colors": list(cores), "color_identity": list(ident),
        "legalities": {"commander": extra.pop("legal", "legal")},
        "prices": {"usd": extra.pop("preco", "1.00")},
        "layout": extra.pop("layout", "normal"),
        "image_uris": {"normal": "http://exemplo/arte.jpg"},
    }
    base.update(extra)
    return base


try:
    # ---------------------------------------------------------------- streaming
    print("\n--- leitura do bulk em pedaços ---")

    lista = [carta(f"Carta {i}") for i in range(5)]
    texto = json.dumps(lista)

    # Um pedaço só: o caso fácil.
    lidas = list(cartas.objetos_do_array([texto]))
    eq("array inteiro num pedaço só", len(lidas), 5)

    # Um caractere por vez: todo objeto termina no meio de um pedaço.
    lidas = list(cartas.objetos_do_array(list(texto)))
    eq("array lido caractere a caractere", len(lidas), 5)
    eq("os nomes sobrevivem ao fatiamento",
       [c["name"] for c in lidas], [f"Carta {i}" for i in range(5)])

    # Array vazio e array com espaço em branco em volta.
    eq("array vazio", list(cartas.objetos_do_array(["[]"])), [])
    eq("array com espaços", len(list(cartas.objetos_do_array(["  [ ", "{}", " ,{} ]"]))), 2)

    # Fluxo cortado no meio: TEM que acusar. Um download incompleto que passa
    # calado vira uma base pela metade.
    try:
        list(cartas.objetos_do_array([texto[:len(texto) // 2]]))
        check("download incompleto levanta erro", False, "(passou calado)")
    except cartas.CartasError:
        check("download incompleto levanta erro", True)

    # Resposta que não é array (uma página de erro HTML, por exemplo).
    try:
        list(cartas.objetos_do_array(["<html>erro</html>"]))
        check("resposta que não é array levanta erro", False, "(passou calado)")
    except cartas.CartasError:
        check("resposta que não é array levanta erro", True)

    # UTF-8 cortado entre pedaços: o decodificador incremental segura o
    # pedaço órfão. Sem isso, "Nazgûl" viraria exceção de decodificação.
    class RespostaFalsa:
        def __init__(self, dados, tamanho):
            self._blocos = [dados[i:i + tamanho]
                            for i in range(0, len(dados), tamanho)]

        def iter_content(self, chunk_size=0):
            return iter(self._blocos)

    bruto = json.dumps([carta("Nazgûl"), carta("Æther Vial")]).encode("utf-8")
    lidas = list(cartas.objetos_do_array(cartas._pedacos(RespostaFalsa(bruto, 3))))
    eq("caractere multibyte cortado entre pedaços",
       [c["name"] for c in lidas], ["Nazgûl", "Æther Vial"])

    # ------------------------------------------------------------- bulk JSONL
    print("\n--- bulk em JSONL gzipado (formato de hoje) ---")

    jsonl = "".join(json.dumps(carta(f"Carta {i}")) + "\n" for i in range(5))

    eq("jsonl inteiro num pedaço só",
       len(list(cartas.objetos_do_jsonl([jsonl]))), 5)
    eq("jsonl lido caractere a caractere",
       [c["name"] for c in cartas.objetos_do_jsonl(list(jsonl))],
       [f"Carta {i}" for i in range(5)])
    eq("jsonl sem quebra de linha no fim",
       len(list(cartas.objetos_do_jsonl([jsonl.rstrip("\n")]))), 5)
    eq("linha em branco no meio não vira carta",
       len(list(cartas.objetos_do_jsonl([jsonl.replace("\n", "\n\n", 1)]))), 5)

    # Última linha cortada: download incompleto, tem que acusar.
    try:
        list(cartas.objetos_do_jsonl([jsonl[:len(jsonl) // 2]]))
        check("jsonl cortado no meio levanta erro", False, "(passou calado)")
    except cartas.CartasError:
        check("jsonl cortado no meio levanta erro", True)

    # O despachante decide pelo conteúdo, não pelo campo de onde veio a URL.
    eq("despachante reconhece array", len(list(cartas.objetos_do_bulk([texto]))), 5)
    eq("despachante reconhece jsonl", len(list(cartas.objetos_do_bulk([jsonl]))), 5)
    eq("despachante aguenta espaço antes do conteúdo",
       len(list(cartas.objetos_do_bulk(["  ", "\n", jsonl]))), 5)
    for ruim, nome in ((["<html>erro</html>"], "página de erro"),
                       ([], "fluxo vazio"),
                       (["   "], "só espaço em branco")):
        try:
            list(cartas.objetos_do_bulk(ruim))
            check(f"despachante recusa {nome}", False, "(passou calado)")
        except cartas.CartasError:
            check(f"despachante recusa {nome}", True)

    # Gzip: a Scryfall manda `.gz` sem Content-Encoding, então o gunzip é
    # nosso. O `_pedacos` decide pelo número mágico, não pelo cabeçalho.
    comprimido = gzip.compress(jsonl.encode("utf-8"))
    lidas = list(cartas.objetos_do_bulk(
        cartas._pedacos(RespostaFalsa(comprimido, 7))))
    eq("jsonl gzipado chega em cartas", len(lidas), 5)
    eq("jsonl cru também passa",
       len(list(cartas.objetos_do_bulk(
           cartas._pedacos(RespostaFalsa(jsonl.encode("utf-8"), 7))))), 5)

    bruto = gzip.compress(
        "".join(json.dumps(carta(n)) + "\n"
                for n in ("Nazgûl", "Æther Vial")).encode("utf-8"))
    eq("multibyte sobrevive ao gunzip em pedaços",
       [c["name"] for c in cartas.objetos_do_bulk(
           cartas._pedacos(RespostaFalsa(bruto, 5)))],
       ["Nazgûl", "Æther Vial"])

    # ------------------------------------------------------------ leitura de campo
    print("\n--- uma carta do bulk virando linha ---")

    eq("ficha não entra na base",
       cartas._linha(carta("Goblin", layout="token")), None)

    linha = dict(zip([c.strip() for c in cartas._COLUNAS.split(",")],
                     cartas._linha(carta("Nature's Lore", tipo="Sorcery"))))
    eq("nome guardado como veio", linha["nome"], "Nature's Lore")
    eq("nome achatado pra busca", linha["busca"], "natures lore")

    lendaria = cartas._linha(carta(
        "Atraxa", tipo="Legendary Creature — Angel", ident="WUBG"))
    eq("criatura lendária pode ser comandante", lendaria[11], 1)
    eq("identidade sai ordenada", lendaria[9], "BGUW")

    comum = cartas._linha(carta("Llanowar Elves"))
    eq("criatura comum não é comandante", comum[11], 0)

    diz_que_pode = cartas._linha(carta(
        "Rograkh", tipo="Artifact", texto="This card can be your commander."))
    eq("carta que diz que pode ser comandante", diz_que_pode[11], 1)

    parceiro = cartas._linha(carta("Tymna", tipo="Legendary Creature — Cleric",
                                   texto="Partner (You can have two commanders...)"))
    eq("parceiro reconhecido", parceiro[12], 1)

    basico = cartas._linha(carta("Snow-Covered Forest",
                                 tipo="Basic Snow Land — Forest"))
    eq("terreno básico reconhecido (inclusive nevado)", basico[13], 1)

    ilimitada = cartas._linha(carta(
        "Rat Colony", tipo="Creature — Rat",
        texto="A deck can have any number of cards named Rat Colony."))
    eq("carta que pode repetir reconhecida", ilimitada[14], 1)

    banida = cartas._linha(carta("Black Lotus", tipo="Artifact", legal="banned"))
    eq("carta banida marcada como ilegal", banida[10], 0)

    # Dupla-face: tipo, texto e custo moram DENTRO das faces, e a arte também.
    # Sem tratar isso, toda carta de duas faces entraria sem tipo nenhum.
    dfc = cartas._linha({
        "oracle_id": "dfc", "name": "Bruce Banner // The Incredible Hulk",
        "layout": "transform", "cmc": 4.0, "colors": ["G"],
        "color_identity": ["G", "R"], "legalities": {"commander": "legal"},
        "prices": {"usd": "4.20"},
        "card_faces": [
            {"name": "Bruce Banner",
             "type_line": "Legendary Creature — Human Scientist",
             "oracle_text": "Transforma.", "mana_cost": "{2}{G}{G}",
             "image_uris": {"normal": "http://exemplo/frente.jpg"}},
            {"name": "The Incredible Hulk", "type_line": "Creature — Monster",
             "oracle_text": "Trample", "mana_cost": ""},
        ],
    })
    campos = dict(zip([c.strip() for c in cartas._COLUNAS.split(",")], dfc))
    eq("dupla-face: tipo das duas faces",
       campos["tipo"],
       "Legendary Creature — Human Scientist // Creature — Monster")
    eq("dupla-face: busca pela frente", campos["busca_frente"], "bruce banner")
    eq("dupla-face: é comandante pela frente", campos["comandante"], 1)
    eq("dupla-face: arte vem da face da frente",
       campos["imagem"], "http://exemplo/frente.jpg")

    # ------------------------------------------------------------------- busca
    print("\n--- busca e filtros ---")

    cartas.init_db()
    povoar = [
        carta("Sol Ring", tipo="Artifact", custo="{1}", cores="", ident="", cmc=1),
        carta("Solemn Simulacrum", tipo="Artifact Creature — Golem",
              custo="{4}", cores="", ident="", cmc=4),
        carta("Lightning Bolt", tipo="Instant", custo="{R}", cores="R",
              ident="R", cmc=1),
        carta("Cultivate", tipo="Sorcery", custo="{2}{G}", cmc=3),
        carta("Atraxa", tipo="Legendary Creature — Angel", custo="{G}{W}{U}{B}",
              cores="GWUB", ident="GWUB", cmc=4),
        carta("Breeding Pool", tipo="Land — Forest Island", custo="",
              cores="", ident="GU", cmc=0),
        carta("Black Lotus", tipo="Artifact", custo="{0}", cores="", ident="",
              cmc=0, legal="banned"),
        {"oracle_id": "split", "name": "Fire // Ice", "layout": "split",
         "type_line": "Instant // Instant", "oracle_text": "", "cmc": 2.0,
         "colors": ["R", "U"], "color_identity": ["R", "U"],
         "legalities": {"commander": "legal"}, "prices": {"usd": "1"},
         "image_uris": {"normal": "x"}, "mana_cost": "{1}{R} // {1}{U}"},
    ]
    conn = cartas._conn()
    conn.executemany(
        f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
        f"VALUES ({cartas._INTERROGACOES})",
        [l for l in (cartas._linha(c) for c in povoar) if l is not None])
    conn.commit()
    conn.close()

    eq("base montada", cartas.estado()["cartas"], 8)

    # A normalização fica GRAVADA na coluna `busca`. Se ela mudar no código e
    # a base não for remontada, a consulta procura uma coisa e o banco guarda
    # outra — e o efeito não é erro, é carta que some da busca. Por isso a
    # versão viaja junto e uma divergência força a remontagem.
    conn = cartas._conn()
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('normalizacao', ?)",
                 (cartas.VERSAO_NORMALIZACAO,))
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('atualizado_em', ?)",
                 (str(time.time()),))
    conn.commit()
    conn.close()
    eq("base recém-montada não pede sync", cartas._precisa_sincronizar(), False)

    conn = cartas._conn()
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('normalizacao', 'antiga')")
    conn.commit()
    conn.close()
    eq("normalização diferente força a remontagem",
       cartas._precisa_sincronizar(), True)

    # O nome inteiro vem primeiro: quem digita "sol ring" quer o Sol Ring na
    # primeira linha, não o Solemn Simulacrum.
    eq("nome exato ordena na frente",
       [c["nome"] for c in cartas.buscar("sol ring")][0], "Sol Ring")
    eq("busca por pedaço acha os dois",
       len(cartas.buscar("sol")), 2)
    eq("busca ignora pontuação e caixa",
       [c["nome"] for c in cartas.buscar("BLACK LOTUS", so_legais=False)],
       ["Black Lotus"])

    eq("carta banida não aparece por padrão", cartas.buscar("black lotus"), [])
    check("carta banida aparece quando pedida",
          len(cartas.buscar("black lotus", so_legais=False)) == 1)

    eq("filtro de comandante",
       [c["nome"] for c in cartas.buscar(comandante=True)], ["Atraxa"])
    eq("filtro de tipo",
       sorted(c["nome"] for c in cartas.buscar(tipo="artifact")),
       ["Sol Ring", "Solemn Simulacrum"])

    # Identidade: o teste que mais importa. A regra é de SUBCONJUNTO.
    nomes_wubg = sorted(c["nome"] for c in cartas.buscar(identidade="WUBG"))
    check("identidade WUBG exclui a carta vermelha",
          "Lightning Bolt" not in nomes_wubg, f"({nomes_wubg})")
    check("identidade WUBG inclui incolor e verde",
          {"Sol Ring", "Cultivate", "Atraxa"} <= set(nomes_wubg), f"({nomes_wubg})")
    eq("identidade incolor só deixa carta sem cor",
       sorted(c["nome"] for c in cartas.buscar(identidade="")),
       ["Sol Ring", "Solemn Simulacrum"])
    eq("identidade GU aceita o terreno de duas cores",
       "Breeding Pool" in [c["nome"] for c in cartas.buscar(identidade="GU")], True)
    eq("identidade G sozinha recusa o terreno GU",
       "Breeding Pool" in [c["nome"] for c in cartas.buscar(identidade="G")], False)
    check("sem identidade não filtra nada",
          len(cartas.buscar()) == 7, "(7 legais de 8)")


    # ------------------------------------------------- filtros avançados
    print("\n--- filtros avançados (a gaveta da tela) ---")

    # Busca por EFEITO. Ela varre a coluna de texto, que não tem índice — e é
    # justamente por isso que o teste existe: se um dia alguém "otimizar" isso
    # trocando o LIKE por casamento exato, a busca por efeito passa a não
    # achar nada e ninguém percebe, porque lista vazia não é erro.
    conn = cartas._conn()
    conn.executemany(
        f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
        f"VALUES ({cartas._INTERROGACOES})",
        [cartas._linha(c) for c in [
            carta("Rhystic Study", tipo="Enchantment", custo="{2}{U}",
                  cores="U", ident="U", cmc=3, preco="45.00",
                  texto="Whenever an opponent casts a spell, that player may "
                        "pay {1}. If the player doesn't, you may draw a card."),
            carta("Sylvan Library", tipo="Enchantment", custo="{1}{G}",
                  cmc=2, preco="30.00",
                  texto="You may draw two additional cards. If you do, choose "
                        "two of them and pay 4 life for each one not put back."),
            carta("Dockside Chef", tipo="Creature — Goblin", custo="{1}{R}",
                  cores="R", ident="R", cmc=2, preco="0.30",
                  texto="Sacrifice another creature or artifact: Draw a card."),
        ]])
    conn.commit()
    conn.close()

    eq("efeito: uma palavra",
       sorted(c["nome"] for c in cartas.buscar(texto="draw")),
       ["Dockside Chef", "Rhystic Study", "Sylvan Library"])
    # AND entre as palavras, não frase exata: ninguém lembra a redação do
    # oracle, e "sacrifice creature" tem duas palavras no meio na carta real.
    eq("efeito: as palavras valem em qualquer ordem e com texto no meio",
       [c["nome"] for c in cartas.buscar(texto="sacrifice creature draw")],
       ["Dockside Chef"])
    eq("efeito: palavra que não existe não acha nada",
       cartas.buscar(texto="proliferate"), [])
    eq("efeito: combina com os outros filtros",
       [c["nome"] for c in cartas.buscar(texto="draw", tipo="enchantment",
                                         cmc_max=2)],
       ["Sylvan Library"])

    # Cor da CARTA, que não é a identidade dela: o Breeding Pool é incolor de
    # cor e GU de identidade. Confundir os dois faria o filtro "verde" trazer
    # terreno, que é o contrário do que se procura ao pedir "minhas cartas
    # verdes".
    eq("cor: uma cor",
       sorted(c["nome"] for c in cartas.buscar(cores="R")),
       ["Dockside Chef", "Fire // Ice", "Lightning Bolt"])
    eq("cor: várias cores é OU, não E",
       "Cultivate" in [c["nome"] for c in cartas.buscar(cores="RG")], True)
    eq("cor: incolor pega o que não tem cor nenhuma",
       sorted(c["nome"] for c in cartas.buscar(cores="C")),
       ["Breeding Pool", "Sol Ring", "Solemn Simulacrum"])
    check("cor: o terreno de identidade GU não conta como carta verde",
          "Breeding Pool" not in [c["nome"] for c in cartas.buscar(cores="G")])

    eq("cmc: faixa fechada",
       sorted(c["nome"] for c in cartas.buscar(cmc_min=2, cmc_max=3)),
       ["Cultivate", "Dockside Chef", "Fire // Ice", "Rhystic Study",
        "Sylvan Library"])
    eq("cmc: só o teto",
       "Atraxa" in [c["nome"] for c in cartas.buscar(cmc_max=3)], False)

    # Carta sem preço PASSA no teto, de propósito: preço ausente é o caso de
    # carta nova e de carta que ninguém vende, e sumir com ela num filtro de
    # orçamento esconderia carta barata sem dizer por quê.
    conn = cartas._conn()
    conn.execute("UPDATE cartas SET preco_usd = NULL WHERE nome = 'Cultivate'")
    conn.commit()
    conn.close()
    baratas = [c["nome"] for c in cartas.buscar(preco_max=1)]
    check("preço: o caro fica de fora", "Rhystic Study" not in baratas)
    check("preço: o barato entra", "Dockside Chef" in baratas)
    check("preço: carta sem preço conhecido passa no teto",
          "Cultivate" in baratas, f"({baratas})")

    # Ordenação. A chave nunca chega crua no SQL — se chegasse, `ordem` seria
    # uma porta de injeção aberta numa rota pública sem token.
    precos = [c["preco_usd"] for c in cartas.buscar(ordem="preco_desc")]
    check("ordem: mais cara primeiro", precos[0] == 45.0, f"({precos[:3]})")
    # Sem preço vai pro FIM das duas ordens: no "mais barata primeiro" ela
    # iria pro topo como se fosse de graça.
    precos = [c["preco_usd"] for c in cartas.buscar(ordem="preco")]
    check("ordem: sem preço vai pro fim, não pro topo dos baratos",
          precos[-1] is None, f"({precos})")
    eq("ordem: chave inventada cai no padrão em vez de ir pro SQL",
       [c["nome"] for c in cartas.buscar(ordem="'; DROP TABLE cartas; --")],
       [c["nome"] for c in cartas.buscar(ordem="nome")])
    # Com nome digitado, relevância ganha: "sol" ordenado por preço não pode
    # esconder o Sol Ring atrás do Solemn Simulacrum.
    eq("ordem: o nome digitado ganha da ordenação escolhida",
       [c["nome"] for c in cartas.buscar("sol ring", ordem="preco_desc")][0],
       "Sol Ring")

    # ------------------------------------------------------------- por_nomes
    print("\n--- resolver nomes ---")

    achadas = cartas.por_nomes(["Sol Ring", "sol ring", "SOL RING"])
    eq("acha o mesmo com qualquer caixa", len(achadas), 3)

    achadas = cartas.por_nomes(["Fire // Ice"])
    eq("carta de duas partes pelo nome inteiro",
       achadas.get("Fire // Ice", {}).get("nome"), "Fire // Ice")
    achadas = cartas.por_nomes(["Fire"])
    eq("carta de duas partes só pela frente",
       achadas.get("Fire", {}).get("nome"), "Fire // Ice")

    eq("nome que não existe volta de fora",
       cartas.por_nomes(["Carta Que Não Existe"]), {})
    eq("lista vazia não vira consulta", cartas.por_nomes([]), {})

    # ------------------------------------------------- carga inteira, sem rede
    #
    # Vai por último de propósito: `_carregar` troca a tabela `cartas`, então
    # qualquer teste de busca depois daqui estaria olhando outra base.
    #
    # Este bloco existe porque os dois bugs que derrubaram a sincronização de
    # verdade — a Scryfall trocando `download_uri` por JSONL gzipado, e o
    # `BEGIN IMMEDIATE` esbarrando na transação implícita do sqlite3 — só
    # apareciam com a carga rodando ponta a ponta. Testar os pedaços não
    # bastava: cada um passava sozinho.
    print("\n--- carga completa com a Scryfall falsa ---")

    class RespostaFalsaHTTP:
        def __init__(self, info=None, corpo=b""):
            self._info, self._corpo = info, corpo

        def raise_for_status(self):
            pass

        def json(self):
            return self._info

        def iter_content(self, chunk_size=0):
            tamanho = chunk_size or 64
            return iter([self._corpo[i:i + tamanho]
                         for i in range(0, len(self._corpo), tamanho)])

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    class SessaoFalsa:
        def __init__(self, info, corpo):
            self._info, self._corpo = info, corpo

        def get(self, url, timeout=None, stream=False):
            if "/bulk-data/" in url:
                return RespostaFalsaHTTP(info=self._info)
            return RespostaFalsaHTTP(corpo=self._corpo)

    # Precisa passar das 1000 cartas, senão a carga se recusa a trocar a base.
    muitas = "".join(json.dumps(carta(f"Bulk {i}")) + "\n" for i in range(1200))
    corpo = gzip.compress(muitas.encode("utf-8"))
    info = {"type": "oracle_cards", "updated_at": "2026-09-08T09:00:00+00:00",
            "jsonl_download_uri": "https://data.exemplo/oracle.jsonl.gz"}

    sessao_real = cartas._sessao
    cartas._sessao = lambda: SessaoFalsa(info, corpo)
    try:
        resumo = cartas._carregar()
        eq("carga contou as cartas", resumo["cartas"], 1200)
        eq("base trocada tem as cartas novas",
           cartas.estado()["cartas"], 1200)
        eq("carta da base nova é buscável",
           [c["nome"] for c in cartas.buscar("Bulk 7", limite=1)], ["Bulk 7"])

        # Formato antigo (array JSON, sem gzip) tem que continuar carregando:
        # é o que sobra se a Scryfall voltar atrás.
        antigo = json.dumps([carta(f"Velho {i}") for i in range(1100)])
        cartas._sessao = lambda: SessaoFalsa(
            {"download_uri": "https://data.exemplo/oracle.json"},
            antigo.encode("utf-8"))
        eq("array JSON sem gzip ainda carrega",
           cartas._carregar()["cartas"], 1100)

        # Bulk curto não pode derrubar a base boa.
        curto = "".join(json.dumps(carta(f"Curto {i}")) + "\n" for i in range(10))
        cartas._sessao = lambda: SessaoFalsa(info, gzip.compress(curto.encode()))
        try:
            cartas._carregar()
            check("bulk curto não troca a base", False, "(trocou!)")
        except cartas.CartasError:
            check("bulk curto não troca a base", True)
        eq("base boa sobreviveu ao bulk curto",
           cartas.estado()["cartas"], 1100)

        # E depois de uma falha o banco continua utilizável — se uma
        # transação tivesse ficado aberta, a carga seguinte travaria.
        cartas._sessao = lambda: SessaoFalsa(info, corpo)
        eq("carga depois da falha funciona", cartas._carregar()["cartas"], 1200)

        # Catálogo sem nenhuma URI de download: erro claro, base intacta.
        cartas._sessao = lambda: SessaoFalsa({"type": "oracle_cards"}, corpo)
        try:
            cartas._carregar()
            check("catálogo sem URI levanta erro", False, "(passou calado)")
        except cartas.CartasError:
            check("catálogo sem URI levanta erro", True)
    finally:
        cartas._sessao = sessao_real

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
