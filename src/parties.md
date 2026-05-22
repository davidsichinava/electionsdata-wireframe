---
theme: [air, alt, wide]
title: Parties
toc: false
---

```js
import {getLang, tr} from "./components/state.js";

const dict  = await FileAttachment("data/config/translations.json").json();
const index = await FileAttachment("data/parties-index.json").json();
const lang  = getLang();
const t     = k => tr(dict, lang, k);
```

```js
// ── Lookup helpers ───────────────────────────────────────────────────────────
const electionById = new Map(index.elections.map(e => [e.id, e]));

function electionName(electionId) {
  const e = electionById.get(electionId);
  if (!e) return electionId;
  return (lang === "ka" ? e.name_ka : e.name_en) ?? e.id;
}

function partyDisplayName(lineage) {
  return lang === "ka" ? (lineage.name_ka ?? lineage.name_en ?? lineage.id)
                        : (lineage.name_en ?? lineage.name_ka ?? lineage.id);
}

function formatVoteShare(v) { return v == null ? "" : (v * 100).toFixed(2) + "%"; }
function formatInt(v)       { return v == null ? "" : Number(v).toLocaleString(lang === "ka" ? "ka-GE" : "en-US"); }
```

```js
// ── Search corpus per lineage: pre-built once, used on every keystroke.
//    Concatenates English + Georgian names + lineage_id + member ids.
const corpus = index.lineages.map(l => {
  const ids = (l.ids || []).join(" ");
  return `${l.name_ka ?? ""} ${l.name_en ?? ""} ${l.id} ${ids}`.toLowerCase();
});
```

```js
// ── State widget — {query, page, filter:category, expanded:Set<lineage_id>} ──
const stateWidget = (() => {
  const el = document.createElement("div");
  el.value = { query: "", page: 1, filter: "all", expanded: new Set() };
  function emit(next) {
    el.value = next;
    el.dispatchEvent(new Event("input"));
  }
  el.setQuery     = q   => emit({ ...el.value, query: q, page: 1 });
  el.bumpPage     = ()  => emit({ ...el.value, page: el.value.page + 1 });
  el.setFilter    = f   => emit({ ...el.value, filter: f, page: 1 });
  el.toggleExpand = lid => {
    const next = new Set(el.value.expanded);
    if (next.has(lid)) next.delete(lid); else next.add(lid);
    emit({ ...el.value, expanded: next });
  };
  return el;
})();
const state = Generators.input(stateWidget);
```

```js
// ── Stable search input + filter chip row (defined ONCE) ─────────────────────
const searchInput = Inputs.text({
  placeholder: t("parties.search_placeholder"),
  submit: false
});
searchInput.style.width = "100%";
searchInput.addEventListener("input", () => stateWidget.setQuery(searchInput.value));

// Category filter chips. Defined once; the active styling updates via a
// reactive cell that adds/removes a class.
const FILTERS = ["all", "party", "coalition", "historic"];
const filterRow = html`<div class="cand-filter-row">${
  FILTERS.map(f => html`<button type="button" class="cand-chip" data-filter="${f}">${t("parties.filter." + f)}</button>`)
}</div>`;
filterRow.addEventListener("click", ev => {
  const btn = ev.target.closest(".cand-chip");
  if (btn) stateWidget.setFilter(btn.dataset.filter);
});
```

