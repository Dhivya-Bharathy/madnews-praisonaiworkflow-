# Praison News Studio (New Project)

Separate project that follows the Praison concept:

- discover latest links for a topic
- crawl each selected URL
- analyze with Praison Agent
- render in a simple UI

## Run locally

```bash
cd praison-trend-ui
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
set OPENAI_API_KEY=your_key
set OPENAI_MODEL=gpt-4o-mini
uvicorn app:app --host 127.0.0.1 --port 8780
```

Open: `http://127.0.0.1:8780`

Optional timeouts (seconds) if DuckDuckGo is slow: `PRAISON_DDGS_LATEST_TIMEOUT` (default 35), `PRAISON_DDGS_COLLECT_TIMEOUT` (45), `PRAISON_DDGS_MADNEWS_TOTAL_TIMEOUT` (120).

## One-click run (Windows)

PowerShell:

```powershell
cd praison-trend-ui
.\run.ps1 -OpenAIKey "sk-..." -Model "gpt-4o-mini" -Port 8780
```

CMD:

```cmd
cd praison-trend-ui
set OPENAI_API_KEY=sk-...
run.bat
```

## API

- `GET /api/latest-news?topic=...&limit=10`
- `POST /api/crawl-and-analyze` body: `{"topic":"...","url":"https://..."}` 

## Deploy

Use the included `Dockerfile` on Render/Railway/Fly.
