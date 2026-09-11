"""
Escopo de JavaScript, lido com o tree-sitter: o que cada módulo declara no
topo, o que importa e exporta, e cada nome que ele usa sem declarar.

É o que o `test_modulos.py` usa pra conferir o que o navegador só confere
tarde demais. Um `import` esquecido não é erro de sintaxe: o módulo carrega
normal e só quebra quando a função que usa o nome roda — no clique, na frente
de quem está montando o deck.

A análise é de escopo léxico, não de tipos: sabe que o `lista` de dentro de
uma função é a variável local e não a função `lista` de `utilidades.js`, mas
não sabe o que um valor é.

    pip install tree-sitter tree-sitter-javascript
"""
from dataclasses import dataclass, field

import tree_sitter
import tree_sitter_javascript

_PARSER = tree_sitter.Parser(tree_sitter.Language(tree_sitter_javascript.language()))

_FUNCOES = {"function_declaration", "function_expression", "function",
            "arrow_function", "method_definition", "generator_function",
            "generator_function_declaration"}
_ESCOPOS = _FUNCOES | {"program", "statement_block", "for_statement",
                       "for_in_statement", "catch_clause", "switch_body",
                       "class_body"}


@dataclass
class Uso:
    """Um nome usado sem declaração no próprio escopo."""
    nome: str
    linha: int
    escrita: bool      # alvo de `=`, `+=`, `++`...
    na_carga: bool     # fora de qualquer função: roda quando o módulo carrega


@dataclass
class Import:
    fonte: str         # o caminho entre aspas
    nomes: list        # [(nome, alias ou None)]
    linha: int
    so_nomes: bool     # `import {a, b} from` — sem default nem `* as`


@dataclass
class Modulo:
    topo: dict = field(default_factory=dict)       # nome -> "function"|"const"|...
    exportados: set = field(default_factory=set)
    exports: list = field(default_factory=list)    # linhas dos `export <declaração>`
    exports_sem_declaracao: list = field(default_factory=list)  # linhas
    imports: list = field(default_factory=list)    # [Import]
    livres: list = field(default_factory=list)     # [Uso] de nomes de fora
    usos_de_import: list = field(default_factory=list)  # [Uso] de nomes importados


def nomes_do_padrao(no):
    """Os identificadores que um padrão (parâmetro, desestruturação) declara.
    O lado direito de um valor padrão (`a = x`) é uso, não declaração."""
    if no is None:
        return []
    if no.type in ("identifier", "shorthand_property_identifier_pattern"):
        return [no]
    if no.type in ("assignment_pattern", "object_assignment_pattern"):
        return nomes_do_padrao(no.child_by_field_name("left"))
    if no.type == "pair_pattern":
        return nomes_do_padrao(no.child_by_field_name("value"))
    if no.type in ("object_pattern", "array_pattern", "rest_pattern",
                   "formal_parameters"):
        return [n for c in no.named_children for n in nomes_do_padrao(c)]
    return []


def _escopo_de(no, de_funcao=False):
    """Onde uma declaração mora: `var` na função, `let`/`const` no bloco."""
    p = no.parent
    while p is not None:
        if (p.type in _FUNCOES or p.type == "program") if de_funcao \
                else p.type in _ESCOPOS:
            return p
        p = p.parent
    raise ValueError("declaração fora de qualquer escopo")


