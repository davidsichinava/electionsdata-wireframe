// Shared loader for the candidate search feature. Reads only canonical CSVs
// from src/data/candidates/ (one CSV per (election_id, slot) — see
// src/data/candidates/README.md for the schema). No YAML rosters, no XLSX
// special cases, no auto-detected legacy filenames.
//
// Consumed by:
//   - src/data/candidates-index.json.js   (slim search index, no appearances)
//   - src/data/candidates-details.json.js (cluster_id → appearance[] map)
//
// Inputs:
//   - src/data/config/elections/**/*.yml         (election metadata + parties)
//   - src/data/config/parties.yml                (canonical party registry)
//   - src/data/candidates/{election|sub}_{slot}.csv  (canonical candidate data)
//   - src/data/results/*.csv                     (joined to attach votes)
//   - src/data/shp/*.geojson                     (district names + centroids)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { csvParse } from "d3-dsv";

const ROOT = "src";
const CONFIG_ELECTIONS_DIR = join(ROOT, "data/config/elections");
const PARTIES_YML = join(ROOT, "data/config/parties.yml");
const CANDIDATES_DIR = "data/candidates";

// ─── helpers ─────────────────────────────────────────────────────────────────

function readYaml(path) {
  const text = readFileSync(path, "utf8");
  try { return yamlLoad(text); }
  catch { return yamlLoad(text, { json: true }); }
}

function readCsv(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  return csvParse(readFileSync(abs, "utf8"));
}

function readGeoJson(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, "utf8")); }
  catch { return null; }
}

function collectYmlFiles(base) {
  const out = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const full = join(base, entry.name);
    if (entry.isDirectory()) out.push(...collectYmlFiles(full));
    else if (entry.name.endsWith(".yml")) out.push(full);
  }
  return out;
}

function geomCentroid(geom) {
  if (!geom) return null;
  let coords = [];
  if (geom.type === "Polygon") coords = geom.coordinates[0] || [];
  else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) coords.push(...(poly[0] || []));
  }
  if (!coords.length) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of coords) { sx += x; sy += y; }
  return [sx / coords.length, sy / coords.length];
}

