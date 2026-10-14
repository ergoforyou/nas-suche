@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Chatterbox – lokale Sprachausgabe einrichten
rem ---------------------------------------------------------------------------
rem  Richtet den lokalen Sprach-Server "Chatterbox TTS Server" ein
rem  (https://github.com/devnen/Chatterbox-TTS-Server, MIT-Lizenz).
rem  Benoetigt eine NVIDIA-Grafikkarte. Einmaliger Download: einige GB.
rem ---------------------------------------------------------------------------
set "ZIEL=%LOCALAPPDATA%\Chatterbox-TTS-Server"

echo.
echo  Chatterbox wird eingerichtet in:
echo    %ZIEL%
echo.
echo  Das dauert beim ersten Mal 10-20 Minuten (Python, PyTorch mit CUDA, Modell).
echo.
pause

rem --- Git -------------------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo Git wird installiert ...
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
)
where git >nul 2>nul || (echo Git konnte nicht installiert werden. Bitte von https://git-scm.com installieren. & goto :fehler)

rem --- uv (stellt Python 3.10 bereit, ohne das System-Python zu veraendern) ----
where uv >nul 2>nul
if errorlevel 1 (
  echo uv wird installiert ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)
where uv >nul 2>nul || (echo uv konnte nicht installiert werden. & goto :fehler)
uv python install 3.10 || goto :fehler

rem --- Programm holen ---------------------------------------------------------
if not exist "%ZIEL%\server.py" (
  git clone --depth 1 https://github.com/devnen/Chatterbox-TTS-Server.git "%ZIEL%" || goto :fehler
) else (
  echo Vorhandene Installation wird aktualisiert ...
  git -C "%ZIEL%" pull --ff-only
)

rem --- Passende CUDA-Variante waehlen (RTX 50xx braucht CUDA 12.8) -------------
set "VARIANTE=--nvidia"
nvidia-smi --query-gpu=name --format=csv,noheader 2>nul | findstr /i /c:"RTX 50" >nul && set "VARIANTE=--nvidia-cu128"
echo Grafikkarten-Variante: %VARIANTE%
echo %VARIANTE%> "%ZIEL%\.ki-assistent-variante"

rem --- Einrichten und starten (das Start-Skript des Projekts installiert alles) -
cd /d "%ZIEL%"
for /f "delims=" %%P in ('uv python find 3.10') do set "PY310=%%P"
echo.
echo Installation laeuft. Wenn der Server bereit ist, erscheint "Uvicorn running on http://...:8004".
echo Danach im KI-Assistenten: Einstellungen - Sprache - Engine "Chatterbox" - "Mehrsprachiges Modell aktivieren".
echo Dieses Fenster offen lassen, solange die Sprachausgabe genutzt wird.
echo.
"%PY310%" start.py %VARIANTE%
goto :eof

:fehler
echo.
echo Die Einrichtung ist fehlgeschlagen. Bitte die Meldungen oben pruefen.
pause
exit /b 1
