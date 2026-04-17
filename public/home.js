const form = document.getElementById("analyze-form");
const input = document.getElementById("search-input");
const chips = Array.from(document.querySelectorAll(".chip"));
const nationalTopics = document.getElementById("national-topics");
const geopoliticalTopics = document.getElementById("geopolitics-topics");
const topStoriesMeta = document.getElementById("top-stories-meta");

const TOP_STORIES_REFRESH_MS = 4 * 60 * 1000;

function normalizeStoryQuery(title) {
  const cleaned = String(title || "")
    .replace(/[^\w\s]/g, " ")
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
  ]);
  const tokens = cleaned
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && !stop.has(t.toLowerCase()));
  return tokens.slice(0, 7).join(" ");
}

form?.addEventListener("submit", (event) => {
  const query = input.value.trim();
  if (!query) {
    event.preventDefault();
    return;
  }
  input.value = query;
});

for (const chip of chips) {
  chip.addEventListener("click", () => {
    const topic = chip.textContent?.trim();
    if (!topic) return;
    window.location.href = `/results.html?q=${encodeURIComponent(topic)}`;
  });
}

function renderDailyTopics(container, stories = []) {
  if (!container) return;
  container.innerHTML = "";
  if (!Array.isArray(stories) || stories.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No stories available right now.";
    container.appendChild(li);
    return;
  }

  for (const story of stories.slice(0, 10)) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "daily-topic-btn text-left text-sm text-slate-700 hover:text-blue-700 hover:underline";
    btn.textContent = story?.title || "Untitled story";
    btn.addEventListener("click", () => {
      const q = String(story?.query || "").trim() || normalizeStoryQuery(story?.title);
      if (!q) return;
      window.location.href = `/results.html?q=${encodeURIComponent(q)}`;
    });
    li.appendChild(btn);
    container.appendChild(li);
  }
}

async function loadTopStories() {
  try {
    const response = await fetch(`/api/top-stories?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed with ${response.status}`);
    const payload = await response.json();
    renderDailyTopics(nationalTopics, payload?.national || []);
    renderDailyTopics(geopoliticalTopics, payload?.geopolitical || []);
    if (topStoriesMeta) {
      const gen = payload?.generatedAt ? new Date(payload.generatedAt) : null;
      topStoriesMeta.textContent = gen
        ? `Trending lists refresh automatically every few minutes · Updated ${gen.toLocaleTimeString()}`
        : "Trending lists refresh automatically every few minutes.";
    }
  } catch {
    renderDailyTopics(nationalTopics, []);
    renderDailyTopics(geopoliticalTopics, []);
    if (topStoriesMeta) {
      topStoriesMeta.textContent = "";
    }
  }
}

loadTopStories();
setInterval(loadTopStories, TOP_STORIES_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadTopStories();
});
