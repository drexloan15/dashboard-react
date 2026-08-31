@echo off
echo ========================================
echo   Dashboard Lexmark
echo ========================================

echo.
echo Que modo deseas usar?
echo   1 = Desarrollo  (npm run dev  - solo este equipo, sin build)
echo   2 = Produccion  (npm start    - acceso LAN, requiere build previo)
echo.
set /p MODO="Elige [1 o 2]: "

if "%MODO%"=="2" goto produccion

:desarrollo
echo.
echo [1/2] Iniciando backend FastAPI (puerto 8001)...
start "Backend FastAPI" cmd /k "cd /d "%~dp0backend" && python main.py"
echo Esperando 8 segundos...
timeout /t 8 /nobreak > nul
echo [2/2] Iniciando frontend Next.js DEV (puerto 3000)...
start "Frontend Next.js DEV" cmd /k "cd /d "%~dp0" && npm run dev"
echo.
echo Abre: http://localhost:3000
goto fin

:produccion
echo.
echo Necesitas haber ejecutado "npm run build" antes.
echo Si es la primera vez o hubo cambios, ejecuta build ahora? [S/N]
set /p BUILD="[S/N]: "
if /i "%BUILD%"=="S" (
    echo Construyendo...
    call npm run build
    if %errorlevel% neq 0 (
        echo ERROR en el build. Revisa los mensajes.
        pause
        exit /b 1
    )
)
echo.
echo [1/2] Iniciando backend FastAPI (puerto 8001)...
start "Backend FastAPI" cmd /k "cd /d "%~dp0backend" && python main.py"
echo Esperando 8 segundos...
timeout /t 8 /nobreak > nul
echo [2/2] Iniciando frontend Next.js PRODUCCION (puerto 3000)...
start "Frontend Next.js PROD" cmd /k "cd /d "%~dp0" && npm start"
echo.
rem La IP LAN se detecta sola: estaba fija en 192.168.1.152, que dejo de ser
rem la de esta maquina. Se pregunta por que interfaz se sale a la red.
set "LANIP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Find-NetRoute -RemoteIPAddress 8.8.8.8)[0].IPAddress" 2^>nul`) do set "LANIP=%%i"
echo ========================================
echo   Acceso local : http://localhost:3000
if defined LANIP (
  echo   Acceso LAN   : http://%LANIP%:3000
) else (
  echo   Acceso LAN   : no se pudo detectar la IP de esta maquina
)
echo ========================================

:fin
echo.
pause
