const form = document.getElementById("analyze-form");
const input = document.getElementById("search-input");
const analyzeBtn = document.getElementById("analyze-btn");
const loadingPanel = document.getElementById("loading-panel");
const fetchMsg = document.getElementById("fetch-msg");
const statusMsg = document.getElementById("status-msg");
const resultsWrap = document.getElementById("results");
const blindWrap = document.getElementById("blind-spots");
const emptyState = document.getElementById("empty-state");
const emptyStateTitle = document.getElementById("empty-state-title");
const emptyStateText = document.getElementById("empty-state-text");
const emptyStateHint = document.getElementById("empty-state-hint");

const leftList = document.getElementById("left-list");
const centerList = document.getElementById("center-list");
const rightList = document.getElementById("right-list");
const leftIgnores = document.getElementById("left-ignores");
const centerIgnores = document.getElementById("center-ignores");
const rightIgnores = document.getElementById("right-ignores");

let lastServerStatus = "";

function resetStatusUi() {
  lastServerStatus = "";
  statusMsg.textContent = "Starting: fetching headlines from sources…";
}

function renderPoints(container, points = []) {
  container.innerHTML = "";
  if (!Array.isArray(points) || points.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Not enough recent coverage from this perspective.";
    container.appendChild(li);
    return;
  }
  for (const item of points) {
    const li = document.createElement("li");
    const point = item?.point || "";
    const source = item?.source ? ` (${item.source})` : "";
    li.textContent = `${point}${source}`.trim();
    container.appendChild(li);
  }
}

function renderBlindSpots(container, items = []) {
  container.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  for (const text of items) {
    const li = document.createElement("li");
    li.textContent = text;
    container.appendChild(li);
  }
}

function normalizeBlindSpotItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((text) => String(text || "").trim())
    .filter((text) => text.length > 0);
}

function setLoading(loading) {
  analyzeBtn.disabled = loading;
  analyzeBtn.textContent = loading ? " " : "Analyze";
  loadingPanel.classList.toggle("hidden", !loading);
  document.body.classList.toggle("is-loading", loading);
}

/** Model JSON sometimes uses different casing; treat as empty only if all are missing. */
function perspectiveArrays(result) {
  if (!result) return { LEFT: [], CENTER: [], RIGHT: [] };
  const pick = (a, b) => (Array.isArray(a) ? a : Array.isArray(b) ? b : []);
  return {
    LEFT: pick(result.LEFT, result.left),
    CENTER: pick(result.CENTER, result.center),
    RIGHT: pick(result.RIGHT, result.right),
  };
}

function hasAnyPoints(result) {
  const { LEFT, CENTER, RIGHT } = perspectiveArrays(result);
  return LEFT.length + CENTER.length + RIGHT.length > 0;
}

function applyPerspectiveArrays(target, { LEFT, CENTER, RIGHT }) {
  target.LEFT = LEFT;
  target.CENTER = CENTER;
  target.RIGHT = RIGHT;
}

function isNoCoverageMeta(meta) {
  const v = meta?.no_coverage;
  return v === true || v === "true" || v === 1;
}

function buildEmptyHint(query, meta, lastStatusLine) {
  const q = String(query || "").trim().toLowerCase();
  const examples = [
    "Waqf Amendment Bill",
    "NEET paper leak",
    "state election results",
    "GST changes",
  ].filter((ex) => ex.toLowerCase() !== q);
  const exampleLine =
    examples.length > 0
      ? `You can try a shorter phrase or another domestic topic (for example: ${examples.slice(0, 2).join(", ")}).`
      : "Try a shorter search phrase or check again later.";

  if (isNoCoverageMeta(meta)) {
    return (
      "Thin Line only uses a fixed set of Indian left, center, and right outlets. " +
      "If none of them published a match for your wording in the last few days, you will see this message. " +
      exampleLine
    );
  }

  let hint =
    "Headlines were found, but the summary step did not return usable bullet points (or they failed source checks). " +
    "Check that OPENAI_API_KEY is set, restart the server, and try again.";
  if (lastStatusLine) {
    hint += ` Last step reported: ${lastStatusLine}`;
  }
  return hint;
}

function showEmptyState(title, text, hintText) {
  emptyStateTitle.textContent = title;
  emptyStateText.textContent = text;
  if (emptyStateHint) {
    emptyStateHint.textContent = hintText || "";
    emptyStateHint.classList.toggle("hidden", !hintText);
  }
  emptyState.classList.remove("hidden");
  resultsWrap.classList.add("hidden");
  blindWrap.classList.add("hidden");
}

