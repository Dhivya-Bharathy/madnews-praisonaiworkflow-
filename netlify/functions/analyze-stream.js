import OpenAI from "openai";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS || 800);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 9000);
const MODEL_MAX_POINTS_PER_SIDE = Number(process.env.MODEL_MAX_POINTS_PER_SIDE || 4);
const ARTICLE_MAX_AGE_DAYS = Number(process.env.ARTICLE_MAX_AGE_DAYS || 21);

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

/** Major center outlets — Google News RSS uses news.google.com links; match via <source> like left/right. */
const centerOutlets = [
  { name: "NDTV", domain: "ndtv.com" },
  { name: "The Hindu", domain: "thehindu.com" },
  { name: "Indian Express", domain: "indianexpress.com" },
  { name: "The Indian Express", domain: "indianexpress.com" },
  { name: "Hindustan Times", domain: "hindustantimes.com" },
  { name: "The Times of India", domain: "timesofindia.indiatimes.com" },
  { name: "Times of India", domain: "timesofindia.indiatimes.com" },
  { name: "The Economic Times", domain: "economictimes.indiatimes.com" },
  { name: "Economic Times", domain: "economictimes.indiatimes.com" },
  { name: "Mint", domain: "livemint.com" },
  { name: "Livemint", domain: "livemint.com" },
  { name: "Business Standard", domain: "business-standard.com" },
  { name: "Deccan Herald", domain: "deccanherald.com" },
  { name: "India Today", domain: "indiatoday.in" },
  { name: "News18", domain: "news18.com" },
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

function simplifyQuery(query) {
  const cleaned = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const stop = new Set([
    "the",
    "a",
    "an",
    "of",
    "to",
    "in",
    "for",
    "on",
    "and",
    "or",
    "with",
    "as",
    "at",
    "by",
    "from",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "this",
    "that",
  ]);
  const tokens = cleaned
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && !stop.has(t));
  return tokens.slice(0, 6).join(" ");
}

function buildQueryFallbacks(query) {
  const original = String(query || "").trim();
  const simplified = simplifyQuery(original);
  const firstChunk = original.split(/\s+/).slice(0, 5).join(" ").trim();
  return Array.from(new Set([original, simplified, firstChunk].filter(Boolean)));
}

function queryLooksGlobalNews(query) {
  const s = String(query || "").toLowerCase();
  return /\b(gaza|israel|palestin|hamas|idf|west bank|ukraine|kyiv|moscow|russia|putin|nato|united nations|\bun\b|security council|kosovo|serbia|iran|tehran|taiwan|beijing|china|xi jinping|syria|yemen|lebanon|hezbollah|afghanistan|iraq|libya|sudan|somalia|venezuela|north korea|kim jong|nuclear deal|sanctions|ceasefire|peacekeeping|troops|invasion|war crime|humanitarian corridor)\b/.test(
    s
  );
}

function newsApiFromDateParam() {
  const d = new Date(Date.now() - ARTICLE_MAX_AGE_DAYS * 86400000);
  return d.toISOString().slice(0, 10);
}

function parsePublishedMs(isoOrRfc) {
  const t = Date.parse(String(isoOrRfc || "").trim());
  return Number.isFinite(t) ? t : null;
}

/** Drop items with a parseable publishedAt older than ARTICLE_MAX_AGE_DAYS (stops archive SEO pages). */
function isRecentArticleItem(item) {
  const ms = parsePublishedMs(item?.publishedAt);
  if (ms == null) return true;
  const age = Date.now() - ms;
  return age >= 0 && age <= ARTICLE_MAX_AGE_DAYS * 86400000;
}

function buildNewsApiEverythingQuery(query) {
  const q = String(query || "").trim();
  if (!q) return "India";
  if (queryLooksGlobalNews(q)) {
    return `${q} (international OR global OR India OR diplomatic OR "United Nations")`;
  }
  return `${q} India`;
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
    t.endsWith(" archives") ||
    /\bnews articles\b.*\bfor\b.*\b20\d{2}\b/.test(t) ||
    /\barticles\b\s*&\s*stories\b.*\bfor\b/.test(t) ||
    /\b(stories|articles)\s+for\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      t
    )
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
    .filter((item) => isRecentArticleItem(item))
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
    const titleMatch = itemBlock.match(
      /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/
    );
    const linkMatch = itemBlock.match(/<link>([\s\S]*?)<\/link>/);
    const pubMatch = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const sourceMatch = itemBlock.match(
      /<source[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/source>|<source[^>]*>([\s\S]*?)<\/source>/
    );
    let title = decodeXml((titleMatch?.[1] || titleMatch?.[2] || "").trim());
    const url = decodeXml((linkMatch?.[1] || "").trim());
    const outlet = decodeXml(
      (sourceMatch?.[1] || sourceMatch?.[2] || fallbackOutlet).trim()
    );

    if (!title || !url) continue;
    title = title.replace(/\s*-\s*[^-]+$/, "").trim();

    items.push({
      outlet: outlet || fallbackOutlet,
      title,
      url,
      publishedAt: pubMatch?.[1] || "",
    });
  }
  return items;
}

