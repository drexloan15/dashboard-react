#!/usr/bin/env bash
# Recarga la base de DESARROLLO local con una copia fresca de produccion.
#
#   bash deploy/dev/refrescar-dev.sh
#
# Solo LEE de produccion (pg_dump) y solo ESCRIBE en la base local. No altera
# nada en el 192.168.1.51.
set -euo pipefail

SERVIDOR="jpuccio@192.168.1.51"
LOCAL="monitoreo-postgres-dev"
DB="lexmark_monitor"
USUARIO="lexmark_user"
COMPOSE="$(dirname "$0")/docker-compose.yml"
DUMP="$(mktemp -t lexmark-dev-XXXXXX.dump)"
trap 'rm -f "$DUMP"' EXIT

echo "[1/4] Levantando la base local si hace falta..."
docker compose -f "$COMPOSE" up -d >/dev/null
for _ in $(seq 1 40); do
  docker exec "$LOCAL" pg_isready -U "$USUARIO" -d "$DB" >/dev/null 2>&1 && break
  sleep 1
done

echo "[2/4] Generando dump en produccion..."
ssh "$SERVIDOR" "docker exec monitoreo-postgres pg_dump -U $USUARIO -F c -d $DB" > "$DUMP"

# Un dump vacio significa que algo fallo. Mejor abortar que dejar la base de
# desarrollo en blanco y creer que produccion se quedo sin datos.
if [ ! -s "$DUMP" ]; then
  echo "ERROR: el dump salio vacio. Se conserva la base local como estaba." >&2
  exit 1
fi
echo "      $(du -h "$DUMP" | cut -f1)"

echo "[3/4] Restaurando en local (se reemplaza el contenido actual)..."
docker exec -i "$LOCAL" pg_restore -U "$USUARIO" -d "$DB" \
  --clean --if-exists --no-owner < "$DUMP" 2>&1 | grep -v "^$" || true

echo "[4/4] Listo:"
docker exec "$LOCAL" psql -U "$USUARIO" -d "$DB" -c \
"SELECT 'estado_actual' t, count(*) FROM estado_actual
 UNION ALL SELECT 'inventario', count(*) FROM inventario
 UNION ALL SELECT 'historial',  count(*) FROM historial
 UNION ALL SELECT 'pr_stats',   count(*) FROM pr_stats ORDER BY 1;"
