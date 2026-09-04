#!/bin/bash
# Heartbeat externo para detectar servidor u host caido, o el stack Docker
# caido con el host arriba.
#
# Por que un "dead man's switch" en vez de un chequeo comun: si el host
# 192.168.1.51 se apaga, NINGUN proceso que corra en el (backend, cron,
# contenedor) puede avisar de su propia caida. La unica forma es invertir el
# problema: este script "hace sonar" un servicio externo (healthchecks.io)
# cada 5 minutos, y ese servicio -- que corre afuera, no depende de este host --
# es el que nota el silencio y manda la alerta. Si el host esta apagado, el
# cron no corre, el ping no llega, y a los ~15 min de gracia salta la alerta
# sola, sin que este script tenga que hacer nada.
#
# Ademas verifica el backend (localhost:8001/health) antes de "sonar": si el
# host esta arriba pero Docker/el stack se cayo, el ping no se manda como
# exitoso sino como fallo explicito (/fail), asi healthchecks.io alerta al
# toque en vez de esperar los 15 min de gracia.
set -euo pipefail

ENV_FILE="$HOME/vantio-monitoreo/heartbeat.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [ -z "${HC_PING_URL:-}" ]; then
  echo "[heartbeat] falta HC_PING_URL en $ENV_FILE" >&2
  exit 1
fi

if curl -fsS --max-time 10 http://localhost:8001/health >/dev/null 2>&1; then
  curl -fsS --max-time 10 -o /dev/null "$HC_PING_URL"
else
  curl -fsS --max-time 10 -o /dev/null "$HC_PING_URL/fail" || true
fi
