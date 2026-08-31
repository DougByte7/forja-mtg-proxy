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

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
