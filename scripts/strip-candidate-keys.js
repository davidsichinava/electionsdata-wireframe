#!/usr/bin/env node
// One-shot: strip legacy candidate file references from every election YAML.
// Removes the following keys from the `files:` block (if present):
//   - candidates           (point to legacy CSV or YAML roster)
//   - party_lists          (PR list CSV)
//   - smd_candidates       (SMD CSV)
//   - mayor_candidates     (mayor / mayor_gamgebeli CSV)
//   - elected              (elected.csv)
// Annulled_precincts is left alone — it's not candidate data.
//
// The new loader auto-discovers canonical files by filename. The schema for
// the override path is preserved as `files.candidate_overrides.{slot}` (only
// emitted when needed, which is not currently the case anywhere).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ELECTIONS_DIR = path.join(ROOT, "src/data/config/elections");

const LEGACY_KEYS = new Set([
  "candidates",
  "party_lists",
  "smd_candidates",
  "mayor_candidates",
  "elected"
]);

// Strip lines like "  candidates: ..." or "      candidates: ..." from a YAML
// file. We do line-level rather than parse-and-serialize so YAML comments
// and original formatting survive.
function stripFromYaml(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const out = [];
  let dropped = 0;
  for (const line of lines) {
    const m = line.match(/^(\s+)([a-z_]+):/);
    if (m && LEGACY_KEYS.has(m[2])) {
      dropped++;
      continue;
    }
    out.push(line);
  }
  if (dropped > 0) {
    fs.writeFileSync(filePath, out.join("\n"), "utf8");
  }
  return dropped;
}

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else if (e.name.endsWith(".yml")) fn(p);
  }
}

let total = 0;
walk(ELECTIONS_DIR, file => {
  const n = stripFromYaml(file);
  if (n > 0) {
    console.log(`${path.relative(ROOT, file)}: -${n} lines`);
    total += n;
  }
});
console.log(`\nTotal lines removed: ${total}`);
