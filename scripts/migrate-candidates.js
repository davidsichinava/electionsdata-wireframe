#!/usr/bin/env node
// One-shot migration from legacy candidate sources to the canonical schema
// documented in src/data/candidates/README.md.
//
// Reads:
//   - src/data/candidates/*.csv        (hand-curated legacy CSVs)
//   - src/data/config/candidates/local/*.yml  (local YAML rosters)
//   - src/data/raw/*.{xlsx,csv}        (raw archival sources for parl_2024,
//                                       local_2017, local_2021 elected,
//                                       local_2025 elected, adj_2024)
//
// Writes:
//   - src/data/candidates/{election_id}_{slot}.csv  (canonical CSVs)
//
// Usage:
//   node scripts/migrate-candidates.js          # writes to src/data/candidates/_migrated/
//   node scripts/migrate-candidates.js --apply  # writes directly to src/data/candidates/
//
// The dry-run mode (default) lets you inspect the output before committing.
// Existing legacy files are NEVER deleted by this script — see the README's
// "Migration notes" section for the cleanup step.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { csvParse, csvFormat, tsvParse } from "d3-dsv";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const ELECTIONS_DIR = path.join(SRC, "data/config/elections");
const PARTIES_YML = path.join(SRC, "data/config/parties.yml");
const LEGACY_DIR = path.join(SRC, "data/candidates");
const LOCAL_YAML_DIR = path.join(SRC, "data/config/candidates/local");
const RAW_DIR = path.join(SRC, "data/raw");

const APPLY = process.argv.includes("--apply");
const OUT_DIR = APPLY ? LEGACY_DIR : path.join(LEGACY_DIR, "_migrated");

fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Canonical schema ──────────────────────────────────────────────────────

const COLUMNS = [
  "election_id", "sub_id", "vote_type", "party_id", "party_label_ka", "party_code",
  "district_id", "district_name_ka", "list_order", "ballot_number",
  "first_name", "last_name", "name_ka", "partisanship", "elected", "source"
];

function emptyRow() {
  const r = {};
  for (const c of COLUMNS) r[c] = "";
  return r;
}

function writeCanonicalCsv(filename, rows) {
  // Normalize: ensure every row has exactly the canonical columns, in order.
  const normalized = rows.map(r => {
    const out = emptyRow();
    for (const c of COLUMNS) if (r[c] != null && r[c] !== "") out[c] = String(r[c]);
    return out;
  });
  const csv = csvFormat(normalized, COLUMNS);
  const full = path.join(OUT_DIR, filename);
  fs.writeFileSync(full, csv, "utf8");
  return normalized.length;
}

// ─── Source readers ────────────────────────────────────────────────────────

function readYaml(file) {
  const text = fs.readFileSync(file, "utf8");
  try { return yaml.load(text); }
  catch { return yaml.load(text, { json: true }); }  // permissive for duplicate keys
}

function readCsv(relPath) {
  const full = path.join(SRC, relPath);
  if (!fs.existsSync(full)) return null;
  return csvParse(fs.readFileSync(full, "utf8"));
}

function readCsvAbs(full) {
  if (!fs.existsSync(full)) return null;
  return csvParse(fs.readFileSync(full, "utf8"));
}

async function readXlsxSheet(xlsxPath, sheetName) {
  if (!fs.existsSync(xlsxPath)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return null;
  const hdr = ws.getRow(1).values.slice(1);
  const out = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i).values.slice(1);
    if (!row.length) continue;
    const rec = {};
    hdr.forEach((h, j) => { rec[String(h)] = row[j] != null ? String(row[j]).trim() : ""; });
    out.push(rec);
  }
  return out;
}

// ─── Party-label → party_id resolver ───────────────────────────────────────
// Re-implements (and slightly extends) the matcher in candidates-build.js so
// the migration is self-contained.

const partiesYml = readYaml(PARTIES_YML);
const partyRegistry = {};
for (const p of (partiesYml?.parties ?? [])) partyRegistry[p.id] = p;

// Loose Georgian-aware label normalization. Strips everything that isn't a
// letter or digit (so curly quotes, em-dashes, spaces, punctuation all
// disappear). Lowercases Latin. Also equates the common Georgian adjective-
// ending alternation -ური / -ული (e.g. რესპუბლიკური ≡ რესპუბლიკული).
function normLabel(s) {
  let x = (s ?? "")
    .toString()
    .toLowerCase()
    // Unicode-aware: keep only letters (\p{L}) and digits (\p{N}); drop
    // everything else (quotes, dashes, spaces, punctuation, parens).
    .replace(/[^\p{L}\p{N}]+/gu, "");
  x = x.replace(/ური/g, "ული");
  return x;
}

// Load election YAMLs once
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

function partyMapFor(electionId) {
  const election = electionById.get(electionId);
  const m = {};
  for (const p of (election?.parties ?? [])) {
    const base = partyRegistry[p.id] ?? { name: { ka: p.id, en: p.id } };
    m[p.id] = {
      name_ka: p.alias?.ka ?? base.name?.ka ?? p.id,
      name_en: p.alias?.en ?? base.name?.en ?? p.id
    };
  }
  return m;
}

