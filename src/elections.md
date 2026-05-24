---
theme: [air, alt, wide]
title: Elections
toc: false
---

```js
import L from "npm:leaflet";
import * as d3 from "npm:d3";
import {getLang, tr} from "./components/state.js";
import {dhondtSeats, makePartyLookup, turnoutValue, turnoutNorm, seatsFor, partiesForFilter, fetchTextAsset, fetchJSONAsset} from "./components/election-utils.js";
import {makeRenderers} from "./components/election-renderers.js";
import {buildElectionMap} from "./components/election-map.js";

// configs — YAML→JSON loaders in src/data/*.json.js
const dict     = await FileAttachment("data/config/translations.json").json();
const elections = await FileAttachment("data/elections.json").json();
const parties   = await FileAttachment("data/parties.json").json();
```

```js
// ── Language — reactive (re-runs the whole chain when user switches) ───────
const lang = getLang();
```

```js
// ── t() translation helper — re-creates when lang or dict changes ──────────
const t = k => tr(dict, lang, k);
```

```js
// ── Stable selection state — no deps, runs once, survives language re-renders ──
const _urlParams    = new URLSearchParams(window.location.search);
const _typeCtrl     = {value: _urlParams.get("type") ?? "parliamentary"};
const _electionCtrl = {value: _urlParams.get("election") ?? null};
const _subCtrl      = {value: _urlParams.get("sub") ?? "__main__"};
const _ballotCtrl   = {value: _urlParams.get("ballot") ?? "mayor"};
const _voteCtrl     = {value: _urlParams.get("vote") ?? null};
const _mapModeCtrl  = {value: _urlParams.get("map") ?? "geographic"};
const _levelCtrl    = {value: _urlParams.get("level") ?? null};
const _partyCtrl    = {value: _urlParams.get("party") ?? null};
const _selectedUnitLevelCtrl = {value: _urlParams.get("unit_level") ?? null};
const _selectedUnitCtrl      = {value: _urlParams.get("unit") ?? null};

function updateUrlParams(updates = {}, deletes = []) {
  const p = new URLSearchParams(window.location.search);
  for (const key of deletes) p.delete(key);
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "" || value === "__default__") p.delete(key);
    else p.set(key, value);
  }
  if (deletes.includes("unit_level")) _selectedUnitLevelCtrl.value = null;
  if (deletes.includes("unit")) _selectedUnitCtrl.value = null;
  if (Object.prototype.hasOwnProperty.call(updates, "unit_level")) _selectedUnitLevelCtrl.value = updates.unit_level ?? null;
  if (Object.prototype.hasOwnProperty.call(updates, "unit")) _selectedUnitCtrl.value = updates.unit ?? null;
  const query = p.toString();
  history.replaceState(null, "", `${window.location.pathname}${query ? "?" + query : ""}${window.location.hash}`);
}
```

```js
// ── DERIVED: election list for the type selector ──────────────────────────
const parlElections = elections.filter(e => e.type === "parliamentary");

const typeInput = Inputs.select(
  ["parliamentary", "presidential", "local", "adjara", "plebiscite"],
  { format: k => t(`type.${k}`), value: _typeCtrl.value }
);
typeInput.addEventListener("input", () => {
  _typeCtrl.value = typeInput.value;
  updateUrlParams({type: typeInput.value}, ["election", "sub", "ballot", "vote", "view", "metric", "map", "level", "party", "unit_level", "unit", "lat", "lng", "z"]);
});
const typeVal = Generators.input(typeInput);
```

```js
// ── Chip-row input — generic widget used for both election and sub-election pickers ─
// Custom DOM element with a `.value` property and "input" events, so
// Generators.input() picks it up exactly like a native Inputs.select would.
// `labelFn(item) -> { short, full }` controls the chip text and tooltip.
function makeChipsInput(items, labelFn, initialValue) {
  const container = html`<div class="year-chips" role="radiogroup"></div>`;
  container.value = initialValue;
  function render() {
    container.innerHTML = "";
    for (const item of items) {
      const {short, full} = labelFn(item);
      const isActive = container.value?.id === item.id;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "year-chip" + (isActive ? " active" : "");
      chip.textContent = short;
      chip.title = full;
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", isActive ? "true" : "false");
      chip.setAttribute("aria-label", full);
      chip.addEventListener("click", () => {
        if (container.value?.id === item.id) return;
        container.value = item;
        render();
        container.dispatchEvent(new Event("input"));
      });
      container.appendChild(chip);
    }
  }
  render();
  return container;
}

// Election chips: show only the year. If two elections share a year (e.g. an
// early parliamentary election after dissolution), the colliding chips get a
// month suffix so they remain distinguishable.
function makeYearChipsInput(items, initialValue) {
  const yearCounts = items.reduce((m, e) => {
    const y = (e.date ?? "").slice(0, 4);
    if (y) m.set(y, (m.get(y) ?? 0) + 1);
    return m;
  }, new Map());
  function label(e) {
    const full = e.name?.[lang] ?? e.name?.en ?? e.id;
    const year = (e.date ?? "").slice(0, 4);
    if (!year) return {short: e.id, full};
    if ((yearCounts.get(year) ?? 0) <= 1) return {short: year, full};
    const monthShort = new Date(e.date).toLocaleDateString(
      lang === "ka" ? "ka-GE" : "en-US",
      { month: "short" }
    );
    return {short: `${year} · ${monthShort}`, full};
  }
  return makeChipsInput(items, label, initialValue);
}

const filteredElections = elections
  .filter(e => e.type === typeVal)
  .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

const _restoredElec = filteredElections.find(e => e.id === _electionCtrl.value) ?? filteredElections[0];
const electionInput = makeYearChipsInput(filteredElections, _restoredElec);
electionInput.addEventListener("input", () => {
  _electionCtrl.value = electionInput.value?.id ?? null;
  updateUrlParams(
    {election: electionInput.value?.id ?? null},
    ["sub", "ballot", "vote", "view", "metric", "map", "level", "party", "unit_level", "unit", "lat", "lng", "z"]
  );
});
const electionVal = Generators.input(electionInput);
```

```js
// ── Ballot type toggle — local elections only: Mayor vs Sakrebulo ─────────
const isLocal    = electionVal?.type === "local";
const hasCouncil = isLocal && !!(electionVal?.files?.council_pr_results);

const ballotTypeInput = Inputs.radio(
  hasCouncil ? ["mayor", "council"] : ["mayor"],
  { value: (hasCouncil && _ballotCtrl.value === "council") ? "council" : "mayor",
    format: k => k === "mayor" ? t("elections.local.mayor") : t("elections.local.council") }
);
ballotTypeInput.addEventListener("input", () => {
  _ballotCtrl.value = ballotTypeInput.value;
  updateUrlParams({ballot: isLocal ? ballotTypeInput.value : null}, ["level", "party", "unit_level", "unit", "lat", "lng", "z"]);
});
const ballotTypeVal = Generators.input(ballotTypeInput);
```

