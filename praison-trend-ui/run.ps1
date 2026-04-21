Param(
  [string]$OpenAIKey = "",
  [string]$Model = "gpt-4o-mini",
  [int]$Port = 8780
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
  Write-Host "Creating virtual environment..."
  python -m venv .venv
}

Write-Host "Activating virtual environment..."
. ".\.venv\Scripts\Activate.ps1"

Write-Host "Installing dependencies..."
pip install -r requirements.txt | Out-Host

if ([string]::IsNullOrWhiteSpace($OpenAIKey)) {
  if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) {
    Write-Host ""
    Write-Host "OPENAI_API_KEY is missing." -ForegroundColor Yellow
    Write-Host "Run like:"
    Write-Host '  .\run.ps1 -OpenAIKey "sk-..."'
    Write-Host "Or set OPENAI_API_KEY in the environment / .env in this folder."
    exit 1
  }
} else {
  $env:OPENAI_API_KEY = $OpenAIKey
}

$env:OPENAI_MODEL = $Model

Write-Host "Starting server on http://127.0.0.1:$Port ..."
uvicorn app:app --host 127.0.0.1 --port $Port --reload
