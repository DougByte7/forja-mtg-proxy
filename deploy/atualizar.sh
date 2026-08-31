#!/usr/bin/env bash
#
# Atualiza a Forja no servidor: puxa o código novo, reconstrói o container e
# confere se a página voltou a responder. Se não voltar, DESFAZ e volta pro
# commit anterior — a página no ar vale mais que a versão nova.
#
# Roda sozinho a cada push na main (.github/workflows/publicar.yml) e na mão
# quando precisar, de dentro da pasta do projeto no servidor:
#
#     ./deploy/atualizar.sh
#
# Um detalhe do caminho automático: quem executa é a cópia do script que JÁ
# estava no servidor, porque ele é quem faz o `git pull`. Mudança neste
# arquivo vale a partir do deploy seguinte, nunca no mesmo. É o preço de o
# script ser o próprio atualizador, e não incomoda contanto que se saiba.
#
# Configuração — tudo opcional, tudo por variável de ambiente. No deploy
# automático elas saem do `.env` do runner (veja o README, seção
# "Publicação automática"):
#
#   FORJA_DIR             pasta do projeto no servidor (padrão: a pasta deste
#                         script, que é o certo quando se roda na mão)
#   FORJA_COMPOSE         arquivo compose (padrão: docker-compose.yml da pasta).
#                         Aponte pro compose grande do servidor se a Forja for
#                         um serviço dentro dele (veja docker-compose.snippet.yml)
#   FORJA_SERVICE         nome do serviço no compose (padrão: forja-backend)
#   FORJA_HEALTH_URL      o que chamar pra saber se subiu (padrão:
#                         http://localhost:8000/). Vazio pula a conferência
#   FORJA_HEALTH_TIMEOUT  segundos de paciência esperando subir (padrão: 90)
#   FORJA_ROLLBACK        0 desliga o desfazer automático (padrão: 1)
#   FORJA_PRUNE           0 desliga a limpeza das imagens velhas (padrão: 1)
#
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORJA_DIR="${FORJA_DIR:-$AQUI}"
FORJA_SERVICE="${FORJA_SERVICE:-forja-backend}"
FORJA_COMPOSE="${FORJA_COMPOSE:-$FORJA_DIR/docker-compose.yml}"
FORJA_HEALTH_URL="${FORJA_HEALTH_URL-http://localhost:8000/}"
FORJA_HEALTH_TIMEOUT="${FORJA_HEALTH_TIMEOUT:-90}"
FORJA_ROLLBACK="${FORJA_ROLLBACK:-1}"
FORJA_PRUNE="${FORJA_PRUNE:-1}"

diz(){ echo "==> $*"; }
morre(){ echo "ERRO: $*" >&2; exit 1; }

# --------------------------------------------------------------------------
# Ferramentas e terreno
# --------------------------------------------------------------------------
# docker e podman aceitam os mesmos argumentos aqui, e o servidor pode ter um
# ou outro (a máquina de teste usa podman). Descobre em vez de exigir.
if   docker compose version  >/dev/null 2>&1; then COMPOSE=(docker compose)
elif podman compose version  >/dev/null 2>&1; then COMPOSE=(podman compose)
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose)
elif command -v podman-compose >/dev/null 2>&1; then COMPOSE=(podman-compose)
else morre "não achei docker compose nem podman compose nesta máquina."; fi
MOTOR="${COMPOSE[0]}"

[ -d "$FORJA_DIR/.git" ] || morre "$FORJA_DIR não é um clone git. \
Aponte FORJA_DIR pra pasta do projeto no servidor."
[ -f "$FORJA_COMPOSE" ] || morre "não achei o compose em $FORJA_COMPOSE. \
Se a Forja é um serviço do compose grande do servidor, aponte FORJA_COMPOSE pra ele."

cd "$FORJA_DIR"

# Arquivo RASTREADO mexido na mão faria o pull falhar no meio. Melhor parar
# aqui, com o nome dos arquivos na tela, do que no meio da atualização.
#
# `--untracked-files=no` de propósito: arquivo que ninguém rastreia (um
# `.claude/` do editor, um `.env.bak`) não atrapalha o `git pull --ff-only`.
# Barrar por causa dele seria travar a publicação por um arquivo que não tem
# nada a ver com o código — e num servidor sempre aparece um.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  morre "há mudanças não commitadas em arquivos versionados de $FORJA_DIR. \
Resolva na mão (git stash, git checkout) antes de publicar."
fi

# --------------------------------------------------------------------------
# Código novo
# --------------------------------------------------------------------------
ANTES="$(git rev-parse HEAD)"
diz "commit atual: $(git log -1 --format='%h %s' "$ANTES")"

diz "puxando o código novo…"
# --ff-only: se não der pra avançar em linha reta, alguma coisa está errada
# (commit local no servidor, força na main). Melhor falhar que criar merge.
if ! git pull --ff-only; then
  # O tropeço clássico: clone feito com remoto SSH. Na mão funciona, porque
  # existe agente de chave na sessão; pelo runner não, porque ele roda como
  # serviço, sem agente nenhum. Como o repositório é público, HTTPS resolve
  # sem chave, sem token e sem nada guardado no servidor.
  case "$(git remote get-url origin 2>/dev/null)" in
    git@*|ssh://*)
      https="$(git remote get-url origin \
               | sed -E 's#^(ssh://)?git@([^:/]+)[:/]#https://\2/#')"
      echo "DICA: o remoto é SSH, e quem puxa aqui é o runner rodando como" >&2
      echo "      serviço — sem agente de chave. O repositório é público," >&2
      echo "      então HTTPS resolve sem credencial nenhuma:" >&2
      echo "      git -C '$FORJA_DIR' remote set-url origin $https" >&2
      ;;
  esac
  morre "não consegui puxar o código novo (veja o erro do git acima)."
