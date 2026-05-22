#!/usr/bin/env node
// Ingest src/data/raw/presidential_candidates.xlsx into canonical CSVs.
// Output:
//   src/data/candidates/pres_2008_presidential.csv
//   src/data/candidates/pres_2013_presidential.csv
//   src/data/candidates/pres_2018_presidential.csv        (R1)
//   src/data/candidates/pres_2018_r2_presidential.csv     (R2 runoff sub-election)
//   src/data/candidates/pres_2024_indirect_presidential.csv
//
// The party_id column resolves to the candidate id (per-person id) used by the
// election YAMLs in src/data/config/elections/presidential/, so that
// candidate cards on the parties page continue to work. The candidate id is
// inferred from:
//   1. The existing CSV (for pres_2008 / pres_2013, to preserve historical ids)
//   2. The YAML's candidates: block (for pres_2018, pres_2024_indirect)
//   3. As a fallback, a slugified last name
//
// Usage:
//   node scripts/ingest-presidential.js          (dry-run → src/data/candidates/_pres_ingest/)
//   node scripts/ingest-presidential.js --apply  (writes directly to src/data/candidates/)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { csvFormat, csvParse } from "d3-dsv";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const PRES_DIR = path.join(SRC, "data/config/elections/presidential");
const CAND_DIR = path.join(SRC, "data/candidates");
const RAW_XLSX = path.join(SRC, "data/raw/presidential_candidates.xlsx");

const APPLY = process.argv.includes("--apply");
const OUT_DIR = APPLY ? CAND_DIR : path.join(CAND_DIR, "_pres_ingest");
fs.mkdirSync(OUT_DIR, { recursive: true });

const COLUMNS = [
  "election_id", "sub_id", "vote_type", "party_id", "party_label_ka", "party_code",
  "district_id", "district_name_ka", "list_order", "ballot_number",
  "first_name", "last_name", "name_ka", "partisanship", "elected", "source"
];

function emptyRow() { const r = {}; for (const c of COLUMNS) r[c] = ""; return r; }

function writeCanonicalCsv(filename, rows) {
  const normalized = rows.map(r => {
    const out = emptyRow();
    for (const c of COLUMNS) if (r[c] != null && r[c] !== "") out[c] = String(r[c]);
    return out;
  });
  const csv = csvFormat(normalized, COLUMNS);
  const full = path.join(OUT_DIR, filename);
  fs.writeFileSync(full, csv, "utf8");
  console.log(`Wrote ${path.relative(ROOT, full)}: ${normalized.length} rows`);
}

function readYaml(file) { return yaml.load(fs.readFileSync(file, "utf8")); }

function readExistingCsv(filename) {
  const full = path.join(CAND_DIR, filename);
  if (!fs.existsSync(full)) return [];
  return csvParse(fs.readFileSync(full, "utf8"));
}

// ─── Build (name → party_id) mapping ──────────────────────────────────────

function normName(s) {
  return (s ?? "").toString().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Preserve historical party_ids by reading the existing files first.
function buildExistingMap(filename) {
  const m = new Map();
  for (const r of readExistingCsv(filename)) {
    m.set(normName(r.name_ka), r.party_id);
  }
  return m;
}

const existing2008 = buildExistingMap("pres_2008_presidential.csv");
const existing2013 = buildExistingMap("pres_2013_presidential.csv");

// Build YAML candidate maps.
function yamlCandidatesMap(electionFile) {
  const m = new Map();
  const doc = readYaml(path.join(PRES_DIR, electionFile));
  for (const c of (doc?.candidates ?? [])) {
    if (c?.name?.ka && c.id) m.set(normName(c.name.ka), c.id);
  }
  return m;
}

const yaml2018 = yamlCandidatesMap("pres_2018.yml");
const yaml2024i = yamlCandidatesMap("pres_2024_indirect.yml");

// Slugify last name as last-resort party_id.
function slugifyLast(lastNameKa) {
  // Map Georgian letters to a Latin-ish slug. For now just lowercase the
  // last_name and strip non-letters; the id stays Georgian so it's stable.
  return normName(lastNameKa);
}

// Final resolver per election. Reports anything that couldn't be matched
// against an existing id (so we can review).
const unmatched = new Map(); // election_id → Set<name>
function resolveCandidateId(electionId, fullName, lastName) {
  const norm = normName(fullName);
  let id = null;
  if (electionId === "pres_2008") id = existing2008.get(norm);
  else if (electionId === "pres_2013") id = existing2013.get(norm);
  else if (electionId === "pres_2018") id = yaml2018.get(norm);
  else if (electionId === "pres_2024_indirect") id = yaml2024i.get(norm);
  if (id) return id;
  const set = unmatched.get(electionId) ?? new Set();
  set.add(fullName);
  unmatched.set(electionId, set);
  return slugifyLast(lastName);
}

// ─── Read XLSX ─────────────────────────────────────────────────────────────

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(RAW_XLSX);

function sheetRows(name) {
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const hdr = [];
  ws.getRow(1).eachCell((cell, c) => { hdr[c] = String(cell.value); });
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (row.cellCount === 0) continue;
    const rec = {};
    hdr.forEach((h, c) => {
      if (!h) return;
      const v = row.getCell(c).value;
      rec[h] = v == null ? "" : String(v).trim();
    });
    out.push(rec);
  }
  return out;
}

