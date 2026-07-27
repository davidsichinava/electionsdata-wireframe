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
