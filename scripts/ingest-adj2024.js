#!/usr/bin/env node
// Ingest src/data/raw/adjara_2024_party_lists_unified.xlsx into canonical CSVs:
//
//   src/data/candidates/adj_2024_pr.csv
//   src/data/candidates/adj_2024_elected.csv
//
// adj_2024 is PR-only (no SMD).
//
// Usage:
//   node scripts/ingest-adj2024.js           (dry-run → src/data/candidates/_adj2024_ingest/)
//   node scripts/ingest-adj2024.js --apply   (writes directly to src/data/candidates/)

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
const RAW_XLSX = path.join(SRC, "data/raw/adjara_2024_party_lists_unified.xlsx");

const APPLY = process.argv.includes("--apply");
const OUT_DIR = APPLY ? CAND_DIR : path.join(CAND_DIR, "_adj2024_ingest");
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

const adj2024Doc = yaml.load(
  fs.readFileSync(path.join(ELECTIONS_DIR, "adjara/adj_2024.yml"), "utf8")
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
  for (const p of (adj2024Doc?.parties ?? [])) {
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

const prRows = sheetRows("candidates");
const electedRows = sheetRows("elected members");

const SOURCE = "adjara_2024_party_lists_unified.xlsx";

// ─── PR candidates ─────────────────────────────────────────────────────────

const prOut = [];
for (const r of prRows) {
  const partyId = resolvePartyId(r.party_name) ?? "";
  prOut.push({
    election_id: "adj_2024",
    sub_id: "__main__",
    vote_type: "pr",
    party_id: partyId,
    party_label_ka: r.party_name,
    party_code: r.party_number,
    district_id: "",
    district_name_ka: "",
    list_order: r.list_order_id,
    ballot_number: "",
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: r.full_name || [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "",
    source: SOURCE,
  });
}

// ─── Elected ───────────────────────────────────────────────────────────────

const elOut = [];
for (const r of electedRows) {
  const partyId = resolvePartyId(r.party_name) ?? "";
  elOut.push({
    election_id: "adj_2024",
    sub_id: "__main__",
    vote_type: "pr",
    party_id: partyId,
    party_label_ka: r.party_name,
    party_code: r.party_number,
    district_id: "",
    district_name_ka: "",
    list_order: r.list_order_id,
    ballot_number: "",
    first_name: r.first_name,
    last_name: r.last_name,
    name_ka: r.full_name || [r.first_name, r.last_name].filter(Boolean).join(" "),
    partisanship: "",
    elected: "TRUE",
    source: SOURCE,
  });
}

writeCanonicalCsv("adj_2024_pr.csv", prOut);
writeCanonicalCsv("adj_2024_elected.csv", elOut);

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
