"""
Confere a combinação de pedidos numa folha só (botão "Combinar pedidos" da
tela do operador).

O que se está travando aqui é o que dói se quebrar em silêncio:

1. **A conta de papel.** O ganho todo do recurso é a folha economizada. Se a
   matemática escorregar, a tela promete economia que a impressora não
   entrega — e o operador só descobre com o papel na mão.
2. **As regras de quem pode entrar na folha.** Laminação misturada estraga o
   acabamento de metade das pessoas e não tem desfazer depois de plastificado;
   pedido cancelado não pode gastar papel.
3. **A folha que sai.** As cartas de todos os pedidos, na ordem, sem página
   nova entre um e outro — e com a legenda dizendo de quem é cada posição.
4. **Imprimir confirma TODOS.** É um papel só com carta de várias pessoas:
   ou o conjunto inteiro vira 'paid', ou nenhum.
5. **A porta.** Toda rota nova de /admin exige o token, e o link assinado de
   um pedido não abre a folha combinada.

O Drive fica de fora: `_fetch_all` é trocado por imagens de mentira, então o
teste roda sem rede.

Precisa do fastapi e do httpx instalados (`pip install -r requirements.txt`
mais `pip install httpx`). Rode de dentro da raiz do projeto:

    python tests/test_combos.py

Sai com código 1 se qualquer checagem falhar.
"""
import os
import re
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

TOKEN = "token-de-teste-combos"
os.environ["ADMIN_TOKEN"] = TOKEN
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "orders.db")
os.environ["LOG_DIR"] = tempfile.mkdtemp()
os.environ["LOG_NIVEL"] = "ERROR"
os.environ["PDF_OUTPUT_DIR"] = tempfile.mkdtemp()
os.environ["PRINTER_QUEUE"] = ""       # nada vai pro CUPS neste teste

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("PULADO: fastapi não está instalado (pip install -r requirements.txt)")
    sys.exit(0)

os.chdir(RAIZ)

from PIL import Image                                          # noqa: E402
from app import calc, cleanup, pdf_generator, storage          # noqa: E402
from app.main import app                                       # noqa: E402

falhas = []


def check(nome, condicao, detalhe=""):
    print(("ok   " if condicao else "FALHA") + f" {nome} {detalhe}")
    if not condicao:
        falhas.append(nome)


# --- o Drive de mentira ---------------------------------------------------
# Uma imagem no gabarito do MPC (2,72 x 3,70) por id, escrita no cache do
# próprio gerador. Assim o recorte de sangria e o desenho rodam de verdade,
# só a rede que não.
def _fetch_falso(drive_ids, cache_dir, on_progress=None):
    resultado = {}
    for i, d in enumerate(dict.fromkeys(drive_ids)):
        caminho = os.path.join(cache_dir, f"{d}.jpg")
        Image.new("RGB", (272, 370), (i * 37 % 255, 90, 160)).save(caminho, "JPEG")
        resultado[d] = caminho
    if on_progress:
        on_progress(len(resultado), len(resultado))
    return resultado


pdf_generator._fetch_all = _fetch_falso


def xml_de(n, prefixo):
    cartas = "".join(f"<card><id>{prefixo}{i}</id><slots>{i}</slots></card>"
                     for i in range(n))
    return f"<order><fronts>{cartas}</fronts></order>"


def semear(nome, deck, cartas, laminacao="single"):
    resultado = calc.compute_cost(cartas, 0, laminacao)
    return storage.create_order(xml_de(cartas, deck), laminacao, nome, deck,
                                resultado)[0]


storage.init_db()
cliente = TestClient(app)
AUTH = {"X-Admin-Token": TOKEN}

# 4 + 18 + 2 = 24 cartas -> 3 folhas juntas contra 1 + 2 + 1 = 4 separadas.
ana = semear("Ana Prado", "aa", 4)
bruno = semear("Bruno Lima", "bb", 18)
carla = semear("Carla Reis", "cc", 2)
dupla = semear("Davi Nunes", "dd", 3, laminacao="double")
morto = semear("Eva Souza", "ee", 5)
storage.set_status(morto, "cancelado")

