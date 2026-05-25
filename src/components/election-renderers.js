import {html} from "npm:htl";
import * as d3 from "npm:d3";
import {seatsFor, partiesForFilter, councilSelfgovIdFromMajorId, formatTurnoutPcts} from "./election-utils.js";

// Factory: returns all chart renderer functions bound to current reactive state.
// Call once per reactive change:
//   const { renderBarChart, renderDots, ... } = makeRenderers({ t, lang, electionVal, ... });
export function makeRenderers({
  t, lang, electionVal,
  getParty, partyColor,
  selectPartyOnMap, _mapCtrl, _partyCtrl,
  passed, failed, presidentialWinnerId,
  viewMode, isPresidential, isPlebiscite,
  effectiveVoteType, results, seatFilter,
  _allCouncilSMDResults, _seatsMap, turnoutByDistrict, parties
}) {

  // ── Shared turnout row helpers (used by renderTurnoutPanel and renderPrecinctPanel) ──
  function metricRow(metric, label, value, sub) {
    if (!value) return "";
    const isActive = (_mapCtrl.current?.currentTurnoutMetric ?? "final") === metric;
    const el = html`<div class="turnout-metric-row${isActive ? " metric-row-active" : ""}" data-metric="${metric}">
      <span class="metric-row-label" style="color:var(--muted);">${label}</span>
      <span style="font-weight:700;">${value}${sub ? html`<span style="font-weight:400;color:var(--muted);font-size:0.74rem;margin-left:4px;">${sub}</span>` : ""}</span>
    </div>`;
    el.addEventListener("click", () => _mapCtrl.current?.setTurnoutMetric(metric));
    return el;
  }

  function statRow(label, value, sub) {
    return html`<div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
      <span style="color:var(--muted);">${label}</span>
      <span style="font-weight:700;">${value}${sub ? html`<span style="font-weight:400;color:var(--muted);font-size:0.75rem;margin-left:4px;">${sub}</span>` : ""}</span>
    </div>`;
  }

  // ── Shared back-to-national header for district / turnout panels ──────────
  function panelBackHeader(districtName) {
    const btn = html`<button style="background:none;border:none;cursor:pointer;font-size:0.75rem;color:var(--theme-foreground-focus);padding:0;display:inline-flex;align-items:center;gap:3px;line-height:1;">← ${t("elections.results.national")}</button>`;
    btn.addEventListener("click", showNationalPanel);
    return html`<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;padding-bottom:0.5rem;border-bottom:1px solid var(--border);">
      ${btn}
      <span style="color:var(--border);">|</span>
      <span style="font-size:0.85rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${districtName}</span>
    </div>`;
  }

  // ── National vote results panel ───────────────────────────────────────────
  function renderNationalPanel() {
    const resultTitle = t(isPresidential ? "elections.presidential.results_title"
                        : isPlebiscite   ? "elections.plebiscite_results_title"
                        :                  "elections.party_list_title");
    if (viewMode === "turnout") {
      return renderTurnoutPanel("national", {
        name_en: t("elections.results.national_unit"),
        name_ka: t("elections.results.national_unit")
      });
    }
    return html`<div class="card results-panel" id="results-panel">
      <div style="font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); margin-bottom:0.75rem; padding-bottom:0.5rem; border-bottom:1px solid var(--border);">
        ${t("elections.results.national")}
      </div>
      <div style="font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:0.5rem;">${resultTitle}</div>
      ${renderBarChart(passed, failed, electionVal?.id, presidentialWinnerId)}
    </div>`;
  }

  // Resets the info panel to national results (called by "National" controls)
  function showNationalPanel() {
    const panel = document.getElementById("results-panel");
    if (panel) panel.replaceWith(renderNationalPanel());
  }

  // Currently-selected party_id, from the map controller if mounted, else
  // from the URL-driven _partyCtrl (set before any render runs). Used by
  // renderers below to mark the matching row "active" on first paint so a
  // shared link like ?party=gd visually highlights GD in every legend.
  function selectedPartyId() {
    return _mapCtrl?.current?.currentPartyId ?? _partyCtrl?.value ?? null;
  }

  // ── Horizontal bar chart ──────────────────────────────────────────────────
  function renderBarChart(passed, failed, elecId, winnerId = null) {
    const maxVal = d3.max([...passed, ...failed], d => d.vote_share) || 1;
    const activeId = selectedPartyId();

    function barRow(d) {
      const pct      = (d.vote_share / maxVal) * 100;
      const shareStr = `${(d.vote_share * 100).toFixed(1)}%`;
      const countStr = d.votes != null ? d.votes.toLocaleString(lang === "ka" ? "ka-GE" : "en-US") : "—";
      const pname    = d.party?.name?.[lang] || d.party_id;
      const isWinner = winnerId && d.party_id === winnerId;
      const isActive = activeId != null && d.party_id === activeId;
      const el = html`
        <div class="bar-row${isActive ? " bar-row-active" : ""}" data-party-id="${d.party_id}" style="cursor:pointer;" title="${t("elections.chart.click_filter")}">
          <div class="bar-label" title="${pname}">
            <span class="party-dot" style="background:${d.color};"></span>${pname}
            ${isWinner ? html`<span style="margin-left:4px; font-size:0.68rem; background:${d.color}; color:#fff; border-radius:3px; padding:1px 5px; vertical-align:middle;">✓</span>` : ""}
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%; background:${d.color};"></div>
          </div>
          <div class="bar-value">
            <span class="bar-value-main">${shareStr}</span>
            <span class="bar-value-sub">${countStr}</span>
          </div>
        </div>
      `;
      el.addEventListener("click", () => selectPartyOnMap(d.party_id));
      return el;
    }

    return html`
      ${passed.map(barRow)}
      ${failed.length > 0 ? html`
        <details class="below-threshold-details">
          <summary class="below-threshold-summary">
            ${t("elections.chart.see_more")}
            <span class="below-threshold-count">${failed.length}</span>
          </summary>
          ${failed.map(barRow)}
        </details>
      ` : ""}
    `;
  }

  // ── Seat composition — rectangular tiles grouped by party ─────────────────
  function renderDots(parties, filter, elec) {
    const all = partiesForFilter(parties, filter, elec);
    const total = d3.sum(all, d => seatsFor(d, filter));
    if (total === 0) return html`<p style="color:var(--muted); font-size:0.85rem; text-align:center;">${t("elections.seats.no_data")}</p>`;

    const COLS = 10;
    return html`<div style="display:flex; flex-wrap:wrap; align-items:flex-start; gap:6px; padding:0.4rem 0;">
      ${all.map(d => {
        const seats = seatsFor(d, filter);
        if (seats === 0) return "";
        const cols = Math.min(seats, COLS);
        const pname = d.party?.name?.[lang] || d.party_id;
        return html`<div class="seat-block" style="width:${cols * 11}px;" title="${pname}: ${seats} ${t('elections.seats_label')}">
          ${Array.from({length: seats}, () =>
            html`<div class="seat-tile" style="background:${d.color};"></div>`
          )}
        </div>`;
      })}
    </div>`;
  }

  // ── Council seat grid — square dot grid for sakrebulo composition ─────────
  function renderCouncilDots(nationalArray, elec, filter) {
    const totalPR  = elec?.council?.total_pr_seats  ?? 200;
    const totalSMD = elec?.council?.total_smd_seats ?? 200;
    const total    = totalPR + totalSMD;
    const COLS     = Math.round(Math.sqrt(total));
    const ROWS     = Math.ceil(total / COLS);
    const totalSlots = COLS * ROWS;

    const all = partiesForFilter(nationalArray, filter, elec);
    if (d3.sum(all, d => seatsFor(d, filter)) === 0)
      return html`<p style="color:var(--muted); font-size:0.85rem; text-align:center;">${t("elections.seats.no_data")}</p>`;

    const dots = [];
    for (const d of all) {
      const n = seatsFor(d, filter);
      for (let i = 0; i < n; i++) dots.push(d.color);
    }
    while (dots.length < totalSlots) dots.push(null);

    return html`<div style="display:grid;grid-template-columns:repeat(${COLS},9px);gap:2px;margin-top:0.5rem;">
      ${dots.map(c => html`<div style="width:9px;height:9px;border-radius:1px;background:${c ?? "transparent"};opacity:${c ? 1 : 0};"></div>`)}
    </div>
    <div style="font-size:0.72rem;color:var(--muted);margin-top:4px;">${total} ${t("elections.seats_label")}</div>`;
  }

  // ── Update council seat chart imperatively on district click ──────────────
  // isSelfgov=true: distId is a selfgov_id; aggregate all majoritarian districts in that unit
  function updateCouncilSeats(distId, props, isSelfgov = false) {
    const chart = document.getElementById("council-seat-chart");
    if (!chart) return;

    let distRows;
    if (isSelfgov) {
      distRows = _allCouncilSMDResults.filter(r =>
        String(r.district_id) !== "national" &&
        councilSelfgovIdFromMajorId(r.district_id) === String(distId)
      );
    } else {
      distRows = results.filter(r => String(r.district_id) === distId);
    }

    const _smdWins = new Map();
    const _distRollup = d3.rollup(distRows, rows => ({
      votes:      d3.sum(rows, r => r.votes),
      vote_share: d3.mean(rows, r => r.vote_share),
      seats_pr:   rows[0]?.seats_pr  ?? 0,
      seats_smd:  rows[0]?.seats_smd ?? 0,
      threshold_status: rows[0]?.threshold_status ?? "notrun"
    }), d => d.party_id);

    for (const rows of d3.group(
      distRows.filter(r => String(r.district_id) !== "national"),
      r => String(r.district_id)
    ).values()) {
      const w = rows.reduce((a, b) => b.votes > a.votes ? b : a);
      _smdWins.set(w.party_id, (_smdWins.get(w.party_id) ?? 0) + 1);
    }

    const _unitSeats    = isSelfgov ? (_seatsMap.get(distId) ?? new Map()) : new Map();
    const _totalPRUnit  = d3.sum([..._unitSeats.values()], d => d.seats_pr);
    const _totalSMDUnit = d3.sum([..._unitSeats.values()], d => d.seats_smd);
    const _totalSMD = isSelfgov && _unitSeats.size > 0
      ? _totalSMDUnit
      : d3.sum([..._smdWins.values()]);

    const distArray = Array.from(
      new Set([..._distRollup.keys(), ..._unitSeats.keys()]),
      party_id => {
        const v = _distRollup.get(party_id) ?? {
          votes: 0,
          vote_share: 0,
          seats_pr: 0,
          seats_smd: 0,
          threshold_status: "notrun"
        };
        return {
        party_id, ...v,
        seats_smd: isSelfgov && _unitSeats.size > 0
          ? (_unitSeats.get(party_id)?.seats_smd ?? 0)
          : (_smdWins.get(party_id) ?? 0),
        seats_pr:  isSelfgov ? (_unitSeats.get(party_id)?.seats_pr ?? 0) : (v.seats_pr ?? 0),
        party: getParty(party_id),
        color: partyColor(party_id, electionVal?.id)
      };
    }).sort((a, b) =>
      seatsFor(b, seatFilter) - seatsFor(a, seatFilter) ||
      b.vote_share - a.vote_share
    );

    const distElec = {...electionVal, council: {
      total_pr_seats:  _totalPRUnit,
      total_smd_seats: _totalSMD
    }};

    const name = props ? (lang === "ka" ? props.name_ka : props.name_en) : null;
    const title = name
      ? `${name} — ${t("elections.local.council_seats_title")}`
      : t("elections.local.council_seats_title");

    chart.replaceWith(html`<div id="council-seat-chart">
      <h4 style="margin-top:0; font-size:0.85rem;">${title}</h4>
      ${renderCouncilDots(distArray, distElec, seatFilter)}
      ${renderSeatLegend(distArray, seatFilter, distElec)}
    </div>`);
  }

  // ── Seat legend ───────────────────────────────────────────────────────────
  function renderSeatLegend(parties, filter, elec) {
    const subset = partiesForFilter(parties, filter, elec);
    const activeId = selectedPartyId();
    return html`<div style="display:flex; flex-wrap:wrap; gap:0.75rem 1.25rem; margin-top:0.75rem;">
      ${subset.map(d => {
        const seats = seatsFor(d, filter);
        const pname = d.party?.name?.[lang] || d.party_id;
        const isActive = activeId != null && d.party_id === activeId;
        const el = html`<div class="seat-legend-row${isActive ? " seat-legend-row-active" : ""}" data-party-id="${d.party_id}" style="display:flex; align-items:center; gap:5px; font-size:0.8rem; cursor:pointer; padding-top:2px; padding-bottom:2px; padding-right:5px;" title="${t("elections.chart.click_filter")}">
          <span style="width:10px;height:10px;border-radius:2px;background:${d.color};display:inline-block;flex-shrink:0;"></span>
          <span style="color:var(--muted);">${pname}</span>
          <strong style="color:var(--dark);">${seats}</strong>
        </div>`;
        el.addEventListener("click", () => selectPartyOnMap(d.party_id));
        return el;
      })}
    </div>`;
  }

  // ── District results panel ────────────────────────────────────────────────
  function renderDistrictPanel(distId, props, data = results) {
    const rows = (distId === "__precinct__"
      ? [...data]
      : data.filter(r => String(r.district_id) === distId)
    ).sort((a, b) => b.vote_share - a.vote_share);
    const pname = lang === "ka" ? props.name_ka : props.name_en || distId;
    const candidateLabel = r => (lang === "ka" ? r.candidate_name_ka : r.candidate_name_en)
      || r.candidate_name
      || r.name_ka
      || null;
    const hasCandidateRows = rows.some(candidateLabel);
    const isSMD = effectiveVoteType === "smd" || isPresidential || hasCandidateRows;
    const colHeader = isSMD ? t("elections.results.candidate")
                    : isPlebiscite ? t("elections.results.vote")
                    : t("elections.results.party");
    const SHOW_N    = 5;
    const topRows   = rows.slice(0, SHOW_N);
    const moreRows  = rows.slice(SHOW_N);

    const activeId = selectedPartyId();
    function distRow(r) {
      const color        = partyColor(r.party_id, electionVal?.id);
      const shareStr     = `${(r.vote_share * 100).toFixed(1)}%`;
      const countStr     = r.votes != null ? r.votes.toLocaleString(lang === "ka" ? "ka-GE" : "en-US") : "—";
      const partyName    = r.party_label || getParty(r.party_id).name?.[lang] || r.party_id;
      const candidateName = candidateLabel(r);
      const isActive = activeId != null && r.party_id === activeId;
      const el = html`<tr class="dist-table-row${isActive ? " dist-table-row-active" : ""}" data-party-id="${r.party_id}" title="${t("elections.chart.click_filter")}">
        <td style="vertical-align:middle;">
          <span class="party-dot" style="background:${color}; vertical-align:middle;"></span>
          ${isSMD && candidateName
            ? html`<strong style="font-size:0.82rem;">${candidateName}</strong>
                   <div style="font-size:0.72rem; color:var(--muted); margin-left:15px;">${partyName}</div>`
            : html`${partyName}${r.threshold_status === "failed" ? html`<span style="color:var(--muted);font-size:0.72rem;"> ✗</span>` : ""}`
          }
        </td>
        <td style="text-align:right; white-space:nowrap; vertical-align:middle;">
          <span style="font-weight:700;">${shareStr}</span>
          <span style="color:var(--muted); font-size:0.75rem; margin-left:4px;">(${countStr})</span>
        </td>
      </tr>`;
      el.addEventListener("click", () => selectPartyOnMap(r.party_id));
      return el;
    }

    const panel = html`<div class="card results-panel" id="results-panel">
      ${panelBackHeader(pname)}
      ${distId === "__precinct__" && props?.address_ka ? html`
        <div style="font-size:0.75rem; color:var(--muted); padding:0 0 8px 0;">
          <span style="font-weight:600;">${t("elections.results.address")}:</span>
          ${props.address_ka}
        </div>` : ""}
      <table class="dist-table">
        <thead><tr>
          <th>${colHeader}</th>
          <th style="text-align:right;">${t("elections.results.share")}</th>
        </tr></thead>
        <tbody>
          ${topRows.map(distRow)}
        </tbody>
      </table>
      ${moreRows.length > 0 ? html`
        <details class="below-threshold-details">
          <summary class="below-threshold-summary">
            ${t("elections.chart.see_more")}
            <span class="below-threshold-count">${moreRows.length}</span>
          </summary>
          <table class="dist-table">
            <tbody>${moreRows.map(distRow)}</tbody>
          </table>
        </details>
      ` : ""}
    </div>`;
    return panel;
  }

  // ── Turnout panel ─────────────────────────────────────────────────────────
  function renderTurnoutPanel(distId, props, turnoutLookup = turnoutByDistrict) {
    const pname = lang === "ka" ? props.name_ka : props.name_en || distId;
    const isNational = distId === "national";
    const td = turnoutLookup instanceof Map ? turnoutLookup.get(distId) : turnoutByDistrict.get(distId);
    const turnoutCfg = electionVal?.turnout ?? {};

    if (!td) {
      return html`<div class="card results-panel" id="results-panel">
        ${isNational ? "" : panelBackHeader(pname)}
        <p style="color:var(--muted); font-size:0.85rem;">${t("elections.turnout.no_data")}</p>
      </div>`;
    }

    const {pct, noonPct, fivePct, invPct} = formatTurnoutPcts(td);

    return html`<div class="card results-panel" id="results-panel">
      ${isNational
        ? html`<div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:0.75rem;padding-bottom:0.5rem;border-bottom:1px solid var(--border);">${t("elections.results.national")}</div>`
        : panelBackHeader(pname)}
      ${props.precinct_name_ka ? html`<div style="font-size:0.78rem;color:var(--muted);margin:-4px 0 8px;">${props.precinct_name_ka}</div>` : ""}
      ${metricRow("final", t("elections.turnout.pct"), pct)}
      ${statRow(t("elections.turnout.voted"),      td.voted      != null ? td.voted.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")      : "—")}
      ${statRow(t("elections.turnout.registered"), td.registered != null ? td.registered.toLocaleString(lang === "ka" ? "ka-GE" : "en-US") : "—")}
      ${(turnoutCfg.has_snapshots || noonPct) && noonPct ? metricRow("noon", t("elections.turnout.noon"), noonPct, td.voted_noon != null ? `(${td.voted_noon.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})` : null) : ""}
      ${(turnoutCfg.has_snapshots || fivePct) && fivePct ? metricRow("5pm",  t("elections.turnout.5pm"),  fivePct,  td.voted_5pm  != null ? `(${td.voted_5pm.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})` : null)  : ""}
      ${turnoutCfg.has_lists && td.main_list    != null ? statRow(t("elections.turnout.main_list"),    td.main_list.toLocaleString(lang === "ka" ? "ka-GE" : "en-US"))    : ""}
      ${turnoutCfg.has_lists && td.special_list != null ? statRow(t("elections.turnout.special_list"), td.special_list.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")) : ""}
      ${invPct ? metricRow("invalid", t("elections.turnout.invalid_pct"), invPct, td.invalid_ballots != null ? `(${td.invalid_ballots.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})` : null) : ""}
    </div>`;
  }

  // ── Precinct info panel (unified: vote results + turnout) ─────────────────
  function renderPrecinctPanel(props, td, stationRows) {
    const pname = lang === "ka" ? props.name_ka : props.name_en;
    const turnoutCfg = electionVal?.turnout ?? {};

    const _sortedRows = [...stationRows].sort((a, b) => b.vote_share - a.vote_share);
    const _topRows    = _sortedRows.slice(0, 5);
    const _moreRows   = _sortedRows.slice(5);
    const candidateLabel = r => (lang === "ka" ? r.candidate_name_ka : r.candidate_name_en)
      || r.candidate_name
      || r.name_ka
      || null;
    const isSMDPrec  = effectiveVoteType === "smd" || isPresidential || _sortedRows.some(candidateLabel);
    const colHeader   = isSMDPrec ? t("elections.results.candidate") : t("elections.results.party");

    function voteRow(r) {
      const color        = partyColor(r.party_id, electionVal?.id);
      const shareStr     = `${(r.vote_share * 100).toFixed(1)}%`;
      const countStr     = r.votes != null ? r.votes.toLocaleString(lang === "ka" ? "ka-GE" : "en-US") : "—";
      const pname_r      = r.party_label || getParty(r.party_id).name?.[lang] || r.party_id;
      const candidateName = candidateLabel(r);
      return html`<tr>
        <td style="vertical-align:middle;">
          <span class="party-dot" style="background:${color};vertical-align:middle;"></span>
          ${isSMDPrec && candidateName
            ? html`<strong style="font-size:0.82rem;">${candidateName}</strong>
                   <div style="font-size:0.72rem;color:var(--muted);margin-left:15px;">${pname_r}</div>`
            : html`${pname_r}`}
        </td>
        <td style="text-align:right;white-space:nowrap;vertical-align:middle;">
          <span style="font-weight:700;">${shareStr}</span>
          <span style="color:var(--muted);font-size:0.75rem;margin-left:4px;">(${countStr})</span>
        </td>
      </tr>`;
    }

    const voteBlock = _sortedRows.length > 0 ? html`
      <table class="dist-table">
        <thead><tr>
          <th>${colHeader}</th>
          <th style="text-align:right;">${t("elections.results.share")}</th>
        </tr></thead>
        <tbody>${_topRows.map(voteRow)}</tbody>
      </table>
      ${_moreRows.length > 0 ? html`
        <details class="below-threshold-details">
          <summary class="below-threshold-summary">
            ${t("elections.chart.see_more")}
            <span class="below-threshold-count">${_moreRows.length}</span>
          </summary>
          <table class="dist-table"><tbody>${_moreRows.map(voteRow)}</tbody></table>
        </details>` : ""}
    ` : "";

    const {pct: _pct, noonPct: _noonPct, fivePct: _fivePct, invPct: _invPct} = formatTurnoutPcts(td);

    const turnoutBlock = td ? html`
      <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin:10px 0 4px;padding-top:8px;border-top:1px solid var(--border);">
        ${t("elections.turnout.title")}
      </div>
      ${metricRow("final", t("elections.turnout.pct"), _pct)}
      ${statRow(t("elections.turnout.voted"),      td.voted      != null ? td.voted.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")      : "—")}
      ${statRow(t("elections.turnout.registered"), td.registered != null ? td.registered.toLocaleString(lang === "ka" ? "ka-GE" : "en-US") : "—")}
      ${(turnoutCfg.has_snapshots || _noonPct) && _noonPct ? metricRow("noon", t("elections.turnout.noon"), _noonPct, td.voted_noon != null ? `(${td.voted_noon.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})` : null) : ""}
      ${(turnoutCfg.has_snapshots || _fivePct) && _fivePct ? metricRow("5pm",  t("elections.turnout.5pm"),  _fivePct, td.voted_5pm  != null ? `(${td.voted_5pm.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})` : null)  : ""}
      ${turnoutCfg.has_lists && td.main_list    != null ? statRow(t("elections.turnout.main_list"),    td.main_list.toLocaleString(lang === "ka" ? "ka-GE" : "en-US"))    : ""}
      ${turnoutCfg.has_lists && td.special_list != null ? statRow(t("elections.turnout.special_list"), td.special_list.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")) : ""}
      ${_invPct ? metricRow("invalid", t("elections.turnout.invalid_pct"), _invPct, td.invalid_ballots != null ? `(${td.invalid_ballots.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})` : null) : ""}
    ` : "";

    return html`<div class="card results-panel" id="results-panel">
      ${panelBackHeader(pname)}
      ${props.address_ka ? html`
        <div style="font-size:0.74rem;color:var(--muted);padding-bottom:6px;border-bottom:1px solid var(--border);margin-bottom:4px;">
          <span style="font-weight:600;">${t("elections.results.address")}:</span> ${props.address_ka}
        </div>` : ""}
      ${voteBlock}
      ${turnoutBlock}
    </div>`;
  }

  // ── Turnout summary (national) ────────────────────────────────────────────
  function renderTurnoutSummary(data, elec) {
    if (!data || data.length === 0) {
      return html`<p style="color:var(--muted); font-size:0.85rem;">${t("elections.turnout.no_data")}</p>`;
    }
    const turnoutCfg = elec?.turnout ?? {};
    const nationalRows = data.filter(r => r.district_id === "national");
    if (nationalRows.length === 0) return html`<p style="color:var(--muted);">—</p>`;

    function voteTypeLabel(vt) {
      if (!vt) return "";
      return vt === "smd" ? t("elections.turnout.smd") : t("elections.turnout.pr");
    }

    return html`<div>
      ${nationalRows.map(row => html`
        <div style="margin-bottom:1rem;">
          <div style="display:flex; gap:1.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
            <div style="text-align:center;">
              <div style="font-size:1.6rem; font-weight:800; color:var(--theme-foreground);">${row.turnout_pct != null ? `${(row.turnout_pct*100).toFixed(1)}%` : "—"}</div>
              <div style="font-size:0.72rem; color:var(--muted); text-transform:uppercase;">${t("elections.turnout.pct")}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:1.1rem; font-weight:700;">${row.voted != null ? row.voted.toLocaleString(lang === "ka" ? "ka-GE" : "en-US") : "—"}</div>
              <div style="font-size:0.72rem; color:var(--muted); text-transform:uppercase;">${t("elections.turnout.voted")}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:1.1rem; font-weight:700; color:var(--muted);">${row.registered != null ? row.registered.toLocaleString(lang === "ka" ? "ka-GE" : "en-US") : "—"}</div>
              <div style="font-size:0.72rem; color:var(--muted); text-transform:uppercase;">${t("elections.turnout.registered")}</div>
            </div>
          </div>
          ${(turnoutCfg.has_snapshots || row.voted_noon != null) && row.voted_noon != null ? html`
            <div style="font-size:0.78rem; color:var(--muted); margin-bottom:3px;">
              ${t("elections.turnout.noon")}: <strong>${row.noon_pct != null ? `${(row.noon_pct*100).toFixed(1)}%` : `${(row.voted_noon/row.registered*100).toFixed(1)}%`}</strong>
              <span style="opacity:0.7;"> (${row.voted_noon.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})</span>
            </div>
            <div style="font-size:0.78rem; color:var(--muted); margin-bottom:3px;">
              ${t("elections.turnout.5pm")}: <strong>${row.five_pct != null ? `${(row.five_pct*100).toFixed(1)}%` : `${(row.voted_5pm/row.registered*100).toFixed(1)}%`}</strong>
              <span style="opacity:0.7;"> (${row.voted_5pm.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})</span>
            </div>` : ""}
          ${row.invalid_ballots != null ? html`
            <div style="font-size:0.78rem; color:var(--muted); margin-bottom:3px;">
              ${t("elections.turnout.invalid_short")}: <strong>${row.invalid_pct != null ? `${(row.invalid_pct*100).toFixed(1)}%` : "—"}</strong>
              <span style="opacity:0.7;"> (${row.invalid_ballots.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")})</span>
            </div>` : ""}
          ${turnoutCfg.has_lists && row.main_list != null ? html`
            <div style="font-size:0.78rem; color:var(--muted); margin-bottom:3px;">
              ${t("elections.turnout.main_list")}: <strong>${row.main_list.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")}</strong>
            </div>
            <div style="font-size:0.78rem; color:var(--muted);">
              ${t("elections.turnout.special_list")}: <strong>${row.special_list.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")}</strong>
            </div>` : ""}
        </div>
      `)}
    </div>`;
  }

  // ── Election info / blurb ─────────────────────────────────────────────────
  function renderElectionInfo(elec, subElection = null) {
    const noteForLang = notes => {
      const raw = notes?.[lang] ?? notes?.en ?? null;
      return typeof raw === "string" && raw.trim() === "" ? null : raw;
    };
    const notesRaw = noteForLang(subElection?.notes) ?? noteForLang(elec?.notes);

    // Render the election YAML's `sources:` block as a small attribution
    // footer beneath the notes. Each entry has `{name: {en, ka}, url?}`; we
    // pick the localized name and turn the entry into a link when `url` is
    // present. If neither notes nor sources exist we return nothing.
    const sources = Array.isArray(elec?.sources) ? elec.sources.filter(Boolean) : [];

    // ── "Participating political groups" — quick links to the filtered
    //    /parties list and to the candidate roster(s) for this election.
    //    What links appear depends on which vote types the election ran:
    //      always:          /parties?election=<id>
    //      pr enabled:      /candidates?election=<id>&vote_type=pr
    //      smd enabled:     /candidates?election=<id>&vote_type=smd
    //                       (council_smd for local elections)
    //      presidential:    /candidates?election=<id>&vote_type=presidential
    const participantLinks = elec?.id ? (() => {
      const links = [];
      const eid = encodeURIComponent(elec.id);
      links.push({
        href: `./parties?election=${eid}`,
        label: t("elections.participants.parties") || "Political parties"
      });
      const prEnabled  = elec.system?.pr?.enabled === true;
      const smdEnabled = elec.system?.smd?.enabled === true;
      const isLocal    = elec.type === "local";
      const isPres     = elec.type === "presidential";
      if (isPres) {
        links.push({
          href: `./candidates?election=${eid}&vote_type=presidential`,
          label: t("elections.participants.candidates") || "Candidates"
        });
      } else {
        if (prEnabled) {
          links.push({
            href: `./candidates?election=${eid}&vote_type=pr`,
            label: t("elections.participants.pr_candidates") || "PR candidates"
          });
        }
        if (smdEnabled) {
          links.push({
            href: `./candidates?election=${eid}&vote_type=${isLocal ? "council_smd" : "smd"}`,
            label: t("elections.participants.smd_candidates") || "SMD candidates"
          });
        }
      }
      return links;
    })() : [];

    if (!notesRaw && sources.length === 0 && participantLinks.length === 0) return "";

    const notesNode = document.createElement("div");
    if (notesRaw) notesNode.innerHTML = notesRaw;

    const participantsNode = participantLinks.length > 0
      ? html`<div class="election-participants">
          <div class="election-participants-label">${t("elections.participants.label") || "Participating political groups"}</div>
          <ul class="election-participants-list">
            ${participantLinks.map(l => html`<li><a href="${l.href}">${l.label} →</a></li>`)}
          </ul>
        </div>`
      : "";

    const sourceItems = sources.map(s => {
      const name = s?.name?.[lang] ?? s?.name?.en ?? s?.name?.ka ?? "";
      if (!name) return null;
      // Treat http(s)://… inside the name string as an inline link too — that
      // matches how parl_1919 currently expresses "Electoral lists: <url>".
      const urlMatch = String(name).match(/https?:\/\/\S+/);
      const url = s?.url ?? (urlMatch ? urlMatch[0] : null);
      if (url) {
        // If the URL is embedded in the name string, split it so we don't
        // render a bare URL alongside the link.
        const label = urlMatch ? String(name).replace(urlMatch[0], "").replace(/[:\s]+$/u, "").trim() : String(name);
        return html`<li><a href="${url}" target="_blank" rel="noopener">${label || url}</a></li>`;
      }
      return html`<li>${name}</li>`;
    }).filter(Boolean);

    const sourcesNode = sourceItems.length
      ? html`<div class="election-sources">
          <div class="election-sources-label">${t("elections.sources") || "Sources"}</div>
          <ul class="election-sources-list">${sourceItems}</ul>
        </div>`
      : "";

    return html`<div class="card election-blurb">
      ${notesRaw ? notesNode : ""}
      ${participantsNode}
      ${sourcesNode}
    </div>`;
  }

  // ── Electoral college (indirect presidential) ─────────────────────────────
  function renderElectoralCollege(elec) {
    const ec = elec?.electoral_college;
    if (!ec) return html`<p style="color:var(--muted);">${t("elections.electoral_college.no_data")}</p>`;

    const candidate = elec.candidates?.[0];
    const candidateName = candidate?.name?.[lang] || candidate?.name?.en || "—";
    const partyRef = candidate?.party ? parties.find(p => p.id === candidate.party) : null;
    const winColor = candidate?.color ?? partyRef?.colors?.default ?? "#1565C0";
    const invalid  = ec.invalid  ?? 0;
    const abstained = ec.abstained ?? 0;
    const absent   = ec.absent  ?? Math.max(0, ec.total - ec.for - ec.against - abstained - invalid);

    const dots = [
      ...Array(ec.for).fill("for"),
      ...Array(ec.against).fill("against"),
      ...Array(abstained).fill("abstained"),
      ...Array(invalid).fill("invalid"),
      ...Array(absent).fill("absent"),
    ];
    const dotColors = { for: winColor, against: "#C62828", abstained: "#9E9E9E", invalid: "#FF8F00", absent: "#E8E8E8" };

    const COLS = Math.round(Math.sqrt(ec.total));
    const totalSlots = COLS * Math.ceil(ec.total / COLS);
    const allDots = [...dots, ...Array(totalSlots - dots.length).fill("empty")];

    const legend = [
      {key: "for",        label: t("elections.electoral_college.for"),        n: ec.for,            color: winColor},
      {key: "against",    label: t("elections.electoral_college.against"),    n: ec.against,        color: "#C62828"},
      {key: "abstained",  label: t("elections.electoral_college.abstained"),  n: abstained,         color: "#9E9E9E"},
      {key: "invalid",    label: t("elections.electoral_college.invalid"),    n: invalid,           color: "#FF8F00"},
      {key: "absent",     label: t("elections.electoral_college.absent"),     n: absent,            color: "#E8E8E8"},
    ].filter(d => d.n > 0);

    return html`<div style="margin-bottom:1rem;">
      <div class="card" style="padding:1.25rem;">
        <div style="display:flex; align-items:center; gap:0.75rem; margin-bottom:1rem;">
          <span style="width:14px; height:14px; border-radius:50%; background:${winColor}; display:inline-block; flex-shrink:0;"></span>
          <span style="font-size:1rem; font-weight:700;">${candidateName}</span>
          <span style="font-size:0.8rem; background:${winColor}; color:#fff; border-radius:4px; padding:2px 8px;">${t("elections.electoral_college.elected")}</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(${COLS}, 9px); gap:2px; margin-bottom:1rem;">
          ${allDots.map(k => html`<div style="width:9px;height:9px;border-radius:1px;background:${k === 'empty' ? 'transparent' : dotColors[k]};"></div>`)}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:0.75rem 1.5rem; font-size:0.82rem;">
          ${legend.map(d => html`<div style="display:flex;align-items:center;gap:5px;">
            <span style="width:10px;height:10px;border-radius:2px;background:${d.color};display:inline-block;border:1px solid #ccc;"></span>
            <span style="color:var(--muted);">${d.label}</span>
            <strong>${d.n}</strong>
          </div>`)}
          <div style="color:var(--muted);font-size:0.75rem;align-self:center;">(${t("elections.electoral_college.total")}: ${ec.total})</div>
        </div>
      </div>
    </div>`;
  }

  return {
    panelBackHeader,
    renderNationalPanel,
    showNationalPanel,
    renderBarChart,
    renderDots,
    renderCouncilDots,
    updateCouncilSeats,
    renderSeatLegend,
    renderDistrictPanel,
    renderTurnoutPanel,
    renderPrecinctPanel,
    renderTurnoutSummary,
    renderElectionInfo,
    renderElectoralCollege,
  };
}
