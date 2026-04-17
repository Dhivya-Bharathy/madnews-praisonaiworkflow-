import OpenAI from "openai";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS || 800);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 9000);
const MODEL_MAX_POINTS_PER_SIDE = Number(process.env.MODEL_MAX_POINTS_PER_SIDE || 4);

const leftOutlets = [
  { name: "ThePrint", domain: "theprint.in" },
  { name: "The Wire", domain: "thewire.in" },
  { name: "Scroll.in", domain: "scroll.in" },
  { name: "The News Minute", domain: "thenewsminute.com" },
];

const rightOutlets = [
  { name: "Zee News", domain: "zeenews.india.com" },
  { name: "Republic", domain: "republicworld.com" },
  { name: "TimesNow", domain: "timesnownews.com" },
  { name: "Aaj Tak", domain: "aajtak.in" },
  { name: "OpIndia", domain: "opindia.com" },
  { name: "Swarajya", domain: "swarajyamag.com" },
  { name: "Panchjanya", domain: "panchjanya.com" },
];

const knownDomains = new Set(
  [...leftOutlets, ...rightOutlets].map((outlet) => outlet.domain)
);

const trustedCenterDomains = new Set([
  "ndtv.com",
  "indianexpress.com",
  "thehindu.com",
  "hindustantimes.com",
  "timesofindia.indiatimes.com",
  "economictimes.indiatimes.com",
  "livemint.com",
  "business-standard.com",
  "thehindubusinessline.com",
  "newindianexpress.com",
  "deccanherald.com",
  "financialexpress.com",
  "news18.com",
  "firstpost.com",
  "aninews.in",
  "ddnews.gov.in",
  "theweek.in",
  "outlookindia.com",
  "telegraphindia.com",
  "indiatoday.in",
  "india.com",
  "wionews.com",
  "moneycontrol.com",
  "dnaindia.com",
  "indiatv.in",
  "freepressjournal.in",
  "tribuneindia.com",
  "siasat.com",
  "thequint.com",
]);

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

function toSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function getHostFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isDomainOrSubdomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isLowQualityArticleTitle(title) {
  const t = String(title || "").trim().toLowerCase();
  if (!t) return true;
  return (
    /\barchives\b/.test(t) ||
    /\btags?\s*:/.test(t) ||
    /^category\s*:/.test(t) ||
    /\blive blog\b/.test(t) ||
    /^economy archives/.test(t) ||
    /^politics archives/.test(t) ||
    t.endsWith(" - archive") ||
    t.endsWith(" archives")
  );
}

function isAcceptableCenterHost(host) {
  if (!host || knownDomains.has(host)) return false;
  for (const domain of trustedCenterDomains) {
    if (isDomainOrSubdomain(host, domain)) return true;
  }
  return (
    host.endsWith(".in") ||
    host.endsWith(".co.in") ||
    isDomainOrSubdomain(host, "indiatimes.com")
  );
}

function mapArticle(article, fallbackOutlet) {
  return {
    outlet: fallbackOutlet || article.source?.name || "Unknown",
    title: article.title || "Untitled",
    url: article.url || "",
    publishedAt: article.publishedAt || "",
  };
}

function pickTopArticles(items, maxItems = 12) {
  return (items || [])
    .filter((item) => item && item.title && item.url && !isLowQualityArticleTitle(item.title))
    .slice(0, maxItems);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNewsApiByDomains(query, outletList) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const domains = outletList.map((outlet) => outlet.domain).join(",");
  const byDomain = new Map(outletList.map((o) => [o.domain, o.name]));
  const outletDomains = new Set(outletList.map((o) => o.domain));

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("domains", domains);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "25");
  url.searchParams.set("apiKey", key);

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return [];
    const data = await response.json();
    if (data?.status === "error") return [];
    const articles = Array.isArray(data.articles) ? data.articles : [];
    return pickTopArticles(
      articles
        .filter((article) => outletDomains.has(getHostFromUrl(article?.url)))
        .map((article) => {
          const domain = getHostFromUrl(article?.url);
          return mapArticle(article, byDomain.get(domain));
        }),
      12
    );
  } catch {
    return [];
  }
}

