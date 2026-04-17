import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS || 800);
const CACHE_VERSION = "v8";
const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 9000);
const MODEL_MAX_POINTS_PER_SIDE = Number(process.env.MODEL_MAX_POINTS_PER_SIDE || 4);
const MIN_POINTS_FOR_BLIND_SPOTS = 2;

const blockedCenterDomains = new Set([
  "msn.com",
  "vajiramandravi.com",
  "testbook.com",
  "byjus.com",
  "jagranjosh.com",
  "wikipedia.org",
  "quora.com",
]);

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

const analysisCache = new Map();
const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function normalizeQuery(query) {
  return `${CACHE_VERSION}:${query.toLowerCase().trim().replace(/\s+/g, " ")}`;
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

function cleanupCache() {
  const now = Date.now();
  for (const [key, entry] of analysisCache.entries()) {
    if (entry.expiresAt <= now) {
      analysisCache.delete(key);
    }
  }
}

function mapArticle(article, fallbackOutlet) {
  return {
    outlet: fallbackOutlet || article.source?.name || "Unknown",
    title: article.title || "Untitled",
    description: article.description || "",
    url: article.url || "",
    publishedAt: article.publishedAt || "",
  };
}

function pickTopArticles(items, maxItems = 12) {
  return items
    .filter((item) => item && item.title && item.url)
    .slice(0, maxItems);
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

function isTrustedCenterDomain(host) {
  if (!host) return false;
  for (const domain of trustedCenterDomains) {
    if (isDomainOrSubdomain(host, domain)) return true;
  }
  return false;
}

/** Center / neutral: trusted major sites or Indian ccTLD (not left/right list). */
function isAcceptableCenterHost(host) {
  if (!host || isBlockedCenterHost(host) || knownDomains.has(host)) return false;
  return (
    isTrustedCenterDomain(host) ||
    host.endsWith(".in") ||
    host.endsWith(".co.in") ||
    isDomainOrSubdomain(host, "indiatimes.com")
  );
}

function isBlockedCenterHost(host) {
  if (!host) return true;
  for (const domain of blockedCenterDomains) {
    if (isDomainOrSubdomain(host, domain)) return true;
  }
  return false;
}

/** Drop section/index pages that look like real stories but are not. */
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

function filterArticleList(list) {
  return (list || []).filter(
    (a) =>
      a &&
      a.title &&
      a.url &&
      !isLowQualityArticleTitle(a.title)
  );
}

function decodeXml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeOutletName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseGoogleNewsRss(xml, fallbackOutlet = "Google News") {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemBlock = match[1];
    const titleMatch = itemBlock.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/);
    const linkMatch = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
    const pubMatch = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const sourceBlockMatch = itemBlock.match(/<source([^>]*)>([\s\S]*?)<\/source>/);
    const title = decodeXml((titleMatch?.[1] || titleMatch?.[2] || "").trim());
    const linkUrl = decodeXml((linkMatch?.[1] || "").trim());
    let sourceUrl = "";
    if (sourceBlockMatch) {
      const attrs = sourceBlockMatch[1];
      const urlAttr =
        attrs.match(/\burl="([^"]+)"/i) || attrs.match(/\burl='([^']+)'/i);
      if (urlAttr) {
        sourceUrl = decodeXml(urlAttr[1].trim());
      }
    }
    const outlet = decodeXml((sourceBlockMatch?.[2] || "").trim() || fallbackOutlet);
    // Prefer publisher URL from <source url="..."> so hostname checks work (Google link is news.google.com).
    const url = sourceUrl || linkUrl;
    if (title && url) {
      items.push({
        outlet,
        title,
        description: "",
        url,
        publishedAt: pubMatch?.[1] || "",
      });
    }
  }
  return items;
}