// Resolves a Georgian party label to a canonical party_id. To avoid bad
// substring collisions (e.g. "ბაქრაძე, უგულავა, ევროპული საქართველო" wrongly
// matching `georgia_party` whose name is just "საქართველო" before the longer
// "ევროპული საქართველო" gets a chance), we score every candidate and pick
// the LONGEST matching registry name. Restricted to parties listed in this
// election's YAML first; falls through to the global registry if nothing
// matches.
const _unresolved = new Map();
function bestMatchFromMap(label, candidates) {
  // candidates: Array<[pid, name_ka_to_match]>
  const norm = normLabel(label);
  if (!norm) return null;
  let best = null;
  for (const [pid, nameKa] of candidates) {
    const nk = normLabel(nameKa);
    if (!nk) continue;
    let hit = false;
    if (norm === nk || norm.includes(nk) || nk.includes(norm)) hit = true;
    if (!hit) continue;
    // Score: prefer the longer registry name (more specific). Tiebreak by
    // exact match.
    const score = nk.length + (norm === nk ? 1000 : 0);
    if (!best || score > best.score) best = { pid, score };
  }
  return best?.pid ?? null;
}

function resolvePartyId(label, electionId) {
  if (!label) return null;
  // Stage 1: election parties — try BOTH the YAML alias and the registry name
  // for every party listed in this election. Score by longest match.
  const election = electionById.get(electionId);
  const cands1 = [];
  for (const p of (election?.parties ?? [])) {
    if (p.alias?.ka) cands1.push([p.id, p.alias.ka]);
    if (partyRegistry[p.id]?.name?.ka) cands1.push([p.id, partyRegistry[p.id].name.ka]);
  }
  const hit1 = bestMatchFromMap(label, cands1);
  if (hit1) return hit1;
  // Stage 2: global registry — same longest-match scoring.
  const cands2 = [];
  for (const [pid, p] of Object.entries(partyRegistry)) {
    if (p.name?.ka) cands2.push([pid, p.name.ka]);
  }
  const hit2 = bestMatchFromMap(label, cands2);
  if (hit2) return hit2;
  // Unresolved
  const bucket = _unresolved.get(electionId) ?? new Set();
  bucket.add(label);
  _unresolved.set(electionId, bucket);
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function splitName(name_ka, first_name, last_name) {
  let f = (first_name ?? "").toString().trim();
  let l = (last_name ?? "").toString().trim();
  const full = (name_ka ?? "").toString().trim();
  if (f && l) return { first_name: f, last_name: l, name_ka: full || `${f} ${l}` };
  if (!full) return { first_name: f, last_name: l, name_ka: "" };
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: "", name_ka: full };
  return { first_name: parts[0], last_name: parts.slice(1).join(" "), name_ka: full };
}

function intOrEmpty(v) {
  if (v == null || v === "" || String(v).trim().toUpperCase() === "NA") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "";
}

function strOrEmpty(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return (s === "NA" || s === "null") ? "" : s;
}

// ─── Extractors (one per source format) ────────────────────────────────────

// Parliamentary / Adjara PR list CSV  →  *_pr.csv
function fromPartyListsCsv(legacyPath, electionId, source) {
  const rows = readCsv(legacyPath);
  if (!rows) return null;
  return rows.map(r => {
    const { first_name, last_name, name_ka } = splitName(r.name_ka, r.first_name, r.last_name);
    const partyLabel = strOrEmpty(r.party_label) || strOrEmpty(r.party_label_ka) || strOrEmpty(r.party_list_name) || strOrEmpty(r.party_name);
    const partyId = strOrEmpty(r.party_id) || resolvePartyId(partyLabel, electionId);
    const partyCode = intOrEmpty(r.party_code ?? r.party_num ?? r.party_number);
    return {
      election_id: electionId,
      sub_id: "__main__",
      vote_type: "pr",
      party_id: partyId || "",
      party_label_ka: partyLabel,
      party_code: partyCode,
      district_id: intOrEmpty(r.district_id),
      district_name_ka: strOrEmpty(r.district_name_ka ?? r.smd_name),
      list_order: intOrEmpty(r.list_order ?? r.order_id ?? r.candidate_order),
      ballot_number: "",
      first_name, last_name, name_ka,
      partisanship: strOrEmpty(r.partisanship),
      elected: "",
      source: source ?? strOrEmpty(r.source_pdf)
    };
  });
}

