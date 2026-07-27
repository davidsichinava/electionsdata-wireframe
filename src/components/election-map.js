import L from "npm:leaflet";
import * as d3 from "npm:d3";
import {turnoutValue, turnoutNorm, fetchTextAsset, fetchJSONAsset, councilSelfgovIdFromMajorId, selfgovIdFromRawDistrictId} from "./election-utils.js";
import {
  GEORGIA_OUTLINE_SVG,
  TBILISI_OUTLINE_SVG,
  SHARE_ICON_SVG,
  CHECK_ICON_SVG,
  FULLSCREEN_ENTER_SVG,
  FULLSCREEN_EXIT_SVG,
  PANEL_MINIMIZE_SVG,
  PANEL_EXPAND_SVG
} from "./icons.js";

// Module-level cache: survives buildElectionMap re-calls (one fetch per session)
const _precinctRegistryCache = {
  geoManifest: null,
  geoByPath: new Map(),
  csvManifest: null,
  csvByPath: new Map()
};

const _fullscreenState = {
  active: false
};

async function loadPrecinctGeo(path, registryUrl) {
  if (!path || !registryUrl) return null;

  if (!_precinctRegistryCache.geoManifest) {
    _precinctRegistryCache.geoManifest = await fetchJSONAsset(registryUrl);
  }

  const assetPath = _precinctRegistryCache.geoManifest[path];
  if (!assetPath) return null;

  if (!_precinctRegistryCache.geoByPath.has(assetPath)) {
    const promise = fetchJSONAsset(assetPath).catch(error => {
      _precinctRegistryCache.geoByPath.delete(assetPath);
      throw error;
    });
    _precinctRegistryCache.geoByPath.set(assetPath, promise);
  }

  return _precinctRegistryCache.geoByPath.get(assetPath);
}

async function loadPrecinctCsv(path, registryUrl) {
  if (!path || !registryUrl) return [];

  if (!_precinctRegistryCache.csvManifest) {
    _precinctRegistryCache.csvManifest = await fetchJSONAsset(registryUrl);
  }

  const assetPath = _precinctRegistryCache.csvManifest[path];
  if (!assetPath) return [];

  if (!_precinctRegistryCache.csvByPath.has(assetPath)) {
    const promise = fetchTextAsset(assetPath)
      .then(text => d3.csvParse(text, d3.autoType))
      .catch(error => {
        _precinctRegistryCache.csvByPath.delete(assetPath);
        throw error;
      });
    _precinctRegistryCache.csvByPath.set(assetPath, promise);
  }

  return _precinctRegistryCache.csvByPath.get(assetPath);
}