async function fetchGoogleNewsByDomains(query, outletList) {
  const siteQuery = outletList.map((outlet) => `site:${outlet.domain}`).join(" OR ");
  const q = `${query} India (${siteQuery}) when:7d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-IN&gl=IN&ceid=IN:en`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Google News RSS failed: ${response.status}`);
  }
  const xml = await response.text();
  const outletDomains = new Set(outletList.map((o) => o.domain));
  const byDomain = new Map(outletList.map((o) => [o.domain, o.name]));
  const allowedOutletNames = new Set(
    outletList.map((o) => normalizeOutletName(o.name))
  );
  return pickTopArticles(
    parseGoogleNewsRss(xml)
      .filter((item) => {
        const host = getHostFromUrl(item.url);
        const sourceName = normalizeOutletName(item.outlet);
        return outletDomains.has(host) || allowedOutletNames.has(sourceName);
      })
      .map((item) => {
        const host = getHostFromUrl(item.url);
        return {
          ...item,
          outlet:
            byDomain.get(host) ||
            outletList.find(
              (o) =>
                normalizeOutletName(o.name) === normalizeOutletName(item.outlet)
            )?.name ||
            item.outlet,
        };
      })
  );
}

async function fetchGoogleNewsCenter(query) {
  const q = `${query} India when:7d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-IN&gl=IN&ceid=IN:en`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Google News center RSS failed: ${response.status}`);
  }
  const xml = await response.text();
  return pickTopArticles(
    parseGoogleNewsRss(xml).filter((item) => {
      const host = getHostFromUrl(item.url);
      return (
        host &&
        !knownDomains.has(host) &&
        !isBlockedCenterHost(host) &&
        isAcceptableCenterHost(host) &&
        !isLowQualityArticleTitle(item?.title)
      );
    })
  );
}

/** India top-headlines: real publisher URLs, good when /everything is sparse. */
async function fetchNewsApiTopHeadlinesIndia(query, pageSize = 30) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const url = new URL("https://newsapi.org/v2/top-headlines");
  url.searchParams.set("country", "in");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("apiKey", key);
  if (query) url.searchParams.set("q", query);

  let articles = [];
  try {
    const response = await fetchWithTimeout(url);
    if (response.ok) {
      const data = await response.json();
      if (data?.status !== "error") {
        articles = Array.isArray(data.articles) ? data.articles : [];
      }
    }
  } catch {
    articles = [];
  }
  return pickTopArticles(
    articles
      .filter((article) => {
        const host = getHostFromUrl(article?.url);
        return host && isAcceptableCenterHost(host);
      })
      .map((article) => mapArticle(article, article.source?.name))
  );
}

async function fetchNewsApiEverything(query, pageSize = 60) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", `${query} India`);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("apiKey", key);

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return [];
    const data = await response.json();
    if (data?.status === "error") return [];
    return Array.isArray(data.articles) ? data.articles : [];
  } catch {
    return [];
  }
}

async function fetchNewsApiByDomains(query, outletList) {
  const key = process.env.NEWS_API_KEY;
  if (!key) {
    return fetchGoogleNewsByDomains(query, outletList);
  }

  const domains = outletList.map((outlet) => outlet.domain).join(",");
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("domains", domains);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "25");
  url.searchParams.set("apiKey", key);

  let articles = [];
  try {
    const response = await fetchWithTimeout(url);
    if (response.ok) {
      const data = await response.json();
      if (data?.status !== "error") {
        articles = Array.isArray(data.articles) ? data.articles : [];
      }
    }
  } catch {
    articles = [];
  }

  const byDomain = new Map(outletList.map((o) => [o.domain, o.name]));
  const outletDomains = new Set(outletList.map((o) => o.domain));

  const primary = pickTopArticles(
    articles
      .filter((article) => outletDomains.has(getHostFromUrl(article?.url)))
      .map((article) => {
        const domain = getHostFromUrl(article?.url);
        return mapArticle(article, byDomain.get(domain));
      })
  );

  if (primary.length >= 3) {
    return primary;
  }

  // Fallback 1: broad NewsAPI fetch then local domain filter.
  const fallbackArticles = await fetchNewsApiEverything(query, 80);
  const fromNewsApiBroad = pickTopArticles(
    fallbackArticles
      .filter((article) => outletDomains.has(getHostFromUrl(article?.url)))
      .map((article) => {
        const domain = getHostFromUrl(article?.url);
        return mapArticle(article, byDomain.get(domain));
      })
  );
  if (fromNewsApiBroad.length >= 3) {
    return fromNewsApiBroad;
  }

  // Fallback 2: free Google News RSS.
  return fetchGoogleNewsByDomains(query, outletList);
}

