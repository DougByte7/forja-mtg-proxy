"""
Confere a combinação de pedidos numa folha só (botão "Combinar pedidos" da
tela do operador).

O que se está travando aqui é o que dói se quebrar em silêncio:

1. **A conta de papel.** O ganho todo do recurso é o slot em branco que
   deixa de ser impresso — e a folha economizada, que é esse mesmo ganho
   arredondado pra baixo. Se a matemática escorregar, a tela promete economia
   que a impressora não entrega — e o operador só descobre com o papel na mão.
2. **As regras de quem pode entrar na folha.** Laminação misturada estraga o
   acabamento de metade das pessoas e não tem desfazer depois de plastificado;
   pedido cancelado não pode gastar papel.
3. **A folha que sai.** As cartas de todos os pedidos, na ordem, sem página
   nova entre um e outro — e com a legenda dizendo de quem é cada posição. A
   folha é montada pelo worker da impressora (o site não monta PDF), com os
   pedidos na ordem que o site entrega em `GET /worker/combos/{id}`.
4. **Imprimir confirma TODOS.** É um papel só com carta de várias pessoas:
   ou o conjunto inteiro entra na fila de impressão, ou nenhum.
5. **A porta.** Toda rota nova de /admin exige o token.

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
check("12 brancos separados viram 3", (r["brancos_separados"],
                                       r["brancos"]) == (12, 3), r)
# O desperdício evitado é o número que a barra mostra como ganho, e a folha
# economizada é ele dividido por 9. Se um dia deixar de fechar, a tela está
# prometendo em slots uma coisa e em papel outra.
check("9 brancos aproveitados = a folha economizada",
      r["brancos_evitados"] == 9
      and r["brancos_evitados"] == r["folhas_economizadas"] * calc.CARDS_PER_PAGE, r)
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
check("e não tinham branco nenhum pra aproveitar",
      (r2["brancos_separados"], r2["brancos_evitados"]) == (0, 0), r2)

# Dois pedidos cheios de branco que ainda assim não fecham folha: junta o
# desperdício num lugar só, mas não devolve papel nenhum. É o caso em que a
# barra não pode cantar vitória — e o que fazia a conta antiga parecer sempre
# a mesma, porque só sabia falar em folha inteira.
r3 = calc.resumo_combinado([{"id": "x", "pages": 1, "blanks": 5},
                            {"id": "y", "pages": 1, "blanks": 3}])
check("branco que não fecha folha não vira economia",
      (r3["brancos_separados"], r3["brancos"], r3["brancos_evitados"],
       r3["folhas_economizadas"]) == (8, 8, 0, 0), r3)

# --- 2. a porta ----------------------------------------------------------
ROTAS = [
    ("POST", "/admin/combos"),
    ("GET", "/admin/combos/qualquer"),
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
check("o site não devolve link de PDF nenhum",
      not any(k.startswith("pdf_url") for k in combo), list(combo))
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
# Quem monta é o worker, com o que o site entrega nesta rota — na ordem de
# impressão, com o XML de cada pedido.
os.environ.setdefault("WORKER_TOKEN", "token-do-worker")
import app.main as site  # noqa: E402
site.WORKER_TOKEN = site.WORKER_TOKEN or "token-do-worker"
WAUTH = {"Authorization": f"Bearer {site.WORKER_TOKEN}"}
entregue = cliente.get(f"/worker/combos/{combo['id']}", headers=WAUTH).json()
check("o site entrega os pedidos do combo na ordem de impressão",
      [p["id"] for p in entregue["pedidos"]] == [ana, bruno, carla],
      [p["id"] for p in entregue["pedidos"]])
caminho, falhas_pdf, mapa = pdf_generator.generate_combined_pdf(
    entregue["pedidos"], combo_id=combo["id"])
check("a folha combinada monta, sem carta faltando", falhas_pdf == 0, falhas_pdf)
check("e o mapa diz de quem é quem",
      [m["id"] for m in mapa] == [ana, bruno, carla], mapa)
check("o mesmo mapa que a tela recebe ao combinar",
      [(m["id"], m["inicio"], m["fim"]) for m in mapa]
      == [(m["id"], m["inicio"], m["fim"]) for m in combo["mapa"]],
      (mapa, combo["mapa"]))

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
rotulo = pdf_generator._rotulo_combinado(combo["id"], mapa)
primeira = rotulo(1, 3, 0, 9)
check("a legenda da folha 1 nomeia os dois pedidos que caem nela",
      f"#{ana}" in primeira and f"#{bruno}" in primeira and f"#{carla}" not in primeira,
      primeira)
check("e dá a posição DENTRO da folha, de 1 a 9",
      "[1-4]" in primeira and "[5-9]" in primeira, primeira)
check("a legenda aguenta nome que a fonte do PDF não escreve",
      pdf_generator._texto_seguro("Ana 🂡 Prado") == "Ana ? Prado",
      pdf_generator._texto_seguro("Ana 🂡 Prado"))

# --- 7. imprimir confirma TODOS ------------------------------------------
check("antes de imprimir, ninguém está pago",
      [storage.get_order(i)["status"] for i in (ana, bruno, carla)]
      == ["pending"] * 3)
r = cliente.post(f"/admin/combos/{combo['id']}/imprimir", headers=AUTH)
check("põe a folha combinada na fila", r.status_code == 200, r.text[:90])
check("e os três pedidos entram na fila junto",
      [storage.get_order(i)["status"] for i in (ana, bruno, carla)]
      == ["a_imprimir"] * 3)
check("presos ao combo, pra o worker não imprimir cada um sozinho",
      all(storage.get_order(i)["impressao_combo"] == combo["id"]
          for i in (ana, bruno, carla)))
check("e o combo também está na fila",
      storage.get_combo(combo["id"])["status"] == "a_imprimir")
check("a resposta diz quais pedidos foram confirmados",
      sorted(r.json()["pedidos"]) == sorted([ana, bruno, carla]), r.json())

# --- 8. desfazer ----------------------------------------------------------
r = cliente.delete(f"/admin/combos/{combo['id']}", headers=AUTH)
check("desfaz a combinação", r.status_code == 200 and r.json()["ok"],
      r.text[:90])
check("a combinação some do banco", storage.get_combo(combo["id"]) is None)
check("mas os pedidos continuam lá, pagos",
      all(storage.get_order(i) and storage.get_order(i)["status"] == "a_imprimir"
          for i in (ana, bruno, carla)))
check("desfazer de novo = 404",
      cliente.delete(f"/admin/combos/{combo['id']}", headers=AUTH).status_code == 404)

# --- 9. a prévia da tela contra a conta do backend -----------------------
# A barra do admin refaz a conta de folhas no navegador pra responder no
# clique, sem ida ao servidor. Duas implementações da mesma regra é
# exatamente onde a divergência se esconde: a tela promete uma economia, o
# papel entrega outra. Os casos moram num JSON só, que as duas pontas leem:
# aqui o backend tem de dar o `esperado` de cada caso, e o
# `front/src/pages/admin/preview.test.ts` cobra o mesmo da conta da tela.
# Mudou a regra? Mude as duas contas e o JSON juntos.
import json
CASOS = json.loads((RAIZ / "front/src/pages/admin/preview.cases.json")
                   .read_text(encoding="utf-8"))
for caso in CASOS:
    lista = [{"id": f"p{i}", "created_at": i, **p}
             for i, p in enumerate(caso["pedidos"])]
    py = calc.resumo_combinado(lista)
    obtido = {k: py[k] for k in caso["esperado"]}
    check(f"backend dá o esperado em '{caso['caso']}' (a tela confere o mesmo)",
          obtido == caso["esperado"], f"py={obtido} json={caso['esperado']}")


# --- 10. a faxina conhece a folha combinada ------------------------------
check("a limpeza reconhece combo-*.pdf",
      cleanup._is_ours("combo-deadbeef.pdf")
      and cleanup._is_ours("combo-deadbeef.pdf.incompleto"))
check("e continua sem encostar no banco",
      not cleanup._is_ours("orders.db") and not cleanup._is_ours("combo.pdf"))

# --- 11. o resto continua de pé -------------------------------------------
check("a listagem do admin continua de pé",
      cliente.get("/admin/pedidos", headers=AUTH).status_code == 200)

print()
if falhas:
    print(f"{len(falhas)} falha(s): " + ", ".join(falhas))
    sys.exit(1)
print("tudo certo")
