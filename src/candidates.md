---
theme: [air, alt, wide]
title: Candidates
toc: false
---

```js
import {getLang, tr} from "./components/state.js";

const dict  = await FileAttachment("data/config/translations.json").json();
const index = await FileAttachment("data/candidates-index.json").json();
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

function inlinePartyLabelMap(c) {
  return new Map((c.pl || []).map(p => [p.i, p]));
}

// Resolve a party's display name. Inline (election-specific) labels in
// `c.pl` only carry the fields that DIFFER from the global registry — so a
// missing `.k` or `.e` means "fall through to the registry". Both sources
// may be empty; in that case return the party_id as last-resort text.
function partyName(pid, prefer = lang, inlineLabels = null) {
  const inline = inlineLabels?.get(pid);
  const reg = index.parties?.[pid];
  if (prefer === "ka") {
    return inline?.k
        ?? (reg?.name_ka && reg.name_ka !== pid ? reg.name_ka : null)
        ?? inline?.e ?? reg?.name_en ?? pid ?? "";
  }
  return inline?.e
      ?? (reg?.name_en && reg.name_en !== pid ? reg.name_en : null)
      ?? inline?.k ?? reg?.name_ka ?? pid ?? "";
}

function voteTypeLabel(voteType) {
  return t(`candidates.vote_type.${voteType}`) || voteType;
}

// Appearance entries store election + vote_type as integer indices into the
// top-level `index.elections` and `index.vote_types` arrays (saves ~1.5 MB
// raw versus repeating the string ids 90,000+ times). Resolve via the
// arrays; the resolvers tolerate already-decoded strings too, so existing
// callers that still pass the string form keep working.
const electionAtIdx = (i) => {
  if (typeof i === "string") return electionById.get(i);
  return index.elections[i];
};
const voteTypeAtIdx = (i) => {
  if (typeof i === "string") return i;
  return index.vote_types?.[i] ?? "";
};

function appearanceElectionId(a) {
  return typeof a.e === "string" ? a.e : (index.elections[a.e]?.id ?? "");
}
function appearanceVoteType(a) {
  return typeof a.v === "string" ? a.v : (index.vote_types?.[a.v] ?? "");
}

// "<election name>, <vote-type> (<district>)" — used both in display and the
// search corpus. The district suffix is shown when present (e.g. for local
// PR/SMD list candidacies in a specific self-gov unit).
function appearanceLabel(a) {
  const election = electionAtIdx(a.e);
  const ename = election ? ((lang === "ka" ? election.name_ka : election.name_en) ?? election.id) : "";
  const vlabel = voteTypeLabel(appearanceVoteType(a));
  const head = vlabel ? `${ename}, ${vlabel}` : ename;
  return a.d ? `${head} (${a.d})` : head;
}
```

```js
// ── Search corpus per cluster: pre-built once, used on every keystroke.
//    Split into two scopes so the user can opt-in via checkboxes:
//      nameCorpus[i]  — candidate first/last name plus appearance context
//                       (election name, vote type, district). Appearance
//                       context stays here because it describes the candidate,
//                       not the party.
//      partyCorpus[i] — party labels only (Georgian + English + party_id).
const nameCorpus = [];
const partyCorpus = [];
for (const c of index.clusters) {
  const inlineLabels = inlinePartyLabelMap(c);
  const partyNames = (c.ps || []).map(pid => {
    const p = index.parties?.[pid];
    const inline = inlineLabels.get(pid);
    // Inline pl entries only carry fields that DIFFER from the registry, so
    // we want BOTH sources in the search corpus: inline catches election-
    // specific aliases ("Bloc: UNM — United Opposition"), registry catches
    // the canonical form ("United National Movement"). Falsy / missing
    // fields stringify as "" and contribute nothing.
    return `${inline?.k ?? ""} ${inline?.e ?? ""} ${p?.name_ka ?? ""} ${p?.name_en ?? ""} ${pid ?? ""}`;
  }).join(" ");
  const apLabels = (c.a || []).map(appearanceLabel).join(" ");
  nameCorpus.push(`${c.f ?? ""} ${c.l ?? ""} ${apLabels}`.toLowerCase());
  partyCorpus.push(partyNames.toLowerCase());
}
```

