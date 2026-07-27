# Dashboard Review & Developer Refactor Plan

Senior-engineer review of the Georgia Elections dashboard (Observable Framework).
**Updated 2026-07-03** to add the loader-unification goals: pure-R data cleaning,
per-election loader pairs, standardized output schemas, and translation hygiene —
on top of the original five axes (speed, redundancy, CSS → modules, JS → modules,
documentation).

---

## 0. Architecture snapshot (as-is)

| Area | File(s) | Size | State |
|------|---------|------|-------|
| Pages | `src/*.md` (7) | ~4 200 lines total | CSS embedded inline (see §4) |
| Map engine | `src/components/election-map.js` | **1 876 lines** | One `buildElectionMap()` megafunction, ~50 inner fns |
| Renderers | `src/components/election-renderers.js` | 694 | Extracted via `makeRenderers()` factory — good model |
| Pure utils | `src/components/election-utils.js` | 128 | Well documented — the template to follow |
| i18n/lang | `src/components/state.js` | 94 | `getLang`, `tr`, `LanguageSwitcher` — **plus a hardcoded navDict (§7)** |
| Shared CSS | `src/custom-style.css` | 666 | Design system, linked in config head — good |
| OF build loaders | `src/data/*.json.js` (13) | small | Build-time YAML/CSV → JSON, manifest + lazy fetch |
| Build join | `src/data/config/candidates-build.js` | ~540 | Geo join, appearance resolution |
| **Results/turnout loaders** | `src/loaders/process_*.R` (**18**) | ~300–1 600 ea | One per election; raw XLSX → results/turnout CSVs |
| **Candidate ingest** | `scripts/ingest-*.js` (**9 node**) | ~300 ea | Raw XLSX → canonical candidate CSVs |
| Downloads generators | `src/loaders/downloads/*.js` (40 node) | small | Per-election XLSX bundles (exceljs) |
| Stray | `add_ka_2021.py` (root) | — | Orphan Python one-off — delete or archive |

**Measured messes (2026-07-03 audit):**
- 174 results CSVs → **36 distinct header signatures** (drift in `party_num`, `round`,
  `name_ka`, `precinct_key`, `raw_district_id`, `selfgov_id` vs `district_id`, column order).
- 19 election YMLs vs 18 R loaders vs 9 node ingests — three parallel per-election conventions.
- ~1 441 lines of CSS inside `.md` pages (breakdown in §4).
- `translations.json` is at full en/ka key parity (278/278) — but nav strings are hardcoded
  in `state.js`, and renderers carry inline English fallback literals.

---

## 1. Bugs & correctness issues (status)

### B1. Presidential featured-map grey districts — **FIXED**
`index.md` now resolves colors/legend from `featured.candidates` for presidential elections.

### B2. Duplicate, divergent selfgov-ID logic — **OPEN**
`election-utils.js` `councilSelfgovIdFromMajorId` vs `election-map.js:193`
`councilSelfgovIdFromDistrictId` (different branch logic; can disagree).
Delete the inner copy, import the canonical one, add a fixture test.
→ In R-unification terms this logic must also exist exactly once in the R layer (§3.4).

### B3. ka/en asymmetry in district-name resolution — **OPEN**
`candidates-build.js` `appearanceFromCanonicalRow`: ka falls back row → geo; en comes
**only** from geo. Make en symmetric; log join coverage at build time.

### B4. `local_2017` district codes don't join the geojson — **OPEN**
XLSX 5/6-digit codes vs 4-digit geo MIDs → 0 % join for council_smd/elected.
Agreed fix: re-encode at ingest (transform table in git history / earlier notes).
→ Fold into the standardized R candidate loader for 2017 (§3) rather than a one-off node script.

### B5. `local_2025` majoritarian code parsing — **OPEN**
`"01.01"` → `parseInt(code.replace(/\./g,''),10)` → `101`, Tbilisi as selfgov 1.
→ Same: implement inside the R candidate loader for 2025.

