#!/usr/bin/env node
// scripts/check-translations.js
// Translation-hygiene checker (REFACTOR_PLAN.md §7 T3). Fails (exit 1) when:
//   1. en/ka key sets in translations.json diverge
//   2. a translation key referenced in source is missing from the dictionary
//   3. header.html's inline fallback navDict drifts from translations.json
// Reports (non-fatal):
//   4. keys defined in translations.json but never referenced in source
//   5. dynamic (template-literal) keys it cannot statically verify
//
// Key-naming convention: `page.section.item`, lowercase, dot-separated —
// e.g. nav.brand, elections.results.candidate, main.card.open.
//
// Usage: node scripts/check-translations.js

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DICT_PATH = "src/data/config/translations.json";
const HEADER_PATH = "src/components/header.html";
const SCAN_DIRS = ["src"];
const SCAN_EXT = new Set([".js", ".md", ".html"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".observablehq", "data"]);
// src/data is skipped: loader sources there don't render UI text.

const dict = JSON.parse(fs.readFileSync(path.join(ROOT, DICT_PATH), "utf8"));
const langs = Object.keys(dict);
const problems = [];
const notes = [];

// ── 1. en/ka key parity ─────────────────────────────────────────────────────
const keySets = Object.fromEntries(langs.map(l => [l, new Set(Object.keys(dict[l]))]));
for (const a of langs) for (const b of langs) {
  if (a >= b) continue;
  const onlyA = [...keySets[a]].filter(k => !keySets[b].has(k));
  const onlyB = [...keySets[b]].filter(k => !keySets[a].has(k));
  if (onlyA.length) problems.push(`keys in ${a} but not ${b}: ${onlyA.join(", ")}`);
  if (onlyB.length) problems.push(`keys in ${b} but not ${a}: ${onlyB.join(", ")}`);
}
const allKeys = new Set(langs.flatMap(l => Object.keys(dict[l])));

// ── 2. keys referenced in source ────────────────────────────────────────────
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (SCAN_EXT.has(path.extname(e.name))) {
      yield p;
    }
  }
}

// t("key") / t('key')  — page-local helpers wrapping tr()
// tr(dict, lang, "key")
// data-nav="key"       — header nav attributes
const LITERAL_RES = [
  /\bt\(\s*"([^"]+)"\s*\)/g,
  /\bt\(\s*'([^']+)'\s*\)/g,
  /\btr\([^,()]+,[^,()]+,\s*"([^"]+)"\s*\)/g,
  /\btr\([^,()]+,[^,()]+,\s*'([^']+)'\s*\)/g,
  /data-nav="([^"]+)"/g,
];
const DYNAMIC_RE = /\bt\(\s*`([^`]*\$\{[^`]*)`\s*\)/g;

const used = new Map();        // key → [files]
const dynamicPrefixes = new Map(); // prefix → [files]
for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    if (rel === DICT_PATH) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const re of LITERAL_RES) {
      for (const m of text.matchAll(re)) {
        if (!used.has(m[1])) used.set(m[1], []);
        used.get(m[1]).push(rel);
      }
    }
    for (const m of text.matchAll(DYNAMIC_RE)) {
      const prefix = m[1].split("${")[0];
      if (!dynamicPrefixes.has(prefix)) dynamicPrefixes.set(prefix, []);
      dynamicPrefixes.get(prefix).push(rel);
    }
  }
}

const missing = [...used.keys()].filter(k => !allKeys.has(k)).sort();
for (const k of missing) {
  problems.push(`key "${k}" used in ${[...new Set(used.get(k))].join(", ")} but missing from ${DICT_PATH}`);
}

// Dynamic keys: verify the prefix matches at least one defined key.
for (const [prefix, files] of dynamicPrefixes) {
  const hits = [...allKeys].filter(k => k.startsWith(prefix));
  if (prefix && hits.length === 0) {
    problems.push(`dynamic key prefix "${prefix}…" (${[...new Set(files)].join(", ")}) matches no key in the dictionary`);
  } else {
    notes.push(`dynamic key "${prefix}…" (${[...new Set(files)][0]}) — ${hits.length} candidate key(s), not statically verified`);
  }
}

// ── 3. header.html inline fallback must match translations.json ────────────
const headerText = fs.readFileSync(path.join(ROOT, HEADER_PATH), "utf8");
const navDictMatch = headerText.match(/const navDict = (\{[\s\S]*?\n  \});/);
if (!navDictMatch) {
  notes.push(`${HEADER_PATH}: no inline navDict found (fallback removed?)`);
} else {
  let headerDict;
  try {
    headerDict = JSON.parse(
      navDictMatch[1]
        .replace(/\/\/[^\n]*/g, "")
        .replace(/,\s*}/g, "}")
    );
  } catch (e) {
    problems.push(`${HEADER_PATH}: could not parse inline navDict as JSON (${e.message})`);
  }
  if (headerDict) {
    for (const lang of Object.keys(headerDict)) {
      for (const [k, v] of Object.entries(headerDict[lang])) {
        const shared = dict[lang]?.[k];
        if (shared == null) {
          problems.push(`${HEADER_PATH} fallback key ${lang}/${k} missing from ${DICT_PATH}`);
        } else if (shared !== v) {
          problems.push(`${HEADER_PATH} fallback ${lang}/${k} = ${JSON.stringify(v)} drifted from ${DICT_PATH} = ${JSON.stringify(shared)}`);
        }
      }
    }
  }
}

// ── 4. unused keys (report-only) ────────────────────────────────────────────
const dynPrefixList = [...dynamicPrefixes.keys()].filter(Boolean);
const unused = [...allKeys]
  .filter(k => !used.has(k))
  .filter(k => !dynPrefixList.some(p => k.startsWith(p)))
  .sort();

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`translations.json: ${langs.map(l => `${l}=${keySets[l].size}`).join(", ")} keys; ` +
  `${used.size} literal key(s) referenced in source, ${dynamicPrefixes.size} dynamic pattern(s).`);

if (notes.length) {
  console.log("\nNotes:");
  for (const n of notes) console.log(`  - ${n}`);
}
if (unused.length) {
  console.log(`\n${unused.length} key(s) defined but never referenced (report-only):`);
  for (const k of unused) console.log(`  - ${k}`);
}
if (problems.length) {
  console.error(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("\nAll translation checks passed.");
