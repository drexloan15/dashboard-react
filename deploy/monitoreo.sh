#!/bin/bash
# Gestion del stack de monitoreo Lexmark.
# Actua SOLO sobre el proyecto vantio-monitoreo; nunca toca el stack VANTIO.
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  up)      docker compose up -d ;;
  down)    docker compose down ;;
  restart) docker compose restart ;;
  rebuild) docker compose up -d --build ;;
  logs)    docker compose logs -f "${2:-}" ;;
  ps)      docker compose ps ;;
  psql)    docker exec -it monitoreo-postgres psql -U lexmark_user -d lexmark_monitor ;;
  url)     # URL del quick tunnel. Cambia cada vez que se reinicia
           # cloudflared; hay que copiarla al url.txt de Red A.
           docker logs monitoreo-cloudflared 2>&1 |
             grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 ;;
  backup)  mkdir -p backups
           docker exec monitoreo-postgres pg_dump -U lexmark_user -F c -d lexmark_monitor              > "backups/lexmark_monitor_$(date +%Y-%m-%d_%H%M).dump"
           echo "Backup listo en backups/" ;;
  *) echo "uso: $0 {up|down|restart|rebuild|logs [servicio]|ps|psql|backup|url}"; exit 1 ;;
esac
