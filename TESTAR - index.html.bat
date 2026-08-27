@echo off
setlocal
title TESTAR - index.html
set "PORTA=8735"
set "PASTA=%~dp0"
if "%PASTA:~-1%"=="\" set "PASTA=%PASTA:~0,-1%"
set "PAGINA=index.html"

echo Iniciando servidor local em "%PASTA%" ...
start "ServidorTeste_%PORTA%" /D "%PASTA%" /min cmd /k "python -m http.server %PORTA%"

timeout /t 2 /nobreak >nul
start "" http://localhost:%PORTA%/%PAGINA%

echo.
echo Servidor rodando em http://localhost:%PORTA%/%PAGINA%
echo Pressione qualquer tecla nesta janela para PARAR o servidor e fechar.
pause >nul

taskkill /FI "WINDOWTITLE eq ServidorTeste_%PORTA%*" /T /F >nul 2>&1
echo Servidor parado.
timeout /t 1 /nobreak >nul
endlocal