```js
// ── State widget — a single custom input carrying {query, page, expanded}.
//    `expanded` is a Set<cluster_id>; clicking a candidate name toggles
//    its membership so multiple candidates can be expanded in-place at once.
//    On first load:
//      * honours ?party=<id>      (from /parties page)
//      * honours #candidate=<cid> (shareable link to a specific candidate)
//    The hash is kept in sync as the user expands/collapses, so the address
//    bar always carries a copyable deep-link to the most recently opened row.
const clusterById = new Map(index.clusters.map(c => [c.c, c]));

const stateWidget = (() => {
  const el = document.createElement("div");
  let initialQuery = "";
  let initialExpanded = new Set();
  let initialScrollCid = null;
  // Default search scope is "candidate name only". When the page is opened
  // via ?party=<id> from the parties page, also enable the "party" scope so
  // the pre-filled query (a party display name) matches.
  let initialScopes = new Set(["name"]);
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const partyId = params.get("party");
    if (partyId) {
      const p = index.parties?.[partyId];
      if (p) initialQuery = (lang === "ka" ? (p.name_ka ?? p.name_en) : (p.name_en ?? p.name_ka)) ?? partyId;
      else initialQuery = partyId; // fall through: the party_id itself is in the corpus
      initialScopes = new Set(["name", "party"]);
    }
    // Deep-link from /elections "Participating political groups". Append
    // election name and (if present) vote-type label to the search query;
    // both strings live in the per-cluster appearance corpus, so the
    // existing substring matcher filters down to the right roster without
    // requiring a new filter axis.
    const electionId = params.get("election");
    if (electionId) {
      const elec = electionById.get(electionId);
      const ename = elec
        ? (lang === "ka" ? elec.name_ka : elec.name_en) ?? electionId
        : electionId;
      initialQuery = initialQuery ? `${initialQuery} ${ename}` : ename;
    }
    const voteType = params.get("vote_type");
    if (voteType) {
      const vlabel = t(`candidates.vote_type.${voteType}`) || voteType;
      initialQuery = initialQuery ? `${initialQuery} ${vlabel}` : vlabel;
    }
    // Deep-link to a specific candidate via #candidate=<cluster_id>.
    const hashMatch = (window.location.hash || "").match(/(?:^|[#&])candidate=([^&]+)/);
    if (hashMatch) {
      const cid = decodeURIComponent(hashMatch[1]);
      const c = clusterById.get(cid);
      if (c) {
        // Pre-fill the search so the candidate's row shows up in the result
        // list (otherwise an empty query produces zero matches).
        if (!initialQuery) initialQuery = `${c.f ?? ""} ${c.l ?? ""}`.trim();
        initialExpanded = new Set([cid]);
        initialScrollCid = cid;
      }
    }
  }
  el.value = {
    query: initialQuery, page: 1,
    expanded: initialExpanded,
    scopes: initialScopes, exact: false,
    scrollToCid: initialScrollCid
  };
  function emit(next) {
    el.value = next;
    el.dispatchEvent(new Event("input"));
  }
  function writeHash(expandedSet) {
    if (typeof window === "undefined") return;
    const last = [...expandedSet].pop();
    const hash = last ? `#candidate=${encodeURIComponent(last)}` : "";
    const url = window.location.pathname + window.location.search + hash;
    history.replaceState(null, "", url);
  }
  el.setQuery   = q   => emit({ ...el.value, query: q, page: 1, scrollToCid: null });
  el.bumpPage   = ()  => emit({ ...el.value, page: el.value.page + 1 });
  el.toggleExpand = cid => {
    const next = new Set(el.value.expanded);
    if (next.has(cid)) next.delete(cid); else next.add(cid);
    writeHash(next);
    emit({ ...el.value, expanded: next, scrollToCid: next.has(cid) ? cid : null });
  };
  el.copyLink = () => {
    if (typeof window === "undefined" || !navigator?.clipboard) return Promise.resolve(false);
    return navigator.clipboard.writeText(window.location.href).then(() => true, () => false);
  };
  el.setScope = (scope, on) => {
    const next = new Set(el.value.scopes);
    if (on) next.add(scope); else next.delete(scope);
    emit({ ...el.value, scopes: next, page: 1 });
  };
  el.setExact = on => emit({ ...el.value, exact: !!on, page: 1 });
  return el;
})();
const state = Generators.input(stateWidget);
```

```js
// ── Stable search input — defined ONCE so focus is preserved across renders.
//    No label; the placeholder inside the input carries the prompt text.
//    The initial value comes from the state widget (which may have been
//    pre-filled from a `?party=` URL param coming in from the /parties page).
const searchInput = Inputs.text({
  placeholder: t("candidates.search_placeholder"),
  value: stateWidget.value.query || "",
  submit: false
});
searchInput.style.width = "100%";
// Debounce keystrokes: with 56,839 clusters in the corpus, dispatching a full
// re-render on every character causes typing lag on lower-powered devices.
// 180ms after the last keystroke is short enough to feel instant but long
// enough that holding a key or pasting doesn't trigger N redundant searches.
{
  let _t;
  searchInput.addEventListener("input", () => {
    clearTimeout(_t);
    const v = searchInput.value;
    _t = setTimeout(() => stateWidget.setQuery(v), 180);
  });
}

