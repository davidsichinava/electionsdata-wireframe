# CEC scanned-protocol checker

Verifies that the scanned election-protocol images on
**https://archiveresults.cec.gov.ge** actually load. Read-only availability QA.

## Status
- **Phase 1 — static era (2010–2019): implemented.** These years are plain
  interlinked HTML (`results/{id}/index.html` → section → okrug → precinct
  `oqmi_*` wrapper pages, each holding one `<img>` scan). Fully HTTP-crawlable.
- **Phase 2 — SPA era (2020–2024): designed, not built.** Those years are an
  Angular app whose protocol image URLs come from JSON under `assets/data/`,
  which Cloudflare gates behind a real browser session. Needs a headless-browser
  adapter (Playwright) that reuses one CF-cleared context and intercepts the
  protocol XHRs. Slot it in as `adapters/spa.js`.

## How it works
1. **Crawl** (`crawl.js`): BFS the `results/{id}/` HTML, scoped to that prefix,
   collecting every `<img>` that looks like a scan (`oqmebi…/ub/…`,
   `p_{okrug}_{precinct}.jpg`). Pages are cached on disk → resumable.
2. **Check** (`check.js`): a 3-byte ranged `GET` per image (existence + size,
   no full download). Verdicts: `OK`, `MISSING` (404 / 301-to-root),
   `FORBIDDEN` (403), `WRONG_TYPE`, `SUSPECT` (image below `--min-bytes`,
   i.e. likely a blank/placeholder), `ERROR`.
3. **Report** (`index.js`): writes `manifest.json`, `results.json`,
   `results.csv`, and `problems.csv` to `reports/protocol-check/`.

All HTTP goes through the system `curl` (`http.js`): Cloudflare 403s Node's
built-in `fetch` on TLS fingerprint, but not curl. Browser UA + same-site
`Referer` are required (images reject HEAD / no-Referer with 403).

## Usage
```bash
# One whole year (discovers its static elections from {year}.html)
node scripts/protocol-check/index.js --year 2010 --concurrency 6 --delay 40

# One subtree / single okrug (good for spot checks)
node scripts/protocol-check/index.js \
  --start "https://archiveresults.cec.gov.ge/results/2010/prop1.html"

# Just enumerate, don't check
node scripts/protocol-check/index.js --year 2012 --list-only
```
Options: `--max-pages`, `--limit`, `--concurrency` (default 5), `--min-bytes`
(default 8000), `--delay` ms (politeness), `--out <dir>`, `--no-cache`.

## Notes
- Ranged GETs transfer ~3 bytes/image, so a full year is cheap; still, keep
  `--concurrency` modest and use `--delay` to stay polite to a public archive.
- Re-runs reuse the page cache (`reports/protocol-check/cache/`, git-ignored);
  delete it to force a fresh crawl.
