#!/usr/bin/env node
// Ingest src/data/raw/adg_2025_candidates_unified.xlsx into canonical CSVs:
//
//   src/data/candidates/local_2025_pr.csv          (PR-per-selfgov)
//   src/data/candidates/local_2025_council_smd.csv (Sakrebulo majoritarian)
//   src/data/candidates/local_2025_mayor.csv
//   src/data/candidates/local_2025_elected.csv
//
// Usage:
//   node scripts/ingest-local2025.js          (dry-run → src/data/candidates/_2025_ingest/)
//   node scripts/ingest-local2025.js --apply  (writes directly to src/data/candidates/)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { csvFormat } from "d3-dsv";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const ELECTIONS_DIR = path.join(SRC, "data/config/elections");
const PARTIES_YML = path.join(SRC, "data/config/parties.yml");
const CAND_DIR = path.join(SRC, "data/candidates");
const RAW_XLSX = path.join(SRC, "data/raw/adg_2025_candidates_unified.xlsx");

const APPLY = process.argv.includes("--apply");
const OUT_DIR = APPLY ? CAND_DIR : path.join(CAND_DIR, "_2025_ingest");
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

// ─── Party-id resolver ─────────────────────────────────────────────────────

const partiesYml = yaml.load(fs.readFileSync(PARTIES_YML, "utf8"));
const partyRegistry = {};
for (const p of (partiesYml?.parties ?? [])) partyRegistry[p.id] = p;

const local2025Doc = yaml.load(
  fs.readFileSync(path.join(ELECTIONS_DIR, "local/local_2025.yml"), "utf8")
);

function normLabel(s) {
  let x = (s ?? "").toString().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  x = x.replace(/ური/g, "ული");
  return x;
}

function bestMatchFromMap(label, candidates) {
  const norm = normLabel(label);
  if (!norm) return null;
  let best = null;
  for (const [pid, nameKa] of candidates) {
    const nk = normLabel(nameKa);
    if (!nk) continue;
    if (!(norm === nk || norm.includes(nk) || nk.includes(norm))) continue;
    const score = nk.length + (norm === nk ? 1000 : 0);
    if (!best || score > best.score) best = { pid, score };
  }
  return best?.pid ?? null;
}