```js
// ── Sub-election picker — chip row (runoffs / by-elections / repeated / etc.)
const isPlebisciteEarly = electionVal?.type === "plebiscite"; // early flag for sub-election setup
const subElections = isPlebisciteEarly
  ? (electionVal?.questions ?? [])
  : (electionVal?.sub_elections ?? []);
const hasSubElections = subElections.length > 0;

// Plebiscite: questions only (no __main__ option). All others: prepend a
// synthetic "Main" entry so the user can return from a sub back to the parent.
const subElectionItems = isPlebisciteEarly
  ? subElections
  : [{id: "__main__", name: {en: t("elections.sub_election.main"), ka: t("elections.sub_election.main")}}, ...subElections];

// Chip label: "Main" stays plain; runoff/by-election/repeated get a localized
// type prefix and a short month-year date so similar entries are distinguishable
// (e.g. "By-election · May 2018" vs "By-election · Oct 2019"). For plebiscite
// questions, fall back to the YAML name (no type info to lean on).
function _subChipLabel(item) {
  const full = item.name?.[lang] ?? item.name?.en ?? item.id;
  if (item.id === "__main__") {
    return {short: full, full};
  }
  if (!item.type) {
    // Plebiscite question — keep the name; truncate the chip if very long.
    const short = full.length > 26 ? full.slice(0, 24).trimEnd() + "…" : full;
    return {short, full};
  }
  const date = item.date ?? electionVal?.date;
  const dateLabel = date
    ? new Date(date).toLocaleDateString(
        lang === "ka" ? "ka-GE" : "en-US",
        { month: "short", year: "numeric" }
      )
    : "";
  const typeLabel = t(`elections.sub_type.${item.type}`) || item.type;
  return {
    short: dateLabel ? `${typeLabel} · ${dateLabel}` : typeLabel,
    full
  };
}

// Wraps a chip-row input in a <details> that shows the current selection in
// its <summary>. Proxies `.value` and "input" events so the wrapper is a
// drop-in replacement: external code (Generators.input, the click handler)
// still sees a single element with the same surface as the bare chip widget.
//
// `defaultOpen` controls the initial expanded state. Useful default: open for
// short lists (2-3 chips fit comfortably alongside everything else), collapsed
// for long lists so they don't dominate the filter column. When defaultOpen
// is false, picking a chip auto-collapses the details — letting it behave
// like a dropdown picker.
function wrapChipsInDetails(chipWidget, labelFn, defaultOpen) {
  const summaryText = document.createElement("span");
  summaryText.className = "chip-summary-text";
  const summary = html`<summary class="chip-summary"></summary>`;
  summary.appendChild(summaryText);
  const details = html`<details class="chip-details">${summary}${chipWidget}</details>`;
  if (defaultOpen) details.open = true;
  Object.defineProperty(details, "value", {
    get() { return chipWidget.value; },
    set(v) { chipWidget.value = v; }
  });
  function refreshSummary() {
    summaryText.textContent = chipWidget.value ? labelFn(chipWidget.value).short : "";
  }
  refreshSummary();
  chipWidget.addEventListener("input", () => {
    refreshSummary();
    if (!defaultOpen) details.open = false;
    details.dispatchEvent(new Event("input"));
  });
  return details;
}

const _restoredSub = subElectionItems.find(e => e.id === _subCtrl.value) ?? subElectionItems[0];
const _subChipWidget = makeChipsInput(subElectionItems, _subChipLabel, _restoredSub);
// Long sub-election lists (e.g. local_2017 has 7 items) collapse by default to
// keep the filter column compact; short lists stay open for quick switching.
const subElectionInput = wrapChipsInDetails(_subChipWidget, _subChipLabel, subElectionItems.length <= 3);
subElectionInput.addEventListener("input", () => {
  _subCtrl.value = subElectionInput.value?.id ?? "__main__";
  updateUrlParams({sub: _subCtrl.value === "__main__" ? null : _subCtrl.value}, ["level", "party", "unit_level", "unit", "lat", "lng", "z"]);
});
const subVal = Generators.input(subElectionInput);
```

```js
// ── Vote type toggle — derived from sub_type ─────────────────────────────
const subType  = electionVal?.sub_type ?? "pr";  // pr | mixed | messy
const hasPR    = electionVal?.system?.pr?.enabled !== false;
const hasSMD   = electionVal?.system?.smd?.enabled;
const hasComp  = electionVal?.system?.compensation?.enabled;

const voteTypeOptions = [
  ...(hasPR   ? ["pr"]           : []),
  ...(hasSMD  ? ["smd"]          : []),
  ...(hasComp ? ["compensation"] : [])
];

// Default vote type — priority: URL ?vote=… > YAML map_view.default_vote_type > first option.
// The YAML hint is ignored if it isn't a valid option for the current election
// (e.g. an election with PR disabled can't default to "pr").
const _yamlDefaultVote = electionVal?.map_view?.default_vote_type;
const _initialVoteType = voteTypeOptions.includes(_voteCtrl.value)
  ? _voteCtrl.value
  : voteTypeOptions.includes(_yamlDefaultVote)
    ? _yamlDefaultVote
    : (voteTypeOptions[0] ?? "pr");

const voteTypeInput = Inputs.radio(voteTypeOptions, {
  value: _initialVoteType,
  format: k => ({
    pr:           t("elections.vote_type.party_list"),
    smd:          t("elections.vote_type.smd"),
    compensation: t("elections.vote_type.compensation")
  })[k]
});
voteTypeInput.addEventListener("input", () => {
  _voteCtrl.value = voteTypeInput.value;
  updateUrlParams({vote: voteTypeInput.value}, ["level", "party", "unit_level", "unit", "lat", "lng", "z"]);
});
const voteTypeVal = Generators.input(voteTypeInput);
```

```js
// ── Election type flags ───────────────────────────────────────────────────
const isPresidential  = electionVal?.type === "presidential";
const isIndirect      = isPresidential && electionVal?.sub_type === "indirect";
const isPlebiscite    = electionVal?.type === "plebiscite";
const isCouncilMode   = isLocal && ballotTypeVal === "council";

// Runoffs/by-elections in parliamentary elections are always SMD — force "smd" and hide the toggle
const isSubElectionSMD = !isPresidential && !isPlebiscite &&
  subVal?.id !== "__main__" &&
  (subVal?.type === "runoff" || subVal?.type === "by_election" ||
   (subVal?.type === "repeated" && !!(subVal?.files?.smd_results || subVal?.files?.smd_precinct_results)));
// Repeated parliamentary votes may be PR-only in annulled precincts — force "pr" and hide the toggle
const isSubElectionPR = !isPresidential && !isPlebiscite &&
  subVal?.id !== "__main__" &&
  subVal?.type === "repeated" && !isSubElectionSMD;
const effectiveVoteType = isSubElectionSMD ? "smd"
  : isSubElectionPR ? "pr"
  : (isLocal && ballotTypeVal === "mayor") ? "smd"
  : voteTypeVal;
```

```js
// ── Map mode ──────────────────────────────────────────────────────────────
const mapModeInput = Inputs.radio([
  "geographic",
  // "cartogram", // Hidden while cartogram views are being redesigned.
], {
  value: _mapModeCtrl.value === "cartogram" ? "cartogram" : "geographic",
  format: k => k === "geographic" ? t("elections.mode.geo") : t("elections.mode.cart")
});
mapModeInput.addEventListener("input", () => {
  _mapModeCtrl.value = mapModeInput.value;
  updateUrlParams({map: mapModeInput.value === "geographic" ? null : mapModeInput.value}, ["level", "party", "unit_level", "unit", "lat", "lng", "z"]);
});
const mapMode = Generators.input(mapModeInput);
```

```js
// ── Map granularity (district / council-district / precinct) ─────────────
const hasPrecinct = !!(
  effectiveVoteType === "smd"          ? electionVal?.system?.smd?.precinct_shape_file
  : effectiveVoteType === "compensation" ? electionVal?.system?.compensation?.precinct_shape_file
  : electionVal?.system?.pr?.precinct_shape_file
);
// Council mode only: majoritarian district layer — only when SMD vote type is selected
const hasCouncilDistricts = isCouncilMode && effectiveVoteType === "smd" && !!(electionVal?.council?.shape_file);
// Self-governing unit level (local 2025+): available when pr.selfgov_shape_file is set
const hasSelfGov = isLocal && !!(electionVal?.system?.pr?.selfgov_shape_file);

```

```js
// ── Stable state objects — each in its own no-dep cell so they run ONCE and survive re-renders ──
const _viewModeCtrl    = {value: ["results", "turnout"].includes(_urlParams.get("view")) ? _urlParams.get("view") : "results"};  // persists view mode across language switches
```

```js
// ── View mode: Results vs Turnout ─────────────────────────────────────────
const hasTurnout = !!(electionVal?.turnout?.available);

// Rebuild viewModeInput on lang change — restore previous selection from _viewModeCtrl
const viewModeInput = Inputs.radio(["results", "turnout"], {
  value: _viewModeCtrl.value,
  format: k => k === "results" ? t("elections.view_mode.results") : t("elections.view_mode.turnout")
});
viewModeInput.addEventListener("input", () => {
  _viewModeCtrl.value = viewModeInput.value;
  updateUrlParams({view: viewModeInput.value === "results" ? null : viewModeInput.value}, ["party", "unit_level", "unit"]);
});
const viewMode = Generators.input(viewModeInput);
```

```js
// ── Turnout metric — controlled imperatively via _mapCtrl (like party filter) ─
const _turnoutMetrics = ["final", "noon", "5pm", "invalid"];
const _turnoutMetricCtrl = {value: _turnoutMetrics.includes(_urlParams.get("metric")) ? _urlParams.get("metric") : "final"};  // mutated by setTurnoutMetric
```

```js
// ── Seat filter (combined / pr / smd) ─────────────────────────────────────
const seatFilterOptions = ["all",
  ...(hasPR && hasSMD || (isLocal && ballotTypeVal === "council") ? ["pr", "smd"] : [])
];
const seatFilterInput = Inputs.radio(seatFilterOptions, {
  value: "all",
  format: k => ({
    all: t("elections.seat_filter.all"),
    pr:  t("elections.seat_filter.pr"),
    smd: t("elections.seat_filter.smd")
  })[k]
});
const seatFilter = Generators.input(seatFilterInput);
```