async function fetchCenterNews(query) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", `${query} India`);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "40");
  url.searchParams.set("apiKey", key);

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return [];
    const data = await response.json();
    if (data?.status === "error") return [];
    const articles = Array.isArray(data.articles) ? data.articles : [];
    return pickTopArticles(
      articles
        .filter((article) => {
          const host = getHostFromUrl(article?.url);
          return host && isAcceptableCenterHost(host);
        })
        .map((article) => mapArticle(article)),
      14
    );
  } catch {
    return [];
  }
}

function slimArticlesForModel(groupedArticles) {
  const trimSide = (sideItems = []) =>
    sideItems.slice(0, MODEL_MAX_POINTS_PER_SIDE).map((item) => ({
      outlet: item.outlet,
      title: item.title,
      url: item.url,
    }));
  return {
    LEFT: trimSide(groupedArticles.LEFT),
    CENTER: trimSide(groupedArticles.CENTER),
    RIGHT: trimSide(groupedArticles.RIGHT),
  };
}

function buildAnalysisPrompt(searchQuery, groupedArticles) {
  const sourceCatalog = {
    LEFT: (groupedArticles.LEFT || []).map((item) => `${item.outlet} - ${item.title}`),
    CENTER: (groupedArticles.CENTER || []).map((item) => `${item.outlet} - ${item.title}`),
    RIGHT: (groupedArticles.RIGHT || []).map((item) => `${item.outlet} - ${item.title}`),
  };

  return `
You are an expert Indian current affairs analyst.
Analyze only current Indian context for the user query.

User query: "${searchQuery}"

Instructions:
1) Return up to 5 concise points for LEFT, CENTER, RIGHT.
2) Use only the supplied article data.
3) For each point include source, and source must be one exact value from allowed source strings.
4) Return strict valid JSON only.

Fetched articles:
${JSON.stringify(groupedArticles, null, 2)}

Allowed source strings:
${JSON.stringify(sourceCatalog, null, 2)}

Output schema:
{
  "search_query": "${searchQuery}",
  "LEFT": [{"point":"...","source":"..."}],
  "CENTER": [{"point":"...","source":"..."}],
  "RIGHT": [{"point":"...","source":"..."}],
  "BLIND_SPOTS": {
    "LEFT_IGNORES": [],
    "RIGHT_IGNORES": [],
    "CENTER_IGNORES": []
  }
}`;
}

function normalizeSourceForMatch(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/\s+/g, " ");
}

function buildAllowedSources(groupedArticles) {
  const sideSources = {
    LEFT: new Set(),
    CENTER: new Set(),
    RIGHT: new Set(),
  };
  for (const side of ["LEFT", "CENTER", "RIGHT"]) {
    for (const article of groupedArticles[side] || []) {
      if (article?.outlet && article?.title) {
        sideSources[side].add(`${String(article.outlet)} - ${String(article.title)}`);
      }
    }
  }
  return sideSources;
}

function filterPointsByAllowedSources(points, allowedSet) {
  if (!Array.isArray(points)) return [];
  const allowedArr = Array.from(allowedSet);
  const allowedNorm = new Set(allowedArr.map(normalizeSourceForMatch));
  return points.filter((pointObj) => {
    const source = normalizeSourceForMatch(pointObj?.source || "");
    return allowedNorm.has(source);
  });
}

function normalizePoints(points) {
  const seen = new Set();
  const cleaned = [];
  for (const item of points || []) {
    const point = String(item?.point || "").trim();
    const source = String(item?.source || "").trim();
    if (!point || !source) continue;
    const key = `${point.toLowerCase()}::${source.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ point, source });
  }
  return cleaned.slice(0, 5);
}

function fallbackPointsFromArticles(articles) {
  const seen = new Set();
  const points = [];
  for (const article of articles || []) {
    const point = String(article?.title || "").trim();
    if (!point) continue;
    const source = `${String(article?.outlet || "").trim()} - ${point}`;
    const key = `${point.toLowerCase()}::${source.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ point, source });
    if (points.length >= 5) break;
  }
  return points;
}

