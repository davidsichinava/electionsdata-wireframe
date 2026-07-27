---
theme: [air, alt, wide]
title: Data Downloads
toc: false
---

```js
import * as d3 from "npm:d3";
import {getLang, tr} from "./components/state.js";

const dict      = await FileAttachment("data/config/translations.json").json();
const manifest  = await FileAttachment("data/downloads.json").json();
const lang = getLang();
```

```js
const t = k => tr(dict, lang, k);
```

```js
// ── Localised strings ──────────────────────────────────────────────────────
const Lx = {
  page_title:  t("data.downloads.page_title"),
  page_sub:    t("data.downloads.page_sub"),
  generated:   t("data.downloads.generated"),
  main_round:  t("data.downloads.main_round"),
  runoff:      t("data.downloads.runoff"),
  by_election: t("data.downloads.by_election"),
  download:    t("data.downloads.download"),
  no_data:     t("data.downloads.no_data"),
  files:       t("data.downloads.files"),
  format_note: t("data.downloads.format_note")
};
```

```js
// ── Data grouping ──────────────────────────────────────────────────────────
const TYPE_ORDER = ["parliamentary", "presidential", "local", "adjara", "plebiscite"];

function subLabel(entry) {
  const specific = lang === "ka" ? entry.sub_name_ka : entry.sub_name_en;
  if (entry.sub_id !== "__main__" && specific && specific !== "Main") return specific;
  if (entry.sub_type === "runoff")      return Lx.runoff;
  if (entry.sub_type === "by_election") return Lx.by_election;
  return Lx.main_round;
}

function formatSize(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000)     return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function formatGenerated(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(lang === "ka" ? "ka-GE" : "en-GB", {
      day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  } catch { return iso; }
}

// Group files: election_id → entries[], type → election_ids[]
const byElection = d3.group(manifest.files ?? [], d => d.election_id);

const idsByType = new Map();
for (const [elecId, entries] of byElection) {
  const type = entries[0]?.election_type ?? "other";
  if (!idsByType.has(type)) idsByType.set(type, []);
  idsByType.get(type).push(elecId);
}
for (const [, ids] of idsByType) {
  ids.sort((a, b) => {
    const da = byElection.get(a)?.[0]?.date ?? "";
    const db = byElection.get(b)?.[0]?.date ?? "";
    return da.localeCompare(db);
  });
}
```

```js
// ── Render ─────────────────────────────────────────────────────────────────
lang; // re-render on language change

// Download SVG icon — function so each call returns a fresh DOM node
const dlIcon = () => html`<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0;"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708z"/></svg>`;

// Each election → a card with year, name, and one download pill per sub
function renderElectionCard(elecId) {
  const entries = byElection.get(elecId) ?? [];
  if (!entries.length) return "";
  const first    = entries[0];
  const elecName = (lang === "ka" && first.label_ka) ? first.label_ka : first.label_en;
  const year     = (first.date ?? "").slice(0, 4);

  // _file/?sha= only exists in Observable Framework dev server.
  // In production (GitHub Pages) files are at their direct path.
  const isDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const fileUrl = (entry) => isDev
    ? `_file/data/downloads/${entry.filename}?sha=${entry.sha}`
    : `data/downloads/${entry.filename}`;

  const pills = entries.map(entry => html`
    <a class="dl-pill" href="${fileUrl(entry)}" download="${entry.filename}" title="${entry.filename}" aria-label="${Lx.download}: ${subLabel(entry)}">
      ${dlIcon()}
      <span class="dl-pill-label">${subLabel(entry)}</span>
      <span class="dl-pill-size">${formatSize(entry.size_bytes)}</span>
    </a>`);

  return html`<div class="dl-card">
    <div class="dl-card-head">
      <span class="dl-card-year">${year}</span>
      <span class="dl-card-name">${elecName}</span>
    </div>
    <div class="dl-card-pills">${pills}</div>
  </div>`;
}

// Each type → a <details> accordion containing election cards
function renderTypeAccordion(typeKey) {
  const ids = idsByType.get(typeKey);
  if (!ids?.length) return "";
  const typeLabel = t(`type.${typeKey}`) || typeKey;
  const count = ids.length;

  return html`<details class="dl-accordion">
    <summary class="dl-accordion-summary">
      <span class="dl-accordion-chevron">▸</span>
      <span class="dl-accordion-label">${typeLabel}</span>
      <span class="dl-accordion-count">${count}</span>
    </summary>
    <div class="dl-cards-grid">
      ${ids.map(id => renderElectionCard(id))}
    </div>
  </details>`;
}

const hasFiles = (manifest.files ?? []).length > 0;

const page = html`

<div class="dl-page">

  <div class="card" style="padding:1rem 1.25rem; margin-bottom:1.25rem;">
    <h2 style="margin:0 0 0.4rem;">${Lx.page_title}</h2>
    <p style="margin:0;color:var(--muted);font-size:0.86rem;max-width:740px;line-height:1.55;">${Lx.page_sub}</p>
  </div>

  <div class="dl-meta-row">
    <span>${Lx.generated}: ${formatGenerated(manifest.generated)}</span>
    <span>${(manifest.files ?? []).length} ${Lx.files}</span>
  </div>

  ${hasFiles
    ? html`<div>${TYPE_ORDER.map(k => renderTypeAccordion(k))}</div>
           <p class="dl-format-note">${Lx.format_note}</p>`
    : html`<p style="color:var(--muted);padding:2rem 0;">${Lx.no_data}</p>`}

</div>
`;

display(page);
```