function normalizeName(s) {
  if (!s) return "";
  let x = String(s).toLowerCase().trim();
  x = x.replace(/[„""«»".,()]/g, "");
  x = x.replace(/\s+/g, " ");
  x = x.replace(/ი\b/g, "");
  return x.trim();
}

function splitName(name_ka, first_name, last_name) {
  const f = (first_name ?? "").toString().trim();
  const l = (last_name ?? "").toString().trim();
  if (f && l) return { first_name: f, last_name: l, name_ka: (name_ka || `${f} ${l}`).trim() };
  const full = (name_ka ?? "").toString().trim();
  if (!full) return { first_name: "", last_name: "", name_ka: "" };
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: "", name_ka: full };
  return { first_name: parts[0], last_name: parts.slice(1).join(" "), name_ka: full };
}

function clusterId(first_norm, last_norm) {
  return `${last_norm}__${first_norm}`;
}

function yearFromId(id) {
  const m = String(id).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

// ─── party registry ──────────────────────────────────────────────────────────

const partiesYml = readYaml(PARTIES_YML);
const partyRegistry = {};
for (const p of (partiesYml?.parties ?? [])) {
  partyRegistry[p.id] = {
    name_ka: p.name?.ka ?? p.id,
    name_en: p.name?.en ?? p.id
  };
}

// Per-election party map: alias.ka/en override registry names.
function buildElectionPartyMap(election) {
  const m = {};
  for (const p of (election.parties ?? [])) {
    const base = partyRegistry[p.id] ?? { name_ka: p.id, name_en: p.id };
    m[p.id] = {
      name_ka: p.alias?.ka ?? base.name_ka,
      name_en: p.alias?.en ?? base.name_en
    };
  }
  return m;
}

// ─── geo lookups (cached per shape file) ─────────────────────────────────────

const geoCache = new Map();
function loadGeoIndex(shapeFile) {
  if (!shapeFile) return null;
  if (geoCache.has(shapeFile)) return geoCache.get(shapeFile);
  const gj = readGeoJson(shapeFile);
  if (!gj?.features) { geoCache.set(shapeFile, null); return null; }
  const byId = {};
  for (const feat of gj.features) {
    const p = feat.properties ?? {};
    const id =
      p.district_id ?? p.electoral_district_id ?? p.major_id ?? p.maj_id ?? p.MID ??
      p.selfgov_id ?? p.self_gov_id ?? p.id ?? p.OBJECTID;
    if (id == null) continue;
    const c = geomCentroid(feat.geometry);
    const name_ka = p.name_ka ?? p.district_name_ka ?? p.district_ka ?? p.NAME_KA ?? p.name ?? null;
    const name_en = p.name_en ?? p.district_name_en ?? p.district_en ?? p.NAME_EN ?? null;
    const key = String(id);
    if (!byId[key]) {
      byId[key] = { name_ka, name_en, lat: c ? c[1] : null, lng: c ? c[0] : null, zoom: 9 };
    }
  }
  const idx = { byId };
  geoCache.set(shapeFile, idx);
  return idx;
}

function lookupDistrict(shapeFile, id) {
  if (!shapeFile || id == null || id === "") return {};
  const idx = loadGeoIndex(shapeFile);
  if (!idx) return {};
  return idx.byId[String(id)] ?? {};
}

// ─── results joining (vote shares) ───────────────────────────────────────────

const resultsCache = new Map();
function loadResults(relPath) {
  if (!relPath) return null;
  if (resultsCache.has(relPath)) return resultsCache.get(relPath);
  const rows = readCsv(relPath);
  resultsCache.set(relPath, rows);
  return rows;
}

function indexSmdResults(rows) {
  const idx = {};
  if (!rows) return idx;
  for (const r of rows) {
    const did = r.district_id ?? r.major_id ?? r.electoral_district_id ?? r.smd_code ?? r.maj_id;
    const pid = r.party_id;
    if (!did || !pid) continue;
    idx[`${did}__${pid}`] = {
      votes: Number(r.votes ?? r.votes_total ?? 0) || 0,
      vote_share: Number(r.vote_share ?? 0) || 0
    };
  }
  return idx;
}

function indexPresResults(rows) {
  const idx = {};
  if (!rows) return idx;
  let total = 0;
  const byParty = {};
  for (const r of rows) {
    const pid = r.party_id;
    if (!pid) continue;
    const v = Number(r.votes) || 0;
    if (r.district_id === "national" || r.district_id === "0") {
      byParty[pid] = { votes: v, vote_share: Number(r.vote_share) || 0 };
    } else {
      byParty[pid] ??= { votes: 0, vote_share: 0 };
      byParty[pid].votes += v;
      total += v;
    }
  }
  if (total > 0) {
    for (const pid of Object.keys(byParty)) {
      if (!byParty[pid].vote_share) byParty[pid].vote_share = byParty[pid].votes / total;
    }
  }
  Object.assign(idx, byParty);
  return idx;
}

// ─── appearance shape ────────────────────────────────────────────────────────

function makeAppearance(o) {
  return {
    election_id: o.election_id,
    election_type: o.election_type,
    election_year: o.election_year,
    sub_id: o.sub_id ?? "__main__",
    vote_type: o.vote_type,
    party_id: o.party_id ?? null,
    party_label_ka: o.party_label_ka ?? null,
    party_label_en: o.party_label_en ?? null,
    party_code: o.party_code ?? null,
    list_order: o.list_order ?? null,
    ballot_number: o.ballot_number ?? null,
    district_id: o.district_id ?? null,
    district_name_ka: o.district_name_ka ?? null,
    district_name_en: o.district_name_en ?? null,
    district_lat: o.district_lat ?? null,
    district_lng: o.district_lng ?? null,
    district_zoom: o.district_zoom ?? null,
    votes: o.votes ?? null,
    vote_share: o.vote_share ?? null,
    elected: o.elected ?? false,
    notes: o.notes ?? null,
    bio_link: null,
    photo_link: null,
    dob: o.dob ?? null
  };
}

// Compact: drop null fields + cluster-redundant name fields.
function compactAppearance(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null) continue;
    if (k === "first_name" || k === "last_name" || k === "name_ka") continue;
    out[k] = v;
  }
  return out;
}

