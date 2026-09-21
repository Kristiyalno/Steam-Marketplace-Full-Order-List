(() => {
  "use strict";

  const DEFAULT_INTERVAL_SECONDS = 40;
  const STORAGE_KEY = "smotRefreshIntervalSeconds";

  const input = document.getElementById("interval");
  const saved = document.getElementById("saved");
  let savedTimer = null;

  chrome.storage.sync.get({ [STORAGE_KEY]: null }, (items) => {
    // null (nothing saved yet) leaves the field empty so the "40" placeholder
    // shows through, dimmed, as the default. Any explicitly saved value
    // (including a user-chosen 40) fills the field normally.
    input.value = items[STORAGE_KEY] === null ? "" : items[STORAGE_KEY];
  });

  function flashSaved() {
    saved.classList.add("visible");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => saved.classList.remove("visible"), 1200);
  }

  function commit() {
    const raw = input.value.trim();

    // Blank stays blank: don't write a concrete number into storage just
    // because the field is empty, or the placeholder default would never
    // show again after the first save.
    if (raw === "") {
      chrome.storage.sync.remove(STORAGE_KEY, flashSaved);
      return;
    }

    let value = parseInt(raw, 10);
    if (isNaN(value) || value < 0) value = DEFAULT_INTERVAL_SECONDS;
    // 0 is allowed (disables auto-refresh); otherwise enforce the input's own range.
    if (value !== 0) value = Math.min(600, Math.max(10, value));
    input.value = value;
    chrome.storage.sync.set({ [STORAGE_KEY]: value }, flashSaved);
  }

  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
})();