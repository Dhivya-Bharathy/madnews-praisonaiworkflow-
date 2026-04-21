const form = document.getElementById("topic-form");
const topicInput = document.getElementById("topic-input");
const newsList = document.getElementById("news-list");
const statusEl = document.getElementById("status");
const analysisWrap = document.getElementById("analysis-wrap");
const loadBtn = document.getElementById("load-btn");
const themeToggle = document.getElementById("theme-toggle");
const mainTabs = document.getElementById("main-tabs");
const panelHeadlines = document.getElementById("panel-headlines");
const panelPerspectives = document.getElementById("panel-perspectives");
const panelCrawl = document.getElementById("panel-crawl");
const triContext = document.getElementById("tri-context");
const triIntro = document.getElementById("tri-intro");
const triStatus = document.getElementById("tri-status");
/** Mirrors server DEFAULT_NEWS_TOPIC until /api/config loads (Render + localhost). */
let resolvedDefaultTopic = "Indian politics";
const leftSummary = document.getElementById("left-summary");
const centerSummary = document.getElementById("center-summary");
const rightSummary = document.getElementById("right-summary");
const leftLinks = document.getElementById("left-links");
const centerLinks = document.getElementById("center-links");
const rightLinks = document.getElementById("right-links");

const PLACEHOLDER =
  '<p class="placeholder muted">Pick a headline in <strong>Headlines</strong> to fill this column.</p>';

/** @type {"headlines" | "perspectives" | "crawl"} */
let activeTab = "headlines";

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll("#main-tabs .tab-btn").forEach((btn) => {
    const t = btn.getAttribute("data-tab");
    const isOn = t === tab;
    btn.classList.toggle("tab-active", isOn);
    btn.setAttribute("aria-selected", isOn ? "true" : "false");
  });
  if (panelHeadlines) panelHeadlines.classList.toggle("hidden", tab !== "headlines");
  if (panelPerspectives) panelPerspectives.classList.toggle("hidden", tab !== "perspectives");
  if (panelCrawl) panelCrawl.classList.toggle("hidden", tab !== "crawl");
  mainTabs?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

document.querySelectorAll("#main-tabs .tab-btn").forEach((btn) => {
  btn.setAttribute("role", "tab");
  btn.setAttribute("aria-selected", "false");
  btn.addEventListener("click", () => {
    const t = btn.getAttribute("data-tab");
    if (t === "headlines" || t === "perspectives" || t === "crawl") setActiveTab(t);
  });
});

function normalizeStanceLabel(stance) {
  const s = String(stance || "").toLowerCase();
  if (s.includes("left")) return "LEFT";
  if (s.includes("right")) return "RIGHT";
  if (s.includes("center") || s.includes("centre")) return "CENTER";
  if (s.includes("mixed")) return "MIXED";
  return "UNKNOWN";
}

function setTheme(mode) {
  const isDark = mode === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  try {
    localStorage.setItem("madnews-theme", isDark ? "dark" : "light");
  } catch {}
  if (themeToggle) themeToggle.textContent = isDark ? "Toggle Light" : "Toggle Dark";
}

themeToggle?.addEventListener("click", () => {
  const isDark = document.documentElement.classList.contains("dark");
  setTheme(isDark ? "light" : "dark");
});
setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(id)
  );
}

function resetThreeColumnPlaceholders() {
  if (triContext) triContext.textContent = "No headline selected yet.";
  triStatus.textContent =
    "Open the Headlines tab, tap a story — we’ll switch here and load LEFT / CENTER / RIGHT for that headline only.";
  leftSummary.innerHTML = PLACEHOLDER;
  centerSummary.innerHTML = PLACEHOLDER;
  rightSummary.innerHTML = PLACEHOLDER;
  leftLinks.innerHTML = "";
  centerLinks.innerHTML = "";
  rightLinks.innerHTML = "";
}

function renderSideSummary(container, sideData) {
  const summary = sideData?.summary || {};
  const points = Array.isArray(summary?.key_points) ? summary.key_points : [];
  container.innerHTML = `
    <div class="rich-summary">${summary?.summary || "No summary available."}</div>
    <ul class="rich-ul">${points.map((x) => `<li>${x}</li>`).join("") || "<li>No key points</li>"}</ul>
  `;
}

function renderSideLinks(container, links = []) {
  container.innerHTML = "";
  if (!Array.isArray(links) || !links.length) {
    container.innerHTML = `<li class="muted">No source links.</li>`;
    return;
  }
  for (const link of links) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = link?.url || "#";
    a.target = "_blank";
    a.rel = "noreferrer";
    a.className = "link-a";
    a.textContent = `${link?.outlet || "Unknown"}: ${link?.title || "Untitled"}`;
    li.appendChild(a);
    container.appendChild(li);
  }
}

