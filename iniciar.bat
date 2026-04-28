@echo off
echo ========================================
echo   Dashboard Lexmark - Iniciando...
echo ========================================

echo.
echo [1/2] Iniciando backend FastAPI (puerto 8000)...
start "Backend FastAPI" cmd /k "cd /d "%~dp0backend" && python main.py"

echo Esperando 3 segundos...
timeout /t 3 /nobreak > nul

echo.
echo [2/2] Iniciando frontend Next.js (puerto 3000)...
start "Frontend Next.js" cmd /k "cd /d "%~dp0" && npm run dev"

echo.
echo ========================================
echo   Abre: http://localhost:3000
echo ========================================
pause
