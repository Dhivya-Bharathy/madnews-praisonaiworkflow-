from __future__ import annotations

import json
import os
import re
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from ddgs import DDGS
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from praisonaiagents import Agent

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR.parent / ".env")
STATIC_DIR = BASE_DIR / "static"
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
FETCH_TIMEOUT = float(os.getenv("PRAISON_UI_FETCH_TIMEOUT_SECONDS", "12"))
FAST_MODE = os.getenv("PRAISON_FAST_MODE", "1").strip().lower() not in ("0", "false", "no")
# Prevent the UI from hanging forever when DuckDuckGo or the network stalls.
DDGS_LATEST_TIMEOUT = float(os.getenv("PRAISON_DDGS_LATEST_TIMEOUT", "35"))
DDGS_COLLECT_TIMEOUT = float(os.getenv("PRAISON_DDGS_COLLECT_TIMEOUT", "45"))
DDGS_MADNEWS_TOTAL_TIMEOUT = float(os.getenv("PRAISON_DDGS_MADNEWS_TOTAL_TIMEOUT", "120"))

LEFT_DOMAINS = [
    "theprint.in",
    "thewire.in",
    "scroll.in",
    "thenewsminute.com",
]
RIGHT_DOMAINS = [
    "zeenews.india.com",
    "republicworld.com",
    "timesnownews.com",
    "aajtak.in",
    "opindia.com",
    "swarajyamag.com",
    "panchjanya.com",
]
CENTER_DOMAINS = [
    "ndtv.com",
    "thehindu.com",
    "indianexpress.com",
    "hindustantimes.com",
    "timesofindia.indiatimes.com",
    "economictimes.indiatimes.com",
    "livemint.com",
    "business-standard.com",
    "deccanherald.com",
    "news18.com",
    "indiatoday.in",
]

app = FastAPI(title="Praison Trend UI", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    url: str = Field(..., min_length=6, max_length=1200)
    topic: str = Field(..., min_length=2, max_length=200)


def _host(url: str) -> str:
    try:
        return urlparse(url).hostname.replace("www.", "") or "unknown"
    except Exception:
        return "unknown"


def _strip_json_array(text: str) -> list[dict[str, Any]]:
    match = re.search(r"\[[\s\S]*\]", str(text or ""))
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    return [x for x in data if isinstance(x, dict)]


def _strip_json_object(text: str) -> dict[str, Any]:
    match = re.search(r"\{[\s\S]*\}", str(text or ""))
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def discover_news_candidates(topic: str, max_results: int = 30) -> list[dict[str, Any]]:
    q = f"{topic} latest news"
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    try:
        ddgs = DDGS()
        for row in ddgs.text(q, max_results=max_results):
            url = str(row.get("href") or row.get("url") or "").strip()
            title = str(row.get("title") or "").strip()
            if not url.startswith("http") or not title:
                continue
            if any(bad in url for bad in ("wikipedia.org", "youtube.com", "facebook.com", "twitter.com")):
                continue
            key = url.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "title": title[:300],
                    "url": url,
                    "outlet": _host(url),
                    "snippet": str(row.get("body") or "")[:350],
                }
            )
    except Exception:
        return out
    return out


def ddg_collect(topic: str, domains: list[str], per_query: int = 5) -> list[dict[str, Any]]:
    """Collect topic links with optional site filters for side buckets."""
    topic = str(topic or "").strip()
    if not topic:
        return []
    queries: list[str] = []
    # Cap domain fan-out; querying too many sites serially is the biggest latency source.
    max_domains = 4 if FAST_MODE else 8
    for d in (domains or [])[:max_domains]:
        d = str(d or "").strip().lower()
        if d:
            queries.append(f"site:{d} {topic} latest news")
    queries.append(f"{topic} latest news")

    ddgs = DDGS()
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for q in queries:
        try:
            for row in ddgs.text(q, max_results=per_query):
                url = str(row.get("href") or row.get("url") or "").strip()
                title = str(row.get("title") or "").strip()
                if not url.startswith("http") or not title:
                    continue
                if any(bad in url for bad in ("wikipedia.org", "youtube.com", "facebook.com", "twitter.com")):
                    continue
                key = url.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append(
                    {
                        "title": title[:300],
                        "url": url,
                        "outlet": _host(url),
                        "snippet": str(row.get("body") or "")[:350],
                    }
                )
        except Exception:
            continue
    return out[:24]


