"use strict";

/* ----------------------------------------------------------------- menus

   Um menu ancorado no botão que o abriu. Ele existe porque mover carta entre
   categorias e tabuleiros precisa funcionar no TOQUE: arrastar é o gesto
   natural no mouse e não existe no celular, então o arrastar é atalho e
   este menu é o caminho.

   Ele é montado a cada abertura em vez de ficar escondido no HTML: a lista
   de categorias muda a cada carta, e um menu guardado teria que ser
   sincronizado — que é o mesmo trabalho, feito duas vezes. */

let menuAberto = null;

function fecharMenu(){
  if (!menuAberto) return;
  menuAberto.remove();
  menuAberto = null;
}

/* `itens` é uma lista de `{rotulo, marca, aoClicar, classe}` ou `"risco"`
   pra uma linha divisória, ou `{titulo}` pra um cabeçalho. */
function abrirMenu(ancora, itens){
  fecharMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  for (const item of itens){
    if (item === "risco"){
      menu.insertAdjacentHTML("beforeend", '<div class="risco"></div>');
      continue;
    }
    if (item.titulo){
      menu.insertAdjacentHTML("beforeend", `<h4>${escapar(item.titulo)}</h4>`);
      continue;
    }
    const botao = document.createElement("button");
    botao.type = "button";
    botao.setAttribute("role", "menuitem");
    botao.className = item.classe || "";
    botao.innerHTML = `<span class="marca">${item.marca || ""}</span>
      <span class="rot-menu">${escapar(item.rotulo)}</span>`;
    botao.addEventListener("click", () => { fecharMenu(); item.aoClicar(); });
    menu.appendChild(botao);
  }
  document.body.appendChild(menu);

  // Posiciona depois de medir: um menu de 12 categorias perto do rodapé
  // abriria pra fora da tela, e aí a metade de baixo dele é inalcançável.
  const caixa = ancora.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const x = Math.min(caixa.left, window.innerWidth - m.width - 8);
  const y = caixa.bottom + m.height + 8 > window.innerHeight
    ? Math.max(8, caixa.top - m.height - 4)
    : caixa.bottom + 4;
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = y + "px";
  menuAberto = menu;
  menu.querySelector("button")?.focus();
}

/* O menu de uma carta: categoria, tabuleiro e sair. Nesta ordem porque é a
   ordem da frequência — trocar de categoria é o que se faz o tempo todo,
   tirar do deck é o que se faz uma vez. */
function menuDaCarta(ancora, nome, tabuleiro){
  const entrada = acharEntrada(nome, tabuleiro);
  if (!entrada) return;
  const atual = entrada.categoria || "";
  const marca = (cat) => atual === cat ? ico("check") : "";
  // Primeiro item, e o único que não muda nada no deck: é o caminho de
  // teclado pra mesma modal que o clique na linha abre — sem ele, ver a carta
  // inteira seria coisa só de quem usa mouse.
  const itens = [{rotulo: "Ver a carta", marca: ico("cards"),
                  aoClicar: () => abrirCarta(entrada.carta)},
                 // O botão de arte fica nos controles da linha, que só
                 // aparecem no hover. Este item é a porta de teclado — e a
                 // porta pra quem procura no menu em vez de caçar o ícone.
                 {rotulo: "Escolher a arte", marca: ico("image"),
                  aoClicar: () => abrirEscolhaDeArte(nome)},
                 "risco",
                 {titulo: `Categoria de ${nome}`}];

  itens.push({rotulo: `Automática (${categoriaAutomatica(entrada.carta)})`,
              marca: marca(""),
              aoClicar: () => definirCategoria(nome, tabuleiro, "")});
  for (const cat of estado.categorias){
    itens.push({rotulo: cat, marca: marca(cat),
                aoClicar: () => definirCategoria(nome, tabuleiro, cat)});
  }
  itens.push({rotulo: `${CATEGORIA_SIDEBOARD} — fora das 100`,
              marca: marca(CATEGORIA_SIDEBOARD),
              aoClicar: () => definirCategoria(nome, tabuleiro,
                                               CATEGORIA_SIDEBOARD)});
  itens.push({rotulo: "Nova categoria…", marca: ico("plus"), aoClicar: () => {
    const escolhido = prompt("Nome da nova categoria:\n\n" +
      "Ex.: Combo principal, Sac outlet, Proteção do comandante");
    if (escolhido) criarCategoria(escolhido, nome, tabuleiro);
  }});

  itens.push("risco");
  itens.push(tabuleiro === "talvez"
    ? {rotulo: "Mover pro deck", marca: ico("arrow-right"),
       aoClicar: () => mover(nome, "talvez", "deck")}
    : {rotulo: "Mover pro maybeboard", marca: ico("arrow-left"),
       aoClicar: () => mover(nome, "deck", "talvez")});
  itens.push({rotulo: tabuleiro === "talvez" ? "Tirar do maybeboard" : "Tirar do deck",
              marca: ico("x"), classe: "perigo",
              aoClicar: () => tirar(nome, tabuleiro)});
  abrirMenu(ancora, itens);
}

/* O menu de uma categoria própria. Só as próprias têm: renomear "Criaturas"
   não faria sentido — ela não é um nome, é o tipo da carta. */
function menuDoGrupo(ancora, cat){
  const i = estado.categorias.indexOf(cat);
  const itens = [
    {titulo: cat},
    {rotulo: "Renomear…", marca: ico("pencil-simple"), aoClicar: () => {
      const novo = prompt("Novo nome da categoria:", cat);
      if (novo) renomearCategoria(cat, novo);
    }},
  ];
  if (i > 0) itens.push({rotulo: "Subir", marca: ico("arrow-up"),
                         aoClicar: () => moverCategoria(cat, -1)});
  if (i >= 0 && i < estado.categorias.length - 1){
    itens.push({rotulo: "Descer", marca: ico("arrow-down"),
                aoClicar: () => moverCategoria(cat, +1)});
  }
  itens.push("risco");
  itens.push({rotulo: "Apagar categoria", marca: ico("x"), classe: "perigo",
              aoClicar: () => apagarCategoria(cat)});
  abrirMenu(ancora, itens);
}
