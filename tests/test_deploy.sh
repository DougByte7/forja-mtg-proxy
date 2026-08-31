#!/usr/bin/env bash
#
# Confere o deploy/atualizar.sh sem docker, sem rede e sem servidor.
#
# Motivo de existir: script de deploy só é exercitado quando se publica, e a
# hora de descobrir que o desfazer não desfaz é a PIOR possível — de
# madrugada, com a página fora do ar. Aqui o git é de verdade (repositório de
# mentira criado na hora) e o motor de container e o curl são dublês que
# obedecem ao que o teste mandar.
#
#     bash tests/test_deploy.sh
#
# Sai com 1 se qualquer checagem falhar.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BANCADA="$(mktemp -d)"
trap 'rm -rf "$BANCADA"' EXIT
falhas=0

check(){ # nome, condição já avaliada em $2 (0 = ok)
  if [ "$2" -eq 0 ]; then echo "ok    $1"
  else echo "FALHA $1 ${3:-}"; falhas=$((falhas + 1)); fi
}
eq(){ # nome, obtido, esperado
  [ "$2" = "$3" ] && check "$1" 0 || check "$1" 1 "(obtido '$2', esperado '$3')"
}

# --------------------------------------------------------------------------
# Dublês: um "docker" que anota o que pediram e obedece ao roteiro, e um
# "curl" que responde conforme o teste tenha ligado a saúde ou não.
# --------------------------------------------------------------------------
mkdir -p "$BANCADA/bin"
cat > "$BANCADA/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$BANCADA/chamadas.txt"
case "$1 ${2:-}" in
  "compose version") exit 0 ;;
  "image prune")     exit 0 ;;
esac
if [ "$1" = "inspect" ]; then
  cat "$BANCADA/DONO_DO_CONTAINER" 2>/dev/null
  [ -f "$BANCADA/DONO_DO_CONTAINER" ] || exit 1
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "up" ]; then
    echo "$(cat "$BANCADA/servidor/marca.txt" 2>/dev/null || echo '?')" \
      >> "$BANCADA/builds.txt"
    [ -f "$BANCADA/SUBIR_FALHA" ] && exit 1
    exit 0
  fi
  [ "$arg" = "logs" ] && exit 0
done
exit 0
FAKE
cat > "$BANCADA/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$BANCADA/chamadas.txt"
# A saúde acompanha o commit: o teste escreve aqui o que "está no ar".
[ -f "$BANCADA/SAUDE_OK" ] && exit 0
exit 22
FAKE
chmod +x "$BANCADA/bin/docker" "$BANCADA/bin/curl"
export BANCADA
export PATH="$BANCADA/bin:$PATH"

# --------------------------------------------------------------------------
# Um repositório de verdade: origem + o clone que faz as vezes do servidor
# --------------------------------------------------------------------------
git init -q --bare "$BANCADA/origem.git"
git clone -q "$BANCADA/origem.git" "$BANCADA/trabalho"
cd "$BANCADA/trabalho"
git config user.email teste@exemplo; git config user.name teste
mkdir -p deploy
cp "$RAIZ/deploy/atualizar.sh" deploy/
chmod +x deploy/atualizar.sh
echo "services: {}" > docker-compose.yml
echo "v1" > marca.txt
git add -A && git commit -qm "v1" && git push -q origin master 2>/dev/null || git push -q origin main
RAMO="$(git rev-parse --abbrev-ref HEAD)"

git clone -q "$BANCADA/origem.git" "$BANCADA/servidor"
SERVIDOR="$BANCADA/servidor"
export FORJA_DIR="$SERVIDOR" FORJA_HEALTH_TIMEOUT=4

novo_commit(){ # cria uma versão nova na origem
  cd "$BANCADA/trabalho"
  echo "$1" > marca.txt
  git add -A && git commit -qm "$1" && git push -q origin "$RAMO"
  cd "$SERVIDOR"
}
publicar(){ "$SERVIDOR/deploy/atualizar.sh" > "$BANCADA/saida.txt" 2>&1; echo $?; }
commit_do_servidor(){ git -C "$SERVIDOR" log -1 --format=%s; }

# --------------------------------------------------------------------------
# 1. Caminho feliz: código novo, container sobe, página responde
# --------------------------------------------------------------------------
touch "$BANCADA/SAUDE_OK"
novo_commit v2
codigo=$(publicar)
eq "publicação bem-sucedida sai com 0" "$codigo" "0"
eq "o servidor ficou no commit novo" "$(commit_do_servidor)" "v2"
check "reconstruiu o container" \
  "$(grep -qc 'compose .*up -d --build' "$BANCADA/chamadas.txt" >/dev/null; echo $?)"
