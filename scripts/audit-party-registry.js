#!/usr/bin/env node
// Audit the consistency between the party / candidate registries and the
// actual canonical CSVs. Writes six advisory reports to reports/:
//
//   A. party_year_mismatch.csv         — _YYYY-suffixed id used outside its year
//   B. party_no_appearances.csv        — registered party_id with zero CSV rows
//   C. party_registered_but_no_candidates.csv
//                                     — listed in election YAML's parties[] but no roster row
//   D. labels_to_party_id.csv          — distinct (party_label_ka, party_id) pairs
//   E. lineage_gaps.csv                — lineage chain skips an election cycle
//   F. unregistered_party_ids.csv      — party_id in CSV with no registry entry anywhere
//
// Plus a short summary printed to stdout.
//
// Usage:
//   node scripts/audit-party-registry.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { csvParse, csvFormat } from "d3-dsv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const ELECTIONS_DIR = path.join(SRC, "data/config/elections");
const PARTIES_YML = path.join(SRC, "data/config/parties.yml");
const CAND_DIR = path.join(SRC, "data/candidates");
const REPORTS_DIR = path.join(ROOT, "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const readYaml = f => yaml.load(fs.readFileSync(f, "utf8"));

// ─── Load registries ──────────────────────────────────────────────────────

const partiesYml = readYaml(PARTIES_YML);
const partyRegistry = new Map();   // party_id → registry record
for (const p of (partiesYml?.parties ?? [])) {
  if (p?.id) partyRegistry.set(p.id, p);
}

const electionDocs = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".yml")) {
      const doc = readYaml(p);
      if (doc?.id) electionDocs.push(doc);
    }
  }
})(ELECTIONS_DIR);

const electionById = new Map(electionDocs.map(d => [d.id, d]));

function electionYear(electionId) {
  const doc = electionById.get(electionId);
  if (!doc?.date) {
    const m = electionId.match(/(\d{4})/);
    return m ? Number(m[1]) : null;
  }
  return Number(doc.date.slice(0, 4));
}

// party_id → Set<election_id> where the id appears in election.yml parties[]
const yamlRegisteredIn = new Map();
// party_id → Set<election_id> where the id appears in election.yml candidates[]
const yamlCandidateIn = new Map();

function addTo(map, k, v) {
  const s = map.get(k) ?? new Set();
  s.add(v);
  map.set(k, s);
}

for (const doc of electionDocs) {
  for (const p of (doc.parties ?? [])) {
    if (p?.id) addTo(yamlRegisteredIn, p.id, doc.id);
  }
  for (const c of (doc.candidates ?? [])) {
    if (c?.id) addTo(yamlCandidateIn, c.id, doc.id);
  }
}

// ─── Scan canonical CSVs ──────────────────────────────────────────────────

const csvFiles = fs.readdirSync(CAND_DIR).filter(f => f.endsWith(".csv"));

// party_id → { appearances, elections:Set, votes:Set, labels:Set, byElection: Map<election_id, count> }
const usage = new Map();
function bumpUsage(pid, electionId, voteType, label) {
  const rec = usage.get(pid) ?? { appearances: 0, elections: new Set(), votes: new Set(), labels: new Set(), byElection: new Map() };
  rec.appearances++;
  rec.elections.add(electionId);
  if (voteType) rec.votes.add(voteType);
  if (label) rec.labels.add(label);
  rec.byElection.set(electionId, (rec.byElection.get(electionId) ?? 0) + 1);
  usage.set(pid, rec);
}

// label → Map<party_id, { elections:Set, count }>
const labelToIds = new Map();
function bumpLabel(label, pid, electionId) {
  if (!label) return;
  const inner = labelToIds.get(label) ?? new Map();
  const rec = inner.get(pid) ?? { elections: new Set(), count: 0 };
  rec.elections.add(electionId);
  rec.count++;
  inner.set(pid, rec);
  labelToIds.set(label, inner);
}

