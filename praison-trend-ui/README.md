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
uvicorn app:app --host 0.0.0.0 --port 8780
```

Open: **`http://127.0.0.1:8780`** or **`http://localhost:8780`** (same UI). Use `0.0.0.0` so it matches Docker/cloud and works via your PC’s LAN IP.

Or: `python app.py` (reads `PORT` / `UVICORN_HOST` from env).

Optional timeouts (seconds) if DuckDuckGo is slow: `PRAISON_DDGS_LATEST_TIMEOUT` (default 35), `PRAISON_DDGS_COLLECT_TIMEOUT` (45), `PRAISON_DDGS_MADNEWS_TOTAL_TIMEOUT` (120).

**Politics-first scope (localhost + Render):** copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEWS_FOCUS` | `politics` | Search/curation bias toward Indian political news. Set to `general` for open-ended topics. |
| `DEFAULT_NEWS_TOPIC` | `Indian politics` | Default headline topic in the UI (also used if `topic` is omitted on `GET /api/latest-news`). |
| `PRAISON_FAST_MODE` | `1` | Faster DDG limits; Perspectives still fills narrative text from article titles/snippets when the API key is absent. |

The browser loads defaults from **`GET /api/config`** so production env vars control the topic field without rebuilding static files.

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

## Deploy (match localhost UI)

On **Render** (or any host), the service must build from the **latest** commit of this repo’s `main` branch. If the site still shows an old button label (e.g. “Load Latest Stories”) or old status text, the deployment is **not** running the current `static/` files.

1. In the Render dashboard: **Manual Deploy → Clear build cache & deploy** (or equivalent).  
2. Confirm the service **Root directory** is the repo root (where `app.py` and `static/` live), not a parent monorepo folder.  
3. **Docker**: use the included `Dockerfile` (already uses `HOST 0.0.0.0` and `$PORT`).  
4. **Non-Docker** Web Service start command:  
   `uvicorn app:app --host 0.0.0.0 --port $PORT`  
5. After deploy: hard-refresh the browser (**Ctrl+Shift+R** / empty cache) once.

HTML/JS responses send **no-store** cache headers so the UI updates on the next deploy without an invisible old bundle.
