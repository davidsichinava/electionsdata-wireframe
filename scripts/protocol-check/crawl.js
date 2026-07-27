// scripts/protocol-check/crawl.js
// Static-era (2010–2019) enumerator for the CEC results archive.
//
// These years are plain interlinked HTML under results/{id}/:
//   index.html → section pages (olqebi_prop.html, major.html, olqebi_meri.html,
//   shualeduri.html, …) → okrug pages (prop{N}.html, …) → precinct "protocol"
//   wrapper pages (oqmi_*_ubani-*.html), each of which is a tiny page holding a
//   single <img> that points at the scanned protocol, e.g.
//     <img src="oqmebi2010/prop/ub/p_1_1.jpg">
//
// We BFS the intra-directory .html links and, on every page, collect any <img>
// whose URL looks like a scanned protocol. Layout assets (pics/, img/, *.gif)
// are ignored. The crawl is scoped to the results/{id}/ prefix so it never
// wanders off into the rest of the site.

import path from "node:path";
import { fetchText, ORIGIN } from "./http.js";

// An <img src> is treated as a scanned protocol when its path looks like the
// archive's scan storage (oqmebi*/…/ub/…) or a p_{okrug}_{precinct}.jpg file.
const SCAN_RE = /(oqmebi|\/ub\/|\bp_\d+_\d+)\.?.*\.(jpg|jpeg|png)$/i;

// Attribute values may be double-quoted, single-quoted, or UNQUOTED — the 2013
// pages, for example, use bare `href=olq_1.html>`. Capture all three forms.
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
const IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
const attr = m => m[1] ?? m[2] ?? m[3] ?? "";

/** Resolve a possibly-relative href against a base URL; null if off-site/invalid. */
function resolve(base, href) {
  try {
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) return null;
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/** Directory prefix of a URL (everything up to and including the last "/"). */
function dirOf(url) {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/[^/]*$/, "");
  return u.href;
}

/**
 * Crawl a static results tree starting from `startUrl`.
 * @param {string} startUrl  e.g. https://archiveresults.cec.gov.ge/results/2010/index.html
 * @param {{cacheDir?:string, maxPages?:number, maxImages?:number, scopePrefix?:string,
 *          minDelayMs?:number, onPage?:(url:string,n:number)=>void}} opts
 * @returns {Promise<{entries:Array<{imageUrl:string,pageUrl:string}>, pagesVisited:number, errors:string[]}>}
 */
export async function staticCrawl(startUrl, opts = {}) {
  const {
    cacheDir,
    maxPages = Infinity,
    maxImages = Infinity,
    minDelayMs = 0,
    onPage,
  } = opts;
  // Default scope: the results/{id}/ directory of the start URL.
  const scopePrefix = opts.scopePrefix ?? (() => {
    const m = startUrl.match(/^(.*\/results\/[^/]+\/)/);
    return m ? m[1] : dirOf(startUrl);
  })();

  const queue = [startUrl];
  const seenPages = new Set([startUrl]);
  const seenImages = new Set();
  const entries = [];
  const errors = [];
  let pagesVisited = 0;

  while (queue.length && pagesVisited < maxPages && entries.length < maxImages) {
    const pageUrl = queue.shift();
    const res = await fetchText(pageUrl, { cacheDir, referer: dirOf(pageUrl), minDelayMs });
    pagesVisited++;
    if (onPage) onPage(pageUrl, pagesVisited);
    if (!res.ok) {
      errors.push(`${res.status} ${pageUrl}`);
      continue;
    }

    // Collect scanned-protocol images on this page.
    for (const m of res.text.matchAll(IMG_RE)) {
      const abs = resolve(pageUrl, attr(m));
      if (!abs || !SCAN_RE.test(abs) || seenImages.has(abs)) continue;
      seenImages.add(abs);
      entries.push({ imageUrl: abs, pageUrl });
      if (entries.length >= maxImages) break;
    }

    // Enqueue intra-scope .html links we haven't seen.
    for (const m of res.text.matchAll(HREF_RE)) {
      const abs = resolve(pageUrl, attr(m));
      if (!abs || !abs.startsWith(scopePrefix)) continue;
      if (!/\.html?($|[?#])/i.test(abs)) continue;
      const norm = abs.replace(/[?#].*$/, "");
      if (seenPages.has(norm)) continue;
      seenPages.add(norm);
      queue.push(norm);
    }
  }

  return { entries, pagesVisited, errors, quedRemaining: queue.length };
}

/**
 * Discover the static election entry pages for a year from `{year}.html`.
 * Returns only static index.html entries; SPA (`#/`) entries are returned
 * separately so the caller can warn that they need the Phase 2 adapter.
 * @param {number|string} year
 * @param {{cacheDir?:string}} opts
 */
export async function discoverYearEntries(year, opts = {}) {
  const res = await fetchText(`${ORIGIN}/${year}.html`, { cacheDir: opts.cacheDir, referer: `${ORIGIN}/` });
  const staticEntries = [];
  const spaEntries = [];
  if (!res.ok) return { staticEntries, spaEntries, status: res.status };
  for (const m of res.text.matchAll(/href\s*=\s*"(results\/[^"]+)"/gi)) {
    const abs = new URL(m[1], `${ORIGIN}/`).href;
    if (abs.includes("#")) spaEntries.push(abs);
    else staticEntries.push(abs);
  }
  return {
    staticEntries: [...new Set(staticEntries)],
    spaEntries: [...new Set(spaEntries)],
    status: 200,
  };
}