// ─── canonical-row → appearance ──────────────────────────────────────────────

const VALID_VOTE_TYPES = new Set(["pr", "smd", "council_smd", "mayor", "gamgebeli", "presidential"]);

function intOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function appearanceFromCanonicalRow(row, election, sub, partyMap, shapeForVoteType, smdResultsIdx, presResultsIdx) {
  const first_name = (row.first_name ?? "").toString().trim();
  const last_name  = (row.last_name  ?? "").toString().trim();
  if (!first_name && !last_name) return null;
  const name_ka = (row.name_ka ?? `${first_name} ${last_name}`).toString().trim();

  const party_id = (row.party_id ?? "").toString().trim() || null;
  const party_label_ka = (row.party_label_ka ?? "").toString().trim() || null;
  const partyNames = party_id && partyMap[party_id] ? partyMap[party_id] : null;
  const party_label_en = partyNames?.name_en ?? partyRegistry[party_id]?.name_en ?? null;

  const vote_type_raw = (row.vote_type ?? "").toString().trim();
  // Normalize sakrebulo_smd alias → council_smd
  const vote_type = vote_type_raw === "sakrebulo_smd" ? "council_smd" : vote_type_raw;
  if (!VALID_VOTE_TYPES.has(vote_type)) return null;

  const districtId = (row.district_id ?? "").toString().trim() || null;

  // District name + centroid: prefer the row's value, fall back to a GeoJSON lookup.
  let district_name_ka = (row.district_name_ka ?? "").toString().trim() || null;
  let district_name_en = null;
  let district_lat = null, district_lng = null, district_zoom = null;
  const shape = shapeForVoteType(vote_type, election);
  const geo = lookupDistrict(shape, districtId);
  if (geo) {
    district_name_ka ??= geo.name_ka ?? null;
    district_name_en   = geo.name_en ?? null;
    district_lat       = geo.lat ?? null;
    district_lng       = geo.lng ?? null;
    district_zoom      = geo.zoom ?? null;
  }

  // Votes / vote share: joined from results CSVs by (district_id, party_id) for
  // SMD and (party_id) for presidential.
  let votes = null, vote_share = null;
  if (vote_type === "smd" || vote_type === "council_smd") {
    const idx = smdResultsIdx ?? {};
    const key = (districtId != null && party_id) ? `${districtId}__${party_id}` : null;
    const hit = key ? idx[key] : null;
    if (hit) { votes = hit.votes; vote_share = hit.vote_share; }
  } else if (vote_type === "presidential" && party_id) {
    const hit = presResultsIdx?.[party_id];
    if (hit) { votes = hit.votes; vote_share = hit.vote_share; }
  }

  const elected = String(row.elected ?? "").toUpperCase() === "TRUE";

  const ap = makeAppearance({
    election_id: election.id,
    election_type: election.type,
    election_year: yearFromId(election.id),
    sub_id: (row.sub_id ?? sub?.id ?? "__main__").toString().trim() || "__main__",
    vote_type,
    party_id,
    party_label_ka,
    party_label_en,
    party_code: intOrNull(row.party_code),
    list_order: intOrNull(row.list_order),
    ballot_number: intOrNull(row.ballot_number),
    district_id: districtId,
    district_name_ka,
    district_name_en,
    district_lat, district_lng, district_zoom,
    votes, vote_share,
    elected,
    notes: (row.partisanship ?? "").toString().trim() || null
  });
  ap.first_name = first_name;
  ap.last_name  = last_name;
  ap.name_ka    = name_ka;
  return ap;
}