const rows = sheetRows("Candidates");

const SOURCE = "presidential_candidates.xlsx";

// Map "elections" column → (election_id, sub_id, filename)
function mapElection(label) {
  switch ((label ?? "").trim()) {
    case "presidential 2008":
      return { election_id: "pres_2008", sub_id: "__main__", filename: "pres_2008_presidential.csv" };
    case "presidential 2013":
      return { election_id: "pres_2013", sub_id: "__main__", filename: "pres_2013_presidential.csv" };
    case "presidential 2018_r1":
      return { election_id: "pres_2018", sub_id: "__main__", filename: "pres_2018_presidential.csv" };
    case "presidential 2018_r2":
      return { election_id: "pres_2018", sub_id: "pres_2018_r2", filename: "pres_2018_r2_presidential.csv" };
    case "presidential 2024":
      return { election_id: "pres_2024_indirect", sub_id: "__main__", filename: "pres_2024_indirect_presidential.csv" };
    default:
      throw new Error(`Unknown election label: ${label}`);
  }
}

// Split full name → (first, last). Georgian convention: first then last.
function splitName(full) {
  const t = (full ?? "").trim();
  const i = t.indexOf(" ");
  if (i < 0) return { first: "", last: t };
  return { first: t.slice(0, i), last: t.slice(i + 1).trim() };
}

function electedFlag(v) {
  const x = (v ?? "").toString().trim().toLowerCase();
  if (x === "yes" || x === "true") return "TRUE";
  if (x === "no"  || x === "false") return "FALSE";
  return "";
}

// ─── Bucket rows by output file ───────────────────────────────────────────

const buckets = new Map();
for (const r of rows) {
  const meta = mapElection(r.elections);
  const { first, last } = splitName(r.name);
  const partyId = resolveCandidateId(meta.election_id, r.name, last);
  const row = {
    election_id: meta.election_id,
    sub_id: meta.sub_id,
    vote_type: "presidential",
    party_id: partyId,
    party_label_ka: r.party,
    party_code: r.code,
    district_id: "",
    district_name_ka: "",
    list_order: "",
    ballot_number: r.code,
    first_name: first,
    last_name: last,
    name_ka: r.name,
    partisanship: "",
    elected: electedFlag(r.elected),
    source: SOURCE,
  };
  const list = buckets.get(meta.filename) ?? [];
  list.push(row);
  buckets.set(meta.filename, list);
}

for (const [filename, rows] of buckets) writeCanonicalCsv(filename, rows);

if (unmatched.size > 0) {
  console.log("\nCandidates without an existing id (will use slugified last-name as id):");
  for (const [eid, set] of unmatched) {
    console.log(`  ${eid}:`);
    for (const n of set) console.log(`    ${n}`);
  }
} else {
  console.log("\nAll candidates matched against existing ids or YAML candidate registries.");
}

console.log(APPLY
  ? "\nApplied to src/data/candidates/."
  : `\nDry run — files in ${path.relative(ROOT, OUT_DIR)}. Re-run with --apply.`);