// Parliamentary / Adjara SMD candidates CSV  →  *_smd.csv
function fromSmdCandidatesCsv(legacyPath, electionId, source) {
  const rows = readCsv(legacyPath);
  if (!rows) return null;
  return rows.map(r => {
    const { first_name, last_name, name_ka } = splitName(r.name_ka, r.first_name, r.last_name);
    const partyLabel = strOrEmpty(r.party_label) || strOrEmpty(r.party_label_ka) || strOrEmpty(r.party_name);
    const partyId = strOrEmpty(r.party_id) || resolvePartyId(partyLabel, electionId);
    const partyCode = intOrEmpty(r.party_code ?? r.party_num ?? r.raw_vote_code ?? r.ballot_code);
    const ballot = intOrEmpty(r.ballot_number ?? r.ballot_code ?? r.candidate_order ?? r.candidate_number);
    return {
      election_id: electionId,
      sub_id: "__main__",
      vote_type: "smd",
      party_id: partyId || "",
      party_label_ka: partyLabel,
      party_code: partyCode,
      district_id: intOrEmpty(r.electoral_district_id ?? r.district_id ?? r.major_id ?? r.smd_code),
      district_name_ka: strOrEmpty(r.district_name_ka ?? r.smd_name),
      list_order: "",
      ballot_number: ballot,
      first_name, last_name, name_ka,
      partisanship: strOrEmpty(r.partisanship),
      elected: "",
      source: source ?? strOrEmpty(r.source_pdf)
    };
  });
}

// Local SMD candidates → _council_smd.csv. For local elections, SMD candidates
// are ALWAYS sakrebulo-majoritarian (council_smd) — even when the source CSV
// doesn't carry an `election_type` column to confirm it (local 2010 case).
function fromLocal2014SmdCsv(legacyPath, electionId) {
  const rows = readCsv(legacyPath);
  if (!rows) return null;
  return rows.map(r => {
    const { first_name, last_name, name_ka } = splitName(r.name_ka, r.first_name, r.last_name);
    const partyLabel = strOrEmpty(r.party_name) || strOrEmpty(r.party_label_ka);
    const partyId = strOrEmpty(r.party_id) || resolvePartyId(partyLabel, electionId);
    return {
      election_id: electionId,
      sub_id: "__main__",
      vote_type: "council_smd",
      party_id: partyId || "",
      party_label_ka: partyLabel,
      party_code: intOrEmpty(r.party_num ?? r.party_code),
      district_id: intOrEmpty(r.major_id ?? r.district_id),
      district_name_ka: "",
      list_order: "",
      ballot_number: "",
      first_name, last_name, name_ka,
      partisanship: "",
      elected: "",
      source: "SakrebuloMembers2014.pdf"
    };
  });
}

// Local mayor candidates CSV → _mayor.csv (also splits gamgebeli when present)
function fromLocalMayorCsv(legacyPath, electionId) {
  const rows = readCsv(legacyPath);
  if (!rows) return null;
  return rows.map(r => {
    const { first_name, last_name, name_ka } = splitName(r.name_ka, r.first_name, r.last_name);
    const partyLabel = strOrEmpty(r.party_label_ka) || strOrEmpty(r.party_name);
    const partyId = strOrEmpty(r.party_id) || resolvePartyId(partyLabel, electionId);
    const electionType = strOrEmpty(r.election_type) || "mayor";
    return {
      election_id: electionId,
      sub_id: "__main__",
      vote_type: electionType, // "mayor" or "gamgebeli"
      party_id: partyId || "",
      party_label_ka: partyLabel,
      party_code: intOrEmpty(r.party_code ?? r.party_num),
      district_id: intOrEmpty(r.selfgov_id ?? r.district_id),
      district_name_ka: "",
      list_order: "",
      ballot_number: "",
      first_name, last_name, name_ka,
      partisanship: "",
      elected: "",
      source: "SakrebuloMembers2014.pdf"
    };
  });
}

// Local YAML candidate roster (data/config/candidates/local/local_*.yml)
function fromLocalYaml(yamlPath, electionId) {
  if (!fs.existsSync(yamlPath)) return null;
  const doc = readYaml(yamlPath);
  const candidates = doc?.candidates ?? {};
  const out = [];
  for (const [_, c] of Object.entries(candidates)) {
    const { first_name, last_name, name_ka } = splitName(c.name_ka, null, null);
    const partyId = strOrEmpty(c.party);
    const partyMap = partyMapFor(electionId);
    const partyLabel = partyMap[partyId]?.name_ka ?? partyRegistry[partyId]?.name?.ka ?? "";
    let voteType = strOrEmpty(c.election_type) || "mayor";
    // Normalize: 2017+ uses sakrebulo_smd; treat same as council_smd for local
    if (voteType === "sakrebulo_smd") voteType = "council_smd";
    const districtId = intOrEmpty(c.major_id ?? c.selfgov_id ?? c.district_id);
    out.push({
      election_id: electionId,
      sub_id: "__main__",
      vote_type: voteType,
      party_id: partyId || "",
      party_label_ka: partyLabel,
      party_code: "",
      district_id: districtId,
      district_name_ka: "",
      list_order: "",
      ballot_number: "",
      first_name, last_name, name_ka,
      partisanship: "",
      elected: "",
      source: path.basename(yamlPath)
    });
  }
  return out;
}

