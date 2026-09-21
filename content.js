(() => {
  "use strict";

  const SELL_KEY = "rgCompactSellOrders";
  const BUY_KEY  = "rgCompactBuyOrders";

  const REFRESH_STORAGE_KEY = "smotRefreshIntervalSeconds";
  const DEFAULT_REFRESH_SECONDS = 40;

  // Live registry of every wired table's refresh timer, so a setting
  // change from the popup can immediately re-arm all of them without a
  // page reload.
  const refreshHandles = new Set();

  function getRefreshIntervalSeconds() {
    return new Promise((resolve) => {
      if (!(chrome && chrome.storage && chrome.storage.sync)) {
        resolve(DEFAULT_REFRESH_SECONDS);
        return;
      }
      chrome.storage.sync.get({ [REFRESH_STORAGE_KEY]: DEFAULT_REFRESH_SECONDS }, (items) => {
        resolve(items[REFRESH_STORAGE_KEY]);
      });
    });
  }

  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[REFRESH_STORAGE_KEY]) return;
      // newValue is undefined when the popup clears the field back to blank
      // (storage.remove), which means "use the default", not "stop".
      const seconds = changes[REFRESH_STORAGE_KEY].newValue ?? DEFAULT_REFRESH_SECONDS;
      refreshHandles.forEach((handle) => handle.rearm(seconds));
    });
  }

  // ── Data extraction ─────────────────────────────────────────────────────────

  function findCompactOrders(rawText, key) {
    const idx = rawText.indexOf(key);
    if (idx === -1) return null;
    const bracketStart = rawText.indexOf("[", idx);
    if (bracketStart === -1) return null;
    let depth = 0, bracketEnd = -1;
    for (let i = bracketStart; i < rawText.length; i++) {
      const ch = rawText[i];
      if (ch === "[") depth++;
      else if (ch === "]") { if (--depth === 0) { bracketEnd = i; break; } }
    }
    if (bracketEnd === -1) return null;
    const numbers = (rawText.slice(bracketStart + 1, bracketEnd).match(/-?\d+/g) || []).map(Number);
    if (numbers.length % 2 !== 0) numbers.pop();
    return numbers;
  }

  /**
   * Collapse duplicate price levels and sort.
   *
   * Sell orders read cheapest first, buy orders read highest first, which is
   * how Steam prints its own rows on each side. `descending` is set for buy.
   *
   * @param {number[]} numbers      flat [price, qty, price, qty, ...] in cents
   * @param {boolean}  descending   true for buy orders
   * @returns {Array<[number, number]>}
   */
  function aggregatePairs(numbers, descending) {
    const totals = new Map();
    for (let i = 0; i < numbers.length; i += 2) {
      const price = numbers[i], qty = numbers[i + 1];
      totals.set(price, (totals.get(price) || 0) + qty);
    }
    const pairs = [...totals.entries()];
    pairs.sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
    return pairs;
  }

  function extractOrdersFromText(rawText, key) {
    const numbers = findCompactOrders(rawText, key);
    if (!numbers || numbers.length === 0) return null;
    return aggregatePairs(numbers, key === BUY_KEY);
  }

  function extractOrders(key) {
    return extractOrdersFromText(document.documentElement.outerHTML, key);
  }

  /**
   * Re-fetch this same listing page and pull fresh order data out of it.
   * Same-origin GET, no new permissions: it's the page the user is already
   * on. Used to keep numbers current after the initial page load.
   *
   * `cache: "no-store"` only governs the browser's own HTTP cache — it does
   * nothing about a CDN or edge cache sitting in front of Steam, which will
   * happily keep serving one cached snapshot to a plain repeated GET. A
   * throwaway query param makes every request look like a different URL so
   * that layer can't dedupe it against what it already has cached.
   *
   * @param {string} key
   * @returns {Promise<Array<[number, number]>|null>}
   */
  async function fetchFreshOrders(key) {
    const url = new URL(location.href);
    url.searchParams.set("smot_ts", Date.now().toString());

    const response = await fetch(url.toString(), {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const html = await response.text();
    return extractOrdersFromText(html, key);
  }

  // ── Money parsing / formatting ───────────────────────────────────────────────

  /**
   * Read a price out of a cell like "$0.12", "0,12€", "1.234,56 €" or
   * "$0.18 or more" and return it in cents.
   *
   * @param {string} text
   * @returns {number|null}
   */
  function parsePriceCents(text) {
    const match = text.match(/\d[\d.,\u00a0\s]*/);
    if (!match) return null;
    const raw = match[0].replace(/[\u00a0\s]/g, "");
    const lastComma = raw.lastIndexOf(",");
    const lastDot   = raw.lastIndexOf(".");
    const sepPos    = Math.max(lastComma, lastDot);

    let intDigits  = raw.replace(/\D/g, "");
    let fracDigits = "00";

    if (sepPos !== -1) {
      const frac = raw.slice(sepPos + 1).replace(/\D/g, "");
      // 1-2 trailing digits means a decimal separator, 3 means thousands.
      if (frac.length > 0 && frac.length <= 2) {
        intDigits  = raw.slice(0, sepPos).replace(/\D/g, "");
        fracDigits = frac.padEnd(2, "0");
      }
    }

    const cents = parseInt(intDigits || "0", 10) * 100 + parseInt(fracDigits || "0", 10);
    return isNaN(cents) ? null : cents;
  }

  /**
   * Build a formatter that mirrors whatever Steam already prints in this
   * table, so totals don't show "$" to someone browsing in euros.
   *
   * @param {string|null} sampleText  text of a native price cell
   * @returns {(cents: number) => string}
   */
  function makeMoneyFormatter(sampleText) {
    let prefix = "", suffix = "", decimal = ".", group = ",";

    if (sampleText) {
      const match = sampleText.match(/^([^\d]*)(\d[\d.,\u00a0\s]*\d|\d)([^\d]*)$/);
      if (match) {
        prefix = match[1];
        suffix = match[3];
        if (/,\d{1,2}$/.test(match[2])) { decimal = ","; group = "."; }
      }
    }

    return function formatMoney(cents) {
      const negative = cents < 0;
      const abs      = Math.abs(cents);
      const whole    = String(Math.floor(abs / 100));
      const frac     = String(abs % 100).padStart(2, "0");
      const grouped  = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
      return (negative ? "-" : "") + prefix + grouped + decimal + frac + suffix;
    };
  }

  // ── Table detection ──────────────────────────────────────────────────────────

  function findOrderTables() {
    return Array.from(document.querySelectorAll("table")).filter(table => {
      const cells = table.querySelectorAll("thead th, thead td");
      const text  = Array.from(cells).map(c => c.textContent.trim().toLowerCase()).join("|");
      return text.includes("price") && text.includes("quantity");
    });
  }

  function classifyTable(table, index) {
    let node = table;
    for (let hops = 0; hops < 4 && node; hops++) {
      const text = (node.textContent || "").toLowerCase();
      if (text.includes("for sale starting at")) return "sell";
      if (text.includes("requests to buy"))      return "buy";
      node = node.parentElement;
    }
    return index === 0 ? "sell" : "buy";
  }

  /**
   * classifyTable's heading-text walk is a heuristic — it assumes the "for
   * sale starting at" / "requests to buy" heading sits within a few
   * ancestor hops of the table, which holds for Steam's actual markup but
   * isn't guaranteed. If it guesses wrong, the wrong compact-orders key gets
   * used and extraction silently returns nothing.
   *
   * This cross-checks the guess against reality: aggregate both
   * rgCompactSellOrders and rgCompactBuyOrders and see which one's price
   * levels actually match the table's own native rows. Falls back to the
   * heuristic's key when neither can be verified (e.g. no native rows
   * parsed yet) or both/neither match.
   */
  function resolveOrderKey(table, guessedKey) {
    const nativePrices = new Set();
    for (const row of nativeDataRows(table)) {
      const cell = row.querySelector("td");
      if (!cell) continue;
      const cents = parsePriceCents(cell.textContent);
      if (cents !== null) nativePrices.add(cents);
    }
    if (nativePrices.size === 0) return guessedKey;

    function matchesNative(key) {
      const pairs = extractOrders(key);
      if (!pairs || pairs.length === 0) return false;
      // Every native price should appear somewhere in this key's data.
      return Array.from(nativePrices).every(p => pairs.some(([price]) => price === p));
    }

    const guessedMatches = matchesNative(guessedKey);
    const otherKey = guessedKey === SELL_KEY ? BUY_KEY : SELL_KEY;
    const otherMatches = matchesNative(otherKey);

    if (guessedMatches && !otherMatches) return guessedKey;
    if (otherMatches && !guessedMatches) return otherKey;
    // Both matched, neither matched, or inconclusive: trust the heuristic.
    return guessedKey;
  }

  function findCollapsedRow(table) {
    const rows = nativeDataRows(table);
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    const priceCell = last.querySelector("td");
    if (!priceCell) return null;
    const text = priceCell.textContent.toLowerCase();
    return (text.includes("or more") || text.includes("or lower") || text.includes("or less")) ? last : null;
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────

  /** Native (Steam-rendered) data rows, excluding anything this script added. */
  function nativeDataRows(table) {
    return Array.from(table.querySelectorAll("tbody tr")).filter(
      r => !r.classList.contains("smot-extra-row") &&
           !r.classList.contains("smot-sum-row") &&
           !r.classList.contains("smot-status-row") &&
           !r.classList.contains("smot-refresh-row") &&
           !r.classList.contains("smot-collapsed-row")
    );
  }

  /** Text of the first native price cell, used as a currency sample. */
  function samplePriceText(table) {
    for (const row of nativeDataRows(table)) {
      const cell = row.querySelector("td");
      if (cell && /\d/.test(cell.textContent)) return cell.textContent.trim();
    }
    return null;
  }

  /**
   * Clone the cell structure from an existing native data row so injected rows
   * use exactly the same elements, classes, and CSS variables Steam applied.
   * This is what keeps font sizes identical without knowing any hashed class
   * names, and the total row now goes through it too.
   *
   * @param {HTMLTableElement} table
   * @param {string} priceText
   * @param {string} qtyText
   * @param {string[]} extraClasses  extra CSS classes on the <tr>
   * @returns {HTMLTableRowElement}
   */
  function makeRow(table, priceText, qtyText, extraClasses = []) {
    const nativeRows = nativeDataRows(table);

    if (nativeRows.length > 0) {
      const template = nativeRows[0];
      const tr = document.createElement("tr");
      extraClasses.forEach(c => tr.classList.add(c));

      const cells  = template.querySelectorAll("td");
      const values = [priceText, qtyText];
      cells.forEach((cell, i) => {
        const td = cell.cloneNode(true);
        // Update only the text content inside, keeping all nested elements.
        const inner = td.querySelector("span") || td;
        inner.textContent = values[i] ?? "";
        tr.appendChild(td);
      });
      return tr;
    }

    // Fallback: plain row (no native template available yet).
    const tr = document.createElement("tr");
    extraClasses.forEach(c => tr.classList.add(c));
    [priceText, qtyText].forEach(val => {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    });
    return tr;
  }

  /**
   * Freeze the table at its collapsed rendered size before any rows are added,
   * so injected content can never reflow the columns or push the table wider.
   *
   * @param {HTMLTableElement} table
   */
  function pinTableLayout(table) {
    if (table.dataset.smotPinned) return;

    const headerCells = Array.from(table.querySelectorAll("thead th"));
    if (headerCells.length === 0) return;

    const tableWidth = table.getBoundingClientRect().width;
    if (!tableWidth) return;

    const widths = headerCells.map(th => th.getBoundingClientRect().width);
    if (widths.some(w => !w)) return;

    table.style.width       = tableWidth + "px";
    table.style.maxWidth    = "100%";
    table.style.tableLayout = "fixed";
    // Percentages rather than pixels, so the columns keep their proportions
    // if the container ever gets narrower than the width we measured.
    headerCells.forEach((th, i) => {
      th.style.width = (widths[i] / tableWidth * 100).toFixed(4) + "%";
    });

    table.dataset.smotPinned = "1";
  }

  /**
   * Compute total value (price × qty, summed) across all pairs.
   * Returns { totalCents, totalQty }.
   */
  function computeTotal(pairs) {
    let totalCents = 0, totalQty = 0;
    for (const [priceCents, qty] of pairs) {
      totalCents += priceCents * qty;
      totalQty   += qty;
    }
    return { totalCents, totalQty };
  }

  function getShownPrices(table, collapsedRow) {
    const shown = new Set();
    const originalTbody = table.querySelector("tbody");
    if (!originalTbody) return shown;
    for (const row of originalTbody.querySelectorAll("tr")) {
      if (row === collapsedRow) continue;
      const cell = row.querySelector("td");
      if (!cell) continue;
      const cents = parsePriceCents(cell.textContent);
      if (cents !== null) shown.add(cents);
    }
    return shown;
  }

  /**
   * @param {boolean} rowsHidden  true while the per-price breakdown is
   *   collapsed. The sum row itself is never hidden by this function — it's
   *   the always-visible total — only the individual `.smot-extra-row`s are.
   */
  function renderExpandedRows(table, extraTbody, pairs, alreadyShownPrices, formatMoney, rowsHidden) {
    // Remove old injected rows (but keep the status row at index 0).
    Array.from(extraTbody.querySelectorAll(".smot-extra-row, .smot-sum-row"))
      .forEach(r => r.remove());

    const frag = document.createDocumentFragment();

    // Data rows.
    for (const [priceCents, qty] of pairs) {
      if (alreadyShownPrices.has(priceCents)) continue;
      const row = makeRow(table, formatMoney(priceCents), String(qty), ["smot-extra-row"]);
      row.hidden = rowsHidden;
      frag.appendChild(row);
    }

    // Sum row, built from the same native template as every other row. The
    // value sits in the price column and the count in the quantity column;
    // the rule above it and the accent colour are what mark it as the total.
    // Always visible, regardless of expand state.
    const { totalCents, totalQty } = computeTotal(pairs);
    const sumRow = makeRow(table, formatMoney(totalCents), String(totalQty), ["smot-sum-row"]);
    sumRow.title = "Total across all " + totalQty + " orders";
    frag.appendChild(sumRow);

    extraTbody.appendChild(frag);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────

  /**
   * Tables with 5 or fewer price levels have no collapsed "or more" row —
   * Steam already renders every order natively. There's nothing to expand,
   * but the total is still worth showing, so this appends a single always-
   * visible sum row plus a small refresh row, with no expand button and no
   * click required to see either.
   *
   * Fetches fresh rather than trusting the DOM at wiring time, same reason
   * as the click-to-expand flow: Steam's market can swap in a new listing's
   * table via SPA navigation, and this function only ever runs once per
   * table (guarded by smotTotalWired), so if it read stale or half-rendered
   * DOM data here it would be stuck showing a wrong total with no later
   * chance to correct it. Falls back to the DOM parse only if the fetch
   * itself fails (e.g. offline).
   */
  async function wireStaticTotal(table, key) {
    table.dataset.smotTotalWired = "1";

    let pairs = await fetchFreshOrders(key);
    if (!pairs) pairs = extractOrders(key);
    if (!pairs || pairs.length === 0) return;

    // The table may have been torn out from under us (SPA nav swapped it
    // for a different listing's table) while the fetch was in flight.
    if (!table.isConnected) return;

    const formatMoney = makeMoneyFormatter(samplePriceText(table));

    const extraTbody = document.createElement("tbody");
    extraTbody.className = "smot-extra-tbody";
    table.appendChild(extraTbody);

    const sumRow = makeRow(table, "", "", ["smot-sum-row"]);
    extraTbody.appendChild(sumRow);

    const refreshRow = document.createElement("tr");
    refreshRow.className = "smot-refresh-row";
    const refreshCell = document.createElement("td");
    refreshCell.colSpan = 2;
    refreshCell.className = "smot-refresh-cell";

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "smot-refresh-btn";
    refreshButton.title = "Refresh now";
    refreshButton.setAttribute("aria-label", "Refresh order list");
    refreshButton.textContent = "\u21bb";

    const refreshNote = document.createElement("span");
    refreshNote.className = "smot-refresh-note";

    refreshCell.appendChild(refreshButton);
    refreshCell.appendChild(refreshNote);
    refreshRow.appendChild(refreshCell);
    extraTbody.appendChild(refreshRow);

    function formatUpdatedAt(date) {
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      const ss = String(date.getSeconds()).padStart(2, "0");
      return "Updated " + hh + ":" + mm + ":" + ss;
    }

    function renderTotal(p) {
      const { totalCents, totalQty } = computeTotal(p);
      const cells = sumRow.querySelectorAll("td");
      const values = [formatMoney(totalCents), String(totalQty)];
      cells.forEach((cell, i) => {
        const inner = cell.querySelector("span") || cell;
        inner.textContent = values[i];
      });
      sumRow.title = "Total across all " + totalQty + " orders";
    }

    renderTotal(pairs);
    refreshNote.textContent = formatUpdatedAt(new Date());

    async function refreshNow({ silent = false } = {}) {
      if (!silent) refreshButton.disabled = true;
      try {
        const fresh = await fetchFreshOrders(key);
        if (!fresh) {
          refreshNote.textContent = "Refresh failed";
          return;
        }
        renderTotal(fresh);
        refreshNote.textContent = formatUpdatedAt(new Date());
      } catch (err) {
        refreshNote.textContent = "Refresh failed";
      } finally {
        if (!silent) refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener("click", () => refreshNow());

    let timerId = null;
    function startTimer(seconds) {
      if (timerId !== null) clearInterval(timerId);
      timerId = null;
      if (!seconds || seconds <= 0) return;
      timerId = setInterval(() => refreshNow({ silent: true }), seconds * 1000);
    }

    const handle = {
      rearm(seconds) {
        if (timerId !== null) startTimer(seconds);
      },
    };
    refreshHandles.add(handle);
    const seconds = await getRefreshIntervalSeconds();
    if (table.isConnected) startTimer(seconds);
  }

  function wireCollapsedRow(table, collapsedRow, key) {
    if (collapsedRow.dataset.smotWired) return;
    collapsedRow.dataset.smotWired = "1";
    collapsedRow.classList.add("smot-collapsed-row");
    // Marks the table as handled via the expand flow, so a later scan can't
    // mistake it for a no-collapsed-row table once this row (now carrying
    // smot-collapsed-row / an injected button) stops matching
    // findCollapsedRow's "or more" text check.
    table.dataset.smotTotalWired = "1";

    const priceCell    = collapsedRow.querySelector("td");
    const originalText = priceCell.textContent;
    const formatMoney  = makeMoneyFormatter(samplePriceText(table));

    // The collapsed row's quantity is the sum of everything hidden behind it.
    // Once those orders are listed one by one it reads as a duplicate, so it
    // is blanked while expanded and put back on collapse.
    const collapsedQtyCell = collapsedRow.querySelectorAll("td")[1] || null;
    const collapsedQtyTarget = collapsedQtyCell
      ? (collapsedQtyCell.querySelector("span") || collapsedQtyCell)
      : null;
    const collapsedQtyText = collapsedQtyTarget ? collapsedQtyTarget.textContent : "";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "smot-expand-btn";
    button.textContent = originalText + " \u25BC";
    button.setAttribute("aria-expanded", "false");

    // Match the font size of native cell text. Native rows put text inside a
    // <span> whose font-size comes from a hashed CSS class we can't predict.
    const nativeSpan = (() => {
      for (const row of table.querySelectorAll("tbody tr")) {
        if (row === collapsedRow) continue;
        const span = row.querySelector("td span");
        if (span) return span;
      }
      return null;
    })();
    if (nativeSpan) {
      const fs = getComputedStyle(nativeSpan).fontSize;
      if (fs) button.style.fontSize = fs;
    }

    priceCell.textContent = "";
    priceCell.appendChild(button);

    // Not hidden: the total row that lands in here needs to stay visible
    // whether or not the full list is expanded. Only the pieces that only
    // make sense while expanded (status/refresh rows, per-price rows) are
    // individually hidden below.
    const extraTbody = document.createElement("tbody");
    extraTbody.className = "smot-extra-tbody";
    table.appendChild(extraTbody);

    const statusRow = document.createElement("tr");
    statusRow.className = "smot-status-row";
    statusRow.hidden = true;
    const statusCell = document.createElement("td");
    statusCell.colSpan = 2;
    statusCell.className = "smot-status-cell";
    statusRow.appendChild(statusCell);
    extraTbody.appendChild(statusRow);

    // Refresh row: a small manual refresh button plus a "last updated" note.
    // Lives above the sum row so it reads as metadata about the list, not
    // part of it. Always visible — like the sum row, staying live is the
    // point even while the per-price breakdown is collapsed.
    const refreshRow = document.createElement("tr");
    refreshRow.className = "smot-refresh-row";
    const refreshCell = document.createElement("td");
    refreshCell.colSpan = 2;
    refreshCell.className = "smot-refresh-cell";

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "smot-refresh-btn";
    refreshButton.title = "Refresh now";
    refreshButton.setAttribute("aria-label", "Refresh order list");
    refreshButton.textContent = "\u21bb";

    const refreshNote = document.createElement("span");
    refreshNote.className = "smot-refresh-note";

    refreshCell.appendChild(refreshButton);
    refreshCell.appendChild(refreshNote);
    refreshRow.appendChild(refreshCell);
    extraTbody.appendChild(refreshRow);

    let expanded = false;

    function setRefreshNote(text) {
      refreshNote.textContent = text;
    }

    function formatUpdatedAt(date) {
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      const ss = String(date.getSeconds()).padStart(2, "0");
      return "Updated " + hh + ":" + mm + ":" + ss;
    }

    /**
     * Parse `pairs`, re-render the rows, and refresh the "shown" set against
     * the native rows as they currently stand. Shared by the initial expand
     * and by every refresh tick so they can't drift apart.
     */
    function applyPairs(pairs) {
      const shown = getShownPrices(table, collapsedRow);
      renderExpandedRows(table, extraTbody, pairs, shown, formatMoney, !expanded);
      if (expanded && collapsedQtyTarget) collapsedQtyTarget.textContent = "";
      // renderExpandedRows only clears/rebuilds the .smot-extra-row and
      // .smot-sum-row nodes; refreshRow isn't touched by that pass, so its
      // position in extraTbody doesn't move on its own. appendChild on a
      // node already in the tree relocates it rather than duplicating it,
      // so this puts refreshRow back at the end, below the fresh sum row,
      // every time new rows are rendered.
      extraTbody.appendChild(refreshRow);
    }

    async function refreshNow({ silent = false } = {}) {
      if (!silent) refreshButton.disabled = true;
      try {
        const pairs = await fetchFreshOrders(key);
        if (!pairs) {
          setRefreshNote("Refresh failed");
          return;
        }
        applyPairs(pairs);
        setRefreshNote(formatUpdatedAt(new Date()));
      } catch (err) {
        setRefreshNote("Refresh failed");
      } finally {
        if (!silent) refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener("click", () => refreshNow());

    // ── Auto-refresh timer ──────────────────────────────────────────────────
    // One timer per wired table, running for as long as the table exists on
    // the page — not just while expanded. The total needs to stay live
    // whether or not the user has opened the per-price breakdown.
    let timerId = null;

    function stopTimer() {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    }

    function startTimer(seconds) {
      stopTimer();
      if (!seconds || seconds <= 0) return;
      timerId = setInterval(() => refreshNow({ silent: true }), seconds * 1000);
    }

    const handle = {
      rearm(seconds) {
        if (timerId !== null) startTimer(seconds); // only re-arm if currently running
      },
    };

    // Show the total immediately, from a fresh same-origin fetch rather
    // than trusting the DOM at wiring time — same reasoning as the
    // click-to-expand flow below: Steam's market can swap this table out
    // via SPA navigation, and this only runs once, so a stale DOM read
    // here would show a wrong total with no later correction. Falls back
    // to the DOM parse if the fetch fails.
    (async () => {
      let pairs = await fetchFreshOrders(key);
      if (!pairs) pairs = extractOrders(key);
      // The button may already have been clicked (or the table torn out)
      // while this awaited; don't clobber whatever state it's in now.
      if (!pairs || !table.isConnected || expanded) return;
      applyPairs(pairs);
      setRefreshNote(formatUpdatedAt(new Date()));

      // Auto-refresh starts here, independent of expand state, so the
      // total keeps itself current for as long as this table is on the
      // page. Collapsing only hides the per-price breakdown, not this.
      refreshHandles.add(handle);
      const seconds = await getRefreshIntervalSeconds();
      if (table.isConnected) startTimer(seconds);
    })();

    button.addEventListener("click", async () => {
      expanded = !expanded;

      if (expanded) {
        // Measure and lock the collapsed size first, then fill the table.
        pinTableLayout(table);

        button.textContent = originalText + " \u25B2";
        button.setAttribute("aria-expanded", "true");
        statusRow.hidden = false;
        statusCell.textContent = "Loading\u2026";

        // Always fetch on expand rather than trusting whatever's currently
        // parsed out of the DOM. Steam's market navigates between listings
        // without a full page reload, so the DOM can still be showing a
        // previous item's embedded order data for a moment after switching
        // listings — a fresh fetch is keyed to the current URL and can't be
        // stale in that way. Falls back to the DOM parse only if the fetch
        // itself fails (e.g. offline).
        let pairs = await fetchFreshOrders(key);
        if (!pairs) pairs = extractOrders(key);

        // The user may have collapsed the row again while this awaited.
        if (!expanded) return;

        if (!pairs) {
          statusRow.hidden = false;
          statusCell.textContent = "Couldn't find the full order list on this page.";
          return;
        }
        statusRow.hidden = true;
        applyPairs(pairs);
        setRefreshNote(formatUpdatedAt(new Date()));
      } else {
        button.textContent = originalText + " \u25BC";
        button.setAttribute("aria-expanded", "false");
        statusRow.hidden = true;
        Array.from(extraTbody.querySelectorAll(".smot-extra-row"))
          .forEach(r => { r.hidden = true; });
        if (collapsedQtyTarget) collapsedQtyTarget.textContent = collapsedQtyText;
      }
    });
  }

  function setupTable(table, kind) {
    // No "already checked" flag on the table itself at the very start:
    // Steam can render the table before its rows land, and marking it here
    // would mean never wiring it once they do. But once either wiring path
    // below has claimed the table (smotTotalWired), later scans must not
    // re-evaluate it — the collapsed row's own markup changes once wired
    // (button, smot-collapsed-row class) and would otherwise stop matching
    // findCollapsedRow on a later scan, wrongly triggering the no-collapsed-
    // row path on top of the already-wired one.
    if (table.dataset.smotTotalWired) return;

    const guessedKey = kind === "sell" ? SELL_KEY : BUY_KEY;
    const key = resolveOrderKey(table, guessedKey);
    const collapsedRow = findCollapsedRow(table);

    if (collapsedRow) {
      wireCollapsedRow(table, collapsedRow, key);
      return;
    }

    // No collapsed row: every order is already rendered natively (5 or
    // fewer price levels), so there's nothing to expand. Still show the
    // always-on total row beneath what's there, without a button and
    // without waiting for a click.
    wireStaticTotal(table, key);
  }

  function scanTables() {
    const tables = findOrderTables();
    tables.forEach((table, index) => setupTable(table, classifyTable(table, index)));
  }

  function init() {
    scanTables();

    // The market page mutates constantly (and our own rows mutate it too),
    // so coalesce bursts into one scan per frame instead of scanning the
    // whole document on every single mutation record.
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scanTables();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();