```js
// Data registries — auto-assembled from election YAMLs by data loaders.
// To add a new election: create the YAML + data files, then restart dev server. No changes needed here.
const _geoRegistryUrl     = await FileAttachment("data/geo-registry.json").url();
const _csvRegistryUrl     = await FileAttachment("data/csv-registry.json").url();
const _turnoutRegistryUrl = await FileAttachment("data/turnout-registry.json").url();
const _occupiedGeo        = await FileAttachment("data/shp/occupied_territories.geojson").json();
// Precinct registries — fetched lazily on first precinct level activation.
// The GeoJSON and CSV registries are YAML-derived manifests; selected precinct files are fetched separately.
const _precinctGeoRegistryUrl = await FileAttachment("data/precinct-geo-registry.json").url();
const _precinctCsvRegistryUrl = await FileAttachment("data/precinct-csv-registry.json").url();

// Generic manifest-backed CSV loader.
// Used for both the main results registry and the turnout registry — each has
// its own manifest URL + cache, but the fetch/parse logic is identical.
// Cache is bounded with an LRU policy so long browsing sessions don't grow
// unbounded — Maps iterate in insertion order, so re-inserting an entry on
// hit moves it to the "newest" end and the oldest entry is the eviction target.
const CSV_CACHE_MAX_ENTRIES = 20;
function makeCsvManifestLoader(registryUrl) {
  const cache = { manifest: null, rowsByPath: new Map() };
  return async function loadByPath(path) {
    if (!path) return [];
    if (!cache.manifest) {
      cache.manifest = await fetchJSONAsset(registryUrl);
    }
    const assetPath = cache.manifest[path];
    if (!assetPath) return [];

    // LRU touch — re-insertion moves the entry to the newest position.
    if (cache.rowsByPath.has(assetPath)) {
      const existing = cache.rowsByPath.get(assetPath);
      cache.rowsByPath.delete(assetPath);
      cache.rowsByPath.set(assetPath, existing);
      return existing;
    }

    // Miss: fetch + cache; evict oldest entries until under the cap.
    const promise = fetchTextAsset(assetPath)
      .then(text => d3.csvParse(text, d3.autoType))
      .catch(error => {
        cache.rowsByPath.delete(assetPath);
        throw error;
      });
    cache.rowsByPath.set(assetPath, promise);
    while (cache.rowsByPath.size > CSV_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.rowsByPath.keys().next().value;
      cache.rowsByPath.delete(oldestKey);
    }
    return promise;
  };
}

const loadCSVPath     = makeCsvManifestLoader(_csvRegistryUrl);
const loadTurnoutPath = makeCsvManifestLoader(_turnoutRegistryUrl);

const _geoRegistryCache = {
  manifest: null,
  geoByPath: new Map()
};

async function loadGeoJSON(elec, vt, level) {
  let path;
  if (level === "council_district") {
    path = elec?.council?.shape_file;
  } else if (level === "selfgov") {
    path = elec?.system?.pr?.selfgov_shape_file;
  } else if (level === "precinct") {
    const ppath = vt === "smd"          ? elec?.system?.smd?.precinct_shape_file
                : vt === "compensation" ? elec?.system?.compensation?.precinct_shape_file
                : elec?.system?.pr?.precinct_shape_file;
    path = ppath ?? (vt === "smd" ? elec?.system?.smd?.shape_file
                  : vt === "compensation" ? elec?.system?.compensation?.shape_file
                  : elec?.system?.pr?.shape_file);
  } else {
    path = vt === "smd"          ? elec?.system?.smd?.shape_file
         : vt === "compensation" ? elec?.system?.compensation?.shape_file
         : (elec?.system?.pr?.shape_file ?? elec?.system?.smd?.shape_file); // fallback for PR-disabled elections
  }
  if (!path) return null;

  if (!_geoRegistryCache.manifest) {
    _geoRegistryCache.manifest = await fetchJSONAsset(_geoRegistryUrl);
  }

  const assetPath = _geoRegistryCache.manifest[path];
  if (!assetPath) return null;

  if (!_geoRegistryCache.geoByPath.has(assetPath)) {
    const promise = fetchJSONAsset(assetPath).catch(error => {
      _geoRegistryCache.geoByPath.delete(assetPath);
      throw error;
    });
    _geoRegistryCache.geoByPath.set(assetPath, promise);
  }

  return _geoRegistryCache.geoByPath.get(assetPath);
}

async function loadResults(elec, vt, sub, level, ballotType) {
  const isSubActive = sub?.id !== "__main__";

  // Council ballot type: load council-specific files
  if (ballotType === "council") {
    if (level === "selfgov") {
      // Self-governing unit level for council PR
      return loadCSVPath(elec?.files?.pr_selfgov_results ?? elec?.files?.council_pr_results);
    }
    if (level === "council_district") {
      // Sub-election override (e.g. runoff)
      if (isSubActive && vt === "smd" && sub?.files?.council_smd_results)
        return loadCSVPath(sub.files.council_smd_results);
      const path = vt === "smd"
        ? elec?.files?.council_smd_results
        : elec?.files?.council_pr_results;
      return loadCSVPath(path);
    }
    if (level === "precinct") {
      // Sub-election override
      if (isSubActive && vt === "smd" && sub?.files?.council_smd_precinct_results)
        return loadCSVPath(sub.files.council_smd_precinct_results);
      const path = vt === "smd"
        ? (elec?.files?.council_smd_precinct_results ?? elec?.files?.council_smd_results)
        : (elec?.files?.council_pr_precinct_results  ?? elec?.files?.council_pr_results);
      return loadCSVPath(path);
    }
    // District level fallthrough — sub-election override
    if (isSubActive && vt === "smd" && sub?.files?.council_smd_results)
      return loadCSVPath(sub.files.council_smd_results);
    const path = vt === "smd"
      ? elec?.files?.council_smd_results
      : elec?.files?.council_pr_results;
    return loadCSVPath(path);
  }
  if (level === "selfgov") {
    // Self-governing unit level for mayor — sub-election override (e.g. mayor runoff)
    if (isSubActive && vt === "smd" && sub?.files?.smd_results)
      return loadCSVPath(sub.files.smd_results);
    const path = vt === "smd" ? elec?.files?.smd_results : elec?.files?.pr_selfgov_results;
    return loadCSVPath(path);
  }
  if (isSubActive) {
    if (level === "precinct") {
      const subPrecinct = sub?.files?.smd_precinct_results ?? sub?.files?.pr_precinct_results;
      if (subPrecinct) return loadCSVPath(subPrecinct);
    }
    // Mayor district level: prefer Tbilisi-expanded district file if available
    if (ballotType === "mayor" && level === "district" && sub?.files?.smd_district_results)
      return loadCSVPath(sub.files.smd_district_results);
    const subPath = sub?.files?.smd_results ?? sub?.files?.pr_results ?? sub?.files?.results;
    if (subPath) return loadCSVPath(subPath);
  }
  if (level === "precinct") {
    const path = vt === "smd"
      ? (elec?.files?.smd_precinct_results ?? elec?.files?.smd_results)
      : (elec?.files?.pr_precinct_results  ?? elec?.files?.pr_results);
    return loadCSVPath(path);
  }
  // Mayor district level: use CEC-district-indexed file (Tbilisi expanded to districts 1–10)
  // instead of selfgov-indexed smd_results (where Tbilisi=1 would leave districts 2–10 uncoloured)
  const path = (ballotType === "mayor" && level === "district" && elec?.files?.smd_district_results)
    ? elec.files.smd_district_results
    : vt === "smd"          ? elec?.files?.smd_results
    : vt === "compensation" ? elec?.files?.compensation_results
    : elec?.files?.pr_results;
  return loadCSVPath(path);
}

async function loadTurnout(elec, level) {
  if (!elec?.turnout?.available) return [];
  const path = (level === "precinct" && elec.turnout.precinct_file)
    ? elec.turnout.precinct_file
    : elec.turnout.file;
  return loadTurnoutPath(path);
}

// For all local modes, use PR shapefile (electoral districts) for the district layer.
// Mayor elections were previously using the SMD (selfgov) shapefile, which rendered selfgov
// outlines instead of CEC electoral district outlines at the district level.
const _geoVt = isLocal ? "pr" : effectiveVoteType;
// Seats CSV is consulted for the seat chart in council mode and mayor mode.
const _needsSeatsData = isCouncilMode || (isLocal && ballotTypeVal === "mayor");

// Precinct paths — purely synchronous; resolved once per election + sub + vote-type change.
// Precinct geo/results CSVs are lazy-loaded in election-map.js when the user picks the precinct level.
function _getPrecinctPaths(elec, vt, sub, ballotType) {
  if (!elec) return { geoPath: null, csvPath: null };
  const isSubActive = sub?.id !== "__main__";
  const geoPath = vt === "smd"          ? elec?.system?.smd?.precinct_shape_file
                : vt === "compensation" ? elec?.system?.compensation?.precinct_shape_file
                : elec?.system?.pr?.precinct_shape_file;
  const subGeoPath = isSubActive
    ? (sub?.files?.precinct_shape_file ?? sub?.precinct_shape_file ?? null)
    : null;
  let csvPath;
  if (ballotType === "council") {
    csvPath = (isSubActive && vt === "smd" && sub?.files?.council_smd_precinct_results)
      ? sub.files.council_smd_precinct_results
      : vt === "smd" ? elec?.files?.council_smd_precinct_results : elec?.files?.council_pr_precinct_results;
  } else if (isSubActive) {
    csvPath = sub?.files?.smd_precinct_results ?? sub?.files?.pr_precinct_results ?? null;
  } else {
    csvPath = vt === "smd" ? elec?.files?.smd_precinct_results : elec?.files?.pr_precinct_results;
  }
  return { geoPath: subGeoPath ?? geoPath ?? null, csvPath: csvPath ?? null };
}
const { geoPath: precinctGeoPath, csvPath: precinctCsvPath } =
  electionVal ? _getPrecinctPaths(electionVal, effectiveVoteType, subVal, ballotTypeVal) : { geoPath: null, csvPath: null };

// All async data loads run in parallel via Promise.all — the cell waits for the slowest
// single fetch instead of the sum of all of them. Falls-back resolve immediately so the
// shape of the destructured array is stable regardless of which optional layers exist.
const [
  geoData,
  cartData,
  results,
  turnoutData,
  councilDistrictGeoData,
  councilDistrictResults,
  _explicitCouncilSMD,
  selfgovGeoData,
  selfgovResults,
  precinctTurnout,
  seatsData
] = electionVal
  ? await Promise.all([
      loadGeoJSON(electionVal, _geoVt, "district"),
      electionVal.files?.cartogram
        ? loadGeoJSON({system: {pr: {shape_file: electionVal.files.cartogram}}}, "pr", "district")
        : Promise.resolve(null),
      loadResults(electionVal, effectiveVoteType, subVal, "district", ballotTypeVal),
      loadTurnout(electionVal, "district"),
      hasCouncilDistricts ? loadGeoJSON(electionVal, _geoVt, "council_district")                                   : Promise.resolve(null),
      hasCouncilDistricts ? loadResults(electionVal, effectiveVoteType, subVal, "council_district", ballotTypeVal) : Promise.resolve([]),
      (isCouncilMode && electionVal.files?.council_smd_results)
        ? loadCSVPath(electionVal.files.council_smd_results)
        : Promise.resolve(null),
      hasSelfGov ? loadGeoJSON(electionVal, "pr", "selfgov")                                                       : Promise.resolve(null),
      hasSelfGov ? loadResults(electionVal, effectiveVoteType, subVal, "selfgov", ballotTypeVal)                   : Promise.resolve([]),
      hasPrecinct ? loadTurnout(electionVal, "precinct")                                                           : Promise.resolve([]),
      (_needsSeatsData && electionVal.files?.seats)
        ? loadCSVPath(electionVal.files.seats)
        : Promise.resolve([])
    ])
  : [null, null, [], [], null, [], null, null, [], [], []];

// Council SMD seat composition: explicit `council_smd_results` file when present (so seats reflect
// the elected-people list even during a runoff); else reuse the council-district results we already
// loaded above. `_explicitCouncilSMD` is null when the file isn't applicable.
const _allCouncilSMDResults = _explicitCouncilSMD ?? councilDistrictResults;
```

