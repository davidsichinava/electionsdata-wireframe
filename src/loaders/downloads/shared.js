import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { csvParse, autoType } from "d3-dsv";

export const ROOT = process.cwd();
export const SRC = path.join(ROOT, "src");
export const ELECTIONS_DIR = path.join(SRC, "data", "config", "elections");
export const PARTIES_YML = path.join(SRC, "data", "config", "parties.yml");
export const OUT_DIR = path.join(SRC, "data", "downloads");
export const WORKBOOK_CREATOR = "GEDA - Georgia Election Data Archive";

export function ensureDownloadsDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf8"));
}

export function readAllElections() {
  const elections = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (/\.ya?ml$/i.test(entry.name)) {
        const election = readYaml(p);
        if (election?.id) elections.push(election);
      }
    }
  }
  scan(ELECTIONS_DIR);
  return elections;
}

export function readElection(id) {
  const election = readAllElections().find(e => e.id === id);
  if (!election) throw new Error(`Election config not found: ${id}`);
  return election;
}

export function readParties() {
  return readYaml(PARTIES_YML) ?? {};
}

export function partyList(partiesYaml) {
  return Array.isArray(partiesYaml?.parties) ? partiesYaml.parties : [];
}

export function buildPartyLookup(partiesYaml, electionParties = []) {
  const lookup = {};
  for (const p of partyList(partiesYaml)) {
    if (!p?.id) continue;
    lookup[p.id] = {
      id: p.id,
      name_en: p.name?.en ?? p.id,
      name_ka: p.name?.ka ?? p.name?.en ?? p.id,
      color: p.color ?? null,
    };
  }
  for (const ep of electionParties ?? []) {
    if (!ep?.id) continue;
    const base = lookup[ep.id] ?? { id: ep.id, name_en: ep.id, name_ka: ep.id };
    lookup[ep.id] = {
      ...base,
      name_en: ep.alias?.en ?? ep.name?.en ?? base.name_en,
      name_ka: ep.alias?.ka ?? ep.name?.ka ?? base.name_ka,
      color: ep.color ?? base.color,
      threshold_status: ep.threshold_status ?? null,
      seats_pr: ep.seats_pr ?? null,
      seats_smd: ep.seats_smd ?? null,
    };
  }
  return lookup;
}