# O compose pode ser o grande do servidor: publicar a Forja não pode reiniciar
# os vizinhos do homelab.
check "não encostou nos outros serviços do compose (--no-deps)" \
  "$(grep -q 'up -d --build --no-deps forja-backend' "$BANCADA/chamadas.txt"; echo $?)"
check "conferiu se a página respondeu" \
  "$(grep -q 'curl .*forja-deploy' "$BANCADA/chamadas.txt"; echo $?)"
check "limpou as imagens velhas SÓ com o filtro da label" \
  "$(grep -q 'image prune -f --filter label=app=forja-backend' "$BANCADA/chamadas.txt"; echo $?)"
check "a saída diz o commit publicado" "$(grep -q 'publicado: .*v2' "$BANCADA/saida.txt"; echo $?)"

# --------------------------------------------------------------------------
# 2. Versão que sobe mas não responde: tem que DESFAZER
# --------------------------------------------------------------------------
: > "$BANCADA/builds.txt"
rm -f "$BANCADA/SAUDE_OK"          # a página não responde mais
novo_commit v3-quebrado
codigo=$(publicar)
eq "publicação quebrada sai com erro" "$codigo" "1"
eq "o servidor VOLTOU pro commit que funcionava" "$(commit_do_servidor)" "v2"
check "reconstruiu de novo ao desfazer (não só resetou o git)" \
  "$([ "$(wc -l < "$BANCADA/builds.txt")" -ge 2 ] && echo 0 || echo 1)" \
  "(builds: $(wc -l < "$BANCADA/builds.txt"))"
check "avisou que desfez" "$(grep -q 'DESFAZENDO' "$BANCADA/saida.txt"; echo $?)"
check "mostrou o log do container antes de desfazer" \
  "$(grep -q 'compose .*logs --tail' "$BANCADA/chamadas.txt"; echo $?)"
check "não limpou imagem nenhuma numa publicação que falhou" \
  "$([ "$(grep -c 'image prune' "$BANCADA/chamadas.txt")" -eq 1 ] && echo 0 || echo 1)"

# O código anterior continua no ar de verdade: a próxima publicação parte dele.
touch "$BANCADA/SAUDE_OK"
novo_commit v4
codigo=$(publicar)
eq "depois de desfazer, a publicação seguinte funciona" "$codigo" "0"
eq "e chega no commit novo" "$(commit_do_servidor)" "v4"

# --------------------------------------------------------------------------
# 2b. O `up` em si falhando (nome de container em uso, imagem que não builda)
# --------------------------------------------------------------------------
# Isto já escapou uma vez: com `set -e`, um `up` que falha abortava o script
# ANTES do log e do desfazer. Falha de subir tem que ser tratada igual a
# falha de responder.
: > "$BANCADA/builds.txt"
touch "$BANCADA/SUBIR_FALHA"
echo "/home/eu/homelab/docker-compose.yml" > "$BANCADA/DONO_DO_CONTAINER"
novo_commit v5-nao-sobe
codigo=$(publicar)
eq "up que falha sai com erro" "$codigo" "1"
eq "up que falha também desfaz" "$(commit_do_servidor)" "v4"
check "e mostra o log do container" \
  "$(grep -q 'compose .*logs --tail' "$BANCADA/chamadas.txt"; echo $?)"
check "e aponta o compose que É dono do container" \
  "$(grep -q 'FORJA_COMPOSE=/home/eu/homelab/docker-compose.yml' "$BANCADA/saida.txt"; echo $?)"
rm -f "$BANCADA/SUBIR_FALHA" "$BANCADA/DONO_DO_CONTAINER"

# Sem dono declarado (container criado na mão, sem label), a dica não aparece
# — palpite errado atrapalha mais que silêncio.
touch "$BANCADA/SUBIR_FALHA"
novo_commit v5b
codigo=$(publicar)
check "sem label de compose, nenhuma dica é inventada" \
  "$(grep -q 'FORJA_COMPOSE=' "$BANCADA/saida.txt" && echo 1 || echo 0)"
rm -f "$BANCADA/SUBIR_FALHA"
touch "$BANCADA/SAUDE_OK"
publicar > /dev/null    # volta pro verde antes do próximo cenário

# --------------------------------------------------------------------------
# 3. Desfazer desligado: fica no commit novo e falha alto
# --------------------------------------------------------------------------
rm -f "$BANCADA/SAUDE_OK"
novo_commit v5-quebrado
codigo=$(FORJA_ROLLBACK=0 "$SERVIDOR/deploy/atualizar.sh" > "$BANCADA/saida.txt" 2>&1; echo $?)
eq "com FORJA_ROLLBACK=0 continua saindo com erro" "$codigo" "1"
eq "com FORJA_ROLLBACK=0 NÃO volta atrás" "$(commit_do_servidor)" "v5-quebrado"

