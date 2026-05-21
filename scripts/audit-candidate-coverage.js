#!/usr/bin/env node
// Audit: which (election_id|sub_id, slot) combinations should have a candidate
// CSV but don't?
//
// Slot expectations by election type:
//   parliamentary main: pr, smd, elected
//   parliamentary sub  (by-election / runoff): smd, elected
//   adjara main:        pr, smd, elected
//   adjara sub:         smd, elected
//   local main:         pr (if system.pr.enabled), council_smd, mayor,
//                       gamgebeli (if pre-2017 i.e. 2010/2014), elected
//   local sub:          council_smd or mayor (depending on what's contested),
//                       elected
//   presidential main:  presidential, elected
//   presidential sub:   presidential, elected (rare; only runoff)
//
// For sub-elections we use the sub.files block to figure out what was
// contested (presence of smd_results / council_smd_results / mayor_*).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ELECTIONS_DIR = path.join(ROOT, "src/data/config/elections");
const CAND_DIR = path.join(ROOT, "src/data/candidates");

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function expectedSlotsForMain(election) {
  const sys = election.system ?? {};
  const t = election.type;
  if (t === "parliamentary") {
    const slots = [];
    if (sys.pr?.enabled) slots.push("pr");
    if (sys.smd?.enabled) slots.push("smd");
    slots.push("elected");
    return slots;
  }
  if (t === "adjara") {
    const slots = [];
    if (sys.pr?.enabled) slots.push("pr");
    if (sys.smd?.enabled) slots.push("smd");
    slots.push("elected");
    return slots;
  }
  if (t === "local") {
    const slots = [];
    if (sys.pr?.enabled) slots.push("pr");
    if (sys.smd?.enabled) slots.push("council_smd", "mayor");
    // 2010 / 2014 had community gamgebeli alongside the city mayors
    if (election.id === "local_2010" || election.id === "local_2014") {
      slots.push("gamgebeli");
    }
    slots.push("elected");
    return slots;
  }
  if (t === "presidential") {
    return ["presidential", "elected"];
  }
  return [];
}

function expectedSlotsForSub(election, sub) {
  const files = sub.files ?? {};
  const slots = [];
  if (files.pr_results) slots.push("pr");
  if (files.smd_results) {
    // For local sub-elections, smd_results is actually mayor or council_smd
    // contests, not parliamentary SMD. We rely on whether council_smd_results
    // is also present to distinguish.
    if (election.type === "local") slots.push("mayor");
    else slots.push("smd");
  }
  if (files.council_smd_results) slots.push("council_smd");
  if (files.gamgebeli_results) slots.push("gamgebeli");
  if (files.presidential_results) slots.push("presidential");
  // elected: only meaningful where there's any contest at all
  if (slots.length > 0) slots.push("elected");
  return slots;
}

function fileFor(electionOrSubId, slot) {
  const fp = path.join(CAND_DIR, `${electionOrSubId}_${slot}.csv`);
  return { path: fp, exists: fs.existsSync(fp) };
}

const allYamls = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".yml")) allYamls.push(p);
  }
}
walk(ELECTIONS_DIR);

// Slots the user is interested in (the report focuses on these).
const REPORT_SLOTS = new Set([
  "pr", "smd", "council_smd", "mayor", "gamgebeli", "presidential", "elected",
]);

const rows = [];
for (const file of allYamls.sort()) {
  const e = readYaml(file);
  const mainSlots = expectedSlotsForMain(e);
  for (const slot of mainSlots) {
    if (!REPORT_SLOTS.has(slot)) continue;
    const { exists, path: fp } = fileFor(e.id, slot);
    rows.push({
      election_id: e.id,
      sub_id: "",
      kind: "main",
      slot,
      status: exists ? "present" : "MISSING",
      file: path.relative(ROOT, fp),
    });
  }
  for (const sub of e.sub_elections ?? []) {
    const subSlots = expectedSlotsForSub(e, sub);
    for (const slot of subSlots) {
      if (!REPORT_SLOTS.has(slot)) continue;
      const { exists, path: fp } = fileFor(sub.id, slot);
      rows.push({
        election_id: e.id,
        sub_id: sub.id,
        kind: sub.type ?? "sub",
        slot,
        status: exists ? "present" : "MISSING",
        file: path.relative(ROOT, fp),
      });
    }
  }
}

// Pretty print: split into present vs missing
const missing = rows.filter(r => r.status === "MISSING");
const present = rows.filter(r => r.status === "present");

console.log(`Present:  ${present.length}`);
console.log(`Missing:  ${missing.length}`);
console.log("");
console.log("== Missing files by election ==\n");
const grouped = new Map();
for (const r of missing) {
  const k = r.election_id;
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(r);
}
for (const [eid, list] of grouped) {
  console.log(`${eid}:`);
  for (const r of list) {
    const label = r.sub_id ? `${r.sub_id} (${r.kind})` : `main`;
    console.log(`  - ${label} :: ${r.slot}  →  ${r.file}`);
  }
}

// Also dump a tidy CSV
const out = path.join(ROOT, "reports/candidate_coverage_audit.csv");
fs.mkdirSync(path.dirname(out), { recursive: true });
const hdr = "election_id,sub_id,kind,slot,status,file";
const body = rows
  .map(r => [r.election_id, r.sub_id, r.kind, r.slot, r.status, r.file].join(","))
  .join("\n");
fs.writeFileSync(out, `${hdr}\n${body}\n`, "utf8");
console.log(`\nWrote ${path.relative(ROOT, out)}`);