```js
// ── Party lookup (bound to current election) ───────────────────────────────
const { getParty, partyColor } = makePartyLookup(electionVal, parties);

// ── Election YAML party/candidate metadata (threshold_status, alias, color) ──
// Parliamentary elections use a "parties" key; presidential elections use "candidates".
const elecPartyMeta = new Map(
  [...(electionVal?.parties ?? []), ...(electionVal?.candidates ?? [])].map(p => [p.id, p])
);

// Separate national summary rows (district_id="national") from district rows
// New combined CSV format includes "national" rows with accurate national vote totals.
const _nationalRows  = results.filter(r => String(r.district_id) === "national");
const _districtRows  = results.filter(r => String(r.district_id) !== "national");
const _hasNatRows    = _nationalRows.length > 0;

// For council mode: compute actual district wins from council SMD results
// one winner per council majoritarian district = one SMD seat
// Computed always (not just in SMD map mode) so seat chart is stable across vote type switches
const _councilSMDWins = isCouncilMode
  ? (() => {
      const wins = new Map();
      for (const rows of d3.group(
        _allCouncilSMDResults.filter(r => String(r.district_id) !== "national"),
        r => String(r.district_id)
      ).values()) {
        const w = rows.reduce((a, b) => b.votes > a.votes ? b : a);
        wins.set(w.party_id, (wins.get(w.party_id) ?? 0) + 1);
      }
      return wins;
    })()
  : new Map();
const _totalCouncilSMD = d3.sum([..._councilSMDWins.values()]);

// National aggregates per party
const nationalResults = _hasNatRows
  // New format: use pre-computed national rows from CSV (accurate vote_share)
  ? d3.rollup(_nationalRows, rows => ({
      votes:      rows[0].votes,
      vote_share: rows[0].vote_share,
      seats_pr:   0,  // calculated below via D'Hondt
      seats_smd:  rows[0]?.seats_smd  ?? 0,
      seats_comp: rows[0]?.seats_comp ?? 0,
      threshold_status: "notrun"  // overridden below from YAML
    }), d => d.party_id)
  // Legacy format: aggregate district rows
  : d3.rollup(_districtRows, rows => ({
      votes:      d3.sum(rows, r => r.votes),
      vote_share: d3.mean(rows, r => r.vote_share),
      seats_pr:   isCouncilMode ? d3.sum(rows, r => r.seats_pr)  : (rows[0]?.seats_pr  ?? 0),
      seats_smd:  isCouncilMode ? d3.sum(rows, r => r.seats_smd) : (rows[0]?.seats_smd ?? 0),
      seats_comp: rows[0]?.seats_comp ?? 0,
      threshold_status: rows[0]?.threshold_status ?? "notrun"
    }), d => d.party_id);

// Compute D'Hondt PR seats if method is defined in election YAML
const _prCfg = electionVal?.system?.pr;
const _seatsByParty = (_prCfg?.method === "dhondt" && _prCfg?.seats)
  ? dhondtSeats(
      new Map([...nationalResults.entries()]
        .filter(([pid]) => elecPartyMeta.get(pid)?.threshold_status === "passed")
        .map(([pid, d]) => [pid, d.votes])
      ),
      _prCfg.seats
    )
  : new Map();

// Build seat lookup from CSV: selfgov_id → Map(party_id → {seats_pr, seats_smd, seats_mayor})
const _seatsMap = new Map();
for (const r of seatsData) {
  const sid = String(r.selfgov_id);
  if (!_seatsMap.has(sid)) _seatsMap.set(sid, new Map());
  _seatsMap.get(sid).set(String(r.party_id), {
    seats_pr:    Number(r.seats_pr)    || 0,
    seats_smd:   Number(r.seats_smd)   || 0,
    seats_mayor: Number(r.seats_mayor) || 0
  });
}
const _natSeatsByParty      = _seatsMap.get("national") ?? new Map();
const _totalPRSeatsFromCSV  = d3.sum([..._natSeatsByParty.values()], d => d.seats_pr);
const _totalSMDSeatsFromCSV = d3.sum([..._natSeatsByParty.values()], d => d.seats_smd);
const _totalMayorsFromCSV   = d3.sum([..._natSeatsByParty.values()], d => d.seats_mayor);

const _nationalPartyIds = new Set([
  ...nationalResults.keys(),
  ..._natSeatsByParty.keys(),
  ..._councilSMDWins.keys()
]);

const nationalArray = Array.from(_nationalPartyIds, party_id => {
  const v = nationalResults.get(party_id) ?? {
    votes: 0,
    vote_share: 0,
    seats_pr: 0,
    seats_smd: 0,
    seats_comp: 0,
    threshold_status: "notrun"
  };
  const meta = elecPartyMeta.get(party_id);
  const threshold_status = meta?.threshold_status ?? v.threshold_status ?? "notrun";
  // Use actual election results from CSV when available (council mode),
  // otherwise fall back to YAML-declared seats or D'Hondt calculation
  const seats_pr = isCouncilMode && _natSeatsByParty.size > 0
    ? (_natSeatsByParty.get(party_id)?.seats_pr ?? 0)
    : (meta?.seats_pr != null
        ? meta.seats_pr
        : _seatsByParty.size > 0 ? (_seatsByParty.get(party_id) ?? 0) : (v.seats_pr ?? 0));
  const seats_smd = isCouncilMode
    ? (_natSeatsByParty.size > 0
        ? (_natSeatsByParty.get(party_id)?.seats_smd ?? 0)
        : (_councilSMDWins.get(party_id) ?? 0))
    : (meta?.seats_smd ?? v.seats_smd ?? 0);
  const seats_mayor = _natSeatsByParty.get(party_id)?.seats_mayor ?? 0;
  const seats_comp = meta?.seats_compensation ?? v.seats_comp ?? 0;
  return {
    party_id, ...v,
    seats_pr, seats_smd, seats_mayor, seats_comp, threshold_status,
    party: getParty(party_id),
    color: partyColor(party_id, electionVal?.id)
  };
}).sort((a, b) => b.vote_share - a.vote_share);

// "notrun" = no threshold applies (SMD / by-elections / presidential) — show all without break
const hasThreshold = nationalArray.some(d => d.threshold_status === "passed" || d.threshold_status === "failed");

// Presidential winner: leading candidate in runoff, or first-round winner (>50%)
const presidentialWinnerId = isPresidential && nationalArray.length > 0
  ? (subVal?.type === "runoff" || nationalArray[0]?.vote_share > 0.5 ? nationalArray[0]?.party_id : null)
  : null;
const passed = hasThreshold
  ? nationalArray.filter(d => d.threshold_status === "passed")
  : nationalArray;
const failed = hasThreshold
  ? nationalArray.filter(d => d.threshold_status === "failed")
  : [];
```

