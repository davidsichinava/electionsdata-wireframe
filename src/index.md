---
theme: [air, alt, wide]
title: Main Page
toc: false
---

```js
import L from "npm:leaflet";
import * as d3 from "npm:d3";
import {getLang, tr} from "./components/state.js";
const dict      = await FileAttachment("data/config/translations.json").json();
const elections = await FileAttachment("data/elections.json").json();
const parties   = await FileAttachment("data/parties.json").json();
const _featured = await FileAttachment("data/index-featured.json").json();
```

```js
const lang = getLang();
```

```js
const t = k => tr(dict, lang, k);
```

```js
// Featured election: data pre-computed server-side by index-featured.json.js
const featured = elections.find(e => e.id === _featured.electionId);
const featGeo  = _featured.geo;
const featCsv  = _featured.csv ?? [];

// Winner-by-district lookup
const _winnerMap = new Map();
d3.group(featCsv, r => String(r.district_id)).forEach((rows, distId) => {
  _winnerMap.set(distId, rows.reduce((a, b) => b.vote_share > a.vote_share ? b : a));
});

// Presidential elections key colors / names by candidate id (CSV's party_id holds
// the candidate id), so source from featured.candidates. Other types use the
// per-election parties list + the global parties registry.
const _isPresidential = featured?.type === "presidential";
const _featContestants = _isPresidential
  ? (featured?.candidates ?? []).map(c => ({
      id: c.id,
      color: c.color,
      alias: c.name ? { ka: c.name.ka, en: c.name.en } : undefined
    }))
  : (featured?.parties ?? []);
const _featById = new Map(_featContestants.map(c => [c.id, c]));

function featPartyColor(partyId) {
  return _featById.get(partyId)?.color
      ?? parties.find(p => p.id === partyId)?.color
      ?? "#9E9E9E";
}
function featPartyName(p) {
  return p.alias?.[lang] || p.alias?.en
    || parties.find(q => q.id === p.id)?.name?.[lang]
    || parties.find(q => q.id === p.id)?.name?.en
    || p.id;
}
```

```js
// Stable map container — fixed height so Leaflet has a concrete size
const mapContainer = html`<div style="width:100%;height:440px;z-index:0;"></div>`;
```

```js
// ── Layout (re-runs on language change) ─────────────────────────────────────
lang;

const _typeOrder = ["parliamentary", "presidential", "local", "adjara", "plebiscite"];
const _byType    = d3.group(elections, e => e.type);

const featName  = featured?.name?.[lang] || featured?.name?.en || "";
const featYear  = (featured?.date ?? "").slice(0, 4);
const featNotes = (featured?.notes?.[lang] || featured?.notes?.en || "").trim();
const featUrl   = featured ? `elections?type=${featured.type}&election=${featured.id}` : "elections";

// Browse section — collapsible per type with election cards inside
function renderBrowseSection(typeKey) {
  const list = (_byType.get(typeKey) ?? []).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  if (!list.length) return "";
  const cards = list.map(e => {
    const name = e.name?.[lang] || e.name?.en || e.id;
    const year = (e.date ?? "").slice(0, 4);
    const url  = `elections?type=${e.type}&election=${e.id}`;
    const hasData = !!(e.files?.pr_results || e.files?.smd_results);
    return html`<a href="${url}" class="idx-elec-card${hasData ? "" : " idx-elec-card-nodata"}">
      <div class="idx-elec-card-year">${year}</div>
      <div class="idx-elec-card-name">${name}</div>
    </a>`;
  });
  return html`<details class="idx-browse-section">
    <summary class="idx-browse-summary">
      <span class="idx-browse-type-label">${t(`type.${typeKey}`)}</span>
      <span class="idx-browse-count">${list.length}</span>
      <span class="idx-browse-chevron">▸</span>
    </summary>
    <div class="idx-elec-cards">${cards}</div>
  </details>`;
}

const layout = html`
<div class="idx-page-wrap">

  <div class="idx-home-grid">
    <div class="card idx-map-card">
      <div class="idx-map-header">
        <span class="idx-map-header-name">${featName}</span>
        <a href="${featUrl}" class="idx-map-explore">${t("main.card.open")} →</a>
      </div>
      ${mapContainer}
    </div>

    <div class="card idx-info-card">
      <div class="idx-info-elec-label">${t("main.featured_title")}</div>
      <div class="idx-info-elec-name">${featName}</div>
      <div class="idx-info-meta">${featYear}</div>
      ${(() => { if (!featNotes) return ""; const _n = document.createElement("p"); _n.className = "idx-info-notes"; _n.innerHTML = featNotes; return _n; })()}
      <a href="${featUrl}" class="idx-explore-btn">${t("main.card.open")} →</a>
    </div>
  </div>

  <h3 style="margin:1.75rem 0 1rem;">${t("main.browse_title")}</h3>
  ${_typeOrder.map(k => renderBrowseSection(k))}

</div>
`;

display(layout);
```

```js
// Map IIFE — lang dep ensures this runs after the layout cell has called display()
lang;
{
  const map = L.map(mapContainer, {zoomControl: false, scrollWheelZoom: false})
    .setView([42.1, 43.0], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19
  }).addTo(map);

  if (featGeo) {
    L.geoJSON(featGeo, {
      style: feature => {
        const distId = String(feature.properties.id ?? feature.properties.ID ?? "");
        const winner = _winnerMap.get(distId);
        return {
          fillColor:   winner ? featPartyColor(winner.party_id) : "#ccc",
          fillOpacity: 0.82,
          color:       "#fff",
          weight:      0.8
        };
      },
      interactive: false
    }).addTo(map);
  }

  // ── Legend: only parties / candidates that actually won at least one district ──
  const _winnerPartyIds = new Set([..._winnerMap.values()].map(w => w.party_id));
  const _legendItems = _featContestants
    .filter(p => _winnerPartyIds.has(p.id))
    .map(p => ({ id: p.id, name: featPartyName(p), color: featPartyColor(p.id) }));

  if (_legendItems.length > 0) {
    const LegendControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create("div");
        div.style.cssText = "background:rgba(255,255,255,0.92);padding:6px 8px;border-radius:5px;box-shadow:0 1px 4px rgba(0,0,0,0.15);font-size:0.72rem;line-height:1.6;";
        div.innerHTML = _legendItems.map(item =>
          `<div style="display:flex;align-items:center;gap:5px;">
            <span style="width:9px;height:9px;border-radius:2px;background:${item.color};display:inline-block;flex-shrink:0;"></span>
            <span style="white-space:nowrap;color:#333;">${item.name}</span>
          </div>`
        ).join("");
        return div;
      }
    });
    new LegendControl({ position: "bottomleft" }).addTo(map);
  }

  setTimeout(() => map.invalidateSize(), 100);
  invalidation.then(() => { try { map.remove(); } catch(e) {} });
}
```
