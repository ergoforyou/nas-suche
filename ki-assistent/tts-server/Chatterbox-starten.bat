@echo off
chcp 65001 >nul
title Chatterbox – lokale Sprachausgabe
set "ZIEL=%LOCALAPPDATA%\Chatterbox-TTS-Server"
if not exist "%ZIEL%\server.py" (
  echo Chatterbox ist noch nicht eingerichtet. Bitte zuerst "Chatterbox-installieren.bat" ausfuehren.
  pause
  exit /b 1
)
set "VARIANTE=--nvidia"
if exist "%ZIEL%\.ki-assistent-variante" set /p VARIANTE=<"%ZIEL%\.ki-assistent-variante"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
for /f "delims=" %%P in ('uv python find 3.10') do set "PY310=%%P"
cd /d "%ZIEL%"
echo Chatterbox startet ... (Fenster offen lassen, solange die Sprachausgabe genutzt wird)
"%PY310%" start.py %VARIANTE%
