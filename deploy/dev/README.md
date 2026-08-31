# Entorno de desarrollo local

Una copia de la base de producción corriendo en Docker en la laptop, para
probar cambios sin tocar los datos reales del 192.168.1.51.

Solo la **base de datos** va en Docker. El backend y el frontend se siguen
levantando con `iniciar.bat` como siempre; lo único que cambia es a qué
PostgreSQL apuntan.

## Levantarlo

```bash
docker compose -f deploy/dev/docker-compose.yml up -d
bash deploy/dev/refrescar-dev.sh      # trae una copia fresca de producción
```

`refrescar-dev.sh` solo **lee** de producción (`pg_dump`) y solo **escribe** en
la base local. Se puede correr cuantas veces se quiera; reemplaza el contenido
local por el de producción. Aborta si el dump sale vacío, para no dejar la base
de desarrollo en blanco por un fallo de conexión.

## Los puertos

| Puerto | Quién |
|---|---|
| 5432 | `vantio-postgres-dev`, del otro proyecto en esta misma laptop |
| **5434** | **esta base de desarrollo** |
| 5433 | producción, en el servidor (no local) |

Se eligió el 5434 para que los tres puedan convivir y para que una cadena de
conexión no se confunda con otra. Solo escucha en `127.0.0.1`: es una base de
pruebas, no tiene por qué quedar expuesta a la red de la oficina.

## Cómo saber a cuál estás apuntando

`backend/.env` manda. Por defecto queda en desarrollo:

```
DATABASE_URL=postgresql://lexmark_user:dev@127.0.0.1:5434/lexmark_monitor
```

El mismo archivo lleva comentada la línea de producción. **El default es
desarrollo a propósito**: si alguien olvida revisarlo, el error es inofensivo.
Al revés no.

Para confirmarlo en cualquier momento:

```bash
docker exec monitoreo-postgres-dev psql -U lexmark_user -d lexmark_monitor \
  -c "SELECT count(*) FROM estado_actual;"
```

## Qué NO afecta a producción

- Levantar, parar o borrar este contenedor
- Restaurar, vaciar o romper la base local
- Correr `init_db()`, migraciones o cualquier `iniciar.bat`

## Qué SÍ afectaría

- Correr un **agente** (`agente_lexmark.exe`, `pr_stats_agent.exe`) con un
  `agent.env` que apunte al túnel real: los agentes escriben en producción a
  través de `api_server`, no leen el `backend/.env`. Para probar agentes, usar
  una `API_URL` inexistente o sustituir el envío.
- Volver a poner la `DATABASE_URL` de producción y olvidarse.

## Parar y borrar

```bash
docker compose -f deploy/dev/docker-compose.yml down       # parar
docker compose -f deploy/dev/docker-compose.yml down -v    # y borrar los datos
```

El `-v` borra solo el volumen `monitoreo-dev_pgdata-dev`. No toca
`vantio-postgres-dev-data` ni nada del servidor.