# --- 1. a conta de papel, sem tocar em rota nenhuma ----------------------
r = calc.resumo_combinado([
    {"id": ana, "customer_name": "Ana", "pages": 1, "blanks": 5},
    {"id": bruno, "customer_name": "Bruno", "pages": 2, "blanks": 0},
    {"id": carla, "customer_name": "Carla", "pages": 1, "blanks": 7},
])
check("soma as cartas dos três", r["cartas"] == 24, r["cartas"])
check("4 folhas separadas viram 3", (r["paginas_separadas"],
                                     r["paginas_combinadas"]) == (4, 3), r)
check("economia de 1 folha", r["folhas_economizadas"] == 1, r)
check("e sobram 3 slots em branco na última", r["brancos"] == 3, r["brancos"])
check("o mapa emenda as faixas sem buraco",
      [(m["inicio"], m["fim"]) for m in r["mapa"]] == [(1, 4), (5, 22), (23, 24)],
      r["mapa"])
check("e diz em que folha cada pedido cai",
      [(m["primeira_pagina"], m["ultima_pagina"]) for m in r["mapa"]]
      == [(1, 1), (1, 3), (3, 3)], r["mapa"])

# Pedido que já fecha a folha certinho não economiza nada — o caso em que a
# tela não pode prometer ganho.
r2 = calc.resumo_combinado([{"id": "x", "pages": 2, "blanks": 0},
                            {"id": "y", "pages": 1, "blanks": 0}])
check("pedidos redondos não economizam folha", r2["folhas_economizadas"] == 0, r2)

# --- 2. a porta ----------------------------------------------------------
ROTAS = [
    ("POST", "/admin/combos"),
    ("GET", "/admin/combos/qualquer"),
    ("POST", "/admin/combos/qualquer/pdf"),
    ("POST", "/admin/combos/qualquer/imprimir"),
    ("DELETE", "/admin/combos/qualquer"),
]
for metodo, rota in ROTAS:
    sem = cliente.request(metodo, rota, data={"ids": f"{ana},{bruno}"})
    errado = cliente.request(metodo, rota, data={"ids": f"{ana},{bruno}"},
                             headers={"X-Admin-Token": "chute"})
    check(f"{metodo} {rota} exige token",
          sem.status_code == 401 and errado.status_code == 401,
          f"{sem.status_code}/{errado.status_code}")

# --- 3. quem pode entrar na folha ----------------------------------------
def combinar(ids, **kw):
    return cliente.post("/admin/combos", data={"ids": ",".join(ids)},
                        headers=AUTH, **kw)


check("um pedido só não é combinação", combinar([ana]).status_code == 400)
check("id repetido não vira dois", combinar([ana, ana]).status_code == 400)
r = combinar([ana, "naoexiste"])
check("pedido inexistente = 404", r.status_code == 404, r.status_code)
r = combinar([ana, dupla])
check("laminação misturada = 400", r.status_code == 400, r.status_code)
check("e a resposta diz por quê",
      "laminação" in r.json()["detail"], r.json()["detail"])
r = combinar([ana, morto])
check("pedido cancelado não gasta papel = 400", r.status_code == 400, r.status_code)

# --- 4. a combinação em si ------------------------------------------------
r = combinar([ana, bruno, carla])
check("combina os três", r.status_code == 200, r.text[:90])
combo = r.json()
check("economiza a folha prometida",
      (combo["paginas_separadas"], combo["paginas_combinadas"],
       combo["folhas_economizadas"]) == (4, 3, 1), combo)
# 1 + 2 + 1 páginas a R$ 2,50 cada. O combinado gasta 3 folhas, mas o valor
# é a soma do que cada um contratou: a economia de papel é da gráfica, não um
# desconto retroativo pra quem já fechou preço.
check("soma o valor dos pedidos, sem desconto pela folha economizada",
      round(combo["valor_total"], 2) == 10.00, combo["valor_total"])
check("o link da folha sai assinado e relativo",
      combo["pdf_url"].startswith(f"/combos/{combo['id']}/pdf?token="),
      combo["pdf_url"])