// election_id → Set<party_id with at least one CSV row in that election>
const electionHasRosterFor = new Map();
function noteRoster(electionId, pid) {
  if (!pid) return;
  addTo(electionHasRosterFor, electionId, pid);
}

for (const fname of csvFiles) {
  const text = fs.readFileSync(path.join(CAND_DIR, fname), "utf8");
  if (!text.trim()) continue;
  let rows;
  try { rows = csvParse(text); } catch { continue; }
  if (!rows?.length) continue;
  for (const r of rows) {
    const pid = (r.party_id ?? "").trim();
    const electionId = (r.election_id ?? "").trim();
    if (!electionId) continue;
    if (pid) {
      bumpUsage(pid, electionId, r.vote_type, r.party_label_ka);
      bumpLabel(r.party_label_ka, pid, electionId);
      noteRoster(electionId, pid);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function suffixYear(pid) {
  const m = pid.match(/_(\d{4})$/);
  return m ? Number(m[1]) : null;
}

function isPerCandidateId(pid) {
  // Per-candidate ids live in election YAMLs' candidates[] block; treat
  // them differently because they're never in parties.yml.
  return yamlCandidateIn.has(pid);
}

function writeReport(filename, rows, columns) {
  const out = rows.map(r => {
    const norm = {};
    for (const c of columns) norm[c] = r[c] == null ? "" : String(r[c]);
    return norm;
  });
  const csv = csvFormat(out, columns);
  fs.writeFileSync(path.join(REPORTS_DIR, filename), csv, "utf8");
  return out.length;
}

// ─── Report A: party_year_mismatch ────────────────────────────────────────
// _YYYY-suffixed id appearing in an election whose year ≠ the suffix year.
// Parties with a `lineage:` tag are intentionally grouped across years, so
// they're skipped here — Report E handles lineage gaps.

const reportA = [];
for (const [pid, rec] of usage) {
  const sy = suffixYear(pid);
  if (sy == null) continue;
  if (isPerCandidateId(pid)) continue;
  const p = partyRegistry.get(pid);
  if (p?.lineage) continue;
  for (const [eid, count] of rec.byElection) {
    const ey = electionYear(eid);
    if (ey != null && ey !== sy) {
      reportA.push({
        party_id: pid,
        suffix_year: sy,
        election_id: eid,
        election_year: ey,
        appearances: count,
        sample_label: [...rec.labels].slice(0, 1)[0] ?? "",
      });
    }
  }
}
reportA.sort((a, b) => a.party_id.localeCompare(b.party_id) || a.election_id.localeCompare(b.election_id));

// ─── Report B: party_no_appearances ───────────────────────────────────────
// Registered in parties.yml but zero CSV rows reference its id.

const reportB = [];
for (const [pid, p] of partyRegistry) {
  if (!usage.has(pid)) {
    reportB.push({
      party_id: pid,
      lineage: p.lineage ?? "",
      type: p.type ?? "",
      category: p.category ?? "",
      name_ka: p.name?.ka ?? "",
      registered_in: [...(yamlRegisteredIn.get(pid) ?? [])].sort().join(";"),
    });
  }
}
reportB.sort((a, b) => a.party_id.localeCompare(b.party_id));

// ─── Report C: party_registered_but_no_candidates ─────────────────────────
// Listed in an election YAML's parties[] but no candidate roster row for that
// (election, id) tuple.

const reportC = [];
for (const [pid, elections] of yamlRegisteredIn) {
  for (const eid of elections) {
    const rosterSet = electionHasRosterFor.get(eid) ?? new Set();
    if (!rosterSet.has(pid)) {
      const doc = electionById.get(eid);
      reportC.push({
        party_id: pid,
        election_id: eid,
        election_year: electionYear(eid) ?? "",
        has_election_results: doc?.files?.pr_results || doc?.files?.smd_results ? "yes" : "no",
        notes: "registered in election YAML but no candidate row found",
      });
    }
  }
}
reportC.sort((a, b) => a.election_id.localeCompare(b.election_id) || a.party_id.localeCompare(b.party_id));

// ─── Report D: labels_to_party_id ─────────────────────────────────────────
// Every distinct (party_label_ka, party_id) seen across CSVs.

const reportD = [];
for (const [label, inner] of labelToIds) {
  for (const [pid, rec] of inner) {
    reportD.push({
      party_label_ka: label,
      party_id: pid,
      appearances: rec.count,
      election_ids: [...rec.elections].sort().join(";"),
      label_resolves_to_n_ids: inner.size, // > 1 means the same label was resolved to multiple ids
    });
  }
}
reportD.sort((a, b) => a.party_label_ka.localeCompare(b.party_label_ka) || a.party_id.localeCompare(b.party_id));

// ─── Report E: lineage_gaps ───────────────────────────────────────────────
// For each lineage, list every _YYYY-suffixed member id, the years they cover,
// and any year in [min, max] that has a candidate with a label resembling the
// lineage but no member id for that year.

// Build lineage → member ids
const lineageMembers = new Map();   // lineage → Set<party_id>
for (const [pid, p] of partyRegistry) {
  if (p?.lineage) addTo(lineageMembers, p.lineage, pid);
}

// For each lineage, compute the set of years it spans (from member suffix
// years AND from elections those members actually appear in).
const reportE = [];
for (const [lineage, ids] of lineageMembers) {
  const yearsCovered = new Set();
  const idsByYear = new Map();    // year → Set<party_id>
  for (const pid of ids) {
    const sy = suffixYear(pid);
    if (sy != null) {
      yearsCovered.add(sy);
      addTo(idsByYear, sy, pid);
    }
    const rec = usage.get(pid);
    if (!rec) continue;
    for (const eid of rec.elections) {
      const ey = electionYear(eid);
      if (ey != null) {
        yearsCovered.add(ey);
        addTo(idsByYear, ey, pid);
      }
    }
  }
  if (yearsCovered.size < 2) continue;
  const ys = [...yearsCovered].sort((a, b) => a - b);
  const min = ys[0], max = ys[ys.length - 1];
  // Election cycles that fall in [min, max] but where no lineage member appears
  const cycles = new Set();
  for (const doc of electionDocs) {
    const ey = electionYear(doc.id);
    if (ey != null && ey >= min && ey <= max) cycles.add(ey);
  }
  const gaps = [...cycles].sort((a, b) => a - b).filter(y => !yearsCovered.has(y));
  if (gaps.length === 0) continue;
  reportE.push({
    lineage,
    members: ids.size,
    years_covered: [...yearsCovered].sort((a, b) => a - b).join(";"),
    year_gaps: gaps.join(";"),
    member_ids: [...ids].sort().join(";"),
  });
}
reportE.sort((a, b) => a.lineage.localeCompare(b.lineage));

// ─── Report G: lineage_orphan_candidates ──────────────────────────────────
// For each per-candidate id (in election YAML `candidates:` block) with a
// `party:` field, classify how it links to the registry:
//
//   * linked_via_lineage  — candidate.party matches a known lineage name
//                          (some registered party has that string as its
//                          .lineage field)
//   * linked_via_party    — candidate.party matches a party_id directly
//   * unresolved          — candidate.party doesn't resolve to either
//
// When a candidate is linked_via_lineage, also check whether the lineage's
// member ids in parties.yml include one whose suffix year matches this
// election's year. If not, the lineage chain has a missing year-specific
// member for this candidate — that's the CD-2013 case.
//
// Separately, for candidates resolved via a label-string in the canonical CSVs
// (no per-candidate YAML registration; parties registry only), we also flag
// labels whose normalized form substring-matches any lineage's registry names
// but whose resolved party_id has no `lineage` field. This catches lineage
// gaps where the candidate isn't even linked back to the family yet.

// Helpers for the lineage check
const lineageNames = new Set(lineageMembers.keys());
// For each lineage, which years have a member id with that _YYYY suffix
const lineageMemberYears = new Map();    // lineage → Set<year>
for (const [lineage, ids] of lineageMembers) {
  const yrs = new Set();
  for (const pid of ids) {
    const sy = suffixYear(pid);
    if (sy != null) yrs.add(sy);
  }
  lineageMemberYears.set(lineage, yrs);
}
// And a normalized-name → lineage lookup for label-based matching
function normName(s) {
  let x = (s ?? "").toString().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return x.replace(/ური/g, "ული");
}
const lineageNormNames = new Map();      // normalized name_ka → lineage
for (const [lineage, ids] of lineageMembers) {
  for (const pid of ids) {
    const p = partyRegistry.get(pid);
    if (p?.name?.ka) lineageNormNames.set(normName(p.name.ka), lineage);
  }
}

// Substring matching is noisy when the lineage member name is a short common
// word that happens to appear in many unrelated labels (e.g. "საქართველო"
// = "Georgia", 10 normalized chars). Require the shorter side of the match
// to be at least MIN_OVERLAP characters — long enough that the match is
// unique to the family rather than a generic word.
const MIN_OVERLAP = 14;

function lineageFromLabel(label) {
  if (!label) return null;
  const norm = normName(label);
  if (norm.length < MIN_OVERLAP) return null;
  let best = null;
  for (const [nn, lineage] of lineageNormNames) {
    if (!nn) continue;
    const shorter = Math.min(nn.length, norm.length);
    if (shorter < MIN_OVERLAP) continue;
    if (norm === nn || norm.includes(nn) || nn.includes(norm)) {
      const score = nn.length + (norm === nn ? 1000 : 0);
      if (!best || score > best.score) best = { lineage, score };
    }
  }
  return best?.lineage ?? null;
}

const reportG = [];

// Sub-report G1: per-candidate ids linked to a lineage that has no member
// for this election's year.
for (const doc of electionDocs) {
  for (const c of (doc.candidates ?? [])) {
    if (!c?.id) continue;
    const cParty = (c.party ?? "").toString();
    let lineageLink = null;
    let kind = "unresolved";
    if (lineageNames.has(cParty)) {
      lineageLink = cParty;
      kind = "linked_via_lineage";
    } else if (partyRegistry.has(cParty)) {
      kind = "linked_via_party";
      lineageLink = partyRegistry.get(cParty)?.lineage ?? null;
    }
    const ey = electionYear(doc.id);
    if (lineageLink) {
      const yrs = lineageMemberYears.get(lineageLink) ?? new Set();
      if (ey != null && !yrs.has(ey)) {
        reportG.push({
          source: "election_yaml_candidate",
          election_id: doc.id,
          election_year: ey ?? "",
          candidate_id: c.id,
          candidate_name_ka: c.name?.ka ?? "",
          party_field: cParty,
          lineage: lineageLink,
          lineage_member_years: [...yrs].sort((a, b) => a - b).join(";"),
          issue: "lineage_has_no_member_for_election_year",
          suggestion: `add ${lineageLink}_${ey} to parties.yml, OR add lineage: ${lineageLink} to the candidate's per-candidate id`,
        });
      }
    } else if (kind === "unresolved" && cParty) {
      reportG.push({
        source: "election_yaml_candidate",
        election_id: doc.id,
        election_year: ey ?? "",
        candidate_id: c.id,
        candidate_name_ka: c.name?.ka ?? "",
        party_field: cParty,
        lineage: "",
        lineage_member_years: "",
        issue: "candidate.party field does not resolve to a party_id or lineage",
        suggestion: `register ${cParty} in parties.yml, or change candidate.party to an existing id/lineage`,
      });
    }
  }
}

// Sub-report G2: party_ids appearing in CSVs whose label resembles a lineage
// the party_id itself isn't linked to via parties.yml.
const seenG2 = new Set();   // dedupe (party_id, lineage, election_id)
for (const [pid, rec] of usage) {
  const p = partyRegistry.get(pid);
  // Skip per-candidate ids (already covered by G1) and ids already linked to
  // a lineage (Report E catches lineage gaps for those).
  if (isPerCandidateId(pid)) continue;
  if (p?.lineage) continue;
  for (const label of rec.labels) {
    const lineage = lineageFromLabel(label);
    if (!lineage) continue;
    for (const eid of rec.elections) {
      const key = `${pid}::${lineage}::${eid}`;
      if (seenG2.has(key)) continue;
      seenG2.add(key);
      reportG.push({
        source: "csv_label",
        election_id: eid,
        election_year: electionYear(eid) ?? "",
        candidate_id: pid,
        candidate_name_ka: "",
        party_field: "",
        lineage,
        lineage_member_years: [...(lineageMemberYears.get(lineage) ?? [])].sort((a, b) => a - b).join(";"),
        issue: "party_id label resembles lineage but party_id has no lineage tag",
        suggestion: `add lineage: ${lineage} to ${pid} in parties.yml`,
      });
    }
  }
}

reportG.sort((a, b) =>
  a.lineage.localeCompare(b.lineage) ||
  (a.election_year - b.election_year) ||
  a.election_id.localeCompare(b.election_id) ||
  a.candidate_id.localeCompare(b.candidate_id)
);

// ─── Report F: unregistered_party_ids ─────────────────────────────────────
// party_id in CSV not in parties.yml AND not in any election YAML's
// candidates[] block AND not in any election YAML's parties[] block.

const reportF = [];
for (const [pid, rec] of usage) {
  if (partyRegistry.has(pid)) continue;
  if (yamlCandidateIn.has(pid)) continue;
  if (yamlRegisteredIn.has(pid)) continue;
  reportF.push({
    party_id: pid,
    appearances: rec.appearances,
    election_ids: [...rec.elections].sort().join(";"),
    vote_types: [...rec.votes].sort().join(";"),
    sample_label: [...rec.labels].slice(0, 1)[0] ?? "",
  });
}
reportF.sort((a, b) => b.appearances - a.appearances || a.party_id.localeCompare(b.party_id));

// ─── Write reports + summary ──────────────────────────────────────────────

const writes = [
  ["A_party_year_mismatch.csv",            reportA, ["party_id", "suffix_year", "election_id", "election_year", "appearances", "sample_label"]],
  ["B_party_no_appearances.csv",           reportB, ["party_id", "lineage", "type", "category", "name_ka", "registered_in"]],
  ["C_party_registered_but_no_candidates.csv", reportC, ["election_id", "election_year", "party_id", "has_election_results", "notes"]],
  ["D_labels_to_party_id.csv",             reportD, ["party_label_ka", "party_id", "appearances", "election_ids", "label_resolves_to_n_ids"]],
  ["E_lineage_gaps.csv",                   reportE, ["lineage", "members", "years_covered", "year_gaps", "member_ids"]],
  ["F_unregistered_party_ids.csv",         reportF, ["party_id", "appearances", "election_ids", "vote_types", "sample_label"]],
  ["G_lineage_orphan_candidates.csv",      reportG, ["source", "election_id", "election_year", "candidate_id", "candidate_name_ka", "party_field", "lineage", "lineage_member_years", "issue", "suggestion"]],
];

console.log(`Party-registry audit — ${csvFiles.length} candidate CSVs scanned\n`);
console.log("Report                                                   Rows");
console.log("------------------------------------------------------ ------");
let total = 0;
for (const [filename, rows, cols] of writes) {
  const n = writeReport(filename, rows, cols);
  total += n;
  console.log(filename.padEnd(56) + n.toString().padStart(6));
}
console.log("------------------------------------------------------ ------");
console.log("TOTAL".padEnd(56) + total.toString().padStart(6));
console.log(`\nReports written to ${path.relative(ROOT, REPORTS_DIR)}/`);
