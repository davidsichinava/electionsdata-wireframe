# Dashboard Review & Developer Refactor Plan

Senior-engineer review of the Georgia Elections dashboard (Observable Framework).
Scope of requested improvements: **(1) speed, (2) remove redundancy, (3) CSS → dedicated
modules, (4) JS functions → dedicated modules, (5) document all functions.**

---

## 0. Architecture snapshot (as-is)

| Area | File(s) | Size | State |
|------|---------|------|-------|
| Pages | `src/*.md` (7) | ~4 200 lines total | CSS embedded inline (see below) |
| Map engine | `src/components/election-map.js` | **1 876 lines** | One `buildElectionMap()` megafunction, ~50 inner fns |
| Renderers | `src/components/election-renderers.js` | 694 | Already extracted via `makeRenderers()` factory — good model |
| Pure utils | `src/components/election-utils.js` | 128 | Well documented — the template to follow |
| i18n/lang | `src/components/state.js` | 94 | `getLang`, `tr`, `LanguageSwitcher` |
| Shared CSS | `src/custom-style.css` | 666 | Design system, linked in config head — good |
| Data loaders | `src/data/*.json.js` (13) | small | Build-time YAML/CSV → JSON, manifest+lazy fetch |
| Build join | `src/data/config/candidates-build.js` | ~540 | Geo join, appearance resolution |

**CSS currently embedded in markdown (target for extraction):**

| Page | Total lines | CSS-in-`<style>` |
|------|------------:|-----------------:|
| `elections.md` | 1 750 | **617** |
| `candidates.md` | 836 | 240 |
| `parties.md` | 613 | 224 |
| `index.md` | 347 | 159 |
| `downloads.md` | 293 | 130 |
| `about.md` | 311 | 59 |
| `analysis.md` | 67 | 12 |
| **Total** | | **~1 441 lines of CSS living in `.md` files** |

The good news: `custom-style.css`, `election-utils.js`, and `election-renderers.js`
already establish the exact patterns we want to extend everywhere.

---

## 1. Bugs & correctness issues (fix first — independent of refactor)

### B1. Presidential featured-map showed all-grey districts — **FIXED**
`index.md` colored districts from the global `parties` registry, but presidential CSVs
key on candidate IDs (`zourabichvili`, `vashadze`) defined under YAML `candidates:`, not
`parties:`. Fixed by resolving `_featContestants` from `featured.candidates` for
presidential elections and sourcing both fill color and legend from it. Client-side only;
no data regen.

### B2. Duplicate, divergent selfgov-ID logic
- `election-utils.js` → `councilSelfgovIdFromMajorId(id)`: `n>=10000 ? /10000 : /100`, with `99` and `1–10` → `"1"`.
- `election-map.js:193` → `councilSelfgovIdFromDistrictId(id)`: `n>=1 && n<=10 ? 1 : n` (different branch logic).

These two can disagree for the same input. **Action:** delete the inner copy in
`election-map.js`, import the canonical `councilSelfgovIdFromMajorId`, and reconcile any
behavioral difference with a unit test fixture (Tbilisi=99, single-digit selfgov, 4-/5-/6-digit codes).

### B3. ka/en asymmetry in district-name resolution
`candidates-build.js` `appearanceFromCanonicalRow` (~lines 282–293): the **ka** name falls
back from row → geo, but the **en** name comes **only** from geo. When the geo join fails
(see B4), English district names silently go blank. **Action:** make the en path symmetric
(row → geo fallback) and treat blank en as a join-coverage metric in the build log.

### B4. `local_2017` district codes don't join the geojson (pending)
`majoritarian_2017_major_id.geojson` MIDs are 4-digit (`selfgov*100 + district`, Tbilisi=99);
the XLSX `elected`/`majoritarian` sheets carry 5/6-digit codes → **0% direct match**, so
`council_smd` / `elected` rows lose `district_name_en`. Agreed fix: a dedicated ingest
loader that re-encodes at ingest time (do **not** edit source files or the join logic).
Transform table:

| Source sheet | Rule → geo MID |
|---|---|
| majoritarian, non-Tbilisi | `floor(MID/100)` |
| majoritarian, Tbilisi (`self_gov_id==1`) | `99*100 + majoritarian_district` |
| elected, non-Tbilisi | `floor(major_id/100)` |
| elected, Tbilisi (`major_id` starts `99`) | `9900 + (major_id % 100)` |
| PR | `district_number` unchanged |
| mayor | no code → name lookup or blank |

Implement as `scripts/ingest-local2017.js` modeled on `scripts/ingest-local2025.js`, then
regenerate `local_2017_council_smd.csv` / `_elected.csv` (+pr/mayor) and verify
`district_name_en` coverage jumps to ~100%.

### B5. `local_2025` majoritarian code parsing (pending)
Codes like `"01.01"` must normalize via `parseInt(code.replace(/\./g,''),10)` → `101`,
with Tbilisi as selfgov 1. Fold into the 2025 ingest script.

---

## 2. Speed / performance

The featured-map loader optimization (`index-featured.json.js`, 12.9 MB+110 MB → ~1–2 MB)
is the right instinct. Extend that discipline:

- **P1. Audit per-page loader payloads.** `elections.md` chains `Promise.all` of 11 loaders.
  Confirm each is manifest-keyed + lazily fetched (as `csv-registry.json.js` is) and that no
  page pulls a full multi-MB registry when it needs one election. Add a build-time size log
  per emitted JSON.
- **P2. Cache hit-rate.** The CSV/GeoJSON LRU cache (`CSV_CACHE_MAX_ENTRIES = 20`) is good;
  instrument hits/misses in dev to confirm the cap isn't thrashing on the heaviest pages
  (precinct GeoJSON especially).
- **P3. GeoJSON weight.** Precinct shapes dominate transfer size. Pre-simplify geometries at
  build time (topojson/`mapshaper -simplify`) and serve simplified layers at low zoom,
  full detail only on drill-down.
- **P4. Defer the map.** Build the Leaflet instance after first paint (the IIFE already keys
  off `lang`); ensure tiles/large layers aren't blocking the results panel render.
- **P5. Reduce reactive re-runs.** Several control cells re-render the whole layout on
  language change. After the CSS extraction, language toggles should mutate text nodes
  (as `updateGlobalNavbar` already does) rather than rebuild Leaflet + panels.

---

## 3. Redundancy removal

- **R1. One copy of each pure helper.** `escapeHtml`, `formatCount`, `formatPct`, `geoId`,
  `getFeatureName`, `getDistrictBaseName` live inside `buildElectionMap`. Hoist to a new
  `src/components/format-utils.js` and import. (Pairs with §4.)
- **R2. Collapse B2's duplicate selfgov logic** (see above).
- **R3. Shared turnout/stat row builders.** `renderTurnoutPanel`, `renderPrecinctPanel`, and
  `renderTurnoutSummary` repeat the same `toLocaleString(lang...)` + metric-row markup.
  Already partly shared (`metricRow`, `statRow`); finish consolidating the snapshot/invalid/
  list rows into one `turnoutRows(td, cfg, lang, t)` helper.
- **R4. Candidate-label resolution** is duplicated verbatim in `renderDistrictPanel` and
  `renderPrecinctPanel` (`candidate_name_ka/en → candidate_name → name_ka`). Extract to one
  `candidateLabel(row, lang)`.
- **R5. CSS tokens.** After extraction, dedupe the repeated card/border/`--muted` inline
  styles against `custom-style.css` variables.

---

## 4. CSS → dedicated modules

**Goal:** zero `<style>` blocks in `.md`; all styling in linked CSS, keyed by stable class
names. ~1 441 lines to move.

Recommended structure (all linked via `observablehq.config.js` head, like `custom-style.css`):