// ── Scope checkboxes — drive the search corpus selection plus an
//    "exact match" toggle. Each is a plain <label><input type=checkbox>…</label>.
const scopeBox = (key, labelKey) => {
  const wrap = document.createElement("label");
  wrap.className = "cand-scope";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = stateWidget.value.scopes.has(key);
  cb.addEventListener("change", () => stateWidget.setScope(key, cb.checked));
  const txt = document.createElement("span");
  txt.textContent = t(labelKey);
  wrap.append(cb, txt);
  return wrap;
};
// Separate "exact match" checkbox: when ON, the search treats the query as
// one verbatim phrase instead of splitting it into space-separated terms.
const exactBox = (() => {
  const wrap = document.createElement("label");
  wrap.className = "cand-scope";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!stateWidget.value.exact;
  cb.addEventListener("change", () => stateWidget.setExact(cb.checked));
  const txt = document.createElement("span");
  txt.textContent = t("candidates.scope.exact");
  wrap.append(cb, txt);
  return wrap;
})();
const scopeBoxes = html`<div class="cand-scopes">
  ${scopeBox("name",  "candidates.scope.candidate")}
  ${scopeBox("party", "candidates.scope.party")}
  ${exactBox}
</div>`;
```

```js
// ── Static frame: defined ONCE. A single placeholder is mutated below by a
//    reactive cell. The candidate detail now expands inline inside the same
//    table, so no separate details panel/card is needed.
const resultsPanel = html`<div></div>`;
const frame = html`

<div>
  <div class="cand-disclaimer">${t("candidates.disclaimer")}</div>

  <div class="cand-grid cand-grid-cands">
    <div class="card">
      <div class="input-group">${searchInput}</div>
      ${scopeBoxes}
      ${resultsPanel}
    </div>
  </div>
</div>
`;
display(frame);
```

```js
// ── Helpers used by both panels ──────────────────────────────────────────────
function formatVoteShare(v) { return v == null ? "" : (v * 100).toFixed(2) + "%"; }
function formatVotes(v)     { return v == null ? "" : Number(v).toLocaleString(lang === "ka" ? "ka-GE" : "en-US"); }