// Pick the right GeoJSON for a given vote_type in this election.
function shapeForVoteType(voteType, election) {
  if (election.type === "parliamentary" || election.type === "adjara") {
    if (voteType === "smd") return election.system?.smd?.shape_file ?? null;
    return election.system?.pr?.shape_file ?? null;
  }
  if (election.type === "local") {
    if (voteType === "council_smd") return election.council?.shape_file ?? election.system?.smd?.shape_file ?? null;
    // mayor / gamgebeli / pr / smd all live on selfgov polygons
    return election.system?.pr?.selfgov_shape_file ?? election.system?.smd?.shape_file ?? null;
  }
  if (election.type === "presidential") return election.system?.pr?.shape_file ?? null;
  return null;
}

// ─── main build ──────────────────────────────────────────────────────────────

const SLOTS = ["pr", "smd", "council_smd", "mayor", "gamgebeli", "presidential"];
const ELECTED_SLOT = "elected";

// Build the canonical-CSV path for one (election, sub_id, slot). Honors an
// optional override in election.files.candidate_overrides.{slot} when set.
function canonicalSlotPath(election, sub, slot) {
  const overrides = election.files?.candidate_overrides ?? {};
  if (overrides[slot]) return overrides[slot];
  const prefix = (!sub || sub.id === "__main__") ? election.id : sub.id;
  return `${CANDIDATES_DIR}/${prefix}_${slot}.csv`;
}

// Key for matching elected.csv rows back onto roster appearances.
function mergeKey(electionId, subId, voteType, firstName, lastName) {
  return `${electionId}|${subId ?? "__main__"}|${voteType}|${normalizeName(firstName)}|${normalizeName(lastName)}`;
}

