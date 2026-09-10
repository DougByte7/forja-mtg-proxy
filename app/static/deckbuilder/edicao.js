"use strict";

/* --------------------------------------------------------------- mexer no deck */

function acharEntrada(nome, tabuleiro){
  return lista(tabuleiro || "deck").find(e => e.carta.nome === nome);
}

/* Onde a carta está — deck, maybeboard ou lugar nenhum. É o que os cliques
   usam pra não precisarem carregar o tabuleiro em cada botão. */
function ondeEsta(nome){
  if (estado.cartas.some(e => e.carta.nome === nome)) return "deck";
  if (estado.maybe.some(e => e.carta.nome === nome)) return "talvez";
  return null;
}

function guardarDesfazer(){
  estado.desfazer.push(JSON.stringify({
    comandantes: estado.comandantes,
    cartas: estado.cartas,
    maybe: estado.maybe,
    categorias: estado.categorias,
  }));
  if (estado.desfazer.length > 40) estado.desfazer.shift();
}

function desfazer(){
  const anterior = estado.desfazer.pop();
  if (!anterior){ toast("Nada pra desfazer."); return; }
  const dados = JSON.parse(anterior);
  estado.comandantes = dados.comandantes;
  estado.cartas = dados.cartas;
  // Instantâneos gravados antes desta versão da tela não têm as duas
  // chaves novas: `|| []` os aceita em vez de zerar o maybeboard com
  // `undefined` na primeira vez que alguém apertar Ctrl+Z.
  estado.maybe = dados.maybe || [];
  estado.categorias = dados.categorias || [];
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();
  toast("Desfeito.");
}

/* Adicionar num tabuleiro. A categoria só é dita quando quem chama tem
   opinião (o menu, ao criar categoria com a carta junto); no caminho normal
   ela nasce vazia e o grupo sai do tipo da carta. */
function adicionar(carta, tabuleiro, categoria){
  tabuleiro = tabuleiro || "deck";
  guardarDesfazer();
  const entrada = acharEntrada(carta.nome, tabuleiro);
  if (entrada){
    entrada.quantidade += 1;
    if (categoria !== undefined) entrada.categoria = categoria;
  } else {
    lista(tabuleiro).push({carta, quantidade: 1, categoria: categoria || ""});
  }
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();
}

function mudarQuantidade(nome, delta, tabuleiro){
  tabuleiro = tabuleiro || ondeEsta(nome) || "deck";
  const entrada = acharEntrada(nome, tabuleiro);
  if (!entrada) return;
  guardarDesfazer();
  entrada.quantidade += delta;
  if (entrada.quantidade <= 0){
    const restante = lista(tabuleiro).filter(e => e !== entrada);
    if (tabuleiro === "talvez") estado.maybe = restante;
    else estado.cartas = restante;
  }
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();
}

/* A quantidade digitada no número da linha. Zero é o mesmo que o ✕, com o
   mesmo toast — é ele que avisa que o Ctrl+Z devolve a carta. */
function definirQuantidade(nome, quantidade, tabuleiro){
  const entrada = acharEntrada(nome, tabuleiro);
  if (!entrada) return;
  if (quantidade <= 0) return tirar(nome, tabuleiro);
  if (quantidade === entrada.quantidade) return;
  mudarQuantidade(nome, quantidade - entrada.quantidade, tabuleiro);
}

function tirar(nome, tabuleiro){
  tabuleiro = tabuleiro || ondeEsta(nome) || "deck";
  guardarDesfazer();
  if (tabuleiro === "talvez"){
    estado.maybe = estado.maybe.filter(e => e.carta.nome !== nome);
  } else {
    estado.cartas = estado.cartas.filter(e => e.carta.nome !== nome);
  }
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();
  toast(`${nome} saiu do ${tabuleiro === "talvez" ? "maybeboard" : "deck"}. ` +
        `Ctrl+Z desfaz.`);
}

/* -------------------------------------------------- mover entre tabuleiros

   A carta atravessa INTEIRA, com quantidade e categoria: o maybeboard herda
   as mesmas categorias do deck, então "sac outlet" continua sendo "sac
   outlet" do outro lado, e voltar não faz a pessoa reclassificar nada.

   Quando a carta já existe no destino (dá pra ter a mesma no deck e em
   dúvida), as quantidades somam em vez de uma sobrescrever a outra. */
function mover(nome, de, para){
  if (de === para) return;
  const entrada = acharEntrada(nome, de);
  if (!entrada) return;
  guardarDesfazer();
  if (de === "talvez") estado.maybe = estado.maybe.filter(e => e !== entrada);
  else estado.cartas = estado.cartas.filter(e => e !== entrada);

  const destino = acharEntrada(nome, para);
  if (destino){
    destino.quantidade += entrada.quantidade;
    if (!destino.categoria) destino.categoria = entrada.categoria;
  } else {
    lista(para).push(entrada);
  }
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();
  toast(para === "talvez"
    ? `${nome} foi pro maybeboard — fora da conta e da cotação.`
    : `${nome} entrou no deck.`);
}

