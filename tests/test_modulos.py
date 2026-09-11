"""
Confere que os módulos do deckbuilder se declaram direito: cada um importa o
que usa, só importa o que o outro exporta, e todos seguem a forma estreita que
deixa os testes de JS achatarem o grafo num script só.

MOTIVO DE EXISTIR. O navegador confere pouco, e tarde. Esquecer um `import`
não impede o módulo de carregar: o nome só é procurado quando a função que o
usa roda — no clique —, e aí é um `ReferenceError` na frente de quem está
montando o deck. Os testes de JS também não pegam isso, porque rodam o grafo
achatado, onde todo nome enxerga todos os outros. Este teste é o que fica
entre um `import` esquecido e o clique.

Cinco coisas que ele persegue:

1. **Nome de outro módulo usado sem import.** O erro acima.
2. **Import de nome que o outro módulo não exporta.** Esse o navegador pega
   na carga — recusando o módulo inteiro, e com ele a tela.
3. **Atribuição a nome importado.** Import é só leitura: `x = 1` num nome
   importado é `TypeError` na hora em que roda. Quem muda um nome é o módulo
   dono dele (daí `agendarBuscaComandante` morar em `busca.js`).
4. **A forma estreita.** Import só como `import {a, b} from "./x.js";`,
   export só na frente de uma declaração, e nenhum nome de topo repetido
   entre módulos. É o que deixa o `js_do_deckbuilder.py` tirar import e
   export por texto e rodar tudo como um script só, sem mudar o que o código
   faz.
5. **Sobra.** Import que ninguém usa e export que ninguém importa. Não
   quebram nada, mas mentem: a lista de imports de um módulo só serve de mapa
   de quem depende de quem enquanto for exata.

COMO ELE RODA. Lê os módulos com o tree-sitter (ver `escopo_js.py`), sem
executar nada:

    pip install tree-sitter tree-sitter-javascript
    python tests/test_modulos.py

Sai com código 1 se qualquer checagem falhar. Sem o tree-sitter instalado,
avisa e sai com 0: ele não está no `requirements.txt` porque não é
dependência do serviço, só deste teste.
"""
import sys

from js_do_deckbuilder import ESTATICO, EXPORT, IMPORT, arquivos

try:
    import escopo_js
except ImportError:
    print("tree-sitter não está instalado — este teste precisa dele pra ler "
          "os módulos.\n\n    pip install tree-sitter tree-sitter-javascript\n")
    sys.exit(0)

# O que um módulo pode usar sem importar: a linguagem e o navegador. Um nome
# fora desta lista e fora de todo módulo é erro de digitação ou import de um
# arquivo que não existe. Se a tela passar a usar outra API do navegador de
# propósito, ela entra aqui.
NAVEGADOR = {
    # a linguagem
    "Array", "BigInt", "Boolean", "Date", "Error", "Infinity", "Intl", "JSON",
    "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "Reflect",
    "RegExp", "Set", "String", "Symbol", "TypeError", "WeakMap", "WeakSet",
    "arguments", "console", "decodeURIComponent", "encodeURIComponent",
    "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt",
    "queueMicrotask", "structuredClone", "undefined",
    # o navegador
    "AbortController", "Blob", "CSS", "CustomEvent", "DOMParser", "DOMRect",
    "Element", "Event", "File", "FileReader", "FormData", "HTMLElement",
    "Image", "IntersectionObserver", "KeyboardEvent", "MouseEvent",
    "MutationObserver", "Node", "ResizeObserver", "TextDecoder",
    "TextEncoder", "URL", "URLSearchParams", "alert", "cancelAnimationFrame",
    "clearInterval", "clearTimeout", "confirm", "crypto", "document", "fetch",
    "getComputedStyle", "history", "localStorage", "location", "matchMedia",
    "navigator", "performance", "prompt", "requestAnimationFrame",
    "sessionStorage", "setInterval", "setTimeout", "window",
}

falhas = []


def check(nome, condicao, detalhe=""):
    print(f"{'ok   ' if condicao else 'FALHA'} {nome}"
          f"{'' if condicao else f'  (obtido {detalhe!r})'}")
    if not condicao:
        falhas.append(nome)


def eq(nome, obtido, esperado):
    check(nome, obtido == esperado,
          "" if obtido == esperado else f"{obtido!r}, esperado {esperado!r}")


def rotulo(caminho):
    return caminho.relative_to(ESTATICO).as_posix()


def primeiro_uso(usos):
    """Um aviso por (módulo, nome), na primeira linha em que ele aparece: o
    mesmo import esquecido usado vinte vezes é um erro, não vinte."""
    vistos = {}
    for chave, linha in usos:
        vistos.setdefault(chave, linha)
    return sorted(f"{arq}:{linha} {nome}" for (arq, nome), linha in vistos.items())


