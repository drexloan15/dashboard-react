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

## Respaldo automático

El servidor corre en **UTC** (`Etc/UTC`) y Perú es UTC−5, así que la hora del
cron **no** es la hora local. Línea actual en el `crontab -u jpuccio`:

```cron
# Respaldo de lexmark_monitor. 00:30 UTC = 19:30 en Peru (UTC-5).
30 0 * * * /home/jpuccio/vantio-monitoreo/backup-monitoreo-db.sh >> /home/jpuccio/vantio-monitoreo/backups/cron.log 2>&1
```

El mismo crontab tiene una línea de **VANTIO** (`10 19 * * * backup-vantio-db.sh`),
de otro proyecto. Al editar, filtrar por `backup-monitoreo-db.sh` y dejar la otra
intacta.

`backup-monitoreo-db.sh` hace `pg_dump -F c`, aborta si el dump sale vacío
(mejor conservar el anterior que subir basura), lo copia a
`gdrive:Monitoreo-Backups` y rota a 14 días, local y remoto.

⚠️ **Pendiente:** `rclone` usa el `client_id` compartido de Google, que se retira
durante 2026. Cuando deje de funcionar, los dumps se seguirán generando en disco
pero **no subirán a Drive** — y afecta a **los dos** respaldos, el de monitoreo y
el de VANTIO, porque comparten el remoto `gdrive`. Sin copia fuera del servidor,
un fallo de hardware se lleva todo; es lo que pasó con el 192.168.1.191.

Se arregla creando un client_id propio (gratis, ~10 min):
https://rclone.org/drive/#making-your-own-client-id

Hay un recordatorio por correo agendado para el **viernes 2026-09-04 a las 8:30**
hora de Perú (`30 13 4 9 *`, o sea 13:30 UTC):

```
recordatorio-rclone.py   # se envía una vez y se borra solo del crontab
```

Se puede probar sin agendar nada ni tocar el cron:
`python3 recordatorio-rclone.py --prueba`

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
