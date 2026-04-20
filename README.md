# madnews

Bias-style perspectives (LEFT / CENTER / RIGHT) over Indian outlets, with blind-spot hints.

## Run locally

```bash
npm install
# Create .env with OPENAI_API_KEY, NEWS_API_KEY, optional OPENAI_MODEL, PORT
npm run dev
```

Open `http://localhost:3000` (or the port in `PORT`).

## Optional: Praison news collector

When `PRAISON_SERVICE_URL` is set (e.g. `http://127.0.0.1:8790`), the Node server **merges** extra articles from a small Python service that uses **DuckDuckGo search** plus a **Praison `Agent`** pass to curate JSON (same `OPENAI_API_KEY` as the rest of the stack).

```bash
cd praison-news
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
set OPENAI_API_KEY=...          # Windows cmd
python -m uvicorn app:app --host 127.0.0.1 --port 8790
```

In another terminal, from the repo root:

```bash
set PRAISON_SERVICE_URL=http://127.0.0.1:8790
npm run dev
```

### Same behavior on Netlify as localhost

Netlify runs only the **static site + Node functions**. It **cannot** see `http://127.0.0.1:8790` on your laptop.

1. In **Netlify → Site configuration → Environment variables**, set the **same** values you use locally (see `.env.example`):
   - `OPENAI_API_KEY`, `NEWS_API_KEY`, `OPENAI_MODEL` (optional), `OPENAI_MAX_TOKENS`, `FETCH_TIMEOUT_MS`, `ARTICLE_MAX_AGE_DAYS` (optional)
2. If you use Praison locally, **deploy `praison-news` somewhere public** (HTTPS), then set:
   - `PRAISON_SERVICE_URL` = that base URL, e.g. `https://your-praison-service.up.railway.app` (no trailing slash)
   - `PRAISON_FETCH_TIMEOUT_MS` if the collector is slow (default `45000`)

**Deploy Praison with Docker** (Railway, Fly.io, Render, Google Cloud Run, etc.):

```bash
cd praison-news
docker build -t madnews-praison .
docker run -e OPENAI_API_KEY=... -e OPENAI_MODEL=gpt-4o-mini -p 8790:8790 madnews-praison
```

The image runs `uvicorn` on `0.0.0.0` and respects the `PORT` env var hosts often inject.

After deploy, paste the **public origin** (scheme + host, no path) into Netlify as `PRAISON_SERVICE_URL`, trigger a new deploy, and analysis should match your local setup.

**502 on analyze after enabling Praison:** Netlify functions have a **short wall-clock limit** (often ~10s on free). The app **caps Praison calls to ~5s each** and **~7.5s total** for the three parallel requests when running as a Netlify function. If Render is cold-starting, Praison may add nothing that run—analysis still completes. For heavier Praison use, upgrade Netlify (longer function limit) or temporarily **remove `PRAISON_SERVICE_URL`** from Netlify to confirm the 502 was timeout-related.

### Phase 1 precompute mode

The Praison service now exposes `GET /v1/precomputed-topics` with a short in-memory cache (default 10 minutes via `PRAISON_PRECOMPUTE_TTL_SECONDS`).  
`/api/top-stories` in both local server and Netlify function reads this precomputed feed first, then falls back to the existing NewsAPI/RSS flow.