```js
// ── Static frame: defined ONCE so the search input never leaves the DOM. ─────
const resultsPanel = html`<div></div>`;
const frame = html`
<style>
  .cand-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
  }
  .cand-grid > .card { min-width: 0; }
  .cand-disclaimer {
    background: var(--theme-background-alt, #f6f6f6);
    border-left: 3px solid var(--muted, #999);
    color: var(--muted, #555);
    padding: 0.6rem 0.8rem;
    font-size: 0.82rem;
    line-height: 1.45;
    margin-bottom: 1rem;
    border-radius: 4px;
  }
  .cand-count {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.5rem 0 0.75rem;
  }
  .cand-prompt {
    color: var(--muted);
    font-style: italic;
    font-size: 0.9rem;
    padding: 1rem 0;
  }
  .cand-grid .input-group input::placeholder {
    color: var(--muted);
    font-style: italic;
    opacity: 1;
  }
  .cand-filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0.8rem 0 0.5rem;
  }
  .cand-chip {
    background: var(--theme-background, #fff);
    border: 1px solid var(--theme-foreground-faint, #ccc);
    border-radius: 14px;
    padding: 4px 12px;
    font-size: 0.78rem;
    color: var(--theme-foreground, #333);
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
  }
  .cand-chip:hover { background: var(--theme-background-alt, #f6f6f6); }
  .cand-chip.cand-chip-active {
    background: var(--red, #CC1720);
    border-color: var(--red, #CC1720);
    color: #fff;
  }
  /* Grid-backed tables: shared column template for header + body rows. */
  .cand-table { width: 100%; max-width: none; font-size: 0.86rem; margin: 0; }
  .cand-table-row {
    display: grid;
    width: 100%;
    border-bottom: 1px solid var(--theme-foreground-faintest, #f0f0f0);
    align-items: start;
  }
  .cand-table-row:last-child { border-bottom: none; }
  .cand-table-parties .cand-table-row {
    grid-template-columns:
      minmax(12rem, 2.4fr)
      minmax(5rem, 0.8fr)
      minmax(5rem, 0.8fr)
      minmax(7rem, 1.1fr)
      minmax(7rem, 1.1fr)
      minmax(6rem, 0.9fr);
  }
  .cand-table-pappear .cand-table-row {
    grid-template-columns:
      minmax(3.5rem, 0.45fr)
      minmax(14rem, 2.2fr)
      minmax(6rem, 0.9fr)
      minmax(7rem, 0.9fr)
      minmax(7rem, 0.9fr)
      minmax(5rem, 0.65fr)
      minmax(5rem, 0.65fr)
      minmax(6.5rem, 0.85fr)
      minmax(7rem, 1fr);
  }
  .cand-table-cell {
    min-width: 0;
    box-sizing: border-box;
    padding: 8px 10px;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
    word-break: normal;
  }
  .cand-table-head { border-bottom: 1px solid var(--theme-foreground-faint, #ddd); }
  .cand-table-head .cand-table-cell {
    font-family: var(--font-head);
    color: var(--muted);
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    overflow-wrap: break-word;
  }
  .cand-grid .input-group label,
  .cand-grid .input-group form > label {
    font-family: var(--font-head);
    font-weight: 700;
    font-size: 0.82rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    display: block;
    margin-bottom: 0.3rem;
  }
  .cand-table-cell.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .cand-table-cell.center { text-align: center; }
  @media (max-width: 900px) {
    .cand-table { overflow-x: auto; padding-bottom: 2px; }
    .cand-table-parties .cand-table-row { min-width: 700px; }
    .cand-table-pappear .cand-table-row { min-width: 920px; }
  }
  .cand-link {
    background: none; border: 0; padding: 0;
    color: var(--theme-foreground-focus, #0366d6);
    cursor: pointer; font: inherit; text-align: left;
  }
  .cand-link:hover { text-decoration: underline; }
  .cand-pager { margin-top: 0.75rem; text-align: center; }
  .cand-show-more {
    background: none;
    border: 1px solid var(--theme-foreground-faint, #ccc);
    border-radius: 4px;
    padding: 5px 14px;
    font-size: 0.85rem;
    cursor: pointer;
    color: var(--theme-foreground, #333);
  }
  .cand-show-more:hover { background: var(--theme-background-alt, #f6f6f6); }
  /* Party-row visual cues */
  .party-color-bar {
    display: inline-block;
    width: 8px;
    height: 1em;
    vertical-align: -2px;
    margin-right: 6px;
    border-radius: 2px;
  }
  .party-meta-line {
    color: var(--muted);
    font-size: 0.78rem;
    margin-top: 2px;
  }
  /* Inline-expanded detail row (matches /candidates) */
  .cand-row-detail {
    display: block;
    background: var(--theme-background-alt, #f9f9f9);
    border-bottom: 1px solid var(--theme-foreground-faintest, #f0f0f0);
    border-left: 3px solid var(--red, #CC1720);
    padding: 12px 16px 14px 16px;
  }
  .cand-row-detail .cand-detail-meta {
    display: flex; gap: 1rem; flex-wrap: wrap;
    color: var(--muted); font-size: 0.82rem;
    margin: 0 0 0.5rem;
  }
  .cand-link .cand-chevron {
    display: inline-block;
    width: 0.85em;
    margin-right: 0.25em;
    color: var(--muted);
    transition: transform 0.15s ease;
  }
  .cand-row-expanded .cand-chevron {
    transform: rotate(90deg);
    color: var(--red);
  }
  .cand-row-expanded .cand-link {
    color: var(--dark);
    font-weight: 700;
  }
  /* Sparkline */
  .cand-sparkline {
    display: inline-block;
    vertical-align: middle;
    height: 18px;
  }
  .cand-sparkline-empty {
    color: var(--muted);
    font-size: 0.78rem;
  }
</style>

<div>
  <div class="cand-disclaimer">${t("parties.disclaimer")}</div>

  <div class="cand-grid">
    <div class="card">
      <div class="input-group">${searchInput}</div>
      ${filterRow}
      ${resultsPanel}
    </div>
  </div>
</div>
`;
display(frame);
```

```js
// ── Helpers used by both panels ──────────────────────────────────────────────

// Tiny SVG sparkline of vote_share over time. Y axis pinned to [0, maxShare].
function renderSparkline(series, color) {
  if (!series || series.length < 2) {
    return html`<span class="cand-sparkline-empty">—</span>`;
  }
  const W = 80, H = 18, P = 2;
  const xs = series.map(([y]) => y);
  const ys = series.map(([, s]) => s);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = Math.max(...ys, 0.01);
  const xOf = y => P + (W - 2 * P) * ((y - xMin) / Math.max(1, xMax - xMin));
  const yOf = s => H - P - (H - 2 * P) * (s / yMax);
  const path = series.map(([y, s], i) => `${i ? "L" : "M"}${xOf(y).toFixed(1)},${yOf(s).toFixed(1)}`).join(" ");
  const lastX = xOf(xs[xs.length - 1]);
  const lastY = yOf(ys[ys.length - 1]);
  const c = color || "var(--red)";
  return html`<svg class="cand-sparkline" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <path d="${path}" stroke="${c}" stroke-width="1.5" fill="none" />
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2" fill="${c}" />
  </svg>`;
}

// "View candidates →" deep-link. Adds ?party=<id> param the candidates page
// will interpret on load and pre-fill the search box / filter.
function candidatesUrlFor(lineage) {
  const params = new URLSearchParams();
  // Use the lineage_id as the filter — the candidates page resolves it to
  // all member ids when filtering.
  params.set("party", lineage.id);
  return `./candidates?${params.toString()}`;
}

// "View on map →" for a single party-election appearance.
function mapUrlForAppearance(ap, lineage) {
  const params = new URLSearchParams();
  // Resolve election type via electionById, fall back to id-prefix.
  const elec = electionById.get(ap.election_id);
  const eType = elec?.type
    ?? (ap.election_id.startsWith("parl_") ? "parliamentary"
       : ap.election_id.startsWith("pres_") ? "presidential"
       : ap.election_id.startsWith("local_") ? "local"
       : ap.election_id.startsWith("adj_") ? "adjara" : null);
  if (eType) params.set("type", eType);
  if (ap.election_id) params.set("election", ap.election_id);
  if (eType === "local") {
    // For local: assume PR ballot (council) since that's where vote_share comes from.
    params.set("ballot", "council");
    params.set("vote", "pr");
    params.set("level", "selfgov");
  } else if (eType === "parliamentary" || eType === "adjara") {
    params.set("vote", "pr");
    params.set("level", "district");
  } else if (eType === "presidential") {
    params.set("level", "district");
  }
  params.set("party", ap.party_id);
  return `./elections?${params.toString()}`;
}
```

```js
// ── Reactive cell: rerender results panel ────────────────────────────────────
{
  const PAGE_SIZE = 30;
  const queryRaw   = (state.query ?? "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const queryTerms = queryRaw.split(" ").filter(Boolean);
  const pageNum    = state.page || 1;
  const filter     = state.filter || "all";
  const expanded   = state.expanded || new Set();

  // Update filter chip visuals
  filterRow.querySelectorAll(".cand-chip").forEach(el => {
    el.classList.toggle("cand-chip-active", el.dataset.filter === filter);
  });

  // Pre-filter by category, then by query.
  const filtered = index.lineages.filter((l, i) => {
    if (filter !== "all" && l.category !== filter) return false;
    if (queryTerms.length) {
      for (const term of queryTerms) {
        if (!corpus[i].includes(term)) return false;
      }
    }
    return true;
  });

  resultsPanel.innerHTML = "";

  if (filtered.length === 0) {
    resultsPanel.append(html`<p class="cand-prompt">${t("parties.no_results")}</p>`);
  } else {
  const countTpl = filtered.length === 1
    ? t("parties.results_count_one")
    : t("parties.results_count_other");
  const countLine = countTpl.replace("{n}",
    filtered.length.toLocaleString(lang === "ka" ? "ka-GE" : "en-US"));

  const end = Math.min(pageNum * PAGE_SIZE, filtered.length);
  const slice = filtered.slice(0, end);

  const rowsHtml = [];
  for (const l of slice) {
    const isOpen = expanded.has(l.id);
    const yearRange = (l.first_year && l.last_year && l.first_year !== l.last_year)
      ? `${l.first_year}–${l.last_year}`
      : (l.last_year ? String(l.last_year) : "—");
    const peakLine = l.peak_share
      ? `${(l.peak_share * 100).toFixed(1)}% (${l.peak_year ?? ""})`
      : "—";
    const idAttr = (l.id ?? "").toString();
    rowsHtml.push(html`
      <div class="cand-table-row ${isOpen ? "cand-row-expanded" : ""}" role="row">
        <div class="cand-table-cell" role="cell">
          <button class="cand-link" type="button" data-lid="${idAttr}" aria-expanded="${isOpen ? "true" : "false"}">
            <span class="cand-chevron">▶</span>
            <span class="party-color-bar" style="background:${l.color ?? "#ccc"}"></span>${partyDisplayName(l)}
          </button>
          <div class="party-meta-line">${t("parties.category." + (l.category || "other"))}</div>
        </div>
        <div class="cand-table-cell" role="cell">${yearRange}</div>
        <div class="cand-table-cell num" role="cell">${formatInt(l.election_count)}</div>
        <div class="cand-table-cell num" role="cell">${formatInt(l.candidate_count)}</div>
        <div class="cand-table-cell" role="cell">${peakLine}</div>
        <div class="cand-table-cell" role="cell">${renderSparkline(l.vote_share_series, l.color)}</div>
      </div>
    `);
    if (isOpen) {
      let content;
      if (!details) {
        content = html`<p class="cand-prompt" style="padding:0">…</p>`;
      } else {
        const appearances = details[l.id] ?? [];
        content = renderPartyAppearances(l, appearances);
      }
      rowsHtml.push(html`<div class="cand-row-detail" role="row" data-lid-detail="${idAttr}">${content}</div>`);
    }
  }

  const table = html`
    <div class="cand-table cand-table-parties" role="table">
      <div class="cand-table-row cand-table-head" role="row">
        <div class="cand-table-cell" role="columnheader">${t("parties.col_name")}</div>
        <div class="cand-table-cell" role="columnheader">${t("parties.col_active")}</div>
        <div class="cand-table-cell num" role="columnheader">${t("parties.col_elections")}</div>
        <div class="cand-table-cell num" role="columnheader">${t("parties.col_candidates")}</div>
        <div class="cand-table-cell" role="columnheader">${t("parties.col_peak")}</div>
        <div class="cand-table-cell" role="columnheader">${t("parties.col_trend")}</div>
      </div>
      ${rowsHtml}
    </div>
  `;
  table.addEventListener("click", ev => {
    const btn = ev.target.closest(".cand-link");
    if (btn) stateWidget.toggleExpand(btn.dataset.lid);
  });

  const pager = end < filtered.length
    ? html`<div class="cand-pager"><button type="button" class="cand-show-more">${t("candidates.show_more")}</button></div>`
    : "";
  if (pager) {
    pager.addEventListener("click", ev => {
      if (ev.target.classList.contains("cand-show-more")) stateWidget.bumpPage();
    });
  }

  resultsPanel.append(html`
    <div class="cand-count">${countLine}</div>
    ${table}
    ${pager}
  `);
  }
}
```

```js
// ── Lazy-load details when first row is opened ───────────────────────────────
let _detailsPromise = null;
function ensureDetails() {
  if (!_detailsPromise) _detailsPromise = FileAttachment("data/parties-details.json").json();
  return _detailsPromise;
}
const details = (state.expanded && state.expanded.size > 0) ? await ensureDetails() : null;
```

```js
// ── Helper that builds the per-election appearances table for one party.
function renderPartyAppearances(lineage, appearances) {
  const candidatesLink = html`<a href="${candidatesUrlFor(lineage)}">${t("parties.view_candidates")}</a>`;
  const summary = html`
    <div class="cand-detail-meta">
      <span>${t("parties.first_year")}: <strong>${lineage.first_year ?? "—"}</strong></span>
      <span>${t("parties.last_year")}: <strong>${lineage.last_year ?? "—"}</strong></span>
      <span>${t("parties.col_elections")}: <strong>${lineage.election_count}</strong></span>
      <span>${t("parties.col_candidates")}: <strong>${formatInt(lineage.candidate_count)}</strong></span>
      <span>${t("parties.elected_total")}: <strong>${formatInt(lineage.won_count)}</strong></span>
      <span>${candidatesLink}</span>
    </div>
  `;

  if (!appearances.length) {
    return html`${summary}<p class="cand-prompt">${t("parties.no_appearances")}</p>`;
  }

  const rows = appearances.map(ap => html`
    <div class="cand-table-row" role="row">
      <div class="cand-table-cell" role="cell">${ap.year ?? ""}</div>
      <div class="cand-table-cell" role="cell">${electionName(ap.election_id)}</div>
      <div class="cand-table-cell" role="cell">${ap.party_label_ka ?? ap.party_label_en ?? ""}</div>
      <div class="cand-table-cell num" role="cell">${formatVoteShare(ap.vote_share)}</div>
      <div class="cand-table-cell num" role="cell">${formatInt(ap.votes)}</div>
      <div class="cand-table-cell num" role="cell">${ap.won ? formatInt(ap.won) : ""}</div>
      <div class="cand-table-cell num" role="cell">${formatInt(ap.candidate_count)}</div>
      <div class="cand-table-cell" role="cell">${
        // Threshold only meaningful for parliamentary elections — local has
        // per-selfgov thresholds, so showing a single national status would
        // be misleading.
        ap.threshold_status && electionById.get(ap.election_id)?.type === "parliamentary"
          ? t("parties.threshold." + ap.threshold_status)
          : ""
      }</div>
      <div class="cand-table-cell" role="cell">${ap.election_id
        ? html`<a href="${mapUrlForAppearance(ap, lineage)}" target="_blank" rel="noopener">${t("candidates.view_on_map")}</a>`
        : ""}</div>
    </div>
  `);

  return html`
    ${summary}
    <div class="cand-table cand-table-pappear" role="table">
      <div class="cand-table-row cand-table-head" role="row">
        <div class="cand-table-cell" role="columnheader">${t("elections.year") || "Year"}</div>
        <div class="cand-table-cell" role="columnheader">${t("parties.col_election")}</div>
        <div class="cand-table-cell" role="columnheader">${t("parties.col_label")}</div>
        <div class="cand-table-cell num" role="columnheader">${t("parties.col_vote_share")}</div>
        <div class="cand-table-cell num" role="columnheader">${t("parties.col_votes")}</div>
        <div class="cand-table-cell num" role="columnheader">${t("parties.col_seats")}</div>
        <div class="cand-table-cell num" role="columnheader">${t("parties.col_candidates")}</div>
        <div class="cand-table-cell" role="columnheader">${t("parties.col_threshold")}</div>
        <div class="cand-table-cell" role="columnheader"></div>
      </div>
      ${rows}
    </div>
  `;
}
```