let triHintTimer = null;

function startTriProgressHints() {
  if (triHintTimer) clearInterval(triHintTimer);
  const hints = [
    "Building LEFT / CENTER / RIGHT for this headline…",
    "Gathering domain-filtered links (can take a while)…",
    "Summarizing each side — almost there…",
  ];
  let i = 0;
  triStatus.textContent = hints[0];
  triHintTimer = setInterval(() => {
    i = Math.min(i + 1, hints.length - 1);
    triStatus.textContent = hints[i];
  }, 22000);
}

function stopTriProgressHints() {
  if (triHintTimer) {
    clearInterval(triHintTimer);
    triHintTimer = null;
  }
}

/** Query sent to /api/madnews-three-sides: search topic + headline so DDG stays on-story. */
function buildHeadlineTopic(searchTopic, row) {
  const title = String(row?.title || "").trim();
  const t = String(searchTopic || "").trim();
  if (!title) return t || "news";
  const combined = `${t} ${title}`.trim();
  return combined.slice(0, 220);
}

async function loadThreeSides(apiTopic, displayHeadline) {
  if (triContext && displayHeadline) {
    triContext.textContent = `Showing perspectives for: ${displayHeadline}`;
  }
  startTriProgressHints();
  try {
    const response = await fetchWithTimeout(
      `/api/madnews-three-sides?topic=${encodeURIComponent(apiTopic)}`,
      {},
      130000
    );
    if (!response.ok) throw new Error(`3-side failed (${response.status})`);
    const data = await response.json();
    const totalTimeout = data?.meta?.error === "madnews_total_timeout";
    if (totalTimeout) {
      stopTriProgressHints();
      triStatus.textContent =
        "Whole 3-side pipeline timed out on the server. Try again or use a shorter headline.";
    }
    renderSideSummary(leftSummary, data?.LEFT);
    renderSideSummary(centerSummary, data?.CENTER);
    renderSideSummary(rightSummary, data?.RIGHT);
    renderSideLinks(leftLinks, data?.LEFT?.links || []);
    renderSideLinks(centerLinks, data?.CENTER?.links || []);
    renderSideLinks(rightLinks, data?.RIGHT?.links || []);
    stopTriProgressHints();
    if (!totalTimeout) {
      triStatus.textContent = displayHeadline
        ? `Loaded for: “${displayHeadline.slice(0, 90)}${displayHeadline.length > 90 ? "…" : ""}”`
        : `3-side view loaded from ${data?.meta?.source || "sources"}.`;
    }
  } catch (error) {
    stopTriProgressHints();
    const msg =
      error?.name === "AbortError"
        ? "3-side request timed out. Try again or pick another headline."
        : error?.message || "Failed to build 3-side view.";
    triStatus.textContent = msg;
  }
}

function clearHeadlineSelection() {
  newsList.querySelectorAll("[data-headline-item]").forEach((el) => {
    el.classList.remove("selected");
  });
}

async function onHeadlineClick(searchTopic, row, liEl) {
  clearHeadlineSelection();
  liEl.classList.add("selected");
  const headline = String(row?.title || "Story").trim();
  const apiTopic = buildHeadlineTopic(searchTopic, row);
  setActiveTab("perspectives");
  await loadThreeSides(apiTopic, headline);
}

function renderNews(items = [], searchTopic = "") {
  newsList.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    newsList.innerHTML = `<li class="muted">No links found for "${searchTopic}".</li>`;
    return;
  }

  for (const row of items) {
    const li = document.createElement("li");
    li.setAttribute("data-headline-item", "1");
    li.className = "headline-card";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "headline-title";
    title.textContent = row?.title || "Untitled";
    title.addEventListener("click", () => onHeadlineClick(searchTopic, row, li));

    const meta = document.createElement("div");
    meta.className = "headline-meta";
    meta.textContent = `${row?.outlet || "Unknown"}${row?.why ? ` - ${row.why}` : ""}`;

    const crawlBtn = document.createElement("button");
    crawlBtn.type = "button";
    crawlBtn.className = "btn-crawl";
    crawlBtn.textContent = "Crawl page (optional)";
    crawlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      crawlAnalyze(searchTopic, row);
    });

    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(crawlBtn);
    newsList.appendChild(li);
  }
}

