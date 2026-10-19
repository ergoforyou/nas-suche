@echo off
REM Prueft Mikrofon, Schluessel, Erkennung, Tasten und Einfuegen
cd /d "%~dp0"
.venv\Scripts\python.exe -m diktierflow --selbsttest