// Presidential candidates CSV → _presidential.csv
function fromPresidentialCsv(legacyPath, electionId) {
  const rows = readCsv(legacyPath);
  if (!rows) return null;
  return rows.map(r => {
    const { first_name, last_name, name_ka } = splitName(r.name_ka, r.first_name, r.last_name);
    const partyId = strOrEmpty(r.party_id);
    const partyLabel = strOrEmpty(r.party_label_ka);
    return {
      election_id: electionId,
      sub_id: "__main__",
      vote_type: "presidential",
      party_id: partyId,
      party_label_ka: partyLabel,
      party_code: intOrEmpty(r.code),
      district_id: "",
      district_name_ka: "",
      list_order: "",
      ballot_number: intOrEmpty(r.code),
      first_name, last_name, name_ka,
      partisanship: "",
      elected: "",
      source: ""
    };
  });
}

// Elected CSV (parliamentary / adjara / local) → _elected.csv
// vote_type per row preserves the original election_type / mandate_type column.
function fromElectedCsv(legacyPath, electionId) {
  const rows = readCsv(legacyPath);
  if (!rows) return null;
  return rows.map(r => {
    const { first_name, last_name, name_ka } = splitName(r.name_ka, r.first_name, r.last_name);
    const rawType = strOrEmpty(r.election_type) || strOrEmpty(r.mandate_type);
    // Normalize legacy variants to canonical slot keys
    const voteType = (
      rawType === "party_list" || rawType === "pr_member" ? "pr" :
      rawType === "smd_member" || rawType === "council_smd" || rawType === "majoritarian" ? "council_smd" :
      rawType === "mayor" ? "mayor" :
      rawType === "gamgebeli" ? "gamgebeli" :
      rawType
    );
    const partyLabel = strOrEmpty(r.party_label) || strOrEmpty(r.party_name);
    const partyId = strOrEmpty(r.party_id) || resolvePartyId(partyLabel, electionId);
    return {
      election_id: electionId,
      sub_id: "__main__",
      vote_type: voteType,
      party_id: partyId || "",
      party_label_ka: partyLabel,
      party_code: intOrEmpty(r.party_num ?? r.party_code),
      district_id: intOrEmpty(r.district_id ?? r.maj_id ?? r.selfgov_id),
      district_name_ka: strOrEmpty(r.district_name_ka ?? r.local_governing_unit ?? r.smd_name),
      list_order: intOrEmpty(r.elected_order ?? r.order_id),
      ballot_number: intOrEmpty(r.candidate_number),
      first_name, last_name, name_ka,
      partisanship: "",
      elected: "TRUE",
      source: strOrEmpty(r.source_pdf) || "SakrebuloMembers2014.pdf"
    };
  });
}

// adj_2008 hand-curated SMD CSV has a different shape (district_name_ka etc.)
function fromAdj2008SmdCsv(legacyPath) {
  const rows = readCsv(legacyPath);
  if (!rows) return null;
  return rows.map(r => {
    const { first_name, last_name, name_ka } = splitName(r.name_ka, r.first_name, r.last_name);
    const partyLabel = strOrEmpty(r.party_label);
    return {
      election_id: "adj_2008",
      sub_id: "__main__",
      vote_type: "smd",
      party_id: strOrEmpty(r.party_id),
      party_label_ka: partyLabel,
      party_code: intOrEmpty(r.ballot_number),
      district_id: intOrEmpty(r.electoral_district_id),
      district_name_ka: strOrEmpty(r.district_name_ka),
      list_order: "",
      ballot_number: intOrEmpty(r.candidate_order),
      first_name, last_name, name_ka,
      partisanship: "",
      elected: "",
      source: ""
    };
  });
}

// parl_2024 raw XLSX → _pr.csv (Candidates sheet) + _elected.csv (Elected sheet)
async function fromParl2024Xlsx() {
  const xlsx = path.join(RAW_DIR, "party_lists_2024_georgia_unified.xlsx");
  const pr = await readXlsxSheet(xlsx, "Candidates");
  const elected = await readXlsxSheet(xlsx, "Elected");
  const out = { pr: [], elected: [] };
  if (pr) {
    for (const r of pr) {
      const first = strOrEmpty(r.name);
      const last = strOrEmpty(r.last_name);
      if (!first && !last) continue;
      const partyLabel = strOrEmpty(r.party_name);
      const partyId = resolvePartyId(partyLabel, "parl_2024");
      out.pr.push({
        election_id: "parl_2024",
        sub_id: "__main__",
        vote_type: "pr",
        party_id: partyId || "",
        party_label_ka: partyLabel,
        party_code: intOrEmpty(r.party_number),
        district_id: "",
        district_name_ka: "",
        list_order: intOrEmpty(r.order_id),
        ballot_number: "",
        first_name: first, last_name: last, name_ka: `${first} ${last}`.trim(),
        partisanship: strOrEmpty(r.partisanship),
        elected: "",
        source: strOrEmpty(r.source_pdf)
      });
    }
  }
  if (elected) {
    for (const r of elected) {
      const full = strOrEmpty(r.name);
      const { first_name, last_name, name_ka } = splitName(full, null, null);
      if (!first_name && !last_name) continue;
      const partyLabel = strOrEmpty(r.electoral_subject);
      // Strip leading "<number> <label>" pattern (e.g. "41 ქართული ოცნება")
      const labelOnly = partyLabel.replace(/^\d+\s+/, "");
      const partyId = resolvePartyId(labelOnly, "parl_2024");
      out.elected.push({
        election_id: "parl_2024",
        sub_id: "__main__",
        vote_type: "pr",
        party_id: partyId || "",
        party_label_ka: labelOnly,
        party_code: intOrEmpty((partyLabel.match(/^(\d+)\s/) ?? [])[1]),
        district_id: "",
        district_name_ka: "",
        list_order: intOrEmpty(r.order_id_in_list),
        ballot_number: "",
        first_name, last_name, name_ka,
        partisanship: strOrEmpty(r.partisanship),
        elected: "TRUE",
        source: "party_lists_2024_georgia_unified.xlsx"
      });
    }
  }
  return out;
}