function stanceCssClass(stance) {
  const s = normalizeStanceLabel(stance);
  if (s === "LEFT") return "stance-left";
  if (s === "RIGHT") return "stance-right";
  if (s === "CENTER") return "stance-center";
  return "stance-unknown";
}

function renderAnalysis(payload) {
  const analysis = payload?.analysis || {};
  const keyPoints = Array.isArray(analysis.key_points) ? analysis.key_points : [];
  const biasSignals = Array.isArray(analysis.bias_signals) ? analysis.bias_signals : [];
  const stance = normalizeStanceLabel(analysis.stance);
  const stanceCls = stanceCssClass(analysis.stance);

  analysisWrap.innerHTML = `
    <div class="analysis-url">${payload?.outlet || "Unknown"} - ${payload?.url || ""}</div>
    <div class="analysis-box"><strong>Summary:</strong> ${analysis.summary || "No summary."}</div>
    <div class="rich-summary"><strong>madnews stance:</strong> <span class="${stanceCls}">${stance}</span></div>
    <div class="rich-summary"><strong>Key points:</strong></div>
    <ul class="rich-ul">${keyPoints.map((x) => `<li>${x}</li>`).join("") || "<li>None</li>"}</ul>
    <div class="rich-summary"><strong>Narrative signals:</strong></div>
    <ul class="rich-ul">${biasSignals.map((x) => `<li>${x}</li>`).join("") || "<li>None</li>"}</ul>
  `;
}

async function crawlAnalyze(topic, row) {
  setActiveTab("crawl");
  analysisWrap.textContent = "Crawling and analyzing…";
  try {
    const response = await fetchWithTimeout(
      "/api/crawl-and-analyze",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, url: row?.url || "" }),
      },
      90000
    );
    if (!response.ok) throw new Error(`Analyze failed (${response.status})`);
    const data = await response.json();
    renderAnalysis(data);
  } catch (error) {
    analysisWrap.textContent = error?.message || "Failed to analyze this link.";
  }
}

async function loadNews(topic) {
  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";
  setActiveTab("headlines");
  setStatus("Loading headlines…");
  newsList.innerHTML = "";
  clearHeadlineSelection();
  resetThreeColumnPlaceholders();
  analysisWrap.textContent =
    "Use “Crawl page (optional)” on a headline (tab 1), or open tab 3 after starting a crawl.";
  try {
    const response = await fetchWithTimeout(
      `/api/latest-news?topic=${encodeURIComponent(topic)}&limit=10`,
      {},
      50000
    );
    if (!response.ok) throw new Error(`Load failed (${response.status})`);
    const data = await response.json();
    renderNews(data?.articles || [], topic);
    const timed = data?.meta?.ddg_timeout === true;
    setStatus(
      timed
        ? "Search timed out (DuckDuckGo slow). Try “Load headlines” again."
        : `Loaded ${data?.articles?.length || 0} headlines. Tap one — we’ll open Perspectives for you.`
    );
  } catch (error) {
    const msg =
      error?.name === "AbortError"
        ? "Request timed out (network or server slow). Try “Load headlines” again."
        : error?.message || "Failed to load latest links.";
    setStatus(msg);
    renderNews([], topic);
    triStatus.textContent = "";
    if (triContext) triContext.textContent = "";
    loadBtn.disabled = false;
    loadBtn.textContent = "Load headlines";
    return;
  }
  loadBtn.disabled = false;
  loadBtn.textContent = "Load headlines";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const topic = topicInput.value.trim() || resolvedDefaultTopic;
  loadNews(topic);
});

async function loadUiConfig() {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    const c = await r.json();
    if (topicInput && typeof c.defaultTopic === "string" && c.defaultTopic.trim()) {
      const dt = c.defaultTopic.trim();
      resolvedDefaultTopic = dt;
      topicInput.value = dt;
    }
    if (triIntro && typeof c.perspectivesNote === "string" && c.perspectivesNote.trim()) {
      triIntro.textContent = c.perspectivesNote.trim();
    }
  } catch {
    resolvedDefaultTopic = "Indian politics";
    if (topicInput && !topicInput.value.trim()) topicInput.value = resolvedDefaultTopic;
    if (triIntro && !triIntro.textContent)
      triIntro.textContent =
        "Each column lists article links from that spectrum plus a short narrative built from those results.";
  }
}

resetThreeColumnPlaceholders();
setActiveTab("headlines");
setStatus(
  "Use the tabs: Headlines → tap a story (Perspectives opens) → optional Article for crawl."
);
loadUiConfig();
