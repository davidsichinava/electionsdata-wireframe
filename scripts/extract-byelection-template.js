#!/usr/bin/env node
// One-shot helper: walk every election YAML and emit a CSV listing each
// "synthetic" party_id (one whose alias is actually a candidate name) into a
// fill-in template at reports/byelection_candidates_to_fill.csv.
//
// A synthetic id is heuristically:
//   * has alias.ka, AND
//   * alias.ka is a person-name pattern (2 tokens) OR
//     the id itself matches /^(major\d+_\d+|mtatsminda_\d+|zugdidi_\d+|smd_only_|parl\d+_\d+)/ etc.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { csvFormat } from "d3-dsv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ELECTIONS_DIR = path.join(ROOT, "src/data/config/elections");
const REPORTS_DIR = path.join(ROOT, "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// Synthetic per-candidate id patterns: location/role prefix + numeric ballot.
// We deliberately exclude bare _YYYY suffixes (those are real parties like
// republicans_2016).
const SYNTHETIC_ID = /^(smd_only_\d+|zugdidi_\d+_\d+|major\d+_\d+_\d+|mtatsminda_\d+(_r?\d+)?_\d+|parl\d{4}_\d{4}_)/;

// Load the parties.yml registry to also exclude any id that's in the global
// registry — those are real parties.
const partiesYml = yaml.load(fs.readFileSync(path.join(ROOT, "src/data/config/parties.yml"), "utf8"));
const registeredIds = new Set((partiesYml?.parties ?? []).map(p => p?.id).filter(Boolean));

const docs = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".yml")) {
      const doc = yaml.load(fs.readFileSync(p, "utf8"));
      if (doc?.id) docs.push(doc);
    }
  }
})(ELECTIONS_DIR);

const out = [];
for (const doc of docs) {
  for (const p of (doc.parties ?? [])) {
    if (!p?.id) continue;
    if (!SYNTHETIC_ID.test(p.id)) continue;
    if (registeredIds.has(p.id)) continue;       // real parties registered in parties.yml
    if (p.id.endsWith("_1919")) continue;         // historic, leave alone
    // Try to extract sub_id from the synthetic id pattern
    let subId = "__main__";
    let ballotNumber = "";
    if (/^smd_only_(\d+)$/.test(p.id)) {
      ballotNumber = p.id.match(/^smd_only_(\d+)$/)[1];
    } else if (/^major(\d+)_(\d+)_(\d+)$/.test(p.id)) {
      // major54_2018_2  → sub_id parl_2016_major54_2018, ballot 2
      const m = p.id.match(/^major(\d+)_(\d+)_(\d+)$/);
      subId = `${doc.id}_major${m[1]}_${m[2]}`;
      ballotNumber = m[3];
    } else if (/^mtatsminda_(\d+)_r?(\d+)?$/.test(p.id)) {
      // mtatsminda_2019_4 or mtatsminda_2019_r2_X
      const m = p.id.match(/^mtatsminda_(\d+)(?:_(.+))?$/);
      subId = `${doc.id}_mtatsminda_${m[1]}`;
      if (m[2] && /^r\d/.test(m[2])) subId += `_${m[2].split("_")[0]}`;
      const ballotMatch = p.id.match(/_(\d+)$/);
      if (ballotMatch && ballotMatch[1] !== m[1]) ballotNumber = ballotMatch[1];
    } else if (/^zugdidi_(\d+)_(\d+)$/.test(p.id)) {
      // zugdidi_2018_2  → sub_id local_2017_zugdidi_2018_sakrebulo_smd
      const m = p.id.match(/^zugdidi_(\d+)_(\d+)$/);
      subId = `${doc.id}_zugdidi_${m[1]}_sakrebulo_smd`;
      ballotNumber = m[2];
    } else if (/^parl\d+_(\d+)_/.test(p.id)) {
      // parl2012_2015_11_41  → sub_id parl_2012_2015_byelection, district 11, ballot 41
      const m = p.id.match(/^parl\d+_(\d+)_(.+)$/);
      subId = `${doc.id}_${m[1]}_byelection`;
      // Last token of the remainder is the ballot number (or party-letter)
      const tokens = m[2].split("_");
      ballotNumber = tokens[tokens.length - 1];
    }

    out.push({
      election_id: doc.id,
      sub_id: subId,
      current_synthetic_id: p.id,
      candidate_name_ka: p.alias?.ka ?? p.name?.ka ?? "",
      candidate_name_en: p.alias?.en ?? p.name?.en ?? "",
      color_hint: p.color ?? "",
      ballot_number: ballotNumber,
      party_label_ka_FILL: "",     // ← USER FILLS THIS
      elected_FILL: "",            // ← USER FILLS THIS (TRUE / FALSE)
      district_name_ka_FILL: "",   // ← optional: only needed for parl SMDs
    });
  }
}

out.sort((a, b) =>
  a.election_id.localeCompare(b.election_id) ||
  a.sub_id.localeCompare(b.sub_id) ||
  Number(a.ballot_number) - Number(b.ballot_number) ||
  a.current_synthetic_id.localeCompare(b.current_synthetic_id)
);

const cols = ["election_id", "sub_id", "current_synthetic_id", "candidate_name_ka", "candidate_name_en", "color_hint", "ballot_number", "party_label_ka_FILL", "elected_FILL", "district_name_ka_FILL"];
const outFile = path.join(REPORTS_DIR, "byelection_candidates_to_fill.csv");
fs.writeFileSync(outFile, csvFormat(out, cols), "utf8");
console.log(`Wrote ${path.relative(ROOT, outFile)}: ${out.length} candidates`);

// Print a per-election summary
const byElection = new Map();
for (const r of out) {
  const k = r.election_id;
  byElection.set(k, (byElection.get(k) ?? 0) + 1);
}
console.log("\nBy election:");
for (const [k, n] of byElection) console.log(`  ${k}: ${n}`);