def curate_with_praison(topic: str, candidates: list[dict[str, Any]], max_items: int = 10) -> list[dict[str, Any]]:
    if not candidates:
        return []
    if FAST_MODE:
        return candidates[:max_items]
    if not (os.getenv("OPENAI_API_KEY") or "").strip():
        return candidates[:max_items]

    agent = Agent(
        name="LatestNewsCurator",
        instructions=(
            "You are a strict news curator. Keep only relevant, likely recent, meaningful news links "
            "for the given topic. Use only provided candidate URLs. No URL invention. "
            "Output strict JSON array only: "
            '[{"title":"...","url":"https://...","outlet":"...","why":"short reason"}].'
        ),
        model=MODEL,
    )
    prompt = (
        f'Topic: "{topic}"\n'
        f"Pick best {max_items} links.\n"
        "Candidate links JSON:\n"
        + json.dumps(candidates[:30], ensure_ascii=False)
    )
    try:
        raw = agent.run(prompt)
    except Exception:
        return candidates[:max_items]
    curated = _strip_json_array(raw)
    allowed = {c["url"] for c in candidates if c.get("url")}
    out: list[dict[str, Any]] = []
    for item in curated:
        url = str(item.get("url") or "").strip()
        title = str(item.get("title") or "").strip()
        if not url or url not in allowed or not title:
            continue
        out.append(
            {
                "title": title[:300],
                "url": url,
                "outlet": str(item.get("outlet") or _host(url))[:120],
                "why": str(item.get("why") or "").strip()[:200],
            }
        )
        if len(out) >= max_items:
            break
    return out if out else candidates[:max_items]


def fetch_page_text(url: str) -> str:
    try:
        response = requests.get(
            url,
            timeout=FETCH_TIMEOUT,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        text = " ".join(soup.get_text(" ").split())
        return text[:10000]
    except Exception:
        return ""


def analyze_article_with_praison(topic: str, url: str, article_text: str) -> dict[str, Any]:
    if not article_text:
        return {
            "summary": "Could not read article content. Try another link.",
            "key_points": [],
            "bias_signals": [],
            "stance": "unknown",
        }
    if not (os.getenv("OPENAI_API_KEY") or "").strip():
        return {
            "summary": article_text[:350] + "...",
            "key_points": [],
            "bias_signals": [],
            "stance": "unknown",
        }

    agent = Agent(
        name="NewsCrawlerAnalyst",
        instructions=(
            "You analyze crawled article text for quick newsroom intelligence. "
            "Output strict JSON only with keys: summary (string), key_points (array of max 5), "
            "bias_signals (array of max 4), stance (left|center|right|mixed|unknown)."
        ),
        model=MODEL,
    )
    prompt = (
        f'Topic: "{topic}"\n'
        f"URL: {url}\n"
        "Article text (possibly truncated):\n"
        f"{article_text}\n"
    )
    try:
        raw = agent.run(prompt)
    except Exception:
        return {
            "summary": article_text[:350] + "...",
            "key_points": [],
            "bias_signals": [],
            "stance": "unknown",
        }
    data = _strip_json_object(raw)
    return {
        "summary": str(data.get("summary") or "").strip()[:800] or "No summary returned.",
        "key_points": [
            str(x).strip() for x in (data.get("key_points") or []) if str(x).strip()
        ][:5],
        "bias_signals": [
            str(x).strip() for x in (data.get("bias_signals") or []) if str(x).strip()
        ][:4],
        "stance": str(data.get("stance") or "unknown").strip().lower()[:20],
    }


def summarize_side_with_praison(topic: str, side: str, articles: list[dict[str, Any]]) -> dict[str, Any]:
    articles = articles[:8]
    if not articles:
        return {
            "summary": f"No usable {side} articles found for this topic.",
            "key_points": [],
            "stance": side.lower(),
        }
    if FAST_MODE or not (os.getenv("OPENAI_API_KEY") or "").strip():
        return {
            "summary": f"{side} side based on current links.",
            "key_points": [a.get("title", "") for a in articles[:4] if a.get("title")],
            "stance": side.lower(),
        }
    agent = Agent(
        name=f"{side}NarrativeSummarizer",
        instructions=(
            "You summarize a side's narrative from provided article headlines/snippets only. "
            "Return strict JSON object with keys: summary (string), key_points (array max 5), stance (string)."
        ),
        model=MODEL,
    )
    prompt = (
        f'Topic: "{topic}"\n'
        f"Side bucket: {side}\n"
        "Articles JSON:\n"
        + json.dumps(articles, ensure_ascii=False)
    )
    try:
        raw = agent.run(prompt)
        data = _strip_json_object(raw)
        return {
            "summary": str(data.get("summary") or "").strip()[:800] or f"{side} narrative unavailable.",
            "key_points": [
                str(x).strip() for x in (data.get("key_points") or []) if str(x).strip()
            ][:5],
            "stance": str(data.get("stance") or side).strip().lower()[:20],
        }
    except Exception:
        return {
            "summary": f"{side} side based on available links.",
            "key_points": [a.get("title", "") for a in articles[:4] if a.get("title")],
            "stance": side.lower(),
        }


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/static/{path:path}")
def static_files(path: str) -> FileResponse:
    file_path = STATIC_DIR / path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Static file not found")
    return FileResponse(file_path)


@app.get("/api/latest-news")
def latest_news(topic: str = "AI news", limit: int = 10) -> dict[str, Any]:
    topic = topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic is required")
    limit = max(3, min(limit, 12))
    max_results = 20 if FAST_MODE else 36
    ddg_timed_out = False
    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(discover_news_candidates, topic, max_results)
        try:
            candidates = fut.result(timeout=DDGS_LATEST_TIMEOUT)
        except concurrent.futures.TimeoutError:
            candidates = []
            ddg_timed_out = True
    curated = curate_with_praison(topic, candidates, max_items=limit)
    return {
        "topic": topic,
        "articles": curated,
        "meta": {
            "candidate_count": len(candidates),
            "source": "ddgs-fast" if FAST_MODE else "ddgs+praison",
            "ddg_timeout": ddg_timed_out,
        },
    }


@app.post("/api/crawl-and-analyze")
def crawl_and_analyze(body: AnalyzeRequest) -> dict[str, Any]:
    url = body.url.strip()
    topic = body.topic.strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="Invalid URL")
    text = fetch_page_text(url)
    analysis = analyze_article_with_praison(topic, url, text)
    return {
        "topic": topic,
        "url": url,
        "outlet": _host(url),
        "analysis": analysis,
        "meta": {"crawl_chars": len(text), "source": "crawl+praison"},
    }