```
src/styles/
  custom-style.css      (existing design system — keep)
  index.css             (.idx-* — from index.md, 159 lines)
  elections.css         (.elections-*, .bar-*, .dist-table, seat tiles… 617 lines)
  candidates.css        (240)
  parties.css           (224)
  downloads.css         (.data-card etc. 130)
  about.css             (59)
```

Process per page:
1. Cut the `<style>…</style>` block into the matching `.css` file **verbatim** first
   (no rewriting) — verify visual parity.
2. Then dedupe against `custom-style.css` variables in a second pass.
3. Keep class names identical so the markup is untouched.

**Gotcha (project rule):** never put backticks inside CSS/HTML comments that sit inside
`html\`…\`` template literals — it breaks template parsing. Moving CSS out of `.md` actually
*removes* this hazard, which is a bonus.

Order: smallest first (`about`, `downloads`, `index`) to validate the pipeline, then
`parties`, `candidates`, `elections` last.

---

## 5. JS functions → dedicated modules

`election-renderers.js`'s `makeRenderers({...})` factory is the proven pattern: pure-ish
functions bound to reactive state, imported by the page. Apply the same to the map.

Proposed split of `election-map.js` (1 876 lines):

```
src/components/
  format-utils.js     escapeHtml, formatCount, formatPct, geoId,
                      getFeatureName, getDistrictBaseName, selfgov-id (canonical)
  map-tooltips.js     tooltipFrame/Line/Subject, buildTurnoutTooltip,
                      buildResultTooltip*, bindDynamicTooltip
  map-precincts.js    precinct* family (stationId, key, parentId, enrichPrecinctRows…)
  map-selection.js    selectionKey, applySelectionHighlight, set/clearSelectedUnit,
                      register/applySelection, restoreSelectedUnitFromUrl
  map-layers.js       districtStyle, makeLayerStyle, buildLookups, addShare,
                      buildLegendHTML, boundsForFeatures, zoomToTbilisi
  election-map.js     buildElectionMap() orchestrator only — wires the above together
```

Rules:
- Extract **pure** functions first (format-utils), they have no closure deps.
- For stateful groups, mirror `makeRenderers`: a factory that takes the shared refs
  (`map`, `_mapCtrl`, `results`, `t`, `lang`, …) and returns the bound functions.
- One behavioral change per commit; keep `buildElectionMap`'s public signature stable.
- Add a thin barrel `src/components/index.js` only if import noise grows.

---

## 6. Documentation standard (document all functions)

`election-utils.js` is the reference style. Adopt JSDoc on every exported and non-trivial
inner function:

```js
/**
 * Map a raw majoritarian/major-district id to its parent selfgov id.
 * @param {string|number} id  district id from CSV or geojson props
 * @returns {string} selfgov id ("1" for Tbilisi / single-digit units)
 */
export function councilSelfgovIdFromMajorId(id) { … }
```

Minimum bar:
- Every `export` gets a JSDoc with `@param`/`@returns` and a one-line purpose.
- Each module starts with a header comment: what it owns, what state it expects.
- Data loaders (`*.json.js`) document their **output shape** (already done well in
  `index-featured.json.js` / `csv-registry.json.js` — match that).
- Non-obvious encodings (district-id schemes, threshold_status, vote_type values) get an
  inline note where first used.

---

## 7. Suggested execution order (low-risk → high)

1. **Bugs** B2–B5 (B1 done). Each is self-contained and testable.
2. **format-utils.js** extraction + JSDoc (enables R1/R2, no UI change).
3. **CSS extraction** page-by-page (about → downloads → index → parties → candidates → elections), visual-diff each.
4. **Map module split** (tooltips → precincts → selection → layers), one commit each.
5. **Renderer de-dup** R3/R4.
6. **Performance** P1–P5, measured before/after with the build-size + cache instrumentation.
7. **Documentation** pass alongside each extraction (not as a separate phase).

**Guardrails:** no commits without explicit request; verify visual/behavioral parity after
each extraction; keep public signatures (`buildElectionMap`, `makeRenderers`, loader output
shapes) stable so pages don't need rewrites.
```
