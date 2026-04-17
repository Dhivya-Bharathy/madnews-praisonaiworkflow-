const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 9000);

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
      outlet: String(item?.source?.name || item?.outlet || "Unknown").trim(),
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

async function fetchTopStoriesBucket(query, maxItems = 10, keywordHints = []) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

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
    const filtered = articles.filter((item) => {
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

export async function handler() {
  try {
    const [national, geopolitical] = await Promise.all([
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
    ]);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        national,
        geopolitical,
        generatedAt: new Date().toISOString(),
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