### B6. (new) 2014-style selfgov/major-ID traps — **PARTIALLY FIXED, generalize**
The 2014 fix (use explicit `selfgov_id` from the corrected XLSX; `maj_id =
selfgov_id*100 + seat`; never `map_city_selfgov()` when an explicit column exists)
must become a shared R helper so 2017/2021/2025 can't re-introduce it.

---

## 2. Guiding decision: one pipeline, R end-to-end for data cleaning

**Target:** for every election, all *data cleaning* is pure, portable R. Node remains
only where the Observable Framework build requires it (the thin `*.json.js` packaging
loaders) and — pending decision — the XLSX download bundles.

```
raw XLSX/CSV (CEC, NDI, …)
        │   R (one pair of scripts per election, shared helpers)
        ▼
canonical CSVs                      ← THE standardized interface (§3.2, §3.3)
  src/data/results/…                   results + turnout, one schema per level
  src/data/candidates/…                candidates + elected, one schema
        │   node (unchanged, thin)
        ▼
Observable build loaders (*.json.js) → dashboard
downloads generators (exceljs)       → XLSX bundles
```

Why this split: the `*.json.js` loaders don't *clean* anything — they walk YAML,
check files exist, and emit JSON manifests. Rewriting them in R buys no portability
(they are Framework-specific by nature) and Observable would happily run `.json.R`
loaders anyway if we ever want that. The cleaning layer — where humans add new
elections — is what must be R, uniform, and documented.

**Open questions for the owner (blocking §3 kickoff):** see end of document.

---

## 3. Loader unification (NEW — the largest pillar)

### 3.1 Per-election loader pair, uniform naming

Every election gets exactly two R entry points (plus shared helpers):

```
src/loaders/
  R/
    common/
      schema.R          # canonical column specs + validators (writes nothing)
      io.R              # read_cec_xlsx(), write_canonical_csv() (UTF-8, ordered cols)
      districts.R       # selfgov/major-ID encoders (B2/B6 logic, ONCE)
      parties.R         # party-label → party_id resolver against parties.yml + election YAML
      turnout.R         # shared turnout/derived-pct computations (round6, shares)
    elections/
      {election_id}_results.R      # raw → results + turnout CSVs
      {election_id}_candidates.R   # raw → candidate + elected CSVs
```

- `{election_id}` matches the YAML id (`local_2014`, `parl_2024`, …) — greppable 1:1.
- Each script: `Rscript src/loaders/R/elections/local_2014_results.R` from repo root,
  no arguments needed, idempotent, prints a row-count + validation summary.
- Existing 18 `process_*.R` migrate into `_results.R` files (mostly renames + moving
  duplicated helpers into `common/`); the 9 node `ingest-*.js` get ported to
  `_candidates.R` (parity-checked against current CSV output before deletion —
  same procedure as the earlier legacy→canonical candidate migration).
- The one-off root `add_ka_2021.py` is deleted after confirming its output is already
  committed.

### 3.2 Canonical results/turnout schema (kills the 36 signatures)

One schema per aggregation level, superset-style — columns always present, empty when
not applicable, **fixed order**:

| Level | File pattern | Columns (fixed order) |
|---|---|---|
| District/unit | `{eid}_{votetype}.csv` | `district_id, party_id, party_num, name_ka, round, votes, vote_share, registered, voted, voted_noon, voted_5pm, main_list, special_list, invalid_ballots, turnout_pct, noon_pct, five_pct, invalid_pct` |
| Precinct | `{eid}_{votetype}_precincts.csv` | `precinct_id, district_id, selfgov_id, precinct_number, party_id, party_num, name_ka, round, votes, vote_share, registered, voted, voted_noon, voted_5pm, invalid_ballots, turnout_pct, noon_pct, five_pct, invalid_pct` |
| Seats | `{eid}_seats.csv` | `selfgov_id, party_id, seats_pr, seats_smd, seats_mayor` |
| Turnout | `data/turnout/{eid}_…` | keep current shape, document it in schema.R |

