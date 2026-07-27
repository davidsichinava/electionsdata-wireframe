#!/usr/bin/env node
// scripts/protocol-check/index.js
// Phase 1 CLI: crawl a static-era (2010–2019) CEC results tree, enumerate every
// scanned protocol image, and verify each loads (fast existence + size check).
//
// Usage:
//   node scripts/protocol-check/index.js --year 2010
//   node scripts/protocol-check/index.js --start <results-index-or-page-url>
//
// Options:
//   --start <url>       Crawl from this page (a results/{id}/ index or any inner page).
//   --year <YYYY>       Discover the year's static elections from {year}.html and crawl each.
//   --max-pages <n>     Cap pages fetched per crawl (default: unlimited).
//   --limit <n>         Cap protocol images enumerated per crawl (default: unlimited).
//   --concurrency <n>   Parallel image probes (default: 5).
//   --min-bytes <n>     Below this an image is flagged SUSPECT (default: 8000).
//   --delay <ms>        Min delay before each request, for politeness (default: 0).
//   --list-only         Only enumerate protocols; skip image checking.
//   --out <dir>         Output dir (default: reports/protocol-check).
//   --no-cache          Disable the on-disk page cache.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvFormat } from "d3-dsv";
import { staticCrawl, discoverYearEntries } from "./crawl.js";
import { checkImage, VERDICT } from "./check.js";
import { pool, ORIGIN } from "./http.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const a = { concurrency: 5, minBytes: 8000, delay: 0, maxPages: Infinity, limit: Infinity };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--start": a.start = v; i++; break;
      case "--year": a.year = v; i++; break;
      case "--max-pages": a.maxPages = Number(v); i++; break;
      case "--limit": a.limit = Number(v); i++; break;
      case "--concurrency": a.concurrency = Number(v); i++; break;
      case "--min-bytes": a.minBytes = Number(v); i++; break;
      case "--delay": a.delay = Number(v); i++; break;
      case "--out": a.out = v; i++; break;
      case "--list-only": a.listOnly = true; break;
      case "--no-cache": a.noCache = true; break;
      default: break;
    }
  }
  return a;
}

function tag(url) {
  // A short label for a results tree, e.g. ".../results/2010/index.html" → "2010".
  const m = url.match(/\/results\/([^/]+)\//);
  return m ? m[1] : "crawl";
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(ROOT, args.out ?? "reports/protocol-check");
  const cacheDir = args.noCache ? undefined : path.join(outDir, "cache");
  fs.mkdirSync(outDir, { recursive: true });

  // Resolve the list of start URLs.
  let starts = [];
  if (args.start) {
    starts = [args.start];
  } else if (args.year) {
    const { staticEntries, spaEntries, status } = await discoverYearEntries(args.year, { cacheDir });
    if (status !== 200) { console.error(`Failed to load ${args.year}.html (status ${status})`); process.exit(1); }
    starts = staticEntries;
    console.log(`${args.year}: ${staticEntries.length} static election(s), ${spaEntries.length} SPA election(s).`);
    if (spaEntries.length) {
      console.log("  SPA elections need the Phase 2 (headless-browser) adapter — skipping here:");
      spaEntries.forEach(u => console.log("   ", u));
    }
    if (!staticEntries.length) { console.error("No static elections to crawl for this year."); process.exit(0); }
  } else {
    console.error("Provide --start <url> or --year <YYYY>. See header for usage.");
    process.exit(1);
  }

  // Crawl (enumerate protocols), then check.
  const allEntries = [];
  const crawlErrors = [];
  for (const start of starts) {
    process.stdout.write(`\nCrawling ${start} …\n`);
    const { entries, pagesVisited, errors } = await staticCrawl(start, {
      cacheDir,
      maxPages: args.maxPages,
      maxImages: args.limit,
      minDelayMs: args.delay,
      onPage: (_u, n) => { if (n % 25 === 0) process.stdout.write(`  …${n} pages, ${allEntries.length + 0} protocols\r`); },
    });
    console.log(`  ${pagesVisited} pages, ${entries.length} protocol images, ${errors.length} page errors.`);
    for (const e of entries) allEntries.push({ tree: tag(start), ...e });
    crawlErrors.push(...errors.map(e => ({ tree: tag(start), error: e })));
  }

  // Deduplicate images that appear under multiple trees.
  const seen = new Set();
  const manifest = allEntries.filter(e => (seen.has(e.imageUrl) ? false : seen.add(e.imageUrl)));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nEnumerated ${manifest.length} unique protocol images → ${path.relative(ROOT, path.join(outDir, "manifest.json"))}`);

  if (args.listOnly) { console.log("--list-only: skipping image checks."); return; }

  // Check images with bounded concurrency.
  console.log(`\nChecking ${manifest.length} images (concurrency ${args.concurrency}, min-bytes ${args.minBytes}) …`);
  const results = await pool(manifest, args.concurrency, e =>
    checkImage(e, { minBytes: args.minBytes, minDelayMs: args.delay }),
    (done, total) => { if (done % 25 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`); }
  );
  // Attach tree label.
  const byUrl = new Map(manifest.map(m => [m.imageUrl, m.tree]));
  for (const r of results) r.tree = byUrl.get(r.imageUrl);

  // Write reports.
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "results.csv"),
    csvFormat(results.map(r => ({
      tree: r.tree, verdict: r.verdict, http_status: r.httpStatus,
      bytes: r.bytes ?? "", content_type: r.contentType, image_url: r.imageUrl, page_url: r.pageUrl,
    }))));
  const problems = results.filter(r => r.verdict !== VERDICT.OK);
  fs.writeFileSync(path.join(outDir, "problems.csv"),
    csvFormat(problems.length ? problems.map(r => ({
      tree: r.tree, verdict: r.verdict, http_status: r.httpStatus,
      bytes: r.bytes ?? "", image_url: r.imageUrl, page_url: r.pageUrl,
    })) : [{ tree: "", verdict: "", http_status: "", bytes: "", image_url: "", page_url: "" }]));
  if (crawlErrors.length) {
    fs.writeFileSync(path.join(outDir, "crawl-errors.csv"), csvFormat(crawlErrors));
  }

  // Summary.
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  console.log("\n\n── Summary ──");
  for (const v of Object.values(VERDICT)) if (counts[v]) console.log(`  ${v.padEnd(11)} ${counts[v]}`);
  console.log(`\nReports in ${path.relative(ROOT, outDir)}/ (results.json, results.csv, problems.csv).`);
  if (problems.length) console.log(`${problems.length} image(s) need attention — see problems.csv.`);
  else console.log("All enumerated protocol images loaded OK.");
}

main().catch(err => { console.error(err); process.exit(1); });