async function fetchNewsApiEverything(query, pageSize = 60) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", buildNewsApiEverythingQuery(query));
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("from", newsApiFromDateParam());
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
      .map((article) => mapArticle(article, article.source?.name)),
    14
  );
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

async function fetchGoogleNewsByDomains(query, outletList) {
  const siteQuery = outletList.map((outlet) => `site:${outlet.domain}`).join(" OR ");
  const q = queryLooksGlobalNews(query)
    ? `${query} (${siteQuery}) when:7d`
    : `${query} India (${siteQuery}) when:7d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-IN&gl=IN&ceid=IN:en`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];
  const xml = await response.text();
  const outletDomains = new Set(outletList.map((o) => o.domain));
  const byDomain = new Map(outletList.map((o) => [o.domain, o.name]));
  const allowedOutletNames = new Set(outletList.map((o) => normalizeOutletName(o.name)));
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
              (o) => normalizeOutletName(o.name) === normalizeOutletName(item.outlet)
            )?.name ||
            item.outlet,
        };
      }),
    12
  );
}

async function fetchNewsApiByDomains(query, outletList) {
  const key = process.env.NEWS_API_KEY;
  if (!key) {
    return fetchGoogleNewsByDomains(query, outletList).catch(() => []);
  }

  const domains = outletList.map((outlet) => outlet.domain).join(",");
  const byDomain = new Map(outletList.map((o) => [o.domain, o.name]));
  const outletDomains = new Set(outletList.map((o) => o.domain));

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("domains", domains);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("from", newsApiFromDateParam());
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

  const primary = pickTopArticles(
    articles
      .filter((article) => outletDomains.has(getHostFromUrl(article?.url)))
      .map((article) => {
        const domain = getHostFromUrl(article?.url);
        return mapArticle(article, byDomain.get(domain));
      }),
    12
  );
  if (primary.length >= 3) {
    return primary;
  }

  const fallbackArticles = await fetchNewsApiEverything(query, 80);
  const fromBroad = pickTopArticles(
    fallbackArticles
      .filter((article) => outletDomains.has(getHostFromUrl(article?.url)))
      .map((article) => {
        const domain = getHostFromUrl(article?.url);
        return mapArticle(article, byDomain.get(domain));
      }),
    12
  );
  if (fromBroad.length >= 3) {
    return fromBroad;
  }

  return fetchGoogleNewsByDomains(query, outletList).catch(() => []);
}

async function fetchNewsApiByDomainsWithRetries(query, outletList) {
  const merged = [];
  const seen = new Set();
  for (const q of buildQueryFallbacks(query)) {
    const items = await fetchNewsApiByDomains(q, outletList).catch(() => []);
    for (const item of items || []) {
      const key = String(item?.url || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= 12) break;
    }
    if (merged.length >= 3) break;
  }
  return merged.slice(0, 12);
}

/** When domain-specific search is sparse, pull same outlets from a broad India query (matches local server.js). */
async function enrichPartisanFromBroad(query, outletList, currentList, minItems = 2) {
  const cur = currentList || [];
  if (cur.length >= minItems) return cur;
  const broad = await fetchNewsApiEverything(String(query || "").trim() || "India", 50).catch(() => []);
  const domains = new Set(outletList.map((o) => o.domain));
  const byDomain = new Map(outletList.map((o) => [o.domain, o.name]));
  const extra = pickTopArticles(
    broad
      .filter((article) => domains.has(getHostFromUrl(article?.url)))
      .map((article) => {
        const domain = getHostFromUrl(article?.url);
        return mapArticle(article, byDomain.get(domain));
      }),
    12
  );
  return mergeArticlesByUrl(cur, extra);
}

async function fetchCenterNews(query) {
  const rawEverything = await fetchNewsApiEverything(query, 80).catch(() => []);
  let picked = pickTopArticles(
    rawEverything
      .filter((article) => {
        const host = getHostFromUrl(article?.url);
        return host && isAcceptableCenterHost(host) && !isLowQualityArticleTitle(article?.title);
      })
      .map((article) => mapArticle(article)),
    14
  );

  const headlines = await fetchNewsApiTopHeadlinesIndia(query, 40).catch(() => []);
  picked = mergeArticlesByUrl(picked, headlines);

  if (picked.length >= 10) {
    return picked;
  }

  const rss = await fetchGoogleNewsByDomains(query, centerOutlets).catch(() => []);
  picked = mergeArticlesByUrl(picked, rss);
  return pickTopArticles(picked, 14);
}

