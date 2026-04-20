const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);

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

function mapArticle(article, fallbackOutlet) {
  return {
    outlet: fallbackOutlet || article?.source?.name || "Unknown",
    title: article?.title || "",
    url: article?.url || "",
    publishedAt: article?.publishedAt || "",
  };
}

function dedupeByUrlAndTitle(items = [], maxItems = 10) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const title = String(item?.title || "").trim();
    const url = String(item?.url || "").trim();
    if (!title || !url) continue;
    const key = `${url.toLowerCase()}::${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      url,
      outlet: String(item?.outlet || item?.source?.name || "Unknown").trim(),
      publishedAt: String(item?.publishedAt || "").trim(),
    });
    if (out.length >= maxItems) break;
  }
  return out;
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
    const sourceBlockMatch = itemBlock.match(/<source([^>]*)>([\s\S]*?)<\/source>/);
    let title = decodeXml((titleMatch?.[1] || titleMatch?.[2] || "").trim());
    const linkUrl = decodeXml((linkMatch?.[1] || "").trim());
    let sourceUrl = "";
    if (sourceBlockMatch) {
      const attrs = sourceBlockMatch[1];
      const urlAttr = attrs.match(/\burl="([^"]+)"/i) || attrs.match(/\burl='([^']+)'/i);
      if (urlAttr) sourceUrl = decodeXml(urlAttr[1].trim());
    }
    const outlet = decodeXml((sourceBlockMatch?.[2] || "").trim() || fallbackOutlet);
    const url = sourceUrl || linkUrl;
    if (!title || !url) continue;
    title = title.replace(/\s*-\s*[^-]+$/, "").trim();
    items.push({
      outlet,
      title,
      url,
      publishedAt: pubMatch?.[1] || "",
    });
  }
  return items;
}

async function fetchGoogleNewsTopic(query, maxItems = 10) {
  const q = `${query} when:1d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-IN&gl=IN&ceid=IN:en`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];
  const xml = await response.text();
  return dedupeByUrlAndTitle(parseGoogleNewsRss(xml), maxItems);
}

async function fetchGoogleNewsTopicUS(query, maxItems = 10) {
  const q = `${query} when:2d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];
  const xml = await response.text();
  return dedupeByUrlAndTitle(parseGoogleNewsRss(xml), maxItems);
}

async function fetchPraisonPrecomputedTopics() {
  const base = String(process.env.PRAISON_SERVICE_URL || "").trim();
  if (!base) return null;
  const url = `${base.replace(/\/$/, "")}/v1/precomputed-topics`;
  try {
    const response = await fetchWithTimeout(url, {}, 1800);
    if (!response.ok) return null;
    const data = await response.json();
    const national = dedupeByUrlAndTitle(Array.isArray(data?.national) ? data.national : [], 10);
    const geopolitical = dedupeByUrlAndTitle(
      Array.isArray(data?.geopolitical) ? data.geopolitical : [],
      10
    );
    if (!national.length && !geopolitical.length) return null;
    return {
      national,
      geopolitical,
      generatedAt: String(data?.generatedAt || "").trim() || new Date().toISOString(),
      source: "praison-precomputed",
    };
  } catch {
    return null;
  }
}

async function fetchTopStoriesBucket(query, maxItems = 10, keywordHints = []) {
  const key = process.env.NEWS_API_KEY;
  if (!key) {
    return fetchGoogleNewsTopic(query, maxItems).catch(() => []);
  }

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", String(Math.max(maxItems * 2, 25)));
  url.searchParams.set("apiKey", key);

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return [];
    const data = await response.json();
    if (data?.status === "error") return [];
    const articles = Array.isArray(data.articles) ? data.articles : [];
    const mapped = articles.map((article) => mapArticle(article, article?.source?.name));
    const filtered = mapped.filter((item) => {
      if (isLowQualityArticleTitle(item?.title)) return false;
      if (!keywordHints.length) return true;
      const bag = `${String(item?.title || "")} ${String(item?.description || "")}`.toLowerCase();
      return keywordHints.some((kw) => bag.includes(String(kw).toLowerCase()));
    });
    return dedupeByUrlAndTitle(filtered, maxItems);
  } catch {
    return [];
  }
}

function articlesToTopStories(articles = []) {
  return (articles || [])
    .map((a) => mapArticle(a, a?.source?.name))
    .filter((item) => item.title && item.url && !isLowQualityArticleTitle(item.title));
}

async function fetchNewsApiTopHeadlinesParams(searchParams, pageSize = 40) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];
  const url = new URL("https://newsapi.org/v2/top-headlines");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("apiKey", key);
  for (const [k, v] of Object.entries(searchParams || {})) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
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

async function fetchTrendingIndiaHeadlines(maxItems = 12) {
  const articles = await fetchNewsApiTopHeadlinesParams({ country: "in" }, 50);
  return dedupeByUrlAndTitle(articlesToTopStories(articles), maxItems);
}

