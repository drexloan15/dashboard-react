# Despliegue — servidor de monitoreo (192.168.1.51)

Copia versionada de lo que vive en `~/vantio-monitoreo` del servidor. Estaba
solo ahí, en un único ejemplar: el servidor anterior (192.168.1.191) murió el
2026-08-28 y se perdió la base de datos entera. Este directorio existe para
que la configuración de despliegue no corra el mismo riesgo.

| Archivo | Qué es |
|---|---|
| `docker-compose.yml` | Los 5 servicios del stack `vantio-monitoreo` |
| `monitoreo.sh` | Gestión: `up down restart rebuild logs ps psql backup url` |
| `backup-monitoreo-db.sh` | Respaldo diario a Google Drive (cron 3:30 AM) |
| `env.example` | Plantilla del `.env` (credenciales de PostgreSQL) |
| `backend.env.example` | Plantilla del `backend.env` |

## Lo que NO está aquí, a propósito

Los tres archivos de secretos, que viven solo en el servidor con `chmod 600`:

- `.env` — credenciales de PostgreSQL
- `backend.env` — `DATABASE_URL`, `ADMIN_PIN`, credenciales de correo
- `agent.env` — `AGENT_API_KEY` y credenciales de la BD para `api_server`

Sus plantillas sí están (`*.example`), así que se puede reconstruir todo
sabiendo las contraseñas.

## Convivencia con VANTIO — leer antes de tocar Docker

El servidor comparte máquina con el stack **VANTIO**, de otro proyecto, en
`~/development/VANTIO`. Reglas:

- Nunca `docker compose down` sin estar dentro de `~/vantio-monitoreo`.
- No tocar `~/development/`, ni nada llamado `vantio-*` que no sea
  `vantio-monitoreo`, ni el volumen `vantio_pgdata`.
- Puertos de VANTIO: **3000, 3002, 5173, 5176, 5432**.
- Puertos de monitoreo: **3001** (frontend), **5433** (PostgreSQL).
  `apiserver` y `cloudflared` no publican ninguno.

El 5432 es la trampa: en el host es la base de VANTIO. La de monitoreo es
`db:5432` por la red interna de Docker, o `localhost:5433` desde el host.

## Levantar de cero

```bash
mkdir -p ~/vantio-monitoreo && cd ~/vantio-monitoreo
# copiar aquí este directorio y el código del repo en ./app
cp env.example .env && cp backend.env.example backend.env
chmod 600 .env backend.env
# completar las contraseñas en ambos, y crear agent.env
# (ver agent/agent.env.example en el repo)
./monitoreo.sh rebuild
```

El esquema se crea solo: `init_db()` corre al importar `backend/main.py`, y
las tablas del agente las crea `api_server` en el primer POST.

## Restaurar la base

```bash
docker exec -i monitoreo-postgres pg_restore -U lexmark_user \
  -d lexmark_monitor --clean < backups/archivo.dump
```

## El túnel

`cloudflared` levanta un quick tunnel gratuito. **La URL cambia en cada
reinicio del contenedor.** Para obtener la vigente:

```bash
./monitoreo.sh url
```

Y copiarla al `C:\imp\url.txt` del servidor de Red A. Los agentes leen ese
archivo en cada ejecución, así que no hay que reinstalarlos ni recompilarlos.

Con un dominio propio en Cloudflare se podría usar un *named tunnel*, que da
hostname fijo y elimina este paso.
