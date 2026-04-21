@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv" (
  echo Creating virtual environment...
  python -m venv .venv
)

call ".venv\Scripts\activate.bat"
echo Installing dependencies...
pip install -r requirements.txt

if "%OPENAI_API_KEY%"=="" (
  echo.
  echo OPENAI_API_KEY is missing.
  echo Set it first in this terminal:
  echo set OPENAI_API_KEY=sk-...
  echo Then run this file again.
  exit /b 1
)

if "%OPENAI_MODEL%"=="" set OPENAI_MODEL=gpt-4o-mini
echo Starting server — open http://127.0.0.1:8780/ or http://localhost:8780/
uvicorn app:app --host 0.0.0.0 --port 8780 --reload
