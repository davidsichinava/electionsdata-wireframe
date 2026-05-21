#!/usr/bin/env node
// Parity check: compare the current loader's output against a synthesised
// pass over the canonical CSVs in src/data/candidates/_migrated/.
//
// Strategy:
//   1. Run `buildCandidates()` from the existing candidates-build.js (legacy
//      sources) and collect appearance counts per (election_id × vote_type ×
//      party_id).
//   2. Read each canonical CSV from src/data/candidates/_migrated/ and bucket
//      its rows the same way.
//   3. Diff. Expected gains: parl_2024_elected (+150), local_2021_elected
//      (+2090), local_2025_elected (+2121). Anything else worth investigating.
//
// Usage:
//   node scripts/parity-check.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvParse } from "d3-dsv";
import { buildCandidates } from "../src/data/config/candidates-build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MIGRATED = path.join(ROOT, "src/data/candidates/_migrated");

// Normalize vote_type values to align legacy and canonical taxonomies:
// canonical uses "council_smd" exclusively for sakrebulo SMD candidates;
// legacy emits "sakrebulo_smd" (from local YAML rosters) and "smd" (from
// local SMD CSVs). Treat all three as equivalent for parity bucketing.
function normVoteType(v) {
  if (v === "sakrebulo_smd") return "council_smd";
  return v;
}

// ─── Legacy: existing loader output ─────────────────────────────────────────
process.stderr.write("Running buildCandidates() against legacy sources...\n");
const legacy = await buildCandidates();
const legacyBuckets = new Map();  // key = `${election_id}|${vote_type}|${party_id}` → count
for (const cluster of legacy.clusters) {
  for (const ap of cluster.appearances) {
    // Legacy mixes "sakrebulo_smd" (from YAML) and "smd" (from CSV) — equate to council_smd
    // for local elections only.
    let vt = ap.vote_type;
    if (ap.election_type === "local" && (vt === "smd" || vt === "sakrebulo_smd")) vt = "council_smd";
    const pid = ap.party_id || "<unresolved>";
    const key = `${ap.election_id}|${vt}|${pid}`;
    legacyBuckets.set(key, (legacyBuckets.get(key) ?? 0) + 1);
  }
}
process.stderr.write(`  legacy buckets: ${legacyBuckets.size}, total appearances: ${[...legacyBuckets.values()].reduce((a,b)=>a+b,0)}\n`);

// ─── Canonical: walk _migrated/*.csv ─────────────────────────────────────────
// _elected.csv files are MODIFIERS in the canonical design — the new loader
// will use them to set `elected: TRUE` on matching roster rows, not as new
// appearances. So we skip them when bucketing for parity comparison.
process.stderr.write("Reading canonical CSVs from _migrated/ (skipping _elected.csv)...\n");
const canonicalBuckets = new Map();
const files = fs.readdirSync(MIGRATED).filter(f => f.endsWith(".csv") && !f.endsWith("_elected.csv"));
let canonicalRows = 0;
for (const f of files) {
  const rows = csvParse(fs.readFileSync(path.join(MIGRATED, f), "utf8"));
  for (const r of rows) {
    if (!r.first_name && !r.last_name) continue;
    const vt = normVoteType(r.vote_type);
    const pid = r.party_id || "<unresolved>";
    const key = `${r.election_id}|${vt}|${pid}`;
    canonicalBuckets.set(key, (canonicalBuckets.get(key) ?? 0) + 1);
    canonicalRows++;
  }
}
process.stderr.write(`  canonical buckets: ${canonicalBuckets.size}, total rows: ${canonicalRows}\n\n`);

// ─── Diff ────────────────────────────────────────────────────────────────────

const allKeys = new Set([...legacyBuckets.keys(), ...canonicalBuckets.keys()]);
const diffs = [];
for (const key of allKeys) {
  const L = legacyBuckets.get(key) ?? 0;
  const C = canonicalBuckets.get(key) ?? 0;
  if (L !== C) diffs.push({ key, legacy: L, canonical: C, delta: C - L });
}

diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

console.log("=== Parity diff (canonical - legacy) ===\n");
console.log("Total legacy appearances: ", [...legacyBuckets.values()].reduce((a,b)=>a+b,0));
console.log("Total canonical rows:     ", canonicalRows);
console.log("Buckets in both, identical:", allKeys.size - diffs.length);
console.log("Buckets that differ:       ", diffs.length);
console.log("");

// Aggregate by (election_id, vote_type)
const aggByElectionVoteType = new Map();
for (const d of diffs) {
  const [eid, vt] = d.key.split("|");
  const k = `${eid}|${vt}`;
  let bucket = aggByElectionVoteType.get(k);
  if (!bucket) { bucket = { legacy: 0, canonical: 0, parties: 0 }; aggByElectionVoteType.set(k, bucket); }
  bucket.legacy += d.legacy;
  bucket.canonical += d.canonical;
  bucket.parties++;
}

console.log("=== Aggregated by (election_id, vote_type) — only rows where totals differ ===\n");
console.log("election_id          vote_type        legacy   canonical   delta   #parties_differ");
const sortedAgg = [...aggByElectionVoteType.entries()].sort((a, b) => Math.abs(b[1].canonical - b[1].legacy) - Math.abs(a[1].canonical - a[1].legacy));
for (const [k, v] of sortedAgg) {
  const [eid, vt] = k.split("|");
  const delta = v.canonical - v.legacy;
  if (delta === 0) continue;
  const arrow = delta > 0 ? "+" : "";
  console.log(`  ${eid.padEnd(20)} ${vt.padEnd(15)} ${String(v.legacy).padStart(6)}   ${String(v.canonical).padStart(8)}   ${(arrow + delta).padStart(6)}   ${v.parties}`);
}

// Show top per-party diffs
console.log("\n=== Top 30 individual (election, vote_type, party_id) buckets that differ ===\n");
for (const d of diffs.slice(0, 30)) {
  const [eid, vt, pid] = d.key.split("|");
  console.log(`  ${eid.padEnd(20)} ${vt.padEnd(15)} ${pid.padEnd(28)} legacy=${String(d.legacy).padStart(5)} canonical=${String(d.canonical).padStart(5)}  Δ=${d.delta > 0 ? "+" : ""}${d.delta}`);
}