check("nenhum XML de deck vaza na resposta", "xml_text" not in r.text)

# O id sai do CONJUNTO: marcar na outra ordem tem que cair na mesma folha,
# senão a mesma coisa seria montada duas vezes com dois nomes.
outra_ordem = combinar([carla, ana, bruno]).json()
check("a ordem do clique não cria outra combinação",
      outra_ordem["id"] == combo["id"], (combo["id"], outra_ordem["id"]))
check("e a ordem de impressão é a de criação",
      [p["id"] for p in outra_ordem["pedidos"]] == [ana, bruno, carla],
      [p["id"] for p in outra_ordem["pedidos"]])

check("dá pra reler a combinação depois",
      cliente.get(f"/admin/combos/{combo['id']}",
                  headers=AUTH).json()["cartas"] == 24)
check("combinação inventada = 404",
      cliente.get("/admin/combos/naoexiste", headers=AUTH).status_code == 404)

# --- 5. a folha que sai ---------------------------------------------------
estado = cliente.post(f"/admin/combos/{combo['id']}/pdf", headers=AUTH).json()
esperar = time.time() + 30
while estado["estado"] == "montando" and time.time() < esperar:
    time.sleep(0.2)
    estado = cliente.post(f"/admin/combos/{combo['id']}/pdf", headers=AUTH).json()
check("a folha combinada monta", estado["estado"] == "pronto", estado)
check("sem carta faltando", estado.get("falhas") == 0, estado)
check("e a resposta traz o mapa de quem é quem",
      [m["id"] for m in estado.get("mapa", [])] == [ana, bruno, carla],
      estado.get("mapa"))

caminho = os.path.join(pdf_generator.OUTPUT_DIR, f"combo-{combo['id']}.pdf")
bytes_pdf = open(caminho, "rb").read()
paginas = len(re.findall(rb"/Type\s*/Page[^s]", bytes_pdf))
check("a folha combinada tem 3 páginas", paginas == 3, paginas)

separadas = 0
for pedido in (ana, bruno, carla):
    p, _ = pdf_generator.generate_pdf(storage.get_order_with_xml(pedido)["xml_text"],
                                      order_id=pedido)
    separadas += len(re.findall(rb"/Type\s*/Page[^s]", open(p, "rb").read()))
check("contra 4 páginas imprimindo um por um", separadas == 4, separadas)

# A legenda da margem é o que diz de quem é cada carta depois do corte.
rotulo = pdf_generator._rotulo_combinado(combo["id"], estado["mapa"])
primeira = rotulo(1, 3, 0, 9)
check("a legenda da folha 1 nomeia os dois pedidos que caem nela",
      f"#{ana}" in primeira and f"#{bruno}" in primeira and f"#{carla}" not in primeira,
      primeira)
check("e dá a posição DENTRO da folha, de 1 a 9",
      "[1-4]" in primeira and "[5-9]" in primeira, primeira)
check("a legenda aguenta nome que a fonte do PDF não escreve",
      pdf_generator._texto_seguro("Ana 🂡 Prado") == "Ana ? Prado",
      pdf_generator._texto_seguro("Ana 🂡 Prado"))

# --- 6. o link assinado ---------------------------------------------------
r = cliente.get(combo["pdf_url"])
check("o link assinado abre a folha", r.status_code == 200, r.status_code)
check("e vem como PDF", r.headers["content-type"] == "application/pdf",
      r.headers.get("content-type"))
check("sem token não abre",
      cliente.get(f"/combos/{combo['id']}/pdf").status_code == 401)
# O token do pedido é assinado sobre outro assunto (`combo:<id>`), então não
# pode servir de chave pra folha combinada — e vice-versa.
token_do_pedido = cliente.get("/admin/pedidos", headers=AUTH).json()["pedidos"][0]
token_do_pedido = token_do_pedido["pdf_url"].split("token=")[1]
check("o token de um pedido não abre a folha combinada",
      cliente.get(f"/combos/{combo['id']}/pdf?token={token_do_pedido}"
                  ).status_code == 401)