```js
// ── Turnout by district/precinct lookup (top-level so renderTurnoutPanel can access it) ──
// turnoutValue and turnoutNorm are imported from election-utils.js.

// Dynamic max for invalid-ballot normalization — computed after turnoutByDistrict is populated.
// Using 95th-percentile of district values (×1.2), capped at 0.30, floor at 0.02.
// Passed explicitly to turnoutNorm(td, metric, _invalidMax).
let _invalidMax = 0.05;

const turnoutByDistrict = new Map();
// In council SMD mode `results` uses major_ids (101…) as district_id, not CEC electoral district
// IDs (1-84). Use council PR results as the source so the district-layer choropleth can resolve
// turnout by CEC district ID. PR results carry the same polling-day turnout columns.
const _distTurnoutSource = (isCouncilMode && effectiveVoteType === "smd" && electionVal?.files?.council_pr_results)
  ? await loadCSVPath(electionVal.files.council_pr_results)
  : results;
const _hasInlineTurnout = _distTurnoutSource.length > 0 && _distTurnoutSource[0]?.registered != null;
if (_hasInlineTurnout) {
  // New combined CSV: turnout columns are denormalized into every party row.
  // Take the first row per district_id (all rows for the same district have identical turnout).
  const _seenDids = new Set();
  for (const r of _distTurnoutSource) {
    const did = String(r.district_id);
    if (!_seenDids.has(did)) {
      _seenDids.add(did);
      const _td = {...r, vote_type: r.vote_type ?? effectiveVoteType ?? "pr"};
      if (_td.turnout_pct == null && _td.registered > 0) _td.turnout_pct = _td.voted / _td.registered;
      if (_td.invalid_pct == null && _td.voted > 0 && _td.invalid_ballots != null) _td.invalid_pct = _td.invalid_ballots / _td.voted;
      if (_td.noon_pct    == null && _td.registered > 0 && _td.voted_noon != null) _td.noon_pct    = _td.voted_noon / _td.registered;
      if (_td.five_pct    == null && _td.registered > 0 && _td.voted_5pm  != null) _td.five_pct    = _td.voted_5pm  / _td.registered;
      turnoutByDistrict.set(did, _td);
    }
  }
  // Synthesize "national" entry from district totals if not already in CSV
  if (!turnoutByDistrict.has("national")) {
    const distEntries = [...turnoutByDistrict.values()];
    const reg   = d3.sum(distEntries, d => d.registered  ?? 0);
    const voted = d3.sum(distEntries, d => d.voted        ?? 0);
    turnoutByDistrict.set("national", {
      district_id:  "national",
      vote_type:    effectiveVoteType ?? "pr",
      registered:   reg,
      voted,
      voted_noon:   d3.sum(distEntries, d => d.voted_noon   ?? 0),
      voted_5pm:    d3.sum(distEntries, d => d.voted_5pm    ?? 0),
      main_list:    d3.sum(distEntries, d => d.main_list    ?? 0),
      special_list: d3.sum(distEntries, d => d.special_list ?? 0),
      turnout_pct:  reg > 0 ? voted / reg : 0,
      invalid_ballots: d3.sum(distEntries, d => d.invalid_ballots ?? 0),
      invalid_pct:  voted > 0 ? d3.sum(distEntries, d => d.invalid_ballots ?? 0) / voted : 0,
      noon_pct:     reg > 0 ? d3.sum(distEntries, d => d.voted_noon ?? 0) / reg : 0,
      five_pct:     reg > 0 ? d3.sum(distEntries, d => d.voted_5pm  ?? 0) / reg : 0
    });
  }
} else if (turnoutData.length > 0) {
  const relevantRows = turnoutData.filter(r =>
    !r.vote_type || r.vote_type === effectiveVoteType || r.vote_type === "pr"
  );
  d3.group(relevantRows, r => String(r.district_id)).forEach((rows, did) => {
    turnoutByDistrict.set(did, rows[0]);
  });
}

// Compute dynamic max for invalid-ballot coloring from actual district data.
// 95th-percentile × 1.2, capped at 0.30, minimum 0.02.
{
  const _invVals = [...turnoutByDistrict.values()]
    .map(d => turnoutValue(d, "invalid"))
    .filter(v => v > 0)
    .sort(d3.ascending);
  if (_invVals.length > 0) {
    _invalidMax = Math.min(0.30, Math.max(0.02, d3.quantile(_invVals, 0.95) * 1.2));
  }
}

const hasTurnoutMetrics = hasTurnout && !!(
  turnoutByDistrict.size > 0 &&
  [...turnoutByDistrict.values()][0]?.voted_noon != null
);
```

```js
// District panel is updated imperatively (DOM manipulation in map click handlers).
// No reactive Mutable needed — avoids re-rendering the container/map on each click.
void 0;
```

```js
// Standalone map div — no reactive deps, so created once and reused across container re-renders.
// Embedding it as ${mapContainer} in the layout moves (not copies) this node, preserving the map.
const mapContainer = html`<div style="width:100%;height:100%;z-index:0;"></div>`;
```

```js
// Module-level map control handle — .current set by the map IIFE, called by bar chart clicks
const _mapCtrl = {current: null};
function selectPartyOnMap(partyId) { _mapCtrl.current?.setPartyFilter(partyId); }

// Stable renderer handle — the makeRenderers cell below mutates this on every
// re-run (including on lang change) so callers that read from _renderers always
// get the latest functions. The map cell references _renderers (not the individual
// renderer names), which keeps it decoupled from lang and prevents needless rebuilds.
const _renderers = {};

// Persistent map view state — survives reactive re-renders so zoom/pan is preserved
// when switching view mode (results ↔ turnout) without changing the election.
function parseUrlNumber(name) {
  const value = _urlParams.get(name);
  return value == null || value === "" ? NaN : Number(value);
}
const _urlLat = parseUrlNumber("lat");
const _urlLng = parseUrlNumber("lng");
const _urlZoom = parseUrlNumber("z");
const _mapState = {
  center: Number.isFinite(_urlLat) && Number.isFinite(_urlLng) ? [_urlLat, _urlLng] : [42.1, 43.0],
  zoom: Number.isFinite(_urlZoom) ? _urlZoom : 7,
  elecId: Number.isFinite(_urlLat) && Number.isFinite(_urlLng) && _electionCtrl.value ? _electionCtrl.value : null,
  ballotType: _ballotCtrl.value
};
```

```js
function shareUrlForCurrentMap() {
  const p = new URLSearchParams();
  const mapState = _mapCtrl.current?.getShareState?.() ?? {};

  p.set("type", typeVal);
  if (electionVal?.id) p.set("election", electionVal.id);
  if (subVal?.id && subVal.id !== "__main__") p.set("sub", subVal.id);
  if (isLocal) p.set("ballot", ballotTypeVal);
  if (effectiveVoteType) p.set("vote", effectiveVoteType);
  if (viewMode && viewMode !== "results") p.set("view", viewMode);
  if (mapMode && mapMode !== "geographic") p.set("map", mapMode);
  if (mapState.level) p.set("level", mapState.level);
  if (mapState.party) p.set("party", mapState.party);
  if (mapState.unitLevel && mapState.unit) {
    p.set("unit_level", mapState.unitLevel);
    p.set("unit", mapState.unit);
  }
  if (mapState.metric && mapState.metric !== "final") p.set("metric", mapState.metric);
  if (Number.isFinite(mapState.lat) && Number.isFinite(mapState.lng)) {
    p.set("lat", mapState.lat.toFixed(5));
    p.set("lng", mapState.lng.toFixed(5));
  }
  if (Number.isFinite(mapState.z)) p.set("z", String(Number(mapState.z.toFixed(2))));

  return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
}

// shareUrlForCurrentMap is passed to buildElectionMap, which mounts it as a Leaflet control.
```