async function fetchTrendingGlobalHeadlines(maxItems = 12) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const attempts = [
    { sources: "bbc-news" },
    { sources: "bbc-news,reuters,associated-press" },
    { sources: "bbc-news,associated-press" },
    { sources: "reuters" },
    { country: "us", category: "general" },
    { country: "gb", category: "general" },
  ];
  let flat = [];
  for (const params of attempts) {
    const articles = await fetchNewsApiTopHeadlinesParams(params, 28);
    flat.push(...articlesToTopStories(articles));
    if (dedupeByUrlAndTitle(flat, maxItems + 2).length >= maxItems) break;
  }
  return dedupeByUrlAndTitle(flat, maxItems);
}

async function fetchWorldEverythingTopStories(maxItems = 14) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set(
    "q",
    '("United Nations" OR NATO OR diplomacy OR geopolitics OR ceasefire OR sanctions OR "foreign policy" OR summit OR conflict) NOT cricket NOT bollywood NOT IPL'
  );
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "36");
  url.searchParams.set("apiKey", key);

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return [];
    const data = await response.json();
    if (data?.status === "error") return [];
    const articles = Array.isArray(data.articles) ? data.articles : [];
    const mapped = articles
      .map((article) => mapArticle(article, article?.source?.name))
      .filter(
        (item) =>
          item.title && item.url && !isLowQualityArticleTitle(item.title)
      );
    return dedupeByUrlAndTitle(mapped, maxItems);
  } catch {
    return [];
  }
}

function prioritizeNationalPoliticsFirst(items = []) {
  const hints =
    /minister|parliament|election|assembly|government|bjp|congress|bill|court|supreme|policy|lok sabha|rajya|chief minister|prime minister|\bpm\b|\bcm\b|governor|cabinet|ministry|protest|vote|campaign/i;
  const pri = [];
  const rest = [];
  for (const it of items || []) {
    if (hints.test(String(it?.title || ""))) pri.push(it);
    else rest.push(it);
  }
  return [...pri, ...rest];
}

function prioritizeGeopoliticalFirst(items = []) {
  const hints =
    /china|russia|ukraine|iran|israel|gaza|nato|un |\bun\b|ceasefire|sanction|military|war|conflict|diplomat|embassy|border|taiwan|middle east|europe|africa|trump|putin|modi|trade|tariff|missile|troops|invasion|peace talk/i;
  const pri = [];
  const rest = [];
  for (const it of items || []) {
    if (hints.test(String(it?.title || ""))) pri.push(it);
    else rest.push(it);
  }
  return [...pri, ...rest];
}

export async function handler() {
  try {
    const precomputed = await fetchPraisonPrecomputedTopics();
    if (precomputed) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
        },
        body: JSON.stringify({
          national: precomputed.national,
          geopolitical: precomputed.geopolitical,
          generatedAt: precomputed.generatedAt,
          meta: { source: precomputed.source },
        }),
      };
    }

    const [trendingIn, trendingWorld, bucketNational, bucketGeo, worldEverything] =
      await Promise.all([
        fetchTrendingIndiaHeadlines(14),
        fetchTrendingGlobalHeadlines(14),
        fetchTopStoriesBucket(
          "India politics OR parliament OR election OR policy OR supreme court",
          10,
          [
            "election",
            "parliament",
            "assembly",
            "government",
            "supreme court",
            "minister",
            "bill",
            "policy",
            "bjp",
            "congress",
          ]
        ),
        fetchTopStoriesBucket(
          "India foreign policy OR diplomacy OR border OR geopolitical OR UN",
          10,
          [
            "foreign policy",
            "diplomatic",
            "geopolitical",
            "geopolitics",
            "border",
            "china",
            "pakistan",
            "united nations",
            "un ",
            "sanction",
            "war",
            "ceasefire",
            "conflict",
          ]
        ),
        fetchWorldEverythingTopStories(14),
      ]);

    let national = dedupeByUrlAndTitle(
      prioritizeNationalPoliticsFirst([...trendingIn, ...bucketNational]),
      10
    );
    let geopolitical = dedupeByUrlAndTitle(
      prioritizeGeopoliticalFirst([
        ...trendingWorld,
        ...bucketGeo,
        ...worldEverything,
      ]),
      10
    );

    if (!national.length) {
      national = await fetchGoogleNewsTopic("India politics government parliament", 10);
    }
    if (!geopolitical.length) {
      geopolitical = await fetchGoogleNewsTopicUS(
        "world geopolitics diplomacy conflict UN NATO",
        10
      );
    }
    if (!geopolitical.length) {
      geopolitical = await fetchGoogleNewsTopicUS("international news", 10);
    }
    if (!geopolitical.length) {
      geopolitical = await fetchGoogleNewsTopic(
        "world news UN security council global affairs",
        10
      );
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
      },
      body: JSON.stringify({
        national,
        geopolitical,
        generatedAt: new Date().toISOString(),
          meta: { source: "newsapi-rss" },
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to fetch top stories",
      }),
    };
  }
}