function mergeArticlesByUrl(primary, extra) {
  const seen = new Set((primary || []).map((a) => a.url).filter(Boolean));
  const out = [...(primary || [])];
  for (const a of extra || []) {
    if (a?.url && !seen.has(a.url)) {
      seen.add(a.url);
      out.push(a);
    }
  }
  return pickTopArticles(out, 24);
}

/** When domain-specific search is sparse, pull same outlets from a broad India query. */
async function enrichPartisanFromBroad(query, outletList, currentList, minItems = 2) {
  const cur = currentList || [];
  if (cur.length >= minItems) return cur;
  const broad = await fetchNewsApiEverything(`${query} India`, 50).catch(() => []);
  const domains = new Set(outletList.map((o) => o.domain));
  const byDomain = new Map(outletList.map((o) => [o.domain, o.name]));
  const extra = pickTopArticles(
    broad
      .filter((article) => domains.has(getHostFromUrl(article?.url)))
      .map((article) => {
        const domain = getHostFromUrl(article?.url);
        return mapArticle(article, byDomain.get(domain));
      })
  );
  return mergeArticlesByUrl(cur, extra);
}

async function fetchCenterNews(query) {
  const rawEverything = await fetchNewsApiEverything(query, 80).catch(() => []);
  const centerArticles = rawEverything.filter((article) => {
    const host = getHostFromUrl(article?.url);
    return (
      host &&
      isAcceptableCenterHost(host) &&
      !isLowQualityArticleTitle(article?.title)
    );
  });
  let picked = pickTopArticles(centerArticles.map((article) => mapArticle(article)));

  const headlines = await fetchNewsApiTopHeadlinesIndia(query, 40).catch(() => []);
  picked = mergeArticlesByUrl(picked, headlines);

  if (picked.length >= 10) {
    return pickTopArticles(picked, 14);
  }

  const rss = (await fetchGoogleNewsCenter(query).catch(() => [])).filter((item) => {
    const host = getHostFromUrl(item?.url);
    return (
      host &&
      isAcceptableCenterHost(host) &&
      !isLowQualityArticleTitle(item?.title)
    );
  });
  picked = mergeArticlesByUrl(picked, rss);
  return pickTopArticles(picked, 14);
}

