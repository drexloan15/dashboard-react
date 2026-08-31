#!/bin/bash
# Respaldo de la BD lexmark_monitor (stack vantio-monitoreo).
# Independiente de backup-vantio-db.sh: otro contenedor, otra carpeta local
# y otra carpeta en Drive. No toca VANTIO-Backups.
set -euo pipefail

BACKUP_DIR="$HOME/vantio-monitoreo/backups"
RCLONE="$HOME/bin/rclone"
CONTAINER="monitoreo-postgres"
DB="lexmark_monitor"
DB_USER="lexmark_user"
REMOTE="gdrive:Monitoreo-Backups"
STAMP=$(date +%Y-%m-%d_%H%M)
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"

OUT="$BACKUP_DIR/${DB}_${STAMP}.dump"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -F c -d "$DB" > "$OUT"

# Aborta si el dump salio vacio: mejor conservar el anterior que subir basura.
if [ ! -s "$OUT" ]; then
  echo "[backup-monitoreo] ERROR: dump vacio, se elimina" >&2
  rm -f "$OUT"
  exit 1
fi

"$RCLONE" copy "$BACKUP_DIR" "$REMOTE" --include "*_${STAMP%_*}*.dump"   --log-file "$BACKUP_DIR/rclone.log" --log-level INFO

# Rotacion local y remota
find "$BACKUP_DIR" -name "*.dump" -type f -mtime +$RETENTION_DAYS -delete
"$RCLONE" delete "$REMOTE" --min-age "${RETENTION_DAYS}d" --include "*.dump"

echo "[backup-monitoreo] OK $STAMP ($(du -h "$OUT" | cut -f1))"