// Builds (or rebuilds) the Leaflet election map.
// Called from elections.md as an awaited async cell.
// ctx must include all reactive state plus mutable handles and renderer functions.
export async function buildElectionMap({
  t: _initT, lang: _initLang, electionVal, voteTypeVal, effectiveVoteType, mapMode, viewMode, isCouncilMode, ballotTypeVal,
  geoData, cartData, results, turnoutData, turnoutByDistrict,
  councilDistrictGeoData, councilDistrictResults,
  selfgovGeoData, selfgovResults,
  precinctGeoPath, precinctCsvPath, precinctTurnout,
  _precinctGeoRegistryUrl, _precinctCsvRegistryUrl,
  seatsData, _districtRows, _allCouncilSMDResults, _invalidMax,
  _mapCtrl, _mapState, _turnoutMetricCtrl, _levelCtrl, _partyCtrl,
  _selectedUnitLevelCtrl, _selectedUnitCtrl, updateUrlParams, mapContainer,
  getParty, partyColor, passed,
  renderers,
  shareUrlForCurrentMap,
  invalidation
}) {
  // Mutable `t` and `lang` so a language change can be applied imperatively
  // via _mapCtrl.current.setLang(newLang, newT) without rebuilding the whole map.
  // All in-function code that references `t` or `lang` reads these let-bindings,
  // so re-rendering the legend after setLang() picks up the new values automatically.
  let t    = _initT;
  let lang = _initLang;

  // Delegate wrappers — read the latest renderer functions from the `renderers` handle
  // at call time, so panels opened after a language toggle pick up the refreshed
  // translations even though the map cell did NOT re-run.
  const renderTurnoutPanel  = (...args) => renderers.renderTurnoutPanel(...args);
  const renderDistrictPanel = (...args) => renderers.renderDistrictPanel(...args);
  const updateCouncilSeats  = (...args) => renderers.updateCouncilSeats(...args);

  // Restore saved view if we're staying on the same election and ballot.
  const _viewCfg    = (ballotTypeVal === "mayor" && electionVal?.map_view_mayor)
    ? electionVal.map_view_mayor
    : electionVal?.map_view;
  const _sameElec   = _mapState.elecId === electionVal?.id && _mapState.ballotType === ballotTypeVal;
  const _defCenter  = _viewCfg?.center ?? [42.1, 43.0];
  const _defZoom    = _viewCfg?.zoom   ?? 7;
  const _initCenter = _sameElec ? _mapState.center : _defCenter;
  const _initZoom   = _sameElec ? _mapState.zoom   : _defZoom;

  // Clean up previous Leaflet instance; save current view first so we can restore it
  invalidation.then(() => {
    try {
      _mapState.center = map.getCenter();
      _mapState.zoom   = map.getZoom();
      _mapState.elecId = electionVal?.id;
      _mapState.ballotType = ballotTypeVal;
      map.remove();
    } catch(e) {}
  });

  const map = L.map(mapContainer, {zoomControl: true, doubleClickZoom: false}).setView(_initCenter, _initZoom);
  function closeMapTooltip() {
    map.eachLayer(layer => {
      if (layer.getTooltip?.()) layer.closeTooltip();
    });
  }
  map.on("movestart dragstart zoomstart", closeMapTooltip);
  mapContainer.addEventListener("mouseleave", closeMapTooltip);

  // Clicking on empty map area (tile background) deselects the active unit
  // and resets the side panel back to the national view. Polygons and
  // precinct circles attach the `leaflet-interactive` class to their SVG
  // elements; we ignore those so the layer-level click handlers continue
  // to drive selection. This matches the back-button behaviour without
  // requiring the user to find the small ← button in the results panel.
  map.on("click", e => {
    const target = e.originalEvent?.target;
    if (!target) return;
    if (target.classList?.contains("leaflet-interactive")) return;
    if (currentSelectedUnitLevel || currentSelectedUnit) {
      clearSelectedUnit();
      if (typeof renderers?.showNationalPanel === "function") {
        renderers.showNationalPanel();
      }
    }
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19
  }).addTo(map);

  const activeGeo = mapMode === "cartogram" ? cartData : geoData;
  if (!activeGeo) {
    setTimeout(() => map.invalidateSize(), 150);
    return;
  }

  // Build district → winner lookup (from district-level results)
  const winnerByDistrict = new Map();
  const shareByDistrict  = new Map();
  d3.group(_districtRows, r => String(r.district_id)).forEach((rows, distId) => {
    const winner = rows.reduce((a, b) => (b.vote_share > a.vote_share ? b : a));
    winnerByDistrict.set(distId, winner);
    shareByDistrict.set(distId, d3.max(rows, r => r.vote_share));
  });

  function districtStyle(feature) {
    const did = geoId(feature);
    if (viewMode === "turnout") {
      const td = turnoutByDistrict.get(did);
      if (!td) return {fillColor: "#e0e0e0", fillOpacity: 0.75, color: "#bbb", weight: 0.5};
      const fillColor = d3.interpolateRgb("#fee2e2", "#b91c1c")(turnoutNorm(td, _turnoutMetricCtrl.value, _invalidMax));
      return {fillColor, fillOpacity: 0.85, color: "#ffffff", weight: 0.5};
    }
    const winner = winnerByDistrict.get(did);
    if (!winner) return {fillColor: "#e0e0e0", fillOpacity: 0.75, color: "#bbb", weight: 0.5};
    const baseColor = partyColor(winner.party_id, electionVal?.id);
    const intensity = shareByDistrict.get(did) ?? 0.5;
    const lightened = d3.color(baseColor) ? d3.interpolateRgb("#f5f5f5", baseColor)(0.4 + intensity * 0.6) : "#ccc";
    return {fillColor: lightened, fillOpacity: 0.85, color: "#ffffff", weight: 0.5};
  }

  // Stringify GeoJSON integer ids once: result maps are keyed by string from CSV,
  // while shape keys vary across vintages (`id`, `maj_id`, `major_id`, etc.).
  function geoId(feature) {
    const p = feature?.properties ?? {};
    return String(p.major_id ?? p.maj_id ?? p.MID ?? p.id ?? p.selfgov_id ?? p.self_gov_id);
  }
  function updateCouncilSeatsForDistrict(did, props) {
    // `did` here is a raw electoral/exec district number (already selfgov-scale),
    // NOT a council maj_id — see the domain note in election-utils.js.
    const sgId = selfgovIdFromRawDistrictId(did);
    const sgFeat = selfgovGeoData?.features?.find(f => String(f.properties.id) === sgId);
    updateCouncilSeats(sgId, sgFeat?.properties ?? props, true);
  }

  // Returns the full human-readable feature name for panels and tooltips.
  // Handles majoritarian GeoJSON (district_name_en + N + major) where name_en/name_ka are absent.
  function getFeatureName(feature, l = "en") {
    const p = feature?.properties ?? {};
    const majorNum = p.major ?? p.majoritarian_district ?? (p.maj_id != null ? Number(p.maj_id) % 100 : null);
    if (l === "ka" && p.name_ka) return p.name_ka;
    if (p.name_en) return p.name_en;
    if (l === "ka" && p.district_name_ka != null && p.major != null) return `${p.district_name_ka} N${p.major}`;
    if (p.district_name_en != null && p.major != null) return `${p.district_name_en} N${p.major}`;
    if (l === "ka" && p.district_name_ka) return p.district_name_ka;
    if (p.district_name_en) return p.district_name_en;
    if (l === "ka" && p.district_ka != null && majorNum != null) return `${p.district_ka} N${majorNum}`;
    if (p.district_en != null && majorNum != null) return `${p.district_en} N${majorNum}`;
    if (l === "ka" && p.district_ka) return p.district_ka;
    if (p.district_en) return p.district_en;
    return null;
  }

  // Returns just the base district name (without N+major) for precinct title building,
  // so precinct titles read "Mtatsminda N{precinct_num}" not "Mtatsminda N1 N{precinct_num}".
  function getDistrictBaseName(feature, l = "en") {
    const p = feature?.properties ?? {};
    if (l === "ka" && p.name_ka) return p.name_ka;
    if (p.name_en) return p.name_en;
    if (l === "ka" && p.district_name_ka) return p.district_name_ka;
    if (p.district_name_en) return p.district_name_en;
    if (l === "ka" && p.district_ka) return p.district_ka;
    if (p.district_en) return p.district_en;
    return null;
  }

  const _tooltipFallbacks = {
    winner: "Leader",
    subject: "Subject",
    votes: "Votes",
    share: "Share",
    turnout: "Turnout",
    count: "Count",
    registered: "Registered",
    noData: "No data"
  };
  function tooltipLabel(key, fallbackKey = key) {
    return t(`elections.map.tooltip.${key}`) || _tooltipFallbacks[fallbackKey] || key;
  }
  // _tooltipLabels is mutated by setLang() so tooltips opened AFTER a language switch
  // reflect the new translations. Bound (string) tooltip content stays in whichever
  // language was active when the layer was added — accepted trade-off for now.
  function _computeTooltipLabels() {
    return {
      winner:     tooltipLabel("winner"),
      subject:    tooltipLabel("subject"),
      votes:      tooltipLabel("votes"),
      share:      tooltipLabel("share"),
      turnout:    tooltipLabel("turnout"),
      count:      tooltipLabel("count"),
      registered: tooltipLabel("registered"),
      noData:     tooltipLabel("no_data", "noData")
    };
  }
  let _tooltipLabels = _computeTooltipLabels();

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const formatted = new Intl.NumberFormat("en-US", {maximumFractionDigits: 0}).format(Math.round(n));
    return lang === "ka" ? formatted.replaceAll(",", " ") : formatted;
  }

  function formatPct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—";
  }

  function activePartyId() {
    return _mapCtrl.current?.currentPartyId ?? _partyCtrl?.value ?? null;
  }

  let currentSelectedUnitLevel = _selectedUnitLevelCtrl?.value ?? null;
  let currentSelectedUnit      = _selectedUnitCtrl?.value ?? null;
  const selectionHandlers = new Map();
  // Track the Leaflet layer behind each selectable unit so we can highlight
  // the matching polygon / circle whenever a district is selected (click,
  // URL restore, or programmatic). Without this the side-panel updates but
  // the map gives no visual confirmation of which unit is currently active.
  const selectionLayers = new Map();
  const selectionKey = (level, id) => `${level ?? ""}:${String(id ?? "")}`;

  // Toggle the `.geda-selected` CSS class on the Leaflet path/circle SVG
  // element of the currently-selected unit. CSS in elections.md styles this
  // with a thick red accent stroke, layered on top of whatever fill the
  // choropleth has applied — works for parliamentary SMD, council SMD,
  // selfgov, and precinct circles alike.
  function applySelectionHighlight() {
    if (mapContainer) {
      mapContainer.querySelectorAll(".geda-selected").forEach(el => el.classList.remove("geda-selected"));
    } else {
      document.querySelectorAll(".geda-selected").forEach(el => el.classList.remove("geda-selected"));
    }
    if (!currentSelectedUnitLevel || !currentSelectedUnit) return;
    const layer = selectionLayers.get(selectionKey(currentSelectedUnitLevel, currentSelectedUnit));
    const el    = layer?.getElement?.();
    if (el?.classList) {
      el.classList.add("geda-selected");
      // Promote so the highlight isn't obscured by neighbouring polygons.
      if (typeof layer.bringToFront === "function") layer.bringToFront();
    }
  }

  function setSelectedUnit(level, id, {updateUrl = true} = {}) {
    currentSelectedUnitLevel = level || null;
    currentSelectedUnit = id == null ? null : String(id);
    if (_selectedUnitLevelCtrl) _selectedUnitLevelCtrl.value = currentSelectedUnitLevel;
    if (_selectedUnitCtrl) _selectedUnitCtrl.value = currentSelectedUnit;
    if (_mapCtrl.current) {
      _mapCtrl.current.currentSelectedUnitLevel = currentSelectedUnitLevel;
      _mapCtrl.current.currentSelectedUnit = currentSelectedUnit;
    }
    if (updateUrl && typeof updateUrlParams === "function") {
      updateUrlParams(
        {level: currentSelectedUnitLevel, unit_level: currentSelectedUnitLevel, unit: currentSelectedUnit},
        []
      );
    }
    applySelectionHighlight();
  }

  function clearSelectedUnit({updateUrl = true} = {}) {
    currentSelectedUnitLevel = null;
    currentSelectedUnit = null;
    if (_selectedUnitLevelCtrl) _selectedUnitLevelCtrl.value = null;
    if (_selectedUnitCtrl) _selectedUnitCtrl.value = null;
    if (_mapCtrl.current) {
      _mapCtrl.current.currentSelectedUnitLevel = null;
      _mapCtrl.current.currentSelectedUnit = null;
    }
    if (updateUrl && typeof updateUrlParams === "function") {
      updateUrlParams({}, ["unit_level", "unit"]);
    }
    applySelectionHighlight();
  }

  function registerSelection(level, id, handler, layer) {
    if (level && id != null && typeof handler === "function") {
      selectionHandlers.set(selectionKey(level, id), handler);
      // Stash the layer so applySelectionHighlight() can find its SVG element.
      if (layer) selectionLayers.set(selectionKey(level, id), layer);
    }
  }

  function applySelection(level, id, {updateUrl = true} = {}) {
    const handler = selectionHandlers.get(selectionKey(level, id));
    if (!handler) return false;
    handler();
    setSelectedUnit(level, id, {updateUrl});
    return true;
  }

  function rowName(row) {
    if (!row) return null;
    const party = getParty?.(row.party_id);
    return (lang === "ka" && (row.name_ka || row.candidate_name_ka))
      || row.name_en
      || row.name_ka
      || row.candidate_name_ka
      || row.candidate_name
      || row.party_label
      || party?.name?.[lang]
      || party?.name?.en
      || row.party_id;
  }

  function turnoutMetricDetails(td, metric) {
    if (!td) return null;
    if (metric === "noon") {
      const pct = td.noon_pct ?? (td.registered > 0 ? td.voted_noon / td.registered : null);
      return {label: t("elections.turnout.metric.noon") || "12:00", count: td.voted_noon, pct};
    }
    if (metric === "5pm") {
      const pct = td.five_pct ?? (td.registered > 0 ? td.voted_5pm / td.registered : null);
      return {label: t("elections.turnout.metric.5pm") || "17:00", count: td.voted_5pm, pct};
    }
    if (metric === "invalid") {
      const pct = td.invalid_pct ?? (td.voted > 0 ? td.invalid_ballots / td.voted : null);
      return {label: t("elections.turnout.metric.invalid") || "Invalid ballots", count: td.invalid_ballots, pct};
    }
    const pct = td.turnout_pct ?? (td.registered > 0 ? td.voted / td.registered : null);
    return {label: t("elections.turnout.metric.final") || _tooltipLabels.turnout, count: td.voted, pct};
  }

  function tooltipFrame(title, rowsHtml) {
    return `<div class="geda-tooltip-frame">
      <div class="geda-tooltip-title">${escapeHtml(title)}</div>
      ${rowsHtml}
    </div>`;
  }

  function tooltipLine(label, value, options = {}) {
    const valueClass = options.wrapValue ? "geda-tooltip-value geda-tooltip-value-wrap" : "geda-tooltip-value";
    return `<div class="geda-tooltip-line">
      <span class="geda-tooltip-label">${escapeHtml(label)}</span>
      <span class="${valueClass}">${escapeHtml(value)}</span>
    </div>`;
  }

  function tooltipSubject(value, color) {
    return `<div class="geda-tooltip-subject" style="color:${escapeHtml(color || "#111111")};">${escapeHtml(value)}</div>`;
  }

  function buildTurnoutTooltip(title, td) {
    const metric = turnoutMetricDetails(td, _turnoutMetricCtrl.value);
    if (!metric) return tooltipFrame(title, `<div style="font-size:0.74rem;color:#666;">${_tooltipLabels.noData}</div>`);
    return tooltipFrame(title, [
      tooltipLine(metric.label, formatPct(metric.pct)),
      tooltipLine(_tooltipLabels.count, formatCount(metric.count)),
      tooltipLine(_tooltipLabels.registered, formatCount(td.registered))
    ].join(""));
  }

  function selectTooltipResultRow(rows) {
    const activeId = activePartyId();
    if (activeId != null) return rows.find(r => String(r.party_id) === String(activeId)) ?? null;
    return rows.reduce((best, row) => !best || (Number(row.vote_share) || 0) > (Number(best.vote_share) || 0) ? row : best, null);
  }

  function buildResultTooltipFromRows(title, rows) {
    const activeId = activePartyId();
    const row = selectTooltipResultRow(rows);
    if (!row && activeId == null) return tooltipFrame(title, `<div style="font-size:0.74rem;color:#666;">${_tooltipLabels.noData}</div>`);

    const fallbackParty = activeId != null ? getParty?.(activeId) : null;
    const subject = rowName(row) || fallbackParty?.name?.[lang] || fallbackParty?.name?.en || activeId || _tooltipLabels.noData;
    const subjectColor = partyColor(row?.party_id ?? activeId, electionVal?.id);
    return tooltipFrame(title, [
      tooltipSubject(subject, subjectColor),
      tooltipLine(_tooltipLabels.votes, formatCount(row?.votes ?? 0)),
      tooltipLine(_tooltipLabels.share, formatPct(row?.vote_share ?? 0))
    ].join(""));
  }

  function buildAreaResultTooltip(title, rows, id) {
    return buildResultTooltipFromRows(
      title,
      rows.filter(r => String(r.district_id) === String(id))
    );
  }

  function withHoverOutline(layer) {
    layer.on("mouseover", () => {
      layer._gedaHoverStyle = {
        color: layer.options?.color,
        weight: layer.options?.weight,
        opacity: layer.options?.opacity
      };
      if (layer.setStyle) layer.setStyle({color: "#111111", weight: 1.2, opacity: 1});
      if (layer.bringToFront) layer.bringToFront();
    });
    layer.on("mouseout", () => {
      const style = layer._gedaHoverStyle;
      if (style && layer.setStyle) layer.setStyle(style);
      layer._gedaHoverStyle = null;
    });
  }

  function bindDynamicTooltip(layer, contentFn) {
    withHoverOutline(layer);
    layer.bindTooltip(() => contentFn(), {
      className: "geda-map-tooltip",
      direction: "top",
      offset: [0, -6],
      opacity: 0.96,
      sticky: false
    });
    layer.on("mousedown", closeMapTooltip);
  }

  const DISTRICT_HOLLOW  = {fillColor: "transparent", fillOpacity: 0, color: "#999", weight: 0.5};
  const SAKREBULO_HOLLOW = {fillColor: "transparent", fillOpacity: 0, color: "#bbb", weight: 0.8};

  if (mapMode === "cartogram" && activeGeo.features[0]?.geometry?.type === "Point") {
    // Cartogram — proportional circles, no precinct overlay
    activeGeo.features.forEach(f => {
      const did  = geoId(f);
      const winner = winnerByDistrict.get(did);
      let fillColor;
      if (viewMode === "turnout") {
        const td = turnoutByDistrict.get(did);
        fillColor = d3.interpolateRgb("#fee2e2", "#b91c1c")(Math.min(1, turnoutValue(td, _turnoutMetricCtrl.value)));
      } else {
        const color = winner ? partyColor(winner.party_id, electionVal?.id) : "#ccc";
        fillColor = d3.interpolateRgb("#f5f5f5", color)(0.4 + (shareByDistrict.get(did) ?? 0.5) * 0.6);
      }
      const circle = L.circle(
        [f.geometry.coordinates[1], f.geometry.coordinates[0]],
        { radius: (f.properties.radius_km ?? 10) * 1000, fillColor, fillOpacity: 0.85, color: "#fff", weight: 0.5 }
      ).addTo(map);
      const selectDistrict = () => {
        const panel = document.getElementById("results-panel");
        if (panel) panel.replaceWith(viewMode === "turnout"
          ? renderTurnoutPanel(did, f.properties)
          : renderDistrictPanel(did, f.properties));

        if (isCouncilMode) updateCouncilSeatsForDistrict(did, f.properties);
      };
      registerSelection("district", did, selectDistrict, circle);
      circle.on("click", () => applySelection("district", did));
      bindDynamicTooltip(circle, () => {
        const title = (lang === "ka" ? f.properties.name_ka : f.properties.name_en) ?? did;
        return viewMode === "turnout"
          ? buildTurnoutTooltip(title, turnoutByDistrict.get(did))
          : buildAreaResultTooltip(title, _districtRows, did);
      });
    });

  } else {
    // Choropleth polygons — district layer always present
    const districtLayer = L.geoJSON(activeGeo, {
      style: districtStyle,
      onEachFeature(feature, layer) {
        const did = geoId(feature);
        const selectDistrict = () => {
          const panel = document.getElementById("results-panel");
          if (panel) panel.replaceWith(viewMode === "turnout"
            ? renderTurnoutPanel(did, feature.properties)
            : renderDistrictPanel(did, feature.properties));
          if (isCouncilMode) updateCouncilSeatsForDistrict(did, feature.properties);
        };
        registerSelection("district", did, selectDistrict, layer);
        layer.on("click", () => applySelection("district", did));
        layer.on("dblclick", e => {
          L.DomEvent.stop(e);
          drillDownOnDoubleClick(layer);
        });
        bindDynamicTooltip(layer, () => {
          const title = getFeatureName(feature, lang)
            ?? (lang === "ka" ? feature.properties.name_ka : feature.properties.name_en)
            ?? did;
          return viewMode === "turnout"
            ? buildTurnoutTooltip(title, turnoutByDistrict.get(did))
            : buildAreaResultTooltip(title, _districtRows, did);
        });
      }
    }).addTo(map);

    // ── Helper: build winner/share/turnout lookups from a results array ──
    // When turnoutArr is empty, extracts inline turnout from resultsArr if available.
    function buildLookups(resultsArr, turnoutArr) {
      const winnerMap  = new Map();
      const shareMap   = new Map();
      const turnoutMap = new Map();
      d3.group(resultsArr, r => String(r.district_id)).forEach((rows, did) => {
        const winner = rows.reduce((a, b) => (b.vote_share > a.vote_share ? b : a));
        winnerMap.set(did, winner);
        shareMap.set(did, d3.max(rows, r => r.vote_share));
        // If no separate turnout array, extract inline turnout from the first result row
        if (turnoutArr.length === 0 && rows[0]?.registered != null) {
          const td = {...rows[0]};
          if (td.turnout_pct == null && td.registered > 0) td.turnout_pct = td.voted / td.registered;
          if (td.invalid_pct == null && td.voted > 0 && td.invalid_ballots != null) td.invalid_pct = td.invalid_ballots / td.voted;
          if (td.noon_pct    == null && td.registered > 0 && td.voted_noon != null) td.noon_pct    = td.voted_noon / td.registered;
          if (td.five_pct    == null && td.registered > 0 && td.voted_5pm  != null) td.five_pct    = td.voted_5pm  / td.registered;
          turnoutMap.set(did, td);
        }
      });
      d3.group(turnoutArr, r => String(r.district_id)).forEach((rows, did) => {
        turnoutMap.set(did, rows[0]);
      });
      return {winnerMap, shareMap, turnoutMap};
    }

    function makeLayerStyle(winnerMap, shareMap, turnoutMap, weight = 0.5) {
      return function(feature) {
        const did = geoId(feature);
        if (viewMode === "turnout") {
          const td = turnoutMap.get(did);
          if (!td) return {fillColor: "#e0e0e0", fillOpacity: 0.6, color: "#ccc", weight};
          return {fillColor: d3.interpolateRgb("#fee2e2", "#b91c1c")(turnoutNorm(td, _turnoutMetricCtrl.value, _invalidMax)), fillOpacity: 0.9, color: "#ffffff", weight};
        }
        const winner = winnerMap.get(did);
        if (!winner) return {fillColor: "#e0e0e0", fillOpacity: 0.6, color: "#ccc", weight};
        const baseColor = partyColor(winner.party_id, electionVal?.id);
        const intensity = shareMap.get(did) ?? 0.5;
        const lightened = d3.color(baseColor) ? d3.interpolateRgb("#f5f5f5", baseColor)(0.4 + intensity * 0.6) : "#ccc";
        return {fillColor: lightened, fillOpacity: 0.9, color: "#ffffff", weight};
      };
    }

    // ── Council-district layer (zoom-activated, council mode only) ────────
    let councilDistrictLayer = null;
    let _councilDistrictStyleFn = null;

    if (councilDistrictGeoData) {
      const {winnerMap, shareMap, turnoutMap} = buildLookups(councilDistrictResults, []);
      const cdStyle = makeLayerStyle(winnerMap, shareMap, turnoutMap, 0.8);
      _councilDistrictStyleFn = cdStyle;

      councilDistrictLayer = L.geoJSON(councilDistrictGeoData, {
        style: cdStyle,
        onEachFeature(feature, layer) {
          const did = geoId(feature);
          // Augment props with derived names (majoritarian GeoJSON has district_name_en + major, not name_en/name_ka)
          const _props = {...feature.properties,
            name_en: getFeatureName(feature, "en"),
            name_ka: getFeatureName(feature, "ka") ?? getFeatureName(feature, "en")
          };
          const selectCouncilDistrict = () => {
            const panel = document.getElementById("results-panel");
            if (panel) panel.replaceWith(viewMode === "turnout"
              ? renderTurnoutPanel(did, _props, turnoutMap)
              : renderDistrictPanel(did, _props, councilDistrictResults));
            if (isCouncilMode) {
              // Always show parent selfgov unit composition, not just this one majoritarian district
              const _sgId = councilSelfgovIdFromMajorId(did);
              const _sgFeat = selfgovGeoData?.features?.find(f => String(f.properties.id) === _sgId);
              updateCouncilSeats(_sgId, _sgFeat?.properties ?? _props, true);
            }
          };
          registerSelection("council_district", did, selectCouncilDistrict, layer);
          layer.on("click", () => applySelection("council_district", did));
          layer.on("dblclick", e => {
            L.DomEvent.stop(e);
            drillDownOnDoubleClick(layer);
          });
          bindDynamicTooltip(layer, () => {
            const title = getFeatureName(feature, lang) ?? did;
            return viewMode === "turnout"
              ? buildTurnoutTooltip(title, turnoutMap.get(did))
              : buildAreaResultTooltip(title, councilDistrictResults, did);
          });
        }
      });
    }

    // ── Self-governing unit layer (local elections with selfgov level) ───────
    let selfgovLayer = null;
    let _selfgovStyleFn = null;
    if (selfgovGeoData) {
      const {winnerMap, shareMap, turnoutMap} = buildLookups(selfgovResults, []);
      const sgStyle = makeLayerStyle(winnerMap, shareMap, turnoutMap, 0.8);
      _selfgovStyleFn = sgStyle;
      selfgovLayer = L.geoJSON(selfgovGeoData, {
        style: sgStyle,
        onEachFeature(feature, layer) {
          const did = geoId(feature);
          const selectSelfgov = () => {
            const panel = document.getElementById("results-panel");
            if (panel) panel.replaceWith(viewMode === "turnout"
              ? renderTurnoutPanel(did, feature.properties, turnoutMap)
              : renderDistrictPanel(did, feature.properties, selfgovResults));
            if (isCouncilMode) updateCouncilSeats(did, feature.properties, true);
          };
          registerSelection("selfgov", did, selectSelfgov, layer);
          layer.on("click", () => applySelection("selfgov", did));
          layer.on("dblclick", e => {
            L.DomEvent.stop(e);
            drillDownOnDoubleClick(layer);
          });
          bindDynamicTooltip(layer, () => {
            const title = (lang === "ka" ? feature.properties.name_ka : feature.properties.name_en) ?? did;
            return viewMode === "turnout"
              ? buildTurnoutTooltip(title, turnoutMap.get(did))
              : buildAreaResultTooltip(title, selfgovResults, did);
          });
        }
      });
    }

    // ── Precinct state (populated lazily on first "Precinct" level click) ───
    let _precinctTurnoutByStation = new Map();
    let _precinctToMajorId        = new Map();
    let winnerByPrecinct          = new Map();
    let shareByPrecinct           = new Map();
    let _shareByPartyByPrecinct   = new Map();
    let precinctLayer             = null;
    let _precinctDataLoaded       = false;
    let _precinctUsesExactKeys    = false;

    function updateCouncilSeatsForPrecinct(parentDid, stationId, props) {
      if (!isCouncilMode) return;
      const sgId = effectiveVoteType === "smd"
        ? councilSelfgovIdFromMajorId(_precinctToMajorId.get(stationId) ?? parentDid)
        : selfgovIdFromRawDistrictId(parentDid);
      const sgFeat = selfgovGeoData?.features?.find(f => String(f.properties.id) === sgId);
      updateCouncilSeats(sgId, sgFeat?.properties ?? props, true);
    }

    function precinctStationId(feature) {
      const raw = feature?.properties?.id ?? feature?.properties?.precinct_id;
      return raw == null ? null : String(Math.round(Number(raw)));
    }

    function precinctKeyPart(value) {
      if (value == null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? String(Math.round(n)) : String(value);
    }

    function precinctExactKey(feature) {
      const p = feature?.properties ?? {};
      if (p.precinct_key != null && String(p.precinct_key).trim() !== "") return String(p.precinct_key).trim();
      const smd = precinctKeyPart(p.MID ?? p.M_District ?? p.smd ?? p.major_id ?? p.maj_id);
      const dd  = precinctKeyPart(p.District ?? p.district ?? p.district_id);
      const pp  = precinctKeyPart(p.Precinct ?? p.precinct ?? p.precinct_number);
      if (smd && dd && pp) return `${smd}.${dd}.${pp}`;
      return precinctStationId(feature);
    }

    function precinctResultKey(row) {
      const key = row?.precinct_key;
      if (key != null && String(key).trim() !== "") return String(key).trim();
      return String(Math.round(row.precinct_id));
    }

    function precinctFeatureResultKey(feature) {
      return _precinctUsesExactKeys ? precinctExactKey(feature) : precinctStationId(feature);
    }

    function precinctStationNumber(feature) {
      const p = feature?.properties ?? {};
      const raw = p.precinct ?? p.Precinct ?? p.precinct_number ?? p.id;
      return raw == null ? null : Math.round(Number(raw)) % 1000;
    }

    function precinctRawDistrict(feature) {
      const p = feature?.properties ?? {};
      return p.district ?? p.district_id ?? p.District;
    }

    function precinctMajorDistrict(feature) {
      const p = feature?.properties ?? {};
      return precinctKeyPart(p.MID ?? p.M_District ?? p.smd ?? p.major_id ?? p.maj_id);
    }

    function precinctParentId(feature, stationId) {
      const p = feature?.properties ?? {};
      if (isCouncilMode && effectiveVoteType === "smd") {
        return precinctMajorDistrict(feature) ?? _precinctToMajorId.get(stationId) ?? String(precinctRawDistrict(feature));
      }
      if (effectiveVoteType === "smd" && !isCouncilMode) {
        if (electionVal?.type !== "local") {
          const mid = precinctMajorDistrict(feature);
          if (mid != null) return mid;
        }
        const mayor = p.Mayor ?? p.selfgov_id;
        if (mayor != null) {
          const m = Number(mayor);
          return String(m === 99 ? 1 : m);
        }
        const d = Number(precinctRawDistrict(feature));
        return d >= 1 && d <= 10 ? "1" : String(d);
      }
      return String(precinctRawDistrict(feature));
    }

    function precinctDisplayProps(feature, stationId, parentDid) {
      const stationNum = precinctStationNumber(feature);
      const p = feature?.properties ?? {};
      const rawDist = String(precinctRawDistrict(feature));
      const featureNameEn = p.name_en || p.precinct_name_en || null;
      const featureNameKa = p.name_ka || p.precinct_name_ka || p.precinct_name || null;
      const nameGeo = (isCouncilMode && effectiveVoteType === "smd" && councilDistrictGeoData)
        ? councilDistrictGeoData
        : activeGeo;
      const distFeat = nameGeo?.features?.find(f => {
        const id = geoId(f);
        return id === parentDid || id === rawDist;
      });
      const distNameEn = (distFeat ? getDistrictBaseName(distFeat, "en") : null) ?? parentDid ?? rawDist;
      const distNameKa = (distFeat ? getDistrictBaseName(distFeat, "ka") : null) ?? distNameEn;
      const suffix = stationNum == null ? stationId : stationNum;
      return {
        ...p,
        name_en: featureNameEn ?? `${distNameEn} N${suffix}`,
        name_ka: featureNameKa ?? `${distNameKa} N${suffix}`,
        precinct_name_ka: featureNameKa ? null : (p.name_ka || p.precinct_name || null),
        address_ka: p.address || null
      };
    }

    function enrichPrecinctRows(rows) {
      return rows.map(r => {
        if (!r.name_ka && !r.candidate_name) {
          if (isCouncilMode && effectiveVoteType === "smd") {
            const match = _allCouncilSMDResults.find(
              d => String(d.district_id) === String(r.district_id) && d.party_id === r.party_id
            );
            if (match?.name_ka) return {...r, name_ka: match.name_ka};
          } else if (ballotTypeVal === "mayor") {
            const match = selfgovResults.find(
              d => String(d.district_id) === String(r.selfgov_id) && d.party_id === r.party_id
            );
            if (match?.name_ka) return {...r, name_ka: match.name_ka};
          }
        }
        return r;
      });
    }

    async function _ensurePrecinctLayer() {
      if (_precinctDataLoaded) return;
      _precinctDataLoaded = true;

      let precinctGeoData  = null;
      let precinctResults  = [];

      if (precinctGeoPath && _precinctGeoRegistryUrl) {
        try {
          precinctGeoData = await loadPrecinctGeo(precinctGeoPath, _precinctGeoRegistryUrl);
        } catch(e) { console.warn("Precinct GeoJSON load failed", e); }
      }

      if (precinctCsvPath && _precinctCsvRegistryUrl) {
        try {
          precinctResults = await loadPrecinctCsv(precinctCsvPath, _precinctCsvRegistryUrl);
        } catch(e) { console.warn("Precinct CSV load failed", e); }
      }

      _precinctUsesExactKeys = precinctResults.some(r => r.precinct_key != null && String(r.precinct_key).trim() !== "");
      const precinctResultKeys = new Set(precinctResults.map(precinctResultKey));

      // Per-station inline turnout (precincts have registered/ballots columns)
      if (precinctResults.length > 0 && precinctResults[0]?.registered != null) {
        const _seenPids = new Set();
        for (const r of precinctResults) {
          const pid = precinctResultKey(r);
          if (!_seenPids.has(pid)) { _seenPids.add(pid); _precinctTurnoutByStation.set(pid, r); }
        }
      }

      // Council SMD: precinct_id → major_id lookup for correct coloring
      if (isCouncilMode && effectiveVoteType === "smd") {
        for (const r of precinctResults) {
          const pid = String(Math.round(r.precinct_id));
          if (!_precinctToMajorId.has(pid)) _precinctToMajorId.set(pid, String(r.district_id));
        }
      }

      // Per-precinct winner/share lookups (point precinct coloring)
      d3.group(precinctResults, precinctResultKey).forEach((rows, pid) => {
        const winner = rows.reduce((a, b) => (b.vote_share > a.vote_share ? b : a));
        winnerByPrecinct.set(pid, winner);
        shareByPrecinct.set(pid, d3.max(rows, r => r.vote_share));
      });

      // Party-filter share lookup
      for (const r of precinctResults) {
        const pid = precinctResultKey(r);
        if (!_shareByPartyByPrecinct.has(pid)) _shareByPartyByPrecinct.set(pid, new Map());
        const shares = _shareByPartyByPrecinct.get(pid);
        shares.set(r.party_id, (shares.get(r.party_id) ?? 0) + (Number(r.vote_share) || 0));
      }

      if (!precinctGeoData) return;
      if (_precinctUsesExactKeys) {
        precinctGeoData = {
          ...precinctGeoData,
          features: precinctGeoData.features?.filter(f => precinctResultKeys.has(precinctExactKey(f))) ?? []
        };
      }
      const isPoints = precinctGeoData.features?.[0]?.geometry?.type === "Point";

      if (isPoints) {
        precinctLayer = L.geoJSON(precinctGeoData, {
          pointToLayer(feature, latlng) {
            const _rawDist  = precinctRawDistrict(feature);
            const _d        = Number(_rawDist);
            const stationId = String(Math.round(feature.properties.id));
            const resultKey = precinctFeatureResultKey(feature) ?? stationId;
            const parentDid = precinctParentId(feature, stationId);
            let fillColor;
            if (viewMode === "turnout") {
              const td = _precinctTurnoutByStation.get(resultKey) ?? _precinctTurnoutByStation.get(stationId) ?? turnoutByDistrict.get(parentDid);
              fillColor = d3.interpolateRgb("#fee2e2", "#b91c1c")(turnoutNorm(td, _turnoutMetricCtrl.value, _invalidMax));
            } else {
              const winner = winnerByPrecinct.get(resultKey) ?? winnerByPrecinct.get(stationId) ?? winnerByDistrict.get(parentDid);
              if (winner) {
                const color     = partyColor(winner.party_id, electionVal?.id);
                const intensity = shareByPrecinct.get(resultKey) ?? shareByPrecinct.get(stationId) ?? shareByDistrict.get(parentDid) ?? 0.5;
                fillColor = d3.interpolateRgb("#f5f5f5", color)(0.4 + intensity * 0.6);
              } else {
                fillColor = "#cccccc";
              }
            }
            return L.circleMarker(latlng, {
              radius: 4, fillColor, fillOpacity: 0.85, color: "none", weight: 0
            });
          },
          onEachFeature(feature, layer) {
            const _rawStId   = feature.properties.id;
            const stationId  = String(Math.round(_rawStId));
            const resultKey  = precinctFeatureResultKey(feature) ?? stationId;
            const stationNum = precinctStationNumber(feature);
            const _rawDist   = precinctRawDistrict(feature);
            const _d         = Number(_rawDist);
            const parentDid  = precinctParentId(feature, stationId);
            const featureNameEn = feature.properties.name_en || feature.properties.precinct_name_en || null;
            const featureNameKa = feature.properties.name_ka || feature.properties.precinct_name_ka || feature.properties.precinct_name || null;
            const _nameGeo   = (isCouncilMode && effectiveVoteType === "smd" && councilDistrictGeoData)
              ? councilDistrictGeoData
              : activeGeo;
            const distFeat   = _nameGeo?.features?.find(f =>
              geoId(f) === parentDid
            );
            const distNameEn = (distFeat ? getDistrictBaseName(distFeat, "en") : null) ?? parentDid;
            const distNameKa = (distFeat ? getDistrictBaseName(distFeat, "ka") : null) ?? distNameEn ?? parentDid;
            const _geoNameKa = feature.properties.name_ka || feature.properties.precinct_name || null;
            const _geoAddrKa = feature.properties.address || null;
            const titleKa    = featureNameKa ?? `${distNameKa} N${stationNum}`;
            const titleEn    = featureNameEn ?? `${distNameEn} N${stationNum}`;

            const selectPrecinct = () => {
              const panel = document.getElementById("results-panel");
              if (!panel) return;
              const enhancedProps = {
                ...feature.properties,
                name_en:          titleEn,
                name_ka:          titleKa,
                precinct_name_ka: featureNameKa ? null : _geoNameKa,
                address_ka:       _geoAddrKa
              };
              if (viewMode === "turnout") {
                panel.replaceWith(renderTurnoutPanel(resultKey, enhancedProps, _precinctTurnoutByStation));
              } else {
                const stationRows = precinctResults
                  .filter(r => precinctResultKey(r) === resultKey)
                  .map(r => {
                    if (!r.name_ka && !r.candidate_name) {
                      if (isCouncilMode && effectiveVoteType === "smd") {
                        const match = _allCouncilSMDResults.find(
                          d => String(d.district_id) === String(r.district_id) && d.party_id === r.party_id
                        );
                        if (match?.name_ka) return {...r, name_ka: match.name_ka};
                      } else if (ballotTypeVal === "mayor") {
                        const match = selfgovResults.find(
                          d => String(d.district_id) === String(r.selfgov_id) && d.party_id === r.party_id
                        );
                        if (match?.name_ka) return {...r, name_ka: match.name_ka};
                      }
                    }
                    return r;
                  });
                panel.replaceWith(renderDistrictPanel("__precinct__", enhancedProps, stationRows));
              }
              updateCouncilSeatsForPrecinct(parentDid, stationId, enhancedProps);
            };
            registerSelection("precinct", resultKey, selectPrecinct, layer);
            if (resultKey !== stationId) registerSelection("precinct", stationId, selectPrecinct, layer);
            layer.on("click", () => applySelection("precinct", resultKey));
            bindDynamicTooltip(layer, () => {
              const title = lang === "ka" ? titleKa : titleEn;
              if (viewMode === "turnout") {
                const td = _precinctTurnoutByStation.get(resultKey)
                  ?? _precinctTurnoutByStation.get(stationId)
                  ?? turnoutByDistrict.get(parentDid);
                return buildTurnoutTooltip(title, td);
              }
              const stationRows = enrichPrecinctRows(
                precinctResults.filter(r => precinctResultKey(r) === resultKey)
              );
              const fallbackRows = [
                winnerByPrecinct.get(resultKey)
                  ?? winnerByPrecinct.get(stationId)
                  ?? winnerByDistrict.get(parentDid)
              ].filter(Boolean);
              return buildResultTooltipFromRows(title, stationRows.length ? stationRows : fallbackRows);
            });
          }
        });
      } else {
        // Polygon precincts — choropleth
        precinctLayer = L.geoJSON(precinctGeoData, {
          style(feature) {
            const stationId = precinctStationId(feature);
            const resultKey = precinctFeatureResultKey(feature) ?? stationId;
            const parentDid = precinctParentId(feature, stationId);
            if (viewMode === "turnout") {
              const td = _precinctTurnoutByStation.get(resultKey) ?? _precinctTurnoutByStation.get(stationId) ?? turnoutByDistrict.get(parentDid);
              if (!td) return {fillColor: "#e0e0e0", fillOpacity: 0.6, color: "#ccc", weight: 0.5};
              return {
                fillColor: d3.interpolateRgb("#fee2e2", "#b91c1c")(turnoutNorm(td, _turnoutMetricCtrl.value, _invalidMax)),
                fillOpacity: 0.9,
                color: "#ffffff",
                weight: 0.5
              };
            }
            const winner = winnerByPrecinct.get(resultKey) ?? winnerByPrecinct.get(stationId) ?? winnerByDistrict.get(parentDid);
            if (!winner) return {fillColor: "#e0e0e0", fillOpacity: 0.6, color: "#ccc", weight: 0.5};
            const baseColor = partyColor(winner.party_id, electionVal?.id);
            const intensity = shareByPrecinct.get(resultKey) ?? shareByPrecinct.get(stationId) ?? shareByDistrict.get(parentDid) ?? 0.5;
            const lightened = d3.color(baseColor) ? d3.interpolateRgb("#f5f5f5", baseColor)(0.4 + intensity * 0.6) : "#ccc";
            return {fillColor: lightened, fillOpacity: 0.9, color: "#ffffff", weight: 0.5};
          },
          onEachFeature(feature, layer) {
            const stationId = precinctStationId(feature);
            const resultKey = precinctFeatureResultKey(feature) ?? stationId;
            const parentDid = precinctParentId(feature, stationId);
            const enhancedProps = precinctDisplayProps(feature, stationId, parentDid);
            const selectPrecinct = () => {
              const panel = document.getElementById("results-panel");
              if (!panel) return;
              if (viewMode === "turnout") {
                panel.replaceWith(renderTurnoutPanel(resultKey, enhancedProps, _precinctTurnoutByStation));
              } else {
                const stationRows = enrichPrecinctRows(
                  precinctResults.filter(r => precinctResultKey(r) === resultKey)
                );
                panel.replaceWith(renderDistrictPanel("__precinct__", enhancedProps, stationRows));
              }
              updateCouncilSeatsForPrecinct(parentDid, stationId, enhancedProps);
            };
            registerSelection("precinct", resultKey, selectPrecinct, layer);
            if (resultKey !== stationId) registerSelection("precinct", stationId, selectPrecinct, layer);
            layer.on("click", () => applySelection("precinct", resultKey));
            bindDynamicTooltip(layer, () => {
              const title = lang === "ka" ? enhancedProps.name_ka : enhancedProps.name_en;
              if (viewMode === "turnout") {
                const td = _precinctTurnoutByStation.get(resultKey)
                  ?? _precinctTurnoutByStation.get(stationId)
                  ?? turnoutByDistrict.get(parentDid);
                return buildTurnoutTooltip(title, td);
              }
              const stationRows = enrichPrecinctRows(
                precinctResults.filter(r => precinctResultKey(r) === resultKey)
              );
              const fallbackRows = [
                winnerByPrecinct.get(resultKey)
                  ?? winnerByPrecinct.get(stationId)
                  ?? winnerByDistrict.get(parentDid)
              ].filter(Boolean);
              return buildResultTooltipFromRows(title, stationRows.length ? stationRows : fallbackRows);
            });
          }
        });
      }
    }

    // ── Manual level switcher control ─────────────────────────────────────
    const _councilSMD = isCouncilMode && effectiveVoteType === "smd";
    const availableLevels = _councilSMD
      ? [
          // In turnout mode, selfgov and district levels are also available (same ballots as mayor)
          ...(viewMode === "turnout" && selfgovLayer ? [{ id: "selfgov",  label: t("elections.map_level.selfgov") }] : []),
          ...(viewMode === "turnout"                 ? [{ id: "district", label: t("elections.map_level.district") }] : []),
          ...(councilDistrictLayer ? [{ id: "council_district", label: t("elections.map_level.council_district") }] : []),
          ...((precinctGeoPath || precinctCsvPath) ? [{ id: "precinct", label: t("elections.map_level.precinct") }] : []),
        ]
      : [
          ...(selfgovLayer  ? [{ id: "selfgov",  label: t("elections.map_level.selfgov") }] : []),
          { id: "district", label: t("elections.map_level.district") },
          ...((precinctGeoPath || precinctCsvPath) ? [{ id: "precinct", label: t("elections.map_level.precinct") }] : []),
        ];
    const multiLevel = availableLevels.length > 1;
    // Default-level priority: URL ?level=… > YAML map_view.default_level > heuristic.
    // Heuristic: broadest level available — selfgov for local elections (or for council SMD
    // turnout view), council_district for council SMD results view, else district.
    const _heuristicLevel = _councilSMD
      ? (viewMode === "turnout" && selfgovLayer ? "selfgov" : (councilDistrictLayer ? "council_district" : "district"))
      : (selfgovLayer ? "selfgov" : "district");
    const _yamlLevel = electionVal?.map_view?.default_level;
    const _yamlLevelValid = availableLevels.some(lvl => lvl.id === _yamlLevel);
    const defaultLevel = _yamlLevelValid ? _yamlLevel : _heuristicLevel;
    let currentLevel = availableLevels.some(lvl => lvl.id === _levelCtrl?.value) ? _levelCtrl.value : defaultLevel;

    // DOM ref to the level-control panel (top-right), captured during the
    // LevelControl's onAdd() below. Click handlers reference it to keep the
    // visual highlighted-item state in sync when they programmatically switch.
    let _levelControlDiv = null;

    // Drill-down on double click: zoom to the clicked feature and jump straight to
    // the most granular level available (precinct when the election has one,
    // otherwise no level change — just the zoom). Skipped when already at
    // precinct (the leaf level — nothing lower to go to).
    function drillDownOnDoubleClick(layer) {
      if (currentLevel === "precinct") return;
      const bounds = layer.getBounds?.();
      if (bounds && bounds.isValid?.()) {
        map.fitBounds(bounds.pad(0.1), {maxZoom: 14, animate: true, duration: 0.5});
      }
      if (precinctGeoPath || precinctCsvPath) {
        applyLevel("precinct", _levelControlDiv, {clearSelection: true});
      }
    }

    function refreshPartyFilter() {
      if (_mapCtrl.current?.currentPartyId) {
        _mapCtrl.current.setPartyFilter(_mapCtrl.current.currentPartyId, true);
      }
    }

    function setLayerInteractivity(layerGroup, enabled) {
      if (!layerGroup) return;
      layerGroup.eachLayer(layer => {
        layer.options.interactive = enabled;
        const el = layer.getElement?.();
        if (el) el.style.pointerEvents = enabled ? "" : "none";
      });
    }

    function applyLevel(levelId, controlDiv, {clearSelection = false, updateUrl = true} = {}) {
      currentLevel = levelId;
      if (_levelCtrl) _levelCtrl.value = currentLevel;
      if (_mapCtrl.current) _mapCtrl.current.currentLevel = currentLevel;
      if (updateUrl && typeof updateUrlParams === "function") updateUrlParams({level: currentLevel}, []);
      if (clearSelection) clearSelectedUnit();
      if (levelId === "selfgov" && selfgovLayer) {
        if (!map.hasLayer(selfgovLayer)) selfgovLayer.addTo(map);
        districtLayer.setStyle(DISTRICT_HOLLOW);
        setLayerInteractivity(districtLayer, false);
        setLayerInteractivity(selfgovLayer, true);
        if (councilDistrictLayer && map.hasLayer(councilDistrictLayer)) map.removeLayer(councilDistrictLayer);
        if (precinctLayer        && map.hasLayer(precinctLayer))        map.removeLayer(precinctLayer);
      } else if (levelId === "district") {
        districtLayer.setStyle(districtStyle);
        setLayerInteractivity(districtLayer, true);
        if (selfgovLayer         && map.hasLayer(selfgovLayer))         map.removeLayer(selfgovLayer);
        if (councilDistrictLayer && map.hasLayer(councilDistrictLayer)) map.removeLayer(councilDistrictLayer);
        if (precinctLayer        && map.hasLayer(precinctLayer))        map.removeLayer(precinctLayer);
      } else if (levelId === "council_district" && councilDistrictLayer) {
        districtLayer.setStyle(DISTRICT_HOLLOW);
        setLayerInteractivity(districtLayer, false);
        if (selfgovLayer && map.hasLayer(selfgovLayer)) map.removeLayer(selfgovLayer);
        if (!map.hasLayer(councilDistrictLayer)) councilDistrictLayer.addTo(map);
        setLayerInteractivity(councilDistrictLayer, true);
        if (precinctLayer && map.hasLayer(precinctLayer)) map.removeLayer(precinctLayer);
      } else if (levelId === "precinct" && (precinctGeoPath || precinctCsvPath)) {
        _ensurePrecinctLayer().then(() => {
          if (!precinctLayer) return;
          districtLayer.setStyle(DISTRICT_HOLLOW);
          setLayerInteractivity(districtLayer, false);
          if (selfgovLayer         && map.hasLayer(selfgovLayer))         map.removeLayer(selfgovLayer);
          if (councilDistrictLayer && map.hasLayer(councilDistrictLayer)) map.removeLayer(councilDistrictLayer);
          if (!map.hasLayer(precinctLayer)) precinctLayer.addTo(map);
          setLayerInteractivity(precinctLayer, true);
          precinctLayer.bringToFront?.();
          if (_mapCtrl.current?.currentPartyId) refreshPartyFilter();
          else if (_mapCtrl.current) _mapCtrl.current.updatePrecinctDots(null);
        });
      }
      if (controlDiv) {
        controlDiv.querySelectorAll(".level-control-item").forEach(el => {
          el.classList.toggle("lc-active", el.dataset.level === currentLevel);
        });
      }
      if (levelId !== "precinct") refreshPartyFilter();
    }

    const LevelControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create("div", "leaflet-level-control");
        L.DomEvent.disableClickPropagation(div);
        _levelControlDiv = div;
        const title = L.DomUtil.create("div", "level-control-title", div);
        title.textContent = t("elections.map_level");

        availableLevels.forEach(lvl => {
          const item = L.DomUtil.create("div", "level-control-item", div);
          item.dataset.level = lvl.id;
          item.textContent = lvl.label;
          if (lvl.id === currentLevel) item.classList.add("lc-active");
          if (multiLevel) {
            item.classList.add("lc-clickable");
            L.DomEvent.on(item, "click", () => applyLevel(lvl.id, div, {clearSelection: true}));
          }
        });
        return div;
      }
    });
    new LevelControl({ position: "topright" }).addTo(map);
    applyLevel(currentLevel, null, {updateUrl: false});

    function restoreSelectedUnitFromUrl() {
      if (!currentSelectedUnitLevel || !currentSelectedUnit) return;
      if (!availableLevels.some(lvl => lvl.id === currentSelectedUnitLevel)) return;

      const restorePanel = () => {
        applySelection(currentSelectedUnitLevel, currentSelectedUnit, {updateUrl: false});
      };

      if (currentSelectedUnitLevel === "precinct" && (precinctGeoPath || precinctCsvPath)) {
        _ensurePrecinctLayer().then(() => {
          applyLevel("precinct", _levelControlDiv, {updateUrl: false});
          setTimeout(restorePanel, 0);
        });
      } else {
        if (currentSelectedUnitLevel !== currentLevel) {
          applyLevel(currentSelectedUnitLevel, _levelControlDiv, {updateUrl: false});
        }
        setTimeout(restorePanel, 0);
      }
    }

    // ── Party filter: lookups for district, selfgov, and precinct vote shares ─
    function addShare(shareMap, areaId, partyId, voteShare) {
      const key = String(areaId);
      if (!shareMap.has(key)) shareMap.set(key, new Map());
      const shares = shareMap.get(key);
      shares.set(partyId, (shares.get(partyId) ?? 0) + (Number(voteShare) || 0));
    }

    const _shareByPartyByDistrict = new Map();
    for (const r of _districtRows) {
      addShare(_shareByPartyByDistrict, r.district_id, r.party_id, r.vote_share);
    }

    const _shareByPartyBySelfgov = new Map();
    for (const r of selfgovResults) {
      if (String(r.district_id) === "national") continue;
      addShare(_shareByPartyBySelfgov, r.district_id, r.party_id, r.vote_share);
    }

    const _shareByPartyByCouncilDistrict = new Map();
    for (const r of councilDistrictResults) {
      if (String(r.district_id) === "national") continue;
      addShare(_shareByPartyByCouncilDistrict, r.district_id, r.party_id, r.vote_share);
    }

    // ── Map legend control (bottom-left) ────────────────────────────────────
    function buildLegendHTML(activePartyId, legendMinVal, legendMaxVal) {
      if (viewMode === "turnout" || activePartyId) {
        const fromColor  = activePartyId ? "#f5f5f5" : "#fee2e2";
        const toColor    = activePartyId ? partyColor(activePartyId, electionVal?.id) : "#b91c1c";
        const stops      = [0, 0.25, 0.5, 0.75, 1.0];
        const stopColors = stops.map(s => d3.interpolateRgb(fromColor, toColor)(s));
        const gradCss    = `linear-gradient(to right, ${stopColors.join(", ")})`;

        let minLabel, maxLabel;
        if (activePartyId) {
          // Show actual min/max vote-share values for this party across districts
          const minPct = legendMinVal != null ? `${(legendMinVal * 100).toFixed(1)}%` : "0%";
          const maxPct = legendMaxVal != null ? `${(legendMaxVal * 100).toFixed(1)}%` : "—";
          minLabel = minPct;
          maxLabel = maxPct;
        } else {
          // Turnout metric: show 0 and realistic ceiling
          minLabel = "0%";
          maxLabel = _turnoutMetricCtrl.value === "invalid" ? `${(_invalidMax * 100).toFixed(0)}%`
                   : _turnoutMetricCtrl.value === "noon"    ? "30%"
                   : _turnoutMetricCtrl.value === "5pm"     ? "60%"
                   : "100%";
        }
        const labels = ["", "", "", "", ""];
        labels[0] = minLabel;
        labels[4] = maxLabel;

        const metricLabel = !activePartyId && viewMode === "turnout"
          ? `<div style="font-size:0.62rem;color:#555;font-weight:600;margin-bottom:3px;">${t("elections.turnout.metric." + _turnoutMetricCtrl.value) || _turnoutMetricCtrl.value}</div>`
          : "";
        return `<div style="min-width:140px;">${metricLabel}
          <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:#555;margin-bottom:2px;">
            ${labels.map(l => `<span>${l}</span>`).join("")}
          </div>
          <div style="height:10px;border-radius:2px;background:${gradCss};"></div>
        </div>`;
      } else {
        const _mapWinnerIds  = new Set([...winnerByDistrict.values()].map(w => w.party_id));
        const _legendParties = passed.filter(p => _mapWinnerIds.has(p.party_id));
        // Long party names wrap inside the legend's max-width (240px). The dot
        // sticks to the top of the wrapped block so the layout reads like a
        // bulleted list rather than a vertically-centred floating swatch.
        return `<div style="display:flex;flex-direction:column;gap:4px;">
          ${_legendParties.map(p => {
            const name = p.party?.name?.[lang] || p.party_id;
            return `<div style="display:flex;align-items:flex-start;gap:5px;">
              <span style="width:9px;height:9px;border-radius:2px;background:${p.color};display:inline-block;flex-shrink:0;margin-top:3px;"></span>
              <span style="font-size:0.65rem;color:#333;line-height:1.3;word-break:break-word;">${name}</span>
            </div>`;
          }).join("")}
        </div>`;
      }
    }

    const LegendControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create("div", "map-legend");
        L.DomEvent.disableClickPropagation(div);
        div.innerHTML = buildLegendHTML(null);
        return div;
      }
    });
    const _legendCtrl = new LegendControl({ position: "bottomleft" }).addTo(map);

    // ── Zoom-to-country button (below +/−) ───────────────────────────────────
    function boundsForFeatures(geo, predicate) {
      const features = geo?.features?.filter(predicate) ?? [];
      if (features.length === 0) return null;
      const bounds = L.geoJSON({type: "FeatureCollection", features}).getBounds();
      return bounds.isValid() ? bounds : null;
    }

    function zoomToTbilisi() {
      const selfgovBounds = boundsForFeatures(selfgovGeoData, f => String(f.properties?.id) === "1");
      const districtBounds = boundsForFeatures(activeGeo, f => {
        const id = Number(geoId(f));
        return id >= 1 && id <= 10;
      });
      const councilBounds = boundsForFeatures(councilDistrictGeoData, f =>
        councilSelfgovIdFromMajorId(geoId(f)) === "1"
      );
      const bounds = selfgovBounds ?? districtBounds ?? councilBounds;
      if (bounds) map.fitBounds(bounds.pad(0.08), {maxZoom: 12});
      else map.setView([41.7151, 44.8271], 11);
    }

    const ZoomHomeControl = L.Control.extend({
      onAdd(map) {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const btn = L.DomUtil.create("a", "", container);
        btn.href  = "#";
        const _label = t("elections.map.zoom_georgia");
        btn.title = _label;
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", _label);
        btn.style.cssText = "display:flex;align-items:center;justify-content:center;width:26px;height:26px;color:#444;";
        btn.innerHTML = GEORGIA_OUTLINE_SVG;
        L.DomEvent.on(btn, "click", e => {
          L.DomEvent.preventDefault(e);
          map.setView([42.1, 43.0], 7);
        });
        const tbilisiBtn = L.DomUtil.create("a", "", container);
        tbilisiBtn.href = "#";
        const _tbilisiLabel = t("elections.map.zoom_tbilisi");
        tbilisiBtn.title = _tbilisiLabel;
        tbilisiBtn.setAttribute("role", "button");
        tbilisiBtn.setAttribute("aria-label", _tbilisiLabel);
        tbilisiBtn.style.cssText = "display:flex;align-items:center;justify-content:center;width:26px;height:26px;color:#444;text-decoration:none;";
        tbilisiBtn.innerHTML = TBILISI_OUTLINE_SVG;
        L.DomEvent.on(tbilisiBtn, "click", e => {
          L.DomEvent.preventDefault(e);
          zoomToTbilisi();
        });
        L.DomEvent.disableClickPropagation(container);
        return container;
      }
    });
    new ZoomHomeControl({ position: "topleft" }).addTo(map);

    // ── Share button (below Tbilisi zoom button, same gap as between controls) ─
    if (shareUrlForCurrentMap) {
      const ShareControl = L.Control.extend({
        onAdd() {
          const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
          const btn = L.DomUtil.create("a", "", container);
          btn.href = "#";
          const _label = t("elections.map.share_view");
          btn.title = _label;
          btn.setAttribute("role", "button");
          btn.setAttribute("aria-label", _label);
          btn.style.cssText = "display:flex;align-items:center;justify-content:center;width:26px;height:26px;color:#444;text-decoration:none;";
          btn.innerHTML = SHARE_ICON_SVG;
          L.DomEvent.on(btn, "click", async e => {
            L.DomEvent.preventDefault(e);
            const url = shareUrlForCurrentMap();
            try {
              await navigator.clipboard.writeText(url);
              btn.innerHTML = CHECK_ICON_SVG;
              btn.style.color = "#2d7d46";
              setTimeout(() => { btn.innerHTML = SHARE_ICON_SVG; btn.style.color = "#444"; }, 1200);
            } catch {
              window.prompt(_label, url);
            }
          });
          L.DomEvent.disableClickPropagation(container);
          return container;
        }
      });
      new ShareControl({ position: "topleft" }).addTo(map);
    }

    // ── Fullscreen toggle ──────────────────────────────────────────────────
    // Pops the map's parent wrapper (.elections-main) into the browser's
    // fullscreen API — fullscreening the WRAPPER, not just mapContainer, so
    // the right-side results panel (a sibling of the map card) stays visible
    // and CSS (.elections-main:fullscreen > .results-panel) positions it as
    // an overlay in the top-right corner. Listens for `fullscreenchange` so
    // pressing Escape flips the icon back. Calls `map.invalidateSize()` after
    // each transition so Leaflet recomputes tile layout for the new viewport.
    const FullscreenControl = L.Control.extend({
      onAdd() {
        const control = this;
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const btn = L.DomUtil.create("a", "", container);
        btn.href = "#";
        btn.setAttribute("role", "button");
        btn.style.cssText = "display:flex;align-items:center;justify-content:center;width:26px;height:26px;color:#444;text-decoration:none;";
        let panelObserver = null;
        let panelObserverTarget = null;
        let panelObserverFrame = null;
        let zoomBoosted = false;
        let panelCollapsed = false;

        // Fullscreen target: the layout wrapper holding both map + panel.
        // Falls back to mapContainer when the wrapper isn't present.
        const fsTarget = () => mapContainer.closest(".elections-main") || document.querySelector(".elections-main") || mapContainer;
        const _fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
        const _isMapFs = () => {
          const target = fsTarget();
          const fsEl = _fsEl();
          return !!fsEl && (fsEl === target || target.contains(fsEl) || fsEl.contains(target));
        };
        const rememberStyle = el => {
          if (!el || el.dataset.mapFsStyle != null) return;
          el.dataset.mapFsStyle = el.getAttribute("style") ?? "";
        };
        const restoreStyle = el => {
          if (!el || el.dataset.mapFsStyle == null) return;
          const previous = el.dataset.mapFsStyle;
          if (previous) el.setAttribute("style", previous);
          else el.removeAttribute("style");
          delete el.dataset.mapFsStyle;
        };
        const setImportant = (el, prop, value) => el?.style?.setProperty(prop, value, "important");
        function scheduleFullscreenLayout() {
          if (panelObserverFrame != null) return;
          panelObserverFrame = requestAnimationFrame(() => {
            panelObserverFrame = null;
            if (_fullscreenState.active || _isMapFs()) applyFullscreenLayout(true);
          });
        }
        function watchFullscreenPanel(active) {
          if (!active) {
            if (panelObserver) panelObserver.disconnect();
            panelObserver = null;
            panelObserverTarget = null;
            if (panelObserverFrame != null) {
              cancelAnimationFrame(panelObserverFrame);
              panelObserverFrame = null;
            }
            return;
          }
          if (typeof MutationObserver === "undefined") return;
          const target = fsTarget();
          if (panelObserver && panelObserverTarget === target) return;
          if (panelObserver) panelObserver.disconnect();
          panelObserver = new MutationObserver(scheduleFullscreenLayout);
          panelObserver.observe(target, {childList: true});
          panelObserverTarget = target;
          control._panelObserver = panelObserver;
        }
        function decorateFullscreenPanel(panel, active) {
          if (!panel) return;
          panel.classList.toggle("results-panel-fullscreen", active);
          panel.classList.toggle("results-panel-collapsed", active && panelCollapsed);

          let toggle = panel.querySelector(":scope > .results-panel-toggle");
          if (!active) {
            if (toggle) toggle.remove();
            panel.classList.remove("results-panel-fullscreen", "results-panel-collapsed");
            return;
          }

          if (!toggle) {
            toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "results-panel-toggle";
            toggle.addEventListener("click", e => {
              e.preventDefault();
              e.stopPropagation();
              panelCollapsed = !panelCollapsed;
              decorateFullscreenPanel(panel, true);
              applyFullscreenLayout(true);
            });
            L.DomEvent.disableClickPropagation(toggle);
            L.DomEvent.disableScrollPropagation(toggle);
            panel.prepend(toggle);
          }

          toggle.innerHTML = panelCollapsed ? PANEL_EXPAND_SVG : PANEL_MINIMIZE_SVG;
          const label = t(panelCollapsed ? "elections.map.expand_infobox" : "elections.map.minimize_infobox");
          toggle.title = label;
          toggle.setAttribute("aria-label", label);
        }
        function zoomForFullscreenEntry() {
          setTimeout(() => {
            map.invalidateSize();
            const nextZoom = Math.min(map.getMaxZoom?.() ?? 19, map.getZoom() + 2);
            map.setZoom(nextZoom, {animate: true});
          }, 180);
        }
        function applyFullscreenLayout(active) {
          const target = fsTarget();
          const mapCard = mapContainer.closest(".card");
          const panel = target.querySelector(".results-panel");
          _fullscreenState.active = active;
          target.classList.toggle("map-fullscreen-active", active);
          watchFullscreenPanel(active);

          if (!active) {
            panelCollapsed = false;
            decorateFullscreenPanel(panel, false);
            [panel, mapContainer, mapCard, target].forEach(restoreStyle);
            return;
          }

          [target, mapCard, mapContainer, panel].forEach(rememberStyle);
          Object.entries({
            display: "block",
            position: "fixed",
            inset: "0",
            width: "100vw",
            height: "100vh",
            margin: "0",
            padding: "0",
            overflow: "hidden"
          }).forEach(([prop, value]) => setImportant(target, prop, value));

          Object.entries({
            position: "relative",
            width: "100vw",
            height: "100vh",
            margin: "0",
            padding: "0",
            overflow: "hidden",
            "border-radius": "0",
            "box-shadow": "none"
          }).forEach(([prop, value]) => setImportant(mapCard, prop, value));

          setImportant(mapContainer, "width", "100%");
          setImportant(mapContainer, "height", "100%");

          if (panel) {
            decorateFullscreenPanel(panel, true);
            Object.entries({
              position: "absolute",
              right: "16px",
              bottom: "16px",
              top: "auto",
              width: panelCollapsed ? "42px" : "340px",
              height: panelCollapsed ? "42px" : "auto",
              "min-height": "0",
              "max-width": "calc(100vw - 32px)",
              "max-height": panelCollapsed ? "42px" : "min(55vh, calc(100vh - 32px))",
              "overflow-y": panelCollapsed ? "hidden" : "auto",
              padding: panelCollapsed ? "6px" : "2.75rem 1.25rem 1.25rem",
              "z-index": "1000"
            }).forEach(([prop, value]) => setImportant(panel, prop, value));
          }
        }

        function syncIcon() {
          const fs = _isMapFs() || _fullscreenState.active;
          applyFullscreenLayout(fs);
          if (fs && !zoomBoosted) {
            zoomBoosted = true;
            zoomForFullscreenEntry();
          }
          btn.innerHTML = fs ? FULLSCREEN_EXIT_SVG : FULLSCREEN_ENTER_SVG;
          const label = t(fs ? "elections.map.exit_fullscreen" : "elections.map.enter_fullscreen");
          btn.title = label;
          btn.setAttribute("aria-label", label);
          // Give Leaflet a moment to settle into the new viewport then redraw tiles
          setTimeout(() => map.invalidateSize(), 120);
        }
        function handleFullscreenChange() {
          if (!_fsEl()) {
            zoomBoosted = false;
            applyFullscreenLayout(false);
          }
          syncIcon();
        }
        syncIcon();
        this._cleanupPanelObserver = () => watchFullscreenPanel(false);

        L.DomEvent.on(btn, "click", e => {
          L.DomEvent.preventDefault(e);
          if (_isMapFs() || _fullscreenState.active) {
            zoomBoosted = false;
            applyFullscreenLayout(false);
            (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
          } else {
            const target = fsTarget();
            const fn = target.requestFullscreen || target.webkitRequestFullscreen;
            applyFullscreenLayout(true);
            zoomBoosted = true;
            zoomForFullscreenEntry();
            const request = fn?.call(target);
            if (request?.catch) request.catch(() => applyFullscreenLayout(false));
          }
        });

        this._escapeListener = e => {
          if (e.key === "Escape" && _fullscreenState.active) {
            zoomBoosted = false;
            applyFullscreenLayout(false);
          }
        };
        document.addEventListener("keydown", this._escapeListener);

        // Track changes (including Escape) — keep a ref so onRemove can detach.
        this._fsListener = handleFullscreenChange;
        document.addEventListener("fullscreenchange", this._fsListener);
        document.addEventListener("webkitfullscreenchange", this._fsListener);

        L.DomEvent.disableClickPropagation(container);
        return container;
      },
      onRemove() {
        if (this._cleanupPanelObserver) this._cleanupPanelObserver();
        else if (this._panelObserver) this._panelObserver.disconnect();
        if (this._escapeListener) document.removeEventListener("keydown", this._escapeListener);
        if (this._fsListener) {
          document.removeEventListener("fullscreenchange", this._fsListener);
          document.removeEventListener("webkitfullscreenchange", this._fsListener);
        }
      }
    });
    new FullscreenControl({ position: "topleft" }).addTo(map);

    // ── Overlay opacity slider ───────────────────────────────────────────────
    // Lets the user dim the choropleth so the basemap's settlement names
    // bleed through. Implementation: drive a CSS custom property on the map
    // container; the matching stylesheet rule applies `opacity` to the
    // Leaflet overlay panes (where path/circle SVG elements live). One
    // property → both polygon layers and precinct circles fade together, no
    // per-layer re-styling needed.
    const OpacityControl = L.Control.extend({
      onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control map-opacity-ctrl");
        const toggle = L.DomUtil.create("a", "map-opacity-toggle", container);
        toggle.href = "#";
        toggle.setAttribute("role", "button");
        const labelTxt = t("elections.map.layer_opacity") || "Layer opacity";
        toggle.title = labelTxt;
        toggle.setAttribute("aria-label", labelTxt);
        // Half-shaded circle icon = the opacity concept at a glance.
        toggle.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M12 2 a10 10 0 0 0 0 20 z" fill="currentColor"/>
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
          </svg>`;
        const tray = L.DomUtil.create("div", "map-opacity-tray", container);
        tray.hidden = true;
        const slider = L.DomUtil.create("input", "map-opacity-slider", tray);
        slider.type = "range";
        slider.min = "20";
        slider.max = "100";
        slider.step = "5";
        slider.value = String(Math.round((mapContainer.dataset.overlayOpacity ?? 1) * 100));
        slider.setAttribute("aria-label", labelTxt);
        const valueEl = L.DomUtil.create("span", "map-opacity-value", tray);
        valueEl.textContent = slider.value + "%";

        function applyOpacity(pct) {
          const ratio = Math.max(0.05, Math.min(1, pct / 100));
          mapContainer.style.setProperty("--map-overlay-opacity", String(ratio));
          mapContainer.dataset.overlayOpacity = String(ratio);
          valueEl.textContent = pct + "%";
        }

        L.DomEvent.on(toggle, "click", e => {
          L.DomEvent.preventDefault(e);
          tray.hidden = !tray.hidden;
          container.classList.toggle("map-opacity-open", !tray.hidden);
        });
        L.DomEvent.on(slider, "input", () => applyOpacity(Number(slider.value)));

        // Initialise from the data attribute so the value survives a control
        // re-mount (e.g. when the map cell re-runs on a language change).
        if (mapContainer.dataset.overlayOpacity != null) {
          applyOpacity(Math.round(Number(mapContainer.dataset.overlayOpacity) * 100));
        }

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        return container;
      }
    });
    new OpacityControl({ position: "topleft" }).addTo(map);

    // Expose imperative map controls for bar chart clicks (toggles party filter)
    _mapCtrl.current = {
      currentPartyId: null,
      currentTurnoutMetric: _turnoutMetricCtrl.value ?? "final",
      currentLevel,
      currentSelectedUnitLevel,
      currentSelectedUnit,
      legendDiv: _legendCtrl.getContainer(),

      // Imperative language refresh — called from a separate lang-only cell in elections.md
      // so a language toggle does NOT invalidate the map cell (which would tear down Leaflet,
      // re-fetch tiles, and rebuild every layer). Only the legend is re-rendered here; tooltip
      // labels are refreshed for the next hover. Layer-bound static tooltips, button titles
      // and the level-control labels stay in whichever language was active at build time —
      // they catch up on the next election / vote-type switch.
      setLang(newLang, newT) {
        if (newLang === lang && newT === t) return;
        lang = newLang;
        t    = newT;
        _tooltipLabels = _computeTooltipLabels();
        if (this.legendDiv) this.legendDiv.innerHTML = buildLegendHTML(this.currentPartyId);
      },

      getShareState() {
        const center = map.getCenter();
        return {
          lat: center.lat,
          lng: center.lng,
          z: map.getZoom(),
          level: currentLevel,
          party: this.currentPartyId,
          unitLevel: this.currentSelectedUnitLevel,
          unit: this.currentSelectedUnit,
          metric: this.currentTurnoutMetric
        };
      },

      setTurnoutMetric(metric) {
        this.currentTurnoutMetric = metric;
        _turnoutMetricCtrl.value  = metric;
        // Highlight active metric rows in the displayed panel
        document.querySelectorAll(".turnout-metric-row[data-metric]").forEach(row => {
          row.classList.toggle("metric-row-active", row.dataset.metric === metric);
        });
        // Restyle the active map layer
        if (currentLevel === "district") {
          districtLayer.setStyle(districtStyle);
        } else if (currentLevel === "selfgov" && selfgovLayer && _selfgovStyleFn) {
          selfgovLayer.setStyle(_selfgovStyleFn);
        } else if (currentLevel === "council_district" && councilDistrictLayer && _councilDistrictStyleFn) {
          councilDistrictLayer.setStyle(_councilDistrictStyleFn);
        }
        // Update precinct dots
        this.updatePrecinctDots(viewMode === "turnout" ? null : this.currentPartyId);
        // Update legend
        if (this.legendDiv) this.legendDiv.innerHTML = buildLegendHTML(null);
      },

      setPartyFilter(partyId, force = false) {
        // Radio behaviour: clicking the active party deselects; clicking a new one replaces
        const newId = force ? partyId : (this.currentPartyId === partyId ? null : partyId);
        this.currentPartyId = newId;
        if (_partyCtrl) _partyCtrl.value = newId;

        // Visual feedback: highlight matching rows in bar chart, district/
        // precinct tables, and the seat legend so the user can always see
        // which party drives the map colouring (whether they arrived via a
        // ?party= link from /parties or clicked a row themselves).
        document.querySelectorAll(".bar-row[data-party-id]").forEach(row => {
          row.classList.toggle("bar-row-active", newId != null && row.dataset.partyId === newId);
        });
        document.querySelectorAll(".dist-table-row[data-party-id]").forEach(row => {
          row.classList.toggle("dist-table-row-active", newId != null && row.dataset.partyId === newId);
        });
        document.querySelectorAll(".seat-legend-row[data-party-id]").forEach(row => {
          row.classList.toggle("seat-legend-row-active", newId != null && row.dataset.partyId === newId);
        });

        // Only restyle the active layer; others must stay hollow
        const districtIsActive        = currentLevel === "district";
        const selfgovIsActive         = currentLevel === "selfgov";
        const councilDistrictIsActive = currentLevel === "council_district";
        const precinctIsActive        = currentLevel === "precinct";

        // Compute min/max from the active layer's share map
        const _activeShareMap = precinctIsActive && _shareByPartyByPrecinct.size
          ? _shareByPartyByPrecinct
          : councilDistrictIsActive
            ? _shareByPartyByCouncilDistrict
            : selfgovIsActive
              ? _shareByPartyBySelfgov
              : _shareByPartyByDistrict;
        const allShares = newId
          ? [..._activeShareMap.values()].map(m => m.get(newId) ?? 0).filter(v => v > 0)
          : [];
        const minShare = allShares.length ? d3.min(allShares) : 0;
        const maxShare = allShares.length ? d3.max(allShares) : 1;
        const range    = (maxShare - minShare) || 1;

        if (newId && districtIsActive) {
          const color = partyColor(newId, electionVal?.id);
          districtLayer.setStyle(feature => {
            const did   = geoId(feature);
            const share = _shareByPartyByDistrict.get(did)?.get(newId) ?? 0;
            return {
              fillColor:   d3.interpolateRgb("#f5f5f5", color)(0.15 + ((share - minShare) / range) * 0.85),
              fillOpacity: 0.9, color: "#ffffff", weight: 0.5
            };
          });
        } else if (districtIsActive) {
          districtLayer.setStyle(districtStyle);
        }

        if (newId && selfgovIsActive && selfgovLayer) {
          const color = partyColor(newId, electionVal?.id);
          selfgovLayer.setStyle(feature => {
            const sgid  = geoId(feature);
            const share = _shareByPartyBySelfgov.get(sgid)?.get(newId) ?? 0;
            return {
              fillColor:   d3.interpolateRgb("#f5f5f5", color)(0.15 + ((share - minShare) / range) * 0.85),
              fillOpacity: 0.9, color: "#ffffff", weight: 0.8
            };
          });
        } else if (selfgovIsActive && selfgovLayer && _selfgovStyleFn) {
          selfgovLayer.setStyle(_selfgovStyleFn);
        }

        if (newId && councilDistrictIsActive && councilDistrictLayer) {
          const color = partyColor(newId, electionVal?.id);
          councilDistrictLayer.setStyle(feature => {
            const did   = geoId(feature);
            const share = _shareByPartyByCouncilDistrict.get(did)?.get(newId) ?? 0;
            return {
              fillColor:   d3.interpolateRgb("#f5f5f5", color)(0.15 + ((share - minShare) / range) * 0.85),
              fillOpacity: 0.9, color: "#ffffff", weight: 0.8
            };
          });
        } else if (councilDistrictIsActive && councilDistrictLayer && _councilDistrictStyleFn) {
          councilDistrictLayer.setStyle(_councilDistrictStyleFn);
        }

        // Always fully re-style precinct dots from scratch (prevents stale colours)
        this.updatePrecinctDots(newId, minShare, maxShare);

        // Update legend — pass actual min/max so labels show real percentages
        if (this.legendDiv) this.legendDiv.innerHTML = buildLegendHTML(newId, newId ? minShare : null, newId ? maxShare : null);
      },

      updatePrecinctDots(activePartyId, distMinShare, distMaxShare) {
        if (!precinctLayer) return;
        let minS = 0, maxS = 1, range = 1;
        if (activePartyId) {
          // Use precinct-level min/max if available, else fall back to district-level values
          const precinctShares = [..._shareByPartyByPrecinct.values()]
            .map(m => m.get(activePartyId) ?? 0).filter(v => v > 0);
          minS  = precinctShares.length ? d3.min(precinctShares) : (distMinShare ?? 0);
          maxS  = precinctShares.length ? d3.max(precinctShares) : (distMaxShare ?? 1);
          range = (maxS - minS) || 1;
        }
        precinctLayer.eachLayer(l => {
          const pid       = String(Math.round(l.feature?.properties?.id ?? 0));
          const resultKey = precinctFeatureResultKey(l.feature) ?? pid;
          const _rawD     = precinctRawDistrict(l.feature);
          const _dn       = Number(_rawD);
          // Council SMD: resolve via precinct→major_id map; local SMD: Tbilisi fold; others: electoral district
          const parentDid = precinctParentId(l.feature, pid);
          let fillColor;
          if (activePartyId) {
            const share = _shareByPartyByPrecinct.get(resultKey)?.get(activePartyId)
                       ?? _shareByPartyByPrecinct.get(pid)?.get(activePartyId)
                       ?? _shareByPartyByCouncilDistrict.get(parentDid)?.get(activePartyId)
                       ?? _shareByPartyByDistrict.get(parentDid)?.get(activePartyId)
                       ?? _shareByPartyBySelfgov.get(parentDid)?.get(activePartyId)
                       ?? 0;
            const color = partyColor(activePartyId, electionVal?.id);
            fillColor = d3.interpolateRgb("#f5f5f5", color)(0.15 + ((share - minS) / range) * 0.85);
          } else if (viewMode === "turnout") {
            const td = _precinctTurnoutByStation.get(resultKey) ?? _precinctTurnoutByStation.get(pid) ?? turnoutByDistrict.get(parentDid);
            fillColor = d3.interpolateRgb("#fee2e2", "#b91c1c")(turnoutNorm(td, _turnoutMetricCtrl.value, _invalidMax));
          } else {
            const winner = winnerByPrecinct.get(resultKey) ?? winnerByPrecinct.get(pid) ?? winnerByDistrict.get(parentDid);
            const color  = winner ? partyColor(winner.party_id, electionVal?.id) : "#ccc";
            const intensity = shareByPrecinct.get(resultKey) ?? shareByPrecinct.get(pid) ?? shareByDistrict.get(parentDid) ?? 0.5;
            fillColor = d3.interpolateRgb("#f5f5f5", color)(0.4 + intensity * 0.6);
          }
          l.setStyle({fillColor, fillOpacity: 0.85});
        });
      }
    };

    if (viewMode !== "turnout" && _partyCtrl?.value) {
      _mapCtrl.current.setPartyFilter(_partyCtrl.value, true);
    }
    restoreSelectedUnitFromUrl();
  }

  setTimeout(() => map.invalidateSize(), 150);
}