# --------------------------------------------------------------------------
# 4. Mudança feita na mão no servidor: para antes de mexer em qualquer coisa
# --------------------------------------------------------------------------
touch "$BANCADA/SAUDE_OK"
echo "mexi aqui na unha" >> "$SERVIDOR/docker-compose.yml"
antes="$(commit_do_servidor)"
: > "$BANCADA/builds.txt"
codigo=$(publicar)
eq "arquivo mexido na mão faz parar" "$codigo" "1"
eq "e não mexeu no código" "$(commit_do_servidor)" "$antes"
eq "e não reconstruiu nada" "$(wc -l < "$BANCADA/builds.txt")" "0"
check "explica o que fazer" "$(grep -q 'não commitadas' "$BANCADA/saida.txt"; echo $?)"
git -C "$SERVIDOR" checkout -q -- docker-compose.yml

# Arquivo que ninguém rastreia (o .claude/ do editor, um .env.bak) NÃO pode
# barrar a publicação: ele não atrapalha o `git pull --ff-only`, e num servidor
# sempre aparece um. Isto já travou uma publicação de verdade.
mkdir -p "$SERVIDOR/.claude"
echo '{}' > "$SERVIDOR/.claude/settings.local.json"
echo "backup" > "$SERVIDOR/.env.bak"
novo_commit v6
codigo=$(publicar)
eq "arquivo não rastreado NÃO barra a publicação" "$codigo" "0"
eq "e o código chega no commit novo" "$(commit_do_servidor)" "v6"
check "e o arquivo continua lá, intocado" \
  "$([ -f "$SERVIDOR/.claude/settings.local.json" ] && echo 0 || echo 1)"
rm -rf "$SERVIDOR/.claude" "$SERVIDOR/.env.bak"

# --------------------------------------------------------------------------
# 5. Sem conferência de saúde: publica no escuro, mas publica
# --------------------------------------------------------------------------
rm -f "$BANCADA/SAUDE_OK"          # o curl responderia erro, se fosse chamado
: > "$BANCADA/chamadas.txt"
novo_commit v7
codigo=$(FORJA_HEALTH_URL= "$SERVIDOR/deploy/atualizar.sh" > "$BANCADA/saida.txt" 2>&1; echo $?)
eq "FORJA_HEALTH_URL vazia publica assim mesmo" "$codigo" "0"
check "e não chama o curl" "$(grep -q 'curl ' "$BANCADA/chamadas.txt" && echo 1 || echo 0)"

# Clone com remoto SSH: na mão funciona (tem agente de chave na sessão), pelo
# runner não (roda como serviço, sem agente). O erro do git sozinho não diz o
# que fazer, então a dica tem que sair junto — e colável.
antes="$(commit_do_servidor)"
git -C "$SERVIDOR" remote set-url origin git@github.com:DougByte7/forja-mtg-proxy.git
codigo=$(GIT_SSH_COMMAND=false publicar)      # ssh falha na hora, sem rede
eq "remoto SSH inalcançável faz parar" "$codigo" "1"
eq "e não mexeu no código" "$(commit_do_servidor)" "$antes"
check "explica que o runner não tem agente de chave" \
  "$(grep -q 'sem agente de chave' "$BANCADA/saida.txt"; echo $?)"
check "e dá o comando pronto pra trocar por HTTPS" \
  "$(grep -q "remote set-url origin https://github.com/DougByte7/forja-mtg-proxy.git" \
     "$BANCADA/saida.txt"; echo $?)"
git -C "$SERVIDOR" remote set-url origin "$BANCADA/origem.git"

# --------------------------------------------------------------------------
# 6. Recados de configuração errada
# --------------------------------------------------------------------------
codigo=$(FORJA_DIR="$BANCADA" "$SERVIDOR/deploy/atualizar.sh" > "$BANCADA/saida.txt" 2>&1; echo $?)
eq "pasta que não é clone git para na hora" "$codigo" "1"
check "e diz por quê" "$(grep -q 'não é um clone git' "$BANCADA/saida.txt"; echo $?)"

codigo=$(FORJA_COMPOSE="$BANCADA/nao-existe.yml" "$SERVIDOR/deploy/atualizar.sh" \
         > "$BANCADA/saida.txt" 2>&1; echo $?)
eq "compose inexistente para na hora" "$codigo" "1"
check "e diz onde procurou" "$(grep -q 'não achei o compose' "$BANCADA/saida.txt"; echo $?)"

echo
if [ "$falhas" -gt 0 ]; then echo "$falhas checagem(ns) falharam"; exit 1; fi
echo "tudo certo"