function buildAnalysisPrompt(searchQuery, groupedArticles) {
  const sourceCatalog = {
    LEFT: (groupedArticles.LEFT || []).map((item) => `${item.outlet} - ${item.title}`),
    CENTER: (groupedArticles.CENTER || []).map(
      (item) => `${item.outlet} - ${item.title}`
    ),
    RIGHT: (groupedArticles.RIGHT || []).map((item) => `${item.outlet} - ${item.title}`),
  };

  return `
You are an expert Indian current affairs analyst.
You must analyze only current Indian context for the user query.

User query: "${searchQuery}"

LEFT-leaning outlets:
ThePrint, The Wire, Scroll.in, The News Minute
RIGHT-leaning outlets:
Zee News, Republic, TimesNow, Aaj Tak, OpIndia, Swarajya, Panchjanya
CENTER/Neutral:
Treat all other outlets as center.

Here are the fetched articles, grouped by perspective:
${JSON.stringify(groupedArticles, null, 2)}

Allowed source strings (must use exact value in output.source):
${JSON.stringify(sourceCatalog, null, 2)}

Instructions:
1) Organize output in three perspectives: LEFT, CENTER, RIGHT.
2) Extract up to top 5 key points per perspective.
3) Keep points concise, factual, and directly relevant to the query.
4) For each point include a source string.
4a) source must be an exact string from the allowed source strings list.
4b) Use ONLY facts present in the provided article lists. Do not infer unsupported claims.
4c) If a perspective has insufficient articles, return fewer points (or empty list) instead of making up points.
5) Identify blind spots:
   - LEFT_IGNORES (what left underreports)
   - RIGHT_IGNORES (what right underreports)
   - CENTER_IGNORES (what center underreports)
6) Focus on differences in framing, tone, and emphasis.
7) Avoid generic statements.
8) Do not fabricate numbers, dates, policy claims, or events.

Return ONLY valid JSON using this exact schema:
{
  "search_query": "${searchQuery}",
  "LEFT": [{"point":"...","source":"..."}],
  "CENTER": [{"point":"...","source":"..."}],
  "RIGHT": [{"point":"...","source":"..."}],
  "BLIND_SPOTS": {
    "LEFT_IGNORES": ["..."],
    "RIGHT_IGNORES": ["..."],
    "CENTER_IGNORES": ["..."]
  }
}
`;
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

function normalizeSourceForMatch(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/\s+/g, " ");
}