const unresolved = new Map();
function resolvePartyId(label) {
  if (!label) return null;
  const cands1 = [];
  for (const p of (local2025Doc?.parties ?? [])) {
    if (p.alias?.ka) cands1.push([p.id, p.alias.ka]);
    if (partyRegistry[p.id]?.name?.ka) cands1.push([p.id, partyRegistry[p.id].name.ka]);
  }
  const hit1 = bestMatchFromMap(label, cands1);
  if (hit1) return hit1;
  const cands2 = [];
  for (const [pid, p] of Object.entries(partyRegistry)) {
    if (p.name?.ka) cands2.push([pid, p.name.ka]);
  }
  const hit2 = bestMatchFromMap(label, cands2);
  if (hit2) return hit2;
  unresolved.set(label, (unresolved.get(label) ?? 0) + 1);
  return null;
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

const mayorRows = sheetRows("mayoral candidates");
const smdRows = sheetRows("majoritarian candidates");
const prRows = sheetRows("party lists");
const electedRows = sheetRows("elected");

const SOURCE = "adg_2025_candidates_unified.xlsx";

function isInitiative(label) {
  if (!label) return false;
  if (/^\s*საინიციატივო\s+ჯგუფი/.test(label)) return true;
  if (/^\s*დამოუკიდებელი\s*$/.test(label)) return true;
  // Bare comma-separated name lists (3+ commas, no curly-quote-wrapped party
  // name) are initiative groups that dropped the "საინიციატივო ჯგუფი - " prefix.
  // Standard registered party / bloc labels never have 3+ commas.
  const commas = (label.match(/,/g) ?? []).length;
  if (commas >= 3 && !/[„"]/.test(label)) return true;
  return false;
}

// Build a selfgov_id ← local_governing_unit lookup from the mayor sheet, so we
// can fill district_id on elected mayor rows that only carry the name.
const selfgovIdByName = new Map();
for (const r of mayorRows) {
  if (r.district_name && r.district_code) {
    selfgovIdByName.set(r.district_name.trim(), r.district_code);
  }
}

// ─── PR-per-selfgov candidates ─────────────────────────────────────────────

const prOut = [];
for (const r of prRows) {
  const partyId = isInitiative(r.party_name) ? "" : (resolvePartyId(r.party_name) ?? "");
  prOut.push({
    election_id: "local_2025",
    sub_id: "__main__",
    vote_type: "pr",
    party_id: partyId,
    party_label_ka: r.party_name,
    party_code: r.party_number,
    district_id: r.district_code,
    district_name_ka: r.district_name,
    list_order: r.order_id,
    ballot_number: "",
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "",
    source: SOURCE,
  });
}

// ─── Council SMD (Sakrebulo majoritarian) candidates ───────────────────────

const smdOut = [];
for (const r of smdRows) {
  const partyId = isInitiative(r.party_name) ? "" : (resolvePartyId(r.party_name) ?? "");
  smdOut.push({
    election_id: "local_2025",
    sub_id: "__main__",
    vote_type: "council_smd",
    party_id: partyId,
    party_label_ka: r.party_name,
    party_code: "",
    district_id: r.majoritarian_district_code,
    district_name_ka: r.district_name,
    list_order: "",
    ballot_number: r.candidate_number,
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "",
    source: SOURCE,
  });
}

// ─── Mayor candidates ──────────────────────────────────────────────────────

const mayorOut = [];
for (const r of mayorRows) {
  const partyId = isInitiative(r.party_name) ? "" : (resolvePartyId(r.party_name) ?? "");
  mayorOut.push({
    election_id: "local_2025",
    sub_id: "__main__",
    vote_type: "mayor",
    party_id: partyId,
    party_label_ka: r.party_name,
    party_code: "",
    district_id: r.district_code,
    district_name_ka: r.district_name,
    list_order: "",
    ballot_number: r.candidate_number,
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "",
    source: SOURCE,
  });
}

// ─── Elected (winners) ─────────────────────────────────────────────────────
// election_type values: "pr", "smd" (sakrebulo SMD → council_smd), "mayor"

const elOut = [];
for (const r of electedRows) {
  const et = (r.election_type ?? "").toLowerCase();
  const voteType = et === "pr" ? "pr"
                : et === "mayor" ? "mayor"
                : "council_smd";
  const partyId = isInitiative(r.party_name) ? "" : (resolvePartyId(r.party_name) ?? "");
  // District id resolution depends on the vote_type:
  //   pr / mayor  → selfgov_id (lookup by local_governing_unit name)
  //   council_smd → majoritarian_district_code from XLSX
  let districtId = "";
  if (voteType === "council_smd") districtId = r.majoritarian_district_code ?? "";
  else if (r.local_governing_unit) districtId = selfgovIdByName.get(r.local_governing_unit.trim()) ?? "";
  elOut.push({
    election_id: "local_2025",
    sub_id: "__main__",
    vote_type: voteType,
    party_id: partyId,
    party_label_ka: r.party_name,
    party_code: voteType === "pr" ? r.party_number : "",
    district_id: districtId,
    district_name_ka: r.local_governing_unit ?? "",
    list_order: voteType === "pr" ? r.list_order_id : "",
    ballot_number: "",
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: r.full_name || [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "TRUE",
    source: SOURCE,
  });
}

// ─── Write ─────────────────────────────────────────────────────────────────

writeCanonicalCsv("local_2025_pr.csv", prOut);
writeCanonicalCsv("local_2025_council_smd.csv", smdOut);
writeCanonicalCsv("local_2025_mayor.csv", mayorOut);
writeCanonicalCsv("local_2025_elected.csv", elOut);

if (unresolved.size > 0) {
  console.log(`\n${unresolved.size} unresolved party labels:`);
  for (const [label, count] of [...unresolved.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  [${count}] ${label}`);
  }
} else {
  console.log("\nAll party labels resolved against the registry.");
}

console.log(APPLY
  ? "\nApplied to src/data/candidates/."
  : `\nDry run — files in ${path.relative(ROOT, OUT_DIR)}. Re-run with --apply.`);
