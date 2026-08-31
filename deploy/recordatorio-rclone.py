#!/usr/bin/env python3
"""Recordatorio unico: crear un client_id propio de Google Drive para rclone.

El client_id compartido que trae rclone por defecto lo retira Google durante
2026. Cuando caiga dejan de subirse LOS DOS respaldos -- el de monitoreo y el
de VANTIO -- y quedariamos solo con los dumps locales, que es exactamente el
escenario que costo la base del servidor 192.168.1.191.

Se agenda con una linea de cron para una fecha concreta. Al enviarse bien se
borra a si mismo del crontab, asi que no se repite el año que viene. Si el
envio falla NO se borra, para que reintente en la siguiente pasada.
"""
import re
import smtplib
import subprocess
import sys
from email.mime.text import MIMEText
from pathlib import Path

ENV = Path.home() / "vantio-monitoreo" / "backend.env"
MARCA = "recordatorio-rclone"        # como se reconoce su propia linea de cron
PARA = "jean.puccio@comutelperu.com"

def leer_env() -> dict:
    datos = {}
    for linea in ENV.read_text(encoding="utf-8", errors="replace").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        k, _, v = linea.partition("=")
        datos[k.strip()] = v.strip().strip('"').strip("'")
    return datos

CUERPO = """Recordatorio: crear un client_id propio de Google Drive para rclone.

QUE PASA SI NO SE HACE
El client_id compartido que rclone trae por defecto lo retira Google durante
2026. Cuando deje de funcionar, los respaldos SIGUEN generandose en el disco
del servidor pero YA NO SUBEN a Drive. Afecta a los dos: el de monitoreo
(lexmark_monitor) y el de VANTIO.

Sin copia fuera del servidor, un fallo de hardware se lleva todo. Es lo que
paso con el 192.168.1.191 en agosto.

COMO SE ARREGLA (unos 10 minutos, gratis)
1. https://rclone.org/drive/#making-your-own-client-id  -- seguir la guia
2. En la consola de Google Cloud: crear proyecto, habilitar Google Drive API,
   crear credenciales OAuth de tipo "Aplicacion de escritorio"
3. En el servidor:  ~/bin/rclone config  ->  editar el remoto "gdrive"
   y pegar el client_id y el client_secret nuevos
4. Probar:  ~/bin/rclone ls gdrive:Monitoreo-Backups
   Ya no deberia salir el aviso de "shared client_id".

OJO: el remoto gdrive lo usan los dos proyectos, asi que arreglarlo una vez
sirve para ambos respaldos.

DONDE MIRAR
  Script:  ~/vantio-monitoreo/backup-monitoreo-db.sh
  Cron:    30 0 * * *   (00:30 UTC = 19:30 hora de Peru)
  Log:     ~/vantio-monitoreo/backups/cron.log
  Repo:    deploy/README.md

-- Enviado automaticamente por el servidor de monitoreo (192.168.1.51).
   Este recordatorio es de una sola vez y ya se elimino del crontab.
"""

def main() -> int:
    env = leer_env()
    remitente = env.get("EMAIL_FROM", "")
    clave = env.get("EMAIL_PASS", "")
    host = env.get("SMTP_HOST", "smtp.gmail.com")
    puerto = int(env.get("SMTP_PORT", "587"))
    if not remitente or not clave:
        print("[recordatorio] faltan EMAIL_FROM/EMAIL_PASS en backend.env", file=sys.stderr)
        return 1

    # Se salta cualquier bandera: si no, "--prueba" acababa siendo el
    # destinatario y Gmail lo rechazaba con un 553.
    destino = next((a for a in sys.argv[1:] if not a.startswith("-")), PARA)
    asunto = "Pendiente: client_id propio de rclone (se retira durante 2026)"
    if "--prueba" in sys.argv:
        asunto = "[PRUEBA] " + asunto

    msg = MIMEText(CUERPO, "plain", "utf-8")
    msg["Subject"] = asunto
    msg["From"] = remitente
    msg["To"] = destino

    with smtplib.SMTP(host, puerto, timeout=30) as s:
        s.starttls()
        s.login(remitente, clave)
        s.send_message(msg)
    print(f"[recordatorio] enviado a {destino}")

    if "--prueba" in sys.argv:
        print("[recordatorio] modo prueba: no se toca el crontab")
        return 0

    # Se envio bien: quitarse del crontab para no repetirse el año que viene.
    # Solo se filtra la propia linea; las demas (incluida la de VANTIO) quedan.
    actual = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
    nuevo = [l for l in actual.splitlines() if MARCA not in l]
    subprocess.run(["crontab", "-"], input="\n".join(nuevo) + "\n", text=True, check=True)
    print("[recordatorio] linea de cron eliminada")
    return 0

if __name__ == "__main__":
    sys.exit(main())
