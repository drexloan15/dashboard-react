# api_server.py — el unico proceso que escribe en PostgreSQL.
# Corre dentro del stack vantio-monitoreo y habla con la BD por la red
# interna de Docker (db:5432), nunca por el puerto del host: ahi el 5432
# es el PostgreSQL del stack VANTIO.
#
# No publica ningun puerto al host. Lo alcanza cloudflared por la red
# interna, asi que no queda expuesto en la LAN.
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1

COPY requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt

COPY api_server.py .

EXPOSE 8000
CMD ["uvicorn", "api_server:app", "--host", "0.0.0.0", "--port", "8000"]