def _madnews_three_sides_body(topic: str, per_q: int, max_items: int) -> dict[str, Any]:
    def _safe_result(fut: Any, default: list[Any]) -> list[Any]:
        try:
            return fut.result(timeout=DDGS_COLLECT_TIMEOUT)
        except (concurrent.futures.TimeoutError, Exception):
            return list(default)

    def _safe_summary(fut: Any, side: str, links: list[dict[str, Any]]) -> dict[str, Any]:
        try:
            return fut.result(timeout=30.0)
        except Exception:
            return {
                "summary": f"{side}: step timed out; titles below are from search only.",
                "key_points": [str(a.get("title") or "") for a in links[:5] if a.get("title")],
                "stance": side.lower(),
            }

    # 1) Gather side candidates concurrently.
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_left = ex.submit(ddg_collect, topic, LEFT_DOMAINS, per_q)
        f_center = ex.submit(ddg_collect, topic, CENTER_DOMAINS, per_q)
        f_right = ex.submit(ddg_collect, topic, RIGHT_DOMAINS, per_q)
        left_candidates = _safe_result(f_left, [])
        center_candidates = _safe_result(f_center, [])
        right_candidates = _safe_result(f_right, [])

    # 2) Curate side links concurrently.
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_left = ex.submit(curate_with_praison, topic, left_candidates, max_items)
        f_center = ex.submit(curate_with_praison, topic, center_candidates, max_items)
        f_right = ex.submit(curate_with_praison, topic, right_candidates, max_items)
        left_links = _safe_result(f_left, left_candidates[:max_items])
        center_links = _safe_result(f_center, center_candidates[:max_items])
        right_links = _safe_result(f_right, right_candidates[:max_items])

    # 3) Summarize side narratives concurrently.
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_left = ex.submit(summarize_side_with_praison, topic, "LEFT", left_links)
        f_center = ex.submit(summarize_side_with_praison, topic, "CENTER", center_links)
        f_right = ex.submit(summarize_side_with_praison, topic, "RIGHT", right_links)
        left_summary = _safe_summary(f_left, "LEFT", left_links)
        center_summary = _safe_summary(f_center, "CENTER", center_links)
        right_summary = _safe_summary(f_right, "RIGHT", right_links)

    return {
        "topic": topic,
        "LEFT": {"summary": left_summary, "links": left_links},
        "CENTER": {"summary": center_summary, "links": center_links},
        "RIGHT": {"summary": right_summary, "links": right_links},
        "meta": {"source": "ddgs+praison+madnews-buckets"},
    }


@app.get("/api/madnews-three-sides")
def madnews_three_sides(topic: str) -> dict[str, Any]:
    topic = topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic is required")

    per_q = 3 if FAST_MODE else 5
    max_items = 6 if FAST_MODE else 8

    empty_summary = {
        "summary": "Timed out or no data for this side.",
        "key_points": [],
        "stance": "unknown",
    }
    empty_payload: dict[str, Any] = {
        "topic": topic,
        "LEFT": {"summary": empty_summary, "links": []},
        "CENTER": {"summary": empty_summary, "links": []},
        "RIGHT": {"summary": empty_summary, "links": []},
        "meta": {"source": "timeout", "error": "madnews_total_timeout"},
    }

    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(_madnews_three_sides_body, topic, per_q, max_items)
        try:
            return fut.result(timeout=DDGS_MADNEWS_TOTAL_TIMEOUT)
        except concurrent.futures.TimeoutError:
            return empty_payload