- The `national` pseudo-row convention stays (documented).
- `schema.R` exposes `validate_results(df, level)` — every loader calls it before
  writing; CI-style check script (`scripts/validate-canonical.R`) re-validates the
  whole `src/data/results/` tree so drift is caught immediately.
- Renderers/map read only documented columns, so the superset change is additive;
  verify with a full build + spot checks per election after each migration.

### 3.3 Canonical candidate schema — already exists, becomes the R contract

`src/data/candidates/README.md` (16 columns) is already the standard; `schema.R`
encodes it as `validate_candidates(df)`. The `_candidates.R` loaders must reproduce
today's CSVs byte-comparably (modulo column-order normalization) before the node
ingests are retired. Keep `scripts/parity-check.js` (or port it) for this.

### 3.4 District/party helpers become single-source

- `districts.R`: `council_maj_id(selfgov_id, seat)`, Tbilisi rules, carved-out-town
  rules (2014/2017), `parse_dotted_code("01.01") → 101` (B5). Mirrors what
  `election-utils.js` does client-side; a small fixture CSV
  (`src/loaders/R/common/districts_fixtures.csv`) is tested from **both** R and JS
  so the two implementations can never diverge silently (resolves B2 permanently).
- `parties.R`: one normalizer (`ური→ული` etc.) + alias resolution against
  `parties.yml` and the election YAML — replaces the copy-pasted resolver in every
  node ingest.

### 3.5 Migration order (lowest-risk first)

1. ~~Scaffold `common/` + `schema.R` + validator script; baseline drift report.~~
   **DONE 2026-07-03.** `src/loaders/R/common/{schema,io,districts}.R` +
   `scripts/validate-canonical.R` + `src/loaders/R/README.md`. Baseline:
   district **0/92 exact (16 sigs)**, precinct **0/77 exact (20 sigs)**,
   seats **5/5 ✓**, canonical candidates **45/45 ✓**, 11 legacy candidate files
   to retire. Reports: `reports/schema-drift.csv`, `reports/schema-signatures.csv`.
   *Schema amendment while scaffolding:* `precinct_key` added to the precinct spec —
   it is load-bearing (`election-map.js` exact-key matching for by-elections).
   Confirmed loader-internal (droppable at migration): `raw_district_id`,
   `electoral_district_id`, `dd`/`pp`/`smd` (parl2016 debris), CSV-side
   `district_name_ka/en` (components read those from geojson props only).
2. Port candidate ingests to R one election at a time, parity-check, delete node twin.
   Start with `local_2021` or `adj2024` (smallest), end with `local_2014` (dual-pipeline,
   subtlest — see memory notes on selfgov encoding).
   **COMPLETE: 9/9 ported (2026-07-03), every output verified byte-identical (SHA-256);
   all `scripts/ingest-*.js` deleted. Zero node left in the candidate-cleaning layer.**
   - `adj_2024` (2 files), `adj_2008` (1), `parl_2020` (3), `parl_2016` (3),
     `local_2025` (4), `local_2021` (4), `local_2014` (5, incl. the
     selfgov*100+seat council-id recomposition), `presidential` (5 files / 4 elections,
     preserving the self-referencing id map + JS Map last-wins semantics),
     `parl_1919` (1).
   - `parl_1919`: committed CSV was STALE (XLSX re-edited after last node run);
     logic parity proven fresh-vs-fresh, CSV refreshed from R.
   - `parl_2016`: SOURCE DATA ERROR found — Elected sheet row 118 last_name
     "ელისაბედრულოვს" is missing its internal space (should be first "სანდრა ელისაბედ",
     last "რულოვს"). Committed CSV kept (it has the correct split); **fix the XLSX
     cell**, then `Rscript src/loaders/R/elections/parl_2016_candidates.R --apply`.
   Shared pieces: `common/parties.R` (resolver + `is_initiative_label` +
   `report_unresolved`), `common/candidates.R` (`col_or_blank`, `norm_name`,
   `split_name`, `split_historic_name`, `join_name`, `elected_flag`), `common/io.R`
   `read_xlsx_sheet()` (normalizes in-cell CRLF→LF exactly like exceljs) +
   `format_csv_d3()` (d3-compatible minimal quoting → hash-equality parity checks).
   Parity gotchas encoded in the helpers: JS `Number("")` is 0 (finite), JS `Map.set`
   last-wins, JS `??` vs `||` fallback semantics, prefix-only vs full initiative check.
   *Cross-language gotcha, now guarded:* R's `yaml` is YAML 1.1 (`id: yes/no` → logical)
   while node's js-yaml v4 is YAML 1.2 (string). The plebiscite option ids in
   `parties.yml` are now quoted (`id: "yes"`), and `make_party_resolver()` fails with an
   explicit message if an unquoted boolean-like id ever reappears.