def analisar(texto):
    raiz = _PARSER.parse(texto.encode("utf-8")).root_node
    if raiz.has_error:
        linha = next((n.start_point[0] + 1 for n in _nos(raiz)
                      if n.is_error or n.is_missing), "?")
        raise SyntaxError(f"erro de sintaxe perto da linha {linha}")
    m = Modulo()
    declarados = {}     # id do nó de escopo -> nomes
    declaracoes = set()  # ids dos identificadores que são declaração
    importados = set()

    def declara(escopo, nos):
        for n in nos:
            declarados.setdefault(escopo.id, set()).add(n.text.decode())
            declaracoes.add(n.id)

    for no in _nos(raiz):
        t = no.type
        if t in ("function_declaration", "generator_function_declaration",
                 "class_declaration"):
            declara(_escopo_de(no), [no.child_by_field_name("name")])
        elif t in ("function_expression", "function", "generator_function") \
                and no.child_by_field_name("name") is not None:
            declara(no, [no.child_by_field_name("name")])
        if t in _FUNCOES:
            for campo in ("parameters", "parameter"):
                declara(no, nomes_do_padrao(no.child_by_field_name(campo)))
        elif t == "variable_declarator":
            decl = no.parent
            declara(_escopo_de(decl, decl.type == "variable_declaration"),
                    nomes_do_padrao(no.child_by_field_name("name")))
        elif t == "catch_clause":
            declara(no, nomes_do_padrao(no.child_by_field_name("parameter")))
        elif t == "for_in_statement" and no.child_by_field_name("kind"):
            var = no.child_by_field_name("kind").text.decode() == "var"
            declara(_escopo_de(no, True) if var else no,
                    nomes_do_padrao(no.child_by_field_name("left")))
        elif t == "import_statement":
            clausula = next((c for c in no.named_children
                             if c.type == "import_clause"), None)
            nomeados = [c for c in (clausula.named_children if clausula else [])]
            so_nomes = len(nomeados) == 1 and nomeados[0].type == "named_imports"
            imp = Import(no.child_by_field_name("source").text.decode()[1:-1],
                         [], no.start_point[0] + 1, so_nomes)
            for espec in (nomeados[0].named_children if so_nomes else []):
                if espec.type != "import_specifier":
                    continue
                nome = espec.child_by_field_name("name")
                alias = espec.child_by_field_name("alias")
                imp.nomes.append((nome.text.decode(),
                                  alias.text.decode() if alias else None))
                local = alias or nome
                declara(raiz, [local])
                declaracoes.add(nome.id)
                importados.add(local.text.decode())
            m.imports.append(imp)

    for c in raiz.named_children:
        alvo = c
        if c.type == "export_statement":
            alvo = c.child_by_field_name("declaration")
            if alvo is None:
                m.exports_sem_declaracao.append(c.start_point[0] + 1)
                continue
            m.exports.append(c.start_point[0] + 1)
        nomes = []
        if alvo.type in ("function_declaration",
                         "generator_function_declaration", "class_declaration"):
            nomes, tipo = [alvo.child_by_field_name("name")], "function"
        elif alvo.type in ("lexical_declaration", "variable_declaration"):
            tipo = alvo.children[0].text.decode()
            nomes = [n for d in alvo.named_children
                     if d.type == "variable_declarator"
                     for n in nomes_do_padrao(d.child_by_field_name("name"))]
        for n in nomes:
            m.topo[n.text.decode()] = tipo
            if c.type == "export_statement":
                m.exportados.add(n.text.decode())

    for no in _nos(raiz):
        if no.type not in ("identifier", "shorthand_property_identifier") \
                or no.id in declaracoes:
            continue
        nome = no.text.decode()
        p, na_carga, onde = no.parent, True, "livre"
        while p is not None:
            if p.type in _FUNCOES:
                na_carga = False
            if nome in declarados.get(p.id, ()):
                onde = "topo" if p.type == "program" else "local"
                break
            p = p.parent
        pai = no.parent
        escrita = (pai.type in ("assignment_expression",
                                "augmented_assignment_expression")
                   and pai.child_by_field_name("left") == no) \
            or pai.type == "update_expression"
        uso = Uso(nome, no.start_point[0] + 1, escrita, na_carga)
        if onde == "livre":
            m.livres.append(uso)
        elif onde == "topo" and nome in importados:
            m.usos_de_import.append(uso)
    return m


def _nos(raiz):
    pilha = [raiz]
    while pilha:
        no = pilha.pop()
        yield no
        pilha.extend(reversed(no.named_children))
