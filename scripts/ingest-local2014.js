#!/usr/bin/env node
// Ingest the corrected 2014 local-election XLSX files into canonical CSVs:
//
//   adg_2014_candidates_unified_corrected.xlsx  → pr / council_smd / mayor / gamgebeli
//   adg_2014_elected_politicians.xlsx            → elected
//
// Output:
//   src/data/candidates/local_2014_pr.csv
//   src/data/candidates/local_2014_council_smd.csv
//   src/data/candidates/local_2014_mayor.csv
//   src/data/candidates/local_2014_gamgebeli.csv
//   src/data/candidates/local_2014_elected.csv
//
// Usage:
//   node scripts/ingest-local2014.js          (dry-run → src/data/candidates/_2014_ingest/)
//   node scripts/ingest-local2014.js --apply  (writes directly to src/data/candidates/)

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
const RAW_CANDIDATES = path.join(SRC, "data/raw/adg_2014_candidates_unified_corrected.xlsx");
const RAW_ELECTED = path.join(SRC, "data/raw/adg_2014_elected_politicians.xlsx");

const APPLY = process.argv.includes("--apply");
const OUT_DIR = APPLY ? CAND_DIR : path.join(CAND_DIR, "_2014_ingest");
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

// ─── Party resolver ────────────────────────────────────────────────────────

const partiesYml = yaml.load(fs.readFileSync(PARTIES_YML, "utf8"));
const partyRegistry = {};
for (const p of (partiesYml?.parties ?? [])) partyRegistry[p.id] = p;

const local2014Doc = yaml.load(
  fs.readFileSync(path.join(ELECTIONS_DIR, "local/local_2014.yml"), "utf8")
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
  for (const p of (local2014Doc?.parties ?? [])) {
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

function isInitiative(label) {
  if (!label) return false;
  if (/^\s*საინიციატივო\s+ჯგუფი/.test(label)) return true;
  if (/^\s*დამოუკიდებელი\s*$/.test(label)) return true;
  const commas = (label.match(/,/g) ?? []).length;
  if (commas >= 3 && !/[„"]/.test(label)) return true;
  return false;
}

// ─── XLSX helpers ──────────────────────────────────────────────────────────

async function loadWb(p) { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p); return wb; }

function sheetRows(wb, name) {
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

const wbC = await loadWb(RAW_CANDIDATES);
const wbE = await loadWb(RAW_ELECTED);

const prRows       = sheetRows(wbC, "party lists");
const smdRows      = sheetRows(wbC, "majoritarian candidates");
const mgRows       = sheetRows(wbC, "mayor_gamgebeli");
const electedRows  = sheetRows(wbE, "elected politicians");

const CANDIDATES_SOURCE = "adg_2014_candidates_unified_corrected.xlsx";
const ELECTED_SOURCE   = "adg_2014_elected_politicians.xlsx";

function partyIdOf(label) {
  if (isInitiative(label)) return "";
  return resolvePartyId(label) ?? "";
}

// ─── PR-per-selfgov candidates ─────────────────────────────────────────────

const prOut = [];
for (const r of prRows) {
  prOut.push({
    election_id: "local_2014",
    sub_id: "__main__",
    vote_type: "pr",
    party_id: partyIdOf(r.party_name),
    party_label_ka: r.party_name,
    party_code: "",
    district_id: r.selfgov_id,
    district_name_ka: r.district_code,
    list_order: r.order_id,
    ballot_number: "",
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "",
    source: CANDIDATES_SOURCE,
  });
}

// ─── Council SMD candidates ────────────────────────────────────────────────

const smdOut = [];
for (const r of smdRows) {
  smdOut.push({
    election_id: "local_2014",
    sub_id: "__main__",
    vote_type: "council_smd",
    party_id: partyIdOf(r.party_name),
    party_label_ka: r.party_name,
    party_code: "",
    district_id: r.maj_id,
    district_name_ka: r.district_name,
    list_order: "",
    ballot_number: r.candidate_number,
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "",
    source: CANDIDATES_SOURCE,
  });
}

// ─── Mayor + Gamgebeli candidates (split by office_type) ───────────────────

const mayorOut = [];
const gamgebeliOut = [];
for (const r of mgRows) {
  const isMayor = r.office_type === "mayor" || r.office_type === "tbilisi_mayor";
  const row = {
    election_id: "local_2014",
    sub_id: "__main__",
    vote_type: isMayor ? "mayor" : "gamgebeli",
    party_id: partyIdOf(r.party_name),
    party_label_ka: r.party_name,
    party_code: "",
    district_id: r.selfgov_id,
    district_name_ka: r.district_name,
    list_order: "",
    ballot_number: r.candidate_number,
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "",
    source: CANDIDATES_SOURCE,
  };
  (isMayor ? mayorOut : gamgebeliOut).push(row);
}

// ─── Elected (winners) ─────────────────────────────────────────────────────
// election_type values: pr_member, smd_member, mayor, gamgebeli
// rounds 1 and 2 (runoffs) all written into the main file, since the loader
// merges by (election_id, sub_id, vote_type, normName) and the existing local_2014
// elected file kept the same convention.

const elOut = [];
for (const r of electedRows) {
  const et = (r.election_type ?? "").toLowerCase();
  let voteType;
  if (et === "pr_member") voteType = "pr";
  else if (et === "smd_member") voteType = "council_smd";
  else if (et === "mayor") voteType = "mayor";
  else if (et === "gamgebeli") voteType = "gamgebeli";
  else voteType = et;

  elOut.push({
    election_id: "local_2014",
    sub_id: "__main__",
    vote_type: voteType,
    party_id: partyIdOf(r.party_name),
    party_label_ka: r.party_name,
    party_code: "",
    district_id: voteType === "council_smd" ? (r.maj_id ?? "") : (r.selfgov_id ?? ""),
    district_name_ka: r.local_governing_unit ?? r.smd_name ?? "",
    list_order: "",
    ballot_number: r.candidate_number ?? "",
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "TRUE",
    source: ELECTED_SOURCE,
  });
}

writeCanonicalCsv("local_2014_pr.csv", prOut);
writeCanonicalCsv("local_2014_council_smd.csv", smdOut);
writeCanonicalCsv("local_2014_mayor.csv", mayorOut);
writeCanonicalCsv("local_2014_gamgebeli.csv", gamgebeliOut);
writeCanonicalCsv("local_2014_elected.csv", elOut);

if (unresolved.size > 0) {
  console.log(`\n${unresolved.size} unresolved party labels:`);
  for (const [label, count] of [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  [${count}] ${label}`);
  }
} else {
  console.log("\nAll party labels resolved against the registry.");
}

console.log(APPLY
  ? "\nApplied to src/data/candidates/."
  : `\nDry run — files in ${path.relative(ROOT, OUT_DIR)}. Re-run with --apply.`);
