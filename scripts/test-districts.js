#!/usr/bin/env node
// scripts/test-districts.js
// Pins the JS district-id helpers to the shared R/JS fixtures
// (src/loaders/R/common/districts_fixtures.csv). The R twin is
// scripts/test-districts.R — run BOTH after touching either implementation.

import fs from "node:fs";
import { csvParse } from "d3-dsv";
import { councilSelfgovIdFromMajorId, selfgovIdFromRawDistrictId } from "../src/components/election-utils.js";

const fixtures = csvParse(fs.readFileSync("src/loaders/R/common/districts_fixtures.csv", "utf8"))
  // "dotted" pins the R-only ingest helper council_maj_id_from_dotted();
  // there is no JS twin (raw codes never reach the client).
  .filter(f => f.fn !== "dotted");
let failed = 0;
for (const { fn, input, expected, note } of fixtures) {
  const got = fn === "maj" ? councilSelfgovIdFromMajorId(input) : selfgovIdFromRawDistrictId(input);
  if (got !== expected) {
    failed++;
    console.error(`✗ ${fn}(${input}) = ${got}, expected ${expected}  (${note})`);
  }
}
if (failed) {
  console.error(`\n${failed}/${fixtures.length} fixture(s) FAILED`);
  process.exit(1);
}
console.log(`All ${fixtures.length} district-id fixtures passed (JS).`);
