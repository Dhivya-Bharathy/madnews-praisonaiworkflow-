"""
Praison-powered news collection service for madnews.

- Uses DuckDuckGo text search for real URLs (works with OpenAI models).
- Uses praisonaiagents.Agent to curate / dedupe / filter into strict JSON.

Run: uvicorn app:app --host 127.0.0.1 --port 8790
Env: OPENAI_API_KEY (required for Agent), optional OPENAI_MODEL (default gpt-4o-mini)
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv
from ddgs import DDGS
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="madnews-praison-collector", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PRECOMPUTE_TTL_SECONDS = int(os.getenv("PRAISON_PRECOMPUTE_TTL_SECONDS", "600"))
PRECOMPUTE_BUILD_BUDGET_SECONDS = float(os.getenv("PRAISON_PRECOMPUTE_BUILD_BUDGET_SECONDS", "4.0"))
_cache_lock = threading.Lock()
_precomputed_topics_cache: dict[str, Any] = {
    "generatedAt": "",
    "expiresAtEpochMs": 0,
    "national": [],
    "geopolitical": [],
}


class CollectRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    perspective: str = Field("LEFT", max_length=12)
    domains: list[str] = Field(default_factory=list, max_length=24)
    max_items: int = Field(8, ge=1, le=14)


def _host(url: str) -> str:
    try:
        return urlparse(url).hostname.replace("www.", "") or ""
    except Exception:
        return ""


def ddg_collect(
    query: str,
    domains: list[str],
    per_query: int = 6,
    locale_suffix: str = "news India",
    deadline_epoch_s: float | None = None,
) -> list[dict[str, Any]]:
    """Gather candidate news rows from DuckDuckGo (no LLM)."""
    q = query.strip()
    if not q:
        return []
    queries: list[str] = []
    for d in (domains or [])[:8]:
        d = d.strip().lower()
        if d:
            queries.append(f"site:{d} {q}")
    queries.append(f"{q} {locale_suffix}".strip())
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    try:
        ddgs = DDGS()
        for sq in queries:
            if deadline_epoch_s and time.time() >= deadline_epoch_s:
                break
            try:
                for r in ddgs.text(sq, max_results=per_query):
                    if deadline_epoch_s and time.time() >= deadline_epoch_s:
                        break
                    href = (r.get("href") or r.get("url") or "").strip()
                    if not href.startswith("http"):
                        continue
                    if "wikipedia.org" in href or "facebook.com" in href or "twitter.com" in href:
                        continue
                    key = href.lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    title = (r.get("title") or "").strip()
                    if not title:
                        continue
                    host = _host(href)
                    out.append(
                        {
                            "title": title[:300],
                            "url": href,
                            "outlet": host or "Unknown",
                            "publishedAt": "",
                            "snippet": (r.get("body") or "")[:400],
                        }
                    )
            except Exception:
                continue
    except Exception:
        return out
    return out[:40]


def _dedupe_by_url_and_title(items: list[dict[str, Any]], max_items: int = 10) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in items or []:
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or "").strip()
        if not title or not url:
            continue
        key = f"{url.lower()}::{title.lower()}"
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "title": title[:300],
                "url": url,
                "outlet": str(item.get("outlet") or _host(url) or "Unknown").strip()[:120],
                "publishedAt": str(item.get("publishedAt") or "").strip(),
            }
        )
        if len(out) >= max_items:
            break
    return out


def _strip_json_array(text: str) -> list[dict[str, Any]]:
    if not text:
        return []
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
    except json.JSONDecodeError:
        return []
    return []


def curate_with_praison(
    query: str,
    perspective: str,
    candidates: list[dict[str, Any]],
    max_items: int,
) -> list[dict[str, Any]]:
    from praisonaiagents import Agent

    if not candidates:
        return []
    if not (os.getenv("OPENAI_API_KEY") or "").strip():
        return candidates[:max_items]

    slim = [
        {"title": c.get("title"), "url": c.get("url"), "outlet": c.get("outlet"), "snippet": c.get("snippet", "")[:200]}
        for c in candidates[:25]
    ]
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    agent = Agent(
        name="NewsCurator",
        instructions=(
            "You curate news article candidates for a bias-mapping app. "
            "You MUST only keep items whose `url` appears exactly in the provided candidate list. "
            "Drop duplicates, obvious non-articles (forums, social, tag pages), and items not plausibly about the user topic. "
            "Output a single JSON array (no markdown fences) of objects: "
            '[{"title":"...","url":"https://...","outlet":"hostname or outlet name","publishedAt":""}] '
            f"Max {max_items} items. Perspective label ({perspective}) is for framing only—do not invent URLs."
        ),
        model=model,
    )
    prompt = (
        f'User topic: "{query}"\n'
        f"Perspective bucket: {perspective}\n"
        "Candidates (JSON):\n"
        + json.dumps(slim, ensure_ascii=False)
    )
    raw = agent.run(prompt, output="silent")
    curated = _strip_json_array(str(raw))
    allowed = {c.get("url", "").strip() for c in candidates if c.get("url")}
    cleaned: list[dict[str, Any]] = []
    for row in curated:
        url = str(row.get("url") or "").strip()
        if url not in allowed:
            continue
        title = str(row.get("title") or "").strip()
        if not title:
            continue
        cleaned.append(
            {
                "title": title[:300],
                "url": url,
                "outlet": str(row.get("outlet") or _host(url) or "Unknown").strip()[:120],
                "publishedAt": str(row.get("publishedAt") or "").strip(),
            }
        )
        if len(cleaned) >= max_items:
            break
    return cleaned if cleaned else candidates[:max_items]


def _build_precomputed_topics() -> dict[str, Any]:
    """Low-latency cached feed for homepage cards."""
    deadline = time.time() + PRECOMPUTE_BUILD_BUDGET_SECONDS
    national_queries = [
        "India parliament election policy latest news",
        "India one nation one election latest updates",
        "Waqf amendment bill India latest",
    ]
    geopolitical_queries = [
        "India foreign policy geopolitics latest news",
        "India China border diplomatic latest",
        "UN Gaza Ukraine geopolitics latest",
    ]

    national_rows: list[dict[str, Any]] = []
    for q in national_queries:
        if time.time() >= deadline:
            break
        national_rows.extend(
            ddg_collect(q, [], per_query=6, locale_suffix="news India", deadline_epoch_s=deadline)
        )

    geopolitical_rows: list[dict[str, Any]] = []
    for q in geopolitical_queries:
        if time.time() >= deadline:
            break
        geopolitical_rows.extend(
            ddg_collect(q, [], per_query=6, locale_suffix="news", deadline_epoch_s=deadline)
        )

    national = _dedupe_by_url_and_title(national_rows, 10)
    geopolitical = _dedupe_by_url_and_title(geopolitical_rows, 10)
    now_ms = int(time.time() * 1000)
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ms / 1000)),
        "expiresAtEpochMs": now_ms + PRECOMPUTE_TTL_SECONDS * 1000,
        "national": national,
        "geopolitical": geopolitical,
    }


def get_precomputed_topics(force_refresh: bool = False) -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    with _cache_lock:
        expires = int(_precomputed_topics_cache.get("expiresAtEpochMs") or 0)
        has_data = bool(_precomputed_topics_cache.get("national") or _precomputed_topics_cache.get("geopolitical"))
        if not force_refresh and has_data and now_ms < expires:
            return {
                "generatedAt": _precomputed_topics_cache.get("generatedAt", ""),
                "national": list(_precomputed_topics_cache.get("national") or []),
                "geopolitical": list(_precomputed_topics_cache.get("geopolitical") or []),
                "cached": True,
            }
        fresh = _build_precomputed_topics()
        _precomputed_topics_cache.update(fresh)
    return {
        "generatedAt": fresh.get("generatedAt", ""),
        "national": list(fresh.get("national") or []),
        "geopolitical": list(fresh.get("geopolitical") or []),
        "cached": False,
    }


@app.get("/")
def root() -> dict[str, Any]:
    """Browser-friendly root: there is no HTML UI; use /health or POST /v1/collect."""
    return {
        "service": "madnews-praison-collector",
        "ok": True,
        "try": {
            "health": "/health",
            "collect": "POST /v1/collect (JSON body: query, perspective, domains, max_items)",
        },
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "praison-news"}


@app.get("/v1/precomputed-topics")
def precomputed_topics(refresh: bool = False) -> dict[str, Any]:
    """Cached topic cards endpoint for low-latency Netlify reads."""
    payload = get_precomputed_topics(force_refresh=refresh)
    return {
        "generatedAt": payload["generatedAt"],
        "national": payload["national"],
        "geopolitical": payload["geopolitical"],
        "meta": {"source": "praison-precompute-cache", "cached": payload["cached"]},
    }


@app.post("/v1/collect")
def collect(body: CollectRequest) -> dict[str, Any]:
    q = body.query.strip()
    if not q:
        raise HTTPException(400, "query required")
    perspective = body.perspective.strip().upper() or "LEFT"
    if perspective not in ("LEFT", "RIGHT", "CENTER", "ALL"):
        raise HTTPException(400, "perspective must be LEFT, RIGHT, CENTER, or ALL")
    domains = [d.strip().lower() for d in body.domains if d and d.strip()]
    raw = ddg_collect(q, domains, per_query=6)
    if not raw:
        return {"articles": [], "meta": {"source": "ddg", "note": "no_results"}}
    articles = curate_with_praison(q, perspective, raw, body.max_items)
    return {
        "articles": articles,
        "meta": {
            "source": "praison+ddg",
            "perspective": perspective,
            "candidate_count": len(raw),
        },
    }
