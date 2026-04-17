const form = document.getElementById("analyze-form");
const input = document.getElementById("search-input");
const chips = Array.from(document.querySelectorAll(".chip"));

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
