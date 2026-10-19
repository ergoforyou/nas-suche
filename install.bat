@echo off
REM DiktierFlow einrichten: virtuelle Umgebung + Abhaengigkeiten
cd /d "%~dp0"
where py >nul 2>nul || (echo Python 3.11+ fehlt: https://www.python.org/downloads/ & pause & exit /b 1)
if not exist .venv py -3 -m venv .venv
call .venv\Scripts\python -m pip install --upgrade pip
call .venv\Scripts\pip install -r requirements.txt
echo.
echo Fertig. Starten mit start.bat
pause
