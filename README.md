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

Netlify: run the Python service on any reachable host (Railway, Fly, VPS) and set `PRAISON_SERVICE_URL` plus `PRAISON_FETCH_TIMEOUT_MS` if needed (default 45000).