3. Migrate `process_*.R` → `elections/{eid}_results.R` with `common/` helpers;
   normalize each election's output to the §3.2 schema; full build + visual spot
   check per election.
4. Only then: downloads generators decision (see Questions).

---

## 4. CSS → dedicated modules — **DONE (2026-07-03): zero `<style>` in any page**

All ~1 441 lines moved out of the 7 `.md` pages into `src/styles/`, linked
globally in the config `head` (Observable serves them as hashed `_file/styles/*`):

```
src/styles/
  index.css (158)  elections.css (617)  candidates.css  parties.css
  cand-shared.css  analysis.css (12)    about.css (59)  downloads.css (130)
```

Findings encoded in the extraction:
- **candidates.md and parties.md carried byte-identical copies of the entire
  candidate-table UI** (24 shared blocks) — deduplicated into `cand-shared.css`.
- Exactly ONE rule diverged between them (`.cand-row-detail .cand-detail-meta`):
  split into a common base + page variants scoped by new `.cand-grid-parties` /
  `.cand-grid-cands` modifier classes on each page's grid (only markup change).
- elections.md's generic-looking classes (.bar-row, .year-chips, .dist-table…)
  were verified to be emitted ONLY by election-renderers.js / election-map.js
  on the elections page — no other page's markup uses them, so global loading
  is collision-free. Design-system overrides (.card, .input-group) were already
  ancestor-scoped in the page CSS.
- Verified: live preview on index/elections/parties/candidates (computed styles,
  CSSOM scoped-rule presence, zero console errors) + clean build (54 links;
  parties page HTML shrank 35→30 kB).

---

## 5. JS functions → dedicated modules (unchanged plan, still pending)

Split `election-map.js` (1 876 lines) following the proven `makeRenderers()` pattern:

```
src/components/
  format-utils.js   escapeHtml, formatCount, formatPct, geoId, getFeatureName,
                    getDistrictBaseName, selfgov-id (canonical — pairs with §3.4 fixtures)
  map-tooltips.js   tooltipFrame/Line/Subject, buildTurnoutTooltip, buildResultTooltip*, bindDynamicTooltip
  map-precincts.js  precinct* family (stationId, keys, parentId, enrichPrecinctRows…)
  map-selection.js  selectionKey, highlight, set/clearSelectedUnit, URL restore
  map-layers.js     districtStyle, makeLayerStyle, buildLookups, addShare, legend, bounds/zoom
  election-map.js   buildElectionMap() orchestrator only
```
Pure functions first; one behavioral change per commit; `buildElectionMap` signature stable.
Also: consolidate `candidateLabel(row, lang)` and turnout-row builders in the renderers
(currently duplicated between district & precinct panels).

---

## 6. Speed (unchanged, augmented)