async function fetchCenterNewsWithRetries(query) {
  const merged = [];
  const seen = new Set();
  for (const q of buildQueryFallbacks(query)) {
    const items = await fetchCenterNews(q).catch(() => []);
    for (const item of items || []) {
      const key = String(item?.url || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= 14) break;
    }
    if (merged.length >= 8) break;
  }
  return merged.slice(0, 14);
}

async function fetchCenterNewsHardFallback(query) {
  let merged = [];
  const genericQueries = [
    simplifyQuery(query),
    `${simplifyQuery(query)} india politics`,
    "india politics",
    "indian parliament",
  ].filter(Boolean);

  for (const q of Array.from(new Set(genericQueries))) {
    const items = await fetchCenterNews(q).catch(() => []);
    merged = mergeArticlesByUrl(merged, items);
    if (merged.length >= 10) return merged.slice(0, 14);
  }

  const [headlinesNoQuery, headlinesPolitics, rssPolitics, rssQuery] = await Promise.all([
    fetchNewsApiTopHeadlinesIndia("", 50).catch(() => []),
    fetchNewsApiTopHeadlinesIndia("India politics", 50).catch(() => []),
    fetchGoogleNewsByDomains("India politics", centerOutlets).catch(() => []),
    fetchGoogleNewsByDomains(simplifyQuery(query) || "India", centerOutlets).catch(() => []),
  ]);

  merged = mergeArticlesByUrl(merged, headlinesNoQuery);
  merged = mergeArticlesByUrl(merged, headlinesPolitics);
  merged = mergeArticlesByUrl(merged, rssPolitics);
  merged = mergeArticlesByUrl(merged, rssQuery);
  return merged.slice(0, 14);
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

async function generateBlindSpotsFromPoints(query, parsedPoints) {
  if (!openai) return null;
  const prompt = `
You are analyzing perspective gaps for Indian news coverage.
Use ONLY the provided point lists and do not invent external facts.

Query: "${query}"
LEFT points: ${JSON.stringify(parsedPoints.LEFT || [])}
CENTER points: ${JSON.stringify(parsedPoints.CENTER || [])}
RIGHT points: ${JSON.stringify(parsedPoints.RIGHT || [])}

Return strict JSON only:
{
  "LEFT_IGNORES": ["..."],
  "CENTER_IGNORES": ["..."],
  "RIGHT_IGNORES": ["..."]
}

Rules:
- 1-2 concise bullets per array.
- Must be grounded in differences between the provided point lists.
- No generic filler text.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: 260,
      messages: [
        {
          role: "system",
          content: "Return strictly valid JSON and no additional prose.",
        },
        { role: "user", content: prompt },
      ],
    });
    const text = completion.choices?.[0]?.message?.content || "{}";
    const json = JSON.parse(text);
    return {
      LEFT_IGNORES: Array.isArray(json?.LEFT_IGNORES)
        ? json.LEFT_IGNORES.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 2)
        : [],
      CENTER_IGNORES: Array.isArray(json?.CENTER_IGNORES)
        ? json.CENTER_IGNORES.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 2)
        : [],
      RIGHT_IGNORES: Array.isArray(json?.RIGHT_IGNORES)
        ? json.RIGHT_IGNORES.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 2)
        : [],
    };
  } catch {
    return null;
  }
}

async function fetchPraisonSupplement(query, perspective, outletList, maxItems, baseUrl, timeoutMs) {
  const domains = (outletList || []).map((o) => o.domain).filter(Boolean);
  const url = `${String(baseUrl).replace(/\/$/, "")}/v1/collect`;
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          perspective,
          domains,
          max_items: maxItems,
        }),
      },
      timeoutMs
    );
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let data;
  try {
    data = await response.json();
  } catch {
    return [];
  }
  const articles = Array.isArray(data.articles) ? data.articles : [];
  return articles.map((a) => ({
    outlet: String(a.outlet || "Unknown").trim(),
    title: String(a.title || "").trim(),
    url: String(a.url || "").trim(),
    publishedAt: String(a.publishedAt || "").trim(),
  }));
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
    const leftPromise = fetchNewsApiByDomainsWithRetries(query, leftOutlets);

    events.push(toSseEvent("status", { message: "Gathering right-wing perspectives..." }));
    const rightPromise = fetchNewsApiByDomainsWithRetries(query, rightOutlets);

    events.push(toSseEvent("status", { message: "Checking neutral/center reports..." }));
    const centerPromise = fetchCenterNewsWithRetries(query);

    const [left, right, center] = await Promise.all([leftPromise, rightPromise, centerPromise]);

    const [leftEnriched, rightEnriched] = await Promise.all([
      enrichPartisanFromBroad(query, leftOutlets, left),
      enrichPartisanFromBroad(query, rightOutlets, right),
    ]);

    let leftResolved = pickTopArticles(leftEnriched, 12);
    let rightResolved = pickTopArticles(rightEnriched, 12);
    const broadQuery = simplifyQuery(query) || "India politics";
    const googleBackfillQuery = queryLooksGlobalNews(query)
      ? simplifyQuery(query) || String(query || "").trim()
      : broadQuery;
    if (leftResolved.length < 2) {
      events.push(toSseEvent("status", { message: "Boosting left coverage from Google News fallback..." }));
      leftResolved = mergeArticlesByUrl(
        leftResolved,
        await fetchGoogleNewsByDomains(googleBackfillQuery, leftOutlets).catch(() => [])
      ).slice(0, 12);
    }
    if (rightResolved.length < 2) {
      events.push(toSseEvent("status", { message: "Boosting right coverage from Google News fallback..." }));
      rightResolved = mergeArticlesByUrl(
        rightResolved,
        await fetchGoogleNewsByDomains(googleBackfillQuery, rightOutlets).catch(() => [])
      ).slice(0, 12);
    }

    let centerResolved = center;
    if (centerResolved.length < 3) {
      events.push(toSseEvent("status", { message: "Boosting center coverage with broader India fallback..." }));
      const centerBackfill = await fetchCenterNewsHardFallback(query).catch(() => []);
      centerResolved = mergeArticlesByUrl(centerResolved, centerBackfill).slice(0, 14);
    }

    const praisonBase = String(process.env.PRAISON_SERVICE_URL || "").trim();
    if (praisonBase) {
      events.push(toSseEvent("status", { message: "Augmenting with Praison news collector..." }));
      const prTimeout = Number(process.env.PRAISON_FETCH_TIMEOUT_MS || 45000);
      const [prL, prR, prC] = await Promise.all([
        fetchPraisonSupplement(query, "LEFT", leftOutlets, 8, praisonBase, prTimeout).catch(() => []),
        fetchPraisonSupplement(query, "RIGHT", rightOutlets, 8, praisonBase, prTimeout).catch(() => []),
        fetchPraisonSupplement(query, "CENTER", centerOutlets, 8, praisonBase, prTimeout).catch(() => []),
      ]);
      leftResolved = pickTopArticles(mergeArticlesByUrl(leftResolved, prL), 12);
      rightResolved = pickTopArticles(mergeArticlesByUrl(rightResolved, prR), 12);
      centerResolved = pickTopArticles(mergeArticlesByUrl(centerResolved, prC), 14);
    }

    const groupedArticles = { LEFT: leftResolved, CENTER: centerResolved, RIGHT: rightResolved };

    if (!leftResolved.length && !centerResolved.length && !rightResolved.length) {
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

    parsed.meta =
      parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)
        ? { ...parsed.meta }
        : {};
    parsed.meta.source_links = {
      LEFT: (groupedArticles.LEFT || []).slice(0, 8).map((a) => ({
        title: a.title,
        outlet: a.outlet,
        url: a.url,
      })),
      CENTER: (groupedArticles.CENTER || []).slice(0, 8).map((a) => ({
        title: a.title,
        outlet: a.outlet,
        url: a.url,
      })),
      RIGHT: (groupedArticles.RIGHT || []).slice(0, 8).map((a) => ({
        title: a.title,
        outlet: a.outlet,
        url: a.url,
      })),
    };

    const hasAnyBlindSpots =
      (parsed.BLIND_SPOTS.LEFT_IGNORES?.length || 0) +
        (parsed.BLIND_SPOTS.CENTER_IGNORES?.length || 0) +
        (parsed.BLIND_SPOTS.RIGHT_IGNORES?.length || 0) >
      0;
    const populatedSidesCount = [parsed.LEFT, parsed.CENTER, parsed.RIGHT].filter(
      (arr) => (arr?.length || 0) > 0
    ).length;
    const enoughForGapAnalysis =
      populatedSidesCount >= 2 &&
      parsed.LEFT.length + parsed.CENTER.length + parsed.RIGHT.length >= 3;
    if (!hasAnyBlindSpots && enoughForGapAnalysis) {
      const generatedBlindSpots = await generateBlindSpotsFromPoints(query, parsed);
      if (generatedBlindSpots) {
        parsed.BLIND_SPOTS.LEFT_IGNORES = generatedBlindSpots.LEFT_IGNORES;
        parsed.BLIND_SPOTS.CENTER_IGNORES = generatedBlindSpots.CENTER_IGNORES;
        parsed.BLIND_SPOTS.RIGHT_IGNORES = generatedBlindSpots.RIGHT_IGNORES;
      }
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
