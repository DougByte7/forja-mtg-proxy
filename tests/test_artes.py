"""
Confere onde a escolha de arte é guardada, e o que ela sobrevive.

MOTIVO DE EXISTIR. Escolher arte carta a carta é o trabalho mais chato de
montar um deck de proxy, e a escolha some em silêncio de três maneiras — todas
elas parecendo "eu não escolhi ainda":

1. **O autosave passando por cima.** A linha do deck é reescrita inteira a
   cada tecla; se a arte morasse nela, uma escolha feita enquanto um autosave
   estava em voo simplesmente sumiria. É a razão da tabela separada, e o teste
   que a prova é o que grava arte, salva o deck por cima e confere que ela
   continua lá.
2. **A chave errada.** Se fosse a posição na lista, reordenar o deck
   embaralharia as artes; se fosse o nome cru, "Lim-Dûl's Vault" e "Lim-Dul's
   Vault" viravam duas linhas e a escolha de uma não apareceria na outra.
3. **O deck duplicado nascendo pelado.** Quem duplica quer a cópia igual,
   inclusive nisso.

E o inverso: deck apagado tem que levar as artes junto, senão a tabela cresce
pra sempre com linhas de decks que ninguém consegue mais abrir.

Não precisa de rede nem de pytest. Rode de dentro da raiz do projeto:

    python tests/test_artes.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TMP = tempfile.mkdtemp(prefix="teste-artes-")
os.environ["DB_PATH"] = os.path.join(TMP, "orders.db")
os.environ["CARTAS_DB_PATH"] = os.path.join(TMP, "cartas.db")
os.environ["LOG_DIR"] = TMP
os.environ["LOG_NIVEL"] = "ERROR"

from app import artes, cartas, decks  # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"(obtido {obtido!r}, esperado {esperado!r})")


try:
    cartas.init_db()
    decks.init_db()
    artes.init_db()

    deck = decks.criar("Deck com arte", ["Atraxa"], [
        {"nome": "Sol Ring", "quantidade": 1},
        {"nome": "Lim-Dûl's Vault", "quantidade": 1},
    ])

    print("\n--- escolher e ler ---")

    artes.escolher(deck["id"], "Sol Ring", "drive-aaa",
                   arquivo="Sol Ring (Kaladesh).png", fonte="Chilli", dpi=800)
    escolhas = artes.do_deck(deck["id"])
    chave = cartas.normalizar("Sol Ring")
    eq("a escolha é lida de volta", escolhas[chave]["frente"]["drive_id"], "drive-aaa")
    eq("com o nome do arquivo junto",
       escolhas[chave]["frente"]["arquivo"], "Sol Ring (Kaladesh).png")
    eq("e o DPI", escolhas[chave]["frente"]["dpi"], 800)

    # O nome do arquivo é metade do caminho de volta quando um id do Drive
    # morre: é o que permite dizer QUAL arte sumiu.
    check("o arquivo é guardado, não só o id",
          bool(escolhas[chave]["frente"]["arquivo"]))

    print("\n--- a chave é o nome achatado ---")

    # Se a chave fosse o nome cru, estas duas seriam linhas diferentes e a
    # escolha feita numa não apareceria na outra.
    artes.escolher(deck["id"], "Lim-Dûl's Vault", "drive-bbb")
    depois = artes.do_deck(deck["id"])
    eq("acento e apóstrofo casam com a mesma linha",
       depois[cartas.normalizar("Lim-Dul's Vault")]["frente"]["drive_id"], "drive-bbb")
    eq("e não criam duas entradas", len(depois), 2)

    # Escolher de novo TROCA, não duplica: é o que "usar esta arte" faz.
    artes.escolher(deck["id"], "sol ring", "drive-ccc")
    eq("escolher de novo troca a arte",
       artes.do_deck(deck["id"])[chave]["frente"]["drive_id"], "drive-ccc")
    eq("e não duplica a linha", len(artes.do_deck(deck["id"])), 2)

    print("\n--- as duas faces ---")

    artes.escolher(deck["id"], "Sol Ring", "drive-verso", face="verso")
    faces = artes.do_deck(deck["id"])[chave]
    eq("frente e verso convivem", sorted(faces), ["frente", "verso"])
    eq("sem se sobrescrever", faces["frente"]["drive_id"], "drive-ccc")

    try:
        artes.escolher(deck["id"], "Sol Ring", "x", face="lateral")
        check("face inventada é recusada", False, "(aceitou)")
    except ValueError:
        check("face inventada é recusada", True)

    try:
        artes.escolher(deck["id"], "Sol Ring", "")
        check("id de arte vazio é recusado", False, "(aceitou)")
    except ValueError:
        check("id de arte vazio é recusado", True)

    print("\n--- o autosave não leva a arte embora ---")

    # A razão de a tabela ser separada. Se a arte morasse na linha do deck,
    # este `salvar` — que reescreve a linha inteira — apagaria a escolha, e
    # não haveria erro nenhum pra ver.
    decks.salvar(deck["id"], "Outro nome", ["Atraxa"],
                 [{"nome": "Sol Ring", "quantidade": 4},
                  {"nome": "Forest", "quantidade": 10}])
    eq("gravar o deck por cima não mexe nas artes",
       artes.do_deck(deck["id"])[chave]["frente"]["drive_id"], "drive-ccc")
    eq("nem mudar a quantidade da carta", len(artes.do_deck(deck["id"])), 2)

    print("\n--- o que ainda está no padrão ---")

    resumo = artes.para_deck(decks.obter(deck["id"]))
    # Atraxa e Forest não foram escolhidas; Sol Ring e Lim-Dûl's Vault sim —
    # mas Lim-Dûl's Vault saiu do deck no `salvar` acima.
    check("Forest aparece como faltando", "Forest" in resumo["faltando"])
    check("o comandante também", "Atraxa" in resumo["faltando"])
    check("Sol Ring não", "Sol Ring" not in resumo["faltando"])

    print("\n--- duplicar leva as artes ---")

    copia = decks.duplicar(deck["id"])
    eq("a cópia nasce com as artes do original",
       artes.do_deck(copia["id"])[chave]["frente"]["drive_id"], "drive-ccc")
    # E são independentes a partir daí: mexer numa não mexe na outra.
    artes.escolher(copia["id"], "Sol Ring", "drive-só-da-copia")
    eq("mas as duas seguem independentes",
       artes.do_deck(deck["id"])[chave]["frente"]["drive_id"], "drive-ccc")

    print("\n--- apagar o deck leva as artes ---")

    decks.apagar(copia["id"])
    eq("as artes do deck apagado somem", artes.do_deck(copia["id"]), {})
    eq("e as do original ficam", len(artes.do_deck(deck["id"])), 2)

    eq("limpar devolve a carta pro padrão",
       artes.limpar(deck["id"], "Sol Ring"), True)
    eq("limpar de novo não é erro, é False",
       artes.limpar(deck["id"], "Sol Ring"), False)
    check("e a face verso continua lá, que é outra escolha",
          "verso" in artes.do_deck(deck["id"])[chave])

    print("\n--- o deck vira pedido ---")

    # Uma carta de duas faces na base, pra o pedido saber que ela tem verso.
    conn = cartas._conn()
    conn.execute(
        f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
        f"VALUES ({cartas._INTERROGACOES})",
        cartas._linha({
            "oracle_id": "delver", "layout": "transform", "cmc": 1.0,
            "name": "Delver of Secrets // Insectile Aberration",
            "colors": ["U"], "color_identity": ["U"],
            "legalities": {"commander": "legal"},
            "card_faces": [
                {"name": "Delver of Secrets", "type_line": "Creature — Human Wizard",
                 "mana_cost": "{U}", "image_uris": {"normal": "http://arte/delver"}},
                {"name": "Insectile Aberration", "type_line": "Creature — Human Insect",
                 "mana_cost": "", "image_uris": {"normal": "http://arte/inseto"}},
            ],
        }))
    conn.commit()
    conn.close()

    delver = "Delver of Secrets // Insectile Aberration"
    ped = decks.criar("Pedido", ["Atraxa"], [
        {"nome": "Sol Ring", "quantidade": 1},
        {"nome": "Forest", "quantidade": 3},
        {"nome": delver, "quantidade": 2},
        {"nome": "Lightning Bolt", "quantidade": 1,
         "categoria": decks.CATEGORIA_SIDEBOARD},
    ], maybeboard=[{"nome": "Island", "quantidade": 1}])

    montado = artes.pedido(ped)
    eq("sem arte nenhuma, não sai XML", montado["xml"], None)
    eq("a carta de duas faces conta frente e verso",
       [f["face"] for f in montado["faltando"] if f["nome"] == delver],
       ["frente", "verso"])
    check("o sideboard vai pro papel",
          any(f["nome"] == "Lightning Bolt" for f in montado["faltando"]))
    check("o maybeboard não",
          not any(f["nome"] == "Island" for f in montado["faltando"]))
    eq("uma arte por lado de cada carta", montado["artes"], 6)
    eq("uma posição na folha por cópia", montado["cartas"], 8)

    for nome, drive_id in (("Atraxa", "id-atraxa"), ("Sol Ring", "id-sol"),
                           ("Lightning Bolt", "id-bolt"), (delver, "id-delver")):
        artes.escolher(ped["id"], nome, drive_id, arquivo=f"{nome}.png")
    artes.escolher(ped["id"], "Forest", "id-floresta")
    montado = artes.pedido(ped)
    eq("com o verso ainda no padrão, continua sem XML", montado["xml"], None)
    eq("e o que falta é só o verso", montado["faltando"],
       [{"nome": delver, "face": "verso"}])

    artes.escolher(ped["id"], delver, "id-inseto", face="verso")
    montado = artes.pedido(ped)
    check("com tudo escolhido, sai o XML", bool(montado["xml"]))
    eq("e não falta nada", montado["faltando"], [])

    # O XML é o que o resto do sistema já sabe cobrar, imprimir e cotar.
    from app import calc, pdf_generator
    import xml.etree.ElementTree as ET
    eq("o calc cobra as 8 cartas e os 2 versos",
       calc.parse_order(montado["xml"]), (8, 2))
    eq("a fila de impressão: frentes na ordem, versos no fim",
       pdf_generator._build_print_queue(ET.fromstring(montado["xml"])),
       ["id-atraxa", "id-sol", "id-floresta", "id-floresta", "id-floresta",
        "id-delver", "id-delver", "id-bolt", "id-inseto", "id-inseto"])
    eq("a cotação lê os nomes das cartas",
       calc.parse_card_list(montado["xml"]),
       [{"nome": "Atraxa", "quantidade": 1}, {"nome": "Sol Ring", "quantidade": 1},
        {"nome": "Forest", "quantidade": 3}, {"nome": delver, "quantidade": 2},
        {"nome": "Lightning Bolt", "quantidade": 1}])
    raiz = ET.fromstring(montado["xml"])
    eq("as 3 Florestas são um <card> com 3 slots",
       [c.findtext("slots") for c in raiz.findall("fronts/card")
        if c.findtext("id") == "id-floresta"], ["2,3,4"])
    eq("o verso fica nos mesmos slots da frente, com o nome dele",
       [(c.findtext("slots"), c.findtext("query")) for c in raiz.findall("backs/card")],
       [("5,6", "Insectile Aberration")])
    eq("o nome do arquivo vai no <name>",
       raiz.find("fronts/card").findtext("name"), "Atraxa.png")

    vazio = decks.criar("Vazio", [], [])
    eq("deck vazio não tem o que imprimir", artes.pedido(vazio)["cartas"], 0)

    print("\n--- as fichas vão pro papel ---")

    # Três armadilhas numa base de mentira: as duas Wurm do Wurmcoil têm
    # nome, tipo e corpo iguais e só o texto separa; duas cartas que criam
    # Treasure citam IMPRESSÕES diferentes da mesma ficha; e o sideboard cria
    # uma ficha que não vai pra mesa.
    def ficha(ident, nome, texto, tipo="Token Artifact Creature — Wurm",
              poder="3", resistencia="3", verso=None):
        f = {"id": ident, "name": nome, "layout": "token", "type_line": tipo,
             "oracle_text": texto, "power": poder, "toughness": resistencia,
             "colors": [], "image_uris": {"normal": f"http://arte/{ident}"}}
        if verso:
            f.update(layout="double_faced_token", image_uris=None, card_faces=[
                {"name": nome.split(" // ")[0], "type_line": tipo,
                 "oracle_text": texto, "image_uris": {"normal": f"http://arte/{ident}"}},
                {"name": nome.split(" // ")[1], "type_line": tipo,
                 "oracle_text": "", "image_uris": {"normal": f"http://arte/{verso}"}}])
        return f

    def cria(nome, *ids):
        return {"oracle_id": "o-" + nome, "layout": "normal", "cmc": 3.0,
                "name": nome, "type_line": "Artifact", "colors": [],
                "color_identity": [], "legalities": {"commander": "legal"},
                "image_uris": {"normal": f"http://arte/{nome}"},
                "all_parts": [{"component": "token", "id": i} for i in ids]}

    tesouro = "Token Artifact — Treasure"
    conn = cartas._conn()
    for c in (cria("Motor de Wurm", "wurm-dt", "wurm-ll"),
              cria("Mapa do Tesouro", "tesouro-a"),
              cria("Fábrica de Tesouro", "tesouro-b"),
              cria("Porta Dupla", "dia-noite"),
              cria("Quartel", "soldado")):
        conn.execute(f"INSERT OR REPLACE INTO cartas ({cartas._COLUNAS}) "
                     f"VALUES ({cartas._INTERROGACOES})", cartas._linha(c))
    for f in (ficha("wurm-dt", "Wurm", "Deathtouch"),
              ficha("wurm-ll", "Wurm", "Lifelink"),
              ficha("tesouro-a", "Treasure", "Sacrifice this: add one mana.",
                    tesouro, "", ""),
              ficha("tesouro-b", "Treasure", "Sacrifice this: add one mana.",
                    tesouro, "", ""),
              ficha("dia-noite", "Dia // Noite", "", "Token Creature — Spirit",
                    "1", "1", verso="noite"),
              ficha("soldado", "Soldier", "", "Token Creature — Soldier", "1", "1")):
        conn.execute(f"INSERT OR REPLACE INTO tokens ({cartas._COLUNAS_TOKENS}) "
                     f"VALUES ({cartas._INTERROGACOES_TOKENS})", cartas._linha_token(f))
    conn.commit()
    conn.close()

    fichado = decks.criar("Fichas", ["Atraxa"], [
        {"nome": "Motor de Wurm", "quantidade": 1},
        {"nome": "Mapa do Tesouro", "quantidade": 1},
        {"nome": "Fábrica de Tesouro", "quantidade": 1},
        {"nome": "Porta Dupla", "quantidade": 1},
        {"nome": "Quartel", "quantidade": 1, "categoria": decks.CATEGORIA_SIDEBOARD},
    ])
    grupos = artes.fichas_do_deck(fichado)
    chaves = {f["id"]: f["chave_arte"] for g in grupos for f in g["tokens"]}
    check("as duas Wurm do Wurmcoil são duas escolhas",
          chaves["wurm-dt"] != chaves["wurm-ll"])
    eq("duas impressões da mesma Treasure são uma escolha só",
       chaves["tesouro-a"], chaves["tesouro-b"])
    check("a chave começa pela sintaxe de ficha do MPC Fill, com o nome",
          chaves["wurm-dt"].startswith("t:Wurm "), chaves["wurm-dt"])
    check("o sideboard não cria ficha", "soldado" not in chaves)

    montado = artes.pedido(fichado)
    fichas_faltando = [(f["nome"], f["face"]) for f in montado["faltando"]
                       if f.get("ficha")]
    eq("ficha sem arte segura o pedido, uma de cada, verso incluído",
       fichas_faltando, [("Wurm", "frente"), ("Wurm", "frente"),
                         ("Treasure", "frente"), ("Dia // Noite", "frente"),
                         ("Dia // Noite", "verso")])
    check("carta não ganha a marca de ficha",
          not any(f.get("ficha") for f in montado["faltando"]
                  if f["nome"] in ("Atraxa", "Quartel")))
    # 1 comandante + 5 cartas + 4 fichas; frente e verso da Dia // Noite.
    eq("uma posição na folha por ficha", montado["cartas"], 10)
    eq("e uma arte por lado", montado["artes"], 11)

    for nome in ("Atraxa", "Motor de Wurm", "Mapa do Tesouro",
                 "Fábrica de Tesouro", "Porta Dupla", "Quartel"):
        artes.escolher(fichado["id"], nome, "id-" + nome)
    for ident in ("wurm-dt", "wurm-ll", "tesouro-a", "dia-noite"):
        artes.escolher(fichado["id"], chaves[ident], "id-" + ident,
                       arquivo=f"{ident}.png")
    montado = artes.pedido(fichado)
    eq("falta só o verso da ficha de duas faces", montado["faltando"],
       [{"nome": "Dia // Noite", "face": "verso", "ficha": True}])
    artes.escolher(fichado["id"], chaves["dia-noite"], "id-noite", face="verso")
    montado = artes.pedido(fichado)
    check("com as fichas escolhidas, sai o XML", bool(montado["xml"]))

    raiz = ET.fromstring(montado["xml"])
    eq("as fichas vêm depois das cartas, com o <query> na sintaxe do MPC Fill",
       [(c.findtext("slots"), c.findtext("query")) for c in raiz.findall("fronts/card")][-4:],
       [("6", "t:Wurm"), ("7", "t:Wurm"), ("8", "t:Treasure"), ("9", "t:Dia")])
    eq("o verso da ficha vai no mesmo slot, pelo nome dele",
       [(c.findtext("slots"), c.findtext("query")) for c in raiz.findall("backs/card")],
       [("9", "t:Noite")])
    eq("o calc cobra as fichas junto", calc.parse_order(montado["xml"]), (10, 1))

    from app import cotacao
    cotaveis, fora = cotacao.filtrar_cotaveis(calc.parse_card_list(montado["xml"]),
                                              "Atraxa")
    eq("a cotação não procura preço de ficha",
       [c["nome"] for c in cotaveis if calc.e_ficha(c["nome"])], [])
    eq("e diz que as deixou de fora",
       sorted(c["nome"] for c in fora if c["motivo"] == "token"),
       ["t:Dia", "t:Treasure", "t:Wurm"])

finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: {', '.join(falhas)}")
    sys.exit(1)
print("tudo certo")