export function sanitize(s) {
  return (s ?? "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60)
    .replace(/_$/, "");
}

export function subTypeLabel(sub) {
  if (!sub || sub.id === "__main__") return "main";
  if (sub.type === "runoff") return "runoff";
  if (sub.type === "by_election") return "by_election";
  if (sub.type === "repeated") return "repeated";
  return sub.type ?? "sub";
}

export function dateToken(election) {
  return (election.date ?? "").split(/\s/)[0].replace(/-/g, "");
}

// Canonical bundle filename — deterministic, no timestamp. Each (election, sub)
// has exactly one filename, so a regeneration overwrites the previous bundle and
// no orphan timestamped files accumulate. Cache-busting is handled via the SHA
// in the downloads manifest (downloads.json).
//
//   Main election:    {election.id}_main_{date_token}_data.xlsx
//   Sub-election:     {sub.id}_{date_token}_data.xlsx
//
// The date_token comes from sub.date when present, otherwise from election.date.
// sub.id is already unique across the project (it conventionally embeds the
// parent election.id) so this collides only on intentional re-runs.
export function bundleFilename(election, sub) {
  const isMain = !sub || sub.id === "__main__";
  const base = isMain ? `${election.id}_main` : sub.id;
  const dateSrc = (!isMain && sub.date) ? sub : election;
  return `${base}_${dateToken(dateSrc)}_data.xlsx`;
}

// Returns bundleFilename(election, sub) when the file exists on disk, else null.
export function existingBundleFilename(election, sub) {
  const filename = bundleFilename(election, sub);
  return fs.existsSync(path.join(OUT_DIR, filename)) ? filename : null;
}

// Writes the workbook to its canonical path and returns the manifest entry.
// Consolidates the last three lines of every loader.
export async function writeBundle(wb, election, sub) {
  const filename = bundleFilename(election, sub);
  const outPath = path.join(OUT_DIR, filename);
  await wb.xlsx.writeFile(outPath);
  return downloadEntry(election, sub, filename);
}

// Canonical candidate-CSV path for an (election, sub, slot) tuple, per the
// convention in src/data/candidates/README.md. Returns the
// election.files.candidate_overrides.<slot> override when set; otherwise
// `data/candidates/{election_id|sub_id}_{slot}.csv`.
export function canonicalCandidatePath(election, sub, slot) {
  const overrides = election?.files?.candidate_overrides ?? {};
  if (overrides[slot]) return overrides[slot];
  const isMain = !sub || sub.id === "__main__";
  const prefix = isMain ? election.id : sub.id;
  return `data/candidates/${prefix}_${slot}.csv`;
}

export function mainSubElection() {
  return { id: "__main__", type: "main", name: { en: "Main", ka: "ძირითადი კენჭისყრა" } };
}

export function subElections(election) {
  return [mainSubElection(), ...(election.sub_elections ?? []).filter(s => s?.id)];
}

export function electionUrl(election, sub = mainSubElection()) {
  const params = new URLSearchParams();
  params.set("type", election.type ?? "");
  params.set("election", election.id);
  if (sub?.id && sub.id !== "__main__") params.set("sub", sub.id);
  return `https://electionsdata.ge/elections?${params.toString()}`;
}

export function dataSourceText(election) {
  const sources = Array.isArray(election.sources) ? election.sources : [];
  if (!sources.length) return "";
  return sources.map(source => {
    const name = source?.name?.en ?? source?.name?.ka ?? "";
    return source?.url ? `${name} (${source.url})` : name;
  }).filter(Boolean).join("; ");
}

export function metadataRows(election, sub, generatedAt, { extraRows = [] } = {}) {
  const isMain = !sub || sub.id === "__main__";
  const subLabelEn = isMain ? "" : ` - ${sub.name?.en ?? sub.id}`;
  const subLabelKa = isMain ? "" : ` - ${sub.name?.ka ?? ""}`;
  const url = electionUrl(election, sub);
  const titleEn = (election.name?.en ?? election.id) + subLabelEn;
  const titleKa = (election.name?.ka ?? "") + subLabelKa;
  return [
    ["Archive", "Georgia Election Data Archive (GEDA)"],
    ["Website", url],
    ["Author", "David Sichinava"],
    ["Election (EN)", titleEn],
    ["Election (KA)", titleKa],
    ["Election ID", election.id],
    ["Election Type", election.type ?? ""],
    ["Election Date", isMain ? (election.date ?? "") : (sub.date ?? election.date ?? "")],
    ["File Generated", generatedAt.toISOString()],
    ["Data Source", dataSourceText(election)],
    ...extraRows,
    ["Citation (APA)", `Sichinava, D. (${generatedAt.getFullYear()}). Results of the ${titleEn}. Georgia Election Data Archive (GEDA). ${url}`],
    ["License", "CC-BY-4.0"],
  ];
}

export function addMetadataSheet(wb, election, sub, generatedAt, options = {}) {
  for (const sheet of [...wb.worksheets]) {
    if (/^About\b/i.test(sheet.name) || /Metadata/i.test(sheet.name) || /მეტამონაცემ/.test(sheet.name)) {
      wb.removeWorksheet(sheet.id);
    }
  }
  const sheet = wb.addWorksheet("About - Metadata");
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 88;
  for (const [key, value] of metadataRows(election, sub, generatedAt, options)) {
    const row = sheet.addRow([key, value ?? ""]);
    row.getCell(1).font = { bold: true, size: 9 };
    row.getCell(2).font = { size: 9 };
    row.getCell(2).alignment = { wrapText: true };
  }
  return sheet;
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function downloadEntry(election, sub, filename) {
  const filePath = path.join(OUT_DIR, filename);
  const stat = fs.statSync(filePath);
  const isMain = !sub || sub.id === "__main__";
  return {
    election_id: election.id,
    election_type: election.type,
    sub_id: isMain ? "__main__" : sub.id,
    sub_type: subTypeLabel(sub),
    label_en: election.name?.en ?? election.id,
    label_ka: election.name?.ka ?? "",
    sub_name_en: isMain ? "Main elections" : (sub.name?.en ?? sub.id),
    sub_name_ka: isMain ? "ძირითადი კენჭისყრა" : (sub.name?.ka ?? ""),
    date: isMain ? (election.date ?? "") : (sub.date ?? election.date ?? ""),
    filename,
    sha: sha256File(filePath),
    size_bytes: stat.size,
  };
}

// Builds the downloads manifest by walking every election + sub and checking
// for a matching canonical bundle on disk. Used by both the build-time data
// loader (downloads.json.js) and the dynamic-path generator in observablehq.config.js.
export function collectDownloadEntries({ excludeIds = new Set() } = {}) {
  const entries = [];
  for (const election of readAllElections()) {
    if (excludeIds.has(election.id)) continue;
    for (const sub of subElections(election)) {
      const filename = existingBundleFilename(election, sub);
      if (filename) entries.push(downloadEntry(election, sub, filename));
    }
  }
  return entries;
}

export function resolveSrcPath(p) {
  return p ? path.join(SRC, p) : null;
}

export function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ── CSV helpers ───────────────────────────────────────────────────────────

// Reads a CSV file referenced by a src-relative path (e.g. "data/results/parl2024_pr.csv").
// Returns [] for missing paths or non-existent files so callers can pass `files?.pr_results`
// without null-checking. autoType numerifies numeric columns.
export function readCSV(relPath) {
  const full = resolveSrcPath(relPath);
  if (!relPath || !fs.existsSync(full)) return [];
  return csvParse(fs.readFileSync(full, "utf8"), autoType);
}

// ── XLSX styling helpers ──────────────────────────────────────────────────
// Kept in sync across every download loader so bundles share the same visual:
// dark-blue header bar, light-blue alternating row tint, frozen first row.

export const HDR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A3A5C" } };
export const HDR_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 9, name: "Calibri" };
export const ALT_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FA" } };

export function styleHeader(row) {
  row.height = 34;
  row.eachCell(cell => {
    cell.fill = HDR_FILL;
    cell.font = HDR_FONT;
    cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "medium", color: { argb: "FF4A7AAC" } } };
  });
}