try:
    modulos = {p: escopo_js.analisar(p.read_text(encoding="utf-8"))
               for p in arquivos()}
    check("o grafo da página tem módulos pra ler", len(modulos) > 1,
          len(modulos))

    # ------------------------------------------------------------ a forma
    print("\n--- a forma de cada módulo ---")
    forma = []
    for p, m in modulos.items():
        texto = p.read_text(encoding="utf-8")
        for imp in m.imports:
            if not imp.so_nomes:
                forma.append(f"{rotulo(p)}:{imp.linha} import sem ser `{{nomes}}`")
            if any(alias for _, alias in imp.nomes):
                forma.append(f"{rotulo(p)}:{imp.linha} import com `as`")
            if not (imp.fonte.startswith(("./", "../"))
                    and imp.fonte.endswith(".js")):
                forma.append(f"{rotulo(p)}:{imp.linha} import de {imp.fonte!r}, "
                             "que não é caminho relativo de um .js")
        for linha in m.exports_sem_declaracao:
            forma.append(f"{rotulo(p)}:{linha} export sem declaração")
        # O achatamento acha import e export por texto. Cada um que a árvore
        # enxerga tem que ser um que o texto enxerga, senão sobra `import` ou
        # `export` no script achatado.
        if len(IMPORT.findall(texto)) != len(m.imports):
            forma.append(f"{rotulo(p)}: import que não começa a linha ou não "
                         "termina em `;`")
        if len(EXPORT.findall(texto)) != len(m.exports):
            forma.append(f"{rotulo(p)}: export que não começa a linha")
    eq("todo import e export segue a forma estreita", forma, [])

    dono, repetidos = {}, []
    for p, m in modulos.items():
        for nome in m.topo:
            if nome in dono:
                repetidos.append(f"{nome}: {rotulo(dono[nome])} e {rotulo(p)}")
            else:
                dono[nome] = p
    eq("nenhum nome de topo se repete entre módulos", repetidos, [])

    # --------------------------------------------------------- os imports
    print("\n--- cada módulo importa o que usa ---")
    sem_import, desconhecidos = [], []
    for p, m in modulos.items():
        for u in m.livres:
            if u.nome in NAVEGADOR:
                continue
            if u.nome in dono:
                sem_import.append(((rotulo(p), f"{u.nome} (de "
                                    f"{rotulo(dono[u.nome])})"), u.linha))
            else:
                desconhecidos.append(((rotulo(p), u.nome), u.linha))
    eq("nenhum nome de outro módulo é usado sem import",
       primeiro_uso(sem_import), [])
    eq("nem nome que nenhum módulo declara e que não é do navegador",
       primeiro_uso(desconhecidos), [])

    errados, importados = [], set()
    for p, m in modulos.items():
        for imp in m.imports:
            alvo = (p.parent / imp.fonte).resolve()
            for nome, _ in imp.nomes:
                importados.add((alvo, nome))
                if alvo not in modulos or nome not in modulos[alvo].exportados:
                    errados.append(f"{rotulo(p)}:{imp.linha} {nome} de {imp.fonte}")
    eq("todo nome importado é exportado pelo módulo de origem", errados, [])
    eq("nenhum módulo atribui a um nome importado",
       sorted(f"{rotulo(p)}:{u.linha} {u.nome}" for p, m in modulos.items()
              for u in m.usos_de_import if u.escrita), [])

    # ------------------------------------------------------------- a sobra
    print("\n--- sobra ---")
    eq("todo import é usado",
       sorted(f"{rotulo(p)}:{imp.linha} {alias or nome}"
              for p, m in modulos.items()
              for imp in m.imports for nome, alias in imp.nomes
              if (alias or nome) not in {u.nome for u in m.usos_de_import}), [])
    # O `comum/` fica de fora: ele existe pra várias páginas, e o export que o
    # deckbuilder não usa pode ser de outra.
    eq("todo export do deckbuilder é importado por algum módulo",
       sorted(f"{rotulo(p)} {nome}" for p, m in modulos.items()
              if p.parent.name == "deckbuilder"
              for nome in m.exportados if (p, nome) not in importados), [])

except Exception as e:      # noqa: BLE001 — o erro é o resultado do teste
    import traceback
    traceback.print_exc()
    falhas.append(f"exceção: {e}")

print()
if falhas:
    print(f"{len(falhas)} checagem(ns) falharam: " + ", ".join(map(str, falhas)))
    sys.exit(1)
print("tudo certo")
