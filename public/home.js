const form = document.getElementById("analyze-form");
const input = document.getElementById("search-input");
const chips = Array.from(document.querySelectorAll(".chip"));
const nationalTopics = document.getElementById("national-topics");
const geopoliticalTopics = document.getElementById("geopolitics-topics");

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
      const q = String(story?.title || "").trim();
      if (!q) return;
      window.location.href = `/results.html?q=${encodeURIComponent(q)}`;
    });
    li.appendChild(btn);
    container.appendChild(li);
  }
}

async function loadTopStories() {
  try {
    const response = await fetch("/api/top-stories");
    if (!response.ok) throw new Error(`Failed with ${response.status}`);
    const payload = await response.json();
    renderDailyTopics(nationalTopics, payload?.national || []);
    renderDailyTopics(geopoliticalTopics, payload?.geopolitical || []);
  } catch {
    renderDailyTopics(nationalTopics, []);
    renderDailyTopics(geopoliticalTopics, []);
  }
}

loadTopStories();