```js
// ════════════════════════════════════════════════════════════
// LAYOUT
// ════════════════════════════════════════════════════════════
// Explicit reactive deps — ensures container re-renders when any of these change
hasTurnout; hasPrecinct; hasCouncilDistricts; viewMode; voteTypeOptions; seatFilterOptions; hasSubElections; isSubElectionSMD; isSubElectionPR; isPresidential; isIndirect; presidentialWinnerId; isPlebiscite; isLocal; hasCouncil; ballotTypeVal; isCouncilMode; lang;
// Forward refs: renderer functions defined later; listing them ensures this cell waits for them
renderNationalPanel; renderElectionInfo; renderBarChart; renderDots; renderCouncilDots; selectPartyOnMap; renderPrecinctPanel;

const container = html`
<style>
  .elections-outer {
    display: grid;
    grid-template-columns: 210px 1fr;
    gap: 1rem;
    align-items: start;
    width: 100%;
  }
  /* Map row: two-column grid — map on the left, results panel on the right.
     The panel only floats over the map when the user enters fullscreen mode
     (see :fullscreen overrides further down). */
  .elections-main {
    display: grid;
    grid-template-columns: minmax(0, 900px) 300px;
    gap: 1rem;
    align-items: start;
  }

  /* ── Fullscreen mode ─────────────────────────────────────────────────────
     When the user clicks the fullscreen button, the .elections-main wrapper
     (which contains both the map card and the results panel) is the element
     handed to the browser's Fullscreen API. Override the two-column grid so
     the map fills the entire viewport, and float the panel as an overlay in
     the bottom-right corner.

     Explicit viewport sizing is intentional here: some browsers keep the
     fullscreen element's document-flow dimensions unless we force the wrapper
     and map card to the fullscreen viewport. */
  .elections-main:fullscreen,
  .elections-main:-webkit-full-screen,
  .elections-main.map-fullscreen-active {
    display: block;
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    padding: 0;
    margin: 0;
    overflow: hidden;
    background: var(--theme-background, #fff);
  }
  .elections-main:fullscreen > .card:not(.results-panel),
  .elections-main:-webkit-full-screen > .card:not(.results-panel),
  .elections-main.map-fullscreen-active > .card:not(.results-panel) {
    width: 100vw !important;
    height: 100% !important;
    margin: 0;
    padding: 0 !important;
    border-radius: 0;
    box-shadow: none;
    overflow: hidden;
  }
  .elections-main:fullscreen > .card:not(.results-panel) > div,
  .elections-main:-webkit-full-screen > .card:not(.results-panel) > div,
  .elections-main.map-fullscreen-active > .card:not(.results-panel) > div {
    width: 100% !important;
    height: 100% !important;
  }
  .elections-main:fullscreen > .results-panel,
  .elections-main:-webkit-full-screen > .results-panel,
  .elections-main.map-fullscreen-active > .results-panel {
    position: absolute;
    right: 16px;
    bottom: 16px;
    width: 340px;
    max-width: calc(100vw - 32px);
    max-height: min(55vh, calc(100vh - 32px));
    overflow-y: auto;
    z-index: 1000;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
    background: var(--theme-background, #fff);
  }
  /* The toggle button gets the .results-panel-toggle class. It's hidden
     by default and only shown when the panel is decorated for fullscreen
     (the JS adds the .results-panel-fullscreen class to the panel — that
     is the most reliable trigger because it does not depend on any
     browser pseudo-class support).

     Comma-separated selector lists that mix :fullscreen with the legacy
     :-webkit-full-screen pseudo-class can get the WHOLE rule dropped in
     some Chrome versions where -webkit-full-screen is no longer a valid
     parser token. That is why these are class-based rules — they are
     robust. */
  .results-panel > .results-panel-toggle {
    display: none;
  }
  .results-panel.results-panel-fullscreen > .results-panel-toggle {
    position: absolute;
    top: 8px;
    right: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border, rgba(0,0,0,0.18));
    border-radius: 4px;
    background: var(--theme-background, #fff);
    color: var(--theme-foreground, #222);
    cursor: pointer;
    z-index: 2;
  }
  .results-panel.results-panel-fullscreen > .results-panel-toggle:hover {
    border-color: var(--theme-foreground-focus, #1a3a5c);
    color: var(--theme-foreground-focus, #1a3a5c);
  }
  .results-panel.results-panel-fullscreen.results-panel-collapsed > :not(.results-panel-toggle) {
    display: none !important;
  }
  .results-panel.results-panel-fullscreen.results-panel-collapsed > .results-panel-toggle {
    top: 6px;
    right: 6px;
  }
  /* On narrow screens the mobile media query below sets left: 16px on the
     fullscreen panel so the expanded panel can stretch across the bottom of
     the screen. When the panel is collapsed to a 42x42 px tile we must
     cancel that left: 16px (or the tile would anchor to the left edge,
     fighting the inline right: 16px set by JS). Class-only selector keeps
     this rule isolated from any :fullscreen / :-webkit-full-screen parser
     quirks. */
  .results-panel.results-panel-fullscreen.results-panel-collapsed {
    left: auto !important;
  }
  @media (max-width: 700px) {
    .elections-main:fullscreen > .results-panel,
    .elections-main:-webkit-full-screen > .results-panel,
    .elections-main.map-fullscreen-active > .results-panel {
      left: 16px;
      width: auto;
      max-height: 45vh;
    }
  }
  .elections-bottom {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    align-items: start;
  }
  @media (max-width: 900px) { .elections-bottom { grid-template-columns: 1fr; } }
  .results-panel { min-height: 200px; overflow-y: auto; }
  .election-info { font-size: 0.85rem; line-height: 1.65; }
  .election-info .info-date { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.5rem; }
  .election-info a { color: var(--theme-foreground-focus); }
  @media (max-width: 900px) {
    .elections-outer  { grid-template-columns: 1fr; }
    .elections-main   { grid-template-columns: 1fr; }
    .elections-bottom { grid-template-columns: 1fr; }
  }

  /* Filter panel */
  .filter-panel { --input-width: 186px; overflow: hidden; }
  .filter-label {
    font-size: 0.72rem; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.05em;
    font-weight: 700; margin-bottom: 4px;
  }
  .filter-item { margin-bottom: 1rem; }

  /* Form fonts — explicit family so Georgian text uses the loaded BPG Arial
     web font instead of whatever the browser picks for native form controls. */
  .filter-panel select,
  .filter-panel option,
  .filter-panel input,
  .filter-panel label {
    font-family: "BPG Arial", "Calibri", system-ui, sans-serif;
  }

  /* Modern select styling */
  .filter-panel select {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    padding: 7px 30px 7px 10px;
    font-size: 0.82rem;
    color: var(--theme-foreground, #1a1a1a);
    background-color: var(--theme-background, #fff);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 9px center;
    border: 1.5px solid var(--border, #ddd);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  .filter-panel select:hover {
    border-color: #aaa;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  .filter-panel select:focus {
    outline: none;
    border-color: #6b9bd2;
    box-shadow: 0 0 0 3px rgba(107,155,210,0.18);
  }

  /* Year chips — election picker. Drop-in replacement for the old long-name
     dropdown; hover shows the full election name as a browser tooltip. */
  .year-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .year-chip {
    font-family: "BPG Arial", "Calibri", system-ui, sans-serif;
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.1;
    padding: 5px 11px;
    border: 1.5px solid var(--border, #ddd);
    border-radius: 999px;
    background: var(--theme-background, #fff);
    color: var(--theme-foreground, #1a1a1a);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .year-chip:hover {
    border-color: #999;
    background: rgba(0,0,0,0.04);
  }
  .year-chip.active {
    background: var(--theme-foreground-focus, #1a3a5c);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  }
  .year-chip.active:hover {
    filter: brightness(1.08);
    background: var(--theme-foreground-focus, #1a3a5c);
  }
  .year-chip:focus-visible {
    outline: 2px solid var(--theme-foreground-focus, #1a3a5c);
    outline-offset: 2px;
  }

  /* Collapsible chip section — summary acts as a chip-shaped status line and
     the disclosure toggle. Used for the sub-election picker so a long list
     (runoffs + by-elections + repeats) doesn't dominate the filter column. */
  .chip-details > summary {
    list-style: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    font-family: "BPG Arial", "Calibri", system-ui, sans-serif;
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.1;
    padding: 5px 26px 5px 11px;
    border: 1.5px solid var(--border, #ddd);
    border-radius: 999px;
    background: var(--theme-background, #fff);
    color: var(--theme-foreground, #1a1a1a);
    position: relative;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .chip-details > summary::-webkit-details-marker { display: none; }
  .chip-details > summary::after {
    content: "";
    width: 6px;
    height: 6px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    position: absolute;
    right: 12px;
    top: calc(50% - 5px);
    transform: rotate(45deg);
    transition: transform 0.15s ease, top 0.15s ease;
  }
  .chip-details[open] > summary::after {
    transform: rotate(-135deg);
    top: calc(50% - 2px);
  }
  .chip-details > summary:hover { border-color: #999; }
  .chip-details > summary:focus-visible {
    outline: 2px solid var(--theme-foreground-focus, #1a3a5c);
    outline-offset: 2px;
  }
  .chip-details > .year-chips { margin-top: 6px; }

  /* Map level control */
  .leaflet-level-control {
    background: white;
    border: 1px solid rgba(0,0,0,0.12);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 0.75rem;
    min-width: 110px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.10);
    line-height: 1.4;
  }
  .level-control-title {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
    margin-bottom: 4px;
    padding-bottom: 3px;
    border-bottom: 1px solid rgba(0,0,0,0.08);
  }
  .level-control-item {
    padding: 2px 0;
    color: #aaa;
  }
  .level-control-item.lc-clickable {
    cursor: pointer;
  }
  .level-control-item.lc-clickable:hover { color: #333; }
  .level-control-item.lc-active { color: #333; font-weight: 600; }


  /* Bar chart */
  .bar-row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; font-size: 0.82rem; }
  .bar-label { width: 140px; white-space: normal; line-height: 1.3; flex-shrink: 0; }
  .bar-track { flex: 1; background: var(--border); border-radius: 2px; height: 14px; position: relative; margin-top: 2px; }
  .bar-fill  { height: 100%; border-radius: 2px; transition: width 0.3s; }
  .bar-value { width: 80px; text-align: right; flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.25; margin-top: 1px; }
  .bar-value-main { font-size: 0.78rem; color: var(--muted); }
  .bar-value-sub  { font-size: 0.70rem; color: var(--muted); opacity: 0.7; }
  /* Expandable below-threshold section */
  .below-threshold-details { margin-top: 6px; }
  .below-threshold-details[open] { margin-top: 8px; }
  .below-threshold-summary {
    display: flex; align-items: center; gap: 6px;
    font-style: italic; text-transform: uppercase;
    font-size: 0.70rem; color: var(--muted);
    cursor: pointer; list-style: none;
    border-top: 2px dashed #bbb; padding-top: 6px;
    user-select: none;
  }
  .below-threshold-summary::-webkit-details-marker { display: none; }
  .below-threshold-summary::before {
    content: "▸"; font-style: normal; font-size: 0.65rem;
    transition: transform 0.15s;
  }
  .below-threshold-details[open] .below-threshold-summary::before { content: "▾"; }
  .below-threshold-count {
    background: var(--muted); color: #fff;
    font-size: 0.65rem; font-style: normal;
    border-radius: 10px; padding: 1px 6px; line-height: 1.4;
  }
  .below-threshold-details .bar-row { margin-top: 6px; }
  .below-threshold-details .dist-table { margin-top: 4px; }

  /* District results table */
  .dist-table {
    width: 100%;
    max-width: none;
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 0.82rem;
  }
  .dist-table thead { display: table-header-group; }
  .dist-table tbody { display: table-row-group; }
  .dist-table tr { display: table-row; }
  .dist-table th,
  .dist-table td {
    box-sizing: border-box;
    padding: 5px 6px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .dist-table th {
    color: var(--muted);
    font-weight: 700;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 2px solid var(--border);
    text-align: left;
  }
  .dist-table th:first-child,
  .dist-table td:first-child {
    width: 68%;
    overflow-wrap: anywhere;
    word-break: normal;
  }
  .dist-table th:last-child,
  .dist-table td:last-child {
    width: 32%;
    text-align: right;
    white-space: nowrap;
  }
  .dist-table tr:last-child td { border-bottom: none; }
  .party-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 5px; flex-shrink: 0; }

  /* Seat tiles — rectangles grouped by party */
  .seat-block { display: flex; flex-wrap: wrap; gap: 2px; }
  .seat-tile  { width: 9px; height: 9px; border-radius: 1px; }

  /* Active highlights for legend rows (bar chart, district table, seat
     legend). All three reserve a 3 px transparent left border on the base
     class so the active state can colour it in without shifting the row's
     contents — that way the red accent never overlaps the swatch or text,
     and toggling does not cause a horizontal jiggle. Background tint stays
     the same in all three for visual consistency. */

  /* Active bar row (party filter) — visible when the user lands via a
     ?party= deep link from /parties or clicks any row themselves. */
  .bar-row {
    transition: background 0.15s, border-color 0.15s;
    border-left: 3px solid transparent;
    border-radius: 3px;
    padding-left: 4px;
  }
  .bar-row-active {
    background: rgba(204, 23, 32, 0.08);
    border-left-color: var(--red, #CC1720);
  }

  /* Clickable district/precinct table rows. The accent attaches to the
     first cell because Leaflet doesn't let us paint a border across the
     whole <tr>; padding-left adds breathing room between the stripe and
     the party-dot swatch. */
  .dist-table-row { cursor: pointer; transition: background 0.1s; }
  .dist-table-row:hover td { background: rgba(0,0,0,0.04); }
  .dist-table-row td:first-child {
    border-left: 3px solid transparent;
    padding-left: 10px;
  }
  .dist-table-row-active td { background: rgba(204, 23, 32, 0.08); }
  .dist-table-row-active td:first-child {
    font-weight: 700;
    border-left-color: var(--red, #CC1720);
  }

  /* Seat legend row (below the dot composition). Border-radius lives here
     (was inline) so the active border-left can sit flush against it. */
  .seat-legend-row {
    transition: background 0.15s, border-color 0.15s;
    border-left: 3px solid transparent;
    border-radius: 3px;
    padding-left: 7px;
  }
  .seat-legend-row:hover { background: rgba(0,0,0,0.04); }
  .seat-legend-row-active {
    background: rgba(204, 23, 32, 0.08);
    border-left-color: var(--red, #CC1720);
  }
  .seat-legend-row-active strong { color: var(--red, #CC1720); }

  /* Election info card "Sources:" footer (rendered by renderElectionInfo()
     after the notes block). Small, muted, treats the YAML 'sources:' array
     as a citation list. */
  .election-sources {
    margin-top: 0.8rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--border);
  }
  .election-sources-label {
    font-family: var(--font-head);
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 0.3rem;
  }
  .election-sources-list {
    margin: 0;
    padding-left: 1.1rem;
    font-size: 0.78rem;
    color: var(--muted);
    line-height: 1.45;
  }
  .election-sources-list li { margin-bottom: 0.2rem; }
  .election-sources-list a {
    color: var(--red, #CC1720);
    text-decoration: none;
  }
  .election-sources-list a:hover { text-decoration: underline; }

  /* Selected map unit (parliamentary SMD, sakrebulo majoritarian, selfgov,
     or precinct circle). The class is toggled by setSelectedUnit() on the
     Leaflet SVG element. !important is necessary because Leaflet applies
     stroke style inline via setStyle() during hover, re-colouring, and
     party-filter restyling, and we want the selection accent to survive all
     of that. The animated dash gives the user an unmistakable cue without
     obscuring the fill colour underneath. */
  path.geda-selected,
  circle.geda-selected {
    stroke: var(--red, #CC1720) !important;
    stroke-width: 3px !important;
    stroke-opacity: 1 !important;
    stroke-dasharray: 6 3 !important;
    animation: geda-selected-dash 0.9s linear infinite;
  }
  @keyframes geda-selected-dash {
    to { stroke-dashoffset: -9; }
  }

  /* Turnout metric rows — clickable to switch the map metric */
  .turnout-metric-row {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 5px 4px; margin: 0 -4px;
    border-bottom: 1px solid var(--border);
    font-size: 0.82rem; cursor: pointer;
    border-radius: 3px; transition: background 0.1s;
  }
  .turnout-metric-row:hover { background: rgba(0,0,0,0.04); }
  .metric-row-active { background: rgba(0,0,0,0.07) !important; }
  .metric-row-active .metric-row-label { font-weight: 700; color: var(--theme-foreground); }


  /* Map legend control */
  .map-legend {
    background: rgba(255,255,255,0.93);
    padding: 7px 10px;
    border-radius: 5px;
    font-size: 0.68rem;
    box-shadow: 0 1px 5px rgba(0,0,0,0.18);
    pointer-events: none;
    max-width: 240px;
  }
</style>

<div class="elections-outer">

  <!-- LEFT: FILTER PANEL -->
  <div class="card filter-panel" style="align-self: start; padding: 1rem;">

    <div class="filter-item">
      <div class="filter-label">${t("elections.type")}</div>
      ${typeInput}
    </div>
    <div class="filter-item">
      <div class="filter-label">${t("elections.choice")}</div>
      ${electionInput}
    </div>
    ${isLocal && hasCouncil ? html`
    <div class="filter-item">
      <div class="filter-label">${t("elections.local.ballot_type")}</div>
      ${ballotTypeInput}
    </div>` : ""}
    ${hasSubElections ? html`
    <div class="filter-item">
      <div class="filter-label">${isPlebiscite ? t("elections.question_label") : t("elections.sub_election")}</div>
      ${subElectionInput}
    </div>` : ""}
    ${voteTypeOptions.length > 1 && !isSubElectionSMD && !isSubElectionPR && !isPlebiscite && !(isLocal && ballotTypeVal === "mayor") ? html`
    <div class="filter-item">
      <div class="filter-label">${t("elections.vote_type")}</div>
      ${voteTypeInput}
    </div>` : ""}

    <hr>
    ${hasTurnout ? html`<div class="filter-item">
      <div class="filter-label">${t("elections.view_mode")}</div>
      ${viewModeInput}
    </div>` : ""}
    ${/* Map representation is hidden while cartogram views are being redesigned.
    !isIndirect ? html`
    <div class="filter-item">
      <div class="filter-label">${t("elections.map_mode")}</div>
      ${mapModeInput}
    </div>
` : ""
    */ ""}
    ${seatFilterOptions.length > 1 && !isPresidential && !isPlebiscite && !(isLocal && ballotTypeVal === "mayor") ? html`
    <div class="filter-item">
      <div class="filter-label">${t("elections.seat_filter")}</div>
      ${seatFilterInput}
    </div>` : ""}
  </div>

  <!-- RIGHT: MAP + RESULTS PANEL + CHARTS -->
  <div>

    ${isIndirect ? html`
    <!-- INDIRECT PRESIDENTIAL: electoral college dot grid -->
    ${renderElectoralCollege(electionVal)}
    ` : html`
    <!-- MAP + INFO PANEL side by side -->
    <div class="elections-main" style="margin-bottom: 0.75rem;">

      <!-- MAP — mapContainer is a stable node embedded here so Leaflet survives re-renders -->
      <div class="card" style="padding: 0; height: 460px; overflow: hidden; position: relative;">
        ${mapContainer}
      </div>

      <!-- INFO PANEL — shows national results by default; updated by map click -->
      ${renderNationalPanel()}

    </div>
    `}

    <!-- BOTTOM: election info (notes) + seat distribution -->
    ${viewMode === "turnout" ? html`
    <!-- Turnout mode: info card only, constrained to map column width -->
    <div style="max-width:900px; width:100%;">
      ${renderElectionInfo(electionVal, subVal)}
    </div>
    ` : html`
    <div class="${(!isPresidential && !isPlebiscite) ? "elections-bottom" : ""}">

      <!-- LEFT: election notes/blurb from YAML -->
      ${renderElectionInfo(electionVal, subVal)}

      <!-- RIGHT: seat distribution -->
      ${!isPresidential && !isPlebiscite ? html`
      <div class="card">
        ${isCouncilMode ? html`
        <div id="council-seat-chart">
          <h4 style="margin-top:0; font-size:0.85rem;">${t("elections.local.council_seats_title")}</h4>
          ${renderCouncilDots(nationalArray, {...electionVal, council: {
            ...electionVal?.council,
            total_smd_seats: _totalSMDSeatsFromCSV > 0 ? _totalSMDSeatsFromCSV : _totalCouncilSMD,
            total_pr_seats:  _totalPRSeatsFromCSV  > 0 ? _totalPRSeatsFromCSV  : (electionVal?.council?.total_pr_seats ?? 0)
          }}, seatFilter)}
          ${renderSeatLegend(nationalArray, seatFilter, electionVal)}
        </div>` : (isLocal && ballotTypeVal === "mayor") ? html`
        <div id="council-seat-chart">
          <h4 style="margin-top:0; font-size:0.85rem;">${t("elections.local.mayor_seats_title")}</h4>
          ${renderCouncilDots(nationalArray, {...electionVal, council: {
            total_pr_seats:  0,
            total_smd_seats: _totalMayorsFromCSV > 0 ? _totalMayorsFromCSV : (electionVal?.system?.smd?.seats ?? 0)
          }}, "mayor")}
          ${renderSeatLegend(nationalArray, "mayor", electionVal)}
        </div>` : html`
        <h4 style="margin-top:0; font-size:0.85rem;">${t("elections.legislature_title")}</h4>
        ${renderDots(nationalArray, seatFilter, electionVal)}
        ${renderSeatLegend(nationalArray, seatFilter, electionVal)}`}
      </div>` : ""}

    </div>`}

  </div>
</div>
`;

display(container);
```

```js
// ── MAP ────────────────────────────────────────────────────────────────────
// Reactive deps — this cell re-runs when any of these change.
// `lang` is intentionally NOT in this list: language toggles refresh the existing
// map imperatively via the cell below (calls _mapCtrl.current.setLang) so the map
// isn't torn down, tiles aren't re-fetched, and zoom/pan/active filter are preserved.
electionVal; voteTypeVal; effectiveVoteType; mapMode; viewMode; isCouncilMode;
geoData; cartData; results; turnoutData; turnoutByDistrict;
councilDistrictGeoData; councilDistrictResults;
selfgovGeoData; selfgovResults;
precinctGeoPath; precinctCsvPath; precinctTurnout;
seatsData;

// Initial language is read from localStorage directly (the same source getLang() uses)
// so this cell doesn't depend on the reactive `lang` variable. The setLang cell below
// catches up with any current-session change immediately after the map is built.
const _initLang = (typeof window !== "undefined" && localStorage.getItem("app_lang")) || "ka";
const _initT    = k => tr(dict, _initLang, k);

await buildElectionMap({
  t: _initT, lang: _initLang,
  electionVal, voteTypeVal, effectiveVoteType, mapMode, viewMode, isCouncilMode, ballotTypeVal,
  geoData, cartData, results, turnoutData, turnoutByDistrict,
  councilDistrictGeoData, councilDistrictResults,
  selfgovGeoData, selfgovResults,
  precinctGeoPath, precinctCsvPath, precinctTurnout,
  _precinctGeoRegistryUrl, _precinctCsvRegistryUrl,
  seatsData, _districtRows, _allCouncilSMDResults, _invalidMax,
  _mapCtrl, _mapState, _turnoutMetricCtrl, _levelCtrl, _partyCtrl,
  _selectedUnitLevelCtrl, _selectedUnitCtrl, updateUrlParams, mapContainer,
  getParty, partyColor, passed,
  renderers: _renderers,
  shareUrlForCurrentMap,
  invalidation
});
```

```js
// ── Language refresh (no map rebuild) ─────────────────────────────────────
// This cell depends on `lang` and `t`. When the user toggles the language it runs
// alone — the map cell above does NOT, because it no longer references `lang`.
// setLang refreshes the legend; tooltip labels are refreshed for the next hover.
{
  _mapCtrl.current?.setLang?.(lang, t);
}
```

```js
// ── CHART RENDERERS ────────────────────────────────────────────────────────
// Declare lang as a dep so all renderer functions re-create when language changes.
// makeRenderers returns a fresh set of functions bound to current reactive state.
lang;

const {
  panelBackHeader, renderNationalPanel, showNationalPanel,
  renderBarChart, renderDots, renderCouncilDots, updateCouncilSeats,
  renderSeatLegend, renderDistrictPanel, renderTurnoutPanel,
  renderPrecinctPanel, renderTurnoutSummary, renderElectionInfo,
  renderElectoralCollege
} = makeRenderers({
  t, lang, electionVal,
  getParty, partyColor,
  selectPartyOnMap, _mapCtrl, _partyCtrl,
  passed, failed, presidentialWinnerId,
  viewMode, isPresidential, isPlebiscite,
  effectiveVoteType, results, seatFilter,
  _allCouncilSMDResults, _seatsMap, turnoutByDistrict, parties
});

// Mirror the freshly-created renderer functions on the stable `_renderers` handle so
// the map cell can read them lazily without taking a reactive dependency on lang.
Object.assign(_renderers, {
  panelBackHeader, renderNationalPanel, showNationalPanel,
  renderBarChart, renderDots, renderCouncilDots, updateCouncilSeats,
  renderSeatLegend, renderDistrictPanel, renderTurnoutPanel,
  renderPrecinctPanel, renderTurnoutSummary, renderElectionInfo,
  renderElectoralCollege
});
```