// local_2017 raw XLSX → 4 slot CSVs
async function fromLocal2017Xlsx() {
  const xlsx = path.join(RAW_DIR, "adg_2017_candidates_unified.xlsx");
  const out = { pr: [], council_smd: [], mayor: [], elected: [] };

  const pr = await readXlsxSheet(xlsx, "PR candidates");
  if (pr) {
    for (const r of pr) {
      const first = strOrEmpty(r.name);
      const last = strOrEmpty(r.last_name);
      if (!first && !last) continue;
      const partyLabel = strOrEmpty(r.party_list_name);
      const partyId = resolvePartyId(partyLabel, "local_2017");
      out.pr.push({
        election_id: "local_2017",
        sub_id: "__main__",
        vote_type: "pr",
        party_id: partyId || "",
        party_label_ka: partyLabel,
        party_code: intOrEmpty(r.party_number),
        district_id: intOrEmpty(r.district_number),
        district_name_ka: strOrEmpty(r.district_name),
        list_order: intOrEmpty(r.order_id),
        ballot_number: "",
        first_name: first, last_name: last, name_ka: `${first} ${last}`.trim(),
        partisanship: strOrEmpty(r.partisanship),
        elected: "",
        source: strOrEmpty(r.source_file)
      });
    }
  }

  const smd = await readXlsxSheet(xlsx, "majoritarian candidates");
  if (smd) {
    for (const r of smd) {
      const first = strOrEmpty(r.name);
      const last = strOrEmpty(r.last_name);
      if (!first && !last) continue;
      const partyLabel = strOrEmpty(r.endorsing_party);
      const partyId = resolvePartyId(partyLabel, "local_2017");
      out.council_smd.push({
        election_id: "local_2017",
        sub_id: "__main__",
        vote_type: "council_smd",
        party_id: partyId || "",
        party_label_ka: partyLabel,
        party_code: "",
        district_id: intOrEmpty(r.majoritarian_district ?? r.district_number),
        district_name_ka: strOrEmpty(r.district_name),
        list_order: "",
        ballot_number: intOrEmpty(r.candidate_number),
        first_name: first, last_name: last, name_ka: `${first} ${last}`.trim(),
        partisanship: "",
        elected: "",
        source: strOrEmpty(r.source_pdf)
      });
    }
  }

  const mayor = await readXlsxSheet(xlsx, "mayoral candidates");
  if (mayor) {
    for (const r of mayor) {
      const first = strOrEmpty(r.name);
      const last = strOrEmpty(r.last_name);
      if (!first && !last) continue;
      const partyLabel = strOrEmpty(r.endorsing_party);
      const partyId = resolvePartyId(partyLabel, "local_2017");
      out.mayor.push({
        election_id: "local_2017",
        sub_id: "__main__",
        vote_type: "mayor",
        party_id: partyId || "",
        party_label_ka: partyLabel,
        party_code: "",
        district_id: intOrEmpty(r.district_number),
        district_name_ka: strOrEmpty(r.district_name),
        list_order: "",
        ballot_number: intOrEmpty(r.candidate_number),
        first_name: first, last_name: last, name_ka: `${first} ${last}`.trim(),
        partisanship: "",
        elected: "",
        source: strOrEmpty(r.source_pdf)
      });
    }
  }

  const elected = await readXlsxSheet(xlsx, "elected politicians");
  if (elected) {
    for (const r of elected) {
      const first = strOrEmpty(r.name);
      const last = strOrEmpty(r.last_name);
      if (!first && !last) continue;
      const partyLabel = strOrEmpty(r.presenter_or_party);
      const partyId = resolvePartyId(partyLabel, "local_2017");
      const rawType = strOrEmpty(r.election_type);
      const voteType = rawType === "pr" ? "pr"
                    : rawType === "smd" || rawType === "majoritarian" ? "council_smd"
                    : rawType === "mayor" ? "mayor"
                    : rawType;
      out.elected.push({
        election_id: "local_2017",
        sub_id: "__main__",
        vote_type: voteType,
        party_id: partyId || "",
        party_label_ka: partyLabel,
        party_code: intOrEmpty(r.party_number),
        district_id: intOrEmpty(r.majoritarian_district),
        district_name_ka: strOrEmpty(r.local_governing_unit),
        list_order: "",
        ballot_number: "",
        first_name: first, last_name: last, name_ka: `${first} ${last}`.trim(),
        partisanship: "",
        elected: "TRUE",
        source: strOrEmpty(r.source_pdf)
      });
    }
  }

  return out;
}