# --- 7. imprimir confirma TODOS ------------------------------------------
check("antes de imprimir, ninguém está pago",
      [storage.get_order(i)["status"] for i in (ana, bruno, carla)]
      == ["pending"] * 3)
r = cliente.post(f"/admin/combos/{combo['id']}/imprimir", headers=AUTH)
check("imprime a folha combinada", r.status_code == 200, r.text[:90])
check("e marca os três pedidos como pagos",
      [storage.get_order(i)["status"] for i in (ana, bruno, carla)]
      == ["paid"] * 3)
check("a resposta diz quais pedidos foram confirmados",
      sorted(r.json()["pedidos"]) == sorted([ana, bruno, carla]), r.json())

# --- 8. desfazer ----------------------------------------------------------
r = cliente.delete(f"/admin/combos/{combo['id']}", headers=AUTH)
check("desfaz a combinação", r.status_code == 200 and r.json()["pdf_apagado"],
      r.text[:90])
check("a folha some do disco", not os.path.exists(caminho))
check("mas os pedidos continuam lá, pagos",
      all(storage.get_order(i) and storage.get_order(i)["status"] == "paid"
          for i in (ana, bruno, carla)))
check("desfazer de novo = 404",
      cliente.delete(f"/admin/combos/{combo['id']}", headers=AUTH).status_code == 404)

# --- 9. a prévia da tela contra a conta do backend -----------------------
# A barra do admin refaz a conta de folhas em JavaScript pra responder no
# clique, sem ida ao servidor. Duas implementações da mesma regra é
# exatamente onde a divergência se esconde: a tela promete uma economia, o
# papel entrega outra. Aqui as duas contas rodam sobre os mesmos números.
try:
    import quickjs
except ImportError:
    print("pulado: quickjs não instalado (pip install quickjs) — a prévia do "
          "admin não foi conferida contra o backend")
else:
    fonte = (RAIZ / "app/static/admin.html").read_text(encoding="utf-8")
    # Do começo do bloco até o fim de `resumoLocal`, que é a conta em si.
    trecho = re.search(r"const CARTAS_POR_FOLHA.*?^function resumoLocal.*?^}",
                       fonte, re.S | re.M).group(0)
    ctx = quickjs.Context()
    ctx.eval(trecho + """
    function previa(lista) {
      const r = resumoLocal(lista);
      return JSON.stringify([r.cartas, r.separadas, r.combinadas, r.economia]);
    }""")
    import json
    casos = [
        [(1, 5), (2, 0), (1, 7)],          # o caso da tela: economiza 1
        [(2, 0), (1, 0)],                  # redondos: não economiza
        [(1, 8), (1, 8), (1, 8)],          # três migalhas viram uma folha
        [(1, 0)],                          # um só
        [(4, 3), (2, 6), (3, 1), (1, 8)],  # um punhado qualquer
    ]
    for caso in casos:
        lista = [{"id": f"p{i}", "pages": pg, "blanks": bl, "created_at": i}
                 for i, (pg, bl) in enumerate(caso)]
        py = calc.resumo_combinado(lista)
        esperado = [py["cartas"], py["paginas_separadas"],
                    py["paginas_combinadas"], py["folhas_economizadas"]]
        obtido = json.loads(ctx.eval(f"previa({json.dumps(lista)})"))
        check(f"prévia da tela bate com o backend em {caso}",
              obtido == esperado, f"js={obtido} py={esperado}")


# --- 10. a faxina conhece a folha combinada ------------------------------
check("a limpeza reconhece combo-*.pdf",
      cleanup._is_ours("combo-deadbeef.pdf")
      and cleanup._is_ours("combo-deadbeef.pdf.incompleto"))
check("e continua sem encostar no banco",
      not cleanup._is_ours("orders.db") and not cleanup._is_ours("combo.pdf"))

# --- 11. montar a folha combinada não mexeu no que já existia ------------
check("o PDF de um pedido só continua saindo",
      cliente.post(f"/admin/pedidos/{ana}/pdf", headers=AUTH).status_code == 200)
check("a listagem do admin continua de pé",
      cliente.get("/admin/pedidos", headers=AUTH).status_code == 200)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