/* --------------------------------------------------------------- categorias

   Categoria é rótulo, não pasta: mudar a de uma carta não a move de lista
   nem mexe em quantidade. A única exceção é o Sideboard, que muda a conta
   das 100 — e por isso o toast diz isso em voz alta quando ela entra ou
   sai de lá. */
function definirCategoria(nome, tabuleiro, categoria){
  const entrada = acharEntrada(nome, tabuleiro);
  if (!entrada) return;
  guardarDesfazer();
  const antes = entrada.categoria || "";
  entrada.categoria = categoria || "";
  estado.validacao = null;
  desenharTudo();
  agendarSalvar();

  const eraFora = CATEGORIAS_FORA_DA_CONTA.has(antes);
  const viraFora = CATEGORIAS_FORA_DA_CONTA.has(entrada.categoria);
  if (tabuleiro === "deck" && viraFora && !eraFora){
    toast(`${nome} foi pro sideboard: sai das 100 e das análises, mas ` +
          `continua na cotação.`);
  } else if (tabuleiro === "deck" && eraFora && !viraFora){
    toast(`${nome} voltou pras 100.`);
  } else {
    toast(entrada.categoria
      ? `${nome} agora está em "${entrada.categoria}".`
      : `${nome} voltou pro grupo do tipo dela.`);
  }
}

/* Cria uma categoria. `carta` opcional: criar a partir do menu de uma linha já
   põe aquela carta dentro, senão o caminho seria criar, fechar, reabrir o
   menu e escolher. */
function criarCategoria(nome, carta, tabuleiro){
  nome = (nome || "").trim().slice(0, 40);
  if (!nome) return null;
  const jaExiste = todasAsCategorias()
    .find(c => c.toLowerCase() === nome.toLowerCase());
  if (jaExiste && !ehPropria(jaExiste)){
    toast(`"${jaExiste}" já é uma categoria da tela.`);
    if (carta) definirCategoria(carta, tabuleiro, jaExiste);
    return jaExiste;
  }
  if (jaExiste){
    if (carta) definirCategoria(carta, tabuleiro, jaExiste);
    return jaExiste;
  }
  if (estado.categorias.length >= 40){
    toast("Já são 40 categorias — apague alguma antes de criar outra.");
    return null;
  }
  guardarDesfazer();
  estado.categorias.push(nome);
  if (carta){
    const entrada = acharEntrada(carta, tabuleiro);
    if (entrada) entrada.categoria = nome;
  }
  desenharTudo();
  agendarSalvar();
  toast(`Categoria "${nome}" criada.`);
  return nome;
}

function renomearCategoria(antiga, nova){
  nova = (nova || "").trim().slice(0, 40);
  if (!nova || nova === antiga) return;
  if (todasAsCategorias().some(c => c.toLowerCase() === nova.toLowerCase())){
    toast(`Já existe uma categoria "${nova}".`);
    return;
  }
  guardarDesfazer();
  estado.categorias = estado.categorias.map(c => c === antiga ? nova : c);
  // As duas listas: o maybeboard herda as categorias do deck, então
  // renomear no deck e não renomear lá deixaria um grupo órfão do outro
  // lado, com o nome velho e sem dono.
  for (const e of estado.cartas.concat(estado.maybe)){
    if (e.categoria === antiga) e.categoria = nova;
  }
  desenharTudo();
  agendarSalvar();
}

/* Apagar a categoria NÃO apaga carta: elas voltam pro grupo do tipo delas.
   Uma categoria é uma forma de olhar a lista, e desfazer uma forma de olhar
   não pode custar 12 cartas. */
function apagarCategoria(cat){
  guardarDesfazer();
  estado.categorias = estado.categorias.filter(c => c !== cat);
  let soltas = 0;
  for (const e of estado.cartas.concat(estado.maybe)){
    if (e.categoria === cat){ e.categoria = ""; soltas++; }
  }
  desenharTudo();
  agendarSalvar();
  toast(soltas
    ? `Categoria "${cat}" apagada — ${soltas} carta(s) voltaram pro grupo do tipo.`
    : `Categoria "${cat}" apagada.`);
}

function moverCategoria(cat, passo){
  const i = estado.categorias.indexOf(cat);
  const destino = i + passo;
  if (i < 0 || destino < 0 || destino >= estado.categorias.length) return;
  guardarDesfazer();
  estado.categorias.splice(i, 1);
  estado.categorias.splice(destino, 0, cat);
  desenharTudo();
  agendarSalvar();
}

function escolherComandante(carta){
  guardarDesfazer();
  if (escolherComandante.parceiro && estado.comandantes.length === 1){
    estado.comandantes.push(carta);
  } else {
    estado.comandantes = [carta];
  }
  escolherComandante.parceiro = false;
  if (!estado.nome || estado.nome === "Deck sem nome"){
    estado.nome = carta.nome.split(",")[0];
    $("nome-deck").value = estado.nome;
  }
  estado.validacao = null;
  desenharTudo();
  buscar();          // a lista da lateral agora tem identidade pra filtrar
  agendarSalvar();
}

function tirarComandante(indice){
  guardarDesfazer();
  estado.comandantes.splice(indice, 1);
  estado.validacao = null;
  desenharTudo();
  buscar();
  agendarSalvar();
}