// Map the vote_type string used in local_2021/2025 elected files to canonical.
function normalizeLocalElectedVoteType(raw) {
  const v = (raw ?? "").toString().toLowerCase().trim();
  if (v === "sakrebulo pr" || v === "pr" || v === "party_list" || v === "pr_member") return "pr";
  if (v === "mayor")     return "mayor";
  if (v === "gamgebeli") return "gamgebeli";
  if (v === "majoritarian" || v === "smd" || v === "council_smd" || v === "sakrebulo_smd" || v === "sakrebulo smd") return "council_smd";
  return "";
}

// Strip leading "<number>. " party-prefix patterns like "5. „ერთიანი..."
function stripPartyNumberPrefix(label) {
  if (!label) return { partyCode: "", label: "" };
  const m = String(label).match(/^\s*(\d+)\.\s+(.+)$/);
  if (m) return { partyCode: m[1], label: m[2].trim() };
  return { partyCode: "", label: String(label).trim() };
}

// Build a row for the local_2021/2025 elected sources. Both share the same
// schema (`self_governing_unit, vote_type, candidate_name, candidate_political_party, majoritarian_district_id`),
// just one is XLSX and the other is TSV.
function rowFromLocalElectedFlat(rec, electionId, source) {
  const fullName = strOrEmpty(rec.candidate_name);
  if (!fullName) return null;
  const { first_name, last_name, name_ka } = splitName(fullName, null, null);
  const { partyCode, label: partyLabel } = stripPartyNumberPrefix(rec.candidate_political_party);
  const partyId = resolvePartyId(partyLabel, electionId);
  const voteType = normalizeLocalElectedVoteType(rec.vote_type);
  // district_id: for SMD use majoritarian_district_id; for mayor/pr use self_governing_unit
  const district = voteType === "council_smd"
    ? intOrEmpty(rec.majoritarian_district_id)
    : intOrEmpty(rec.self_governing_unit);
  return {
    election_id: electionId,
    sub_id: "__main__",
    vote_type: voteType,
    party_id: partyId || "",
    party_label_ka: partyLabel,
    party_code: partyCode,
    district_id: district,
    district_name_ka: "",
    list_order: "",
    ballot_number: "",
    first_name, last_name, name_ka,
    partisanship: "",
    elected: "TRUE",
    source
  };
}

async function fromLocal2021ElectedXlsx() {
  const xlsx = path.join(RAW_DIR, "local2021_elected_people.xlsx");
  if (!fs.existsSync(xlsx)) return null;
  const rows = await readXlsxSheet(xlsx, (await new ExcelJS.Workbook().xlsx.readFile(xlsx), null)) ;
  // Re-read with explicit sheet name
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const ws = wb.worksheets[0];
  const hdr = ws.getRow(1).values.slice(1).map(v => String(v ?? "").trim());
  const out = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i).values.slice(1);
    if (!row.length) continue;
    const rec = {};
    hdr.forEach((h, j) => { rec[h] = row[j] != null ? String(row[j]).trim() : ""; });
    const canonical = rowFromLocalElectedFlat(rec, "local_2021", "local2021_elected_people.xlsx");
    if (canonical) out.push(canonical);
  }
  return out;
}

async function fromLocal2025ElectedCsv() {
  const csv = path.join(RAW_DIR, "local2025_elected_people.csv");
  if (!fs.existsSync(csv)) return null;
  const text = fs.readFileSync(csv, "utf8");
  // The "csv" is actually tab-separated despite the extension.
  const parser = text.includes("\t") ? tsvParse : csvParse;
  const rows = parser(text);
  const out = [];
  for (const r of rows) {
    const canonical = rowFromLocalElectedFlat(r, "local_2025", "local2025_elected_people.csv");
    if (canonical) out.push(canonical);
  }
  return out;
}