function filterPointsByAllowedSources(points, allowedSet) {
  if (!Array.isArray(points)) return [];
  const allowedArr = Array.from(allowedSet);
  const allowedNorm = new Set(allowedArr.map(normalizeSourceForMatch));
  return points.filter((pointObj) => {
    const source = normalizeSourceForMatch(pointObj?.source || "");
    if (allowedNorm.has(source)) return true;
    return allowedArr.some((line) => {
      const n = normalizeSourceForMatch(line);
      return n === source;
    });
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

/** Uses each article's real title + outlet (from NewsAPI / Google News RSS only). */
function fallbackPointsFromArticles(articles) {
  const seen = new Set();
  const points = [];
  for (const article of articles || []) {
    const point = String(article?.title || "").trim();
    if (!point) continue;
    const source = `${String(article?.outlet || "").trim()} - ${point}`;
    if (!point || !source.trim()) continue;
    const key = `${point.toLowerCase()}::${source.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ point, source });
    if (points.length >= 5) break;
  }
  return points;
}

app.get("/api/analyze-stream", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) {
    return res.status(400).json({ error: "Missing query parameter q" });
  }

  if (!openai) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY in .env" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    cleanupCache();
    const normalized = normalizeQuery(query);
    const cached = analysisCache.get(normalized);
    const hasCachedData =
      cached &&
      ((cached.data?.LEFT?.length || 0) +
        (cached.data?.CENTER?.length || 0) +
        (cached.data?.RIGHT?.length || 0) >
        0);
    if (cached && cached.expiresAt > Date.now() && hasCachedData) {
      sendSse(res, "status", { message: "Using recently cached analysis..." });
      sendSse(res, "result", cached.data);
      sendSse(res, "done", { cached: true });
      return res.end();
    }

    sendSse(res, "status", { message: "🕵️ Scanning left-leaning sources..." });
    const leftPromise = fetchNewsApiByDomains(query, leftOutlets).catch((error) => ({
      error: error.message,
      items: [],
    }));

    sendSse(res, "status", { message: "🕵️ Gathering right-wing perspectives..." });
    const rightPromise = fetchNewsApiByDomains(query, rightOutlets).catch((error) => ({
      error: error.message,
      items: [],
    }));

    sendSse(res, "status", { message: "🕵️ Checking neutral/center reports..." });
    const centerPromise = fetchCenterNews(query).catch((error) => ({
      error: error.message,
      items: [],
    }));

    const [leftRaw, rightRaw, centerRaw] = await Promise.all([
      leftPromise,
      rightPromise,
      centerPromise,
    ]);

    let left = filterArticleList(Array.isArray(leftRaw) ? leftRaw : leftRaw.items);
    let right = filterArticleList(Array.isArray(rightRaw) ? rightRaw : rightRaw.items);
    let center = filterArticleList(Array.isArray(centerRaw) ? centerRaw : centerRaw.items);

    const [leftEnriched, rightEnriched] = await Promise.all([
      enrichPartisanFromBroad(query, leftOutlets, left),
      enrichPartisanFromBroad(query, rightOutlets, right),
    ]);
    left = filterArticleList(leftEnriched);
    right = filterArticleList(rightEnriched);

    const sourceErrors = [leftRaw, rightRaw, centerRaw]
      .filter((result) => result && result.error)
      .map((result) => result.error);

    if (sourceErrors.length) {
      sendSse(res, "status", {
        message:
          "Some sources failed to load, continuing with available data...",
      });
    }

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
      sendSse(res, "status", {
        message: "No India-focused articles found for this topic.",
      });
      sendSse(res, "result", emptyPayload);
      sendSse(res, "done", { cached: false });
      return res.end();
    }

    const slimGroupedArticles = slimArticlesForModel(groupedArticles);

    sendSse(res, "status", { message: "🧠 Analyzing bias patterns..." });
    sendSse(res, "status", { message: "🔍 Cross-referencing narratives..." });

    const prompt = buildAnalysisPrompt(query, slimGroupedArticles);
    const stream = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: OPENAI_MAX_TOKENS,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are a precise analyst. Return strictly valid JSON and no additional prose.",
        },
        { role: "user", content: prompt },
      ],
    });

    let assembled = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        assembled += delta;
        sendSse(res, "chunk", { text: delta });
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(assembled);
    } catch {
      const repaired = assembled
        .slice(assembled.indexOf("{"))
        .slice(0, assembled.lastIndexOf("}") + 1);
      parsed = JSON.parse(repaired);
    }
    parsed.BLIND_SPOTS = parsed.BLIND_SPOTS || {};
    parsed.BLIND_SPOTS.LEFT_IGNORES = parsed.BLIND_SPOTS.LEFT_IGNORES || [];
    parsed.BLIND_SPOTS.RIGHT_IGNORES = parsed.BLIND_SPOTS.RIGHT_IGNORES || [];
    parsed.BLIND_SPOTS.CENTER_IGNORES = parsed.BLIND_SPOTS.CENTER_IGNORES || [];
    parsed.LEFT = Array.isArray(parsed.LEFT)
      ? parsed.LEFT
      : Array.isArray(parsed.left)
        ? parsed.left
        : [];
    parsed.CENTER = Array.isArray(parsed.CENTER)
      ? parsed.CENTER
      : Array.isArray(parsed.center)
        ? parsed.center
        : [];
    parsed.RIGHT = Array.isArray(parsed.RIGHT)
      ? parsed.RIGHT
      : Array.isArray(parsed.right)
        ? parsed.right
        : [];

    // Guardrail: keep only points whose source matches fetched outlets for that side.
    const allowedSources = buildAllowedSources(groupedArticles);
    parsed.LEFT = normalizePoints(filterPointsByAllowedSources(parsed.LEFT, allowedSources.LEFT));
    parsed.CENTER = normalizePoints(
      filterPointsByAllowedSources(parsed.CENTER, allowedSources.CENTER)
    );
    parsed.RIGHT = normalizePoints(filterPointsByAllowedSources(parsed.RIGHT, allowedSources.RIGHT));

    parsed.LEFT = parsed.LEFT.filter((p) => !isLowQualityArticleTitle(p.point));
    parsed.CENTER = parsed.CENTER.filter((p) => !isLowQualityArticleTitle(p.point));
    parsed.RIGHT = parsed.RIGHT.filter((p) => !isLowQualityArticleTitle(p.point));

    parsed.meta =
      parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
        ? { ...parsed.meta }
        : {};
    const verbatimHeadlinesFor = [];

    // When the model returns nothing valid, list real headlines from the same fetch (not invented text).
    if (parsed.LEFT.length === 0 && groupedArticles.LEFT.length > 0) {
      parsed.LEFT = fallbackPointsFromArticles(groupedArticles.LEFT);
      if (parsed.LEFT.length) verbatimHeadlinesFor.push("LEFT");
    }
    if (parsed.CENTER.length === 0 && groupedArticles.CENTER.length > 0) {
      parsed.CENTER = fallbackPointsFromArticles(groupedArticles.CENTER);
      if (parsed.CENTER.length) verbatimHeadlinesFor.push("CENTER");
    }
    if (parsed.RIGHT.length === 0 && groupedArticles.RIGHT.length > 0) {
      parsed.RIGHT = fallbackPointsFromArticles(groupedArticles.RIGHT);
      if (parsed.RIGHT.length) verbatimHeadlinesFor.push("RIGHT");
    }

    const totalParsed =
      parsed.LEFT.length + parsed.CENTER.length + parsed.RIGHT.length;
    const totalGrouped =
      groupedArticles.LEFT.length +
      groupedArticles.CENTER.length +
      groupedArticles.RIGHT.length;
    if (totalParsed === 0 && totalGrouped > 0) {
      parsed.LEFT = fallbackPointsFromArticles(groupedArticles.LEFT);
      parsed.CENTER = fallbackPointsFromArticles(groupedArticles.CENTER);
      parsed.RIGHT = fallbackPointsFromArticles(groupedArticles.RIGHT);
      for (const side of ["LEFT", "CENTER", "RIGHT"]) {
        if (parsed[side].length && !verbatimHeadlinesFor.includes(side)) {
          verbatimHeadlinesFor.push(side);
        }
      }
    }

    if (verbatimHeadlinesFor.length) {
      parsed.meta.verbatim_headlines_for = verbatimHeadlinesFor;
    }

    const pointTotalAfter =
      (parsed.LEFT?.length || 0) +
      (parsed.CENTER?.length || 0) +
      (parsed.RIGHT?.length || 0);
    const groupedTotal =
      groupedArticles.LEFT.length +
      groupedArticles.CENTER.length +
      groupedArticles.RIGHT.length;
    if (pointTotalAfter === 0 && groupedTotal > 0) {
      parsed.LEFT = fallbackPointsFromArticles(groupedArticles.LEFT);
      parsed.CENTER = fallbackPointsFromArticles(groupedArticles.CENTER);
      parsed.RIGHT = fallbackPointsFromArticles(groupedArticles.RIGHT);
      const forced = ["LEFT", "CENTER", "RIGHT"].filter((k) => parsed[k].length);
      if (forced.length) {
        parsed.meta =
          parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
            ? { ...parsed.meta }
            : {};
        parsed.meta.verbatim_headlines_for = forced;
      }
    }

    const enoughForBlindSpots =
      parsed.LEFT.length >= MIN_POINTS_FOR_BLIND_SPOTS &&
      parsed.CENTER.length >= MIN_POINTS_FOR_BLIND_SPOTS &&
      parsed.RIGHT.length >= MIN_POINTS_FOR_BLIND_SPOTS;
    if (!enoughForBlindSpots) {
      parsed.BLIND_SPOTS.LEFT_IGNORES = [];
      parsed.BLIND_SPOTS.CENTER_IGNORES = [];
      parsed.BLIND_SPOTS.RIGHT_IGNORES = [];
    }

    const hasResultData =
      ((parsed?.LEFT?.length || 0) +
        (parsed?.CENTER?.length || 0) +
        (parsed?.RIGHT?.length || 0)) >
      0;
    if (hasResultData) {
      analysisCache.set(normalized, {
        data: parsed,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    sendSse(res, "result", parsed);
    sendSse(res, "done", { cached: false });
    res.end();
  } catch (error) {
    sendSse(res, "error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Thin Line running at http://localhost:${PORT}`);
});