function buildMapUrl(ap) {
  const params = new URLSearchParams();
  params.set("type", ap.election_type);
  if (ap.election_id) params.set("election", ap.election_id);

  const subId = ap.sub_election_id ?? ap.sub_id ?? ap.sub;
  if (subId && subId !== "__main__") params.set("sub", subId);

  const voteType = ap.vote_type;
  const isLocal = ap.election_type === "local";
  const isCouncilSmd = voteType === "smd" || voteType === "council_smd" || voteType === "sakrebulo_smd";
  const districtId = ap.district_id == null ? null : String(ap.district_id);

  function selectUnit(level, id = districtId) {
    params.set("level", level);
    if (!level || id == null || id === "") return;
    params.set("unit_level", level);
    params.set("unit", String(id));
  }

  if (isLocal) {
    if (voteType === "pr") {
      params.set("ballot", "council");
      params.set("vote", "pr");
      selectUnit("selfgov");
    } else if (isCouncilSmd) {
      params.set("ballot", "council");
      params.set("vote", "smd");
      selectUnit("council_district");
    } else if (voteType === "mayor" || voteType === "gamgebeli") {
      params.set("ballot", "mayor");
      selectUnit("selfgov");
    }
  } else if (voteType === "smd") {
    params.set("vote", voteType);
    selectUnit("district");
  } else if (voteType === "pr" || voteType === "compensation") {
    params.set("vote", voteType);
    params.set("level", "district");
  } else if (voteType === "presidential") {
    params.set("level", "district");
  }

  if (ap.party_id) params.set("party", ap.party_id);

  if (ap.district_lat != null && ap.district_lng != null) {
    params.set("lat", ap.district_lat.toFixed(5));
    params.set("lng", ap.district_lng.toFixed(5));
    const zoom = Number(ap.district_zoom ?? 10);
    params.set("z", Number.isFinite(zoom) ? String(zoom) : "10");
  }
  return `./elections?${params.toString()}`;
}

// Render a stack of "<election>, <vote-type>" lines for a cluster's appearances.
function renderClusterElections(c) {
  return html`<ul class="cand-list cand-elections">${
    (c.a || []).map(pair => html`<li>${appearanceLabel(pair)}</li>`)
  }</ul>`;
}

// Render the cluster's distinct parties stacked, most-recent first.
function renderClusterParties(c) {
  const ids = c.ps && c.ps.length ? c.ps : (c.p ? [c.p] : []);
  if (!ids.length) return html`<span></span>`;
  const inlineLabels = inlinePartyLabelMap(c);
  return html`<ul class="cand-list cand-parties">${
    ids.map(pid => html`<li>${partyName(pid, lang, inlineLabels)}</li>`)
  }</ul>`;
}

