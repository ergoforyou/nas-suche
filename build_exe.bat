@echo off
REM Erzeugt dist\DiktierFlow\DiktierFlow.exe (ohne Konsole)
cd /d "%~dp0"
call .venv\Scripts\pip install pyinstaller
call .venv\Scripts\pyinstaller --noconfirm --noconsole --name DiktierFlow ^
  --collect-all faster_whisper --collect-all ctranslate2 --collect-submodules uiautomation ^
  run_diktierflow.py