export async function handler(event) {
  const query = String(event.queryStringParameters?.q || "").trim();
  const events = [];

  if (!query) {
    events.push(toSseEvent("error", { message: "Missing query parameter q" }));
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      body: events.join(""),
    };
  }

  if (!openai) {
    events.push(toSseEvent("error", { message: "Missing OPENAI_API_KEY in Netlify environment variables" }));
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      body: events.join(""),
    };
  }

  try {
    events.push(toSseEvent("status", { message: "Scanning left-leaning sources..." }));
    const leftPromise = fetchNewsApiByDomains(query, leftOutlets);

    events.push(toSseEvent("status", { message: "Gathering right-wing perspectives..." }));
    const rightPromise = fetchNewsApiByDomains(query, rightOutlets);

    events.push(toSseEvent("status", { message: "Checking neutral/center reports..." }));
    const centerPromise = fetchCenterNews(query);

    const [left, right, center] = await Promise.all([leftPromise, rightPromise, centerPromise]);
    const groupedArticles = { LEFT: left, CENTER: center, RIGHT: right };

    if (!left.length && !center.length && !right.length) {
      const emptyPayload = {
        search_query: query,
        LEFT: [],
        CENTER: [],
        RIGHT: [],
        BLIND_SPOTS: {
          LEFT_IGNORES: [],
          CENTER_IGNORES: [],
          RIGHT_IGNORES: [],
        },
        meta: { no_coverage: true, empty_reason: "no_outlet_articles" },
      };
      events.push(toSseEvent("result", emptyPayload));
      events.push(toSseEvent("done", { cached: false }));
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        body: events.join(""),
      };
    }

    events.push(toSseEvent("status", { message: "Analyzing bias patterns..." }));
    const prompt = buildAnalysisPrompt(query, slimArticlesForModel(groupedArticles));
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: OPENAI_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content: "Return strictly valid JSON and no additional prose.",
        },
        { role: "user", content: prompt },
      ],
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const repaired = content
        .slice(content.indexOf("{"))
        .slice(0, content.lastIndexOf("}") + 1);
      parsed = JSON.parse(repaired);
    }

    parsed.BLIND_SPOTS = parsed.BLIND_SPOTS || {};
    parsed.BLIND_SPOTS.LEFT_IGNORES = parsed.BLIND_SPOTS.LEFT_IGNORES || [];
    parsed.BLIND_SPOTS.RIGHT_IGNORES = parsed.BLIND_SPOTS.RIGHT_IGNORES || [];
    parsed.BLIND_SPOTS.CENTER_IGNORES = parsed.BLIND_SPOTS.CENTER_IGNORES || [];
    parsed.LEFT = Array.isArray(parsed.LEFT) ? parsed.LEFT : [];
    parsed.CENTER = Array.isArray(parsed.CENTER) ? parsed.CENTER : [];
    parsed.RIGHT = Array.isArray(parsed.RIGHT) ? parsed.RIGHT : [];

    const allowedSources = buildAllowedSources(groupedArticles);
    parsed.LEFT = normalizePoints(filterPointsByAllowedSources(parsed.LEFT, allowedSources.LEFT));
    parsed.CENTER = normalizePoints(filterPointsByAllowedSources(parsed.CENTER, allowedSources.CENTER));
    parsed.RIGHT = normalizePoints(filterPointsByAllowedSources(parsed.RIGHT, allowedSources.RIGHT));

    if (parsed.LEFT.length === 0 && groupedArticles.LEFT.length > 0) {
      parsed.LEFT = fallbackPointsFromArticles(groupedArticles.LEFT);
    }
    if (parsed.CENTER.length === 0 && groupedArticles.CENTER.length > 0) {
      parsed.CENTER = fallbackPointsFromArticles(groupedArticles.CENTER);
    }
    if (parsed.RIGHT.length === 0 && groupedArticles.RIGHT.length > 0) {
      parsed.RIGHT = fallbackPointsFromArticles(groupedArticles.RIGHT);
    }

    events.push(toSseEvent("result", parsed));
    events.push(toSseEvent("done", { cached: false }));
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      body: events.join(""),
    };
  } catch (error) {
    events.push(
      toSseEvent("error", {
        message: error instanceof Error ? error.message : "Unknown error",
      })
    );
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      body: events.join(""),
    };
  }
}
