(() => {
  "use strict";

  const DEFAULT_INTERVAL_SECONDS = 40;
  const STORAGE_KEY = "smotRefreshIntervalSeconds";

  const input = document.getElementById("interval");
  const saved = document.getElementById("saved");
  let savedTimer = null;

  chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_INTERVAL_SECONDS }, (items) => {
    input.value = items[STORAGE_KEY];
  });

  function flashSaved() {
    saved.classList.add("visible");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => saved.classList.remove("visible"), 1200);
  }

  function commit() {
    let value = parseInt(input.value, 10);
    if (isNaN(value) || value < 0) value = DEFAULT_INTERVAL_SECONDS;
    // 0 is allowed (disables auto-refresh); otherwise enforce the input's own range.
    if (value !== 0) value = Math.min(600, Math.max(10, value));
    input.value = value;
    chrome.storage.sync.set({ [STORAGE_KEY]: value }, flashSaved);
  }

  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
})();
