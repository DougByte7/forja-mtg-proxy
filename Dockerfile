# O build do front (front/ → app/static/dist). O worker precisa dele: a tela
# de pedidos (/admin) é servida pelo painel dele, não pela Vercel.
FROM node:24-slim AS front
WORKDIR /src/front
COPY front/package.json front/pnpm-lock.yaml front/pnpm-workspace.yaml ./
RUN npx --yes pnpm@12.8.1 install --frozen-lockfile
COPY front/ ./
RUN npx --yes pnpm@12.8.1 build

FROM python:3.12-slim

# A etiqueta serve pra faxina do deploy: cada rebuild deixa a imagem anterior
# sem tag, e é por esta label que o `deploy/atualizar.sh` acha as sobras da
# Forja sem encostar nas imagens dos outros serviços da máquina.
LABEL app=forja-backend

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends cups-client \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY --from=front /src/app/static/dist ./app/static/dist
# O worker da impressora sai desta mesma imagem, com outro comando (ver o
# docker-compose.yml). Ele usa o `cups-client` lá de cima; o site não usa mais.
COPY worker ./worker

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