- P1 audit per-page loader payloads (elections.md `Promise.all` of 11).
- P2 LRU cache hit-rate instrumentation (`CSV_CACHE_MAX_ENTRIES = 20`).
- P3 pre-simplify precinct GeoJSON at build time; serve detail on drill-down.
- P4 defer Leaflet until after first paint.
- P5 language toggle should mutate text, not rebuild map/panels.
- **P6 (new):** schema standardization (§3.2) lets the CSV parser and lookups be
  simpler/faster — one column map instead of per-election special-casing.

---

## 7. Translations compatibility — **DONE (2026-07-03)**

- **T1 ✔** `state.js`'s `LanguageSwitcher` + `updateGlobalNavbar` + navDict were
  dead code with STALE values (referenced nowhere) — deleted; `state.js` now only
  exports `tr()` + `getLang()` (JSDoc'd) and runs `loadFonts()`. `header.html`'s
  inline navDict is kept deliberately as the no-flash fallback (applied before
  translations.json is fetched, which then wins) — annotated, and the checker
  fails if it drifts from translations.json.
- **T2 ✔** Zero missing keys found: every literal key referenced in source exists
  in translations.json; the `t(...) || "…"` fallbacks in renderers are inert
  safety nets. Georgian literals in `downloads/shared.js` are bilingual manifest
  DATA fields (sub_name_ka/en), not UI translations — intentionally left.
- **T3 ✔** `scripts/check-translations.js`: fails on en/ka divergence, missing
  referenced keys, header-fallback drift, or dynamic-key prefixes matching no key;
  reports unused keys (104 currently — report-only, since variable-key lookups
  are invisible to static scan) and unverifiable dynamic patterns (4).
- **T4 ✔** Key convention (`page.section.item`) documented in the checker header.
- Verified end-to-end in the live preview: ka→en toggle switches header AND page
  body (lang-change → getLang chain), zero console errors; full build clean
  (54 links). Also fixed `.claude/launch.json` to pin `--port 3001` (the preview
  panel pointed at 3001 while `observable preview` defaulted to 3000).

---

## 8. Documentation standard (unchanged)

JSDoc on every JS export (`election-utils.js` is the reference); roxygen-style
headers (`#' @param`, `#' @return`) on every R function in `common/`; each loader
starts with a header naming its raw inputs, outputs, and quirks. Loader README in
`src/loaders/R/` explains "how to add a new election" step by step — that is the
portability deliverable the R rewrite exists to serve.

---

## 9. Execution order (revised)

1. **Bugs** B2, B3 (small, self-contained). B4/B5 fold into §3 loaders.
2. **§3.1–3.2 scaffold**: `common/` + schema validators + drift report. No behavior change.
3. **Translations T1–T3** (small, independent, high hygiene value).
4. **CSS extraction** page-by-page (§4).
5. **Candidate loaders → R** election-by-election with parity checks (§3.5 step 2).
6. **Results loaders normalization** (§3.5 step 3) — the long tail, one election at a time.
7. **JS module split** (§5) + renderer de-dup.
8. **Speed passes** (§6), measured.
9. Docs (§8) ride along with every step, not at the end.

**Guardrails:** parity-check before deleting any working loader; full `npm run build`
+ spot check after each election migration; no commits without explicit request;
public signatures and canonical CSV paths stay stable throughout.

---

## Decisions (confirmed by owner, 2026-07-03)

1. **Scope of "pure R": cleaning layer only.** The 13 Observable `*.json.js` build
   loaders and the 40 exceljs download generators stay node — framework plumbing,
   not data cleaning.
2. **Node candidate ingests: port all 9 to R**, one election at a time, each
   parity-checked against current CSV output before its node twin is deleted.
3. **Canonical results schema: adopted as proposed in §3.2** (superset columns,
   fixed order, empty when N/A; district + precinct variants).
4. **R code shape: sourced `common/` scripts** under `src/loaders/R/common/` —
   zero install step, copy-the-folder portability.