// adj_2024 raw XLSX — peek to determine PR/elected shape
async function fromAdj2024Xlsx() {
  const xlsx = path.join(RAW_DIR, "adjara_2024_election_results.xlsx");
  if (!fs.existsSync(xlsx)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  // List sheets in stderr for inspection during dry-run
  const sheetNames = wb.worksheets.map(w => w.name);
  process.stderr.write(`[adj_2024] sheets: ${sheetNames.join(", ")}\n`);
  // Heuristic: look for a sheet with PR-ish columns
  for (const sn of sheetNames) {
    if (/pr|party|პროპორ|სია/i.test(sn)) {
      const rows = await readXlsxSheet(xlsx, sn);
      if (!rows?.length) continue;
      const hdr = Object.keys(rows[0]);
      process.stderr.write(`[adj_2024] PR sheet candidate '${sn}' headers: ${hdr.join(", ")}\n`);
      // Defer concrete extraction until inspection; emit empty for now
    }
  }
  return null; // No-op until adj_2024's XLSX shape is hand-inspected
}

// ─── Job manifest ──────────────────────────────────────────────────────────

const jobs = [];
const summary = [];

function addCsvJob(outName, fn) { jobs.push({ outName, fn }); }

// Parliamentary
addCsvJob("parl_2008_pr.csv",       () => fromPartyListsCsv("data/candidates/parl2008_party_lists.csv", "parl_2008"));
addCsvJob("parl_2008_smd.csv",      () => fromSmdCandidatesCsv("data/candidates/parl2008_smd_candidates.csv", "parl_2008"));
addCsvJob("parl_2008_elected.csv",  () => fromElectedCsv("data/candidates/parl2008_elected.csv", "parl_2008"));
addCsvJob("parl_2012_pr.csv",       () => fromPartyListsCsv("data/candidates/parl2012_party_lists.csv", "parl_2012"));
addCsvJob("parl_2012_smd.csv",      () => fromSmdCandidatesCsv("data/candidates/parl2012_smd_candidates.csv", "parl_2012"));
addCsvJob("parl_2012_elected.csv",  () => fromElectedCsv("data/candidates/parl2012_elected.csv", "parl_2012"));

// Adjara
addCsvJob("adj_2008_pr.csv",        () => fromPartyListsCsv("data/candidates/adj2008_party_lists.csv", "adj_2008"));
addCsvJob("adj_2008_smd.csv",       () => fromAdj2008SmdCsv("data/candidates/adj2008_smd_candidates.csv"));
addCsvJob("adj_2016_pr.csv",        () => fromPartyListsCsv("data/candidates/adj2016_party_lists.csv", "adj_2016"));
addCsvJob("adj_2016_smd.csv",       () => fromSmdCandidatesCsv("data/candidates/adj2016_smd_candidates.csv", "adj_2016"));
addCsvJob("adj_2016_elected.csv",   () => fromElectedCsv("data/candidates/adj2016_elected.csv", "adj_2016"));
addCsvJob("adj_2020_pr.csv",        () => fromPartyListsCsv("data/candidates/adj2020_party_lists.csv", "adj_2020"));
addCsvJob("adj_2020_smd.csv",       () => fromSmdCandidatesCsv("data/candidates/adj2020_smd_candidates.csv", "adj_2020"));
addCsvJob("adj_2020_elected.csv",   () => fromElectedCsv("data/candidates/adj2020_elected.csv", "adj_2020"));

// Local 2010
addCsvJob("local_2010_council_smd.csv", () => fromLocal2014SmdCsv("data/candidates/local2010_smd_candidates.csv", "local_2010"));
addCsvJob("local_2010_mayor.csv",       () => fromLocalMayorCsv("data/candidates/local2010_mayor_candidates.csv", "local_2010"));

// Local 2014
addCsvJob("local_2014_pr.csv",          () => fromPartyListsCsv("data/candidates/local2014_party_lists.csv", "local_2014"));
addCsvJob("local_2014_council_smd.csv", () => fromLocal2014SmdCsv("data/candidates/local2014_smd_candidates.csv", "local_2014"));

// Local 2014 mayor+gamgebeli — split into two files by election_type column
addCsvJob("local_2014_mayor.csv",       () => {
  const all = fromLocalMayorCsv("data/candidates/local2014_mayor_gamgebeli_candidates.csv", "local_2014");
  return (all ?? []).filter(r => r.vote_type === "mayor");
});
addCsvJob("local_2014_gamgebeli.csv",   () => {
  const all = fromLocalMayorCsv("data/candidates/local2014_mayor_gamgebeli_candidates.csv", "local_2014");
  return (all ?? []).filter(r => r.vote_type === "gamgebeli");
});
addCsvJob("local_2014_elected.csv",     () => fromElectedCsv("data/candidates/local2014_elected.csv", "local_2014"));

// Local 2021 — from YAML roster (mayor/gamgebeli/council_smd)
addCsvJob("local_2021_council_smd.csv", () => {
  const all = fromLocalYaml(path.join(LOCAL_YAML_DIR, "local_2021.yml"), "local_2021");
  return (all ?? []).filter(r => r.vote_type === "council_smd");
});
addCsvJob("local_2021_mayor.csv", () => {
  const all = fromLocalYaml(path.join(LOCAL_YAML_DIR, "local_2021.yml"), "local_2021");
  return (all ?? []).filter(r => r.vote_type === "mayor");
});
addCsvJob("local_2021_gamgebeli.csv", () => {
  const all = fromLocalYaml(path.join(LOCAL_YAML_DIR, "local_2021.yml"), "local_2021");
  return (all ?? []).filter(r => r.vote_type === "gamgebeli");
});

// Local 2025 — from YAML roster
addCsvJob("local_2025_council_smd.csv", () => {
  const all = fromLocalYaml(path.join(LOCAL_YAML_DIR, "local_2025.yml"), "local_2025");
  return (all ?? []).filter(r => r.vote_type === "council_smd");
});
addCsvJob("local_2025_mayor.csv", () => {
  const all = fromLocalYaml(path.join(LOCAL_YAML_DIR, "local_2025.yml"), "local_2025");
  return (all ?? []).filter(r => r.vote_type === "mayor");
});

// Presidential
addCsvJob("pres_2008_presidential.csv", () => fromPresidentialCsv("data/candidates/pres2008_candidates.csv", "pres_2008"));
addCsvJob("pres_2013_presidential.csv", () => fromPresidentialCsv("data/candidates/pres2013_candidates.csv", "pres_2013"));

// ─── Run jobs ──────────────────────────────────────────────────────────────

(async () => {
  // Sync jobs first
  for (const job of jobs) {
    try {
      const rows = job.fn();
      if (!rows) { summary.push({ file: job.outName, rows: 0, status: "skipped (no source)" }); continue; }
      const n = writeCanonicalCsv(job.outName, rows);
      summary.push({ file: job.outName, rows: n, status: "ok" });
    } catch (err) {
      summary.push({ file: job.outName, rows: 0, status: "error: " + err.message });
    }
  }

  // Async jobs — XLSX-based
  // parl_2024
  try {
    const out = await fromParl2024Xlsx();
    summary.push({ file: "parl_2024_pr.csv",      rows: writeCanonicalCsv("parl_2024_pr.csv", out.pr),       status: "ok" });
    summary.push({ file: "parl_2024_elected.csv", rows: writeCanonicalCsv("parl_2024_elected.csv", out.elected), status: "ok" });
  } catch (err) {
    summary.push({ file: "parl_2024_*", rows: 0, status: "error: " + err.message });
  }

  // local_2017
  try {
    const out = await fromLocal2017Xlsx();
    summary.push({ file: "local_2017_pr.csv",          rows: writeCanonicalCsv("local_2017_pr.csv",          out.pr),         status: "ok" });
    summary.push({ file: "local_2017_council_smd.csv", rows: writeCanonicalCsv("local_2017_council_smd.csv", out.council_smd), status: "ok" });
    summary.push({ file: "local_2017_mayor.csv",       rows: writeCanonicalCsv("local_2017_mayor.csv",       out.mayor),      status: "ok" });
    summary.push({ file: "local_2017_elected.csv",     rows: writeCanonicalCsv("local_2017_elected.csv",     out.elected),    status: "ok" });
  } catch (err) {
    summary.push({ file: "local_2017_*", rows: 0, status: "error: " + err.message });
  }

  // local_2021 elected
  try {
    const out = await fromLocal2021ElectedXlsx();
    if (out) summary.push({ file: "local_2021_elected.csv", rows: writeCanonicalCsv("local_2021_elected.csv", out), status: "ok" });
    else     summary.push({ file: "local_2021_elected.csv", rows: 0, status: "skipped (no XLSX)" });
  } catch (err) {
    summary.push({ file: "local_2021_elected.csv", rows: 0, status: "error: " + err.message });
  }

  // local_2025 elected
  try {
    const out = await fromLocal2025ElectedCsv();
    if (out) summary.push({ file: "local_2025_elected.csv", rows: writeCanonicalCsv("local_2025_elected.csv", out), status: "ok" });
    else     summary.push({ file: "local_2025_elected.csv", rows: 0, status: "skipped (no source)" });
  } catch (err) {
    summary.push({ file: "local_2025_elected.csv", rows: 0, status: "error: " + err.message });
  }

  // adj_2024 — peek-only for now
  try { await fromAdj2024Xlsx(); } catch (err) { process.stderr.write("adj_2024 peek failed: " + err.message + "\n"); }

  // ─── Report ──────────────────────────────────────────────────────────────
  console.log("\n=== Migration summary ===");
  console.log(`Output dir: ${path.relative(ROOT, OUT_DIR)}`);
  console.log(`Mode: ${APPLY ? "APPLY (writing alongside legacy)" : "DRY-RUN (writing to _migrated/)"}`);
  console.log("");
  let total = 0;
  for (const s of summary.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`  ${s.file.padEnd(40)} ${String(s.rows).padStart(6)} rows   ${s.status}`);
    total += s.rows;
  }
  console.log(`\n  total rows written: ${total}`);

  if (_unresolved.size) {
    console.log(`\n=== Unresolved party labels (no party_id match) ===`);
    for (const [eid, labels] of [..._unresolved].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`\n  ${eid}:`);
      for (const l of [...labels].sort()) console.log(`    "${l}"`);
    }
    console.log("\n(These rows still carry party_label_ka; they simply can't be cross-linked to a registry entry. Promote them in parties.yml if they're real parties.)");
  }
})();