fi

DEPOIS="$(git rev-parse HEAD)"
if [ "$ANTES" = "$DEPOIS" ]; then
  diz "nada mudou no código — reconstruindo mesmo assim (é o que se espera de \
uma publicação manual)."
else
  diz "novo commit: $(git log -1 --format='%h %s' "$DEPOIS")"
fi

# --------------------------------------------------------------------------
# Container
# --------------------------------------------------------------------------
subir(){
  # `--no-deps` porque o compose costuma ser o GRANDE do servidor, com os
  # outros serviços do homelab dentro. Publicar a Forja não pode reiniciar o
  # vizinho de baixo — só o serviço nomeado aqui é tocado.
  "${COMPOSE[@]}" -f "$FORJA_COMPOSE" up -d --build --no-deps "$FORJA_SERVICE"
}

# Espera a página responder de verdade. Sem isto, "deploy ok" significa só
# "o compose não reclamou" — e container que sobe e morre em dois segundos
# passa batido.
esta_no_ar(){
  [ -z "$FORJA_HEALTH_URL" ] && { diz "conferência pulada (FORJA_HEALTH_URL vazia)."; return 0; }
  diz "esperando $FORJA_HEALTH_URL responder (até ${FORJA_HEALTH_TIMEOUT}s)…"
  local fim=$((SECONDS + FORJA_HEALTH_TIMEOUT))
  while [ $SECONDS -lt $fim ]; do
    # O User-Agent diz quem é: o log de visitas classifica por ele, e uma
    # conferência de deploy não pode entrar na conta como "pessoa".
    if curl -fsS -o /dev/null --max-time 5 \
         -A "forja-deploy/1.0 (bot; conferência pós-publicação)" \
         "$FORJA_HEALTH_URL"; then
      diz "no ar."
      return 0
    fi
    sleep 3
  done
  return 1
}

# Dentro do `if` de propósito: comando que falha aí não dispara o `set -e`.
# Solto, um `up` que desse errado abortaria o script na hora — sem log, sem
# desfazer, sem dica. Era o que acontecia.
diz "reconstruindo e subindo o serviço $FORJA_SERVICE…"
if subir && esta_no_ar; then
  if [ "$FORJA_PRUNE" != "0" ]; then
    # Cada rebuild deixa a imagem anterior pra trás, sem tag. Num servidor de
    # casa isso vira dezenas de GB em alguns meses. O filtro por label é o que
    # garante que só as NOSSAS sobras saem (a label está no Dockerfile) —
    # prune sem filtro mexeria nas imagens dos outros serviços da máquina.
    diz "limpando imagens velhas da Forja…"
    "$MOTOR" image prune -f --filter label=app=forja-backend >/dev/null || true
  fi
  diz "publicado: $(git log -1 --format='%h %s')"
  exit 0
fi

# --------------------------------------------------------------------------
# Não subiu
# --------------------------------------------------------------------------
# O tropeço clássico quando a Forja é um serviço do compose grande do
# servidor: o container que está rodando pertence a OUTRO arquivo compose, e o
# docker recusa criar outro com o mesmo nome ("name is already in use").
# Publicar pelo compose errado nunca ia atualizar o container certo, então a
# dica é a correção de verdade, não um contorno.
dono="$("$MOTOR" inspect "$FORJA_SERVICE" \
        --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
        2>/dev/null || true)"
if [ -n "$dono" ] && [ "$dono" != "$FORJA_COMPOSE" ]; then
  echo "DICA: o container '$FORJA_SERVICE' que está rodando foi criado por outro" >&2
  echo "      compose:  $dono" >&2
  echo "      e esta publicação usou:  $FORJA_COMPOSE" >&2
  echo "      Aponte FORJA_COMPOSE pra ele no .env do runner (e reinicie o" >&2
  echo "      serviço do runner):" >&2
  echo "      FORJA_COMPOSE=$dono" >&2
fi

echo "ERRO: o serviço não subiu ou não respondeu. Últimas linhas do log:" >&2
"${COMPOSE[@]}" -f "$FORJA_COMPOSE" logs --tail 50 "$FORJA_SERVICE" >&2 || true

if [ "$FORJA_ROLLBACK" = "0" ] || [ "$ANTES" = "$DEPOIS" ]; then
  morre "o serviço não subiu. O código continua em $(git rev-parse --short HEAD)."
fi

# Volta pro que funcionava. A página no ar vale mais que a versão nova: quem
# publicou pode estar dormindo, e quem abrir a Forja no meio disso não tem
# nada a ver com o commit quebrado.
echo "==> DESFAZENDO: voltando pro commit $(git log -1 --format='%h %s' "$ANTES")" >&2
git reset --hard "$ANTES"
if subir && esta_no_ar; then
  morre "a versão nova não subiu; o servidor voltou pro commit anterior \
($(git rev-parse --short "$ANTES")) e está no ar. Conserte e publique de novo."
fi
morre "a versão nova não subiu E o desfazer também não. O serviço está fora do \
ar — olhe o log acima."