export function finishSheet(sheet, widths) {
  widths.forEach((w, i) => { if (w) sheet.getColumn(i + 1).width = w; });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (let r = 2; r <= sheet.rowCount; r++) {
    if (r % 2 === 0) {
      sheet.getRow(r).eachCell({ includeEmpty: false }, cell => {
        if (!cell.fill?.fgColor) cell.fill = ALT_FILL;
      });
    }
  }
}

// Multiplies a 0–1 fraction by 100 with 2-decimal rounding for display.
// Returns "" for missing or non-numeric input so the Excel cell shows blank.
export function safePct(v) {
  if (v == null || v === "" || v === "NA") return "";
  const n = Number(v);
  return Number.isFinite(n) ? Number((n * 100).toFixed(2)) : "";
}

// Generic CSV → sheet pass-through. Converts any `*_pct` column and the
// `vote_share` column from a 0–1 fraction to a 0–100 percentage so the Excel
// view is human-friendly. Other columns are written verbatim.
export function buildCsvSheet(wb, sheetName, rows) {
  if (!rows.length) return;
  const sheet = wb.addWorksheet(sheetName);
  const keys = Object.keys(rows[0]);
  styleHeader(sheet.addRow(keys));
  for (const row of rows) {
    sheet.addRow(keys.map(k => {
      const v = row[k];
      if (/_pct$/.test(k) || k === "vote_share") return safePct(v);
      return v ?? "";
    }));
  }
  finishSheet(sheet, keys.map(k => Math.min(42, Math.max(10, k.length + 4))));
}

// Sheet-name label for sub-elections in local-election bundles. local_2014 only
// knew the first three; local_2017 added "Repeated" — the canonical mapping
// lives here so every loader uses the same vocabulary.
export function subElectionSheetLabel(sub) {
  if (sub?.type === "by_election") return "By-election";
  if (sub?.type === "repeated")    return "Repeated";
  if (sub?.type === "runoff")      return "Runoff";
  return "Sub-election";
}