export async function buildCandidates() {
  const electionFiles = collectYmlFiles(CONFIG_ELECTIONS_DIR);
  const elections = electionFiles.map(f => readYaml(f));

  const electionMeta = elections
    .filter(e => e?.id)
    .map(e => ({
      id: e.id,
      type: e.type,
      year: yearFromId(e.id),
      name_ka: e.name?.ka ?? e.id,
      name_en: e.name?.en ?? e.id
    }))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  const appearances = [];
  const apIndex = new Map(); // mergeKey → appearance reference

  for (const election of elections) {
    if (!election?.id) continue;
    const partyMap = buildElectionPartyMap(election);

    // Pre-load PR + SMD result indexes once per election (used by ALL subs).
    const smdResultsIdx = indexSmdResults(election.files?.smd_results ? loadResults(election.files.smd_results) : null);
    const presResultsIdx = indexPresResults(election.files?.pr_results ? loadResults(election.files.pr_results) : null);

    // Process __main__ election + each sub-election uniformly.
    const subs = [{ id: "__main__", sub: null }];
    for (const sub of (election.sub_elections ?? [])) {
      if (sub?.id) subs.push({ id: sub.id, sub });
    }

    for (const { sub } of subs) {
      // Read each candidate-roster slot.
      for (const slot of SLOTS) {
        const csvPath = canonicalSlotPath(election, sub, slot);
        const rows = readCsv(csvPath);
        if (!rows) continue;
        for (const r of rows) {
          const ap = appearanceFromCanonicalRow(
            r, election, sub, partyMap,
            shapeForVoteType, smdResultsIdx, presResultsIdx
          );
          if (!ap) continue;
          appearances.push(ap);
          const k = mergeKey(ap.election_id, ap.sub_id, ap.vote_type, ap.first_name, ap.last_name);
          if (!apIndex.has(k)) apIndex.set(k, ap);
        }
      }

      // Read elected.csv as a MODIFIER. For each row, find the matching roster
      // appearance (same election/sub/vote_type/normalized name) and flip its
      // `elected` flag to true. If no match found, emit a standalone appearance
      // marked elected — this happens when the roster wasn't sourced but
      // winners are known (e.g. some sub-elections).
      const electedCsvPath = canonicalSlotPath(election, sub, ELECTED_SLOT);
      const electedRows = readCsv(electedCsvPath);
      if (electedRows) {
        for (const r of electedRows) {
          const ap = appearanceFromCanonicalRow(
            r, election, sub, partyMap,
            shapeForVoteType, smdResultsIdx, presResultsIdx
          );
          if (!ap) continue;
          ap.elected = true; // elected.csv rows always mark winners
          const k = mergeKey(ap.election_id, ap.sub_id, ap.vote_type, ap.first_name, ap.last_name);
          const existing = apIndex.get(k);
          if (existing) {
            existing.elected = true;
          } else {
            appearances.push(ap);
            apIndex.set(k, ap);
          }
        }
      }
    }
  }

  // ─── cluster by normalized (first_name, last_name) ─────────────────────────

  const clusters = new Map();
  for (const ap of appearances) {
    const fn = normalizeName(ap.first_name);
    const ln = normalizeName(ap.last_name);
    if (!fn && !ln) continue;
    const cid = clusterId(fn, ln);
    let c = clusters.get(cid);
    if (!c) {
      c = {
        cluster_id: cid,
        name_ka: ap.name_ka,
        first_name: ap.first_name,
        last_name: ap.last_name,
        name_variants: new Set(),
        latest_party_id: null,
        latest_year: -Infinity,
        parties: new Set(),
        appearances: []
      };
      clusters.set(cid, c);
    }
    c.name_variants.add(ap.name_ka);
    c.appearances.push(ap);
    if (ap.party_id) c.parties.add(ap.party_id);
    if (ap.election_year != null && ap.election_year > c.latest_year) {
      c.latest_year = ap.election_year;
      c.latest_party_id = ap.party_id ?? c.latest_party_id;
      if (ap.name_ka) c.name_ka = ap.name_ka;
    }
  }

  const clustersOut = [...clusters.values()]
    .map(c => {
      const sortedAppearances = c.appearances
        .sort((a, b) => (b.election_year ?? 0) - (a.election_year ?? 0));
      const appearances_summary = sortedAppearances.map(a => {
        const obj = { e: a.election_id, v: a.vote_type };
        if (a.district_name_ka) obj.d = a.district_name_ka;
        return obj;
      });
      const partiesOrdered = [];
      const partyLabels = new Map();
      const seen = new Set();
      for (const a of sortedAppearances) {
        if (a.party_id && !seen.has(a.party_id)) {
          seen.add(a.party_id);
          partiesOrdered.push(a.party_id);
        }
        if (a.party_id && !partyLabels.has(a.party_id)) {
          const base = partyRegistry[a.party_id] ?? {};
          const name_ka = a.party_label_ka ?? base.name_ka ?? a.party_id;
          const name_en = a.party_label_en ?? base.name_en ?? name_ka;
          const needsInlineLabel =
            !base.name_ka ||
            base.name_ka === a.party_id ||
            (a.party_label_ka && a.party_label_ka !== base.name_ka);
          if (needsInlineLabel) {
            partyLabels.set(a.party_id, { id: a.party_id, name_ka, name_en });
          }
        }
      }
      return {
        cluster_id: c.cluster_id,
        name_ka: c.name_ka,
        first_name: c.first_name,
        last_name: c.last_name,
        name_variants: [...c.name_variants].filter(Boolean),
        latest_party_id: c.latest_party_id,
        latest_year: c.latest_year === -Infinity ? null : c.latest_year,
        parties: partiesOrdered,
        party_labels: partiesOrdered.map(pid => partyLabels.get(pid)).filter(Boolean),
        appearances_summary,
        appearance_count: c.appearances.length,
        appearances: sortedAppearances.map(compactAppearance)
      };
    })
    .sort((a, b) =>
      (a.last_name ?? "").localeCompare(b.last_name ?? "", "ka") ||
      (a.first_name ?? "").localeCompare(b.first_name ?? "", "ka")
    );

  return {
    generated_at: new Date().toISOString(),
    elections: electionMeta,
    parties: partyRegistry,
    clusters: clustersOut,
    appearance_count: appearances.length
  };
}