// ── Build the appearances sub-table for one expanded candidate row. ─────────
function renderAppearancesTable(cluster, appearances) {
  const districtFor = ap => (lang === "ka"
    ? (ap.district_name_ka ?? ap.district_id ?? "")
    : (ap.district_name_en ?? ap.district_name_ka ?? ap.district_id ?? "")) || "";

  const electionFor = ap => {
    const ename = electionName(ap.election_id);
    const v = voteTypeLabel(ap.vote_type);
    return v ? `${ename}, ${v}` : ename;
  };

  // Shareable-link button: copies the current URL (which carries
  // #candidate=<cluster_id>) to the clipboard. Falls back to a "select-and-
  // copy" prompt on browsers without clipboard permission.
  const copyBtn = html`<button type="button" class="cand-copy-link" title="${t("candidates.copy_link") || "Copy link"}">
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l3.54-3.54a5 5 0 0 0-7.07-7.07L11.5 4.43" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M14 11a5 5 0 0 0-7.07 0L3.39 14.54a5 5 0 0 0 7.07 7.07L12.5 19.57" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>
    <span>${t("candidates.copy_link") || "Copy link"}</span>
  </button>`;
  copyBtn.addEventListener("click", async () => {
    const ok = await stateWidget.copyLink();
    const original = copyBtn.querySelector("span").textContent;
    copyBtn.querySelector("span").textContent = ok
      ? (t("candidates.link_copied") || "Copied!")
      : (t("candidates.copy_failed") || "Copy failed");
    copyBtn.classList.add("cand-copy-feedback");
    setTimeout(() => {
      copyBtn.querySelector("span").textContent = original;
      copyBtn.classList.remove("cand-copy-feedback");
    }, 1500);
  });

  return html`
    <div class="cand-detail">
      <div class="cand-detail-meta">
        <span>${t("candidates.record_count")}: <strong>${cluster.n}</strong></span>
        <span>${t("candidates.latest_year")}: <strong>${cluster.y ?? "—"}</strong></span>
        <span class="cand-detail-share">${copyBtn}</span>
      </div>
      <div class="cand-table cand-table-details" role="table">
        <div class="cand-table-row cand-table-head" role="row">
          <div class="cand-table-cell" role="columnheader">${t("elections.year") || "Year"}</div>
          <div class="cand-table-cell" role="columnheader">${t("candidates.col_election_types")}</div>
          <div class="cand-table-cell" role="columnheader">${t("candidates.app_party")}</div>
          <div class="cand-table-cell" role="columnheader">${t("candidates.app_district")}</div>
          <div class="cand-table-cell num" role="columnheader">${t("candidates.app_list_order")}</div>
          <div class="cand-table-cell num" role="columnheader">${t("candidates.app_votes")}</div>
          <div class="cand-table-cell num" role="columnheader">${t("candidates.app_vote_share")}</div>
          <div class="cand-table-cell center" role="columnheader">${t("candidates.app_elected")}</div>
          <div class="cand-table-cell" role="columnheader"></div>
        </div>
        ${appearances.map(ap => html`
          <div class="cand-table-row" role="row">
            <div class="cand-table-cell" role="cell">${ap.election_year ?? ""}</div>
            <div class="cand-table-cell" role="cell">${electionFor(ap)}</div>
            <div class="cand-table-cell" role="cell">${ap.party_label_ka ?? partyName(ap.party_id) ?? ""}</div>
            <div class="cand-table-cell" role="cell">${districtFor(ap)}</div>
            <div class="cand-table-cell num" role="cell">${ap.list_order ?? ""}</div>
            <div class="cand-table-cell num" role="cell">${formatVotes(ap.votes)}</div>
            <div class="cand-table-cell num" role="cell">${formatVoteShare(ap.vote_share)}</div>
            <div class="cand-table-cell center" role="cell">${ap.elected ? "✓" : ""}</div>
            <div class="cand-table-cell" role="cell">${ap.election_id
              ? html`<a href="${buildMapUrl(ap)}" target="_blank" rel="noopener">${t("candidates.view_on_map")}</a>`
              : ""}</div>
          </div>
        `)}
      </div>
    </div>
  `;
}
```

```js
// ── Reactive cell: rerender results panel when search query / page changes ─
{
  const PAGE_SIZE = 25;
  const queryRaw   = (state.query ?? "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  // In "exact" mode the entire trimmed query is one phrase; otherwise we
  // split on whitespace and require every term to appear (AND).
  const exact      = !!state.exact;
  const queryTerms = exact
    ? (queryRaw ? [queryRaw] : [])
    : queryRaw.split(" ").filter(Boolean);
  const pageNum    = state.page || 1;

  const scopes = state.scopes || new Set(["name"]);
  // Require at least 2 characters of search text before scanning the corpus.
  // Single-letter queries match nearly every candidate and produce a huge
  // sort + render that's visibly slow on GitHub Pages. We treat the
  // too-short state like an empty query so no misleading "no results"
  // message appears while the user is mid-type.
  const totalQueryChars = queryTerms.reduce((a, b) => a + b.length, 0);
  const effectiveTerms = totalQueryChars >= 2 ? queryTerms : [];
  const matches = (() => {
    if (!effectiveTerms.length) return [];
    if (!scopes.size) return [];
    // Hoist scope flags out of the hot loop so we don't re-read the Set on
    // each of 56k iterations.
    const useName  = scopes.has("name");
    const useParty = scopes.has("party");
    const out = [];
    for (let i = 0; i < nameCorpus.length; i++) {
      // Per-cluster haystack: union of the active scope corpuses.
      const haystack = (useName  ? nameCorpus[i]  : "") +
                       (useParty ? (" " + partyCorpus[i]) : "");
      let ok = true;
      for (const term of effectiveTerms) {
        if (!haystack.includes(term)) { ok = false; break; }
      }
      if (ok) out.push(index.clusters[i]);
    }
    out.sort((a, b) => (b.n - a.n) || (a.l ?? "").localeCompare(b.l ?? "", "ka"));
    return out;
  })();

  resultsPanel.innerHTML = "";

  if (!effectiveTerms.length) {
    // No prompt below the box — the input's placeholder already invites typing.
  } else if (matches.length === 0) {
    resultsPanel.append(html`<p class="cand-prompt">${t("candidates.no_results")}</p>`);
  } else {
    const countTpl = matches.length === 1
      ? t("candidates.results_count_one")
      : t("candidates.results_count_other");
    const countLine = countTpl.replace("{n}",
      matches.length.toLocaleString(lang === "ka" ? "ka-GE" : "en-US"));

    const end = Math.min(pageNum * PAGE_SIZE, matches.length);
    const slice = matches.slice(0, end);

    const expanded = state.expanded || new Set();

    // Build the table by interleaving cluster rows with inline detail rows
    // for any expanded cluster. The detail row is a sibling of the cluster
    // row inside the same .cand-table wrapper; it carries class .cand-row-detail
    // and spans the full width.
    const rowsHtml = [];
    for (const c of slice) {
      const isOpen = expanded.has(c.c);
      rowsHtml.push(html`
        <div class="cand-table-row ${isOpen ? "cand-row-expanded" : ""}" role="row">
          <div class="cand-table-cell" role="cell">
            <button class="cand-link" type="button" data-cid="${c.c}" aria-expanded="${isOpen ? "true" : "false"}">
              <span class="cand-chevron">▶</span>${c.f} ${c.l}
            </button>
          </div>
          <div class="cand-table-cell" role="cell">${renderClusterParties(c)}</div>
          <div class="cand-table-cell" role="cell">${renderClusterElections(c)}</div>
          <div class="cand-table-cell num" role="cell">${c.n.toLocaleString(lang === "ka" ? "ka-GE" : "en-US")}</div>
        </div>
      `);
      if (isOpen) {
        let content;
        if (!details) {
          content = html`<p class="cand-prompt" style="padding:0">…</p>`;
        } else {
          const appearances = details[c.c] ?? [];
          content = renderAppearancesTable(c, appearances);
        }
        rowsHtml.push(html`<div class="cand-row-detail" role="row" data-cid-detail="${c.c}">${content}</div>`);
      }
    }

    const table = html`
      <div class="cand-table cand-table-results" role="table">
        <div class="cand-table-row cand-table-head" role="row">
          <div class="cand-table-cell" role="columnheader">${t("candidates.col_name")}</div>
          <div class="cand-table-cell" role="columnheader">${t("candidates.col_latest_party")}</div>
          <div class="cand-table-cell" role="columnheader">${t("candidates.col_election_types")}</div>
          <div class="cand-table-cell num" role="columnheader">${t("candidates.col_appearances")}</div>
        </div>
        ${rowsHtml}
      </div>
    `;

    // Delegated click: toggle expansion of a candidate row.
    table.addEventListener("click", ev => {
      const btn = ev.target.closest(".cand-link");
      if (btn) stateWidget.toggleExpand(btn.dataset.cid);
    });

    // Honour ?candidate=<cid> deep-link or a toggle-driven scroll: after the
    // table renders, if a particular cluster id has been flagged for scroll,
    // bring its detail row into view. We clear the flag immediately so future
    // re-renders (e.g. typing in the search) don't keep auto-scrolling.
    if (state.scrollToCid) {
      const cid = state.scrollToCid;
      // Delay one frame so the DOM has the detail row attached.
      requestAnimationFrame(() => {
        const target = resultsPanel.querySelector(`[data-cid-detail="${CSS.escape(cid)}"]`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      stateWidget.value = { ...stateWidget.value, scrollToCid: null };
    }

    const pager = end < matches.length
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
// ── Lazy-load details the first time any candidate is expanded ──────────────
let _detailsPromise = null;
function ensureDetails() {
  if (!_detailsPromise) _detailsPromise = FileAttachment("data/candidates-details.json").json();
  return _detailsPromise;
}
const details = (state.expanded && state.expanded.size > 0) ? await ensureDetails() : null;
```