function hideEmptyState() {
  emptyState.classList.add("hidden");
}

async function runAnalysis(query) {
  hideEmptyState();
  resultsWrap.classList.add("hidden");
  blindWrap.classList.add("hidden");
  leftList.innerHTML = "";
  centerList.innerHTML = "";
  rightList.innerHTML = "";

  fetchMsg.textContent = `Showing perspectives for "${query}"`;
  setLoading(true);
  resetStatusUi();

  try {
    const response = await fetch(`/api/analyze-stream?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResult = null;

    function consumeSseText(text) {
      const normalized = String(text || "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      const events = normalized.split("\n\n");
      const tail = events.pop() || "";
      for (const eventBlock of events) {
        const lines = eventBlock.split("\n");
        const eventNameLine = lines.find((line) => line.startsWith("event: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (!eventNameLine || !dataLine) continue;

        const eventName = eventNameLine.replace("event: ", "").trim();
        let payload;
        try {
          payload = JSON.parse(dataLine.replace("data: ", ""));
        } catch {
          continue;
        }

        if (eventName === "status" && payload?.message) {
          lastServerStatus = payload.message;
          statusMsg.textContent = payload.message;
        }
        if (eventName === "error") {
          throw new Error(payload?.message || "Streaming error");
        }
        if (eventName === "result") {
          finalResult = payload;
        }
      }
      return tail;
    }

    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      buffer = consumeSseText(buffer);
      if (done) break;
    }

    buffer += decoder.decode();
    buffer = consumeSseText(buffer);

    if (!finalResult) {
      throw new Error("No analysis payload received.");
    }

    if (!hasAnyPoints(finalResult)) {
      const title = isNoCoverageMeta(finalResult.meta)
        ? "No articles from our Indian outlets"
        : "Could not build the three perspectives";
      const reason = isNoCoverageMeta(finalResult.meta)
        ? `We did not find matching stories for “${query}” on the left, center, and right Indian sites this app scans (recent days).`
        : `We had some headlines for “${query}”, but nothing ended up as valid LEFT / CENTER / RIGHT bullet points.`;
      showEmptyState(title, reason, buildEmptyHint(query, finalResult.meta, lastServerStatus));
      return;
    }

    applyPerspectiveArrays(finalResult, perspectiveArrays(finalResult));

    renderPoints(leftList, finalResult.LEFT);
    renderPoints(centerList, finalResult.CENTER);
    renderPoints(rightList, finalResult.RIGHT);

    const verbatim = finalResult.meta?.verbatim_headlines_for;
    if (Array.isArray(verbatim) && verbatim.length > 0) {
      fetchMsg.textContent = `${fetchMsg.textContent} (${verbatim.join(", ")}: exact headlines from your search results — not generated text.)`;
    }

    const leftBlind = normalizeBlindSpotItems(finalResult.BLIND_SPOTS?.LEFT_IGNORES);
    const centerBlind = normalizeBlindSpotItems(finalResult.BLIND_SPOTS?.CENTER_IGNORES);
    const rightBlind = normalizeBlindSpotItems(finalResult.BLIND_SPOTS?.RIGHT_IGNORES);

    renderBlindSpots(leftIgnores, leftBlind);
    renderBlindSpots(centerIgnores, centerBlind);
    renderBlindSpots(rightIgnores, rightBlind);

    resultsWrap.classList.remove("hidden");
    const hasBlindContent =
      leftBlind.length > 0 || centerBlind.length > 0 || rightBlind.length > 0;
    blindWrap.classList.toggle("hidden", !hasBlindContent);
  } catch (error) {
    fetchMsg.textContent = "";
    const errHint =
      (lastServerStatus ? `Last step: ${lastServerStatus}. ` : "") +
      "If the error mentions the API key, update .env and restart the Node server.";
    showEmptyState("Something went wrong", error.message || "Unknown error", errHint);
  } finally {
    setLoading(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  const next = new URL(window.location.href);
  next.searchParams.set("q", query);
  window.history.replaceState({}, "", next.toString());
  runAnalysis(query);
});

const initialQuery = new URLSearchParams(window.location.search).get("q") || "";
if (initialQuery.trim()) {
  input.value = initialQuery.trim();
  runAnalysis(initialQuery.trim());
}
